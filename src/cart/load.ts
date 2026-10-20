import { isZip, readZip } from './zip';

export const CARTRIDGE_EXTENSIONS = ['.rom', '.bin', '.int', '.itv'];
export const STATE_EXTENSION = '.intvstate';
/** The biggest cartridges fill the whole 64K-word address space. */
const MAX_IMAGE_SIZE = 0x30000;

export type Media =
  | { kind: 'cartridge'; image: Uint8Array; cfg?: string; name: string }
  | { kind: 'state'; bytes: Uint8Array; name: string };

/** A file to load, with the .cfg that came with it (from the same zip). */
export interface GameFile {
  file: File;
  cfg?: File;
}

/** gzip files start with $1F $8B; save states are gzipped. */
export function looksLikeSaveState(bytes: Uint8Array): boolean {
  return bytes[0] === 0x1f && bytes[1] === 0x8b;
}

/** A display name from a file name: no extension, underscores as spaces. */
export function titleFromFileName(name: string): string {
  return name.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').trim() || name;
}

const baseName = (name: string) => name.split('/').pop()!.replace(/\.[^.]+$/, '').toLowerCase();

/** Works out what a file is: a cartridge image (with its .cfg, if any) or a save state. */
export async function readMedia({ file, cfg }: GameFile): Promise<Media> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const name = file.name.toLowerCase();
  if (name.endsWith(STATE_EXTENSION) || looksLikeSaveState(bytes)) return { kind: 'state', bytes, name: file.name };
  if (name.endsWith('.cfg')) throw new Error('A .cfg file only says how to load a .bin; drop the two together in a .zip.');
  if (bytes.length === 0) throw new Error(`${file.name} is empty.`);
  if (bytes.length > MAX_IMAGE_SIZE) throw new Error(`${file.name} is too big to be an Intellivision cartridge.`);
  const knownExtension = CARTRIDGE_EXTENSIONS.some((ext) => name.endsWith(ext));
  if (!knownExtension && bytes.length % 0x200 !== 0) {
    throw new Error(`${file.name} isn't something the Intellivision can use. Try a .rom, .bin or .int file.`);
  }
  return { kind: 'cartridge', image: bytes, cfg: cfg ? await cfg.text() : undefined, name: file.name };
}

/** File types the emulator can use, in the order a zip's contents are preferred. */
const PREFERRED_EXTENSIONS = ['.rom', '.bin', '.int', '.itv', STATE_EXTENSION];

/** The usable files in a dropped file: itself, or the cartridge images (with their .cfg files) and states inside a zip. */
export async function filesFrom(file: File): Promise<GameFile[]> {
  const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  if (!isZip(head) && !file.name.toLowerCase().endsWith('.zip')) return [{ file }];
  const entries = readZip(new Uint8Array(await file.arrayBuffer())).filter(
    (entry) => !entry.name.split('/').pop()!.startsWith('.') && !entry.name.startsWith('__MACOSX/'),
  );
  const rank = (name: string) => PREFERRED_EXTENSIONS.findIndex((ext) => name.toLowerCase().endsWith(ext));
  const toFile = async (entry: (typeof entries)[number]) =>
    new File([new Uint8Array(await entry.read())], entry.name.split('/').pop()!);
  const cfgs = entries.filter((entry) => entry.name.toLowerCase().endsWith('.cfg'));
  const games = entries
    .filter((entry) => rank(entry.name) >= 0)
    .sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name, undefined, { numeric: true }));
  if (games.length === 0) throw new Error(`${file.name} has no cartridge images in it.`);
  // A .rom describes its own memory map; a .bin takes the .cfg with its name, or the zip's only one.
  const cfgFor = (entry: (typeof entries)[number]) =>
    entry.name.toLowerCase().endsWith('.rom')
      ? undefined
      : (cfgs.find((cfg) => baseName(cfg.name) === baseName(entry.name)) ?? (cfgs.length === 1 ? cfgs[0] : undefined));
  return Promise.all(
    games.map(async (entry) => {
      const cfg = cfgFor(entry);
      return { file: await toFile(entry), cfg: cfg && (await toFile(cfg)) };
    }),
  );
}
