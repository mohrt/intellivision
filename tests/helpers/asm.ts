/** Encoders for CP1610 instructions, so tests read like assembly. Each returns the instruction's words. */

const ALU = { mov: 2, add: 3, sub: 4, cmp: 5, and: 6, xor: 7 } as const;
const MEMORY = { mvo: 1, mvi: 2, add: 3, sub: 4, cmp: 5, and: 6, xor: 7 } as const;
const CONDITIONS = {
  b: 0, bc: 1, bov: 2, bpl: 3, beq: 4, blt: 5, ble: 6, busc: 7,
  nopp: 8, bnc: 9, bnov: 10, bmi: 11, bneq: 12, bge: 13, bgt: 14, besc: 15,
} as const;
const SHIFTS = { swap: 0, sll: 1, rlc: 2, sllc: 3, slr: 4, sar: 5, rrc: 6, sarc: 7 } as const;

export const asm = {
  hlt: () => [0x000],
  sdbd: () => [0x001],
  eis: () => [0x002],
  dis: () => [0x003],
  clrc: () => [0x006],
  setc: () => [0x007],
  nop: () => [0x034],
  incr: (reg: number) => [0x008 | reg],
  decr: (reg: number) => [0x010 | reg],
  comr: (reg: number) => [0x018 | reg],
  negr: (reg: number) => [0x020 | reg],
  adcr: (reg: number) => [0x028 | reg],
  gswd: (reg: number) => [0x030 | reg],
  rswd: (reg: number) => [0x038 | reg],
  shift: (kind: keyof typeof SHIFTS, reg: number, two = false) => [0x040 | (SHIFTS[kind] << 3) | (two ? 4 : 0) | reg],
  reg: (kind: keyof typeof ALU, src: number, dst: number) => [(ALU[kind] << 6) | (src << 3) | dst],
  direct: (kind: keyof typeof MEMORY, address: number, reg: number) => [0x200 | (MEMORY[kind] << 6) | reg, address],
  /** MVO@, MVI@, ADD@...: through pointer register `ptr` (R1-R6). */
  indirect: (kind: keyof typeof MEMORY, ptr: number, reg: number) => [0x200 | (MEMORY[kind] << 6) | (ptr << 3) | reg],
  immediate: (kind: keyof typeof MEMORY, value: number, reg: number) => [0x200 | (MEMORY[kind] << 6) | 0x38 | reg, value],
  mvii: (value: number, reg: number) => asm.immediate('mvi', value, reg),
  pshr: (reg: number) => asm.indirect('mvo', 6, reg),
  pulr: (reg: number) => asm.indirect('mvi', 6, reg),
  /** A branch at `at` to `target`. */
  branch: (kind: keyof typeof CONDITIONS, at: number, target: number) =>
    target >= at + 2 ? [0x200 | CONDITIONS[kind], target - at - 2] : [0x220 | CONDITIONS[kind], at + 1 - target],
  /** J (no register), JSR (R4-R6); interrupts: 1 enables, 2 disables. */
  jump: (target: number, saveTo: number | null = null, interrupts = 0) => [
    0x004,
    ((saveTo === null ? 3 : saveTo - 4) << 8) | (((target >> 10) & 0x3f) << 2) | interrupts,
    target & 0x3ff,
  ],
};
