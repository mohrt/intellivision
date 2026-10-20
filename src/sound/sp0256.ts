/** The SP0256-012's internal ROM: 2K bytes, at byte address $1000 of its own address space. */
export const SPEECH_ROM_SIZE = 0x800;
const ROM_BASE = 0x1000;
/** The SPB-640's FIFO appears at this bit address; jumping there runs speech data the CPU feeds in. */
const FIFO_ADDRESS = 0x1800 << 3;
const FIFO_SIZE = 64;
/** One sample every 358 colour-burst clocks (about 10 kHz): 179 half CPU cycles. */
const HALF_CYCLES_PER_SAMPLE = 179;
/** The counter period for noise and for pauses. */
const NOISE_PERIOD = 64;
const PAUSE_PERIOD = 64;
/** Stops a runaway program (in a bad ROM) from looping for ever without producing a sample. */
const MAX_INSTRUCTIONS = 4096;

/** The filter's coefficient quantization table, from the SP0250 data sheet. */
const COEFFICIENTS = [
  0, 9, 17, 25, 33, 41, 49, 57, 65, 73, 81, 89, 97, 105, 113, 121, 129, 137, 145, 153, 161, 169, 177, 185, 193, 201,
  209, 217, 225, 233, 241, 249, 257, 265, 273, 281, 289, 297, 301, 305, 309, 313, 317, 321, 325, 329, 333, 337, 341, 345,
  349, 353, 357, 361, 365, 369, 373, 377, 381, 385, 389, 393, 397, 401, 405, 409, 413, 417, 421, 425, 427, 429, 431, 433,
  435, 437, 439, 441, 443, 445, 447, 449, 451, 453, 455, 457, 459, 461, 463, 465, 467, 469, 471, 473, 475, 477, 479, 481,
  482, 483, 484, 485, 486, 487, 488, 489, 490, 491, 492, 493, 494, 495, 496, 497, 498, 499, 500, 501, 502, 503, 504, 505,
  506, 507, 508, 509, 510, 511,
];

/** The filter registers: amplitude, period, six B/F coefficient pairs, and the two interpolation steps. */
const AM = 0;
const PR = 1;
const B0 = 2;
const F0 = 3;
const B1 = 4;
const F1 = 5;
const B2 = 6;
const F2 = 7;
const B3 = 8;
const F3 = 9;
const B4 = 10;
const F4 = 11;
const B5 = 12;
const F5 = 13;
const IA = 14;
const IP = 15;

/** How one field of a data block is read: its width in bits, its shift, the register, and how it's applied. */
interface Field {
  bits: number;
  shift: number;
  register: number;
  /** Added to the register, sign-extended, rather than replacing it. */
  delta?: boolean;
  /** Replaces only the bits above `shift`. */
  merge?: boolean;
  /** Clears B0-F2 first. */
  clearLow?: boolean;
}

const f = (bits: number, shift: number, register: number, extra: Omit<Field, 'bits' | 'shift' | 'register'> = {}): Field => ({
  bits,
  shift,
  register,
  ...extra,
});
const NOTHING = f(0, 0, 0);

/**
 * The data blocks that follow each opcode, by opcode (as read: 4 bits, least
 * significant first) and mode. Each opcode has four forms for the mode
 * register's bits 2 and 1; `null` opcodes have no data.
 */
const LOAD_ALL = [AM, PR, B0, F0, B1, F1, B2, F2, B3, F3, B4, F4, B5, F5].map((register) => f(8, 0, register));
const LOAD_ALL_INTERP = [...LOAD_ALL, f(8, 0, IA), f(8, 0, IP)];

const load4 = (wide: boolean, poles12: boolean) => [
  f(6, 2, AM, { clearLow: true }),
  f(8, 0, PR),
  wide ? f(6, 1, B3) : f(4, 3, B3),
  wide ? f(7, 1, F3) : f(6, 2, F3),
  wide ? f(8, 0, B4) : f(7, 1, B4),
  wide ? f(8, 0, F4) : f(6, 2, F4),
  ...(poles12 ? [f(8, 0, B5), f(8, 0, F5)] : []),
];

const setMsb6 = (wide: boolean, poles12: boolean) => [
  ...(poles12 ? [] : [NOTHING]),
  f(6, 2, AM),
  wide ? f(7, 1, F3, { merge: true }) : f(6, 2, F3, { merge: true }),
  wide ? f(8, 0, F4, { merge: true }) : f(6, 2, F4, { merge: true }),
  ...(poles12 ? [f(8, 0, F5, { merge: true })] : []),
];

const delta9 = (wide: boolean, poles12: boolean) => [
  f(4, 2, AM, { delta: true }),
  f(5, 0, PR, { delta: true }),
  ...(wide
    ? [
        f(4, 1, B0, { delta: true }),
        f(4, 2, F0, { delta: true }),
        f(4, 1, B1, { delta: true }),
        f(4, 2, F1, { delta: true }),
        f(4, 1, B2, { delta: true }),
        f(4, 2, F2, { delta: true }),
        f(4, 1, B3, { delta: true }),
        f(5, 1, F3, { delta: true }),
        f(5, 0, B4, { delta: true }),
        f(5, 0, F4, { delta: true }),
      ]
    : [
        f(3, 4, B0, { delta: true }),
        f(3, 3, F0, { delta: true }),
        f(3, 4, B1, { delta: true }),
        f(3, 3, F1, { delta: true }),
        f(3, 4, B2, { delta: true }),
        f(3, 3, F2, { delta: true }),
        f(3, 3, B3, { delta: true }),
        f(4, 2, F3, { delta: true }),
        f(4, 1, B4, { delta: true }),
        f(4, 2, F4, { delta: true }),
      ]),
  ...(poles12 ? [f(5, 0, B5, { delta: true }), f(5, 0, F5, { delta: true })] : []),
];

const setMsbA = (wide: boolean, poles12: boolean) => [
  ...(poles12 ? [] : [NOTHING]),
  f(6, 2, AM),
  ...[F0, F1, F2].map((register) => (wide ? f(6, 2, register, { merge: true }) : f(5, 3, register, { merge: true }))),
];

const loadC = (wide: boolean, poles12: boolean, interp: boolean) => [
  f(6, 2, AM),
  f(8, 0, PR),
  ...(wide
    ? [f(6, 1, B0), f(6, 2, F0), f(6, 1, B1), f(6, 2, F1), f(6, 1, B2), f(6, 2, F2), f(6, 1, B3), f(7, 1, F3), f(8, 0, B4), f(8, 0, F4)]
    : [f(3, 4, B0), f(5, 3, F0), f(3, 4, B1), f(5, 3, F1), f(3, 4, B2), f(5, 3, F2), f(4, 3, B3), f(6, 2, F3), f(7, 1, B4), f(6, 2, F4)]),
  ...(poles12 ? [f(8, 0, B5), f(8, 0, F5)] : []),
  ...(interp ? [f(5, 0, IA), f(5, 0, IP)] : []),
];

const deltaD = (wide: boolean, poles12: boolean) => [
  f(4, 2, AM, { delta: true, clearLow: !wide }),
  f(5, 0, PR, { delta: true }),
  ...(wide
    ? [f(4, 1, B3, { delta: true }), f(5, 1, F3, { delta: true }), f(5, 0, B4, { delta: true }), f(5, 0, F4, { delta: true })]
    : [f(3, 3, B3, { delta: true }), f(4, 2, F3, { delta: true }), f(4, 1, B4, { delta: true }), f(4, 2, F4, { delta: true })]),
  ...(poles12 ? [f(5, 0, B5, { delta: true }), f(5, 0, F5, { delta: true })] : []),
];

const setMsb35 = (wide: boolean, poles12: boolean, interp: boolean) => [
  ...(poles12 ? [] : [NOTHING]),
  f(6, 2, AM),
  f(8, 0, PR),
  ...[F0, F1, F2].map((register) => (wide ? f(6, 2, register, { merge: true }) : f(5, 3, register, { merge: true }))),
  ...(interp ? [f(5, 0, IA), f(5, 0, IP)] : []),
];

/** By mode bits 2-1: 00 and 01 are narrow coefficients, 10 and 11 wide; 01 and 11 have twelve poles. */
const forModes = (make: (wide: boolean, poles12: boolean) => Field[]): Field[][] => [
  make(false, false),
  make(false, true),
  make(true, false),
  make(true, true),
];

const DATA_FORMATS: (Field[][] | null)[] = [
  /* 0 RTS / SETPAGE */ null,
  /* 1 SETMODE */ null,
  /* 2 LOAD_4 */ forModes(load4),
  /* 3 LOAD_C */ forModes((wide, poles12) => loadC(wide, poles12, false)),
  /* 4 LOAD_2 */ forModes((wide, poles12) => loadC(wide, poles12, true)),
  /* 5 SETMSB_A */ forModes(setMsbA),
  /* 6 SETMSB_6 */ forModes(setMsb6),
  /* 7 LOAD_E */ forModes(() => [f(6, 2, AM), f(8, 0, PR)]),
  /* 8 LOADALL */ [LOAD_ALL, LOAD_ALL_INTERP, LOAD_ALL, LOAD_ALL_INTERP],
  /* 9 DELTA_9 */ forModes(delta9),
  /* 10 SETMSB_5 */ forModes((wide, poles12) => setMsb35(wide, poles12, false)),
  /* 11 DELTA_D */ forModes(deltaD),
  /* 12 SETMSB_3 */ forModes((wide, poles12) => setMsb35(wide, poles12, true)),
  /* 13 JSR */ null,
  /* 14 JMP */ null,
  /* 15 PAUSE */ [[NOTHING], [NOTHING], [NOTHING], [NOTHING]],
];
const OP_RTS = 0;
const OP_SETMODE = 1;
/** The opcodes after which the interpolation registers keep their values (as jzIntv and MAME have it). */
const KEEPS_INTERPOLATION = new Set([1, 2, 3]);
const OP_JSR = 13;
const OP_JMP = 14;
const OP_PAUSE = 15;

function reverseBits(value: number, width: number): number {
  let out = 0;
  for (let bit = 0; bit < width; bit++) if (value & (1 << bit)) out |= 1 << (width - 1 - bit);
  return out;
}

const int16 = (value: number) => (value << 16) >> 16;

/** A coefficient register as the filter uses it: sign and magnitude, through the quantization table. */
function coefficient(register: number): number {
  return register & 0x80 ? COEFFICIENTS[-register & 0x7f] : -COEFFICIENTS[register];
}

/** Amplitude: 3 bits of exponent and 5 of mantissa. */
const amplitude = (register: number) => (register & 0x1f) << ((register & 0xe0) >> 5);

/**
 * The Intellivoice: General Instrument's SP0256-012 speech processor, with the
 * SPB-640 that gives it a 64-decle FIFO, mapped at $0080-$0081.
 *
 * The SP0256 runs a little program of its own, from its internal ROM or from
 * the FIFO: each instruction loads, adjusts or keeps the 12-pole lattice
 * filter's registers for a number of pitch periods, and the filter, driven by
 * pulses or noise, makes the speech at about 10 kHz. The CPU starts a phrase
 * by writing its number to $0080 when LRQ (bit 15 of $0080) says the chip can
 * take one, and feeds speech data through $0081. Behaviour follows jzIntv's
 * Intellivoice, which was matched against the real module.
 */
export class Sp0256 {
  /** The internal ROM, or null with no Intellivoice plugged in. */
  speechRom: Uint8Array | null = null;
  readonly fifo = new Uint16Array(FIFO_SIZE);
  fifoHead = 0;
  fifoTail = 0;
  /** Bits already read from the decle at the FIFO's tail. */
  fifoBit = 0;
  /** True while the chip can accept a phrase address. */
  loadRequest = true;
  /** The phrase address waiting to start, as a bit address. */
  pendingAddress = 0;
  /** The micro-sequencer's program counter, as a bit address. */
  pc = 0;
  /** The one-level return address. */
  stack = 0;
  /** The page (top bits of jump targets) set by SETPAGE. */
  page = ROM_BASE << 3;
  mode = 0;
  halted = true;
  fromFifo = false;
  silent = true;
  readonly registers = new Uint8Array(16);
  readonly b = new Int16Array(6);
  readonly f = new Int16Array(6);
  /** Each filter stage's two delayed outputs. */
  readonly delay = new Int16Array(12);
  repeat = 0;
  counter = 0;
  period = 0;
  amplitude = 0;
  interpolate = false;
  random = 1;
  /** Half CPU cycles towards the next sample. */
  phase = 0;
  /** The latest sample, -1 to 1. */
  output = 0;

  get present(): boolean {
    return this.speechRom !== null;
  }

  reset(): void {
    this.fifo.fill(0);
    this.fifoHead = this.fifoTail = this.fifoBit = 0;
    this.registers.fill(0);
    this.b.fill(0);
    this.f.fill(0);
    this.delay.fill(0);
    this.repeat = -1;
    this.counter = 0;
    this.period = 0;
    this.amplitude = 0;
    this.interpolate = false;
    this.random = 1;
    this.loadRequest = true;
    this.pendingAddress = 0;
    this.pc = 0;
    this.stack = 0;
    this.page = ROM_BASE << 3;
    this.mode = 0;
    this.halted = true;
    this.fromFifo = false;
    this.silent = true;
    this.output = 0;
  }

  /** $0080: LRQ in bit 15. $0081: "FIFO full" in bit 15. */
  read(address: number): number {
    if (address === 0) return this.loadRequest ? 0x8000 : 0;
    return this.fifoHead - this.fifoTail >= FIFO_SIZE ? 0x8000 : 0;
  }

  /** $0080: start a phrase (ignored while busy). $0081: a decle into the FIFO, or with bit 10 set, a reset. */
  write(address: number, value: number): void {
    if (address === 0) {
      if (!this.loadRequest) return;
      this.loadRequest = false;
      this.pendingAddress = (value & 0xff) << 4;
      return;
    }
    if (value & 0x400) {
      this.reset();
      return;
    }
    if (this.fifoHead - this.fifoTail >= FIFO_SIZE) return;
    this.fifo[this.fifoHead++ & (FIFO_SIZE - 1)] = value & 0x3ff;
  }

  /** Runs for `cycles` CPU cycles, updating `output`. */
  run(cycles: number): void {
    this.phase += cycles * 2;
    while (this.phase >= HALF_CYCLES_PER_SAMPLE) {
      this.phase -= HALF_CYCLES_PER_SAMPLE;
      this.output = this.nextSample() / 32768;
    }
  }

  private idle(): boolean {
    return this.repeat <= 0 && this.counter <= 0;
  }

  /** The next 10 kHz sample, as a 16-bit value. */
  nextSample(): number {
    for (let attempt = 0; attempt < 4; attempt++) {
      if (this.idle()) {
        this.sequence();
        if (this.silent && this.idle()) return 0;
      }
      const sample = this.filterSample();
      if (sample !== null) return sample;
    }
    return 0;
  }

  // --- The micro-sequencer ----------------------------------------------------------

  /** Reads `bits` bits (least significant first) from the FIFO or the ROM. */
  private take(bits: number): number {
    let data: number;
    if (this.fromFifo) {
      const first = this.fifo[this.fifoTail & (FIFO_SIZE - 1)];
      const second = this.fifo[(this.fifoTail + 1) & (FIFO_SIZE - 1)];
      data = ((second << 10) | first) >> this.fifoBit;
      this.fifoBit += bits;
      if (this.fifoBit >= 10) {
        this.fifoTail++;
        this.fifoBit -= 10;
      }
    } else {
      const byte = (bitAddress: number) => {
        const at = (bitAddress >> 3) - ROM_BASE;
        return this.speechRom && at >= 0 && at < this.speechRom.length ? this.speechRom[at] : 0;
      };
      data = ((byte(this.pc + 8) << 8) | byte(this.pc)) >> (this.pc & 7);
      this.pc += bits;
    }
    return data & ((1 << bits) - 1);
  }

  /** Runs instructions until one gives the filter something to do (or the chip halts). */
  private sequence(): void {
    for (let count = 0; this.idle(); count++) {
      if (this.halted && !this.loadRequest) {
        this.pc = this.pendingAddress | (ROM_BASE << 3);
        this.fromFifo = false;
        this.halted = false;
        this.loadRequest = true;
        this.pendingAddress = 0;
      }
      if (this.halted || count >= MAX_INSTRUCTIONS) {
        this.halted = true;
        this.repeat = 1;
        this.counter = 0;
        this.loadRequest = true;
        this.pendingAddress = 0;
        return;
      }

      const immediate = this.take(4);
      const opcode = this.take(4);
      let jumped = false;
      let repeat = 0;
      switch (opcode) {
        case OP_RTS:
          if (immediate) {
            this.page = reverseBits(immediate, 4) << 15;
          } else {
            jumped = true;
            this.pc = this.stack;
            this.halted = this.stack === 0;
            this.stack = 0;
          }
          break;
        case OP_JMP:
        case OP_JSR: {
          const target = this.page | (reverseBits(immediate, 4) << 11) | (reverseBits(this.take(8), 8) << 3);
          if (opcode === OP_JSR) this.stack = (this.pc + 7) & ~7;
          this.pc = target;
          jumped = true;
          break;
        }
        case OP_SETMODE:
          this.mode = ((immediate & 8) >> 2) | (immediate & 4) | ((immediate & 3) << 4);
          break;
        default:
          repeat = immediate | (this.mode & 0x30);
      }
      if (opcode !== OP_SETMODE) this.mode &= 0x0f;

      if (jumped) {
        this.fromFifo = this.pc === FIFO_ADDRESS;
        // Jumping to the FIFO drops a partly read decle.
        if (this.fromFifo && this.fifoBit) {
          if (this.fifoTail < this.fifoHead) this.fifoTail++;
          this.fifoBit = 0;
        }
        continue;
      }
      if (!repeat) continue;
      this.load(opcode, repeat);
      return;
    }
  }

  /** Reads an instruction's data block into the filter registers, then sets the filter going. */
  private load(opcode: number, repeat: number): void {
    const r = this.registers;
    this.repeat = repeat;
    this.delay.fill(0);
    const fields = DATA_FORMATS[opcode]?.[(this.mode >> 1) & 3] ?? [];
    if ((this.mode & 2) === 0) r[F5] = r[B5] = 0;
    for (const field of fields) {
      if (field.clearLow) r[B0] = r[F0] = r[B1] = r[F1] = r[B2] = r[F2] = 0;
      if (!field.bits) continue;
      let value = this.take(field.bits);
      if (field.delta && value & (1 << (field.bits - 1))) value -= 1 << field.bits;
      value = (value << field.shift) & 0xff;
      this.silent = false;
      if (field.merge) r[field.register] = (r[field.register] & ((1 << field.shift) - 1)) | value;
      else if (field.delta) r[field.register] += value;
      else r[field.register] = value;
    }
    if (!KEEPS_INTERPOLATION.has(opcode)) r[IA] = r[IP] = 0;
    if (opcode === OP_PAUSE) {
      this.silent = true;
      r[AM] = 0;
      r[PR] = PAUSE_PERIOD;
    }
    this.decode();
  }

  private decode(): void {
    const r = this.registers;
    this.amplitude = amplitude(r[AM]);
    this.counter = 0;
    this.period = r[PR];
    for (let stage = 0; stage < 6; stage++) {
      this.b[stage] = coefficient(r[B0 + stage * 2]);
      this.f[stage] = coefficient(r[F0 + stage * 2]);
    }
    this.interpolate = r[IA] !== 0 || r[IP] !== 0;
  }

  // --- The filter -------------------------------------------------------------------

  /** One sample from the filter, or null when its repeat count has run out. */
  private filterSample(): number | null {
    const bit = this.random & 1;
    this.random = (this.random >> 1) ^ (bit ? 0x4001 : 0);
    let sample = 0;
    let interpolateNow = false;
    if (--this.counter <= 0) {
      if (this.repeat-- <= 0) {
        this.counter = this.repeat = 0;
        return null;
      }
      this.counter = this.period || NOISE_PERIOD;
      sample = this.amplitude;
      interpolateNow = this.interpolate;
    }
    // A period of 0 means noise rather than pulses.
    if (!this.period) sample = bit ? -this.amplitude : this.amplitude;

    if (interpolateNow) {
      const r = this.registers;
      r[AM] += r[IA];
      r[PR] += r[IP];
      this.amplitude = amplitude(r[AM]);
      this.period = r[PR];
    }

    sample = int16(sample);
    const { b, f, delay } = this;
    for (let stage = 0; stage < 6; stage++) {
      sample = int16(sample + ((b[stage] * delay[stage * 2 + 1]) >> 9));
      sample = int16(sample + ((f[stage] * delay[stage * 2]) >> 8));
      delay[stage * 2 + 1] = delay[stage * 2];
      delay[stage * 2] = sample;
    }
    return Math.max(-128, Math.min(127, sample >> 4)) << 8;
  }
}
