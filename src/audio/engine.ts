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
// Around each voice the engine adds the outside world, for a moment only (silence otherwise):
// breaking in, the low rumble of the carriage is heard under the stuttering signal and is cut
// off when the seal closes (a soft thump and the hiss of noise cancelling); pushed out, the
// rumble comes back for a moment before the silence.
//
// The engine works on a live AudioContext (LiveSound below) and on an OfflineAudioContext (the
// test renders sound files with it, faster than real time).
import type { CharacterId } from '../settings';
import { BREAK_IN_S, clamp01, makeVoice, type Kit, type Voice, type VoiceParams } from './voices';

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
  /** Brown noise: the carriage's rumble. */
  private rumble: AudioBuffer;
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
    this.kit = { ctx, noise: noiseBuffer(ctx), crush: crushCurve(), strain: tanhCurve(1) };
    this.rumble = brownNoise(ctx);
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
   * Listen to someone: `key` identifies them (and their character), `elapsed` is how long
   * (s) their sound has been playing already. The same key again only updates the numbers; a
   * new key pushes the old voice out while the new one breaks in.
   */
  focus(key: string, character: CharacterId, seed: number, p: VoiceParams, elapsed = 0, at = this.ctx.currentTime): void {
    this.lastUpdate = performance.now();
    if (key === this.currentKey && this.current) return this.current.set(p, at);
    const switching = !!this.current;
    this.release(at, !switching);
    const v = makeVoice(character, this.kit, seed, this.dry, this.wet);
    v.start(p, at, elapsed);
    this.breakIn(at);
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

  /** Push out of the voice in focus: back to silence (with `outside`, through a moment of the rumble). */
  release(at = this.ctx.currentTime, outside = true): void {
    if (!this.current) return;
    this.current.tuneOut(at);
    if (outside) this.pushOut(at);
    this.current = null;
    this.currentKey = '';
  }

  /** Play a character for a few seconds without a phone (the panel's "Test sound"). */
  preview(character: CharacterId, seed: number, seconds = 5): void {
    const at = this.ctx.currentTime + 0.05;
    const v = makeVoice(character, this.kit, seed, this.dry, this.wet);
    v.start({ pan: 0, clarity: 1, closeness: 0.7, build: 0.6, activity: 0.3 }, at, Math.random() * 90);
    v.tuneOut(at + seconds);
    this.breakIn(at);
    this.pushOut(at + seconds);
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

  /** The carriage's rumble under the breaking-in signal, cut off by the seal: a thump and a hiss. */
  private breakIn(at: number): void {
    const { ctx } = this;
    const seal = at + BREAK_IN_S;
    const rumble = this.rumbleAt(at, seal + 0.3);
    rumble.setValueAtTime(0, at);
    rumble.setTargetAtTime(0.22, at, 0.08);
    rumble.setTargetAtTime(0, seal, 0.02);
    // The thump of the seal: a soft, very low knock.
    const knock = new OscillatorNode(ctx, { frequency: 70 });
    const kg = new GainNode(ctx, { gain: 0 });
    knock.frequency.setValueAtTime(70, seal);
    knock.frequency.exponentialRampToValueAtTime(40, seal + 0.12);
    kg.gain.setValueAtTime(0, seal);
    kg.gain.linearRampToValueAtTime(0.35, seal + 0.006);
    kg.gain.exponentialRampToValueAtTime(0.0005, seal + 0.18);
    knock.connect(kg).connect(this.dry);
    knock.start(seal);
    knock.stop(seal + 0.2);
    // The hiss of noise cancelling closing in, fading.
    const hiss = new AudioBufferSourceNode(ctx, { buffer: this.kit.noise, loop: true });
    const hp = new BiquadFilterNode(ctx, { type: 'highpass', frequency: 3500 });
    const hg = new GainNode(ctx, { gain: 0 });
    hg.gain.setValueAtTime(0, seal);
    hg.gain.linearRampToValueAtTime(0.03, seal + 0.02);
    hg.gain.setTargetAtTime(0, seal + 0.05, 0.4);
    hiss.connect(hp).connect(hg).connect(this.dry);
    hiss.start(seal, Math.random() * 1.5);
    hiss.stop(seal + 2.5);
  }

  /** Pushed out: the rumble of the outside for a moment, then silence. */
  private pushOut(at: number): void {
    const rumble = this.rumbleAt(at, at + 2);
    rumble.setValueAtTime(0, at);
    rumble.setTargetAtTime(0.16, at, 0.05);
    rumble.setTargetAtTime(0, at + 0.25, 0.25);
  }

  /** A rumble source playing from `at` to `until`; returns its level to shape. */
  private rumbleAt(at: number, until: number): AudioParam {
    const { ctx } = this;
    const src = new AudioBufferSourceNode(ctx, { buffer: this.rumble, loop: true });
    const lp = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 180 });
    const g = new GainNode(ctx, { gain: 0 });
    src.connect(lp).connect(g).connect(this.dry);
    src.start(at, Math.random() * 2);
    src.stop(until);
    return g.gain;
  }
}

/** Volume setting (0..1) to gain: a curve, so the lower half of the slider is still usable. */
function volumeGain(v: number): number {
  return 1.6 * clamp01(v) ** 2;
}

/** Brown noise (integrated white noise, normalised): a low, soft rumble. */
function brownNoise(ctx: BaseAudioContext): AudioBuffer {
  const buf = ctx.createBuffer(1, Math.round(ctx.sampleRate * 3), ctx.sampleRate);
  const d = buf.getChannelData(0);
  let b = 0;
  let peak = 0;
  for (let i = 0; i < d.length; i++) {
    b = (b + 0.02 * (Math.random() * 2 - 1)) / 1.02;
    d[i] = b;
    peak = Math.max(peak, Math.abs(b));
  }
  for (let i = 0; i < d.length; i++) d[i] /= peak || 1;
  return buf;
}

/** Staircase curve: the signal rounded to coarse steps (about 4 bits), the sound of a bad digital link. */
function crushCurve(): Float32Array<ArrayBuffer> {
  const n = 4096;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) curve[i] = Math.round(((i / (n - 1)) * 2 - 1) * 8) / 8;
  return curve;
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
  return tanhCurve(1.4, true);
}

/**
 * tanh(k·x) over -1..1 (inputs beyond are held at the ends). `normalise`: scaled so ±1 maps to
 * ±1; otherwise plain tanh, which is close to x for small signals.
 */
function tanhCurve(k: number, normalise = false): Float32Array<ArrayBuffer> {
  const n = 4096;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(k * x) / (normalise ? Math.tanh(k) : 1);
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
