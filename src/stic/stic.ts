/** The STIC's picture in MOB coordinates: border x 0-7, background x 8-167, border from x 167. */
export const IMAGE_WIDTH = 176;
/** In scanlines: top border 0-15, background 16-207 (96 rows of two lines), bottom border 208-223. */
export const IMAGE_LINES = 224;
/** What the screen shows: the whole width, and 8 lines of border above and below the picture. */
export const FRAME_WIDTH = IMAGE_WIDTH;
export const FRAME_TOP = 8;
export const FRAME_HEIGHT = 208;

export const CARD_COLUMNS = 20;
export const CARD_ROWS = 12;
export const BACKTAB_SIZE = CARD_COLUMNS * CARD_ROWS;

const PICTURE_X = 8;
const PICTURE_ROW = 8;
const PICTURE_WIDTH = 160;
const PICTURE_ROWS = 96;
const LAST_MOB_LINE = 208;

/** Register $20 (display enable), $21 (mode), $28-$2B (colour stack), $2C border, $30-$32 delays and edge masks. */
export const REG_DISPLAY_ENABLE = 0x20;
export const REG_MODE = 0x21;
const REG_COLOR_STACK = 0x28;
const REG_BORDER = 0x2c;
const REG_H_DELAY = 0x30;
const REG_V_DELAY = 0x31;
const REG_EDGE_MASK = 0x32;

/** [implemented bits, bits that read as 1] for each register. */
const REGISTER_MASKS: readonly [number, number][] = Array.from({ length: 0x40 }, (_, reg): [number, number] => {
  if (reg < 0x08) return [0x07ff, 0x3800];
  if (reg < 0x10) return [0x0fff, 0x3000];
  if (reg < 0x18) return [0x3fff, 0x0000];
  if (reg < 0x20) return [0x03ff & ~(1 << (reg - 0x18)), 0x3c00];
  if (reg >= 0x28 && reg <= 0x2c) return [0x000f, 0x3ff0];
  if (reg === 0x30 || reg === 0x31) return [0x0007, 0x3ff8];
  if (reg === 0x32) return [0x0003, 0x3ffc];
  return [0x0000, 0x3fff];
});

/** A MOB's height in scanlines, by Y register bits 9-7 (size and 16-line resolution). */
const MOB_HEIGHTS = [8, 16, 16, 32, 32, 64, 64, 128];

/** Doubles each bit of a byte into a 16-bit word (double-width MOBs). */
const DOUBLED = Uint16Array.from({ length: 256 }, (_, byte) => {
  let word = 0;
  for (let bit = 0; bit < 8; bit++) if (byte & (1 << bit)) word |= 3 << (bit * 2);
  return word;
});

function reverse16(word: number): number {
  let out = 0;
  for (let bit = 0; bit < 16; bit++) if (word & (1 << bit)) out |= 0x8000 >> bit;
  return out;
}

/** Scratch space for drawing a frame; never part of a save state. */
class Scratch {
  readonly background = new Uint8Array(PICTURE_WIDTH * PICTURE_ROWS);
  readonly backgroundOn = new Uint8Array(PICTURE_WIDTH * PICTURE_ROWS);
  readonly lastBackground = new Uint8Array(CARD_ROWS);
  readonly mobColor = new Uint8Array(IMAGE_WIDTH * IMAGE_LINES);
  readonly mobShown = new Uint8Array(IMAGE_WIDTH * IMAGE_LINES);
  readonly mobBehind = new Uint8Array(IMAGE_WIDTH * IMAGE_LINES);
  /** Each MOB's rows as 16-bit masks (bit 15 is the leftmost pixel), for collisions. */
  readonly mobRows = Array.from({ length: 8 }, () => new Uint16Array(16));
  readonly mobActive = new Uint8Array(8);
  readonly image = new Uint8Array(IMAGE_WIDTH * IMAGE_LINES);
}

/**
 * The AY-3-8900 Standard Television Interface Chip. It draws the 20x12 cards
 * of the background table (BACKTAB, in system RAM) from the GROM's 256 fixed
 * cards and the 64 of GRAM, in Color Stack or Foreground/Background mode,
 * with eight moving objects (MOBs) in front or behind, and finds where they
 * touch each other, the background and the border.
 *
 * Like jzIntv, it draws a whole frame at the start of vertical blank, from the
 * cards it fetched row by row during the frame (BUSRQ) and its registers then.
 * The CPU can only reach the registers during the first part of vertical
 * blank, and GRAM and GROM a little longer, unless the display is off.
 */
export class Stic {
  readonly registers = new Uint16Array(0x40);
  readonly gram = new Uint8Array(0x200);
  /** The Graphics ROM, given by the machine. */
  grom: Uint8Array = new Uint8Array(0x800);
  /** The background cards fetched for the frame being displayed. */
  readonly cards = new Uint16Array(BACKTAB_SIZE);
  /** Color Stack mode (a read of $21) rather than Foreground/Background (a write). */
  colorStackMode = true;
  /** The CPU wrote $20 during this vertical blank, so the next frame is displayed. */
  enableRequested = false;
  /** Whether the frame being drawn now is displayed. */
  displayEnabled = false;
  /** Bus cycle from which the CPU may reach the STIC (it acknowledged the interrupt). */
  accessFrom = 0;
  /** Last bus cycle the registers are reachable in. */
  registersUntil = 0;
  /** Last bus cycle GRAM and GROM are reachable in. */
  graphicsUntil = 0;
  /** The finished picture, as colour indexes. */
  readonly framebuffer = new Uint8Array(FRAME_WIDTH * FRAME_HEIGHT);
  private readonly scratch = new Scratch();

  reset(): void {
    this.registers.fill(0);
    for (let reg = 0; reg < 0x40; reg++) if (reg !== REG_DISPLAY_ENABLE) this.store(reg, 0xffff);
    this.colorStackMode = true;
    this.enableRequested = false;
    this.displayEnabled = false;
    this.accessFrom = 0;
    this.registersUntil = 0;
    this.graphicsUntil = 0;
    this.cards.fill(0);
    this.framebuffer.fill(0);
  }

  private store(reg: number, value: number): void {
    if (reg === REG_DISPLAY_ENABLE) this.enableRequested = true;
    if (reg === REG_MODE) this.colorStackMode = false;
    const [implemented, ones] = REGISTER_MASKS[reg];
    this.registers[reg] = (value & implemented) | ones;
  }

  /** Reads $0000-$007F or a register alias ($4000, $8000, $C000), at bus cycle `now`. */
  readRegister(address: number, now: number): number {
    if (now < this.accessFrom || now > this.registersUntil) return address < 0x80 ? address & 0x0e : 0xffff;
    if ((address & 0x7f) === REG_MODE) this.colorStackMode = true;
    if (address >= 0x4000) return 0xffff;
    if (address >= 0x40) return this.gram[address];
    return this.registers[address];
  }

  writeRegister(address: number, value: number, now: number): void {
    const reg = address & 0x7f;
    if (reg >= 0x40 || now < this.accessFrom || now > this.registersUntil) return;
    this.store(reg, value);
  }

  /** Reads $3000-$3FFF: GROM, then GRAM and its aliases. */
  readGraphics(address: number, now: number): number {
    if (now < this.accessFrom || now > this.graphicsUntil) return address & 0x3fff;
    return address & 0x800 ? this.gram[address & 0x1ff] : this.grom[address & 0x7ff];
  }

  writeGraphics(address: number, value: number, now: number): void {
    if (now < this.accessFrom || now > this.graphicsUntil || !(address & 0x800)) return;
    this.gram[address & 0x1ff] = value & 0xff;
  }

  /** The STIC's fetch of one row of 20 cards from BACKTAB during the frame. */
  fetchRow(row: number, backtab: Uint16Array): void {
    if (row >= CARD_ROWS) return;
    for (let i = row * CARD_COLUMNS, end = i + CARD_COLUMNS; i < end; i++) this.cards[i] = backtab[i] & 0x3fff;
  }

  /** A frame with the display off. */
  blank(): void {
    this.framebuffer.fill(0);
  }

  /** Draws the frame and records its collisions. */
  render(): void {
    this.drawBackground();
    this.drawMobs();
    this.compose();
    this.detectCollisions();
    const { image } = this.scratch;
    this.framebuffer.set(image.subarray(FRAME_TOP * IMAGE_WIDTH, (FRAME_TOP + FRAME_HEIGHT) * IMAGE_WIDTH));
  }

  private cardRows(index: number): Uint8Array {
    return index & 0x800 ? this.gram.subarray(index & 0x1f8, (index & 0x1f8) + 8) : this.grom.subarray(index, index + 8);
  }

  /** The 160x96 background, and which of its pixels are "on" (foreground), for MOB priority and collisions. */
  private drawBackground(): void {
    const { background, backgroundOn, lastBackground } = this.scratch;
    const regs = this.registers;
    const stack = [0, 1, 2, 3].map((i) => regs[REG_COLOR_STACK + i] & 0x0f);
    let stackIndex = 0;
    let bg = stack[0];
    for (let row = 0; row < CARD_ROWS; row++) {
      for (let column = 0; column < CARD_COLUMNS; column++) {
        const card = this.cards[row * CARD_COLUMNS + column];
        const origin = row * 8 * PICTURE_WIDTH + column * 8;
        let fg: number;
        let index: number;
        if (this.colorStackMode) {
          if ((card & 0x1800) === 0x1000) {
            this.drawColoredSquares(card, origin, bg);
            continue;
          }
          if (card & 0x2000) {
            stackIndex = (stackIndex + 1) & 3;
            bg = stack[stackIndex];
          }
          fg = ((card >> 9) & 8) | (card & 7);
          index = card & 0x800 ? card & 0x9f8 : card & 0x7f8;
        } else {
          fg = card & 7;
          bg = ((card >> 9) & 0x0b) | ((card >> 11) & 0x04);
          index = card & 0x9f8;
        }
        const rows = this.cardRows(index);
        for (let y = 0; y < 8; y++) {
          const bits = rows[y];
          let at = origin + y * PICTURE_WIDTH;
          for (let x = 7; x >= 0; x--, at++) {
            const on = (bits >> x) & 1;
            background[at] = on ? fg : bg;
            backgroundOn[at] = on;
          }
        }
      }
      lastBackground[row] = bg;
    }
  }

  /**
   * A Colored Squares card: four 4x4 blocks with colours 0-6 from the card, or
   * 7 for the colour stack's current colour, which counts as background.
   */
  private drawColoredSquares(card: number, origin: number, stackColor: number): void {
    const { background, backgroundOn } = this.scratch;
    const colors = [card & 7, (card >> 3) & 7, (card >> 6) & 7, ((card >> 9) & 3) | ((card >> 11) & 4)];
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        const color = colors[(y >> 2) * 2 + (x >> 2)];
        const at = origin + y * PICTURE_WIDTH + x;
        background[at] = color === 7 ? stackColor : color;
        backgroundOn[at] = color === 7 ? 0 : 1;
      }
    }
  }

  /** Draws the MOBs, 7 first so that MOB 0 ends up in front, and keeps each one's shape for collisions. */
  private drawMobs(): void {
    const { mobColor, mobShown, mobBehind, mobRows, mobActive } = this.scratch;
    const regs = this.registers;
    mobShown.fill(0);
    for (let mob = 7; mob >= 0; mob--) {
      const xReg = regs[mob];
      const yReg = regs[0x08 + mob];
      const aReg = regs[0x10 + mob];
      const rows = mobRows[mob];
      rows.fill(0);
      const x = xReg & 0xff;
      const y = (yReg & 0x7f) * 2;
      mobActive[mob] = 0;
      if (x === 0 || x >= 167 || (xReg & 0x300) === 0 || y >= LAST_MOB_LINE) continue;
      mobActive[mob] = 1;

      const tall = (yReg & 0x80) !== 0;
      const height = tall ? 16 : 8;
      let index = aReg & 0xff8;
      if (!this.colorStackMode || index & 0x800) index &= 0x9f8;
      if (tall) index &= 0xff0;
      const wide = (xReg & 0x400) !== 0;
      const flipX = (yReg & 0x400) !== 0;
      const flipY = (yReg & 0x800) !== 0;
      for (let row = 0; row < height; row++) {
        const byte = index & 0x800 ? this.gram[((index & 0x1ff) + row) & 0x1ff] : this.grom[(index + row) & 0x7ff];
        let bits = wide ? DOUBLED[byte] : byte << 8;
        if (flipX) bits = wide ? reverse16(bits) : reverse16(bits) << 8;
        rows[flipY ? height - 1 - row : row] = bits & 0xffff;
      }

      if (!(xReg & 0x200)) continue;
      const color = ((aReg >> 9) & 8) | (aReg & 7);
      const behind = (aReg >> 13) & 1;
      const shift = (yReg >> 8) & 3;
      let shownRows = height;
      if (y + (height << shift) > LAST_MOB_LINE) shownRows = (LAST_MOB_LINE - 1 - y + (1 << shift)) >> shift;
      for (let row = 0; row < shownRows; row++) {
        const bits = rows[row];
        if (!bits) continue;
        for (let repeat = 0; repeat < 1 << shift; repeat++) {
          const line = y + (row << shift) + repeat;
          if (line >= IMAGE_LINES) break;
          for (let k = 0; k < 16; k++) {
            if (!(bits & (0x8000 >> k))) continue;
            const px = x + k;
            if (px >= IMAGE_WIDTH) break;
            const at = line * IMAGE_WIDTH + px;
            mobColor[at] = color;
            mobShown[at] = 1;
            mobBehind[at] = behind;
          }
        }
      }
    }
  }

  /** Merges MOBs and background, shifts them by the delay registers, and puts the border round them. */
  private compose(): void {
    const { background, backgroundOn, lastBackground, mobColor, mobShown, mobBehind, image } = this.scratch;
    const regs = this.registers;
    const hDelay = regs[REG_H_DELAY] & 7;
    const vDelay = (regs[REG_V_DELAY] & 7) * 2;
    // MOBs don't show in the rightmost column, which the border covers once shifted.
    for (let line = 0; line < IMAGE_LINES; line++) mobShown.fill(0, line * IMAGE_WIDTH + 167 - hDelay, (line + 1) * IMAGE_WIDTH);

    for (let line = 0; line < LAST_MOB_LINE - vDelay; line++) {
      const row = (line >> 1) - PICTURE_ROW;
      const inPicture = row >= 0 && row < PICTURE_ROWS;
      // Left of the cards, revealed by the horizontal delay: the last background colour of the row.
      const cardRow = (line - 16) >> 4;
      const fill = !inPicture
        ? lastBackground[CARD_ROWS - 1]
        : (line & 15) === 0
          ? lastBackground[(cardRow + CARD_ROWS - 1) % CARD_ROWS]
          : lastBackground[cardRow];
      const out = (line + vDelay) * IMAGE_WIDTH;
      image.fill(0, out, out + hDelay);
      for (let x = 0; x + hDelay < IMAGE_WIDTH; x++) {
        let color = fill;
        let on = 0;
        if (inPicture && x >= PICTURE_X && x < PICTURE_X + PICTURE_WIDTH) {
          const at = row * PICTURE_WIDTH + x - PICTURE_X;
          color = background[at];
          on = backgroundOn[at];
        }
        const m = line * IMAGE_WIDTH + x;
        if (mobShown[m] && !(mobBehind[m] && on)) color = mobColor[m];
        image[out + x + hDelay] = color;
      }
    }

    const border = regs[REG_BORDER] & 0x0f;
    const edges = regs[REG_EDGE_MASK];
    const top = edges & 2 ? 32 : 16;
    const left = edges & 1 ? 16 : 8;
    image.fill(border, 0, top * IMAGE_WIDTH);
    image.fill(border, LAST_MOB_LINE * IMAGE_WIDTH);
    for (let line = top; line < LAST_MOB_LINE; line++) {
      const at = line * IMAGE_WIDTH;
      image.fill(border, at, at + left);
      image.fill(border, at + 167, at + IMAGE_WIDTH);
    }
  }

  /** Sets the collision registers' bits (they stay set until the CPU clears them). */
  private detectCollisions(): void {
    const { mobRows, mobActive, backgroundOn } = this.scratch;
    const regs = this.registers;
    const hDelay = regs[REG_H_DELAY] & 7;
    const vDelay = (regs[REG_V_DELAY] & 7) * 2;
    const edges = regs[REG_EDGE_MASK];
    const topBorderEnd = edges & 2 ? 32 : 16;

    const geometry = (mob: number) => {
      const xReg = regs[mob];
      const yReg = regs[0x08 + mob];
      return {
        x: xReg & 0x1ff, // with the "interacts" bit, as jzIntv compares them
        y: (yReg & 0x7f) << 1,
        width: xReg & 0x400 ? 16 : 8,
        height: MOB_HEIGHTS[(yReg >> 7) & 7],
        shift: (yReg >> 8) & 3,
      };
    };
    const interacts = (mob: number, x: number, y: number, xLimit: number) =>
      mobActive[mob] && x > 0x100 && x < xLimit - hDelay && y <= 0xd8 - vDelay;

    // Pixels off the left and right of the picture never collide with MOBs or the background.
    const trimmed = mobRows.map((rows, mob) => {
      const screenX = (regs[mob] & 0xff) + hDelay;
      let mask = 0xffff;
      for (let k = 0; k < 16; k++) if (screenX + k <= 6 || screenX + k >= 168) mask &= ~(0x8000 >> k);
      return rows.map((bits) => bits & mask);
    });

    for (let a = 0; a < 8; a++) {
      const A = geometry(a);
      if (!interacts(a, A.x, A.y, 0x1a8)) continue;
      const rowsA = trimmed[a];

      for (let b = a + 1; b < 8; b++) {
        if ((regs[0x18 + a] >> b) & 1 && (regs[0x18 + b] >> a) & 1) continue;
        const B = geometry(b);
        if (!interacts(b, B.x, B.y, 0x1a7)) continue;
        if ((A.x < B.x || A.x >= B.x + B.width) && (B.x < A.x || B.x >= A.x + A.width)) continue;
        if ((A.y < B.y || A.y >= B.y + B.height) && (B.y < A.y || B.y >= A.y + A.height)) continue;
        const shiftA = A.x < B.x ? B.x - A.x : 0;
        const shiftB = B.x < A.x ? A.x - B.x : 0;
        const clamp = (line: number) => Math.min(Math.max(line, 15 - vDelay), LAST_MOB_LINE - vDelay);
        const low = clamp(Math.max(A.y, B.y));
        const high = clamp(Math.min(A.y + A.height - 1, B.y + B.height - 1));
        for (let line = low; line <= high; line++) {
          if ((rowsA[(line - A.y) >> A.shift] << shiftA) & (trimmed[b][(line - B.y) >> B.shift] << shiftB)) {
            regs[0x18 + a] |= 1 << b;
            regs[0x18 + b] |= 1 << a;
            break;
          }
        }
      }

      const x = A.x & 0xff;
      if (!(regs[0x18 + a] & 0x100)) {
        const last = Math.min(A.y + A.height - 1, 206 - vDelay);
        search: for (let line = A.y; line <= last; line++) {
          const bits = rowsA[(line - A.y) >> A.shift];
          const row = (line >> 1) - PICTURE_ROW;
          if (!bits || row < 0 || row >= PICTURE_ROWS) continue;
          for (let k = 0; k < 16; k++) {
            const px = x + k - PICTURE_X;
            if (bits & (0x8000 >> k) && px >= 0 && px < PICTURE_WIDTH && backgroundOn[row * PICTURE_WIDTH + px]) {
              regs[0x18 + a] |= 0x100;
              break search;
            }
          }
        }
      }

      if (!(regs[0x18 + a] & 0x200)) {
        // The border's inner edge: column 7 (to 15 with the left edge masked), column 167,
        // line 15 (to 31 with the top masked) and line 208.
        const screenX = x + hDelay;
        const screenY = A.y + vDelay;
        search: for (let row = 0; row < A.height >> A.shift; row++) {
          const bits = mobRows[a][row];
          if (!bits) continue;
          for (let repeat = 0; repeat < 1 << A.shift; repeat++) {
            const line = screenY + (row << A.shift) + repeat;
            if (line < 15 || line > LAST_MOB_LINE) continue;
            for (let k = 0; k < 16; k++) {
              if (!(bits & (0x8000 >> k))) continue;
              const px = screenX + k;
              if (px < 7 || px > 167) continue;
              const onEdge =
                px === 7 || px === 167 || (edges & 1 && px <= 15) || line < topBorderEnd || line === LAST_MOB_LINE;
              if (onEdge) {
                regs[0x18 + a] |= 0x200;
                break search;
              }
            }
          }
        }
      }
    }
  }
}
