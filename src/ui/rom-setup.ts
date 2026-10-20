import { isZip, readZip } from '../cart/zip';
import {
  ROM_KINDS,
  hasRequiredRoms,
  identifyRom,
  isRomSize,
  type IdentifiedRom,
  type SystemRomStore,
  type SystemRoms,
} from '../roms/system-roms';

/** The ROM-sized files in a zip, skipping macOS metadata. */
async function romsInZip(data: Uint8Array): Promise<File[]> {
  const entries = readZip(data).filter((entry) => {
    const base = entry.name.split('/').pop()!;
    return isRomSize(entry.size) && !base.startsWith('.') && !entry.name.startsWith('__MACOSX/');
  });
  return Promise.all(entries.map(async (entry) => new File([new Uint8Array(await entry.read())], entry.name)));
}

export interface RomSetupOptions {
  /** Opened from a running console: offers Back (resolves null) and restarts rather than starts. */
  whileRunning?: boolean;
}

/**
 * Shows the ROM setup panel in place of the screen until the required ROMs are
 * loaded and the user presses Start. Resolves with the ROMs to use, or null if
 * the user went back to the running console instead.
 */
export function askForRoms(
  root: HTMLElement,
  store: SystemRomStore,
  initial: SystemRoms,
  options: RomSetupOptions = {},
): Promise<SystemRoms | null> {
  const query = <T extends HTMLElement>(selector: string) => {
    const element = root.querySelector<T>(selector);
    if (!element) throw new Error(`ROM setup is missing ${selector}`);
    return element;
  };
  const fileInput = query<HTMLInputElement>('input[type="file"]');
  const startButton = query<HTMLButtonElement>('[data-action="start"]');
  const backButton = query<HTMLButtonElement>('[data-action="back"]');
  const forgetButton = query<HTMLButtonElement>('[data-action="forget-roms"]');
  const message = query<HTMLElement>('.rom-message');
  const heading = query<HTMLElement>('h1');
  heading.textContent = options.whileRunning ? 'Change the Intellivision system ROMs' : 'First, load the Intellivision system ROMs';
  startButton.textContent = options.whileRunning ? 'Restart with these ROMs' : 'Switch the console on';
  backButton.hidden = !options.whileRunning;
  message.textContent = '';
  const roms: SystemRoms = { ...initial };
  const warnings = new Map<string, string>();
  const listeners = new AbortController();

  const render = () => {
    for (const kind of ROM_KINDS) {
      const row = query<HTMLElement>(`[data-rom="${kind}"]`);
      const status = row.querySelector<HTMLElement>('.rom-status')!;
      const rom = roms[kind];
      const warning = warnings.get(kind);
      row.dataset.state = rom ? (warning ? 'warning' : 'loaded') : 'missing';
      const missing = row.classList.contains('optional') ? 'Not loaded (optional)' : 'Not loaded yet';
      status.textContent = rom ? `Loaded: ${rom.name}${warning ? ` (${warning})` : ''}` : missing;
    }
    startButton.disabled = !hasRequiredRoms(roms);
    forgetButton.hidden = !ROM_KINDS.some((kind) => roms[kind]);
  };

  const addFiles = async (files: File[]) => {
    const errors: string[] = [];
    const found: IdentifiedRom[] = [];
    for (const file of files) {
      try {
        const data = new Uint8Array(await file.arrayBuffer());
        if (!isZip(data)) {
          found.push(identifyRom(file.name, data));
          continue;
        }
        const inZip = await romsInZip(data);
        if (inZip.length === 0) errors.push(`${file.name} has no ROM-sized files in it.`);
        for (const entry of inZip) {
          try {
            found.push(identifyRom(entry.name, new Uint8Array(await entry.arrayBuffer())));
          } catch (error) {
            errors.push(error instanceof Error ? error.message : String(error));
          }
        }
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
    for (const rom of found) {
      roms[rom.kind] = rom;
      if (rom.warning) warnings.set(rom.kind, rom.warning);
      else warnings.delete(rom.kind);
      await store.save(rom.kind, rom);
    }
    message.textContent = errors.join(' ');
    render();
  };

  query<HTMLButtonElement>('[data-action="choose-roms"]').addEventListener('click', () => fileInput.click(), {
    signal: listeners.signal,
  });
  fileInput.addEventListener(
    'change',
    () => {
      const files = [...(fileInput.files ?? [])];
      fileInput.value = '';
      void addFiles(files);
    },
    { signal: listeners.signal },
  );
  forgetButton.addEventListener(
    'click',
    () => {
      for (const kind of ROM_KINDS) delete roms[kind];
      warnings.clear();
      message.textContent = '';
      void store.forget().then(render);
    },
    { signal: listeners.signal },
  );

  // Captured and stopped so the cartridge panel's page-wide drop handling doesn't also see ROM files.
  const dragOptions = { signal: listeners.signal, capture: true };
  const hasFiles = (event: DragEvent) => event.dataTransfer?.types.includes('Files') ?? false;
  let dragDepth = 0;
  window.addEventListener(
    'dragenter',
    (event) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      dragDepth++;
      root.classList.add('drag-over');
    },
    dragOptions,
  );
  window.addEventListener(
    'dragover',
    (event) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    },
    dragOptions,
  );
  window.addEventListener(
    'dragleave',
    (event) => {
      if (!hasFiles(event)) return;
      event.stopImmediatePropagation();
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) root.classList.remove('drag-over');
    },
    dragOptions,
  );
  window.addEventListener(
    'drop',
    (event) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      dragDepth = 0;
      root.classList.remove('drag-over');
      void addFiles([...(event.dataTransfer?.files ?? [])]);
    },
    dragOptions,
  );

  document.body.classList.add('needs-roms');
  root.hidden = false;
  render();
  root.scrollIntoView({ block: 'start' });

  return new Promise((resolve) => {
    const close = (result: SystemRoms | null) => {
      listeners.abort();
      root.hidden = true;
      document.body.classList.remove('needs-roms');
      resolve(result);
    };
    startButton.addEventListener('click', () => close(roms), { signal: listeners.signal });
    backButton.addEventListener('click', () => close(null), { signal: listeners.signal });
  });
}
