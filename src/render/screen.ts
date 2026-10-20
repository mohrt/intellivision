import { PALETTE } from '../stic/palette';
import { FRAME_HEIGHT, FRAME_WIDTH } from '../stic/stic';

/**
 * Each STIC pixel is one colour-burst clock wide (3.58 MHz) and each frame
 * line one scanline tall, which on a 4:3 TV makes a pixel about 1.7 times as
 * wide as a line is tall.
 */
export const PIXEL_ASPECT = 1.7;
export const SCREEN_ASPECT = (FRAME_WIDTH * PIXEL_ASPECT) / FRAME_HEIGHT;

/** Turns finished STIC frames (colour indexes) into canvas pixels. */
export class Screen {
  private readonly context: CanvasRenderingContext2D;
  private readonly image: ImageData;
  private readonly pixels: Uint32Array;
  private hasNewFrame = false;

  constructor(canvas: HTMLCanvasElement) {
    canvas.width = FRAME_WIDTH;
    canvas.height = FRAME_HEIGHT;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas 2D context is not available');
    this.context = context;
    this.image = context.createImageData(FRAME_WIDTH, FRAME_HEIGHT);
    this.pixels = new Uint32Array(this.image.data.buffer);
  }

  capture(frame: Uint8Array): void {
    const { pixels } = this;
    for (let i = 0; i < pixels.length; i++) pixels[i] = PALETTE[frame[i]];
    this.hasNewFrame = true;
  }

  /** TV snow, shown while the console can't run (no system ROMs yet). */
  showSnow(): void {
    const { pixels } = this;
    for (let i = 0; i < pixels.length; i++) {
      const level = (Math.random() * 200) | 0;
      pixels[i] = (0xff000000 | (level << 16) | (level << 8) | level) >>> 0;
    }
    this.hasNewFrame = true;
  }

  present(): void {
    if (!this.hasNewFrame) return;
    this.context.putImageData(this.image, 0, 0);
    this.hasNewFrame = false;
  }
}
