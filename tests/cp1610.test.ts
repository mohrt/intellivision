import { describe, expect, it } from 'vitest';
import { Cp1610 } from '../src/cpu/cp1610';
import { asm } from './helpers/asm';
import { FlatBus } from './helpers/flat-bus';

const ORIGIN = 0x5000;

/** A CPU at ORIGIN with `instructions` loaded there. */
function cpuWith(...instructions: number[][]) {
  const bus = new FlatBus();
  bus.load(ORIGIN, instructions.flat());
  const cpu = new Cp1610(bus);
  cpu.reset();
  cpu.r[7] = ORIGIN;
  return { cpu, bus };
}

/** Runs `count` instructions and returns the cycles each took. */
const run = (cpu: Cp1610, count: number) => Array.from({ length: count }, () => cpu.step());
const flags = (cpu: Cp1610) => ({ s: cpu.s, z: cpu.z, o: cpu.o, c: cpu.c });

describe('CP1610 moves', () => {
  it('moves through immediate, direct and indirect operands, with their timings', () => {
    const { cpu, bus } = cpuWith(
      asm.mvii(0x1234, 0),
      asm.direct('mvo', 0x0300, 0),
      asm.direct('mvi', 0x0300, 1),
      asm.mvii(0x0300, 4),
      asm.indirect('mvi', 4, 2),
      asm.indirect('mvo', 4, 0),
    );
    expect(run(cpu, 6)).toEqual([8, 11, 10, 8, 8, 9]);
    expect(cpu.r[1]).toBe(0x1234);
    expect(cpu.r[2]).toBe(0x1234);
    // R4 steps on after each access.
    expect(cpu.r[4]).toBe(0x0302);
    expect(bus.memory[0x0301]).toBe(0x1234);
  });

  it('pushes and pops through R6', () => {
    const { cpu, bus } = cpuWith(asm.mvii(0x0200, 6), asm.mvii(0xbeef, 3), asm.pshr(3), asm.pulr(5));
    const cycles = run(cpu, 4);
    expect(bus.memory[0x0200]).toBe(0xbeef);
    expect(cpu.r[5]).toBe(0xbeef);
    expect(cpu.r[6]).toBe(0x0200);
    expect(cycles.slice(2)).toEqual([9, 12]);
  });

  it('reads a 16-bit value as two bytes after SDBD, from the instruction or through R4', () => {
    const { cpu, bus } = cpuWith(asm.sdbd(), [0x02b8, 0x0034, 0xff12], asm.mvii(0x0300, 4), asm.sdbd(), asm.indirect('mvi', 4, 1));
    bus.memory[0x0300] = 0xff78;
    bus.memory[0x0301] = 0x0056;
    const cycles = run(cpu, 5);
    expect(cpu.r[0]).toBe(0x1234);
    expect(cpu.r[1]).toBe(0x5678);
    expect(cpu.r[4]).toBe(0x0302);
    expect(cycles).toEqual([4, 10, 8, 4, 10]);
  });

  it('writes into the instruction stream with MVOI', () => {
    const { cpu, bus } = cpuWith(asm.mvii(0x0abc, 2), asm.immediate('mvo', 0, 2));
    run(cpu, 2);
    expect(bus.memory[ORIGIN + 3]).toBe(0x0abc);
  });

  it('sees the address of the next instruction when reading R7', () => {
    const { cpu } = cpuWith(asm.reg('mov', 7, 1));
    run(cpu, 1);
    expect(cpu.r[1]).toBe(ORIGIN + 1);
  });

  it('jumps by writing R7, taking a cycle more', () => {
    const { cpu } = cpuWith(asm.mvii(0x6000, 3), asm.reg('mov', 3, 7));
    expect(run(cpu, 2)).toEqual([8, 7]);
    expect(cpu.pc).toBe(0x6000);
  });
});

describe('CP1610 arithmetic', () => {
  it('sets carry and zero when an add wraps, and overflow when the sign goes wrong', () => {
    const { cpu } = cpuWith(
      asm.mvii(0xffff, 0),
      asm.mvii(0x0001, 1),
      asm.reg('add', 1, 0),
      asm.mvii(0x7fff, 2),
      asm.reg('add', 1, 2),
    );
    run(cpu, 3);
    expect(cpu.r[0]).toBe(0);
    expect(flags(cpu)).toEqual({ s: 0, z: 1, o: 0, c: 1 });
    run(cpu, 2);
    expect(cpu.r[2]).toBe(0x8000);
    expect(flags(cpu)).toEqual({ s: 1, z: 0, o: 1, c: 0 });
  });

  it('subtracts with carry meaning "no borrow"', () => {
    const { cpu } = cpuWith(asm.mvii(5, 0), asm.mvii(3, 1), asm.reg('sub', 1, 0), asm.reg('sub', 0, 1));
    run(cpu, 3);
    expect(cpu.r[0]).toBe(2);
    expect(cpu.c).toBe(1);
    run(cpu, 1);
    expect(cpu.r[1]).toBe(1);
    expect(cpu.c).toBe(1);
    const { cpu: other } = cpuWith(asm.mvii(3, 0), asm.immediate('sub', 5, 0));
    run(other, 2);
    expect(other.r[0]).toBe(0xfffe);
    expect(flags(other)).toEqual({ s: 1, z: 0, o: 0, c: 0 });
  });

  it('compares without storing, and does the one-operand register instructions', () => {
    const { cpu } = cpuWith(
      asm.mvii(10, 0),
      asm.immediate('cmp', 10, 0),
      asm.incr(0),
      asm.negr(0),
      asm.comr(0),
      asm.setc(),
      asm.adcr(0),
    );
    run(cpu, 2);
    expect(cpu.r[0]).toBe(10);
    expect(cpu.z).toBe(1);
    run(cpu, 2);
    expect(cpu.r[0]).toBe(0xfff5);
    run(cpu, 1);
    expect(cpu.r[0]).toBe(10);
    run(cpu, 2);
    expect(cpu.r[0]).toBe(11);
  });

  it('ands and xors, and clears a register with XORR', () => {
    const { cpu } = cpuWith(asm.mvii(0xf0f0, 0), asm.immediate('and', 0x3c3c, 0), asm.reg('xor', 0, 0));
    run(cpu, 2);
    expect(cpu.r[0]).toBe(0x3030);
    run(cpu, 1);
    expect(cpu.r[0]).toBe(0);
    expect(cpu.z).toBe(1);
  });

  it('keeps the flags in GSWD and restores them with RSWD', () => {
    const { cpu } = cpuWith(asm.mvii(0x00a0, 1), asm.rswd(1), asm.gswd(2));
    run(cpu, 3);
    expect(flags(cpu)).toEqual({ s: 1, z: 0, o: 1, c: 0 });
    expect(cpu.r[2]).toBe(0xa0a0);
  });
});

describe('CP1610 shifts', () => {
  it('swaps bytes, or copies the low byte to both', () => {
    const { cpu } = cpuWith(asm.mvii(0x1280, 0), asm.shift('swap', 0), asm.shift('swap', 0, true));
    run(cpu, 2);
    expect(cpu.r[0]).toBe(0x8012);
    expect(cpu.s).toBe(0);
    run(cpu, 1);
    expect(cpu.r[0]).toBe(0x1212);
  });

  it('shifts left and right by one or two, with the right shifts taking the sign from bit 7', () => {
    const { cpu } = cpuWith(
      asm.mvii(0x4001, 1),
      asm.shift('sll', 1, true),
      asm.mvii(0x8100, 2),
      asm.shift('sar', 2),
      asm.mvii(0x8100, 3),
      asm.shift('slr', 3),
    );
    const cycles = run(cpu, 6);
    expect(cpu.r[1]).toBe(0x0004);
    expect(cpu.r[2]).toBe(0xc080);
    expect(cpu.r[3]).toBe(0x4080);
    expect(cpu.s).toBe(1);
    expect([cycles[1], cycles[3]]).toEqual([8, 6]);
  });

  it('rotates through carry, and through carry and overflow by two', () => {
    const { cpu } = cpuWith(asm.mvii(0x8000, 0), asm.clrc(), asm.shift('rlc', 0), asm.shift('rlc', 0), asm.mvii(0xc000, 1), asm.shift('rlc', 1, true));
    run(cpu, 3);
    expect(cpu.r[0]).toBe(0);
    expect(cpu.c).toBe(1);
    run(cpu, 1);
    expect(cpu.r[0]).toBe(1);
    expect(cpu.c).toBe(0);
    run(cpu, 2);
    expect(cpu.r[1]).toBe(0);
    expect([cpu.c, cpu.o]).toEqual([1, 1]);
  });
});

describe('CP1610 branches and jumps', () => {
  it('branches forwards and backwards, 9 cycles taken and 7 not', () => {
    const { cpu } = cpuWith(
      asm.mvii(1, 0), // $5000
      asm.decr(0), // $5002
      asm.branch('bneq', 0x5003, 0x5002), // $5003: not taken (R0 is 0 now)
      asm.branch('beq', 0x5005, 0x5009), // $5005: taken
      asm.hlt(),
      asm.hlt(),
      asm.branch('b', 0x5009, 0x5002), // $5009: back
    );
    const cycles = run(cpu, 5);
    expect(cycles.slice(2)).toEqual([7, 9, 9]);
    expect(cpu.pc).toBe(0x5002);
  });

  it('calls with JSR, saving the return address, and returns with MOVR R5, R7', () => {
    const { cpu, bus } = cpuWith(asm.jump(0x5100, 5));
    bus.load(0x5100, asm.reg('mov', 5, 7));
    expect(run(cpu, 1)).toEqual([13]);
    expect(cpu.r[5]).toBe(ORIGIN + 3);
    run(cpu, 1);
    expect(cpu.pc).toBe(ORIGIN + 3);
  });

  it('turns interrupts on or off with JE and JD', () => {
    const { cpu, bus } = cpuWith(asm.jump(0x5100, null, 1));
    bus.load(0x5100, asm.jump(0x5200, null, 2));
    run(cpu, 1);
    expect(cpu.i).toBe(1);
    run(cpu, 1);
    expect(cpu.i).toBe(0);
  });
});

describe('CP1610 interrupts', () => {
  it('pushes the PC and jumps to the EXEC handler, in 12 cycles', () => {
    const { cpu, bus } = cpuWith(asm.mvii(0x0200, 6));
    run(cpu, 1);
    expect(cpu.interrupt()).toBe(12);
    expect(cpu.pc).toBe(0x1004);
    expect(bus.memory[0x0200]).toBe(ORIGIN + 2);
    expect(cpu.r[6]).toBe(0x0201);
  });

  it('accepts interrupts only with them enabled, and not straight after EIS or an MVO', () => {
    const { cpu } = cpuWith(asm.eis(), asm.nop(), asm.direct('mvo', 0x0300, 0), asm.nop());
    run(cpu, 1);
    expect(cpu.acceptsInterrupt).toBe(false);
    run(cpu, 1);
    expect(cpu.acceptsInterrupt).toBe(true);
    run(cpu, 1);
    expect(cpu.acceptsInterrupt).toBe(false);
    expect(cpu.acceptsBusRequest).toBe(false);
    run(cpu, 1);
    expect(cpu.acceptsBusRequest).toBe(true);
  });
});
