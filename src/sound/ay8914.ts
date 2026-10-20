/** Output level for each 4-bit amplitude: each step is 1/sqrt(2) (3 dB) of the next. */
export const AY_VOLUMES: readonly number[] = Array.from({ length: 16 }, (_, level) =>
  level === 0 ? 0 : Math.SQRT1_2 ** (15 - level),
);

/** Bits of each register that exist. */
const REGISTER_MASKS = [0xff, 0xff, 0xff, 0xff, 0x0f, 0x0f, 0x0f, 0xff, 0xff, 0x1f, 0x0f, 0x3f, 0x3f, 0x3f];
export const PSG_REGISTERS = REGISTER_MASKS.length;
const ENVELOPE_SHAPE = 10;
/** Volume register bits 5-4: 00 is a fixed volume, then the envelope at a quarter, half or full. */
const ENVELOPE_SHIFT = [0, 2, 1, 0];

/**
 * The General Instrument AY-3-8914: the AY-3-8910's three tone channels, noise
 * and envelope generators with the registers in a different order, an 8-bit
 * coarse envelope period and two extra envelope scales. `tick` advances it by
 * one step of its counters, every 4 CPU cycles; a tone with period P is a
 * square wave with a period of 2P steps.
 */
export class Ay8914 {
  readonly registers = new Uint8Array(PSG_REGISTERS);
  readonly toneCounters = new Int32Array(3);
  readonly toneOutputs = new Uint8Array(3);
  noiseCounter = 0;
  /** 17-bit shift register; bit 0 is the noise output. */
  noiseShifter = 1;
  envelopeCounter = 0;
  /** 0-31 through the envelope's two halves, or -1 once it has stopped. */
  envelopeStep = 0;
  envelopeLevel = 0;

  reset(): void {
    this.registers.fill(0);
    this.toneCounters.fill(0);
    this.toneOutputs.fill(0);
    this.noiseCounter = 0;
    this.noiseShifter = 1;
    this.envelopeCounter = 0;
    this.envelopeStep = 0;
    this.envelopeLevel = 0;
  }

  read(register: number): number {
    return register < PSG_REGISTERS ? this.registers[register] : 0xff;
  }

  write(register: number, value: number): void {
    if (register >= PSG_REGISTERS) return;
    this.registers[register] = value & REGISTER_MASKS[register];
    if (register === ENVELOPE_SHAPE) {
      this.envelopeStep = 0;
      this.envelopeCounter = 0;
      this.envelopeLevel = this.attack ? 0 : 15;
    }
  }

  private get attack(): boolean {
    return (this.registers[ENVELOPE_SHAPE] & 0x04) !== 0;
  }

  /** A tone period of 0 counts as 4096. */
  private tonePeriod(channel: number): number {
    return this.registers[channel] | (this.registers[channel + 4] << 8) || 0x1000;
  }

  /** The envelope steps every 2 x period counter steps; a period of 0 counts as 65536. */
  private envelopePeriod(): number {
    return (this.registers[3] | (this.registers[7] << 8) || 0x10000) * 2;
  }

  /** The noise shifts every 2 x period steps; a period of 0 counts as 32. */
  private noisePeriod(): number {
    return (this.registers[9] || 32) * 2;
  }

  /** Advances one counter step and returns the mixed level, 0 to 3. */
  tick(): number {
    const { toneCounters, toneOutputs, registers } = this;
    for (let channel = 0; channel < 3; channel++) {
      if (++toneCounters[channel] >= this.tonePeriod(channel)) {
        toneCounters[channel] = 0;
        toneOutputs[channel] ^= 1;
      }
    }
    if (++this.noiseCounter >= this.noisePeriod()) {
      this.noiseCounter = 0;
      const s = this.noiseShifter;
      this.noiseShifter = (s >> 1) ^ (s & 1 ? 0x10004 : 0);
    }
    if (++this.envelopeCounter >= this.envelopePeriod()) {
      this.envelopeCounter = 0;
      this.stepEnvelope();
    }

    const enables = registers[8];
    const noise = this.noiseShifter & 1;
    let level = 0;
    for (let channel = 0; channel < 3; channel++) {
      const tone = toneOutputs[channel] | ((enables >> channel) & 1);
      const noiseOn = noise | ((enables >> (channel + 3)) & 1);
      if (!(tone & noiseOn)) continue;
      const volume = registers[11 + channel];
      const mode = volume >> 4;
      level += mode ? AY_VOLUMES[this.envelopeLevel] / (1 << ENVELOPE_SHIFT[mode]) : AY_VOLUMES[volume & 0x0f];
    }
    return level;
  }

  private stepEnvelope(): void {
    if (this.envelopeStep < 0) return;
    const shape = this.registers[ENVELOPE_SHAPE];
    const hold = shape & 0x01;
    const alternate = (shape >> 1) & 1;
    const attack = (shape >> 2) & 1;
    const repeat = (shape >> 3) & 1;
    const step = (this.envelopeStep + 1) & 31;
    if (step < 16) {
      this.envelopeLevel = attack ? step : 15 - step;
      this.envelopeStep = step;
    } else if (step === 16 && (!repeat || hold)) {
      this.envelopeLevel = repeat && attack !== alternate ? 15 : 0;
      this.envelopeStep = -1;
    } else if (step === 16 && !alternate) {
      this.envelopeLevel = attack ? 0 : 15;
      this.envelopeStep = 0;
    } else {
      this.envelopeLevel = attack ? 31 - step : step - 16;
      this.envelopeStep = step;
    }
  }
}
