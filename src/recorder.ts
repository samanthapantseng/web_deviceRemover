/**
 * Screen recording of the "after" picture only, into a video file, on the device that shows it.
 *
 * - Mac (main.ts): the view as on screen, mirrored as shown, without the mask overlay or the
 *   panel (paint()).
 * - iPad, streaming mode (stream/ipad.ts): the picture the Mac sends back, mirrored as shown
 *   (draw()). Nothing extra goes over the network.
 *
 * Each frame is drawn into a canvas whose stream goes to a MediaRecorder. When no new frame
 * comes (a reconnect on the iPad) the recording holds the last picture.
 */

/** In order of preference: MP4 (Safari, recent Chrome) plays everywhere, including Photos. */
const TYPES = ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
/** The same with sound: AAC in MP4 first (plays everywhere), then Opus. */
const AV_TYPES = [
  'video/mp4;codecs=avc1,mp4a.40.2',
  'video/mp4;codecs=avc1,opus',
  'video/mp4',
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
];

export class ScreenRecorder {
  /** The finished recording, kept until the next one starts (to save it again). */
  last: File | null = null;
  /** Called when recording starts or stops, and when a file is ready. */
  onChange: () => void = () => undefined;
  /** Called with the finished file. */
  onFile: (file: File) => void = () => undefined;

  private canvas = document.createElement('canvas');
  private ctx = this.canvas.getContext('2d')!;
  private rec: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private startedAt = 0;
  private limit: ReturnType<typeof setTimeout> | undefined;

  static get supported(): boolean {
    return typeof MediaRecorder !== 'undefined' && typeof HTMLCanvasElement.prototype.captureStream === 'function';
  }

  get recording(): boolean {
    return !!this.rec;
  }

  /** Seconds since the recording started. */
  get seconds(): number {
    return this.rec ? (performance.now() - this.startedAt) / 1000 : 0;
  }

  /**
   * Start recording at `width`×`height` (the size of the picture shown now). Stops by itself
   * after `maxSeconds`, so a forgotten recording does not fill the iPad's memory. With `audio`
   * (hijack mode's sound), the file has that sound too.
   */
  start(width: number, height: number, name: string, maxSeconds: number, audio?: MediaStream | null): void {
    if (this.rec) return;
    this.last = null; // let the previous recording's memory go
    this.canvas.width = width;
    this.canvas.height = height;
    this.ctx.fillStyle = '#000';
    this.ctx.fillRect(0, 0, width, height);
    const stream = this.canvas.captureStream(30);
    // A copy of the sound's track: stopping the recording stops its tracks, and the sound's own
    // track must survive for the next recording.
    const audioTracks = audio?.getAudioTracks().map((t) => t.clone()) ?? [];
    audioTracks.forEach((t) => stream.addTrack(t));
    const types = audioTracks.length ? AV_TYPES : TYPES;
    const mimeType = types.find((t) => MediaRecorder.isTypeSupported(t)) ?? '';
    const rec = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 4_000_000, audioBitsPerSecond: 160_000 });
    this.chunks = [];
    rec.ondataavailable = (e) => e.data.size && this.chunks.push(e.data);
    rec.onstop = () => {
      const type = rec.mimeType || mimeType || 'video/mp4';
      const file = new File(this.chunks, `${name}.${type.includes('mp4') ? 'mp4' : 'webm'}`, { type: type.split(';')[0] });
      this.chunks = [];
      this.last = file;
      this.onChange();
      this.onFile(file);
    };
    rec.start(1000); // a piece every second, so a long recording is not one huge buffer at the end
    this.rec = rec;
    this.startedAt = performance.now();
    this.limit = setTimeout(() => this.stop(), maxSeconds * 1000);
    this.onChange();
  }

  stop(): void {
    const rec = this.rec;
    if (!rec) return;
    clearTimeout(this.limit);
    this.rec = null;
    rec.stop(); // onstop delivers the file
    rec.stream.getTracks().forEach((t) => t.stop());
    this.onChange();
  }

  /** Let `fn` draw the frame straight into the recording (a canvas of the size given to start()). */
  paint(fn: (ctx: CanvasRenderingContext2D) => void): void {
    if (!this.rec) return;
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    fn(this.ctx);
  }

  /** Add the picture now on screen. Call for every frame shown. */
  draw(src: CanvasImageSource, srcWidth: number, srcHeight: number, mirror: boolean): void {
    if (!this.rec || !srcWidth || !srcHeight) return;
    const { width, height } = this.canvas;
    // Fit (the size could change mid-recording, e.g. the iPad turned): letterbox, never stretch.
    const s = Math.min(width / srcWidth, height / srcHeight);
    const w = srcWidth * s;
    const h = srcHeight * s;
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (w < width || h < height) ctx.fillRect(0, 0, width, height);
    if (mirror) ctx.setTransform(-1, 0, 0, 1, width, 0);
    ctx.drawImage(src, (width - w) / 2, (height - h) / 2, w, h);
  }
}
