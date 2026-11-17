// OpenCV.js inpainting (Telea's fast marching method): quick and smudgy. No GPU needed,
// so this is the fill to fall back on if the neural one misbehaves.
import { makeCanvas } from '../types';
import type { Cv } from './opencv';
import { sampleHole, type Fill, type FillJob } from './types';

/** Longest side of the working image. Telea output is blurry anyway, so there is no point going bigger. */
const MAX_SIDE = 256;
const RADIUS = 4;

export class TeleaFill implements Fill {
  readonly id = 'telea' as const;
  readonly label = 'Telea (OpenCV.js)';
  // Telea only looks a few pixels beyond the hole; a tight window keeps the result sharper.
  readonly context = 1.5;
  private cv: Cv = null;
  private work = makeCanvas(MAX_SIDE, MAX_SIDE, true);
  private maskBytes = new Uint8Array(0);

  backend(): string {
    return this.cv ? 'opencv.js (wasm)' : 'not loaded';
  }

  async init(): Promise<void> {
    const { getOpenCv } = await import('./opencv');
    const { cv } = await getOpenCv();
    if (typeof cv.inpaint !== 'function') throw new Error('This OpenCV.js build has no inpaint()');
    this.cv = cv;
  }

  async run(job: FillJob): Promise<HTMLCanvasElement> {
    const cv = this.cv;
    const { rect } = job;
    const scale = Math.min(1, MAX_SIDE / Math.max(rect.w, rect.h));
    const w = Math.max(8, Math.round(rect.w * scale));
    const h = Math.max(8, Math.round(rect.h * scale));
    const { canvas, ctx } = this.work;
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    ctx.drawImage(job.frame, rect.x, rect.y, rect.w, rect.h, 0, 0, w, h);
    const img = ctx.getImageData(0, 0, w, h);

    if (this.maskBytes.length !== w * h) this.maskBytes = new Uint8Array(w * h);
    sampleHole(job, w, h, this.maskBytes, 255, 0);

    const rgba = cv.matFromImageData(img);
    const rgb = new cv.Mat();
    const mask = new cv.Mat(h, w, cv.CV_8UC1);
    const dst = new cv.Mat();
    try {
      cv.cvtColor(rgba, rgb, cv.COLOR_RGBA2RGB);
      mask.data.set(this.maskBytes);
      cv.inpaint(rgb, mask, dst, RADIUS, cv.INPAINT_TELEA);
      cv.cvtColor(dst, rgba, cv.COLOR_RGB2RGBA);
      img.data.set(rgba.data);
    } finally {
      rgba.delete();
      rgb.delete();
      mask.delete();
      dst.delete();
    }
    ctx.putImageData(img, 0, 0);
    return canvas;
  }
}
