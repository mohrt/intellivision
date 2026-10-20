import { describe, expect, it } from 'vitest';
import { Cartridge } from '../src/cart/cartridge';
import { Intellivision } from '../src/intellivision';
import { SaveStates, decodeSession, encodeSession, type SaveStateRecord, type Session } from '../src/storage/save-states';
import { MemoryStore } from '../src/storage/store';
import { testRoms } from './helpers/test-roms';

const layout = () => ({ rom: [{ address: 0x5000, words: new Uint16Array(16) }], ram: [{ address: 0xd000, length: 16, width: 8 as const }] });

function running(frames: number): Intellivision {
  const intv = new Intellivision();
  intv.setRoms(testRoms());
  intv.insertCartridge(new Cartridge(layout()));
  intv.audio.setRates(intv.clockHz, 48000);
  intv.bus.write(0xd003, 0x42);
  for (let i = 0; i < frames; i++) intv.runFrame();
  return intv;
}

/** What should match between two machines run the same way from the same state. */
function fingerprint(intv: Intellivision) {
  return {
    now: intv.now,
    pc: intv.cpu.pc,
    registers: [...intv.cpu.r],
    systemRam: [...intv.bus.systemRam],
    scratchRam: [...intv.bus.scratchRam],
    cartRam: intv.bus.read(0xd003),
    sticRegisters: [...intv.stic.registers],
    frame: [...intv.stic.framebuffer],
    psg: [...intv.psg.registers],
    audio: [...intv.audio.takeSamples()],
  };
}

describe('save states', () => {
  it('restores a machine so it carries on exactly as the original did', () => {
    const original = running(10);
    const state = original.saveState();
    original.audio.takeSamples();
    for (let i = 0; i < 5; i++) original.runFrame();

    const restored = running(0);
    restored.loadState(state);
    restored.audio.takeSamples();
    for (let i = 0; i < 5; i++) restored.runFrame();

    const expected = fingerprint(original);
    expect(expected.cartRam).toBe(0x42);
    expect(fingerprint(restored)).toEqual(expected);
  });

  it('leaves the ROMs out', () => {
    const json = JSON.stringify(running(1).saveState());
    expect(json).not.toContain('"exec"');
    expect(json).not.toContain('"grom"');
  });

  it('round-trips a session through the file format and the store, newest first', async () => {
    const intv = running(3);
    const rom = new Uint8Array([1, 2, 3, 4]);
    const session: Session = { machine: intv.saveState(), rom, romName: 'test.bin', cfg: '[mapping]', title: 'Test' };
    const decoded = await decodeSession(await encodeSession(session));
    expect(decoded.rom).toEqual(rom);
    expect(decoded.cfg).toBe('[mapping]');
    const copy = running(0);
    copy.loadState(decoded.machine);
    expect(copy.now).toBe(intv.now);

    const states = new SaveStates(new MemoryStore<SaveStateRecord>());
    await states.add('first', session);
    await new Promise((resolve) => setTimeout(resolve, 2));
    await states.add('second', session);
    const list = await states.list();
    expect(list.map((s) => s.name)).toEqual(['second', 'first']);
    expect((await states.load(list[1].id))?.title).toBe('Test');
    await states.delete(list[0].id);
    expect((await states.list()).length).toBe(1);
  });

  it('rejects files that are not Intellivision states', async () => {
    await expect(decodeSession(new Uint8Array([1, 2, 3]))).rejects.toThrow(/not an Intellivision save state/);
  });
});
