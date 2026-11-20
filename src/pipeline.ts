import type { FrameSource } from './camera';
import { PhoneTracker, type Verdict } from './detect/tracker';
import type { PhoneBox, YoloSegDetector } from './detect/yoloSeg';
import type { Effect, PickedPhone } from './effects/types';
import { AlphaCanvas } from './mask/alphaCanvas';
import { MaskStabilizer, type StableMask } from './mask/stabilizer';
import type { Settings } from './settings';
import { makeCanvas, type CanvasPair, type Rect } from './types';

export interface PipelineStats {
  /** Completed detect → mask → fill cycles per second (the rate at which the fill updates). */
  pipelineFps: number;
  /** Whole detection step: preprocessing + inference + mask decoding. */
  detectMs: number;
  inferMs: number;
  maskMs: number;
  /** Time spent in the effect (inpainting, or cutting out in grow mode). 0 while no phone is visible. */
  effectMs: number;
  /** Objects erased in the last frame, and the best phone score among them. */
  phones: number;
  bestScore: number;
  /** What the tracker is watching, e.g. "#4 watching 1.2/1.5 s · 80 %", erased first. */
  objects: string[];
  /** The strongest look-alike turned away by the top-category check, e.g. "book 0.80 (phone 0.31)". */
  rejected: string;
  held: boolean;
}

export interface Snapshot {
  before: HTMLCanvasElement;
  after: HTMLCanvasElement;
}

const smooth = (prev: number, next: number) => (prev === 0 ? next : prev + 0.15 * (next - prev));

/**
 * camera frame → detector → mask stabiliser → effect, on its own asynchronous loop.
 * The display loop (main.ts) calls render() at screen rate and always gets the newest result.
 */
export class Pipeline {
  readonly width: number;
  readonly height: number;
  readonly stats: PipelineStats = {
    pipelineFps: 0,
    detectMs: 0,
    inferMs: 0,
    maskMs: 0,
    effectMs: 0,
    phones: 0,
    bestScore: 0,
    objects: [],
    rejected: '',
    held: false,
  };
  /** Set to see the context window in the mask overlay. */
  debugRect: () => Rect | null = () => null;
  /** Watches each phone-like object before deciding to erase it. */
  readonly tracker = new PhoneTracker();

  private frames: [CanvasPair, CanvasPair];
  private front = 0;
  private stabilizer: MaskStabilizer;
  private alphaCanvas: AlphaCanvas;
  private maskViz: CanvasPair;
  /** This frame's phone-like objects and what the tracker decided about each (mask overlay). */
  private seen: { box: PhoneBox; verdict: Verdict }[] = [];
  private mask: StableMask | null = null;
  private running = false;
  private tickMs = 60;
  private lastTick = 0;
  private snapshotWaiters: ((s: Snapshot) => void)[] = [];

  constructor(
    private source: FrameSource,
    private detector: YoloSegDetector,
    private effect: Effect,
    private settings: Settings,
  ) {
    this.width = source.width;
    this.height = source.height;
    this.frames = [makeCanvas(this.width, this.height, true), makeCanvas(this.width, this.height, true)];
    this.stabilizer = new MaskStabilizer(this.width, this.height);
    this.alphaCanvas = new AlphaCanvas(this.width, this.height);
    this.maskViz = makeCanvas(this.width, this.height);
  }

  /** The effect in use. */
  get activeEffect(): Effect {
    return this.effect;
  }

  /** Switch effect (mode). The new one starts from nothing; the next processed frame feeds it. */
  setEffect(effect: Effect): void {
    if (effect === this.effect) return;
    this.effect.deactivate?.();
    effect.reset();
    this.effect = effect;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.loop();
  }

  stop(): void {
    this.running = false;
  }

  private async loop(): Promise<void> {
    while (this.running) {
      await this.source.nextFrame();
      try {
        await this.tick();
      } catch (err) {
        // One bad frame must not end the show: log it, breathe, carry on.
        console.error('[pipeline] frame failed', err);
        await new Promise((r) => setTimeout(r, 200));
      }
    }
  }

  private async tick(): Promise<void> {
    const s = this.settings;
    const { width, height } = this;
    const back = this.front ^ 1;
    const frame = this.frames[back];
    frame.ctx.drawImage(this.source.element, 0, 0, width, height);
    // Held for the whole frame, in case the mode is switched while this frame is being worked on.
    const effect = this.effect;
    const watchMs = effect.watchMs?.(s) ?? s.watchMs;

    // Every object that looks even slightly like a phone (half the threshold) goes to the
    // tracker; only the ones it has decided on are erased.
    let verdicts: Verdict[] = [];
    const det = await this.detector.detect(frame.canvas, width, height, {
      conf: s.confidence,
      floor: Math.max(0.05, s.confidence * 0.5),
      topClassOnly: s.topClassOnly,
      soft: !!effect.needsPhoneAlpha,
      person: !!effect.needsPersonAlpha?.(s),
      choose: (seen) => {
        verdicts = this.tracker.update(seen, performance.now(), { conf: s.confidence, watchMs, share: s.watchShare });
        return verdicts.map((v) => v.erase);
      },
    });

    const t0 = performance.now();
    const mask = this.stabilizer.update(det.boxes.length ? det.mask : null, det.bounds, {
      dilate: s.dilate,
      feather: s.feather,
      holdFrames: s.holdFrames,
      persistFrames: Math.max(1, Math.round(s.persistMs / this.tickMs)),
    });
    this.alphaCanvas.write(mask);
    const maskMs = performance.now() - t0;

    this.seen = det.seen.map((box, i) => ({ box, verdict: verdicts[i] }));
    this.mask = mask;
    if (s.showMask) this.drawMaskViz();

    // The decided-on objects, in the detector's order (the same as det.boxes), with their ids.
    const phones: PickedPhone[] = [];
    det.seen.forEach((box, i) => {
      const v = verdicts[i];
      if (v?.erase) phones.push({ ...box, id: v.id, erasedMs: v.erasedMs });
    });
    const f = {
      frame: frame.canvas,
      width,
      height,
      mask,
      maskCanvas: this.alphaCanvas.canvas,
      phoneAlpha: det.boxes.length ? det.soft : null,
      personAlpha: det.boxes.length ? det.person : null,
      phones,
      settings: s,
    };
    effect.onMask(f);
    const t1 = performance.now();
    await effect.process(f);
    const effectMs = mask.present ? performance.now() - t1 : 0;

    this.front = back;

    const now = performance.now();
    if (this.lastTick) this.tickMs = smooth(this.tickMs, now - this.lastTick);
    this.lastTick = now;
    const st = this.stats;
    st.pipelineFps = 1000 / this.tickMs;
    st.detectMs = smooth(st.detectMs, det.preMs + det.inferMs + det.postMs);
    st.inferMs = smooth(st.inferMs, det.inferMs);
    st.maskMs = smooth(st.maskMs, maskMs);
    st.effectMs = mask.present ? smooth(st.effectMs, effectMs) : 0;
    st.phones = det.boxes.length;
    st.bestScore = det.boxes.reduce((m, b) => Math.max(m, b.score), 0);
    st.objects = this.tracker.summary(now, watchMs);
    const r = det.rejected[0];
    st.rejected = r ? `${r.top.name} ${r.top.score.toFixed(2)} (phone ${r.score.toFixed(2)})` : '';
    st.held = mask.held;

    if (this.snapshotWaiters.length) {
      const snap = this.takeSnapshot();
      for (const resolve of this.snapshotWaiters.splice(0)) resolve(snap);
    }
  }

  /** Draw the current view. `ctx` must be width × height; mirroring is applied here. */
  render(ctx: CanvasRenderingContext2D, overlay = true): void {
    const s = this.settings;
    ctx.save();
    if (s.mirror) ctx.setTransform(-1, 0, 0, 1, this.width, 0);
    const base = s.syncDisplay ? this.frames[this.front].canvas : this.source.element;
    ctx.drawImage(base, 0, 0, this.width, this.height);
    this.effect.render(ctx);
    // overlay = false: the picture without the mask overlay (screen recording).
    if (s.showMask && overlay) this.drawDebug(ctx);
    ctx.restore();
  }

  /** Before/after of the same camera frame, taken at the end of the next processed frame. */
  snapshot(): Promise<Snapshot> {
    return new Promise((resolve) => this.snapshotWaiters.push(resolve));
  }

  private takeSnapshot(): Snapshot {
    const draw = (withEffect: boolean) => {
      const { canvas, ctx } = makeCanvas(this.width, this.height);
      if (this.settings.mirror) ctx.setTransform(-1, 0, 0, 1, this.width, 0);
      ctx.drawImage(this.frames[this.front].canvas, 0, 0);
      if (withEffect) this.effect.render(ctx, true);
      return canvas;
    };
    return { before: draw(false), after: draw(true) };
  }

  private drawMaskViz(): void {
    const { ctx } = this.maskViz;
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#ff00c8';
    ctx.fillRect(0, 0, this.width, this.height);
    ctx.globalCompositeOperation = 'destination-in';
    ctx.drawImage(this.alphaCanvas.canvas, 0, 0);
  }

  private drawDebug(ctx: CanvasRenderingContext2D): void {
    if (this.mask?.present) {
      ctx.globalAlpha = 0.45;
      ctx.drawImage(this.maskViz.canvas, 0, 0);
      ctx.globalAlpha = 1;
      const r = this.debugRect();
      if (r) {
        ctx.strokeStyle = '#00e5ff';
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);
        ctx.strokeRect(r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1);
        ctx.setLineDash([]);
      }
    }
    // Erased objects in yellow; objects being watched in orange, dashed; decided against in grey.
    ctx.lineWidth = 1.5;
    ctx.font = '11px ui-monospace, Menlo, monospace';
    const watchMs = this.effect.watchMs?.(this.settings) ?? this.settings.watchMs;
    for (const { box: b, verdict: v } of this.seen) {
      if (!v) continue;
      const pct = `${Math.round(v.share * 100)}%`;
      const watching = !v.erase && v.ageMs < watchMs;
      const colour = v.erase ? '#ffe600' : watching ? '#ff9100' : '#9e9e9e';
      const label = v.erase
        ? `${b.score.toFixed(2)} · ${pct}`
        : watching
          ? `watching ${(v.ageMs / 1000).toFixed(1)} s · ${pct}`
          : `not erased · ${pct}`;
      ctx.strokeStyle = colour;
      ctx.fillStyle = colour;
      ctx.setLineDash(v.erase ? [] : [5, 4]);
      ctx.strokeRect(b.x1, b.y1, b.x2 - b.x1, b.y2 - b.y1);
      ctx.setLineDash([]);
      // Text would come out reversed under the mirror transform, so un-flip it locally.
      ctx.save();
      if (this.settings.mirror) {
        ctx.translate(b.x2, b.y1 - 4);
        ctx.scale(-1, 1);
        ctx.fillText(label, 0, 0);
      } else {
        ctx.fillText(label, b.x1, b.y1 - 4);
      }
      ctx.restore();
    }
  }
}
