import { describe, expect, it } from 'vitest';
import {
  Controllers,
  NO_DIRECTION,
  discFromDirections,
  discFromVector,
  keyBit,
  padCode,
} from '../src/io/controllers';
import { GamepadManager, hatDirections, readGamepad, type GamepadLike } from '../src/io/gamepad-input';

function pad(overrides: Partial<GamepadLike> & { pressed?: number[] }): GamepadLike {
  const pressed = new Set(overrides.pressed ?? []);
  return {
    id: 'Test pad',
    index: 0,
    mapping: 'standard',
    axes: [0, 0, 0, 0],
    buttons: Array.from({ length: 17 }, (_, i) => ({ pressed: pressed.has(i) })),
    ...overrides,
  };
}

const idle = { disc: NO_DIRECTION, keys: 0, top: false, lowerLeft: false, lowerRight: false };

describe('hand controllers', () => {
  it('pulls low the lines of each key, disc direction and action button', () => {
    expect(padCode({ ...idle, keys: keyBit('1') })).toBe(0x81);
    expect(padCode({ ...idle, keys: keyBit('enter') })).toBe(0x28);
    expect(padCode({ ...idle, disc: 0 })).toBe(0x04);
    expect(padCode({ ...idle, disc: 4 })).toBe(0x02);
    expect(padCode({ ...idle, disc: 8 })).toBe(0x01);
    expect(padCode({ ...idle, disc: 12 })).toBe(0x08);
    expect(padCode({ ...idle, top: true })).toBe(0xa0);
    expect(padCode({ ...idle, lowerLeft: true, lowerRight: true })).toBe(0xe0);
  });

  it('reads the left controller (player 1) at $01FF and the right at $01FE, active low', () => {
    const controllers = new Controllers();
    controllers.inputs[0].set('test', { keys: keyBit('5') });
    controllers.inputs[1].set('test', { disc: 2 });
    expect(controllers.read(1)).toBe(~0x42 & 0xff);
    expect(controllers.read(0)).toBe(~0x16 & 0xff);
    controllers.inputs[0].clear('test');
    expect(controllers.read(1)).toBe(0xff);
  });

  it('merges input sources: the first disc direction, and every key and button', () => {
    const controllers = new Controllers();
    const input = controllers.inputs[0];
    input.set('keyboard', { disc: 4 });
    input.set('gamepad', { disc: 12, keys: keyBit('9'), top: true });
    expect(input.state).toEqual({ disc: 4, keys: keyBit('9'), top: true, lowerLeft: false, lowerRight: false });
  });

  it('turns arrow keys into 8 disc directions and a vector into 16', () => {
    expect(discFromDirections(true, false, false, false)).toBe(0);
    expect(discFromDirections(true, true, false, false)).toBe(2);
    expect(discFromDirections(false, false, true, true)).toBe(10);
    expect(discFromDirections(true, false, true, false)).toBe(NO_DIRECTION);
    expect(discFromVector(1, 0.4)).toBe(3);
    expect(discFromVector(-0.2, -1)).toBe(9);
  });
});

describe('gamepads', () => {
  it('maps the D-pad, the buttons and the stick in 16 directions', () => {
    expect(readGamepad(pad({ pressed: [12, 15, 0] }))).toMatchObject({ disc: 2, top: true });
    expect(readGamepad(pad({ pressed: [1, 2, 9] }))).toMatchObject({ lowerRight: true, lowerLeft: true, keys: keyBit('enter') });
    expect(readGamepad(pad({ pressed: [8, 4] })).keys).toBe(keyBit('clear') | keyBit('1'));
    expect(readGamepad(pad({ axes: [0.9, -0.35, 0, 0] })).disc).toBe(3);
    expect(readGamepad(pad({ axes: [0.2, 0.2, 0, 0] })).disc).toBe(NO_DIRECTION);
  });

  it('reads joysticks without a standard mapping from their axes or hat', () => {
    expect(readGamepad(pad({ mapping: '', axes: [-1, 0] })).disc).toBe(12);
    expect(hatDirections(-1)).toBe(0x01);
    expect(hatDirections(1.29)).toBe(0);
    expect(readGamepad(pad({ mapping: '', axes: [0, 0, 0, 0, 0, 0, 0, 0, 0, -1 + 2 / 7] })).disc).toBe(NO_DIRECTION);
  });

  it('numbers pads in the order they were plugged in', () => {
    const second = pad({ index: 1 });
    const first = pad({ index: 3 });
    let pads: (GamepadLike | null)[] = [null, second];
    const manager = new GamepadManager(() => pads);
    expect(manager.connected().map((p) => p.index)).toEqual([1]);
    pads = [null, second, null, first];
    expect(manager.connected().map((p) => p.index)).toEqual([1, 3]);
  });
});
