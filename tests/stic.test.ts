import { describe, expect, it } from 'vitest';
import { FRAME_TOP, FRAME_WIDTH, Stic } from '../src/stic/stic';

/** A STIC whose registers are always open, with card n of the GROM being n's bit pattern on every row. */
function open(): Stic {
  const stic = new Stic();
  stic.reset();
  stic.grom = Uint8Array.from({ length: 0x800 }, (_, i) => i >> 3);
  stic.registersUntil = stic.graphicsUntil = Infinity;
  for (let reg = 0; reg < 0x20; reg++) stic.writeRegister(reg, 0, 0);
  for (let reg = 0x28; reg <= 0x32; reg++) stic.writeRegister(reg, 0, 0);
  stic.readRegister(0x21, 0); // Color Stack mode
  return stic;
}

/** Puts `cards` at the start of BACKTAB and has the STIC fetch it all. */
function show(stic: Stic, cards: number[]): void {
  const backtab = new Uint16Array(240);
  backtab.set(cards);
  for (let row = 0; row < 12; row++) stic.fetchRow(row, backtab);
  stic.render();
}

/** The colour at a STIC picture position: x in MOB coordinates (the cards start at 8), y in scanlines. */
const pixel = (stic: Stic, x: number, line: number) => stic.framebuffer[(line - FRAME_TOP) * FRAME_WIDTH + x];
/** The colour at background pixel (x, y) of the 160x96 card area. */
const cardPixel = (stic: Stic, x: number, y: number) => pixel(stic, 8 + x, 16 + y * 2);

describe('STIC registers', () => {
  it('reads back only the bits each register has, the rest as fixed values', () => {
    const stic = open();
    stic.writeRegister(0x00, 0xffff, 0);
    stic.writeRegister(0x28, 0xffff, 0);
    stic.writeRegister(0x30, 0x000a, 0);
    expect(stic.readRegister(0x00, 0)).toBe(0x3fff);
    expect(stic.readRegister(0x08, 0)).toBe(0x3000);
    expect(stic.readRegister(0x28, 0)).toBe(0x3fff);
    expect(stic.readRegister(0x30, 0)).toBe(0x3ffa);
    expect(stic.readRegister(0x22, 0)).toBe(0x3fff);
  });

  it('is only reachable between the interrupt and the end of its window', () => {
    const stic = open();
    stic.accessFrom = 100;
    stic.registersUntil = 200;
    stic.graphicsUntil = 300;
    stic.writeRegister(0x2c, 5, 50);
    stic.writeRegister(0x2c, 6, 250);
    expect(stic.readRegister(0x2c, 150) & 0x0f).toBe(0);
    stic.writeRegister(0x2c, 7, 150);
    expect(stic.readRegister(0x2c, 150) & 0x0f).toBe(7);
    expect(stic.readRegister(0x2c, 250)).toBe(0x2c & 0x0e);
    stic.writeGraphics(0x800, 0x55, 250);
    stic.writeGraphics(0x801, 0x66, 350);
    expect(stic.readGraphics(0x800, 250)).toBe(0x55);
    expect(stic.gram[1]).toBe(0);
    expect(stic.readGraphics(0x800, 350)).toBe(0x800);
  });

  it('switches to Foreground/Background mode on a write of $21, and back on a read', () => {
    const stic = open();
    stic.writeRegister(0x21, 0, 0);
    expect(stic.colorStackMode).toBe(false);
    stic.readRegister(0x4021, 0);
    expect(stic.colorStackMode).toBe(true);
  });

  it('counts a write to $20 as turning the display on', () => {
    const stic = open();
    stic.enableRequested = false;
    stic.writeRegister(0x20, 0, 0);
    expect(stic.enableRequested).toBe(true);
  });
});

describe('STIC background', () => {
  it('draws Color Stack cards in their colour over the stack, which moves on with bit 13', () => {
    const stic = open();
    stic.writeRegister(0x28, 1, 0);
    stic.writeRegister(0x29, 5, 0);
    // GROM card $0F (right half on) in red; then the same card in tan, moving the stack on.
    show(stic, [(0x0f << 3) | 2, 0x2000 | (0x0f << 3) | 3]);
    expect(cardPixel(stic, 0, 0)).toBe(1);
    expect(cardPixel(stic, 4, 0)).toBe(2);
    expect(cardPixel(stic, 8, 7)).toBe(5);
    expect(cardPixel(stic, 12, 7)).toBe(3);
    // The stack stays moved for the following cards.
    expect(cardPixel(stic, 16, 0)).toBe(5);
  });

  it('uses GRAM cards, whose colour can be any of the 16', () => {
    const stic = open();
    stic.gram.fill(0x80, 8, 16);
    show(stic, [0x0800 | (1 << 3) | 0x1000 | 4]);
    expect(cardPixel(stic, 0, 3)).toBe(12);
    expect(cardPixel(stic, 1, 3)).toBe(0);
  });

  it('draws Colored Squares cards, with colour 7 showing the stack', () => {
    const stic = open();
    stic.writeRegister(0x28, 9, 0);
    // Squares 3 (tan), 7 (the stack), 4 (dark green), 6 (yellow).
    show(stic, [0x1000 | 3 | (7 << 3) | (4 << 6) | ((6 & 3) << 9) | 0x2000]);
    expect([cardPixel(stic, 0, 0), cardPixel(stic, 7, 0), cardPixel(stic, 0, 7), cardPixel(stic, 7, 7)]).toEqual([3, 9, 4, 6]);
  });

  it('draws Foreground/Background cards with their own background colour', () => {
    const stic = open();
    stic.writeRegister(0x21, 0, 0);
    // Yellow on colour 9 (bits 9 and 12).
    show(stic, [6 | (0x0f << 3) | 0x0200 | 0x1000]);
    expect(cardPixel(stic, 0, 0)).toBe(9);
    expect(cardPixel(stic, 7, 0)).toBe(6);
  });

  it('puts the border round the picture and shifts the picture by the delay registers', () => {
    const stic = open();
    stic.writeRegister(0x2c, 10, 0);
    stic.writeRegister(0x30, 3, 0);
    stic.writeRegister(0x31, 2, 0);
    show(stic, [(0x80 << 3) | 2]);
    expect(pixel(stic, 3, 100)).toBe(10);
    expect(pixel(stic, 170, 100)).toBe(10);
    expect(pixel(stic, 50, 10)).toBe(10);
    // The card's leftmost pixel moves 3 right and 2 rows (4 lines) down.
    expect(pixel(stic, 11, 20)).toBe(2);
    expect(pixel(stic, 11, 16)).not.toBe(2);
  });

  it('masks the leftmost column and the top row of cards with border when asked', () => {
    const stic = open();
    stic.writeRegister(0x2c, 10, 0);
    stic.writeRegister(0x32, 3, 0);
    show(stic, [(0xff << 3) | 2, (0xff << 3) | 2]);
    expect(pixel(stic, 12, 40)).toBe(10);
    expect(cardPixel(stic, 8, 2)).toBe(10);
  });
});

describe('STIC moving objects', () => {
  /** MOB `mob` showing GROM card $FF (solid) in `color` at (x, y). */
  function placeMob(stic: Stic, mob: number, x: number, y: number, color: number, extra = { x: 0, y: 0, a: 0 }) {
    stic.writeRegister(mob, 0x300 | x | extra.x, 0);
    stic.writeRegister(0x08 + mob, y | extra.y, 0);
    stic.writeRegister(0x10 + mob, (0xff << 3) | (color & 7) | ((color & 8) << 9) | extra.a, 0);
  }

  it('draws a MOB 8 pixels wide and 8 lines tall, or bigger with the size bits', () => {
    const stic = open();
    placeMob(stic, 0, 20, 10, 6);
    placeMob(stic, 1, 60, 10, 13, { x: 0x400, y: 0x200, a: 0 });
    show(stic, []);
    expect(pixel(stic, 20, 20)).toBe(6);
    expect(pixel(stic, 27, 27)).toBe(6);
    expect(pixel(stic, 28, 20)).toBe(0);
    expect(pixel(stic, 20, 28)).toBe(0);
    // Double width and 4 lines a row: 16 x 32.
    expect(pixel(stic, 75, 51)).toBe(13);
    expect(pixel(stic, 76, 20)).toBe(0);
    expect(pixel(stic, 60, 52)).toBe(0);
  });

  it('puts lower-numbered MOBs in front, and MOBs with the priority bit behind the cards', () => {
    const stic = open();
    placeMob(stic, 3, 8, 8, 2);
    placeMob(stic, 1, 10, 8, 5, { x: 0, y: 0, a: 0x2000 });
    // A card whose left half (x 8-11) is on, in blue, over a black stack.
    show(stic, [(0xf0 << 3) | 1]);
    expect(pixel(stic, 9, 16)).toBe(2);
    // MOB 1 is in front of MOB 3 but behind the card's "on" pixels...
    expect(pixel(stic, 10, 16)).toBe(1);
    // ...and in front of its "off" ones.
    expect(pixel(stic, 13, 16)).toBe(5);
    expect(pixel(stic, 17, 16)).toBe(5);
  });

  it('turns a MOB round with the flip bits', () => {
    const stic = open();
    stic.gram.set([0x80, 0, 0, 0, 0, 0, 0, 0]);
    stic.writeRegister(0, 0x300 | 30, 0);
    stic.writeRegister(8, 10 | 0x400 | 0x800, 0);
    stic.writeRegister(0x10, 0x0800 | 7, 0);
    show(stic, []);
    expect(pixel(stic, 37, 27)).toBe(7);
    expect(pixel(stic, 30, 20)).toBe(0);
  });

  it('records collisions between MOBs, with the background and with the border, until cleared', () => {
    const stic = open();
    placeMob(stic, 0, 30, 30, 2);
    placeMob(stic, 2, 34, 33, 3);
    placeMob(stic, 4, 100, 30, 4);
    placeMob(stic, 5, 4, 60, 5);
    // A solid card under MOB 4: Y 30 is picture row 22 (card row 2), X 100 is card column 11.
    const cards = new Array(240).fill(0);
    cards[2 * 20 + 11] = (0xff << 3) | 1;
    show(stic, cards);
    const collisions = (mob: number) => stic.readRegister(0x18 + mob, 0) & 0x3ff;
    expect(collisions(0)).toBe(1 << 2);
    expect(collisions(2)).toBe(1 << 0);
    expect(collisions(4)).toBe(0x100);
    expect(collisions(5)).toBe(0x200);
    stic.writeRegister(0x18, 0, 0);
    expect(collisions(0)).toBe(0);
  });

  it('lets a MOB that is invisible but interacting collide, and ignores one that does not interact', () => {
    const stic = open();
    stic.writeRegister(0, 0x100 | 50, 0);
    stic.writeRegister(8, 50, 0);
    stic.writeRegister(0x10, 0xff << 3, 0);
    stic.writeRegister(1, 0x200 | 52, 0);
    stic.writeRegister(9, 50, 0);
    stic.writeRegister(0x11, 0xff << 3, 0);
    placeMob(stic, 2, 54, 52, 3);
    show(stic, []);
    expect(stic.readRegister(0x18, 0) & 0x3ff).toBe(1 << 2);
    expect(stic.readRegister(0x19, 0) & 0x3ff).toBe(0);
    expect(pixel(stic, 51, 100)).toBe(0);
  });
});
