import type { FillSet } from '../fill';
import type { Fill } from '../fill/types';
import { CropTracker } from '../mask/cropTracker';
import type { FillId } from '../settings';
import { makeCanvas, sameRect, type CanvasPair, type Rect } from '../types';
import type { Effect, EffectFrame } from './types';

const FADE_OUT_MS = 180;

/**
 * Erases the phone: fills the masked region with one of the selectable fills and blends
 * the result over the camera image through the feathered mask.
 */
export class RemoveEffect implements Effect {
  readonly id = 'remove';
  /** Time the last fill took, ms. */
  fillMs = 0;
  /** Context window used for the last fill (for the debug overlay). */
  rect: Rect | null = null;

  private active: Fill;
  private wanted: FillId = 'stylised';

  private crop: CropTracker;
  /** Latest phone-free pixels, in frame coordinates. Only `memRect` is valid. */
  private mem: CanvasPair;
  private memRect: Rect | null = null;
  private memKey = '';
  /** `mem` cut to the feathered mask: this is what gets drawn over the camera image. */
  private overlay: CanvasPair;
  private maskCanvas: HTMLCanvasElement | null = null;

  private present = false;
  private opacity = 0;
  private lastRender = 0;

  constructor(
    private width: number,
    private height: number,
    private fills: FillSet,
  ) {
    this.active = fills.get('stylised');
    this.crop = new CropTracker(width, height);
    this.mem = makeCanvas(width, height);
    this.overlay = makeCanvas(width, height);
  }

  describe(): string {
    const a = this.active;
    let text = `${a.label} · ${a.backend()}`;
    if (a.id !== this.wanted) {
      const failed = this.fills.state(this.wanted) === 'failed';
      const why = failed ? `failed: ${this.fills.error(this.wanted)}` : 'still loading';
      text += ` (${this.fills.get(this.wanted).label} ${why})`;
    }
    return text;
  }

  onMask(f: EffectFrame): void {
    this.maskCanvas = f.maskCanvas;
    this.present = f.mask.present;
    if (!f.mask.present) {
      // Keep the overlay pixels so render() can fade them out, but forget the fill: when a
      // phone shows up again it must not be painted with stale content.
      this.memRect = null;
      this.crop.reset();
      return;
    }
    // The mask is newer than the fill. Showing the previous fill through the new mask right
    // away keeps the phone covered while the next fill is still being computed. (Not in sync
    // mode, where the overlay must only change together with the displayed frame.)
    if (!f.settings.syncDisplay) this.compose();
  }

  async process(f: EffectFrame): Promise<void> {
    if (!f.mask.present) return;
    this.wanted = f.settings.fill;
    const fill = (this.active = this.fills.resolve(this.wanted));
    const rect = this.crop.update(f.mask.roi, f.settings.cropSize, fill.context);
    const t0 = performance.now();
    const patch = await fill.run({
      frame: f.frame,
      width: f.width,
      height: f.height,
      alpha: f.mask.alpha,
      hole: f.mask.roi,
      rect,
      settings: f.settings,
    });
    this.fillMs = performance.now() - t0;
    this.rect = rect;

    // Temporal smoothing: while the window has not moved, blend the new fill into the old
    // one instead of replacing it. This damps the frame-to-frame shimmer of the inpainter.
    const key = fill.id === 'stylised' ? `stylised:${f.settings.style}` : fill.id;
    const steady = key === this.memKey && sameRect(rect, this.memRect);
    const m = this.mem.ctx;
    m.globalAlpha = steady ? 1 - f.settings.fillSmoothing : 1;
    m.drawImage(patch, 0, 0, patch.width, patch.height, rect.x, rect.y, rect.w, rect.h);
    m.globalAlpha = 1;
    this.memRect = rect;
    this.memKey = key;
    this.compose();
  }

  private compose(): void {
    const o = this.overlay.ctx;
    o.globalCompositeOperation = 'source-over';
    o.clearRect(0, 0, this.width, this.height);
    const r = this.memRect;
    if (!r || !this.maskCanvas) return;
    o.drawImage(this.mem.canvas, r.x, r.y, r.w, r.h, r.x, r.y, r.w, r.h);
    o.globalCompositeOperation = 'destination-in';
    o.drawImage(this.maskCanvas, 0, 0);
    o.globalCompositeOperation = 'source-over';
  }

  render(ctx: CanvasRenderingContext2D, still = false): void {
    const now = performance.now();
    const dt = now - this.lastRender;
    this.lastRender = now;
    if (still) {
      if (this.present) ctx.drawImage(this.overlay.canvas, 0, 0);
      return;
    }
    // Appear at once, disappear with a short fade.
    this.opacity = this.present ? 1 : Math.max(0, this.opacity - dt / FADE_OUT_MS);
    if (this.opacity <= 0) return;
    ctx.globalAlpha = this.opacity;
    ctx.drawImage(this.overlay.canvas, 0, 0);
    ctx.globalAlpha = 1;
  }
}
