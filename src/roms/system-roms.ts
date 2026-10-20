import type { KeyValueStore } from '../storage/store';

export type RomKind = 'exec' | 'grom';

export const ROM_KINDS: readonly RomKind[] = ['exec', 'grom'];

/** The EXEC is 4K 10-bit words, stored as big-endian 16-bit words; Intellivision II dumps add 256 words. */
export const EXEC_SIZES = [0x2000, 0x2200];
export const GROM_SIZE = 0x800;

/** CRC-32s of Mattel's chips. */
const KNOWN_ROMS: Record<number, RomKind> = {
  0xcbce86f7: 'exec', // the Master Component's Executive ROM
  0x683a4158: 'grom', // the Graphics ROM
};

export interface StoredRom {
  /** The file it came from, shown to the user. */
  name: string;
  data: Uint8Array;
}

export interface IdentifiedRom extends StoredRom {
  kind: RomKind;
  /** Set when the file is the right size but not Mattel's original. */
  warning: string | null;
}

export type SystemRoms = Partial<Record<RomKind, StoredRom>>;

/** What the console itself maps into memory. */
export interface MachineRoms {
  /** $1000-$1FFF. */
  exec: Uint16Array;
  /** $0400-$04FF, only in Intellivision II EXECs. */
  execAux: Uint16Array | null;
  /** The 256 built-in 8x8 cards, $3000-$37FF. */
  grom: Uint8Array;
}

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export function isRomSize(size: number): boolean {
  return size === GROM_SIZE || EXEC_SIZES.includes(size);
}

/** Works out which system ROM a file is; throws if it can't be one. */
export function identifyRom(name: string, data: Uint8Array): IdentifiedRom {
  const known = KNOWN_ROMS[crc32(data)];
  if (known) return { kind: known, name, data, warning: null };
  let kind: RomKind;
  if (data.length === GROM_SIZE) kind = 'grom';
  else if (EXEC_SIZES.includes(data.length)) kind = 'exec';
  else {
    throw new Error(
      `${name} is ${data.length.toLocaleString('en')} bytes, which isn't an Intellivision system ROM. ` +
        'The EXEC is 8,192 bytes and the GROM 2,048.',
    );
  }
  return { kind, name, data, warning: "not Mattel's original; some games may not work with it" };
}

export function hasRequiredRoms(roms: SystemRoms): boolean {
  return ROM_KINDS.every((kind) => roms[kind]);
}

/** Big-endian 16-bit words from a ROM file, masked to the chip's width. */
function words(bytes: Uint8Array, from: number, count: number, mask: number): Uint16Array {
  const out = new Uint16Array(count);
  for (let i = 0; i < count; i++) out[i] = ((bytes[from + i * 2] << 8) | bytes[from + i * 2 + 1]) & mask;
  return out;
}

/** The ROMs as the console maps them; throws if one is missing. */
export function machineRoms(roms: SystemRoms): MachineRoms {
  const { exec, grom } = roms;
  if (!exec || !grom) throw new Error('Both the EXEC and the GROM are needed.');
  const aux = exec.data.length === EXEC_SIZES[1];
  return {
    execAux: aux ? words(exec.data, 0, 0x100, 0x3ff) : null,
    exec: words(exec.data, aux ? 0x200 : 0, 0x1000, 0x3ff),
    grom: grom.data.slice(0, GROM_SIZE),
  };
}

/**
 * The user's ROMs, kept in browser storage (IndexedDB) so they only have to be
 * given once. Saving asks the browser to make the storage persistent, which
 * stops it evicting the ROMs under storage pressure; browsers are likelier to
 * grant that right after a user action like choosing files.
 */
export class SystemRomStore {
  constructor(private readonly store: KeyValueStore<StoredRom>) {}

  async load(): Promise<SystemRoms> {
    const roms: SystemRoms = {};
    for (const [key, rom] of await this.store.entries()) {
      const kind = key as RomKind;
      const sizeOk = kind === 'grom' ? rom.data.length === GROM_SIZE : EXEC_SIZES.includes(rom.data.length);
      if (ROM_KINDS.includes(kind) && sizeOk) roms[kind] = rom;
    }
    return roms;
  }

  save(kind: RomKind, rom: StoredRom): Promise<void> {
    void globalThis.navigator?.storage?.persist?.().catch(() => false);
    return this.store.put(kind, { name: rom.name, data: rom.data });
  }

  async forget(): Promise<void> {
    await Promise.all(ROM_KINDS.map((kind) => this.store.delete(kind)));
  }
}
