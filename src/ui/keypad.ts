import { KEYPAD_KEYS, NO_DIRECTION, discFromVector, keyBit, type ControllerInput, type KeypadKey } from '../io/controllers';

type Action = 'top' | 'lowerLeft' | 'lowerRight';
const SOURCE = 'screen-keypad';
const KEY_LABELS: Partial<Record<KeypadKey, string>> = { clear: 'Clear', enter: 'Enter' };
const ACTIONS: [Action, string][] = [
  ['top', 'Top'],
  ['lowerLeft', 'Lower left'],
  ['lowerRight', 'Lower right'],
];
/** The middle of the disc, as a fraction of its radius, presses nothing. */
const DEAD_ZONE = 0.25;

/**
 * A clickable (and touchable) hand controller: the disc, the 12-key keypad
 * and the action buttons. It presses keys on one player's controller, chosen
 * with `setController`.
 */
export class OnScreenKeypad {
  private readonly held = new Set<KeypadKey | Action>();
  private disc = NO_DIRECTION;
  private controller: ControllerInput;

  constructor(
    root: HTMLElement,
    controller: ControllerInput,
    private readonly focusScreen: () => void,
  ) {
    this.controller = controller;
    const keys = root.querySelector<HTMLElement>('.keypad-keys');
    if (!keys) throw new Error('Keypad is missing .keypad-keys');
    keys.replaceChildren(...KEYPAD_KEYS.map((key) => this.button(key, KEY_LABELS[key] ?? key)));
    root.querySelector<HTMLElement>('.keypad-sides')?.replaceChildren(...ACTIONS.map(([action, label]) => this.button(action, label)));
    const disc = root.querySelector<HTMLElement>('.keypad-disc');
    if (disc) this.attachDisc(disc);
  }

  /** Moves the keypad to another player's controller. */
  setController(controller: ControllerInput): void {
    this.controller.clear(SOURCE);
    this.controller = controller;
    this.update();
  }

  private button(control: KeypadKey | Action, label: string): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.dataset.key = control;
    const set = (down: boolean) => {
      if (this.held.has(control) === down) return;
      if (down) this.held.add(control);
      else this.held.delete(control);
      button.classList.toggle('active', down);
      this.update();
    };
    button.addEventListener('pointerdown', (event) => {
      button.setPointerCapture(event.pointerId);
      event.preventDefault();
      set(true);
    });
    const release = () => {
      set(false);
      this.focusScreen();
    };
    button.addEventListener('pointerup', release);
    button.addEventListener('pointercancel', release);
    button.addEventListener('lostpointercapture', () => set(false));
    return button;
  }

  /** The disc presses the direction from its middle to the pointer, in 16 steps. */
  private attachDisc(disc: HTMLElement): void {
    const knob = disc.querySelector<HTMLElement>('.keypad-disc-knob');
    const point = (event: PointerEvent) => {
      const box = disc.getBoundingClientRect();
      const radius = box.width / 2;
      const x = (event.clientX - box.left - radius) / radius;
      const y = (radius - (event.clientY - box.top)) / radius;
      this.disc = Math.hypot(x, y) < DEAD_ZONE ? NO_DIRECTION : discFromVector(x, y);
      if (knob) {
        const angle = (this.disc * Math.PI) / 8;
        const reach = this.disc === NO_DIRECTION ? 0 : 30;
        knob.style.transform = `translate(${Math.sin(angle) * reach}%, ${-Math.cos(angle) * reach}%)`;
      }
      this.update();
    };
    const release = () => {
      this.disc = NO_DIRECTION;
      if (knob) knob.style.transform = '';
      this.update();
      this.focusScreen();
    };
    disc.addEventListener('pointerdown', (event) => {
      disc.setPointerCapture(event.pointerId);
      event.preventDefault();
      point(event);
    });
    disc.addEventListener('pointermove', (event) => {
      if (disc.hasPointerCapture(event.pointerId)) point(event);
    });
    disc.addEventListener('pointerup', release);
    disc.addEventListener('pointercancel', release);
  }

  private update(): void {
    let keys = 0;
    for (const control of this.held) {
      if ((KEYPAD_KEYS as readonly string[]).includes(control)) keys |= keyBit(control as KeypadKey);
    }
    this.controller.set(SOURCE, {
      disc: this.disc,
      keys,
      top: this.held.has('top'),
      lowerLeft: this.held.has('lowerLeft'),
      lowerRight: this.held.has('lowerRight'),
    });
  }
}
