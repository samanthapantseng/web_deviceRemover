// Hijack mode's sound: one voice per person in focus, through a shared room and a limiter.
//
//   voice ─┬─ dry ──────────────┐
//          └─ send → reverb ────┴→ volume → limiter → soft clip → ceiling → headphones
//                                                                   ├→ meter (levels for the panel)
//                                                                   └→ recording (only if asked)
//
// The limiter, the soft clip and the ceiling are there so that nothing (a bug, a resonating
// filter, many voices at once) can ever be louder than the ceiling: about -2 dB below full scale,
// at any volume setting.
//
// The engine works on a live AudioContext (LiveSound below) and on an OfflineAudioContext (the
// test renders sound files with it, faster than real time).
import type { CharacterId } from '../settings';
import { clamp01, makeVoice, type Kit, type Voice, type VoiceParams } from './voices';

/** Highest possible output sample value (0.8 = -1.9 dBFS). */
export const CEILING = 0.8;
/** How far ahead (s) rhythmic events are scheduled, and how often the scheduler runs (ms). */
const LOOKAHEAD = 0.3;
const TICK_MS = 50;
/** Without any update for this long (the camera stopped, the tab hidden), the sound fades out. */
const WATCHDOG_MS = 3000;

export interface Levels {
  /** dBFS over the last ~45 ms; -Infinity in silence. */
  rms: number;
  peak: number;
}

export class SoundEngine {
  readonly ctx: BaseAudioContext;
  private kit: Kit;
  private dry: GainNode;
  private wet: GainNode;
  private volume: GainNode;
  private final: GainNode;
  private meter: AnalyserNode;
  private meterData: Float32Array<ArrayBuffer>;
  private recordDest: MediaStreamAudioDestinationNode | null = null;
  private voices = new Set<Voice>();
  private current: Voice | null = null;
  private currentKey = '';
  private lastUpdate = 0;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(ctx: BaseAudioContext, volume: number) {
    this.ctx = ctx;
    this.kit = { ctx, noise: noiseBuffer(ctx) };
    this.dry = new GainNode(ctx);
    this.wet = new GainNode(ctx);
    const reverb = new ConvolverNode(ctx, { buffer: roomImpulse(ctx), disableNormalization: false });
    const ret = new GainNode(ctx, { gain: 0.7 });
    this.volume = new GainNode(ctx, { gain: volumeGain(volume) });
    const limiter = new DynamicsCompressorNode(ctx, { threshold: -12, knee: 4, ratio: 20, attack: 0.003, release: 0.25 });
    const clip = new WaveShaperNode(ctx, { curve: softClipCurve(), oversample: '2x' });
    this.final = new GainNode(ctx, { gain: CEILING });
    this.meter = new AnalyserNode(ctx, { fftSize: 2048 });
    this.meterData = new Float32Array(this.meter.fftSize);
    this.dry.connect(this.volume);
    this.wet.connect(reverb).connect(ret).connect(this.volume);
    this.volume.connect(limiter).connect(clip).connect(this.final);
    this.final.connect(ctx.destination);
    this.final.connect(this.meter);
  }

  /** Live use: schedule rhythmic events ahead and run the watchdog, on a timer. */
  startClock(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.current && performance.now() - this.lastUpdate > WATCHDOG_MS) this.release();
      this.scheduleUntil(this.ctx.currentTime + LOOKAHEAD);
    }, TICK_MS);
  }

  setVolume(v: number): void {
    this.volume.gain.setTargetAtTime(volumeGain(v), this.ctx.currentTime, 0.1);
  }

  /** The key of the voice in focus ('' when silent). */
  get focusKey(): string {
    return this.currentKey;
  }

  /**
   * Listen to someone: `key` identifies them (and their character). The same key again only
   * updates the numbers; a new key tunes the old voice out while the new one tunes in.
   */
  focus(key: string, character: CharacterId, seed: number, p: VoiceParams, at = this.ctx.currentTime): void {
    this.lastUpdate = performance.now();
    if (key === this.currentKey && this.current) return this.current.set(p, at);
    this.release(at);
    const v = makeVoice(character, this.kit, seed, this.dry, this.wet);
    v.start(p, at);
    this.burst(at, p.pan, 1);
    this.voices.add(v);
    this.current = v;
    this.currentKey = key;
    v.schedule(at + LOOKAHEAD);
  }

  /** New numbers for the voice in focus. */
  update(p: VoiceParams, at = this.ctx.currentTime): void {
    this.lastUpdate = performance.now();
    this.current?.set(p, at);
  }

  /** Tune out of the voice in focus: back to silence. */
  release(at = this.ctx.currentTime): void {
    if (!this.current) return;
    this.current.tuneOut(at);
    this.burst(at, 0, 0.35);
    this.current = null;
    this.currentKey = '';
  }

  /** Play a character for a few seconds without a phone (the panel's "Test sound"). */
  preview(character: CharacterId, seed: number, seconds = 5): void {
    const at = this.ctx.currentTime + 0.05;
    const v = makeVoice(character, this.kit, seed, this.dry, this.wet);
    v.start({ pan: 0, clarity: 1, closeness: 0.7, build: 0.6, activity: 0.3 }, at);
    v.tuneOut(at + seconds);
    this.burst(at, 0, 1);
    this.voices.add(v);
    v.schedule(at + LOOKAHEAD);
  }

  /** Schedule every voice's rhythmic events up to `until`, and let finished voices go. */
  scheduleUntil(until: number): void {
    const now = this.ctx.currentTime;
    for (const v of this.voices) {
      if (v.stopAt + 0.5 < now) {
        v.dispose();
        this.voices.delete(v);
      } else v.schedule(until);
    }
  }

  /** The output level now (what goes to the headphones). */
  levels(): Levels {
    this.meter.getFloatTimeDomainData(this.meterData);
    let sum = 0;
    let peak = 0;
    for (const x of this.meterData) {
      sum += x * x;
      peak = Math.max(peak, Math.abs(x));
    }
    const db = (v: number) => (v > 0 ? 20 * Math.log10(v) : -Infinity);
    return { rms: db(Math.sqrt(sum / this.meterData.length)), peak: db(peak) };
  }

  /** The output as a stream, for screen recordings with sound (live context only). */
  stream(): MediaStream | null {
    if (!(this.ctx instanceof AudioContext)) return null;
    if (!this.recordDest) {
      this.recordDest = new MediaStreamAudioDestinationNode(this.ctx);
      this.final.connect(this.recordDest);
    }
    return this.recordDest.stream;
  }

  /** A short sweep of radio-like noise: the sound of tuning in (or, quieter, out). */
  private burst(at: number, pan: number, strength: number): void {
    const { ctx } = this;
    const src = new AudioBufferSourceNode(ctx, { buffer: this.kit.noise, loop: true });
    const bp = new BiquadFilterNode(ctx, { type: 'bandpass', frequency: 3200, Q: 3 });
    const g = new GainNode(ctx, { gain: 0 });
    const pn = new StereoPannerNode(ctx, { pan: Math.max(-0.85, Math.min(0.85, pan)) });
    bp.frequency.setValueAtTime(3200, at);
    bp.frequency.exponentialRampToValueAtTime(450, at + 0.8);
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(0.25 * strength, at + 0.06);
    g.gain.setTargetAtTime(0, at + 0.15, 0.2);
    src.connect(bp).connect(g).connect(pn);
    pn.connect(this.dry);
    pn.connect(this.wet);
    src.start(at, Math.random() * 1.5);
    src.stop(at + 1.6);
  }
}

/** Volume setting (0..1) to gain: a curve, so the lower half of the slider is still usable. */
function volumeGain(v: number): number {
  return 1.6 * clamp01(v) ** 2;
}

function noiseBuffer(ctx: BaseAudioContext): AudioBuffer {
  const buf = ctx.createBuffer(1, Math.round(ctx.sampleRate * 2), ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return buf;
}

/** A dark room of about 2.5 s: decaying stereo noise, slightly smoothed. */
function roomImpulse(ctx: BaseAudioContext): AudioBuffer {
  const sr = ctx.sampleRate;
  const buf = ctx.createBuffer(2, Math.round(sr * 2.5), sr);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    let y = 0;
    for (let i = 0; i < d.length; i++) {
      const t = i / sr;
      y += 0.35 * (Math.random() * 2 - 1 - y);
      d[i] = y * Math.exp((-6.9 * t) / 2.5) * (t < 0.01 ? t / 0.01 : 1);
    }
  }
  return buf;
}

/** tanh-shaped curve: gentle saturation that can never go past ±1. */
function softClipCurve(): Float32Array<ArrayBuffer> {
  const n = 2048;
  const curve = new Float32Array(n);
  const k = 1.4;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(k * x) / Math.tanh(k);
  }
  return curve;
}

/**
 * The live sound for the page. Browsers only allow sound after the person has clicked or pressed
 * a key on the page; until then there is no audio context and `running` is false.
 */
export class LiveSound {
  engine: SoundEngine | null = null;
  private ctx: AudioContext | null = null;
  private volume = 0.5;
  /** Called when sound starts or stops being possible (to show or hide the "click for sound" hint). */
  onChange: () => void = () => undefined;

  /** Create the audio context if the browser allows it, and resume it. Cheap; call it often. */
  ensure(): void {
    if (!this.ctx) {
      // Before the first click or key press an AudioContext would start suspended (with a
      // warning in the console), so wait for it.
      const activation = (navigator as Navigator & { userActivation?: { hasBeenActive: boolean } }).userActivation;
      if (activation && !activation.hasBeenActive) return;
      try {
        this.ctx = new AudioContext({ latencyHint: 'playback' });
      } catch (err) {
        console.error('[sound] no audio context', err);
        return;
      }
      this.engine = new SoundEngine(this.ctx, this.volume);
      this.engine.startClock();
      this.ctx.onstatechange = () => this.onChange();
      this.onChange();
    }
    if (this.ctx.state !== 'running' && this.ctx.state !== 'closed') void this.ctx.resume().catch(() => undefined);
  }

  get running(): boolean {
    return this.ctx?.state === 'running';
  }

  setVolume(v: number): void {
    this.volume = v;
    this.engine?.setVolume(v);
  }

  stream(): MediaStream | null {
    return this.engine?.stream() ?? null;
  }
}
