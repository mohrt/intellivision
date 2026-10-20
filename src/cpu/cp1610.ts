/** The memory side of the CPU: 16-bit words at 16-bit addresses. */
export interface CpuBus {
  read(address: number): number;
  write(address: number, value: number): void;
}

/** Where the Intellivision's EXEC puts its interrupt handler. */
export const INTERRUPT_VECTOR = 0x1004;
export const RESET_VECTOR = 0x1000;

/** `intr` bits: what the CPU may respond to after the instruction it just ran. */
const ALLOW_INTERRUPT = 1;
const ALLOW_BUS_REQUEST = 2;

/**
 * The General Instrument CP1610: eight 16-bit registers (R6 is the stack
 * pointer, R7 the program counter), sign, zero, overflow and carry flags, and
 * 10-bit instruction words. Instruction timings, and the quirks of which
 * register values an instruction sees, follow jzIntv, the reference
 * Intellivision emulator. Interrupts and the STIC's bus requests are only taken
 * between instructions, and not after the "non-interruptible" ones (SDBD, EIS,
 * DIS, the shifts, every MVO, ...).
 */
export class Cp1610 {
  readonly r = new Uint16Array(8);
  s = 0;
  z = 0;
  o = 0;
  c = 0;
  /** Interrupts enabled (EIS / DIS). */
  i = 0;
  /** Set by SDBD: 2 while it runs, 1 during the next instruction, which then reads its operand as two bytes. */
  d = 0;
  /** What may interrupt the CPU before its next instruction (ALLOW_* bits). */
  intr = 0;
  halted = false;

  constructor(private readonly bus: CpuBus) {}

  reset(): void {
    this.r.fill(0);
    this.r[7] = RESET_VECTOR;
    this.s = this.z = this.o = this.c = this.i = this.d = 0;
    this.intr = 0;
    this.halted = false;
  }

  get pc(): number {
    return this.r[7];
  }

  /** Whether an interrupt request would be taken now. */
  get acceptsInterrupt(): boolean {
    return (this.intr & ALLOW_INTERRUPT) !== 0;
  }

  /** Whether the STIC's bus request would be acknowledged now. */
  get acceptsBusRequest(): boolean {
    return (this.intr & ALLOW_BUS_REQUEST) !== 0;
  }

  /** Takes an interrupt: pushes the PC and jumps to `vector`. Returns the cycles it took. */
  interrupt(vector = INTERRUPT_VECTOR): number {
    const r = this.r;
    this.bus.write(r[6], r[7]);
    r[6]++;
    r[7] = vector;
    return 12;
  }

  /** Runs one instruction and returns the cycles it took. */
  step(): number {
    if (this.halted) return 4;
    const pc = this.r[7];
    const op = this.bus.read(pc) & 0x3ff;
    this.intr = ALLOW_BUS_REQUEST | this.i;
    let cycles: number;
    if (op >= 0x240) cycles = this.memoryOp(op, pc);
    else if (op >= 0x200) cycles = this.branch(op, pc);
    else if (op >= 0x080) cycles = this.registerOp(op, pc);
    else if (op >= 0x040) cycles = this.shift(op, pc);
    else if (op >= 0x008) cycles = this.singleRegister(op, pc);
    else cycles = this.implied(op, pc);
    this.d >>= 1;
    return cycles;
  }

  // --- Flags ----------------------------------------------------------------------

  private setSz(value: number): number {
    this.s = (value >> 15) & 1;
    this.z = value === 0 ? 1 : 0;
    return value;
  }

  private add(a: number, b: number, carryIn = 0): number {
    const sum = a + b + carryIn;
    const result = sum & 0xffff;
    this.c = sum >> 16;
    this.o = ((~(a ^ b) & (a ^ result)) >> 15) & 1;
    return this.setSz(result);
  }

  /** b - a, as b + ~a + 1 (so carry means "no borrow"). */
  private subtract(a: number, b: number): number {
    const sum = b + (a ^ 0xffff) + 1;
    const result = sum & 0xffff;
    this.c = sum >> 16;
    this.o = (((a ^ b) & (b ^ result)) >> 15) & 1;
    return this.setSz(result);
  }

  /** The 2-op ALU, shared by the register, direct, indirect and immediate forms. */
  private alu(kind: number, operand: number, register: number): number | null {
    switch (kind) {
      case 3:
        return this.add(operand, register);
      case 4:
        return this.subtract(operand, register);
      case 5:
        this.subtract(operand, register);
        return null;
      case 6:
        return this.setSz(operand & register);
      default:
        return this.setSz(operand ^ register);
    }
  }

  // --- Instruction groups ---------------------------------------------------------

  /** $000-$007: HLT, SDBD, EIS, DIS, J/JSR, TCI, CLRC, SETC. */
  private implied(op: number, pc: number): number {
    const r = this.r;
    if (op === 0x004) return this.jump(pc);
    r[7] = pc + 1;
    this.intr = 0;
    switch (op) {
      case 0x000:
        this.halted = true;
        break;
      case 0x001:
        this.d = 2;
        break;
      case 0x002:
        this.i = 1;
        break;
      case 0x003:
        this.i = 0;
        break;
      case 0x006:
        this.c = 0;
        break;
      case 0x007:
        this.c = 1;
        break;
    }
    return 4;
  }

  /** J, JSR and their interrupt-enabling/disabling forms: three words. */
  private jump(pc: number): number {
    const r = this.r;
    const first = this.bus.read(pc + 1);
    const second = this.bus.read(pc + 2);
    const target = (((first >> 2) & 0x3f) << 10) | (second & 0x3ff);
    const saveTo = (first >> 8) & 3;
    const interruptMode = first & 3;
    if (interruptMode) this.intr = this.i = interruptMode & 1;
    if (saveTo !== 3) r[4 + saveTo] = pc + 3;
    r[7] = target;
    return 13;
  }

  /** $008-$03F: INCR, DECR, COMR, NEGR, ADCR, GSWD, NOP, SIN, RSWD. */
  private singleRegister(op: number, pc: number): number {
    const r = this.r;
    const reg = op & 7;
    r[7] = pc + 1;
    const value = r[reg];
    switch (op >> 3) {
      case 1:
        r[reg] = this.setSz((value + 1) & 0xffff);
        break;
      case 2:
        r[reg] = this.setSz((value - 1) & 0xffff);
        break;
      case 3:
        r[reg] = this.setSz(value ^ 0xffff);
        break;
      case 4:
        r[reg] = this.subtract(value, 0);
        break;
      case 5:
        r[reg] = this.add(value, this.c);
        break;
      case 6:
        if (reg < 4) {
          const status = (this.s << 7) | (this.z << 6) | (this.o << 5) | (this.c << 4);
          r[reg] = status | (status << 8);
          this.intr = 0;
        }
        // NOP ($034, $035) and SIN ($036, $037) do nothing here.
        return 6;
      case 7:
        this.s = (value >> 7) & 1;
        this.z = (value >> 6) & 1;
        this.o = (value >> 5) & 1;
        this.c = (value >> 4) & 1;
        this.intr = 0;
        return 6;
    }
    return reg >= 6 ? 7 : 6;
  }

  /** $040-$07F: SWAP, SLL, RLC, SLLC, SLR, SAR, RRC, SARC by one or two (R0-R3 only). */
  private shift(op: number, pc: number): number {
    const r = this.r;
    const reg = op & 3;
    const two = (op >> 2) & 1;
    const value = r[reg];
    let result: number;
    r[7] = pc + 1;
    this.intr = 0;
    switch ((op >> 3) & 7) {
      case 0: // SWAP
        if (two) {
          result = (value & 0xff) * 0x101;
          this.s = (value >> 7) & 1;
        } else {
          result = ((value >> 8) | (value << 8)) & 0xffff;
          this.s = (value >> 15) & 1;
        }
        break;
      case 1: // SLL
        result = (value << (1 + two)) & 0xffff;
        this.s = (result >> 15) & 1;
        break;
      case 2: // RLC
        if (two) {
          result = ((value << 2) | (this.c << 1) | this.o) & 0xffff;
          this.o = (value >> 14) & 1;
        } else {
          result = ((value << 1) | this.c) & 0xffff;
        }
        this.c = value >> 15;
        this.s = (result >> 15) & 1;
        break;
      case 3: // SLLC
        result = (value << (1 + two)) & 0xffff;
        if (two) this.o = (value >> 14) & 1;
        this.c = value >> 15;
        this.s = (result >> 15) & 1;
        break;
      case 4: // SLR
        result = value >> (1 + two);
        this.s = (result >> 7) & 1;
        break;
      case 5: // SAR
        result = ((value << 16) >> (17 + two)) & 0xffff;
        this.s = (result >> 7) & 1;
        break;
      case 6: // RRC
        if (two) {
          result = (value >> 2) | (this.c << 14) | (this.o << 15);
          this.o = (value >> 1) & 1;
        } else {
          result = (value >> 1) | (this.c << 15);
        }
        this.c = value & 1;
        this.s = (result >> 7) & 1;
        break;
      default: // SARC
        result = ((value << 16) >> (17 + two)) & 0xffff;
        if (two) this.o = (value >> 1) & 1;
        this.c = value & 1;
        this.s = (result >> 7) & 1;
        break;
    }
    this.z = result === 0 ? 1 : 0;
    r[reg] = result;
    return two ? 8 : 6;
  }

  /** $080-$1FF: MOVR, ADDR, SUBR, CMPR, ANDR, XORR (R7 as the source reads as the next PC). */
  private registerOp(op: number, pc: number): number {
    const r = this.r;
    const kind = op >> 6;
    const src = (op >> 3) & 7;
    const dst = op & 7;
    r[7] = pc + 1;
    const source = r[src];
    if (kind === 2) {
      r[dst] = this.setSz(source);
    } else {
      const result = this.alu(kind, source, r[dst]);
      if (result !== null) r[dst] = result;
    }
    if (dst === 7 && src !== 7) return 7;
    return dst >= 6 ? 7 : 6;
  }

  /** $200-$23F: conditional branches with a displacement word. */
  private branch(op: number, pc: number): number {
    const r = this.r;
    const displacement = this.bus.read(pc + 1);
    const target = ((op & 0x20 ? displacement ^ 0xffff : displacement) + pc + 2) & 0xffff;
    r[7] = pc + 2;
    let taken: boolean;
    if (op & 0x10) {
      // BEXT: the Intellivision's external branch lines are never driven.
      taken = (op & 0x0f) === 0;
    } else {
      const { s, z, o, c } = this;
      switch (op & 7) {
        case 0:
          taken = true;
          break;
        case 1:
          taken = c === 1;
          break;
        case 2:
          taken = o === 1;
          break;
        case 3:
          taken = s === 0;
          break;
        case 4:
          taken = z === 1;
          break;
        case 5:
          taken = (s ^ o) === 1;
          break;
        case 6:
          taken = (z | (s ^ o)) === 1;
          break;
        default:
          taken = (c ^ s) === 1;
          break;
      }
      if (op & 8) taken = !taken;
    }
    if (!taken) return 7;
    r[7] = target;
    return 9;
  }

  /** $240-$3FF: MVO, MVI, ADD, SUB, CMP, AND, XOR with direct, indirect or immediate operands. */
  private memoryOp(op: number, pc: number): number {
    const r = this.r;
    const bus = this.bus;
    const kind = (op >> 6) & 7;
    const mode = (op >> 3) & 7;
    const reg = op & 7;
    const doubleByte = this.d !== 0;

    if (mode === 0) {
      const address = bus.read(pc + 1);
      r[7] = pc + 2;
      if (kind === 1) {
        bus.write(address, r[reg]);
        this.intr = 0;
        return 11;
      }
      this.operate(kind, bus.read(address), reg);
      return reg >= 6 ? 11 : 10;
    }

    if (mode === 7) {
      if (kind === 1) {
        r[7] = pc + 2 + (doubleByte ? 1 : 0);
        bus.write(pc + 1, r[reg]);
        this.intr = 0;
        return 9;
      }
      let operand: number;
      if (doubleByte) {
        operand = (bus.read(pc + 1) & 0xff) | ((bus.read(pc + 2) & 0xff) << 8);
        r[7] = pc + 3;
      } else {
        operand = bus.read(pc + 1);
        r[7] = pc + 2;
      }
      this.operate(kind, operand, reg);
      return (doubleByte ? 10 : 8) + (reg >= 6 ? 1 : 0);
    }

    if (kind === 1) {
      // MVO@: R4 and R5 step on after the write, and R6 pushes.
      const data = r[reg];
      const address = r[mode];
      r[7] = pc + 1;
      bus.write(address, data);
      if (mode >= 4) r[mode] = address + 1;
      this.intr = 0;
      return 9;
    }

    if (mode === 6) {
      // Reads through R6 pop: it steps back before the read.
      const address = (r[6] - 1) & 0xffff;
      r[7] = pc + 1;
      const operand = bus.read(address);
      r[6] = address;
      this.operate(kind, operand, reg);
      return 12;
    }

    const address = r[mode];
    r[7] = pc + 1;
    let operand = bus.read(address);
    let next = address + 1;
    if (doubleByte) {
      // R1-R3 don't step, so both bytes come from the same address.
      const high = bus.read(mode >= 4 ? next : address);
      operand = (operand & 0xff) | ((high & 0xff) << 8);
      next++;
    }
    if (mode >= 4) r[mode] = next;
    this.operate(kind, operand, reg);
    return doubleByte ? 10 : 8;
  }

  private operate(kind: number, operand: number, reg: number): void {
    if (kind === 2) {
      this.r[reg] = operand;
      return;
    }
    const result = this.alu(kind, operand, this.r[reg]);
    if (result !== null) this.r[reg] = result;
  }
}
