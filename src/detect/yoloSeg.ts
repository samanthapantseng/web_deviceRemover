// YOLO11-seg (Ultralytics, ONNX) phone detector with pixel masks.
//
// Model I/O (verified with scripts/inspect_onnx.py):
//   images   float32 [1, 3, 640, 640]   RGB, 0..1, letterboxed
//   output0  float32 [1, 116, 8400]     per anchor: cx, cy, w, h | 80 class scores | 32 mask coefficients
//   output1  float32 [1, 32, 160, 160]  mask prototypes
// A detection's mask is sigmoid(coefficients · prototypes), cropped to its box and upsampled.
import { createSession, exclusive, feedData, fetchModel, modelUrl, ort, type Backend } from '../runtime/ort';
import { clamp, makeCanvas, type Rect } from '../types';

const SIZE = 640;
const PROTO = 160;
const PROTO_STRIDE = SIZE / PROTO;
const NUM_CLASSES = 80;
const NUM_COEFFS = 32;

export const COCO_CELL_PHONE = 67;

export interface PhoneBox {
  /** Frame pixels. */
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  score: number;
}

export interface DetectOptions {
  /** Minimum score for a detection with no history. */
  conf: number;
  /**
   * Boxes accepted on the previous frame. A candidate overlapping one of these is kept down to
   * half the threshold (hysteresis), so a phone hovering around the threshold does not blink.
   */
  prior?: PhoneBox[];
  classes?: number[];
  maxDetections?: number;
}

export interface Detection {
  boxes: PhoneBox[];
  /** Frame-sized, 1 where any phone is. Reused between calls: read it before the next detect(). */
  mask: Uint8Array;
  /** Bounding box of the mask, or null when it is empty. */
  bounds: Rect | null;
  preMs: number;
  inferMs: number;
  postMs: number;
}

interface Candidate {
  anchor: number;
  score: number;
  // Letterbox pixels.
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

function iou(a: { x1: number; y1: number; x2: number; y2: number }, b: typeof a): number {
  const w = Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1);
  const h = Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1);
  if (w <= 0 || h <= 0) return 0;
  const inter = w * h;
  return inter / ((a.x2 - a.x1) * (a.y2 - a.y1) + (b.x2 - b.x1) * (b.y2 - b.y1) - inter);
}

export class YoloSegDetector {
  backend: Backend = 'wasm';
  private session!: ort.InferenceSession;
  private letterbox = makeCanvas(SIZE, SIZE, true);
  private input = new Float32Array(3 * SIZE * SIZE);
  private mask = new Uint8Array(0);
  private logits = new Float32Array(0);
  private coeffs = new Float32Array(NUM_COEFFS);

  async init(model: string, onProgress?: (fraction: number) => void): Promise<void> {
    const bytes = await fetchModel(modelUrl(`${model}.onnx`), onProgress);
    const loaded = await createSession(bytes);
    this.session = loaded.session;
    this.backend = loaded.backend;
    // First run compiles the GPU shaders; do it now rather than on the first camera frame.
    await this.run();
  }

  private run(): Promise<ort.InferenceSession.OnnxValueMapType> {
    const tensor = new ort.Tensor('float32', feedData(this.input), [1, 3, SIZE, SIZE]);
    return exclusive(() => this.session.run({ images: tensor }));
  }

  async detect(source: CanvasImageSource, width: number, height: number, opts: DetectOptions): Promise<Detection> {
    const t0 = performance.now();

    // Letterbox: scale to fit 640×640, pad with grey (same as Ultralytics preprocessing).
    const scale = Math.min(SIZE / width, SIZE / height);
    const nw = Math.round(width * scale);
    const nh = Math.round(height * scale);
    const padX = (SIZE - nw) >> 1;
    const padY = (SIZE - nh) >> 1;
    const { ctx } = this.letterbox;
    ctx.fillStyle = 'rgb(114,114,114)';
    ctx.fillRect(0, 0, SIZE, SIZE);
    ctx.drawImage(source, 0, 0, width, height, padX, padY, nw, nh);
    const rgba = ctx.getImageData(0, 0, SIZE, SIZE).data;
    const plane = SIZE * SIZE;
    const input = this.input;
    for (let i = 0, p = 0; i < plane; i++, p += 4) {
      input[i] = rgba[p] / 255;
      input[plane + i] = rgba[p + 1] / 255;
      input[2 * plane + i] = rgba[p + 2] / 255;
    }
    const t1 = performance.now();

    const out = await this.run();
    const t2 = performance.now();

    const pred = out.output0.data as Float32Array;
    const anchors = out.output0.dims[2];
    const protos = out.output1.data as Float32Array;

    // Candidates for the wanted classes, at the lower (hysteresis) threshold.
    const classes = opts.classes ?? [COCO_CELL_PHONE];
    const prior = opts.prior ?? [];
    const lowConf = prior.length ? Math.max(0.05, opts.conf * 0.5) : opts.conf;
    const candidates: Candidate[] = [];
    for (const cls of classes) {
      const row = (4 + cls) * anchors;
      for (let i = 0; i < anchors; i++) {
        const score = pred[row + i];
        if (score < lowConf) continue;
        const cx = pred[i];
        const cy = pred[anchors + i];
        const hw = pred[2 * anchors + i] / 2;
        const hh = pred[3 * anchors + i] / 2;
        candidates.push({ anchor: i, score, x1: cx - hw, y1: cy - hh, x2: cx + hw, y2: cy + hh });
      }
    }
    candidates.sort((a, b) => b.score - a.score);

    if (this.mask.length !== width * height) this.mask = new Uint8Array(width * height);
    else this.mask.fill(0);

    // Greedy NMS, hysteresis, then paint each surviving mask.
    const kept: Candidate[] = [];
    const boxes: PhoneBox[] = [];
    const maxDet = opts.maxDetections ?? 4;
    for (const c of candidates) {
      if (kept.length >= maxDet) break;
      if (kept.some((k) => iou(k, c) > 0.5)) continue;
      const box: PhoneBox = {
        x1: clamp((c.x1 - padX) / scale, 0, width),
        y1: clamp((c.y1 - padY) / scale, 0, height),
        x2: clamp((c.x2 - padX) / scale, 0, width),
        y2: clamp((c.y2 - padY) / scale, 0, height),
        score: c.score,
      };
      if (c.score < opts.conf && !prior.some((p) => iou(p, box) > 0.3)) continue;
      kept.push(c);
      boxes.push(box);
      this.paintMask(pred, anchors, protos, c, box, width, height, scale, padX, padY);
    }

    let bounds: Rect | null = null;
    if (boxes.length) {
      let x1 = width;
      let y1 = height;
      let x2 = 0;
      let y2 = 0;
      for (const b of boxes) {
        x1 = Math.min(x1, Math.floor(b.x1));
        y1 = Math.min(y1, Math.floor(b.y1));
        x2 = Math.max(x2, Math.ceil(b.x2));
        y2 = Math.max(y2, Math.ceil(b.y2));
      }
      if (x2 > x1 && y2 > y1) bounds = { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
    }

    const t3 = performance.now();
    return { boxes, mask: this.mask, bounds, preMs: t1 - t0, inferMs: t2 - t1, postMs: t3 - t2 };
  }

  /** Decode one detection's mask straight into the frame-sized mask, inside its box only. */
  private paintMask(
    pred: Float32Array,
    anchors: number,
    protos: Float32Array,
    c: Candidate,
    box: PhoneBox,
    width: number,
    height: number,
    scale: number,
    padX: number,
    padY: number,
  ): void {
    const coeffs = this.coeffs;
    for (let k = 0; k < NUM_COEFFS; k++) coeffs[k] = pred[(4 + NUM_CLASSES + k) * anchors + c.anchor];

    // Window of the 160×160 prototype grid under the box, plus a 1 px border for bilinear taps.
    const px0 = clamp(Math.floor(c.x1 / PROTO_STRIDE) - 1, 0, PROTO - 1);
    const py0 = clamp(Math.floor(c.y1 / PROTO_STRIDE) - 1, 0, PROTO - 1);
    const px1 = clamp(Math.ceil(c.x2 / PROTO_STRIDE) + 1, 0, PROTO - 1);
    const py1 = clamp(Math.ceil(c.y2 / PROTO_STRIDE) + 1, 0, PROTO - 1);
    const lw = px1 - px0 + 1;
    const lh = py1 - py0 + 1;
    if (this.logits.length < lw * lh) this.logits = new Float32Array(lw * lh);
    const logits = this.logits;
    logits.fill(0, 0, lw * lh);
    for (let k = 0; k < NUM_COEFFS; k++) {
      const ck = coeffs[k];
      const base = k * PROTO * PROTO;
      for (let y = 0; y < lh; y++) {
        const src = base + (py0 + y) * PROTO + px0;
        const dst = y * lw;
        for (let x = 0; x < lw; x++) logits[dst + x] += ck * protos[src + x];
      }
    }

    // Bilinear upsample of the logits to frame resolution; logit > 0 <=> sigmoid > 0.5.
    const fx0 = Math.floor(box.x1);
    const fy0 = Math.floor(box.y1);
    const fx1 = Math.min(width, Math.ceil(box.x2));
    const fy1 = Math.min(height, Math.ceil(box.y2));
    const mask = this.mask;
    for (let fy = fy0; fy < fy1; fy++) {
      const v = clamp(((fy + 0.5) * scale + padY) / PROTO_STRIDE - 0.5 - py0, 0, lh - 1);
      const ya = Math.floor(v);
      const yb = Math.min(ya + 1, lh - 1);
      const ty = v - ya;
      const rowA = ya * lw;
      const rowB = yb * lw;
      const out = fy * width;
      for (let fx = fx0; fx < fx1; fx++) {
        const u = clamp(((fx + 0.5) * scale + padX) / PROTO_STRIDE - 0.5 - px0, 0, lw - 1);
        const xa = Math.floor(u);
        const xb = Math.min(xa + 1, lw - 1);
        const tx = u - xa;
        const top = logits[rowA + xa] * (1 - tx) + logits[rowA + xb] * tx;
        const bottom = logits[rowB + xa] * (1 - tx) + logits[rowB + xb] * tx;
        if (top * (1 - ty) + bottom * ty > 0) mask[out + fx] = 1;
      }
    }
  }
}
