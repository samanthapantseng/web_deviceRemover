/**
 * Streaming mode, `?latency` on the iPad's stream page: measures the round trip
 * iPad → Mac → iPad. On a Quest the counter is always on: it numbers the frames (see Stamper). The camera picture is sent through a canvas that stamps a frame counter
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

/** Draws the bar code for `counter` into the top-left corner of a `w` wide frame. */
function drawCounter(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, w: number, counter: number): void {
  const { cell, margin } = layout(w);
  ctx.fillStyle = '#808080';
  ctx.fillRect(0, 0, margin * 2 + BITS * cell, margin * 2 + 2 * cell);
  for (let i = 0; i < BITS; i++) {
    const bit = (counter >> (BITS - 1 - i)) & 1;
    // Row 0: the counter. Row 1: its complement, to reject frames read mid-blend.
    ctx.fillStyle = bit ? '#fff' : '#000';
    ctx.fillRect(margin + i * cell, margin, cell, cell);
    ctx.fillStyle = bit ? '#000' : '#fff';
    ctx.fillRect(margin + i * cell, margin + cell, cell, cell);
  }
}

/**
 * Reads the counter from a frame whose sender drew it `senderWidth` wide; the frame may since
 * have been scaled to `width` × … . -1 if it cannot be read (covered, blurred, no counter).
 * `scratch` is a small canvas reused between calls.
 */
export function readCounter(
  scratch: CanvasRenderingContext2D,
  source: CanvasImageSource,
  width: number,
  senderWidth: number,
): number {
  const { cell, margin } = layout(senderWidth);
  const s = width / senderWidth;
  scratch.canvas.width = BITS * 4;
  scratch.canvas.height = 2 * 4;
  scratch.drawImage(source, margin * s, margin * s, BITS * cell * s, 2 * cell * s, 0, 0, BITS * 4, 8);
  const px = scratch.getImageData(0, 0, BITS * 4, 8).data;
  const bit = (col: number, row: number) => {
    const i = ((row * 4 + 2) * BITS * 4 + col * 4 + 2) * 4;
    return px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114 > 128 ? 1 : 0;
  };
  let value = 0;
  for (let i = 0; i < BITS; i++) {
    const b = bit(i, 0);
    if (bit(i, 1) === b) return -1;
    value = (value << 1) | b;
  }
  return value;
}

/** The counter values are taken modulo this; enough for over two minutes at 30 fps. */
export const COUNTER_WRAP = WRAP;

// Chrome's "breakout box" (Quest Browser has it, Safari does not): camera frames as a stream of
// VideoFrames, and a video track fed with VideoFrames. Not in TypeScript's DOM types.
interface TrackProcessor {
  readable: ReadableStream<VideoFrame>;
}
interface TrackGenerator extends MediaStreamTrack {
  writable: WritableStream<VideoFrame>;
}
type ProcessorCtor = new (init: { track: MediaStreamTrack }) => TrackProcessor;
type GeneratorCtor = new (init: { kind: 'video' }) => TrackGenerator;
const Processor = (globalThis as unknown as { MediaStreamTrackProcessor?: ProcessorCtor }).MediaStreamTrackProcessor;
const Generator = (globalThis as unknown as { MediaStreamTrackGenerator?: GeneratorCtor }).MediaStreamTrackGenerator;

/**
 * Sends the camera picture with a frame counter drawn into it. On the iPad (`?latency`) to
 * measure the round trip; on a Quest always, so that whatever the Mac sends back for a frame
 * can be matched with where the head was when that frame was taken.
 *
 * Two ways to do it. With the breakout box (Quest Browser), each camera frame is taken as it
 * arrives, stamped and passed on: one frame out per frame in, at the camera's own pace, and
 * it keeps going while the page is not being drawn (in the immersive view the 2D page is not).
 * Elsewhere, a canvas redrawn on every camera frame and captured as a video track.
 */
export class Stamper {
  readonly track: MediaStreamTrack;
  readonly width: number;
  readonly height: number;
  /** 'frames' (the breakout box) or 'canvas'. */
  readonly method: 'frames' | 'canvas';
  /** Called after each stamped frame, with the counter and when it was stamped (performance.now()). */
  onFrame: ((counter: number, at: number) => void) | null = null;
  private canvas: HTMLCanvasElement | OffscreenCanvas;
  private ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  private counter = 0;
  private sentAt = new Float64Array(WRAP);
  private writer: WritableStreamDefaultWriter<VideoFrame> | null = null;
  private reading = 0;

  /** `camera`: the camera track (used with the breakout box); `video`: the same camera, playing. */
  constructor(
    private video: HTMLVideoElement,
    camera?: MediaStreamTrack,
  ) {
    this.width = video.videoWidth;
    this.height = video.videoHeight;
    if (camera && Processor && Generator && typeof OffscreenCanvas !== 'undefined' && typeof VideoFrame !== 'undefined') {
      this.method = 'frames';
      this.canvas = new OffscreenCanvas(this.width, this.height);
      this.ctx = this.canvas.getContext('2d', { alpha: false })!;
      const gen = new Generator({ kind: 'video' });
      this.writer = gen.writable.getWriter();
      this.track = gen;
      this.setCamera(camera);
    } else {
      this.method = 'canvas';
      const c = document.createElement('canvas');
      c.width = this.width;
      c.height = this.height;
      this.canvas = c;
      this.ctx = c.getContext('2d', { alpha: false })!;
      this.track = c.captureStream(30).getVideoTracks()[0];
      this.loop();
    }
    this.track.contentHint = 'motion';
  }

  /** When the frame with this counter value was drawn (performance.now()), or 0. */
  sentTime(value: number): number {
    return this.sentAt[value % WRAP];
  }

  /** The camera was reopened (breakout box only; the canvas follows the video element). */
  setCamera(camera: MediaStreamTrack): void {
    if (this.method !== 'frames' || !Processor) return;
    const run = ++this.reading;
    const reader = new Processor({ track: camera }).readable.getReader();
    void (async () => {
      try {
        while (run === this.reading) {
          const { value: frame, done } = await reader.read();
          if (done || !frame) break;
          if (run !== this.reading) {
            frame.close();
            break;
          }
          const timestamp = frame.timestamp;
          this.ctx.drawImage(frame, 0, 0, this.width, this.height);
          frame.close();
          this.stamp();
          const out = new VideoFrame(this.canvas as OffscreenCanvas, { timestamp });
          await this.writer!.write(out).catch(() => out.close());
        }
      } catch (err) {
        console.error('[stream] the camera frame loop stopped', err);
      } finally {
        reader.releaseLock();
      }
    })();
  }

  private stamp(): void {
    this.counter = (this.counter + 1) % WRAP;
    drawCounter(this.ctx, this.width, this.counter);
    const now = performance.now();
    this.sentAt[this.counter] = now;
    this.onFrame?.(this.counter, now);
  }

  private loop(): void {
    const draw = () => {
      this.ctx.drawImage(this.video, 0, 0, this.width, this.height);
      this.stamp();
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
  private ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true })!;
  private samples: number[] = [];
  private last = -1;
  /** Frames whose bar code could not be read (covered, blurred, or not a test frame). */
  unreadable = 0;

  constructor(
    private stamper: Stamper,
    private keep = 300,
  ) {}

  /** Call for every received frame. */
  read(video: HTMLVideoElement): void {
    if (!video.videoWidth || !video.videoHeight) return;
    // The bar code was drawn in the sender's frame size; the received frame may be scaled.
    const value = readCounter(this.ctx, video, video.videoWidth, this.stamper.width);
    if (value < 0) {
      this.unreadable++;
      return;
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
