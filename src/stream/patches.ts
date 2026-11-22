/**
 * Streaming to a Quest, its immersive view: instead of a whole picture, the Mac sends back for
 * each processed frame only what covers the phones (the fill, cut to the feathered mask, the
 * rest transparent), with the number of the camera frame it was made from (latency.ts). The
 * Quest draws it into the room where the camera was looking when it took that frame. The room
 * itself is the headset's own passthrough, with no delay.
 *
 * The extra cover: the patch is drawn a little off (lining up by hand) and late (the round trip),
 * so a phone's edge can show beside it. Around the fill, the patch therefore gets a border
 * `margin` pixels wide, of the picture around the phone (the phone already replaced by the
 * fill), blurred, with a soft outer edge: not accurate, but it covers the edge and fades into
 * the room.
 *
 * On a WebRTC data channel of the same connection as the video, straight between the devices.
 * Unordered and without retransmission: a late patch is worth less than the next one.
 *
 *   Quest → Mac (text)    {"type":"patch-mode","on":true,"full":false,"margin":16}   again every 2 s
 *                          on: the Quest is in its room view (otherwise the Mac sends nothing)
 *                          full: the whole frame instead (for lining up; see questXr.ts)
 *                          margin: extra cover around the phone, frame pixels (see below)
 *   Mac → Quest (binary)  [header length: uint32, little-endian][header: JSON][image: WebP]
 *                          header {"id":…,"w":640,"h":480,"kind":"patch"|"full"|"empty",
 *                                  "x":…,"y":…,"cw":…,"ch":…}
 *                          the image covers the rectangle x, y, cw × ch of the w × h frame
 *                          (around the phones; the whole frame for "full").
 *                          "empty": no image, nothing to cover in that frame.
 */
import type { Rect } from '../types';
import { readCounter } from './latency';

export const PATCH_CHANNEL = 'patches';

export type PatchKind = 'patch' | 'full' | 'empty';

export interface PatchHeader {
  /** The frame counter of the camera frame it was made from, -1 if unreadable. */
  id: number;
  /** The whole camera frame's size. */
  w: number;
  h: number;
  kind: PatchKind;
  /** The part of the frame the image covers (cw × ch at x, y). */
  x: number;
  y: number;
  cw: number;
  ch: number;
}

export interface Patch extends PatchHeader {
  image: Blob | null;
  /** When it arrived on the Quest (performance.now()). */
  receivedAt: number;
}

interface ModeMessage {
  type: 'patch-mode';
  on: boolean;
  full: boolean;
  margin?: number;
}

/** The data channel's options: fresh beats complete. */
export const PATCH_CHANNEL_INIT: RTCDataChannelInit = { ordered: false, maxRetransmits: 0 };

// ---------------------------------------------------------------- Mac side

/** One processed frame, as the pipeline hands it over. */
export interface DoneFrame {
  /** The camera frame the detection was made on (with the Quest's frame counter in it). */
  frame: HTMLCanvasElement;
  width: number;
  height: number;
  /** Whether anything is being covered in this frame. */
  present: boolean;
  /** Where in the frame (null: nothing covered). */
  roi: Rect | null;
  /** Frame-sized canvas whose alpha is the (feathered) mask of what is covered. */
  maskCanvas: HTMLCanvasElement;
  /** Draws what the effect puts over the camera frame (transparent elsewhere). */
  drawEffect(ctx: CanvasRenderingContext2D): void;
}

export interface PatchStats {
  /** Patches with something in them, empty ones, and frames skipped (busy, or channel full). */
  sent: number;
  empty: number;
  skipped: number;
  /** Frames whose counter could not be read (then id -1). */
  unreadable: number;
  /** Average size of a patch with an image, KB. */
  avgKB: number;
  full: boolean;
  /** Extra cover around the phone, frame pixels. */
  margin: number;
  /** Drawing and encoding one patch, ms (average). */
  encodeMs: number;
}

/** A canvas to draw on, and a reusable one of the frame's size. */
class Layer {
  readonly canvas = document.createElement('canvas');
  readonly ctx = this.canvas.getContext('2d')!;
  /** Cleared, sized `w` × `h`, drawing in frame coordinates shifted by (-x, -y). */
  fit(w: number, h: number, x = 0, y = 0): CanvasRenderingContext2D {
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.clearRect(0, 0, w, h);
    this.ctx.setTransform(1, 0, 0, 1, -x, -y);
    return this.ctx;
  }
}

/** Mac side: turns processed frames into patches for the Quest on its data channel. */
export class PatchServer {
  /** The Quest's frame width (from its offer): the counter's size depends on it. */
  senderWidth = 640;
  readonly stats: PatchStats = { sent: 0, empty: 0, skipped: 0, unreadable: 0, avgKB: 0, full: false, margin: 0, encodeMs: 0 };
  private dc: RTCDataChannel | null = null;
  private on = false;
  private full = false;
  private margin = 0;
  private busy = false;
  private out = new Layer();
  private after = new Layer();
  private grown = new Layer();
  private scratch = document.createElement('canvas').getContext('2d', { willReadFrequently: true })!;
  private encoder = new TextEncoder();

  /** The channel of a new connection (the old one is dropped). */
  attach(dc: RTCDataChannel): void {
    this.dc = dc;
    this.on = this.full = false;
    dc.binaryType = 'arraybuffer';
    dc.onmessage = (e) => {
      if (this.dc !== dc || typeof e.data !== 'string') return;
      try {
        const msg = JSON.parse(e.data) as ModeMessage;
        if (msg.type !== 'patch-mode') return;
        this.on = !!msg.on;
        this.full = this.stats.full = !!msg.full;
        this.margin = this.stats.margin = Math.max(0, Math.min(60, Math.round(Number(msg.margin) || 0)));
      } catch {
        /* not ours */
      }
    };
    dc.onclose = () => {
      if (this.dc === dc) this.dc = null;
    };
  }

  /** Whether a Quest wants patches right now. */
  get active(): boolean {
    return this.on && this.dc?.readyState === 'open';
  }

  /** Call once per processed frame. Cheap when no Quest listens; skips frames while busy. */
  frame(f: DoneFrame): void {
    const dc = this.dc;
    if (!this.on || !dc || dc.readyState !== 'open') return;
    if (this.busy || dc.bufferedAmount > 512 * 1024) {
      this.stats.skipped++;
      return;
    }
    const id = readCounter(this.scratch, f.frame, f.width, this.senderWidth);
    if (id < 0) this.stats.unreadable++;
    const kind: PatchKind = this.full ? 'full' : f.present ? 'patch' : 'empty';
    // Only the part around the phones is drawn and sent: much less to blur and encode.
    const pad = Math.ceil(this.margin * 2) + 4;
    const r = kind === 'full' || !f.roi ? { x: 0, y: 0, w: f.width, h: f.height } : f.roi;
    const x = Math.max(0, r.x - pad);
    const y = Math.max(0, r.y - pad);
    const cw = Math.min(f.width, r.x + r.w + pad) - x;
    const ch = Math.min(f.height, r.y + r.h + pad) - y;
    const header: PatchHeader = { id, w: f.width, h: f.height, kind, x, y, cw, ch };
    if (kind === 'empty' || cw <= 0 || ch <= 0) {
      this.stats.empty++;
      this.send(dc, { ...header, kind: 'empty' }, null);
      return;
    }
    const t0 = performance.now();
    const ctx = this.out.fit(cw, ch, x, y);
    if (kind === 'full') ctx.drawImage(f.frame, 0, 0);
    else if (this.margin > 0) this.drawBorder(f, ctx, header);
    f.drawEffect(ctx);
    const canvas = this.out.canvas;
    this.busy = true;
    canvas.toBlob(
      (blob) => {
        this.busy = false;
        this.stats.encodeMs += (performance.now() - t0 - this.stats.encodeMs) * 0.1;
        if (!blob || this.dc !== dc) return;
        void blob.arrayBuffer().then((bytes) => {
          if (this.send(dc, header, new Uint8Array(bytes))) {
            this.stats.sent++;
            this.stats.avgKB += (bytes.byteLength / 1024 - this.stats.avgKB) * 0.1;
          }
        });
      },
      'image/webp',
      header.kind === 'full' ? 0.6 : 0.8,
    );
  }

  /** The blurred border of the extra cover, into `ctx` (the fill is drawn over it afterwards). */
  private drawBorder(f: DoneFrame, ctx: CanvasRenderingContext2D, c: PatchHeader): void {
    const m = this.margin;
    // All three layers are the crop c (cw × ch at x, y), drawn in frame coordinates.
    // The picture with the phone already replaced, so the blur does not smear the phone outwards.
    const after = this.after.fit(c.cw, c.ch, c.x, c.y);
    after.drawImage(f.frame, c.x, c.y, c.cw, c.ch, c.x, c.y, c.cw, c.ch);
    f.drawEffect(after);
    // The mask grown by m: stamped around a circle of radius m (the phone is much larger than
    // the gaps this leaves), then softened.
    const grown = this.grown.fit(c.cw, c.ch, c.x, c.y);
    const stamp = (dx: number, dy: number) => grown.drawImage(f.maskCanvas, c.x, c.y, c.cw, c.ch, c.x + dx, c.y + dy, c.cw, c.ch);
    stamp(0, 0);
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * 2 * Math.PI;
      stamp(Math.cos(a) * m, Math.sin(a) * m);
    }
    ctx.filter = `blur(${Math.max(1, m / 2)}px)`;
    ctx.drawImage(this.after.canvas, c.x, c.y);
    ctx.globalCompositeOperation = 'destination-in';
    ctx.filter = `blur(${Math.max(1, m / 3)}px)`;
    ctx.drawImage(this.grown.canvas, c.x, c.y);
    ctx.filter = 'none';
    ctx.globalCompositeOperation = 'source-over';
  }

  private send(dc: RTCDataChannel, header: PatchHeader, image: Uint8Array | null): boolean {
    if (dc.readyState !== 'open') return false;
    const head = this.encoder.encode(JSON.stringify(header));
    const msg = new Uint8Array(4 + head.length + (image?.length ?? 0));
    new DataView(msg.buffer).setUint32(0, head.length, true);
    msg.set(head, 4);
    if (image) msg.set(image, 4 + head.length);
    // Larger than a data channel message may be (about 256 KB in Chrome): skip it.
    if (msg.length > 250 * 1024) {
      this.stats.skipped++;
      return false;
    }
    try {
      dc.send(msg);
      return true;
    } catch {
      this.stats.skipped++;
      return false;
    }
  }
}

// ---------------------------------------------------------------- Quest side

/** Quest side: receives the patches on the current connection's channel. */
export class PatchClient {
  onPatch: ((p: Patch) => void) | null = null;
  private dc: RTCDataChannel | null = null;
  private on = false;
  private full = false;
  private margin = 0;
  private decoder = new TextDecoder();

  constructor() {
    // Repeated: the channel does not retransmit, and a new Mac page starts with defaults.
    setInterval(() => this.sendMode(), 2000);
  }

  attach(dc: RTCDataChannel): void {
    this.dc = dc;
    dc.binaryType = 'arraybuffer';
    dc.onopen = () => this.sendMode();
    dc.onmessage = (e) => {
      if (this.dc !== dc || !(e.data instanceof ArrayBuffer)) return;
      const p = this.parse(e.data);
      if (p) this.onPatch?.(p);
    };
  }

  /** Ask for patches (the room view is on) or for nothing. */
  setOn(on: boolean): void {
    this.on = on;
    this.sendMode();
  }

  /** Extra cover around the phones, frame pixels. */
  setMargin(px: number): void {
    if (Math.round(px) === this.margin) return;
    this.margin = Math.round(px);
    this.sendMode();
  }

  /** Ask for whole frames (lining up) instead of patches. */
  setFull(full: boolean): void {
    this.full = full;
    this.sendMode();
  }

  get isFull(): boolean {
    return this.full;
  }

  private sendMode(): void {
    if (this.dc?.readyState !== 'open') return;
    this.dc.send(JSON.stringify({ type: 'patch-mode', on: this.on, full: this.full, margin: this.margin } satisfies ModeMessage));
  }

  private parse(data: ArrayBuffer): Patch | null {
    if (data.byteLength < 4) return null;
    const len = new DataView(data).getUint32(0, true);
    if (4 + len > data.byteLength) return null;
    try {
      const header = JSON.parse(this.decoder.decode(new Uint8Array(data, 4, len))) as PatchHeader;
      const rest = data.byteLength - 4 - len;
      const image = rest > 0 ? new Blob([new Uint8Array(data, 4 + len, rest)], { type: 'image/webp' }) : null;
      return { ...header, image, receivedAt: performance.now() };
    } catch {
      return null;
    }
  }
}
