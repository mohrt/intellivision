import { IntellivisionBus } from './bus';
import type { Cartridge } from './cart/cartridge';
import { Cp1610 } from './cpu/cp1610';
import { Controllers } from './io/controllers';
import type { MachineRoms } from './roms/system-roms';
import { Ay8914 } from './sound/ay8914';
import { AudioMixer } from './sound/mixer';
import { captureState, restoreState, type StateNode } from './state/snapshot';
import { Stic } from './stic/stic';

export type TvStandard = 'ntsc' | 'pal';

interface Timing {
  /** The CPU clock: the colour burst crystal / 4 (NTSC), or 4 MHz / 4 (PAL). */
  clockHz: number;
  frameCycles: number;
  lineCycles: number;
}

export const TIMING: Record<TvStandard, Timing> = {
  ntsc: { clockHz: 3_579_545 / 4, frameCycles: 14_934, lineCycles: 57 },
  pal: { clockHz: 1_000_000, frameCycles: 19_968, lineCycles: 64 },
};

/** How long the STIC holds each bus request: the first, the 13 normal ones, and the extra one with no vertical delay. */
const FIRST_FETCH_HOLD = 68;
const FETCH_HOLD = 108;
const EXTRA_FETCH_HOLD = 38;
/** From the first fetch to the second, before the vertical and horizontal delays. */
const FIRST_FETCH_GAP = 120;

/** The STIC's frame, phase by phase (after jzIntv's measured timings). */
const enum Phase {
  /** Start of vertical blank: the interrupt, and the STIC's registers open to the CPU. */
  FrameStart,
  /** The register window closes; the display is on for this frame if the CPU wrote $20. */
  RegistersClose,
  /** GRAM closes, and the STIC starts fetching the background, one card row per bus request. */
  FirstFetch,
  Fetch,
  LastFetch,
  ExtraFetch,
}

/**
 * The whole console: CP1610, STIC, AY-3-8914, the RAMs, two hand controllers,
 * the EXEC and GROM, and the cartridge. Time is counted in CPU cycles; the
 * STIC's frame is a series of timed phases between which the CPU runs.
 */
export class Intellivision {
  readonly stic = new Stic();
  readonly psg = new Ay8914();
  readonly controllers = new Controllers();
  readonly bus = new IntellivisionBus(this.stic, this.psg, this.controllers);
  readonly cpu = new Cp1610(this.bus);
  readonly audio = new AudioMixer(this.psg);
  tv: TvStandard = 'ntsc';
  /** CPU cycles since power on. */
  now = 0;
  frameStart = 0;
  frames = 0;
  phase = Phase.FrameStart;
  nextPhaseAt = 0;
  /** Card rows fetched so far this frame. */
  fetchedRows = 0;
  fetchesLeft = 0;
  interruptPending = false;
  interruptUntil = 0;
  busRequestPending = false;
  busRequestUntil = 0;
  /** Where the sound chip has been run up to. */
  audioAt = 0;
  private hasRoms = false;
  /** Called with each finished picture, at the start of vertical blank. */
  onFrame: (framebuffer: Uint8Array) => void = () => {};

  constructor() {
    this.bus.beforeSound = () => this.catchUpAudio(this.bus.now);
    this.reset();
  }

  get timing(): Timing {
    return TIMING[this.tv];
  }

  get clockHz(): number {
    return this.timing.clockHz;
  }

  get romsLoaded(): boolean {
    return this.hasRoms;
  }

  get cartridge(): Cartridge | null {
    return this.bus.cartridge;
  }

  /** The EXEC and GROM, or null to take them out. */
  setRoms(roms: MachineRoms | null): void {
    this.bus.exec = roms?.exec ?? null;
    this.bus.execAux = roms?.execAux ?? null;
    this.stic.grom = roms?.grom ?? new Uint8Array(0x800);
    this.hasRoms = roms !== null;
    this.reset();
  }

  /** Changing cartridges means switching off first. */
  insertCartridge(cartridge: Cartridge | null): void {
    this.bus.cartridge = cartridge;
    this.reset();
  }

  setTv(tv: TvStandard): void {
    this.tv = tv;
    this.restartTiming();
  }

  /** Power on: everything back to its initial state (RAM cleared). */
  reset(): void {
    this.bus.scratchRam.fill(0);
    this.bus.systemRam.fill(0);
    this.stic.gram.fill(0);
    this.bus.cartridge?.reset();
    this.pressReset();
  }

  /** The console's reset button: restarts the chips, keeping memory. */
  pressReset(): void {
    this.cpu.reset();
    this.stic.reset();
    this.psg.reset();
    this.restartTiming();
  }

  private restartTiming(): void {
    this.now = this.frameStart = this.audioAt = 0;
    this.phase = Phase.FrameStart;
    this.nextPhaseAt = 0;
    this.interruptPending = this.busRequestPending = false;
  }

  /** Runs the console for `cycles` CPU cycles. */
  run(cycles: number): void {
    const target = this.now + cycles;
    while (this.now < target) {
      this.runCpu(Math.min(target, this.nextPhaseAt));
      if (this.now >= this.nextPhaseAt) this.enterPhase();
    }
    this.catchUpAudio(this.now);
  }

  /** Runs until the next picture is finished. */
  runFrame(): void {
    const frames = this.frames;
    while (this.frames === frames) this.run(Math.max(1, this.nextPhaseAt - this.now));
  }

  private catchUpAudio(until: number): void {
    if (until > this.audioAt) {
      this.audio.run(until - this.audioAt);
      this.audioAt = until;
    }
  }

  private requestBus(at: number, hold: number): void {
    this.busRequestPending = true;
    this.busRequestUntil = at + hold;
  }

  private enterPhase(): void {
    const stic = this.stic;
    const at = this.nextPhaseAt;
    const { frameCycles, lineCycles } = this.timing;
    const fetchTime = FIRST_FETCH_GAP + 12 * lineCycles * 16 + lineCycles + 17;
    const graphicsWindow = frameCycles - fetchTime;
    const registerWindow = graphicsWindow - 896;
    const vDelay = stic.registers[0x31] & 7;
    const delay = 2 * lineCycles * vDelay + (stic.registers[0x30] & 7);

    switch (this.phase) {
      case Phase.FrameStart:
        if (stic.displayEnabled) stic.render();
        else stic.blank();
        this.frames++;
        this.onFrame(stic.framebuffer);
        this.frameStart = at;
        this.interruptPending = true;
        this.interruptUntil = at + registerWindow + 7;
        // After a displayed frame, the STIC only lets the CPU in once it has taken the interrupt.
        if (stic.displayEnabled) stic.accessFrom = Infinity;
        stic.enableRequested = false;
        stic.registersUntil = at + registerWindow;
        stic.graphicsUntil = at + graphicsWindow;
        this.fetchedRows = 0;
        this.phase = Phase.RegistersClose;
        this.nextPhaseAt = at + registerWindow;
        break;
      case Phase.RegistersClose:
        stic.displayEnabled = stic.enableRequested;
        if (!stic.displayEnabled) {
          stic.registersUntil = stic.graphicsUntil = Infinity;
          this.phase = Phase.FrameStart;
          this.nextPhaseAt = this.frameStart + frameCycles;
        } else {
          this.phase = Phase.FirstFetch;
          this.nextPhaseAt = this.frameStart + graphicsWindow;
        }
        break;
      case Phase.FirstFetch:
        this.requestBus(at, FIRST_FETCH_HOLD);
        this.phase = Phase.Fetch;
        this.fetchesLeft = 11;
        this.nextPhaseAt = at + FIRST_FETCH_GAP + delay;
        break;
      case Phase.Fetch:
        this.requestBus(at, FETCH_HOLD);
        if (--this.fetchesLeft === 0) this.phase = Phase.LastFetch;
        this.nextPhaseAt = at + 16 * lineCycles;
        break;
      case Phase.LastFetch:
        this.requestBus(at, FETCH_HOLD);
        this.phase = Phase.ExtraFetch;
        this.nextPhaseAt = at + 16 * lineCycles - delay;
        break;
      case Phase.ExtraFetch:
        if (vDelay === 0) this.requestBus(at, EXTRA_FETCH_HOLD);
        this.phase = Phase.FrameStart;
        this.nextPhaseAt = this.frameStart + frameCycles;
        break;
    }
  }

  /** Runs instructions until `until`, taking the interrupt and the STIC's bus requests between them. */
  private runCpu(until: number): void {
    const { cpu, bus, stic } = this;
    while (this.now < until) {
      if (this.interruptPending && cpu.acceptsInterrupt) {
        this.interruptPending = false;
        if (this.now <= this.interruptUntil) {
          bus.now = this.now;
          this.now += cpu.interrupt();
          stic.accessFrom = this.now;
          continue;
        }
      } else if (this.busRequestPending && cpu.acceptsBusRequest) {
        this.busRequestPending = false;
        if (this.now <= this.busRequestUntil) {
          // The CPU stops while the STIC copies a row of cards; a request it answers too late is lost.
          stic.fetchRow(this.fetchedRows++, bus.systemRam);
          this.now = this.busRequestUntil;
          continue;
        }
      }
      bus.now = this.now;
      this.now += cpu.step();
    }
  }

  /** Everything in the console except the ROMs (cartridge RAM included). */
  saveState(): StateNode {
    return captureState(this);
  }

  /** Restores a saved state; the same cartridge must already be in. */
  loadState(state: StateNode): void {
    restoreState(this, state);
  }
}
