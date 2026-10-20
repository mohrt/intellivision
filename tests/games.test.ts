import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Cartridge } from '../src/cart/cartridge';
import { readCartridgeImage } from '../src/cart/formats';
import { CARTRIDGE_EXTENSIONS } from '../src/cart/load';
import { Intellivision } from '../src/intellivision';
import { keyBit, NO_DIRECTION } from '../src/io/controllers';
import { identifyRom, machineRoms } from '../src/roms/system-roms';
import { framePng } from './helpers/png';

// The system ROMs and cartridge images are never committed. These run the free games (npm run
// fetch:games puts them in public/games/) and your own cartridges in roms/, given the system ROMs
// in roms/ (exec.bin, grom.bin and optionally ivoice.bin) or as INTV_EXEC=/path/to/exec.bin
// INTV_GROM=/path/to/grom.bin INTV_VOICE=/path/to/ivoice.bin. Games that talk must speak.
const root = join(import.meta.dirname, '..');
const execPath = process.env.INTV_EXEC ?? join(root, 'roms', 'exec.bin');
const gromPath = process.env.INTV_GROM ?? join(root, 'roms', 'grom.bin');
const voicePath = process.env.INTV_VOICE ?? join(root, 'roms', 'ivoice.bin');
const haveRoms = existsSync(execPath) && existsSync(gromPath);
const systemRomNames = new Set(['exec.bin', 'grom.bin', 'ivoice.bin']);
const cartridgesIn = (dir: string) =>
  existsSync(dir)
    ? readdirSync(dir)
        .filter((name) => CARTRIDGE_EXTENSIONS.some((ext) => name.toLowerCase().endsWith(ext)) && !systemRomNames.has(name))
        .map((name) => join(dir, name))
    : [];
const cartridges = haveRoms ? [...cartridgesIn(join(root, 'public', 'games')), ...cartridgesIn(join(root, 'roms'))] : [];
/** Set SHOTS=<dir> to save screenshots of the title screen and the game. */
const shotsDir = process.env.SHOTS;
const SECONDS_TO_RUN = 20;
const FPS = 60;

describe.skipIf(cartridges.length === 0)('cartridges', () => {
  const load = (path: string) => new Uint8Array(readFileSync(path));
  for (const path of cartridges) {
    const name = basename(path);
    it(`${name} turns the display on, runs its own code and talks if it should`, () => {
      const intv = new Intellivision();
      const ivoice = existsSync(voicePath) ? identifyRom('ivoice.bin', load(voicePath)) : undefined;
      intv.setRoms(
        machineRoms({ exec: identifyRom('exec', load(execPath)), grom: identifyRom('grom', load(gromPath)), ivoice }),
      );
      intv.audio.setRates(intv.clockHz, 48000);
      const cfgPath = path.replace(/\.[^.]+$/, '.cfg');
      const image = readCartridgeImage(load(path), existsSync(cfgPath) ? readFileSync(cfgPath, 'utf8') : undefined);
      intv.insertCartridge(new Cartridge(image.layout));
      let framesInCartridge = 0;
      let framesShown = 0;
      let framesSpeaking = 0;
      for (let frame = 1; frame <= SECONDS_TO_RUN * FPS; frame++) {
        // Press keys and buttons now and then to get past title screens.
        const second = Math.floor(frame / FPS);
        const pressing = frame % FPS < 6;
        intv.controllers.inputs[0].set('test', {
          disc: pressing && second % 3 === 2 ? (second * 4) % 16 : NO_DIRECTION,
          keys: pressing && second % 3 === 0 ? keyBit('1') : 0,
          top: pressing && second % 3 === 1,
        });
        intv.runFrame();
        if (intv.cpu.pc < 0x1000 || intv.cpu.pc >= 0x2000) framesInCartridge++;
        if (intv.stic.displayEnabled) framesShown++;
        if (!intv.voice.halted) framesSpeaking++;
        intv.audio.takeSamples();
        if (shotsDir && (frame === 3 * FPS || frame === SECONDS_TO_RUN * FPS)) {
          mkdirSync(shotsDir, { recursive: true });
          const label = frame === 3 * FPS ? 'title' : 'game';
          writeFileSync(join(shotsDir, `${name.replace(/\.[^.]+$/, '')} - ${label}.png`), framePng(intv.stic.framebuffer));
        }
      }
      // Games built on the EXEC spend most of their time in it while they wait for a key.
      expect(framesInCartridge).toBeGreaterThan(0);
      expect(framesShown).toBeGreaterThan(SECONDS_TO_RUN * FPS * 0.9);
      expect(new Set(intv.stic.framebuffer).size).toBeGreaterThan(2);
      if (image.known?.voice && ivoice) expect(framesSpeaking).toBeGreaterThan(FPS / 2);
      else expect(framesSpeaking).toBe(0);
    }, 60_000);
  }
});
