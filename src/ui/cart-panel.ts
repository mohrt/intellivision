import type { GameFile } from '../cart/load';

export interface GameListing {
  title: string;
  credit?: string;
  license?: string;
  licenseHref?: string;
  sourceHref?: string;
  hint?: string;
}

export interface CartPanelCallbacks {
  /** A file was dropped or chosen (a cartridge image, a zip, a save state, or a system ROM). */
  onFile(file: GameFile): Promise<void>;
  /** Downloads one of the free games. */
  onGame(index: number): Promise<File>;
  onEject(): void;
  /** Opens the system ROM setup to add the Intellivoice's ROM. */
  onAddVoice(): void;
  focusScreen(): void;
}

function requireChild<T extends Element>(root: Element, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error(`Cartridge panel is missing ${selector}`);
  return element;
}

/** The cartridge slot: drop or choose files, pick from a zip or the free games. */
export class CartPanel {
  private readonly fileInput: HTMLInputElement;
  private readonly message: HTMLElement;
  private readonly zipFiles: HTMLElement;
  private readonly zipButtons: HTMLElement;
  private readonly gamePicker: HTMLSelectElement;
  private readonly gameInfo: HTMLElement;
  private games: GameListing[] = [];
  private zipChoices: GameFile[] = [];

  constructor(
    private readonly root: HTMLElement,
    private readonly callbacks: CartPanelCallbacks,
  ) {
    this.fileInput = requireChild(root, 'input[name="cart-file"]');
    this.message = requireChild(root, '.cart-message');
    this.zipFiles = requireChild(root, '.zip-files');
    this.zipButtons = requireChild(root, '.zip-buttons');
    this.gamePicker = requireChild(root, 'select[name="bundled-game"]');
    this.gameInfo = requireChild(root, '.game-info');
    this.gamePicker.addEventListener('change', () => this.showGameInfo());
    requireChild<HTMLButtonElement>(root, '[data-action="play-game"]').addEventListener('click', () => {
      const index = Number(this.gamePicker.value);
      this.run(async () => this.callbacks.onFile({ file: await this.callbacks.onGame(index) }));
    });

    root.querySelectorAll<HTMLButtonElement>('[data-action="choose"]').forEach((button) =>
      button.addEventListener('click', () => this.fileInput.click()),
    );
    this.fileInput.addEventListener('change', () => {
      const file = this.fileInput.files?.[0];
      this.fileInput.value = '';
      if (file) this.run(() => this.callbacks.onFile({ file }));
    });
    requireChild<HTMLButtonElement>(root, '[data-action="eject"]').addEventListener('click', () => {
      this.callbacks.onEject();
      this.callbacks.focusScreen();
    });
    requireChild<HTMLButtonElement>(root, '[data-action="add-voice"]').addEventListener('click', () => this.callbacks.onAddVoice());
    this.attachDragAndDrop();
  }

  /** Files can be dropped anywhere on the page. */
  private attachDragAndDrop(): void {
    let depth = 0;
    const hasFiles = (event: DragEvent) => event.dataTransfer?.types.includes('Files') ?? false;
    document.addEventListener('dragenter', (event) => {
      if (!hasFiles(event)) return;
      depth++;
      this.root.classList.add('drag-over');
    });
    document.addEventListener('dragleave', () => {
      depth = Math.max(0, depth - 1);
      if (depth === 0) this.root.classList.remove('drag-over');
    });
    document.addEventListener('dragover', (event) => {
      if (hasFiles(event)) event.preventDefault();
    });
    document.addEventListener('drop', (event) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      depth = 0;
      this.root.classList.remove('drag-over');
      const file = event.dataTransfer?.files[0];
      if (file) this.run(() => this.callbacks.onFile({ file }));
    });
  }

  private run(action: () => Promise<void>): void {
    this.showMessage('');
    action()
      .catch((error: unknown) => this.showMessage(error instanceof Error ? error.message : String(error)))
      .finally(() => this.callbacks.focusScreen());
  }

  showMessage(text: string, isWarning = false): void {
    this.message.textContent = text;
    this.message.classList.toggle('warning', isWarning);
  }

  /** Shows the cartridge in the slot: its title, file and where it sits in memory. */
  showCartridge(title: string, fileLabel: string, details: string): void {
    this.root.dataset.state = 'loaded';
    requireChild(this.root, '.cart-name').textContent = title;
    requireChild(this.root, '.cart-file').textContent = fileLabel === title ? '' : `(${fileLabel})`;
    requireChild(this.root, '.cart-details').textContent = details;
  }

  showEmpty(): void {
    this.root.dataset.state = 'empty';
    this.setZipFiles([], null);
    this.showVoicePrompt(false);
  }

  /** Offers the Intellivoice ROM for a game that talks. */
  showVoicePrompt(show: boolean): void {
    requireChild<HTMLElement>(this.root, '.voice-prompt').hidden = !show;
  }

  /** Whether the console has its system ROMs (without them, the slot is hidden). */
  showRoms(loaded: boolean): void {
    this.root.dataset.roms = loaded ? 'loaded' : 'missing';
  }

  /** Buttons for the other cartridge images in a zip. */
  setZipFiles(files: GameFile[], current: string | null): void {
    this.zipChoices = files;
    this.zipFiles.hidden = files.length < 2;
    this.zipButtons.replaceChildren(
      ...files.map((game) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = game.file.name;
        button.classList.toggle('current', game.file.name === current);
        button.addEventListener('click', () => this.run(() => this.callbacks.onFile(game)));
        return button;
      }),
    );
  }

  get zipContents(): GameFile[] {
    return this.zipChoices;
  }

  setGames(games: GameListing[]): void {
    this.games = games;
    requireChild<HTMLElement>(this.root, '.bundled-games').hidden = games.length === 0;
    this.gamePicker.replaceChildren(
      ...games.map((game, index) => {
        const option = document.createElement('option');
        option.value = String(index);
        option.textContent = game.title;
        return option;
      }),
    );
    this.showGameInfo();
  }

  private showGameInfo(): void {
    const game = this.games[Number(this.gamePicker.value)];
    this.gameInfo.replaceChildren();
    if (!game) return;
    const link = (href: string, text: string) => {
      const anchor = document.createElement('a');
      anchor.href = href;
      anchor.target = '_blank';
      anchor.rel = 'noopener';
      anchor.textContent = text;
      return anchor;
    };
    const parts: (string | Node)[] = [];
    if (game.credit) parts.push(game.credit);
    if (game.license) parts.push(game.licenseHref ? link(game.licenseHref, game.license) : game.license);
    if (game.sourceHref) parts.push(link(game.sourceHref, 'source'));
    if (game.hint) parts.push(game.hint);
    parts.forEach((part, i) => {
      if (i > 0) this.gameInfo.append(' · ');
      this.gameInfo.append(part);
    });
  }
}
