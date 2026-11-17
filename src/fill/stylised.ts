// Stylised fills: not an attempt at realism, but a deliberate mark where the phone was.
//   void  a black hole
//   flat  one colour, the average of what surrounds the phone
//   blur  the surroundings smeared smoothly across the hole ("push-pull" interpolation)
//
// All three are plain 2D-canvas operations: no model, no WASM, nothing to load. That also
// makes this the fill of last resort if everything else fails on the exhibition machine.
import { makeCanvas, type CanvasPair } from '../types';
import { sampleHole, type Fill, type FillJob } from './types';

const SIDE = 128;

export class StylisedFill implements Fill {
  readonly id = 'stylised' as const;
  readonly label = 'Stylised';
  readonly context = 1.6;
  private levels: CanvasPair[] = [];
  private holeCanvas = makeCanvas(SIDE, SIDE, true);
  private holeImage = new ImageData(SIDE, SIDE);
  private holeBytes = new Uint8Array(SIDE * SIDE);
  private out = makeCanvas(SIDE, SIDE);

  constructor() {
    for (let s = SIDE; s >= 1; s >>= 1) this.levels.push(makeCanvas(s, s));
  }

  backend(): string {
    return 'canvas';
  }

  async init(): Promise<void> {}

  async run(job: FillJob): Promise<HTMLCanvasElement> {
    const { rect } = job;
    const out = this.out.ctx;
    out.globalCompositeOperation = 'source-over';

    if (job.settings.style === 'void') {
      out.fillStyle = '#000';
      out.fillRect(0, 0, SIDE, SIDE);
      return this.out.canvas;
    }

    // Level 0: the context window with the hole cut out (transparent).
    sampleHole(job, SIDE, SIDE, this.holeBytes, 255, 0);
    const px = this.holeImage.data;
    for (let i = 0; i < SIDE * SIDE; i++) px[i * 4 + 3] = this.holeBytes[i];
    this.holeCanvas.ctx.putImageData(this.holeImage, 0, 0);
    const top = this.levels[0].ctx;
    top.globalCompositeOperation = 'copy';
    top.drawImage(job.frame, rect.x, rect.y, rect.w, rect.h, 0, 0, SIDE, SIDE);
    top.globalCompositeOperation = 'destination-out';
    top.drawImage(this.holeCanvas.canvas, 0, 0);

    // Push: halve repeatedly. Canvas pixels are premultiplied, so each halving is an
    // alpha-weighted average: transparent (hole) pixels simply don't contribute.
    for (let i = 1; i < this.levels.length; i++) {
      const { canvas, ctx } = this.levels[i];
      ctx.globalCompositeOperation = 'copy';
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(this.levels[i - 1].canvas, 0, 0, canvas.width, canvas.height);
    }

    // The 1×1 level is now the mean colour of everything around the hole, at partial alpha.
    // Stacking it on itself drives alpha to 1 without changing the colour.
    const last = this.levels[this.levels.length - 1];
    last.ctx.globalCompositeOperation = 'source-over';
    for (let i = 0; i < 8; i++) last.ctx.drawImage(last.canvas, 0, 0);

    if (job.settings.style === 'flat') {
      out.imageSmoothingEnabled = false;
      out.drawImage(last.canvas, 0, 0, SIDE, SIDE);
      return this.out.canvas;
    }

    // Pull: from coarse to fine, slide each coarser (already opaque) level underneath the
    // finer one. Wherever the fine level has no data, the coarser estimate shows through.
    for (let i = this.levels.length - 2; i >= 0; i--) {
      const { canvas, ctx } = this.levels[i];
      ctx.globalCompositeOperation = 'destination-over';
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(this.levels[i + 1].canvas, 0, 0, canvas.width, canvas.height);
    }
    out.imageSmoothingEnabled = true;
    out.drawImage(this.levels[0].canvas, 0, 0);
    return this.out.canvas;
  }
}
