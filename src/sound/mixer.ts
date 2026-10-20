import type { Ay8914 } from './ay8914';

/** The PSG's counters step once every 4 CPU cycles. */
export const CPU_CYCLES_PER_TICK = 4;
const GAIN = 0.6 / 3;
/** A gentle high-pass that takes away the chip's DC offset. */
const DC_BLOCK = 0.995;

/**
 * Runs the sound chip in step with the CPU and resamples its output to the
 * audio device's rate, averaging the chip steps that fall in each sample.
 */
export class AudioMixer {
  private cyclePhase = 0;
  private ticksPerSample = 1;
  private position = 0;
  private sum = 0;
  private count = 0;
  private lastIn = 0;
  private lastOut = 0;
  private buffer = new Float32Array(4096);
  private length = 0;

  constructor(private readonly psg: Ay8914) {}

  setRates(cpuHz: number, sampleRate: number): void {
    this.ticksPerSample = cpuHz / CPU_CYCLES_PER_TICK / sampleRate;
  }

  /** Advances the chip by `cycles` CPU cycles. */
  run(cycles: number): void {
    this.cyclePhase += cycles;
    while (this.cyclePhase >= CPU_CYCLES_PER_TICK) {
      this.cyclePhase -= CPU_CYCLES_PER_TICK;
      this.sum += this.psg.tick() * GAIN;
      this.count++;
      this.position++;
      if (this.position >= this.ticksPerSample) {
        this.position -= this.ticksPerSample;
        this.emit(this.sum / this.count);
        this.sum = this.count = 0;
      }
    }
  }

  private emit(value: number): void {
    const out = value - this.lastIn + DC_BLOCK * this.lastOut;
    this.lastIn = value;
    this.lastOut = out;
    if (this.length === this.buffer.length) {
      const bigger = new Float32Array(this.buffer.length * 2);
      bigger.set(this.buffer);
      this.buffer = bigger;
    }
    this.buffer[this.length++] = out;
  }

  /** The samples made since the last call. */
  takeSamples(): Float32Array {
    const samples = this.buffer.slice(0, this.length);
    this.length = 0;
    return samples;
  }
}
