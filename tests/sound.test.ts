import { describe, expect, it } from 'vitest';
import { AY_VOLUMES, Ay8914 } from '../src/sound/ay8914';
import { AudioMixer } from '../src/sound/mixer';

function chip(): Ay8914 {
  const psg = new Ay8914();
  psg.reset();
  return psg;
}

/** Channel A alone: tone on, noise off for all, at `volume`. */
function toneOnA(psg: Ay8914, period: number, volume = 15): void {
  psg.write(0, period & 0xff);
  psg.write(4, period >> 8);
  psg.write(8, 0x3e);
  psg.write(11, volume);
}

describe('AY-3-8914', () => {
  it('keeps only the bits each register has', () => {
    const psg = chip();
    for (let reg = 0; reg < 14; reg++) psg.write(reg, 0xff);
    expect([...psg.registers]).toEqual([0xff, 0xff, 0xff, 0xff, 0x0f, 0x0f, 0x0f, 0xff, 0xff, 0x1f, 0x0f, 0x3f, 0x3f, 0x3f]);
    expect(psg.read(14)).toBe(0xff);
  });

  it('plays a tone of the CPU clock / (8 x period): 254 is about 440 Hz', () => {
    const psg = chip();
    toneOnA(psg, 254);
    const clockHz = 3_579_545 / 4;
    let edges = 0;
    let last = 0;
    for (let tick = 0; tick < clockHz / 4; tick++) {
      const level = psg.tick();
      if (level > 0 && last === 0) edges++;
      last = level;
    }
    expect(edges).toBeGreaterThanOrEqual(438);
    expect(edges).toBeLessThanOrEqual(442);
  });

  it('treats a tone period of 0 as 4096', () => {
    const psg = chip();
    toneOnA(psg, 0);
    let changes = 0;
    let last = psg.tick();
    for (let tick = 0; tick < 4096 * 4; tick++) {
      const level = psg.tick();
      if (level !== last) changes++;
      last = level;
    }
    expect(changes).toBe(4);
  });

  it('ramps the envelope up and holds it, or down to silence, by its shape', () => {
    const levels = (shape: number) => {
      const psg = chip();
      psg.write(3, 1);
      psg.write(10, shape);
      const seen: number[] = [psg.envelopeLevel];
      for (let tick = 0; tick < 2 * 40; tick++) {
        psg.tick();
        if (psg.envelopeLevel !== seen[seen.length - 1]) seen.push(psg.envelopeLevel);
      }
      return seen;
    };
    expect(levels(0x0d)).toEqual([...Array(16).keys()]);
    expect(levels(0x00)).toEqual([...Array(16).keys()].reverse());
    // Shape $0E goes up and down for ever.
    expect(levels(0x0e).slice(0, 18)).toEqual([...Array(16).keys(), 14, 13]);
  });

  it('plays the envelope at full, half or a quarter by volume bits 5-4', () => {
    const at = (volume: number) => {
      const psg = chip();
      toneOnA(psg, 1, volume);
      psg.write(10, 0x0d);
      psg.write(3, 1);
      for (let tick = 0; tick < 64; tick++) psg.tick();
      let peak = 0;
      for (let tick = 0; tick < 8; tick++) peak = Math.max(peak, psg.tick());
      return peak;
    };
    expect(at(0x30)).toBeCloseTo(AY_VOLUMES[15]);
    expect(at(0x20)).toBeCloseTo(AY_VOLUMES[15] / 2);
    expect(at(0x10)).toBeCloseTo(AY_VOLUMES[15] / 4);
  });

  it('makes noise from its shift register when noise is enabled', () => {
    const psg = chip();
    psg.write(8, 0x37);
    psg.write(9, 1);
    psg.write(11, 15);
    const levels = new Set<number>();
    for (let tick = 0; tick < 2000; tick++) levels.add(psg.tick());
    expect(levels.size).toBe(2);
  });
});

describe('audio mixer', () => {
  it('turns the chip into samples at the output rate, without a DC offset', () => {
    const psg = chip();
    toneOnA(psg, 254);
    const mixer = new AudioMixer(psg);
    const clockHz = 3_579_545 / 4;
    mixer.setRates(clockHz, 48000);
    mixer.run(clockHz);
    const samples = mixer.takeSamples();
    expect(samples.length).toBeGreaterThan(47900);
    expect(samples.length).toBeLessThan(48100);
    const tail = samples.slice(24000);
    const mean = tail.reduce((sum, value) => sum + value, 0) / tail.length;
    expect(Math.abs(mean)).toBeLessThan(0.01);
    expect(Math.max(...tail)).toBeGreaterThan(0.05);
  });
});
