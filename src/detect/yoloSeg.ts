// YOLO11-seg (Ultralytics, ONNX) phone detector with pixel masks.
//
// Model I/O (verified with scripts/inspect_onnx.py), for the usual 640×640 export:
//   images   float32 [1, 3, 640, 640]   RGB, 0..1, letterboxed
//   output0  float32 [1, 116, 8400]     per anchor: cx, cy, w, h | 80 class scores | 32 mask coefficients
//   output1  float32 [1, 32, 160, 160]  mask prototypes (a quarter of the input side)
// The *-320 models are the same networks exported for 320×320 input ([1,116,2100], [1,32,80,80]);
// the input side is read from the model. A detection's mask is sigmoid(coefficients · prototypes),
// cropped to its box and upsampled.
import { createSession, fetchModel, modelUrl, type Backend, type Model, type Outputs } from '../runtime/ort';
import { clamp, iou, makeCanvas, type Rect } from '../types';
import type { Sighting } from './tracker';

const DEFAULT_SIZE = 640;
const NUM_CLASSES = 80;
const NUM_COEFFS = 32;

export const COCO_CELL_PHONE = 67;

/** The 80 COCO categories the model scores, in output order. */
export const COCO_NAMES = [
  'person', 'bicycle', 'car', 'motorcycle', 'airplane', 'bus', 'train', 'truck', 'boat', 'traffic light',
  'fire hydrant', 'stop sign', 'parking meter', 'bench', 'bird', 'cat', 'dog', 'horse', 'sheep', 'cow',
  'elephant', 'bear', 'zebra', 'giraffe', 'backpack', 'umbrella', 'handbag', 'tie', 'suitcase', 'frisbee',
  'skis', 'snowboard', 'sports ball', 'kite', 'baseball bat', 'baseball glove', 'skateboard', 'surfboard', 'tennis racket', 'bottle',
  'wine glass', 'cup', 'fork', 'knife', 'spoon', 'bowl', 'banana', 'apple', 'sandwich', 'orange',
  'broccoli', 'carrot', 'hot dog', 'pizza', 'donut', 'cake', 'chair', 'couch', 'potted plant', 'bed',
  'dining table', 'toilet', 'tv', 'laptop', 'mouse', 'remote', 'keyboard', 'cell phone', 'microwave', 'oven',
  'toaster', 'sink', 'refrigerator', 'book', 'clock', 'vase', 'scissors', 'teddy bear', 'hair drier', 'toothbrush',
] as const;

/** One phone-like object in one frame (frame pixels). */
export interface PhoneBox extends Sighting {
  /** The strongest other category for the same region, e.g. { name: 'remote', score: 0.2 }. */
  next: { name: string; score: number };
}

/** Something that scored as a phone but that the model thinks is something else (top-category check). */
export interface RejectedBox {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** Its "cell phone" score. */
  score: number;
  /** What the model rates higher, e.g. { name: 'book', score: 0.8 }. */
  top: { name: string; score: number };
}

export interface DetectOptions {
  /** Score at which a single frame says "phone". */
  conf: number;
  /** Lowest phone score at which an object is reported at all (default: `conf`). */
  floor?: number;
  /**
   * Only count a region as a phone if "cell phone" is the model's highest score of all 80
   * categories for it. Without this a book scoring "book 0.8, cell phone 0.3" counts as a phone.
   */
  topClassOnly?: boolean;
  /** At most this many objects are reported per frame. */
  maxDetections?: number;
  /**
   * Decides which of this frame's objects are erased (their masks painted), e.g. by watching
   * them over time (tracker.ts). Default: those whose top category is phone, at or above `conf`.
   */
  choose?: (seen: PhoneBox[]) => boolean[];
}

export interface Detection {
  /** The objects that are erased: their masks are in `mask`. */
  boxes: PhoneBox[];
  /** Every phone-like object found (phone score at least `floor`), strongest first. */
  seen: PhoneBox[];
  /** Up to 3 look-alikes turned away by the top-category check, strongest first (for diagnosis). */
  rejected: RejectedBox[];
  /** Frame-sized, 1 where an erased object is. Reused between calls: read it before the next detect(). */
  mask: Uint8Array;
  /** Bounding box of the mask, or null when it is empty. */
  bounds: Rect | null;
  preMs: number;
  inferMs: number;
  postMs: number;
}

interface Candidate {
  anchor: number;
  /** "cell phone" score. */
  score: number;
  /** Strongest other category and its score. */
  rival: number;
  rivalScore: number;
  /** What the region is ranked by: the phone score, or with the top-category check its best score. */
  rank: number;
  // Letterbox pixels.
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** The square input side a model was exported for: from its metadata, else its name (…-320), else 640. */
function inputSide(loaded: Model, model: string): number {
  const meta = loaded.session.inputMetadata?.[0];
  const side = meta?.isTensor ? meta.shape[3] : undefined;
  if (typeof side === 'number' && side > 0) return side;
  const fromName = /-(\d+)$/.exec(model);
  return fromName ? Number(fromName[1]) : DEFAULT_SIZE;
}

export class YoloSegDetector {
  backend: Backend = 'wasm';
  /** Input side of the loaded model (640, or 320 for the light models). */
  size = DEFAULT_SIZE;
  private model!: Model;
  private letterbox = makeCanvas(1, 1, true);
  private input = new Float32Array(0);
  private mask = new Uint8Array(0);
  private logits = new Float32Array(0);
  private coeffs = new Float32Array(NUM_COEFFS);

  async init(model: string, onProgress?: (fraction: number) => void): Promise<void> {
    const bytes = await fetchModel(modelUrl(`${model}.onnx`), onProgress);
    this.model = await createSession(bytes);
    this.backend = this.model.backend;
    this.size = inputSide(this.model, model);
    this.letterbox = makeCanvas(this.size, this.size, true);
    this.input = new Float32Array(3 * this.size * this.size);
    // First run compiles the GPU shaders; do it now rather than on the first camera frame.
    await this.run();
  }

  private run(): Promise<Outputs> {
    return this.model.run({ images: { data: this.input, dims: [1, 3, this.size, this.size] } });
  }

  async detect(source: CanvasImageSource, width: number, height: number, opts: DetectOptions): Promise<Detection> {
    const t0 = performance.now();
    const size = this.size;

    // Letterbox: scale to fit size×size, pad with grey (same as Ultralytics preprocessing).
    const scale = Math.min(size / width, size / height);
    const nw = Math.round(width * scale);
    const nh = Math.round(height * scale);
    const padX = (size - nw) >> 1;
    const padY = (size - nh) >> 1;
    const { ctx } = this.letterbox;
    ctx.fillStyle = 'rgb(114,114,114)';
    ctx.fillRect(0, 0, size, size);
    ctx.drawImage(source, 0, 0, width, height, padX, padY, nw, nh);
    const rgba = ctx.getImageData(0, 0, size, size).data;
    const plane = size * size;
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
    const proto = out.output1.dims[2];

    // Candidates: regions with a "cell phone" score of at least the floor.
    const topOnly = opts.topClassOnly ?? true;
    const lowConf = opts.floor ?? opts.conf;
    const phoneRow = (4 + COCO_CELL_PHONE) * anchors;
    const candidates: Candidate[] = [];
    for (let i = 0; i < anchors; i++) {
      const score = pred[phoneRow + i];
      if (score < lowConf) continue;
      let rival = -1;
      let rivalScore = 0;
      for (let k = 0; k < NUM_CLASSES; k++) {
        if (k === COCO_CELL_PHONE) continue;
        const v = pred[(4 + k) * anchors + i];
        if (v > rivalScore) {
          rivalScore = v;
          rival = k;
        }
      }
      const cx = pred[i];
      const cy = pred[anchors + i];
      const hw = pred[2 * anchors + i] / 2;
      const hh = pred[3 * anchors + i] / 2;
      const rank = topOnly ? Math.max(score, rivalScore) : score;
      candidates.push({ anchor: i, score, rival, rivalScore, rank, x1: cx - hw, y1: cy - hh, x2: cx + hw, y2: cy + hh });
    }
    candidates.sort((a, b) => b.rank - a.rank);

    if (this.mask.length !== width * height) this.mask = new Uint8Array(width * height);
    else this.mask.fill(0);

    // Greedy NMS: one entry per object. With the top-category check the strongest reading of an
    // object stands for the whole object: a book whose best region says "book" is not let
    // through by a neighbouring region that happens to say "phone".
    const kept: Candidate[] = [];
    const seen: PhoneBox[] = [];
    const rejected: RejectedBox[] = [];
    const maxDet = opts.maxDetections ?? 8;
    for (const c of candidates) {
      if (kept.length >= maxDet) break;
      if (kept.some((k) => iou(k, c) > 0.5)) continue;
      kept.push(c);
      const rect = {
        x1: clamp((c.x1 - padX) / scale, 0, width),
        y1: clamp((c.y1 - padY) / scale, 0, height),
        x2: clamp((c.x2 - padX) / scale, 0, width),
        y2: clamp((c.y2 - padY) / scale, 0, height),
      };
      const phoneIsTop = !topOnly || c.score >= c.rivalScore;
      seen.push({ ...rect, score: c.score, phoneIsTop, next: { name: COCO_NAMES[c.rival] ?? '–', score: c.rivalScore } });
      if (!phoneIsTop && rejected.length < 3) rejected.push({ ...rect, score: c.score, top: { name: COCO_NAMES[c.rival], score: c.rivalScore } });
    }

    // Which objects are erased, then paint only their masks.
    const erase = opts.choose ? opts.choose(seen) : seen.map((s) => s.phoneIsTop && s.score >= opts.conf);
    const boxes: PhoneBox[] = [];
    seen.forEach((box, i) => {
      if (!erase[i]) return;
      boxes.push(box);
      this.paintMask(pred, anchors, protos, proto, size / proto, kept[i], box, width, height, scale, padX, padY);
    });

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
    return { boxes, seen, rejected, mask: this.mask, bounds, preMs: t1 - t0, inferMs: t2 - t1, postMs: t3 - t2 };
  }

  /** Decode one detection's mask straight into the frame-sized mask, inside its box only. */
  private paintMask(
    pred: Float32Array,
    anchors: number,
    protos: Float32Array,
    proto: number,
    stride: number,
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

    // Window of the prototype grid (160×160 for a 640 model) under the box, plus a 1 px border for bilinear taps.
    const px0 = clamp(Math.floor(c.x1 / stride) - 1, 0, proto - 1);
    const py0 = clamp(Math.floor(c.y1 / stride) - 1, 0, proto - 1);
    const px1 = clamp(Math.ceil(c.x2 / stride) + 1, 0, proto - 1);
    const py1 = clamp(Math.ceil(c.y2 / stride) + 1, 0, proto - 1);
    const lw = px1 - px0 + 1;
    const lh = py1 - py0 + 1;
    if (this.logits.length < lw * lh) this.logits = new Float32Array(lw * lh);
    const logits = this.logits;
    logits.fill(0, 0, lw * lh);
    for (let k = 0; k < NUM_COEFFS; k++) {
      const ck = coeffs[k];
      const base = k * proto * proto;
      for (let y = 0; y < lh; y++) {
        const src = base + (py0 + y) * proto + px0;
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
      const v = clamp(((fy + 0.5) * scale + padY) / stride - 0.5 - py0, 0, lh - 1);
      const ya = Math.floor(v);
      const yb = Math.min(ya + 1, lh - 1);
      const ty = v - ya;
      const rowA = ya * lw;
      const rowB = yb * lw;
      const out = fy * width;
      for (let fx = fx0; fx < fx1; fx++) {
        const u = clamp(((fx + 0.5) * scale + padX) / stride - 0.5 - px0, 0, lw - 1);
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
