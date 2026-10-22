// Downloads the freely distributable games listed in games-catalog.json into
// public/games/ and writes the index.json the page reads. Games published only
// as source are built from their pinned commits with jzIntv's as1600 assembler
// and the IntyBASIC compiler, which are built from source too (this needs git,
// make and a C/C++ compiler). The files themselves are kept out of git; the
// deploy workflow runs this too. A game whose download or build fails, or whose
// download no longer matches its checksum, is left out with a warning.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync, inflateRawSync } from 'node:zlib';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const outDir = join(scriptDir, '..', 'public', 'games');
const catalog = JSON.parse(await readFile(join(scriptDir, 'games-catalog.json'), 'utf8'));

async function download(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
  return Buffer.from(await response.arrayBuffer());
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** One file from a .zip (stored or deflated), found through the central directory. */
function unzipEntry(zip, wanted) {
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0) throw new Error('not a zip file');
  let offset = zip.readUInt32LE(end + 16);
  for (let i = 0; i < zip.readUInt16LE(end + 10); i++) {
    const method = zip.readUInt16LE(offset + 10);
    const size = zip.readUInt32LE(offset + 20);
    const nameLength = zip.readUInt16LE(offset + 28);
    const skip = nameLength + zip.readUInt16LE(offset + 30) + zip.readUInt16LE(offset + 32);
    const local = zip.readUInt32LE(offset + 42);
    const name = zip.toString('utf8', offset + 46, offset + 46 + nameLength);
    if (name === wanted) {
      const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
      const data = zip.subarray(start, start + size);
      return method === 0 ? Buffer.from(data) : inflateRawSync(data);
    }
    offset += 46 + skip;
  }
  throw new Error(`${wanted} is not in the zip`);
}

async function downloadGame(game) {
  let bytes = await download(game.url);
  if (sha256(bytes) !== game.sha256) throw new Error('the download has changed (checksum mismatch)');
  if (game.gzip) bytes = gunzipSync(bytes);
  if (game.zipEntry) bytes = unzipEntry(bytes, game.zipEntry);
  return bytes;
}

const workDir = await mkdtemp(join(tmpdir(), 'intv-games-'));
const toolsDir = join(workDir, 'tools');
mkdirSync(toolsDir);

/** Runs a command, failing with the end of its output. */
function run(command, args, cwd) {
  try {
    execFileSync(command, args, {
      cwd,
      stdio: 'pipe',
      env: { ...process.env, PATH: `${toolsDir}${delimiter}${process.env.PATH}` },
    });
  } catch (error) {
    const output = `${error.stdout ?? ''}${error.stderr ?? ''}`.trim().split('\n').slice(-5).join('\n');
    throw new Error(`${command} ${args.join(' ')} failed${output ? `:\n${output}` : ` (${error.message})`}`);
  }
}

const steps = new Map();
/** Runs a setup step shared by several games once, remembering its result or its failure. */
function once(key, step) {
  if (!steps.has(key)) {
    try {
      steps.set(key, { value: step() });
    } catch (error) {
      steps.set(key, { error });
    }
  }
  const { value, error } = steps.get(key);
  if (error) throw error;
  return value;
}

/** A source tree from the catalog's sources, checked out at its pinned commit. */
const checkout = (name) =>
  once(`source ${name}`, () => {
    const { repo, commit } = catalog.sources[name];
    const dir = join(workDir, name);
    mkdirSync(dir);
    run('git', ['init', '-q'], dir);
    run('git', ['fetch', '-q', '--depth', '1', repo, commit], dir);
    run('git', ['checkout', '-q', 'FETCH_HEAD'], dir);
    return dir;
  });

/** jzIntv's assembler, put on the PATH. GCC's LTO flags and the static Linux link are cleared so it builds on macOS too. */
const as1600 = () =>
  once('as1600', () => {
    const jzintv = checkout('jzintv');
    mkdirSync(join(jzintv, 'bin'), { recursive: true });
    run('make', ['LTO=', 'SLFLAGS=', '../bin/as1600'], join(jzintv, 'src'));
    const tool = join(toolsDir, 'as1600');
    writeFileSync(tool, readFileSync(join(jzintv, 'bin', 'as1600')), { mode: 0o755 });
    return tool;
  });

/** The IntyBASIC compiler, and the directory with the prologue and epilogue its output includes. */
const intybasic = () =>
  once('intybasic', () => {
    const dir = checkout('intybasic');
    run('make', ['intybasic'], dir);
    return { compiler: join(dir, 'intybasic'), library: dir };
  });

/** Builds a game from source as its catalog entry describes, returning the .rom image. */
function buildGame(game) {
  const { build } = game;
  const dir = join(checkout(build.source), build.dir);
  for (const fix of build.fixes ?? []) {
    const path = join(dir, fix.file);
    writeFileSync(path, readFileSync(path, 'utf8').replace(fix.find, fix.replace));
  }
  const rom = join(workDir, game.file);
  if (build.make) {
    as1600(); // The Makefile runs it from the PATH.
    for (const made of build.makeDirs ?? []) mkdirSync(join(dir, made), { recursive: true });
    // The helper tools are built without -Werror and with config.h's portable macOS settings
    // everywhere: Linux's include x86-only <sys/io.h>, and `macosx` must expand to itself
    // because an empty one breaks the macOS SDK's availability attributes.
    run('make', ['CC=cc -w -Ulinux -Dmacosx=macosx', build.make], dir);
    return readFileSync(join(dir, build.make));
  }
  if (build.bas) {
    const { compiler, library } = intybasic();
    const asm = build.bas.replace(/\.bas$/, '.asm');
    run(compiler, [build.bas, asm, library], dir);
    run(as1600(), ['-o', rom, `-i${library}`, asm], dir);
  } else {
    run(as1600(), ['-o', rom, ...(build.include ?? []).map((path) => `-i${path}`), build.asm], dir);
  }
  return readFileSync(rom);
}

try {
  await mkdir(outDir, { recursive: true });
  const games = [];
  for (const game of catalog.games) {
    try {
      const bytes = game.build ? buildGame(game) : await downloadGame(game);
      await writeFile(join(outDir, game.file), bytes);

      let licenseUrl = game.licenseUrl;
      if (game.licenseFile) {
        // Licences such as MIT and GPL must be shipped with the copies.
        const licenseName = `${game.file}.license.txt`;
        await writeFile(join(outDir, licenseName), await download(game.licenseFile));
        licenseUrl = `games/${licenseName}`;
      }
      games.push({
        title: game.title,
        file: game.file,
        credit: game.credit,
        license: game.license,
        licenseUrl,
        sourceUrl: game.sourceUrl,
        hint: game.hint,
      });
      console.log(`Saved public/games/${game.file}`);
    } catch (error) {
      console.warn(`Skipping ${game.title}: ${error.message}`);
    }
  }

  games.sort((a, b) => a.title.localeCompare(b.title));
  await writeFile(join(outDir, 'index.json'), `${JSON.stringify({ games }, null, 2)}\n`);
  console.log(`Listed ${games.length} of ${catalog.games.length} games in public/games/index.json`);
} finally {
  await rm(workDir, { recursive: true, force: true });
}
