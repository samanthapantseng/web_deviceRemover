import { paintArea, reachArea } from '../detect/yoloSeg';
import { DistanceField } from '../mask/distance';
import type { GrowShape, Settings } from '../settings';
import { clamp, makeCanvas, type CanvasPair } from '../types';
import type { Effect, EffectFrame, PickedPhone } from './types';

/** How long a phone takes to shrink back to its real size and fade out once it is gone. */
const LEAVE_MS = 250;
/** Time constant of the drawn position following the phone (smooths the detector's steps). */
const FOLLOW_MS = 30;
/** Fewer mask pixels than this in a phone's area: keep the previous cut-out. */
const MIN_PIXELS = 30;
/**
 * Hand shape: the hand starts from person pixels at least this far inside the phone's outline,
 * as a share of the phone box's longer side (at least 3 px). Fingers covering the phone reach
 * well inside; a cheek next to it only shows in thin slivers along a wobbly mask edge.
 */
const SEED_DEPTH = 0.05;
/** Pieces of the mask smaller than this share of it are specks and left out. */
const SPECK = 0.05;
/** Rectangle: share of the mask's pixels ignored at each end of each side (stray specks). */
const TRIM = 0.005;
/** Rectangle: corner radius as a share of the short side (phones have rounded corners). */
const CORNER = 0.12;
/** Convex outline: it is kept as its distance from the centre in this many directions. */
const OUTLINE_STEPS = 120;
const OUTLINE_COS = Float32Array.from({ length: OUTLINE_STEPS }, (_, k) => Math.cos((2 * Math.PI * k) / OUTLINE_STEPS));
const OUTLINE_SIN = Float32Array.from({ length: OUTLINE_STEPS }, (_, k) => Math.sin((2 * Math.PI * k) / OUTLINE_STEPS));

const HOLE = 0;
const INSIDE = 1;
const OUTSIDE = 2;

const smoothstep = (t: number) => t * t * (3 - 2 * t);

/** A rotated rectangle: centre, angle of its first side (rad), and half of each side. */
interface Turned {
  cx: number;
  cy: number;
  angle: number;
  hw: number;
  hh: number;
}

interface Grown {
  id: number;
  /** When it started growing: when the tracker decided on it, or grow mode was switched on if later. */
  decidedAt: number;
  shape: GrowShape;
  /** Side of the square sprite, frame px. */
  side: number;
  /**
   * What is drawn. Mask: this frame's camera pixels with the smoothed mask as alpha. Convex
   * outline and rectangle: plain camera pixels (the shape is cut when drawing).
   */
  front: CanvasPair;
  image: ImageData;
  /** Mask shape: the smoothed mask in sprite pixels (0..255), and a spare for the next frame. */
  shapeAlpha: Uint8Array | null;
  spareAlpha: Uint8Array | null;
  /** Frame position of the sprite's top-left pixel. */
  ox: number;
  oy: number;
  /** The point the phone grows around, in the frame it was cut from. */
  cx: number;
  cy: number;
  /** Where that point is drawn: follows (cx, cy) smoothly at display rate. */
  ax: number;
  ay: number;
  /** Rectangle shape: the rectangle, its angle and size smoothed over frames (centred on cx, cy). */
  rect: Turned | null;
  /** Convex-outline shape: distance of the outline from (cx, cy) per direction, smoothed over frames. */
  outline: Float32Array | null;
  /** Processed frames in a row without a sighting. */
  missed: number;
  /** Set when it is gone: it shrinks back from `leftScale` and fades out. */
  leftAt: number | null;
  leftScale: number;
}

/**
 * Grow: draws each phone bigger, around its own centre, on top of the picture. Each phone
 * inflates from `growStart` to `growMax` times its real size over `growSeconds`, counted from
 * the moment the tracker decided on it (or grow mode was switched on, if that was later). When
 * it is gone, it shrinks back to its real size and fades out. A bigger copy around the phone's
 * own centre covers the real phone, so nothing has to be inpainted.
 *
 * Four shapes (`growShape`); the picture inside is always the current frame:
 *  - hand (default): as mask, plus the hand on the phone from the detector's person mask: it
 *    starts from the person pixels in front of the phone (inside its convex hull, where the
 *    phone mask is missing: fingers on it) and spreads through the person mask for `growReach`,
 *    fading out. Starting only from what covers the phone keeps out a face or body next to it.
 *  - mask: the detector's own mask, anti-aliased, holes filled, specks left out. The
 *    dents fingers make in it are filled (`growFill`, a morphological closing), so the fingers
 *    lying on the phone are enlarged with it while the rest of the outline stays exact. The
 *    mask is smoothed over frames (`growSmoothing`).
 *  - hull: the mask's convex hull, drawn as a clip path. Since a phone is a rounded rectangle,
 *    this comes out close to the rectangle.
 *  - rectangle: the smallest rotated, round-cornered rectangle around the mask, as a clip path.
 */
export class GrowEffect implements Effect {
  readonly id = 'grow';
  readonly needsPhoneAlpha = true;
  needsPersonAlpha(s: Settings): boolean {
    return s.growShape === 'hand';
  }
  /** No inpaint window in this mode (for the mask overlay). */
  readonly rect = null;

  private phones = new Map<number, Grown>();
  /** Per pixel of a phone's area: OUTSIDE (reached from the area's border), INSIDE (mask) or, left at 0, a hole. */
  private region = new Uint8Array(0);
  /** Per pixel of a phone's area: which piece of the mask it belongs to (0: none). */
  private piece = new Int32Array(0);
  /** Per pixel of a phone's area: 1 where the phone is (mask, holes filled, without specks). */
  private solid = new Uint8Array(0);
  /** Per pixel of a phone's area: the mask shape's alpha (0..255). */
  private cutAlpha = new Uint8Array(0);
  private queue = new Int32Array(0);
  /** Hand shape: steps along the hand from the fingers on the phone (−1: not reached). */
  private depth = new Int32Array(0);
  private histU = new Int32Array(0);
  private histV = new Int32Array(0);
  /** For filling finger gaps: the area with a border, and two distance fields over it. */
  private work = new Uint8Array(0);
  private distA = new Float32Array(0);
  private distB = new Float32Array(0);
  private field = new DistanceField();
  private settings: Settings | null = null;
  private lastRender = 0;
  /** When this mode was switched on (never, until reset()): a phone picked earlier starts growing from here. */
  private since = -Infinity;

  constructor(
    private width: number,
    private height: number,
  ) {}

  describe(): string {
    const s = this.settings;
    if (!s) return 'grow';
    const shape =
      s.growShape === 'hand'
        ? `mask + hand ${Math.round(s.growReach * 100)} %, gaps ${Math.round(s.growFill * 100)} %`
        : s.growShape === 'mask'
          ? `mask, gaps ${Math.round(s.growFill * 100)} %`
          : s.growShape;
    const plan = `grow ${shape} · ${s.growStart}× → ${s.growMax}× in ${s.growSeconds} s`;
    const now = performance.now();
    const sizes = [...this.phones.values()]
      .filter((p) => p.leftAt === null)
      .map((p) => `${this.scaleAt(p, now).toFixed(1)}×`);
    return sizes.length ? `${plan} · now ${sizes.join(', ')}` : plan;
  }

  reset(): void {
    this.phones.clear();
    this.since = performance.now();
  }

  onMask(f: EffectFrame): void {
    this.settings = f.settings;
  }

  async process(f: EffectFrame): Promise<void> {
    this.settings = f.settings;
    const now = performance.now();
    const seen = new Set<number>();
    if (f.phoneAlpha) {
      for (const phone of f.phones) {
        if (this.cut(phone, f, now)) seen.add(phone.id);
      }
    }
    for (const p of this.phones.values()) {
      if (seen.has(p.id)) {
        p.missed = 0;
        p.leftAt = null;
      } else if (p.leftAt === null && ++p.missed > f.settings.holdFrames) {
        // Gone for longer than a detector dropout: shrink back and fade.
        p.leftScale = this.scaleAt(p, now);
        p.leftAt = now;
      }
    }
  }

  render(ctx: CanvasRenderingContext2D, still = false): void {
    const now = performance.now();
    const dt = Math.min(100, now - this.lastRender);
    this.lastRender = now;
    const follow = 1 - Math.exp(-dt / FOLLOW_MS);

    const draws: { p: Grown; scale: number; alpha: number }[] = [];
    for (const p of this.phones.values()) {
      if (!still) {
        p.ax += (p.cx - p.ax) * follow;
        p.ay += (p.cy - p.ay) * follow;
      }
      let scale = this.scaleAt(p, now);
      let alpha = 1;
      if (p.leftAt !== null) {
        if (still) continue;
        const t = (now - p.leftAt) / LEAVE_MS;
        if (t >= 1) {
          this.phones.delete(p.id);
          continue;
        }
        const e = smoothstep(t);
        scale = p.leftScale + (1 - p.leftScale) * e;
        alpha = 1 - e;
      }
      draws.push({ p, scale, alpha });
    }
    if (!draws.length) return;

    // Biggest first, so a phone that has only just started growing stays visible on top.
    draws.sort((a, b) => b.scale - a.scale);
    for (const { p, scale, alpha } of draws) {
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      // Frame point q is drawn at a + scale · (q − c): the phone's centre stays where it is.
      ctx.translate(p.ax, p.ay);
      ctx.scale(scale, scale);
      // A clip is set in drawing space, so its edge is smooth however big it is drawn.
      if (p.outline) {
        const r = p.outline;
        ctx.beginPath();
        ctx.moveTo(r[0] * OUTLINE_COS[0], r[0] * OUTLINE_SIN[0]);
        for (let k = 1; k < OUTLINE_STEPS; k++) ctx.lineTo(r[k] * OUTLINE_COS[k], r[k] * OUTLINE_SIN[k]);
        ctx.closePath();
        ctx.clip();
      } else if (p.rect) {
        const { angle, hw, hh } = p.rect;
        ctx.rotate(angle);
        ctx.beginPath();
        roundedRect(ctx, -hw, -hh, 2 * hw, 2 * hh, CORNER * 2 * Math.min(hw, hh));
        ctx.clip();
        ctx.rotate(-angle);
      }
      ctx.translate(p.ox - p.cx, p.oy - p.cy);
      ctx.drawImage(p.front.canvas, 0, 0);
      ctx.restore();
    }
  }

  private scaleAt(p: Grown, now: number): number {
    const s = this.settings;
    if (!s) return 1;
    const t = clamp((now - p.decidedAt) / Math.max(1, s.growSeconds * 1000), 0, 1);
    return s.growStart + (s.growMax - s.growStart) * smoothstep(t);
  }

  /** Take one phone out of the frame into its sprite. False when its mask is (nearly) empty. */
  private cut(phone: PickedPhone, f: EffectFrame, now: number): boolean {
    const W = this.width;
    const H = this.height;
    const alpha = f.phoneAlpha!;
    const s = f.settings;
    const shape = s.growShape;
    const hand = shape === 'hand' ? f.personAlpha : null;
    // With the hand, the area around the phone in which the detector decoded the person mask.
    const { x0, y0, x1, y1 } = hand ? reachArea(phone, W, H) : paintArea(phone, W, H, true);
    const bw = x1 - x0;
    const bh = y1 - y0;
    if (bw < 2 || bh < 2) return false;
    const n = this.markPhone(alpha, x0, y0, bw, bh);
    if (n < MIN_PIXELS) return false;

    const keep = clamp(s.growSmoothing, 0, 0.9);
    let cx: number;
    let cy: number;
    let half: number;
    let fit: Turned | null = null;
    let outline: Float32Array | null = null;
    if (shape === 'hull') {
      const hull = this.fitHull(x0, y0, bw, bh);
      if (!hull) return false;
      cx = hull.cx;
      cy = hull.cy;
      const before = this.phones.get(phone.id);
      outline = smoothOutline(before && before.shape === 'hull' ? before.outline : null, hull.radii, keep);
      // Room for the outline as found in this frame and as smoothed (which can still be bigger).
      let r = 0;
      for (let k = 0; k < OUTLINE_STEPS; k++) r = Math.max(r, hull.radii[k], outline[k]);
      half = Math.ceil(r) + 3;
    } else if (shape === 'rectangle') {
      fit = this.fitRect(x0, y0, bw, bh);
      if (!fit) return false;
      cx = fit.cx;
      cy = fit.cy;
      const c = Math.abs(Math.cos(fit.angle));
      const sn = Math.abs(Math.sin(fit.angle));
      // Room around the rectangle, as the smoothed one can be a little bigger or turned.
      half = Math.ceil(Math.max(fit.hw * c + fit.hh * sn, fit.hw * sn + fit.hh * c) * 1.15) + 3;
    } else {
      let sx = 0;
      let sy = 0;
      for (let y = 0; y < bh; y++) {
        for (let x = 0; x < bw; x++) {
          if (this.solid[y * bw + x]) {
            sx += x;
            sy += y;
          }
        }
      }
      cx = x0 + sx / n + 0.5;
      cy = y0 + sy / n + 0.5;
      half = Math.ceil(Math.max(cx - x0, x1 - cx, cy - y0, y1 - cy)) + 2;
    }

    const p = this.sprite(phone.id, half, cx, cy, shape);
    p.decidedAt = Math.max(now - phone.erasedMs, this.since);
    const side = p.side;
    const ox = Math.round(cx) - side / 2;
    const oy = Math.round(cy) - side / 2;

    if (fit || outline) {
      p.rect = fit ? smoothRect(p.rect, fit, keep) : null;
      p.outline = outline;
      // The camera pixels around the phone, as they are; the shape is cut when drawing.
      const out = p.front.ctx;
      out.clearRect(0, 0, side, side);
      const sx = Math.max(0, ox);
      const sy = Math.max(0, oy);
      const sw = Math.min(W, ox + side) - sx;
      const sh = Math.min(H, oy + side) - sy;
      if (sw > 0 && sh > 0) out.drawImage(f.frame, sx, sy, sw, sh, sx - ox, sy - oy, sw, sh);
    } else {
      p.rect = null;
      p.outline = null;
      const a = this.maskAlpha(alpha, x0, y0, bw, bh, s.growFill * Math.sqrt(n));
      if (hand) {
        const long = Math.max(phone.x2 - phone.x1, phone.y2 - phone.y1);
        this.addHand(hand, x0, y0, bw, bh, s.growReach * long, Math.max(3, SEED_DEPTH * long));
      }
      this.cutMask(p, a, f.frame, x0, y0, bw, bh, ox, oy, cx, cy, keep);
    }

    p.ox = ox;
    p.oy = oy;
    p.cx = cx;
    p.cy = cy;
    return true;
  }

  /** The phone's state, with a sprite of at least 2·half px (a new one if it does not fit). */
  private sprite(id: number, half: number, cx: number, cy: number, shape: GrowShape): Grown {
    const p = this.phones.get(id);
    if (p && p.side >= 2 * half && p.side <= 3.2 * half) {
      if (p.shape !== shape) {
        p.shape = shape;
        p.rect = null;
        p.outline = null;
        p.shapeAlpha = null;
      }
      return p;
    }
    const side = Math.ceil((2 * half * 1.15) / 16) * 16;
    const same = p && p.shape === shape;
    const fresh: Grown = {
      id,
      decidedAt: 0,
      shape,
      side,
      front: makeCanvas(side, side),
      image: new ImageData(side, side),
      shapeAlpha: null,
      spareAlpha: null,
      ox: 0,
      oy: 0,
      cx,
      cy,
      ax: p?.ax ?? cx,
      ay: p?.ay ?? cy,
      rect: same ? p.rect : null,
      outline: same ? p.outline : null,
      missed: 0,
      leftAt: null,
      leftScale: 1,
    };
    this.phones.set(id, fresh);
    return fresh;
  }

  /**
   * Which pixels of a phone's area are phone (`solid`): the mask (the detector paints it only
   * inside this area), with gaps fully enclosed by it filled (a phone has no holes) and pieces
   * under SPECK of it left out. Not just the biggest piece: a finger across the phone can split
   * the mask in two. Returns how many pixels are phone.
   */
  private markPhone(alpha: Uint8Array, x0: number, y0: number, bw: number, bh: number): number {
    const size = bw * bh;
    if (this.region.length < size) {
      this.region = new Uint8Array(size);
      this.piece = new Int32Array(size);
      this.solid = new Uint8Array(size);
      this.cutAlpha = new Uint8Array(size);
      this.queue = new Int32Array(size);
      this.depth = new Int32Array(size);
    }
    const { region, piece, solid, queue } = this;
    const W = this.width;

    // INSIDE where the mask is; OUTSIDE where the area's border can be reached without crossing
    // the mask (4-connected); HOLE for the rest.
    let tail = 0;
    for (let y = 0; y < bh; y++) {
      const row = (y0 + y) * W + x0;
      for (let x = 0; x < bw; x++) {
        const i = y * bw + x;
        if (alpha[row + x] > 127) region[i] = INSIDE;
        else if (x === 0 || y === 0 || x === bw - 1 || y === bh - 1) {
          region[i] = OUTSIDE;
          queue[tail++] = i;
        } else region[i] = HOLE;
      }
    }
    for (let head = 0; head < tail; head++) {
      const i = queue[head];
      const x = i % bw;
      if (x > 0 && region[i - 1] === HOLE) (region[i - 1] = OUTSIDE), (queue[tail++] = i - 1);
      if (x < bw - 1 && region[i + 1] === HOLE) (region[i + 1] = OUTSIDE), (queue[tail++] = i + 1);
      if (i >= bw && region[i - bw] === HOLE) (region[i - bw] = OUTSIDE), (queue[tail++] = i - bw);
      if (i + bw < size && region[i + bw] === HOLE) (region[i + bw] = OUTSIDE), (queue[tail++] = i + bw);
    }

    // Pieces (4-connected) of what is not OUTSIDE, and their sizes.
    piece.fill(0, 0, size);
    const sizes = [0];
    let total = 0;
    for (let start = 0; start < size; start++) {
      if (region[start] === OUTSIDE || piece[start]) continue;
      const id = sizes.length;
      tail = 0;
      queue[tail++] = start;
      piece[start] = id;
      for (let head = 0; head < tail; head++) {
        const i = queue[head];
        const x = i % bw;
        if (x > 0 && region[i - 1] !== OUTSIDE && !piece[i - 1]) (piece[i - 1] = id), (queue[tail++] = i - 1);
        if (x < bw - 1 && region[i + 1] !== OUTSIDE && !piece[i + 1]) (piece[i + 1] = id), (queue[tail++] = i + 1);
        if (i >= bw && region[i - bw] !== OUTSIDE && !piece[i - bw]) (piece[i - bw] = id), (queue[tail++] = i - bw);
        if (i + bw < size && region[i + bw] !== OUTSIDE && !piece[i + bw]) (piece[i + bw] = id), (queue[tail++] = i + bw);
      }
      sizes.push(tail);
      total += tail;
    }
    let n = 0;
    for (let i = 0; i < size; i++) {
      const id = piece[i];
      solid[i] = id && sizes[id] >= SPECK * total ? 1 : 0;
      n += solid[i];
    }
    return n;
  }

  /**
   * Mask shape: the alpha of each pixel of the area. The mask's own anti-aliased edge where it
   * is phone; solid in holes (and on the mask's soft rim around them); and, with `fill` > 0, the
   * dents fingers make filled: a morphological closing (grow the phone by `fill` px, shrink it
   * back by as much) fills every dent narrower than about 2·fill and leaves the rest of the
   * outline exactly as it was.
   */
  private maskAlpha(alpha: Uint8Array, x0: number, y0: number, bw: number, bh: number, fill: number): Uint8Array {
    const { solid, region, cutAlpha: out } = this;
    const W = this.width;
    for (let y = 0; y < bh; y++) {
      const row = (y0 + y) * W + x0;
      for (let x = 0; x < bw; x++) {
        const i = y * bw + x;
        const left = x > 0 ? i - 1 : -1;
        const right = x < bw - 1 ? i + 1 : -1;
        const up = y > 0 ? i - bw : -1;
        const down = y < bh - 1 ? i + bw : -1;
        if (solid[i]) {
          const nearHole =
            region[i] === HOLE ||
            (left >= 0 && region[left] === HOLE) ||
            (right >= 0 && region[right] === HOLE) ||
            (up >= 0 && region[up] === HOLE) ||
            (down >= 0 && region[down] === HOLE);
          out[i] = nearHole ? 255 : alpha[row + x];
        } else {
          // The soft rim just outside the mask, only next to the phone (not around specks).
          const nearPhone = (left >= 0 && solid[left]) || (right >= 0 && solid[right]) || (up >= 0 && solid[up]) || (down >= 0 && solid[down]);
          out[i] = nearPhone ? alpha[row + x] : 0;
        }
      }
    }
    if (fill >= 1) this.fillGaps(bw, bh, fill);
    return out;
  }

  /**
   * Hand shape: adds the hand on the phone to `cutAlpha`. It starts from the person pixels in
   * front of the phone (at least `inset` px inside the phone's convex hull, where the phone
   * itself is not: fingers covering it) and spreads through the person mask (8-connected), but only within `reach` px
   * in a straight line from those fingers: fully up to 60 % of that, then fading out. A face or
   * body next to the phone is not in front of it; joined to the hand, it still comes along where
   * it is within the reach of the fingers (a straight-line limit, so not round the phone).
   */
  private addHand(person: Uint8Array, x0: number, y0: number, bw: number, bh: number, reach: number, inset: number): void {
    if (reach < 1) return;
    const { solid, depth, queue, cutAlpha: out } = this;
    const W = this.width;
    const size = bw * bh;

    // The phone's convex hull, as the span it covers on each row.
    const ends: [number, number][] = [];
    for (let y = 0; y < bh; y++) {
      let first = -1;
      let last = -1;
      for (let x = 0; x < bw; x++) {
        if (!solid[y * bw + x]) continue;
        if (first < 0) first = x;
        last = x;
      }
      if (first >= 0) ends.push([first, y], [first, y + 1], [last + 1, y], [last + 1, y + 1]);
    }
    const hull = convexHull(ends);
    if (hull.length < 3) return;

    // Seeds: person, not phone, inside the hull.
    depth.fill(-1, 0, size);
    let tail = 0;
    for (let y = 0; y < bh; y++) {
      const yc = y + 0.5;
      let left = Infinity;
      let right = -Infinity;
      for (let k = 0; k < hull.length; k++) {
        const [ax, ay] = hull[k];
        const [bx, by] = hull[(k + 1) % hull.length];
        if ((ay <= yc && by > yc) || (by <= yc && ay > yc)) {
          const xc = ax + ((yc - ay) / (by - ay)) * (bx - ax);
          if (xc < left) left = xc;
          if (xc > right) right = xc;
        }
      }
      if (left > right) continue;
      const row = (y0 + y) * W + x0;
      for (let x = Math.max(0, Math.ceil(left - 0.5)); x <= Math.min(bw - 1, Math.floor(right - 0.5)); x++) {
        const i = y * bw + x;
        if (solid[i] || person[row + x] <= 127) continue;
        // Far enough inside the outline (for a point inside a convex shape: the nearest edge line).
        const xc = x + 0.5;
        let inner = Infinity;
        for (let k = 0; k < hull.length && inner >= inset; k++) {
          const [ax, ay] = hull[k];
          const [bx, by] = hull[(k + 1) % hull.length];
          const len = Math.hypot(bx - ax, by - ay);
          if (len > 0) inner = Math.min(inner, Math.abs((bx - ax) * (yc - ay) - (by - ay) * (xc - ax)) / len);
        }
        if (inner < inset) continue;
        depth[i] = 0;
        queue[tail++] = i;
      }
    }
    if (!tail) return;

    // Straight-line distance from the fingers on the phone.
    if (this.work.length < size) {
      this.work = new Uint8Array(size);
      this.distA = new Float32Array(size);
      this.distB = new Float32Array(size);
    }
    const { work, distA: near } = this;
    for (let i = 0; i < size; i++) work[i] = depth[i] === 0 ? 1 : 0;
    this.field.compute(work, bw, { x: 0, y: 0, w: bw, h: bh }, near);

    // Spread along the person mask, within the reach of the fingers.
    for (let head = 0; head < tail; head++) {
      const i = queue[head];
      const d = depth[i] + 1;
      const x = i % bw;
      const y = (i - x) / bw;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= bh) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if ((!dx && !dy) || xx < 0 || xx >= bw) continue;
          const j = yy * bw + xx;
          if (depth[j] >= 0 || solid[j] || near[j] > reach || person[(y0 + yy) * W + x0 + xx] <= 127) continue;
          depth[j] = d;
          queue[tail++] = j;
        }
      }
    }

    // Alpha: full up to 60 % of the reach, then fading; the person mask's soft rim next to it.
    const full = 0.6 * reach;
    const fade = (d: number) => (d <= full ? 1 : Math.max(0, (reach - d) / (reach - full)));
    for (let y = 0; y < bh; y++) {
      const row = (y0 + y) * W + x0;
      for (let x = 0; x < bw; x++) {
        const i = y * bw + x;
        let a = 0;
        if (depth[i] >= 0) a = 255 * fade(near[i]);
        else if (person[row + x] > 0) {
          const joined =
            (x > 0 && depth[i - 1] >= 0) ||
            (x < bw - 1 && depth[i + 1] >= 0) ||
            (y > 0 && depth[i - bw] >= 0) ||
            (y < bh - 1 && depth[i + bw] >= 0);
          if (joined) a = person[row + x] * fade(near[i]);
        }
        if (a > out[i]) out[i] = Math.round(a);
      }
    }
  }

  /** Adds the closing of `solid` by a disc of radius r to `cutAlpha` (anti-aliased at its new edges). */
  private fillGaps(bw: number, bh: number, r: number): void {
    // A border of more than r around the area, so the grown phone fits and the shrinking sees
    // outside all round (also past the frame's edge).
    const pad = Math.ceil(r) + 2;
    const ew = bw + 2 * pad;
    const eh = bh + 2 * pad;
    const n = ew * eh;
    if (this.work.length < n) {
      this.work = new Uint8Array(n);
      this.distA = new Float32Array(n);
      this.distB = new Float32Array(n);
    }
    const { work, distA, distB, solid } = this;
    work.fill(0, 0, n);
    for (let y = 0; y < bh; y++) work.set(solid.subarray(y * bw, (y + 1) * bw), (y + pad) * ew + pad);
    const roi = { x: 0, y: 0, w: ew, h: eh };
    this.field.compute(work, ew, roi, distA); // distance to the phone
    for (let i = 0; i < n; i++) work[i] = distA[i] > r ? 1 : 0; // outside the phone grown by r
    this.field.compute(work, ew, roi, distB); // distance to that outside
    const out = this.cutAlpha;
    for (let y = 0; y < bh; y++) {
      const e = (y + pad) * ew + pad;
      for (let x = 0; x < bw; x++) {
        const d = distB[e + x] - r;
        if (d <= 0) continue;
        const a = d >= 1 ? 255 : Math.round(d * 255);
        const i = y * bw + x;
        if (a > out[i]) out[i] = a;
      }
    }
  }

  /**
   * Mask shape: this frame's camera pixels with the mask as alpha. Only the mask is smoothed
   * over frames (blended with the previous one, aligned on the phone's centre), never the
   * picture, so a moving phone does not smear.
   */
  private cutMask(
    p: Grown,
    a: Uint8Array,
    frame: HTMLCanvasElement,
    x0: number,
    y0: number,
    bw: number,
    bh: number,
    ox: number,
    oy: number,
    cx: number,
    cy: number,
    keep: number,
  ): void {
    const side = p.side;
    const size = side * side;
    if (!p.spareAlpha || p.spareAlpha.length !== size) p.spareAlpha = new Uint8Array(size);
    const next = p.spareAlpha;
    next.fill(0);
    for (let y = 0; y < bh; y++) {
      const d = (y0 + y - oy) * side + (x0 - ox);
      next.set(a.subarray(y * bw, (y + 1) * bw), d);
    }
    const prev = p.shapeAlpha;
    if (prev && prev.length === size && keep > 0) {
      const dx = Math.round(p.ox - p.cx - (ox - cx));
      const dy = Math.round(p.oy - p.cy - (oy - cy));
      for (let v = 0; v < side; v++) {
        const sv = v - dy;
        const inRow = sv >= 0 && sv < side;
        for (let u = 0; u < side; u++) {
          const su = u - dx;
          const old = inRow && su >= 0 && su < side ? prev[sv * side + su] : 0;
          const j = v * side + u;
          next[j] = Math.round(keep * old + (1 - keep) * next[j]);
        }
      }
    }
    p.spareAlpha = prev;
    p.shapeAlpha = next;

    // Colour from this frame, wherever the (smoothed) mask is.
    const dst = p.image.data;
    dst.fill(0);
    const sx = Math.max(0, ox);
    const sy = Math.max(0, oy);
    const ex = Math.min(this.width, ox + side);
    const ey = Math.min(this.height, oy + side);
    if (ex > sx && ey > sy) {
      const sw = ex - sx;
      const src = frame.getContext('2d')!.getImageData(sx, sy, sw, ey - sy).data;
      for (let y = sy; y < ey; y++) {
        for (let x = sx; x < ex; x++) {
          const j = (y - oy) * side + (x - ox);
          const al = next[j];
          if (!al) continue;
          const si = ((y - sy) * sw + (x - sx)) * 4;
          const di = j * 4;
          dst[di] = src[si];
          dst[di + 1] = src[si + 1];
          dst[di + 2] = src[si + 2];
          dst[di + 3] = al;
        }
      }
    }
    p.front.ctx.putImageData(p.image, 0, 0);
  }

  /**
   * The phone's convex hull, leaving out specks. Returned as the hull's centre and its
   * distance from there in OUTLINE_STEPS directions, which is easy to smooth over time.
   */
  private fitHull(x0: number, y0: number, bw: number, bh: number): { cx: number; cy: number; radii: Float32Array } | null {
    const { solid } = this;
    // The two ends of every row (as pixel corners, in frame coordinates), then their hull.
    const ends: [number, number][] = [];
    for (let y = 0; y < bh; y++) {
      let first = -1;
      let last = -1;
      for (let x = 0; x < bw; x++) {
        if (!solid[y * bw + x]) continue;
        if (first < 0) first = x;
        last = x;
      }
      if (first >= 0) {
        const fy = y0 + y;
        ends.push([x0 + first, fy], [x0 + first, fy + 1], [x0 + last + 1, fy], [x0 + last + 1, fy + 1]);
      }
    }
    const hull = convexHull(ends);
    const n = hull.length;
    if (n < 3) return null;

    // Centre: the hull's centre of area.
    let area = 0;
    let gx = 0;
    let gy = 0;
    for (let i = 0; i < n; i++) {
      const [ax, ay] = hull[i];
      const [bx, by] = hull[(i + 1) % n];
      const c = ax * by - bx * ay;
      area += c;
      gx += (ax + bx) * c;
      gy += (ay + by) * c;
    }
    if (Math.abs(area) < 2) return null;
    const cx = gx / (3 * area);
    const cy = gy / (3 * area);

    // Distance from the centre to the hull's edge in each direction (the hull is convex and
    // contains its centre, so each ray leaves it exactly once).
    const radii = new Float32Array(OUTLINE_STEPS);
    for (let k = 0; k < OUTLINE_STEPS; k++) {
      const dx = OUTLINE_COS[k];
      const dy = OUTLINE_SIN[k];
      let r = 0;
      for (let i = 0; i < n; i++) {
        const [ax, ay] = hull[i];
        const [bx, by] = hull[(i + 1) % n];
        const ex = bx - ax;
        const ey = by - ay;
        const den = dx * ey - dy * ex;
        if (Math.abs(den) < 1e-9) continue;
        const wx = ax - cx;
        const wy = ay - cy;
        const t = (wx * ey - wy * ex) / den;
        const u = (wx * dy - wy * dx) / den;
        if (u >= -1e-6 && u <= 1 + 1e-6 && t > r) r = t;
      }
      radii[k] = r;
    }
    return { cx, cy, radii };
  }

  /**
   * The rotated rectangle around the phone's pixels. Its direction is that of the smallest
   * rectangle enclosing them (which lies along one edge of their convex hull), so it takes in as
   * little background as possible; its sides are where the pixels end along both directions,
   * ignoring the outermost TRIM of them, so a stray speck does not stretch it.
   */
  private fitRect(x0: number, y0: number, bw: number, bh: number): Turned | null {
    const { solid } = this;
    // Pixel count and mean, and the two ends of every row (as pixel corners) for the hull.
    let n = 0;
    let sx = 0;
    let sy = 0;
    const ends: [number, number][] = [];
    for (let y = 0; y < bh; y++) {
      let first = -1;
      let last = -1;
      for (let x = 0; x < bw; x++) {
        if (!solid[y * bw + x]) continue;
        if (first < 0) first = x;
        last = x;
        n++;
        sx += x;
        sy += y;
      }
      if (first >= 0) ends.push([first, y], [first, y + 1], [last + 1, y], [last + 1, y + 1]);
    }
    if (n < MIN_PIXELS) return null;
    const mx = sx / n;
    const my = sy / n;
    const angle = smallestRectAngle(convexHull(ends));
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);

    // Histograms (1 px bins) of where the pixels lie along both sides.
    const R = Math.ceil(Math.hypot(bw, bh)) + 1;
    const bins = 2 * R + 1;
    if (this.histU.length < bins) {
      this.histU = new Int32Array(bins);
      this.histV = new Int32Array(bins);
    }
    const { histU: hu, histV: hv } = this;
    hu.fill(0, 0, bins);
    hv.fill(0, 0, bins);
    for (let y = 0; y < bh; y++) {
      const dy = y - my;
      for (let x = 0; x < bw; x++) {
        if (!solid[y * bw + x]) continue;
        const dx = x - mx;
        hu[Math.round(dx * cos + dy * sin) + R]++;
        hv[Math.round(dy * cos - dx * sin) + R]++;
      }
    }
    const trim = Math.floor(n * TRIM);
    const [u0, u1] = span(hu, bins, trim);
    const [v0, v1] = span(hv, bins, trim);
    // Bin b holds pixels whose centre lies b − R from the mean; each pixel is 1 px wide.
    const cu = (u0 + u1) / 2 - R;
    const cv = (v0 + v1) / 2 - R;
    return {
      cx: x0 + 0.5 + mx + cu * cos - cv * sin,
      cy: y0 + 0.5 + my + cu * sin + cv * cos,
      angle,
      hw: (u1 - u0 + 1) / 2,
      hh: (v1 - v0 + 1) / 2,
    };
  }
}

/** Convex hull of points (Andrew's monotone chain). */
function convexHull(points: [number, number][]): [number, number][] {
  points.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: [number, number], a: [number, number], b: [number, number]) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: [number, number][] = [];
  for (const q of points) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper: [number, number][] = [];
  for (let i = points.length - 1; i >= 0; i--) {
    const q = points[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

/** Angle of the smallest-area rectangle around a convex hull: it has a side along one hull edge. */
function smallestRectAngle(hull: [number, number][]): number {
  let best = Infinity;
  let bestAngle = 0;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i];
    const b = hull[(i + 1) % hull.length];
    const angle = Math.atan2(b[1] - a[1], b[0] - a[0]);
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    let u0 = Infinity;
    let u1 = -Infinity;
    let v0 = Infinity;
    let v1 = -Infinity;
    for (const [x, y] of hull) {
      const u = x * c + y * s;
      const v = y * c - x * s;
      if (u < u0) u0 = u;
      if (u > u1) u1 = u;
      if (v < v0) v0 = v;
      if (v > v1) v1 = v;
    }
    const area = (u1 - u0) * (v1 - v0);
    if (area < best) {
      best = area;
      bestAngle = angle;
    }
  }
  return bestAngle;
}

/** First and last bin once `trim` counts are dropped from each end. */
function span(h: Int32Array, bins: number, trim: number): [number, number] {
  let lo = 0;
  let acc = 0;
  while (lo < bins - 1 && (acc += h[lo]) <= trim) lo++;
  let hi = bins - 1;
  acc = 0;
  while (hi > lo && (acc += h[hi]) <= trim) hi--;
  return [lo, hi];
}

/** The new outline blended with the previous one (`keep` of the old). Reuses `prev`. */
function smoothOutline(prev: Float32Array | null, next: Float32Array, keep: number): Float32Array {
  if (!prev || keep <= 0) return next;
  for (let k = 0; k < OUTLINE_STEPS; k++) prev[k] = keep * prev[k] + (1 - keep) * next[k];
  return prev;
}

/**
 * The new rectangle, with angle and size blended with the previous one (`keep` of the old).
 * The centre is the new one: the picture is cut around it, so it must match this frame.
 */
function smoothRect(prev: Turned | null, next: Turned, keep: number): Turned {
  if (!prev || keep <= 0) return { ...next };
  let { hw, hh } = next;
  // A rectangle turned by 90° with its sides swapped is the same rectangle: take the
  // description closest to the previous one, so the blend does not spin it.
  let d = next.angle - prev.angle;
  d -= Math.PI * Math.round(d / Math.PI);
  if (Math.abs(d) > Math.PI / 4) {
    d -= Math.sign(d) * (Math.PI / 2);
    [hw, hh] = [hh, hw];
  }
  return {
    cx: next.cx,
    cy: next.cy,
    angle: prev.angle + (1 - keep) * d,
    hw: keep * prev.hw + (1 - keep) * hw,
    hh: keep * prev.hh + (1 - keep) * hh,
  };
}

/** Path of a rectangle with rounded corners (arcTo, which every browser has). */
function roundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
