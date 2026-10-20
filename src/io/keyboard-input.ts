import { discFromDirections, keyBit, type ControllerInput, type KeypadKey } from './controllers';

const UP = new Set(['ArrowUp']);
const DOWN = new Set(['ArrowDown']);
const LEFT = new Set(['ArrowLeft']);
const RIGHT = new Set(['ArrowRight']);
const TOP_KEYS = new Set(['Space', 'KeyZ']);
const LOWER_LEFT_KEYS = new Set(['KeyX']);
const LOWER_RIGHT_KEYS = new Set(['KeyC']);
const KEYPAD_CODES: Record<string, KeypadKey> = {
  Minus: 'clear',
  Backspace: 'clear',
  NumpadDecimal: 'clear',
  Equal: 'enter',
  Enter: 'enter',
  NumpadEnter: 'enter',
};
for (let digit = 0; digit <= 9; digit++) {
  KEYPAD_CODES[`Digit${digit}`] = String(digit) as KeypadKey;
  KEYPAD_CODES[`Numpad${digit}`] = String(digit) as KeypadKey;
}
const PAUSE_KEYS = new Set(['Pause', 'KeyP']);
const GAME_KEYS = [UP, DOWN, LEFT, RIGHT, TOP_KEYS, LOWER_LEFT_KEYS, LOWER_RIGHT_KEYS];

export interface KeyboardCallbacks {
  onPause(): void;
}

/** True when a key press belongs to a form field rather than the game. */
function typingInField(event: KeyboardEvent): boolean {
  const target = event.target as HTMLElement | null;
  return !!target && (target.isContentEditable || ['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName));
}

/**
 * Player 1 on the keyboard: the arrows for the disc, Space or Z for the top
 * action buttons, X and C for the lower left and right ones, and the number
 * keys for the keypad, with - (or Backspace) for Clear and = (or Enter) for Enter.
 */
export class KeyboardInput {
  private readonly held = new Set<string>();

  constructor(
    private readonly controller: ControllerInput,
    private readonly callbacks: KeyboardCallbacks,
  ) {}

  attach(target: Window): void {
    target.addEventListener('keydown', (event) => this.onKey(event, true));
    target.addEventListener('keyup', (event) => this.onKey(event, false));
    target.addEventListener('blur', () => {
      this.held.clear();
      this.update();
    });
  }

  private onKey(event: KeyboardEvent, down: boolean): void {
    if (down && (event.ctrlKey || event.metaKey || event.altKey || typingInField(event))) return;
    const code = event.code;
    if (PAUSE_KEYS.has(code)) {
      if (down && !event.repeat) this.callbacks.onPause();
      event.preventDefault();
      return;
    }
    if (!GAME_KEYS.some((keys) => keys.has(code)) && !(code in KEYPAD_CODES)) return;
    event.preventDefault();
    if (down) this.held.add(code);
    else this.held.delete(code);
    this.update();
  }

  private update(): void {
    const held = (keys: Set<string>) => [...keys].some((code) => this.held.has(code));
    let keys = 0;
    for (const code of this.held) {
      const key = KEYPAD_CODES[code];
      if (key) keys |= keyBit(key);
    }
    this.controller.set('keyboard', {
      disc: discFromDirections(held(UP), held(RIGHT), held(DOWN), held(LEFT)),
      keys,
      top: held(TOP_KEYS),
      lowerLeft: held(LOWER_LEFT_KEYS),
      lowerRight: held(LOWER_RIGHT_KEYS),
    });
  }
}
