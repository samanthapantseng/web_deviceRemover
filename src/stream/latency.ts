/**
 * Streaming mode, `?latency` on the iPad's stream page: measures the round trip
 * iPad → Mac → iPad. The camera picture is sent through a canvas that stamps a frame counter
 * into the top-left corner as a black and white bar code. The Mac processes it like any other
 * frame and sends it back; the iPad reads the counter from the frames it receives.
 *
 * This leaves out the camera's and the screen's own delay, but includes everything streaming
 * adds: encoding, Wi-Fi, decoding and processing on the Mac, twice.
 */

const BITS = 12;
const WRAP = 1 << BITS; // 4096 frames: over two minutes at 30 fps, far beyond any delay
/** Cell size in a 640 px wide frame; large, so it survives compression and downscaling. */
const CELL = 16;

function layout(w: number) {
  const cell = Math.max(4, Math.round((CELL * w) / 640));
  return { cell, margin: cell / 2 };
}

/** Sends the camera picture with a frame counter drawn into it. */
export class Stamper {
  readonly track: MediaStreamTrack;
  readonly width: number;
  readonly height: number;
  private canvas = document.createElement('canvas');
  private ctx: CanvasRenderingContext2D;
  private counter = 0;
  private sentAt = new Float64Array(WRAP);

  constructor(private video: HTMLVideoElement) {
    this.width = this.canvas.width = video.videoWidth;
    this.height = this.canvas.height = video.videoHeight;
    this.ctx = this.canvas.getContext('2d', { alpha: false })!;
    this.track = this.canvas.captureStream(30).getVideoTracks()[0];
    this.track.contentHint = 'motion';
    this.loop();
  }

  /** When the frame with this counter value was drawn (performance.now()), or 0. */
  sentTime(value: number): number {
    return this.sentAt[value % WRAP];
  }

  private loop(): void {
    const draw = () => {
      const { ctx, width: w, height: h } = this;
      ctx.drawImage(this.video, 0, 0, w, h);
      this.counter = (this.counter + 1) % WRAP;
      const { cell, margin } = layout(w);
      ctx.fillStyle = '#808080';
      ctx.fillRect(0, 0, margin * 2 + BITS * cell, margin * 2 + 2 * cell);
      for (let i = 0; i < BITS; i++) {
        const bit = (this.counter >> (BITS - 1 - i)) & 1;
        // Row 0: the counter. Row 1: its complement, to reject frames read mid-blend.
        ctx.fillStyle = bit ? '#fff' : '#000';
        ctx.fillRect(margin + i * cell, margin, cell, cell);
        ctx.fillStyle = bit ? '#000' : '#fff';
        ctx.fillRect(margin + i * cell, margin + cell, cell, cell);
      }
      this.sentAt[this.counter] = performance.now();
    };
    const v = this.video as HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number };
    if (typeof v.requestVideoFrameCallback === 'function') {
      const onFrame = () => {
        draw();
        v.requestVideoFrameCallback!(onFrame);
      };
      v.requestVideoFrameCallback(onFrame);
    } else {
      setInterval(draw, 1000 / 30);
    }
  }
}

/** Reads the counter back from received frames and keeps the recent round-trip times. */
export class StampReader {
  private canvas = document.createElement('canvas');
  private ctx = this.canvas.getContext('2d', { willReadFrequently: true })!;
  private samples: number[] = [];
  private last = -1;
  /** Frames whose bar code could not be read (covered, blurred, or not a test frame). */
  unreadable = 0;

  constructor(
    private stamper: Stamper,
    private keep = 300,
  ) {
    // 4 px per cell, sampled in the middle.
    this.canvas.width = BITS * 4;
    this.canvas.height = 2 * 4;
  }

  /** Call for every received frame. */
  read(video: HTMLVideoElement): void {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) return;
    // The bar code was drawn in the sender's frame size; the received frame may be scaled.
    const { cell, margin } = layout(this.stamper.width);
    const sx = vw / this.stamper.width;
    const sy = vh / this.stamper.height;
    this.ctx.drawImage(video, margin * sx, margin * sy, BITS * cell * sx, 2 * cell * sy, 0, 0, this.canvas.width, this.canvas.height);
    const px = this.ctx.getImageData(0, 0, this.canvas.width, this.canvas.height).data;
    const bit = (col: number, row: number) => {
      const i = ((row * 4 + 2) * this.canvas.width + col * 4 + 2) * 4;
      return px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114 > 128 ? 1 : 0;
    };
    let value = 0;
    for (let i = 0; i < BITS; i++) {
      const b = bit(i, 0);
      if (bit(i, 1) === b) {
        this.unreadable++;
        return;
      }
      value = (value << 1) | b;
    }
    if (value === this.last) return; // the same frame shown again
    this.last = value;
    const sent = this.stamper.sentTime(value);
    const ms = performance.now() - sent;
    if (!sent || ms < 0 || ms > 10_000) return;
    this.samples.push(ms);
    if (this.samples.length > this.keep) this.samples.shift();
  }

  reset(): void {
    this.samples = [];
    this.unreadable = 0;
  }

  summary(): { median: number; p95: number; n: number } | null {
    if (!this.samples.length) return null;
    const s = [...this.samples].sort((a, b) => a - b);
    const at = (q: number) => s[Math.min(s.length - 1, Math.floor(q * s.length))];
    return { median: at(0.5), p95: at(0.95), n: s.length };
  }
}
