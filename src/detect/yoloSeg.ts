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
import { clamp, iou, makeCanvas, type Box, type Rect } from '../types';
import type { Sighting } from './tracker';

const DEFAULT_SIZE = 640;
const NUM_CLASSES = 80;
const NUM_COEFFS = 32;

export const COCO_CELL_PHONE = 67;
const COCO_PERSON = 0;
/** A region counts as a person (for `opts.person`) from this "person" score. */
const PERSON_CONF = 0.25;

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

/**
 * Share of a box's longer side added around it when the soft mask is painted. The model's box
 * is sometimes a little tight; the mask is cut off at its edge, and an enlarged phone would
 * show that cut as a long straight edge.
 */
const SOFT_MARGIN = 0.08;

/**
 * Share of a phone box's longer side around it in which the person mask is decoded (`opts.person`):
 * the hand holding it. Effects can use less of it, not more.
 */
export const HAND_REACH = 0.6;

/** The frame area around a phone in which the person mask is decoded (see HAND_REACH). */
export function reachArea(box: Box, width: number, height: number): { x0: number; y0: number; x1: number; y1: number } {
  const m = HAND_REACH * Math.max(box.x2 - box.x1, box.y2 - box.y1);
  return {
    x0: Math.max(0, Math.floor(box.x1 - m)),
    y0: Math.max(0, Math.floor(box.y1 - m)),
    x1: Math.min(width, Math.ceil(box.x2 + m)),
    y1: Math.min(height, Math.ceil(box.y2 + m)),
  };
}

/** The frame area, in whole pixels, in which an object's mask is painted. */
export function paintArea(box: Box, width: number, height: number, soft: boolean): { x0: number; y0: number; x1: number; y1: number } {
  const m = soft ? Math.max(3, SOFT_MARGIN * Math.max(box.x2 - box.x1, box.y2 - box.y1)) : 0;
  return {
    x0: Math.max(0, Math.floor(box.x1 - m)),
    y0: Math.max(0, Math.floor(box.y1 - m)),
    x1: Math.min(width, Math.ceil(box.x2 + m)),
    y1: Math.min(height, Math.ceil(box.y2 + m)),
  };
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
   * Also return `soft`: the mask with anti-aliased edges (grow mode enlarges it, so its steps
   * would show). Masks are then painted a little beyond each box (see `paintArea`).
   */
  soft?: boolean;
  /**
   * Also return `person`: the anti-aliased mask of the people next to each erased phone (inside
   * `reachArea`), so an effect can take the hand holding it along.
   */
  person?: boolean;
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
  /**
   * Only with `opts.soft`: `mask` with anti-aliased edges, 0..255, where 128 is the mask's edge
   * (> 127 exactly where `mask` is 1). Reused between calls like `mask`.
   */
  soft: Uint8Array | null;
  /**
   * Only with `opts.person` and an erased phone: the people's mask, anti-aliased like `soft`,
   * painted only inside each phone's `reachArea` (and each person's box). Reused between calls.
   */
  person: Uint8Array | null;
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
  private soft = new Uint8Array(0);
  private softOn = false;
  private person = new Uint8Array(0);
  /** Frame-resolution logits of the box being painted (for the soft mask). */
  private boxLogits = new Float32Array(0);
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
    this.softOn = !!opts.soft;
    if (this.softOn) {
      if (this.soft.length !== width * height) this.soft = new Uint8Array(width * height);
      else this.soft.fill(0);
    }

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
      const area = paintArea(box, width, height, this.softOn);
      this.paintMask(pred, anchors, protos, proto, size / proto, kept[i].anchor, area, this.mask, this.softOn ? this.soft : null, width, scale, padX, padY);
    });

    // The people next to the erased phones (the hand holding one), each inside its own box.
    let person: Uint8Array | null = null;
    if (opts.person && boxes.length) {
      if (this.person.length !== width * height) this.person = new Uint8Array(width * height);
      else this.person.fill(0);
      person = this.person;
      const personRow = (4 + COCO_PERSON) * anchors;
      const found: { anchor: number; score: number; x1: number; y1: number; x2: number; y2: number }[] = [];
      for (let i = 0; i < anchors; i++) {
        const score = pred[personRow + i];
        if (score < PERSON_CONF) continue;
        const hw = pred[2 * anchors + i] / 2;
        const hh = pred[3 * anchors + i] / 2;
        found.push({ anchor: i, score, x1: pred[i] - hw, y1: pred[anchors + i] - hh, x2: pred[i] + hw, y2: pred[anchors + i] + hh });
      }
      found.sort((a, b) => b.score - a.score);
      const people: typeof found = [];
      for (const c of found) {
        if (people.length >= 6) break;
        if (!people.some((k) => iou(k, c) > 0.5)) people.push(c);
      }
      for (const box of boxes) {
        const reach = reachArea(box, width, height);
        for (const c of people) {
          const area = {
            x0: Math.max(reach.x0, Math.floor((c.x1 - padX) / scale)),
            y0: Math.max(reach.y0, Math.floor((c.y1 - padY) / scale)),
            x1: Math.min(reach.x1, Math.ceil((c.x2 - padX) / scale)),
            y1: Math.min(reach.y1, Math.ceil((c.y2 - padY) / scale)),
          };
          if (area.x1 <= area.x0 || area.y1 <= area.y0) continue;
          this.paintMask(pred, anchors, protos, proto, size / proto, c.anchor, area, null, person, width, scale, padX, padY);
        }
      }
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
    const soft = this.softOn ? this.soft : null;
    return { boxes, seen, rejected, mask: this.mask, bounds, soft, person, preMs: t1 - t0, inferMs: t2 - t1, postMs: t3 - t2 };
  }

  /**
   * Decode one detection's mask straight into frame-sized masks, inside `area` only: on/off
   * into `hard`, anti-aliased into `soft` (either may be null; overlapping objects add up).
   */
  private paintMask(
    pred: Float32Array,
    anchors: number,
    protos: Float32Array,
    proto: number,
    stride: number,
    anchor: number,
    area: { x0: number; y0: number; x1: number; y1: number },
    hard: Uint8Array | null,
    softOut: Uint8Array | null,
    width: number,
    scale: number,
    padX: number,
    padY: number,
  ): void {
    const coeffs = this.coeffs;
    for (let k = 0; k < NUM_COEFFS; k++) coeffs[k] = pred[(4 + NUM_CLASSES + k) * anchors + anchor];

    // The window of the prototype grid (160×160 for a 640 model) under the area, plus a 1 cell
    // border for bilinear taps.
    const { x0: fx0, y0: fy0, x1: fx1, y1: fy1 } = area;
    const px0 = clamp(Math.floor((fx0 * scale + padX) / stride) - 1, 0, proto - 1);
    const py0 = clamp(Math.floor((fy0 * scale + padY) / stride) - 1, 0, proto - 1);
    const px1 = clamp(Math.ceil((fx1 * scale + padX) / stride) + 1, 0, proto - 1);
    const py1 = clamp(Math.ceil((fy1 * scale + padY) / stride) + 1, 0, proto - 1);
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
    const bw = fx1 - fx0;
    const bh = fy1 - fy0;
    const soft = !!softOut && bw > 0 && bh > 0;
    if (soft && this.boxLogits.length < bw * bh) this.boxLogits = new Float32Array(bw * bh);
    const boxLogits = this.boxLogits;
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
        const l = top * (1 - ty) + bottom * ty;
        if (hard && l > 0) hard[out + fx] = 1;
        if (soft) boxLogits[(fy - fy0) * bw + fx - fx0] = l;
      }
    }
    if (soft) this.antialias(softOut!, bw, bh, fx0, fy0, width);
  }

  /**
   * Coverage of each pixel from the box's logits: 0.5 + the signed distance (px) to the edge
   * where the logit crosses 0, estimated as logit / |gradient|. Gives an edge that stays smooth
   * when it is drawn several times bigger. Overlapping objects keep the larger value.
   */
  private antialias(soft: Uint8Array, bw: number, bh: number, x0: number, y0: number, width: number): void {
    const L = this.boxLogits;
    for (let y = 0; y < bh; y++) {
      const up = y > 0 ? y - 1 : y;
      const dn = y < bh - 1 ? y + 1 : y;
      const dy = Math.max(1, dn - up);
      for (let x = 0; x < bw; x++) {
        const i = y * bw + x;
        const l = L[i];
        const lf = x > 0 ? x - 1 : x;
        const rt = x < bw - 1 ? x + 1 : x;
        const gx = (L[y * bw + rt] - L[y * bw + lf]) / Math.max(1, rt - lf);
        const gy = (L[dn * bw + x] - L[up * bw + x]) / dy;
        const g = Math.sqrt(gx * gx + gy * gy);
        const d = g > 1e-6 ? l / g : l > 0 ? 1 : -1;
        // Keep the sign exact, so > 127 matches the hard mask (l > 0).
        const a = l > 0 ? Math.max(128, Math.min(255, Math.round((d + 0.5) * 255))) : Math.min(127, Math.max(0, Math.round((d + 0.5) * 255)));
        const o = (y0 + y) * width + x0 + x;
        if (a > soft[o]) soft[o] = a;
      }
    }
  }
}
