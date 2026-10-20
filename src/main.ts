import { AudioOutput } from './audio/audio-output';
import { Cartridge } from './cart/cartridge';
import { readCartridgeImage, type CartridgeImage } from './cart/formats';
import { STATE_EXTENSION, filesFrom, readMedia, titleFromFileName, type GameFile } from './cart/load';
import { Emulator } from './emulator';
import { fetchGame, loadGameManifest, type BundledGame } from './games';
import { GamepadManager, padName, readGamepad } from './io/gamepad-input';
import { KeyboardInput } from './io/keyboard-input';
import { SCREEN_ASPECT, Screen } from './render/screen';
import {
  SystemRomStore,
  crc32,
  hasRequiredRoms,
  identifyRom,
  machineRoms,
  type StoredRom,
  type SystemRoms,
} from './roms/system-roms';
import { SaveStates, decodeSession, encodeSession, type SaveStateRecord, type Session } from './storage/save-states';
import { memoryStores, openBrowserStores, type KeyValueStore } from './storage/store';
import { CartPanel } from './ui/cart-panel';
import { downloadFile } from './ui/download';
import { OnScreenKeypad } from './ui/keypad';
import { askForRoms } from './ui/rom-setup';
import { Settings } from './ui/settings';
import { attachToolbar } from './ui/toolbar';

/** Form fields whose values are remembered between visits. */
const REMEMBERED_SETTINGS = ['tv', 'show-keypad', 'keypad-player', 'sound', 'volume'];

/** Longest gap the loop catches up on, so a backgrounded tab doesn't run a burst of frames. */
const MAX_FRAME_MS = 100;
const PLAYERS = 2;
/** The system ROMs' CRCs, to recognise one dropped on the cartridge slot. */
const SYSTEM_ROM_CRCS = new Set([0xcbce86f7, 0x683a4158, 0x0de7579d]);
const ROM_LABELS = { exec: 'EXEC', grom: 'GROM', ivoice: 'Intellivoice ROM' } as const;

interface CurrentCartridge {
  image: Uint8Array;
  cfg?: string;
  fileName: string;
  title: string;
  /** Talks through the Intellivoice. */
  talks: boolean;
}

function requireElement<T extends HTMLElement>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Page is missing ${selector}`);
  return element;
}

const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'intellivision';

/** What the cartridge panel says about an image: its memory map, and anything missing. */
function describeImage(image: CartridgeImage, cartridge: Cartridge): string {
  const format = image.format === 'rom' ? 'Intellicart .rom' : '.bin';
  return [`${format}: ${cartridge.describe()}`, ...image.warnings].join(' · ');
}

async function main(): Promise<void> {
  const canvas = requireElement<HTMLCanvasElement>('#screen');
  const status = requireElement<HTMLParagraphElement>('#status');
  const screenFrame = requireElement<HTMLElement>('.screen-frame');
  const romSetup = requireElement<HTMLElement>('#rom-setup');

  try {
    document.documentElement.style.setProperty('--screen-aspect', SCREEN_ASPECT.toFixed(4));
    const settings = new Settings();
    settings.bind(document, REMEMBERED_SETTINGS);

    const screen = new Screen(canvas);
    const emulator = new Emulator(screen);
    const machine = emulator.machine;
    const audio = await AudioOutput.create().catch((error: unknown) => {
      console.warn('Audio is unavailable:', error);
      return null;
    });
    if (audio) emulator.setAudioRate(audio.sampleRate);

    const stores = await openBrowserStores(() => {
      status.textContent = "Waiting for the browser's storage: if this page is open in another tab, close or reload that tab.";
    }).catch((error: unknown) => {
      console.warn('Browser storage is unavailable; the ROMs and save states will last until the page is closed.', error);
      requireElement<HTMLElement>('.rom-storage-note').textContent =
        "This browser isn't letting the page store files, so the ROMs will be forgotten when you close it.";
      return memoryStores();
    });
    const romStore = new SystemRomStore(stores.roms as KeyValueStore<StoredRom>);
    const saveStates = new SaveStates(stores.saveStates as KeyValueStore<SaveStateRecord>);

    let current: CurrentCartridge | null = null;
    let paused = false;
    /** While the ROM setup is shown in place of the screen. */
    let choosingRoms = false;
    const focusScreen = () => canvas.focus();

    const updateStatus = () => {
      const what = !machine.romsLoaded ? 'No system ROMs' : current ? current.title : 'No cartridge';
      status.textContent = `${what} · ${machine.tv.toUpperCase()} · Arrows, Space and the number keys play`;
    };

    // --- System ROMs ----------------------------------------------------------------
    // The user's own EXEC and GROM, kept in the browser; the site never serves them.
    const useRoms = (roms: SystemRoms) => {
      machine.setRoms(hasRequiredRoms(roms) ? machineRoms(roms) : null);
      cartPanel.showRoms(machine.romsLoaded);
      cartPanel.showVoicePrompt(!!current?.talks && !machine.voice.present);
      updateCanSave();
      updateStatus();
      audio?.flush();
    };
    /** Shows the ROM setup in place of the (paused) screen until the user starts the console or goes back. */
    const openRomSetup = async (whileRunning: boolean) => {
      if (choosingRoms) return;
      choosingRoms = true;
      audio?.flush();
      if (!whileRunning) status.textContent = 'Load the system ROMs above to switch the console on.';
      const chosen = await askForRoms(romSetup, romStore, await romStore.load(), { whileRunning });
      choosingRoms = false;
      emulator.resetTiming();
      const stored = await romStore.load();
      if (chosen || !hasRequiredRoms(stored)) useRoms(chosen ?? stored);
      if (!machine.romsLoaded) void openRomSetup(false);
      updateStatus();
      focusScreen();
    };
    const addRom = async (name: string, data: Uint8Array) => {
      const rom = identifyRom(name, data);
      await romStore.save(rom.kind, rom);
      const roms = await romStore.load();
      if (hasRequiredRoms(roms)) useRoms(roms);
      toolbar.showMessage(`${ROM_LABELS[rom.kind]} loaded`);
    };

    // --- Cartridges -----------------------------------------------------------------
    const insertImage = (image: Uint8Array, fileName: string, cfg?: string, title?: string) => {
      const parsed = readCartridgeImage(image, cfg);
      const cartridge = new Cartridge(parsed.layout);
      machine.insertCartridge(cartridge);
      current = {
        image,
        cfg,
        fileName,
        title: title ?? parsed.known?.title ?? titleFromFileName(fileName.split(' from ')[0]),
        talks: !!parsed.known?.voice,
      };
      emulator.resetTiming();
      audio?.flush();
      cartPanel.showCartridge(current.title, fileName, describeImage(parsed, cartridge));
      cartPanel.showVoicePrompt(current.talks && !machine.voice.present);
      if (parsed.warnings.length) cartPanel.showMessage(parsed.warnings.join(' '), true);
      updateCanSave();
      updateStatus();
    };

    const eject = () => {
      machine.insertCartridge(null);
      current = null;
      cartPanel.showEmpty();
      updateCanSave();
      updateStatus();
    };

    // --- Save states ----------------------------------------------------------------
    const currentSession = (): Session => {
      if (!current) throw new Error('Insert a cartridge first.');
      return {
        machine: machine.saveState(),
        rom: current.image,
        romName: current.fileName,
        cfg: current.cfg,
        title: current.title,
      };
    };
    const restoreSession = async (session: Session) => {
      if (!machine.romsLoaded) throw new Error('Load the system ROMs first.');
      insertImage(session.rom, session.romName, session.cfg, session.title);
      machine.loadState(session.machine);
      emulator.restored();
      toolbar.showTv(machine.tv);
      audio?.flush();
      updateStatus();
    };
    const updateCanSave = () => toolbar.setCanSave(current !== null && machine.romsLoaded);

    // --- Panels ---------------------------------------------------------------------
    const cartPanel = new CartPanel(requireElement('#cart-panel'), {
      onFile: async (game: GameFile) => {
        const games = await filesFrom(game.file);
        const fromZip = games[0].file !== game.file;
        const chosen = games[0];
        if (fromZip) cartPanel.setZipFiles(games, chosen.file.name);
        else if (cartPanel.zipContents.includes(game)) cartPanel.setZipFiles(cartPanel.zipContents, game.file.name);
        else cartPanel.setZipFiles([], null);
        const picked = cartPanel.zipContents.includes(game) ? game : chosen;
        const media = await readMedia(picked);
        if (media.kind === 'state') {
          await restoreSession(await decodeSession(media.bytes));
          toolbar.showMessage('Save state loaded');
          return;
        }
        if (SYSTEM_ROM_CRCS.has(crc32(media.image))) {
          await addRom(picked.file.name, media.image);
          return;
        }
        if (!machine.romsLoaded) throw new Error('The console needs its EXEC and GROM before it can play a cartridge.');
        const bundled = bundledGames.find((entry) => entry.file === picked.file.name);
        const label = fromZip ? `${picked.file.name} from ${game.file.name}` : picked.file.name;
        insertImage(media.image, label, media.cfg, bundled?.title);
      },
      onGame: (index) => fetchGame(import.meta.env.BASE_URL, bundledGames[index]),
      onEject: eject,
      onAddVoice: () => void openRomSetup(true),
      focusScreen,
    });

    let bundledGames: BundledGame[] = [];
    void loadGameManifest(import.meta.env.BASE_URL).then((games) => {
      bundledGames = games;
      const href = (link?: string) => (link?.startsWith('games/') ? `${import.meta.env.BASE_URL}${link}` : link);
      cartPanel.setGames(games.map((game) => ({ ...game, licenseHref: href(game.licenseUrl), sourceHref: href(game.sourceUrl) })));
    });

    const refreshStates = async () => toolbar.setStates(await saveStates.list());
    const toolbar = attachToolbar(requireElement('#toolbar'), {
      onPause: (pause) => {
        paused = pause;
        screenFrame.classList.toggle('paused', pause);
        emulator.resetTiming();
        audio?.flush();
      },
      onReset: () => machine.pressReset(),
      onPowerCycle: () => {
        machine.reset();
        audio?.flush();
      },
      onFullscreen: () => {
        if (document.fullscreenElement) {
          void document.exitFullscreen();
          return;
        }
        void screenFrame.requestFullscreen().then(focusScreen);
      },
      onTv: (tv) => {
        emulator.setTv(tv);
        updateStatus();
      },
      onSaveState: async () => {
        const session = currentSession();
        await saveStates.add(session.title, session);
        await refreshStates();
        toolbar.showMessage('State saved');
      },
      onLoadState: async (id) => {
        const session = await saveStates.load(id);
        if (!session) throw new Error('That save state no longer exists.');
        await restoreSession(session);
        toolbar.showMessage('State loaded');
      },
      onDeleteState: async (id) => {
        await saveStates.delete(id);
        await refreshStates();
      },
      onExportState: async () => {
        const session = currentSession();
        downloadFile(await encodeSession(session), `${slug(session.title)}${STATE_EXTENSION}`);
      },
      onImportState: async (file) => {
        await restoreSession(await decodeSession(new Uint8Array(await file.arrayBuffer())));
        toolbar.showMessage('Save state loaded');
      },
      focusScreen,
    });
    await refreshStates();

    // --- Inputs ---------------------------------------------------------------------
    const [player1, player2] = machine.controllers.inputs;
    new KeyboardInput(player1, { onPause: () => toolbar.setPaused(!toolbar.paused) }).attach(window);
    const gamepads = new GamepadManager();
    gamepads.attach(window);
    const gamepadStatus = requireElement<HTMLElement>('.gamepad-status');

    const keypadRoot = requireElement<HTMLElement>('#keypad');
    const keypad = new OnScreenKeypad(keypadRoot, player1, focusScreen);
    const showKeypad = requireElement<HTMLInputElement>('input[name="show-keypad"]');
    const keypadPlayer = requireElement<HTMLSelectElement>('select[name="keypad-player"]');
    const applyKeypad = () => {
      keypadRoot.hidden = !showKeypad.checked;
      keypad.setController(keypadPlayer.value === '1' ? player2 : player1);
    };
    showKeypad.addEventListener('change', applyKeypad);
    keypadPlayer.addEventListener('change', applyKeypad);
    applyKeypad();

    const sound = requireElement<HTMLInputElement>('input[name="sound"]');
    const volume = requireElement<HTMLInputElement>('input[name="volume"]');
    const soundHint = requireElement<HTMLElement>('.sound-hint');
    const applySound = () => {
      audio?.setEnabled(sound.checked);
      audio?.setVolume(Number(volume.value));
    };
    sound.addEventListener('change', applySound);
    volume.addEventListener('input', applySound);
    applySound();
    if (!audio) {
      sound.disabled = volume.disabled = true;
      soundHint.textContent = 'Sound is not supported in this browser';
      soundHint.hidden = false;
    } else if (!audio.running) {
      soundHint.hidden = false;
      audio.resumeOnGesture(window, () => (soundHint.hidden = true));
    }

    // --- Main loop ------------------------------------------------------------------
    let lastPadNames = '';
    const pollGamepads = () => {
      const pads = gamepads.connected();
      for (let player = 0; player < PLAYERS; player++) {
        const pad = pads[player];
        const input = machine.controllers.inputs[player];
        if (pad) input.set('gamepad', readGamepad(pad));
        else input.clear('gamepad');
      }
      const names = pads
        .slice(0, PLAYERS)
        .map((pad, player) => `Player ${player + 1}: ${padName(pad)}`)
        .join(' · ');
      if (names !== lastPadNames) {
        lastPadNames = names;
        gamepadStatus.textContent = names;
      }
    };

    let last = performance.now();
    const frame = (now: number) => {
      const elapsed = Math.min(now - last, MAX_FRAME_MS);
      last = now;
      pollGamepads();
      if (!paused && !choosingRoms) {
        emulator.run(elapsed);
        audio?.play(emulator.takeAudioSamples());
      }
      screen.present();
      requestAnimationFrame(frame);
    };

    requireElement<HTMLButtonElement>('#toolbar [data-action="change-roms"]').addEventListener('click', () => {
      void openRomSetup(true);
    });

    const storedRoms = await romStore.load().catch(() => ({}));
    useRoms(storedRoms);
    cartPanel.showEmpty();
    focusScreen();
    requestAnimationFrame(frame);
    if (!machine.romsLoaded) await openRomSetup(false);
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : String(error);
    throw error;
  }
}

void main();
