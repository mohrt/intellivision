import { crc32 } from '../roms/system-roms';
import type { CartridgeLayout, RamBlock, RomBlock } from './cartridge';
import { KNOWN_CARTS, type KnownCart } from './known-carts';

export type ImageFormat = 'rom' | 'bin';

export interface CartridgeImage {
  format: ImageFormat;
  layout: CartridgeLayout;
  /** From the table of known cartridges, by the file's CRC-32. */
  known?: KnownCart;
  /** Things the user should know, e.g. hardware this emulator doesn't have. */
  warnings: string[];
}

/** Where a .bin without a .cfg goes: 8K words at $5000, then 4K at $D000 and 4K at $F000. */
const USUAL_MAP: [number, number][] = [
  [0x5000, 0x2000],
  [0xd000, 0x1000],
  [0xf000, 0x1000],
];
/** JLP boards add 16-bit RAM here. */
const JLP_RAM: RamBlock = { address: 0x8040, length: 0x1f40, width: 16 };

const ROM_READ = 0x01;
const ROM_WRITE = 0x02;
const ROM_NARROW = 0x04;

/** CRC-16 with polynomial $1021, as the Intellicart's .rom format uses. */
export function crc16(bytes: Uint8Array, start: number, end: number): number {
  let crc = 0xffff;
  for (let i = start; i < end; i++) {
    crc ^= bytes[i] << 8;
    for (let bit = 0; bit < 8; bit++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

/** The Intellicart .rom format starts $A8 (or 'A'), then the segment count and its complement. */
export function looksLikeRomFormat(bytes: Uint8Array): boolean {
  return bytes.length >= 53 && (bytes[0] === 0xa8 || (bytes[0] & ~0x20) === 0x41) && (bytes[1] ^ bytes[2]) === 0xff;
}

/** Merges RAM given 256 words at a time into blocks. */
function addRam(ram: RamBlock[], address: number, length: number, width: 8 | 16): void {
  const last = ram[ram.length - 1];
  if (last && last.width === width && last.address + last.length === address) last.length += length;
  else ram.push({ address, length, width });
}

/**
 * Decodes an Intellicart .rom: segments of big-endian words, each with its
 * address range and a CRC, then a table of which 2K pages are readable and
 * writable (RAM), with 256-word precision.
 */
export function parseRomFormat(bytes: Uint8Array): CartridgeLayout {
  const segments = bytes[1];
  let offset = 3;
  const rom: RomBlock[] = [];
  for (let i = 0; i < segments; i++) {
    const start = offset;
    if (offset + 2 > bytes.length) throw new Error('The .rom file is cut short.');
    const low = bytes[offset++] << 8;
    const high = (bytes[offset++] << 8) + 0x100;
    if (high <= low) throw new Error('The .rom file has a segment with a bad address range.');
    const length = high - low;
    if (offset + length * 2 + 2 > bytes.length) throw new Error('The .rom file is cut short.');
    const words = new Uint16Array(length);
    for (let w = 0; w < length; w++, offset += 2) words[w] = (bytes[offset] << 8) | bytes[offset + 1];
    const expected = (bytes[offset] << 8) | bytes[offset + 1];
    if (crc16(bytes, start, offset) !== expected) throw new Error('The .rom file is damaged (a segment fails its CRC check).');
    offset += 2;
    rom.push({ address: low, words });
  }

  if (offset + 50 > bytes.length) throw new Error('The .rom file is cut short (no memory attribute table).');
  const ram: RamBlock[] = [];
  for (let page = 0; page < 32; page++) {
    const attributes = (bytes[offset + (page >> 1)] >> ((page & 1) * 4)) & 0x0f;
    const range = bytes[offset + 16 + ((page >> 1) | ((page & 1) << 4))];
    const first = (range >> 4) & 7;
    const last = range & 7;
    if (!(attributes & ROM_READ) || !(attributes & ROM_WRITE)) continue;
    for (let sub = first; sub <= last; sub++) {
      addRam(ram, (page << 11) | (sub << 8), 0x100, attributes & ROM_NARROW ? 8 : 16);
    }
  }
  return { rom, ram };
}

export interface CfgFile {
  /** [file word, last file word, address]. */
  mapping: [number, number, number][];
  ram: RamBlock[];
  vars: Record<string, string>;
}

const number = (text: string) => (text.startsWith('$') ? parseInt(text.slice(1), 16) : parseInt(text, 10));

/** Reads the parts of a jzIntv .cfg file that describe plain ROM and RAM. */
export function parseCfg(text: string): CfgFile {
  const cfg: CfgFile = { mapping: [], ram: [], vars: {} };
  let section = '';
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/;.*$/, '').trim();
    if (!line) continue;
    const header = line.match(/^\[(\w+)\]$/);
    if (header) {
      section = header[1].toLowerCase();
      continue;
    }
    if (section === 'mapping' || section === 'preload') {
      // Lines with PAGE are the ECS's paged ROM, which this emulator doesn't have.
      const m = line.match(/^(\$?[0-9a-f]+)\s*-\s*(\$?[0-9a-f]+)\s*=\s*(\$?[0-9a-f]+)\s*$/i);
      if (m) cfg.mapping.push([number(m[1]), number(m[2]), number(m[3])]);
    } else if (section === 'memattr') {
      const m = line.match(/^(\$?[0-9a-f]+)\s*-\s*(\$?[0-9a-f]+)\s*=\s*RAM\s+(\d+)/i);
      if (m) {
        const start = number(m[1]);
        cfg.ram.push({ address: start, length: number(m[2]) - start + 1, width: Number(m[3]) <= 8 ? 8 : 16 });
      }
    } else if (section === 'vars') {
      const m = line.match(/^(\w+)\s*=\s*"?([^"]*)"?$/);
      if (m) cfg.vars[m[1].toLowerCase()] = m[2].trim();
    }
  }
  return cfg;
}

function wordsOf(bytes: Uint8Array): Uint16Array {
  const words = new Uint16Array(bytes.length >> 1);
  for (let i = 0; i < words.length; i++) words[i] = (bytes[i * 2] << 8) | bytes[i * 2 + 1];
  return words;
}

/** Lays a .bin's words out in blocks taken in file order. */
function sequentialBlocks(words: Uint16Array, map: [number, number][]): RomBlock[] {
  const blocks: RomBlock[] = [];
  let at = 0;
  for (const [address, length] of map) {
    if (at >= words.length) break;
    blocks.push({ address, words: words.slice(at, at + length) });
    at += length;
  }
  return blocks;
}

/** A raw .bin (or .int) image: big-endian words, laid out by its .cfg, the table of known carts, or the usual map. */
export function parseBin(bytes: Uint8Array, cfgText?: string, known?: KnownCart): CartridgeLayout {
  if (bytes.length % 2 !== 0) throw new Error("That file has an odd number of bytes, so it isn't an Intellivision .bin image.");
  const words = wordsOf(bytes);
  if (cfgText !== undefined) {
    const cfg = parseCfg(cfgText);
    const rom = cfg.mapping.map(([first, last, address]) => ({ address, words: words.slice(first, last + 1) }));
    const ram = [...cfg.ram];
    if (Number(cfg.vars.jlp) > 0) ram.push(JLP_RAM);
    return { rom: rom.length ? rom : sequentialBlocks(words, USUAL_MAP), ram };
  }
  const ram: RamBlock[] = known?.ram ? [{ address: known.ram[0], length: known.ram[1], width: 8 }] : [];
  const map = known?.map ?? USUAL_MAP;
  if (words.length > map.reduce((total, [, length]) => total + length, 0)) {
    throw new Error(
      "That image is bigger than the usual cartridge memory map, and it isn't one this emulator knows. Load it with its .cfg file (both in one .zip).",
    );
  }
  return { rom: sequentialBlocks(words, map), ram };
}

/** Works out what a cartridge file holds, and how it is wired. */
export function readCartridgeImage(bytes: Uint8Array, cfgText?: string): CartridgeImage {
  const known = KNOWN_CARTS.get(crc32(bytes));
  const warnings: string[] = [];
  let format: ImageFormat = 'bin';
  let layout: CartridgeLayout | undefined;
  if (looksLikeRomFormat(bytes)) {
    try {
      layout = parseRomFormat(bytes);
      format = 'rom';
    } catch (error) {
      // A .bin can happen to start like a .rom; only give up if it can't be a .bin either.
      if (bytes.length % 2 !== 0) throw error;
    }
  }
  layout ??= parseBin(bytes, cfgText, known);
  if (known?.ecs) warnings.push("This game needs the Entertainment Computer System, which isn't emulated.");
  return { format, layout, known, warnings };
}
