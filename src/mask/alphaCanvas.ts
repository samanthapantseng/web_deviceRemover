import { makeCanvas, type CanvasPair, type Rect } from '../types';
import type { StableMask } from './stabilizer';

/**
 * The stabilised mask as a canvas whose alpha channel is the mask (RGB is black). Drawing
 * it with `destination-in` cuts anything down to the feathered phone shape.
 */
export class AlphaCanvas {
  private pair: CanvasPair;
  private image: ImageData;
  private roi: Rect | null = null;

  constructor(
    private width: number,
    height: number,
  ) {
    this.pair = makeCanvas(width, height, true);
    this.image = new ImageData(width, height);
  }

  get canvas(): HTMLCanvasElement {
    return this.pair.canvas;
  }

  write(mask: StableMask): void {
    const px = this.image.data;
    const { ctx } = this.pair;
    const old = this.roi;
    if (old) {
      for (let y = old.y; y < old.y + old.h; y++) {
        const row = y * this.width;
        for (let x = old.x; x < old.x + old.w; x++) px[(row + x) * 4 + 3] = 0;
      }
      ctx.clearRect(old.x, old.y, old.w, old.h);
      this.roi = null;
    }
    if (!mask.present) return;
    const r = mask.roi;
    for (let y = r.y; y < r.y + r.h; y++) {
      const row = y * this.width;
      for (let x = r.x; x < r.x + r.w; x++) px[(row + x) * 4 + 3] = mask.alpha[row + x];
    }
    ctx.putImageData(this.image, 0, 0, r.x, r.y, r.w, r.h);
    this.roi = { ...r };
  }
}
