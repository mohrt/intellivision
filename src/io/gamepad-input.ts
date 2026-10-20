import { NO_DIRECTION, discFromDirections, discFromVector, keyBit, type KeypadKey, type PadState } from './controllers';

/** Joystick directions, as bits, while working out which way a pad points. */
const Dir = { Up: 0x01, Right: 0x02, Down: 0x04, Left: 0x08 } as const;

/** The parts of the browser's Gamepad object we use (so tests can pass plain objects). */
export interface GamepadLike {
  readonly id: string;
  readonly index: number;
  readonly mapping: string;
  readonly connected?: boolean;
  readonly axes: readonly number[];
  readonly buttons: readonly { readonly pressed: boolean }[];
}

const AXIS_THRESHOLD = 0.5;
/** Axes never go past ±1; a hat switch reads about 1.29 when centred. */
const HAT_NEUTRAL_LIMIT = 1.05;

// Standard gamepad mapping (https://w3c.github.io/gamepad/#remapping)
const DPAD_UP = 12;
const DPAD_DOWN = 13;
const DPAD_LEFT = 14;
const DPAD_RIGHT = 15;
const TOP_BUTTON = 0;
const LOWER_RIGHT_BUTTON = 1;
const LOWER_LEFT_BUTTON = 2;
/** The other face, shoulder and middle buttons give the keypad keys games most often ask for. */
const KEYPAD_BUTTONS: [number, KeypadKey][] = [
  [3, 'enter'],
  [4, '1'],
  [5, '2'],
  [6, '3'],
  [7, '4'],
  [8, 'clear'],
  [9, 'enter'],
];

const HAT_STEPS = [
  Dir.Up,
  Dir.Up | Dir.Right,
  Dir.Right,
  Dir.Down | Dir.Right,
  Dir.Down,
  Dir.Down | Dir.Left,
  Dir.Left,
  Dir.Up | Dir.Left,
];

/**
 * Directions of a hat switch reported as one axis: eight positions from -1
 * (up) clockwise in steps of 2/7, and a value beyond ±1 when centred. Many USB
 * joysticks report their stick this way when the browser has no standard mapping.
 */
export function hatDirections(value: number): number {
  if (Math.abs(value) > HAT_NEUTRAL_LIMIT) return 0;
  return HAT_STEPS[Math.round((value + 1) * 3.5)] ?? 0;
}

/** Axes seen resting beyond ±1, which makes them hat switches, by pad id. */
const knownHatAxes = new Map<string, Set<number>>();

function hatAxes(pad: GamepadLike): Set<number> {
  let hats = knownHatAxes.get(pad.id);
  if (!hats) {
    hats = new Set();
    knownHatAxes.set(pad.id, hats);
  }
  pad.axes.forEach((value, index) => {
    if (Math.abs(value) > HAT_NEUTRAL_LIMIT) hats.add(index);
  });
  return hats;
}

function axisPairDirs(x: number, y: number): number {
  let dirs = 0;
  if (y < -AXIS_THRESHOLD) dirs |= Dir.Up;
  if (y > AXIS_THRESHOLD) dirs |= Dir.Down;
  if (x < -AXIS_THRESHOLD) dirs |= Dir.Left;
  if (x > AXIS_THRESHOLD) dirs |= Dir.Right;
  return dirs;
}

/**
 * A pad as an Intellivision hand controller: the D-pad, or the stick in all 16
 * of the disc's directions; A the top action buttons, X and B the lower left
 * and right ones; the rest keypad keys.
 */
export function readGamepad(pad: GamepadLike): PadState {
  const pressed = (i: number) => pad.buttons[i]?.pressed ?? false;
  const axes = pad.axes;
  let dirs = 0;
  let disc = NO_DIRECTION;
  if (pad.mapping === 'standard') {
    if (pressed(DPAD_UP)) dirs |= Dir.Up;
    if (pressed(DPAD_DOWN)) dirs |= Dir.Down;
    if (pressed(DPAD_LEFT)) dirs |= Dir.Left;
    if (pressed(DPAD_RIGHT)) dirs |= Dir.Right;
    const [x = 0, y = 0] = axes;
    if (!dirs && Math.hypot(x, y) > AXIS_THRESHOLD) disc = discFromVector(x, -y);
  } else {
    const hats = hatAxes(pad);
    if (!hats.has(0) && !hats.has(1)) dirs |= axisPairDirs(axes[0] ?? 0, axes[1] ?? 0);
    for (const index of hats) dirs |= hatDirections(axes[index] ?? 2);
  }
  if (disc === NO_DIRECTION) {
    disc = discFromDirections(!!(dirs & Dir.Up), !!(dirs & Dir.Right), !!(dirs & Dir.Down), !!(dirs & Dir.Left));
  }
  let keys = 0;
  for (const [button, key] of KEYPAD_BUTTONS) if (pressed(button)) keys |= keyBit(key);
  return {
    disc,
    keys,
    top: pressed(TOP_BUTTON),
    lowerLeft: pressed(LOWER_LEFT_BUTTON),
    lowerRight: pressed(LOWER_RIGHT_BUTTON),
  };
}

/** Connected gamepads in the order they were plugged in; the first is player 1, the second player 2. */
export class GamepadManager {
  private readonly connectOrder: number[] = [];

  constructor(private readonly source: () => readonly (GamepadLike | null)[] = browserGamepads) {}

  attach(target: Window): void {
    target.addEventListener('gamepadconnected', (event) => this.noteConnected((event as GamepadEvent).gamepad.index));
    target.addEventListener('gamepaddisconnected', (event) => {
      const at = this.connectOrder.indexOf((event as GamepadEvent).gamepad.index);
      if (at >= 0) this.connectOrder.splice(at, 1);
    });
  }

  private noteConnected(index: number): void {
    if (!this.connectOrder.includes(index)) this.connectOrder.push(index);
  }

  connected(): GamepadLike[] {
    const pads = [...this.source()].filter((pad): pad is GamepadLike => pad !== null && pad.connected !== false);
    for (const pad of pads) this.noteConnected(pad.index);
    const rank = (pad: GamepadLike) => this.connectOrder.indexOf(pad.index);
    return pads.sort((a, b) => rank(a) - rank(b));
  }
}

function browserGamepads(): readonly (GamepadLike | null)[] {
  try {
    return navigator.getGamepads?.() ?? [];
  } catch {
    // Blocked by a permissions policy.
    return [];
  }
}

/** A short, readable name for a pad (browsers add vendor and product codes). */
export function padName(pad: GamepadLike): string {
  return pad.id.replace(/\s*\(.*\)\s*$/, '').trim() || 'Gamepad';
}
