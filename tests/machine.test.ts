import { describe, expect, it } from 'vitest';
import { Cartridge } from '../src/cart/cartridge';
import { Intellivision } from '../src/intellivision';
import { keyBit } from '../src/io/controllers';
import { asm } from './helpers/asm';
import { testRoms } from './helpers/test-roms';

function machine(roms = testRoms()): Intellivision {
  const intv = new Intellivision();
  intv.setRoms(roms);
  return intv;
}

/** Test ROMs whose interrupt handler doesn't turn the display on. */
function romsWithDisplayOff() {
  const roms = testRoms();
  roms.exec.set([...asm.nop(), ...asm.nop(), ...asm.pulr(7)], 4);
  return roms;
}

describe('the frame', () => {
  it('lasts 14,934 CPU cycles (NTSC) or 19,968 (PAL)', () => {
    const intv = machine();
    intv.runFrame();
    const first = intv.frameStart;
    intv.runFrame();
    expect(intv.frameStart - first).toBe(14_934);
    intv.setTv('pal');
    intv.runFrame();
    intv.runFrame();
    const pal = intv.frameStart;
    intv.runFrame();
    expect(intv.frameStart - pal).toBe(19_968);
  });

  it('interrupts the CPU once a frame, and shows the next frame when the handler writes $20', () => {
    const intv = machine();
    for (let i = 0; i < 3; i++) intv.runFrame();
    expect(intv.stic.displayEnabled).toBe(true);
    const stack = intv.cpu.r[6];
    intv.runFrame();
    expect(intv.cpu.r[6]).toBe(stack);
    // BACKTAB's first card is the loop's count, drawn from the GROM in the colour stack.
    expect(new Set(intv.stic.framebuffer).size).toBeGreaterThan(1);

    const dark = machine(romsWithDisplayOff());
    for (let i = 0; i < 3; i++) dark.runFrame();
    expect(dark.stic.displayEnabled).toBe(false);
    expect(new Set(dark.stic.framebuffer)).toEqual(new Set([0]));
  });

  it('stops the CPU while the STIC fetches the cards, and not when the display is off', () => {
    const loops = (intv: Intellivision) => {
      for (let i = 0; i < 3; i++) intv.runFrame();
      const before = intv.cpu.r[1];
      intv.runFrame();
      return (intv.cpu.r[1] - before) & 0xffff;
    };
    const shown = loops(machine());
    const dark = loops(machine(romsWithDisplayOff()));
    expect(dark).toBeGreaterThan(shown);
    // 14 fetches of up to 108 cycles are about 10% of the frame.
    expect(dark / shown).toBeGreaterThan(1.05);
    expect(dark / shown).toBeLessThan(1.15);
  });
});

describe('the memory map', () => {
  it('has 8-bit scratch RAM, 16-bit system RAM, a read-only EXEC and an empty bus reading $FFFF', () => {
    const { bus } = machine();
    bus.write(0x0100, 0x1234);
    bus.write(0x0200, 0x1234);
    bus.write(0x1000, 0);
    expect(bus.read(0x0100)).toBe(0x34);
    expect(bus.read(0x0200)).toBe(0x1234);
    expect(bus.read(0x1000)).toBe(0x004);
    expect(bus.read(0x0400)).toBe(0xffff);
    expect(bus.read(0x5000)).toBe(0xffff);
  });

  it('reads the sound chip at $01F0-$01FD and the hand controllers at $01FE/$01FF', () => {
    const intv = machine();
    intv.bus.write(0x01f4, 0xff);
    expect(intv.bus.read(0x01f4)).toBe(0x0f);
    intv.controllers.inputs[0].set('test', { keys: keyBit('3') });
    expect(intv.bus.read(0x01ff)).toBe(~0x21 & 0xff);
    expect(intv.bus.read(0x01fe)).toBe(0xff);
  });

  it('reaches the STIC through its aliases, and GROM and GRAM at $3000-$39FF', () => {
    const intv = machine();
    intv.stic.registersUntil = intv.stic.graphicsUntil = Infinity;
    intv.bus.write(0x402c, 6);
    expect(intv.bus.read(0x002c) & 0x0f).toBe(6);
    expect(intv.bus.read(0x3008)).toBe(1);
    intv.bus.write(0x3800, 0x1ff);
    intv.bus.write(0x3e01, 0x22);
    expect(intv.bus.read(0x3800)).toBe(0xff);
    expect(intv.stic.gram[1]).toBe(0x22);
    intv.bus.write(0x3000, 5);
    expect(intv.bus.read(0x3000)).toBe(0);
  });

  it('puts the cartridge everywhere else, and clears its RAM on power up but not on reset', () => {
    const intv = machine();
    const cartridge = new Cartridge({ rom: [{ address: 0x5000, words: Uint16Array.of(0x2a5) }], ram: [{ address: 0xd000, length: 16, width: 16 }] });
    intv.insertCartridge(cartridge);
    expect(intv.bus.read(0x5000)).toBe(0x2a5);
    intv.bus.write(0xd000, 77);
    intv.pressReset();
    expect(intv.bus.read(0xd000)).toBe(77);
    intv.reset();
    expect(intv.bus.read(0xd000)).toBe(0);
  });
});
