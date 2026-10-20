import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Cartridge } from '../src/cart/cartridge';
import { crc16, looksLikeRomFormat, parseBin, parseCfg, parseRomFormat, readCartridgeImage } from '../src/cart/formats';
import { KNOWN_CARTS } from '../src/cart/known-carts';
import { filesFrom, readMedia } from '../src/cart/load';
import { makeZip } from './helpers/zip';

const bigEndian = (words: number[]) => Uint8Array.from(words.flatMap((word) => [word >> 8, word & 0xff]));

/** An Intellicart .rom with the given segments ([address, words], 256-word aligned) and attribute bytes. */
function romFile(segments: [number, number[]][], attributes = new Uint8Array(48)): Uint8Array {
  const parts: number[] = [0xa8, segments.length, segments.length ^ 0xff];
  for (const [address, words] of segments) {
    const segment = [address >> 8, (address + words.length - 1) >> 8, ...bigEndian(words)];
    const crc = crc16(Uint8Array.from(segment), 0, segment.length);
    parts.push(...segment, crc >> 8, crc & 0xff);
  }
  const crc = crc16(attributes, 0, 48);
  return Uint8Array.from([...parts, ...attributes, crc >> 8, crc & 0xff]);
}

describe('Intellicart .rom images', () => {
  it('reads its segments and its RAM from the attribute table', () => {
    const attributes = new Uint8Array(48);
    // Page 26 ($D000-$D7FF): readable, writable, 8-bit; its first 4 x 256 words.
    attributes[13] = 0x7 << 0;
    attributes[16 + 13] = 0x03;
    const words = Array.from({ length: 0x100 }, (_, i) => i * 3);
    const layout = parseRomFormat(romFile([[0x5000, words]], attributes));
    expect(layout.rom).toHaveLength(1);
    expect(layout.rom[0].address).toBe(0x5000);
    expect([...layout.rom[0].words]).toEqual(words);
    expect(layout.ram).toEqual([{ address: 0xd000, length: 0x400, width: 8 }]);
  });

  it('turns away a damaged .rom', () => {
    const image = romFile([[0x5000, new Array(0x100).fill(7)]]);
    expect(looksLikeRomFormat(image)).toBe(true);
    image[10] ^= 1;
    expect(() => parseRomFormat(image)).toThrow(/damaged/);
  });

  const games = join(import.meta.dirname, '..', 'public', 'games');
  const roms = existsSync(games) ? readdirSync(games).filter((name) => name.endsWith('.rom')) : [];
  it.skipIf(roms.length === 0)('reads the free games written by the IntyBASIC toolchain', () => {
    for (const name of roms) {
      const image = readCartridgeImage(new Uint8Array(readFileSync(join(games, name))));
      expect(image.format).toBe('rom');
      expect(image.layout.rom.some((block) => block.address === 0x5000)).toBe(true);
    }
  });
});

describe('.bin images', () => {
  it('lays out big-endian words over the usual map: 8K at $5000, then $D000 and $F000', () => {
    const words = Array.from({ length: 0x3800 }, (_, i) => i & 0xffff);
    const layout = parseBin(bigEndian(words));
    expect(layout.rom.map((block) => [block.address, block.words.length])).toEqual([
      [0x5000, 0x2000],
      [0xd000, 0x1000],
      [0xf000, 0x800],
    ]);
    expect(layout.rom[1].words[0]).toBe(0x2000);
  });

  it('uses the memory map the table of known carts gives', () => {
    const atlantis = KNOWN_CARTS.get(0x13ff363c);
    expect(atlantis?.map).toEqual([[0x4800, 0x2000]]);
    const layout = parseBin(new Uint8Array(0x4000), undefined, atlantis);
    expect(layout.rom[0].address).toBe(0x4800);
    const chess = KNOWN_CARTS.get(0x752fd927);
    expect(parseBin(new Uint8Array(0x4000), undefined, chess).ram).toEqual([{ address: 0xd000, length: 0x800, width: 8 }]);
    expect(KNOWN_CARTS.get(0x8ad19ab3)?.voice).toBe(true);
  });

  it('follows a .cfg: its mapping, RAM and JLP', () => {
    const cfg = parseCfg(`
[mapping]
$0000 - $0FFF = $5000 ; first 4K
$1000 - $1FFF = $9000
$2000 - $2FFF = $C000 PAGE 1
[memattr]
$8800 - $8FFF = RAM 8
[vars]
name = "Some Game"
jlp = 1
`);
    expect(cfg.mapping).toEqual([
      [0x0000, 0x0fff, 0x5000],
      [0x1000, 0x1fff, 0x9000],
    ]);
    expect(cfg.ram).toEqual([{ address: 0x8800, length: 0x800, width: 8 }]);
    expect(cfg.vars).toEqual({ name: 'Some Game', jlp: '1' });
    const layout = parseBin(new Uint8Array(0x4000), '[mapping]\n$0000 - $0FFF = $9000\n[vars]\njlp = 1\n');
    expect(layout.rom.map((block) => block.address)).toEqual([0x9000]);
    expect(layout.ram).toEqual([{ address: 0x8040, length: 0x1f40, width: 16 }]);
  });

  it('turns away an image bigger than the usual map with no .cfg', () => {
    expect(() => parseBin(new Uint8Array(0x8002))).toThrow(/\.cfg/);
    expect(() => parseBin(new Uint8Array(3))).toThrow(/odd number/);
  });
});

describe('cartridges on the bus', () => {
  it('reads its ROM, keeps its RAM (8-bit RAM keeps 8 bits) until power off, and floats elsewhere', () => {
    const cartridge = new Cartridge({
      rom: [{ address: 0x5000, words: Uint16Array.of(0x1234, 0x5678) }],
      ram: [
        { address: 0xd000, length: 0x100, width: 8 },
        { address: 0x8040, length: 0x10, width: 16 },
      ],
    });
    expect(cartridge.read(0x5001)).toBe(0x5678);
    cartridge.write(0x5000, 0);
    expect(cartridge.read(0x5000)).toBe(0x1234);
    cartridge.write(0xd000, 0xabcd);
    cartridge.write(0x8040, 0xabcd);
    expect(cartridge.read(0xd000)).toBe(0xcd);
    expect(cartridge.read(0x8040)).toBe(0xabcd);
    expect(cartridge.read(0x6000)).toBe(0xffff);
    cartridge.reset();
    expect(cartridge.read(0xd000)).toBe(0);
    expect(cartridge.describe()).toBe('$5000-$5001, RAM $D000-$D0FF, RAM $8040-$804F');
  });
});

describe('dropped files', () => {
  it('pairs a .bin in a zip with its .cfg, and leaves .rom files on their own', async () => {
    const zip = makeZip({
      'game.bin': new Uint8Array(0x2000),
      'game.cfg': new TextEncoder().encode('[mapping]\n$0000 - $0FFF = $6000\n'),
      'other.rom': romFile([[0x5000, new Array(0x100).fill(1)]]),
      '__MACOSX/._game.bin': new Uint8Array(4),
    });
    const files = await filesFrom(new File([zip], 'games.zip'));
    expect(files.map((game) => [game.file.name, game.cfg?.name])).toEqual([
      ['other.rom', undefined],
      ['game.bin', 'game.cfg'],
    ]);
    const media = await readMedia(files[1]);
    expect(media.kind === 'cartridge' && readCartridgeImage(media.image, media.cfg).layout.rom[0].address).toBe(0x6000);
  });

  it('says what to do with a .cfg on its own', async () => {
    await expect(readMedia({ file: new File(['[mapping]'], 'game.cfg') })).rejects.toThrow(/\.zip/);
  });
});
