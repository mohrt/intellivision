import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Intellivision } from '../src/intellivision';
import { Sp0256 } from '../src/sound/sp0256';
import { testRoms } from './helpers/test-roms';

const romPath = join(import.meta.dirname, '..', 'roms', 'ivoice.bin');

function chip(rom = new Uint8Array(0x800)): Sp0256 {
  const voice = new Sp0256();
  voice.speechRom = rom;
  voice.reset();
  return voice;
}

/** Runs `samples` 10 kHz samples and returns the loudest and how many were spent speaking. */
function listen(voice: Sp0256, samples: number) {
  let peak = 0;
  let speaking = 0;
  for (let i = 0; i < samples; i++) {
    peak = Math.max(peak, Math.abs(voice.nextSample()));
    if (!voice.halted) speaking++;
  }
  return { peak, speaking };
}

describe('Intellivoice', () => {
  it('takes a phrase address while LRQ is set, and ignores another until it has started', () => {
    const voice = chip();
    expect(voice.read(0)).toBe(0x8000);
    voice.write(0, 5);
    expect(voice.read(0)).toBe(0);
    voice.write(0, 9);
    expect(voice.pendingAddress).toBe(5 << 4);
    voice.nextSample();
    // Started (and, with an empty ROM, finished at once), so it can take the next one.
    expect(voice.pendingAddress).toBe(0);
    expect(voice.read(0)).toBe(0x8000);
  });

  it('queues up to 64 decles in its FIFO, says when it is full, and resets on bit 10', () => {
    const voice = chip();
    for (let i = 0; i < 70; i++) voice.write(1, i);
    expect(voice.fifoHead - voice.fifoTail).toBe(64);
    expect(voice.read(1)).toBe(0x8000);
    voice.write(0, 3);
    voice.write(1, 0x400);
    expect(voice.read(1)).toBe(0);
    expect(voice.read(0)).toBe(0x8000);
    expect(voice.halted).toBe(true);
  });

  it('makes no sound when idle, and halts on an RTS with nothing to return to', () => {
    const voice = chip();
    voice.write(0, 0);
    expect(listen(voice, 1000)).toEqual({ peak: 0, speaking: 0 });
  });

  it('runs a program from the FIFO, here a 12-bit pause then a voiced LOAD_E', () => {
    const voice = chip();
    // Instructions are read least significant bit first: immediate 4 bits, then the opcode.
    // LOAD_E (opcode 7) with repeat 15: amplitude (6 bits) and period (8 bits), then RTS.
    const bits = [15, 4, 7, 4, 0x3f, 6, 40, 8, 0, 4, 0, 4];
    let stream = 0n;
    let length = 0n;
    for (let i = 0; i < bits.length; i += 2) {
      stream |= BigInt(bits[i]) << length;
      length += BigInt(bits[i + 1]);
    }
    for (let i = 0; i < 4; i++) voice.write(1, Number((stream >> BigInt(i * 10)) & 0x3ffn));
    voice.halted = false;
    voice.pc = 0x1800 << 3;
    voice.fromFifo = true;
    const { peak, speaking } = listen(voice, 2000);
    expect(peak).toBeGreaterThan(0);
    expect(speaking).toBeGreaterThan(15 * 40 - 10);
    expect(voice.halted).toBe(true);
  });

  it('makes a sample every 358 colour-burst clocks: about 10 kHz', () => {
    let samples = 0;
    const voice = new (class extends Sp0256 {
      override nextSample(): number {
        samples++;
        return super.nextSample();
      }
    })();
    voice.speechRom = new Uint8Array(0x800);
    voice.reset();
    for (let cycle = 0; cycle < 894_886; cycle += 4) voice.run(4);
    expect(samples).toBeGreaterThanOrEqual(9998);
    expect(samples).toBeLessThanOrEqual(9999);
  });

  it.skipIf(!existsSync(romPath))('speaks the phrases in its ROM, of which 1-5 are pauses', () => {
    const rom = new Uint8Array(readFileSync(romPath));
    const pause = listen((() => { const v = chip(rom); v.write(0, 1); return v; })(), 12_000);
    expect(pause.peak).toBe(0);
    expect(pause.speaking).toBeGreaterThan(9000);
    const word = listen((() => { const v = chip(rom); v.write(0, 10); return v; })(), 12_000);
    expect(word.peak).toBeGreaterThan(10_000);
  });
});

describe('the Intellivoice on the bus', () => {
  it('answers at $0080-$0081 only with its ROM given', () => {
    const intv = new Intellivision();
    intv.setRoms(testRoms());
    expect(intv.bus.read(0x0080)).toBe(0xffff);
    intv.setRoms({ ...testRoms(), speech: new Uint8Array(0x800) });
    expect(intv.voice.present).toBe(true);
    expect(intv.bus.read(0x0080)).toBe(0x8000);
    intv.bus.write(0x0080, 7);
    expect(intv.bus.read(0x0080)).toBe(0);
    intv.pressReset();
    expect(intv.bus.read(0x0080)).toBe(0x8000);
  });

  it('is part of save states, without its ROM', () => {
    const intv = new Intellivision();
    intv.setRoms({ ...testRoms(), speech: new Uint8Array(0x800) });
    intv.bus.write(0x0081, 0x155);
    const state = intv.saveState();
    expect(JSON.stringify(state)).not.toContain('speechRom');
    const other = new Intellivision();
    other.setRoms({ ...testRoms(), speech: new Uint8Array(0x800) });
    other.loadState(state);
    expect(other.voice.fifo[0]).toBe(0x155);
    expect(other.voice.fifoHead).toBe(1);
  });
});
