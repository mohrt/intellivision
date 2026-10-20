import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SystemRomStore, hasRequiredRoms, identifyRom, machineRoms, type StoredRom } from '../src/roms/system-roms';
import { MemoryStore } from '../src/storage/store';

const local = (name: string) => join(import.meta.dirname, '..', 'roms', name);

describe('system ROMs', () => {
  it('tells the EXEC and GROM apart by size, warning when they are not Mattel\'s', () => {
    expect(identifyRom('a', new Uint8Array(0x2000))).toMatchObject({ kind: 'exec', warning: expect.stringMatching(/original/) });
    expect(identifyRom('b', new Uint8Array(0x800)).kind).toBe('grom');
    expect(identifyRom('c', new Uint8Array(0x2200)).kind).toBe('exec');
    expect(() => identifyRom('d', new Uint8Array(1000))).toThrow(/8,192 bytes/);
  });

  it.skipIf(!existsSync(local('exec.bin')) || !existsSync(local('grom.bin')))('recognises Mattel\'s ROMs by checksum', () => {
    expect(identifyRom('x', new Uint8Array(readFileSync(local('exec.bin'))))).toMatchObject({ kind: 'exec', warning: null });
    expect(identifyRom('y', new Uint8Array(readFileSync(local('grom.bin'))))).toMatchObject({ kind: 'grom', warning: null });
  });

  it('maps the EXEC as 10-bit big-endian words, with the extra 256 of an Intellivision II EXEC at $0400', () => {
    const exec = new Uint8Array(0x2000);
    exec.set([0xff, 0xff, 0x01, 0x23]);
    const roms = machineRoms({ exec: { name: 'e', data: exec }, grom: { name: 'g', data: new Uint8Array(0x800) } });
    expect([roms.exec[0], roms.exec[1]]).toEqual([0x3ff, 0x123]);
    expect(roms.execAux).toBeNull();
    const exec2 = new Uint8Array(0x2200);
    exec2.set([0x00, 0x04], 0);
    exec2.set([0x00, 0x05], 0x200);
    const aux = machineRoms({ exec: { name: 'e', data: exec2 }, grom: { name: 'g', data: new Uint8Array(0x800) } });
    expect(aux.execAux?.[0]).toBe(4);
    expect(aux.exec[0]).toBe(5);
  });

  it('are kept between page loads until forgotten', async () => {
    const backing = new MemoryStore<StoredRom>();
    const store = new SystemRomStore(backing);
    await store.save('exec', { name: 'exec.bin', data: new Uint8Array(0x2000) });
    expect(hasRequiredRoms(await new SystemRomStore(backing).load())).toBe(false);
    await store.save('grom', { name: 'grom.bin', data: new Uint8Array(0x800) });
    const loaded = await new SystemRomStore(backing).load();
    expect(hasRequiredRoms(loaded)).toBe(true);
    expect(loaded.grom?.name).toBe('grom.bin');
    await store.forget();
    expect(await store.load()).toEqual({});
  });
});
