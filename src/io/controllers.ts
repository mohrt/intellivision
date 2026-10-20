/** The keypad's keys, top row first; a key's index is its bit in `PadState.keys`. */
export const KEYPAD_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'clear', '0', 'enter'] as const;
export type KeypadKey = (typeof KEYPAD_KEYS)[number];
export const keyBit = (key: KeypadKey): number => 1 << KEYPAD_KEYS.indexOf(key);

/** The lines each keypad key pulls low (read active low). */
const KEY_CODES = [0x81, 0x41, 0x21, 0x82, 0x42, 0x22, 0x84, 0x44, 0x24, 0x88, 0x48, 0x28];
/** The disc's 16 directions, clockwise from north. */
const DISC_CODES = [0x04, 0x14, 0x16, 0x06, 0x02, 0x12, 0x13, 0x03, 0x01, 0x11, 0x19, 0x09, 0x08, 0x18, 0x1c, 0x0c];
/** Both top buttons are wired together; the lower ones are separate. */
const TOP_CODE = 0xa0;
const LOWER_LEFT_CODE = 0x60;
const LOWER_RIGHT_CODE = 0xc0;

export const NO_DIRECTION = -1;

export interface PadState {
  /** The disc direction, 0-15 clockwise from north, or NO_DIRECTION. */
  disc: number;
  /** Pressed keypad keys, one bit per entry of KEYPAD_KEYS. */
  keys: number;
  top: boolean;
  lowerLeft: boolean;
  lowerRight: boolean;
}

const idle = (): PadState => ({ disc: NO_DIRECTION, keys: 0, top: false, lowerLeft: false, lowerRight: false });

/** The disc direction for up/right/down/left pressed together (8 directions), or NO_DIRECTION. */
export function discFromDirections(up: boolean, right: boolean, down: boolean, left: boolean): number {
  const y = (up ? 1 : 0) - (down ? 1 : 0);
  const x = (right ? 1 : 0) - (left ? 1 : 0);
  if (x === 0 && y === 0) return NO_DIRECTION;
  return discFromVector(x, y);
}

/** The nearest of the 16 disc directions to a vector (x right, y up). */
export function discFromVector(x: number, y: number): number {
  const angle = Math.atan2(x, y); // 0 is north, clockwise
  return ((Math.round((angle / (2 * Math.PI)) * 16) % 16) + 16) % 16;
}

/** The lines a controller pulls low (before inverting): everything pressed, wired together. */
export function padCode(state: PadState): number {
  let code = state.disc >= 0 ? DISC_CODES[state.disc & 15] : 0;
  KEY_CODES.forEach((keyCode, key) => {
    if (state.keys & (1 << key)) code |= keyCode;
  });
  if (state.top) code |= TOP_CODE;
  if (state.lowerLeft) code |= LOWER_LEFT_CODE;
  if (state.lowerRight) code |= LOWER_RIGHT_CODE;
  return code;
}

/** One hand controller, pressed by several input sources (keyboard, gamepad, on-screen pad) at once. */
export class ControllerInput {
  private readonly sources = new Map<string, PadState>();

  set(source: string, state: Partial<PadState>): void {
    this.sources.set(source, { ...idle(), ...state });
  }

  clear(source: string): void {
    this.sources.delete(source);
  }

  get state(): PadState {
    const merged = idle();
    for (const state of this.sources.values()) {
      if (merged.disc === NO_DIRECTION) merged.disc = state.disc;
      merged.keys |= state.keys;
      merged.top ||= state.top;
      merged.lowerLeft ||= state.lowerLeft;
      merged.lowerRight ||= state.lowerRight;
    }
    return merged;
  }
}

/**
 * The two hand controllers, read through the sound chip's I/O ports: the right
 * one at $01FE, the left one (player 1 in most games) at $01FF.
 */
export class Controllers {
  /** Player 1 (left controller), player 2 (right controller). */
  readonly inputs: readonly [ControllerInput, ControllerInput] = [new ControllerInput(), new ControllerInput()];

  /** Reads $01FE (port 0, right) or $01FF (port 1, left), active low. */
  read(port: 0 | 1): number {
    return ~padCode(this.inputs[port === 1 ? 0 : 1].state) & 0xff;
  }
}
