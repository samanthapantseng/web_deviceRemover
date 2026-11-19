// The sound characters of hijack mode, all synthesised with the Web Audio API: no recordings.
//
// A Voice is one person's soundscape. The engine (engine.ts) gives it a few numbers about the
// phone in focus, about 25 times a second, and the voice turns them into sound:
//
//   pan        where the phone is, left to right
//   clarity    how centred it is in the focus zone: muffled at the edge, clear in the middle
//   closeness  how big the phone is in the picture: louder, drier and brighter when close
//   build      how long it has been held: more layers the longer someone is on their phone
//   activity   how much the phone moves: busier rhythm, faster movement
//
// Every change is a smooth glide (setTargetAtTime), never a jump, so nothing clicks. Each
// character connects its sound to `input`; the base class does the muffling, panning, level
// and the "tuning in / out" glide that all characters share.
import type { CharacterId } from '../settings';

export interface VoiceParams {
  pan: number;
  clarity: number;
  closeness: number;
  build: number;
  activity: number;
}

/** What every voice needs from the engine: the audio context and a shared noise buffer. */
export interface Kit {
  ctx: BaseAudioContext;
  /** 2 s of white noise, looped by noise sources (started at random offsets). */
  noise: AudioBuffer;
}

/** How clarity is heard: a low-pass that opens (muffled → clear) or a high-pass that opens (tinny → full). */
interface ToneShape {
  type: BiquadFilterType;
  /** Cut-off at clarity 0 (and while tuned out), Hz. */
  closed: number;
  /** Cut-off at clarity 1, Hz. */
  open: number;
}

export const mtof = (m: number) => 440 * 2 ** ((m - 69) / 12);
export const clamp01 = (v: number) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);
const clampPan = (v: number) => (Number.isFinite(v) ? Math.min(0.85, Math.max(-0.85, v)) : 0);
const PENTATONIC = [0, 3, 5, 7, 10];

/** Small seeded random number generator: the same seed gives the same person the same variations. */
export function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export abstract class Voice {
  abstract readonly character: CharacterId;
  /** When the voice has faded out and stops (context time); Infinity while it plays. */
  stopAt = Infinity;

  protected readonly ctx: BaseAudioContext;
  /** Characters connect their sound here. */
  protected readonly input: GainNode;
  protected readonly rng: () => number;
  protected p: VoiceParams = { pan: 0, clarity: 0, closeness: 0.5, build: 0, activity: 0 };
  /** Continuous sources (oscillators, noise, LFOs), stopped when the voice ends. */
  protected readonly sources: AudioScheduledSourceNode[] = [];
  /** Detune of continuous oscillators, for the pitch glide when tuning in and out. */
  protected readonly glide: AudioParam[] = [];
  /** All nodes, disconnected when the voice ends. */
  private readonly nodes: AudioNode[] = [];

  private readonly tone: BiquadFilterNode;
  private readonly panner: StereoPannerNode;
  private readonly level: GainNode;
  private readonly send: GainNode;
  private inAt = 0;
  private outAt = Infinity;

  constructor(
    protected readonly kit: Kit,
    seed: number,
    dry: AudioNode,
    wet: AudioNode,
    private readonly shape: ToneShape,
  ) {
    this.ctx = kit.ctx;
    this.rng = mulberry32(seed);
    this.input = this.node(new GainNode(this.ctx, { gain: 1 }));
    this.tone = this.node(new BiquadFilterNode(this.ctx, { type: shape.type, frequency: shape.closed, Q: 0.8 }));
    this.panner = this.node(new StereoPannerNode(this.ctx, { pan: 0 }));
    this.level = this.node(new GainNode(this.ctx, { gain: 0 }));
    this.send = this.node(new GainNode(this.ctx, { gain: 0.3 }));
    this.input.connect(this.tone).connect(this.panner).connect(this.level);
    this.level.connect(dry);
    this.level.connect(this.send).connect(wet);
  }

  /** Start the continuous sources of this character at `at`. */
  protected abstract begin(at: number): void;
  /** React to `this.p` (the base already handles tone, pan, level and reverb). */
  protected abstract shapeParams(at: number, tau: number): void;
  /** Schedule rhythmic events up to `until` (context time). */
  protected events(_until: number): void {}

  /** Register a node so it is disconnected when the voice ends. */
  protected node<T extends AudioNode>(n: T): T {
    this.nodes.push(n);
    return n;
  }

  /** A continuous source: started now, stopped with the voice. */
  protected source<T extends AudioScheduledSourceNode>(n: T, at: number, offset?: number): T {
    this.node(n);
    this.sources.push(n);
    if (n instanceof AudioBufferSourceNode) n.start(at, offset ?? 0);
    else n.start(at);
    return n;
  }

  /** A looped noise source, started at a random point so two of them are not the same noise. */
  protected noise(at: number): AudioBufferSourceNode {
    const src = new AudioBufferSourceNode(this.ctx, { buffer: this.kit.noise, loop: true });
    return this.source(src, at, this.rng() * (this.kit.noise.duration - 0.1));
  }

  /** Pitch bend (cents) at time t: slides up into tune when tuning in, sags when tuning out. */
  protected bendAt(t: number): number {
    const into = -70 * Math.exp(-Math.max(0, t - this.inAt) / 0.25);
    const out = t > this.outAt ? -45 * (1 - Math.exp(-(t - this.outAt) / 0.5)) : 0;
    return into + out;
  }

  /** Start sounding at `at`, tuning in from muffled and slightly flat. */
  start(p: VoiceParams, at: number): void {
    this.inAt = at;
    this.p = sanitise(p);
    this.begin(at);
    for (const d of this.glide) {
      d.setValueAtTime(-70, at);
      d.setTargetAtTime(0, at, 0.25);
    }
    this.apply(at, 0.45);
  }

  /** New numbers for this voice. */
  set(p: VoiceParams, at: number): void {
    if (at >= this.outAt) return;
    this.p = sanitise(p);
    // Slower glides while still tuning in, so the opening is heard as tuning, not as a jump.
    this.apply(at, at - this.inAt < 1.2 ? 0.45 : 0.2);
  }

  /** Fade out over about `seconds`, muffling and sagging in pitch on the way; then stop. */
  tuneOut(at: number, seconds = 1.5): void {
    if (this.outAt <= at) return;
    this.outAt = at;
    const tau = seconds / 4;
    this.level.gain.cancelScheduledValues(at);
    this.level.gain.setTargetAtTime(0, at, tau);
    this.tone.frequency.cancelScheduledValues(at);
    this.tone.frequency.setTargetAtTime(this.shape.closed, at, tau * 1.5);
    for (const d of this.glide) d.setTargetAtTime(-45, at, 0.5);
    // By then the level is e^-12 (about -100 dB) below where it was: stopping there cannot click.
    this.stopAt = at + seconds * 3;
    for (const s of this.sources) s.stop(this.stopAt);
  }

  /** Schedule what this voice plays up to `until`. */
  schedule(until: number): void {
    this.events(Math.min(until, this.stopAt));
  }

  dispose(): void {
    for (const n of this.nodes) n.disconnect();
  }

  private apply(at: number, tau: number): void {
    const p = this.p;
    const { closed, open } = this.shape;
    this.tone.frequency.setTargetAtTime(closed * (open / closed) ** p.clarity, at, tau);
    this.panner.pan.setTargetAtTime(p.pan, at, 0.25);
    this.level.gain.setTargetAtTime((0.45 + 0.55 * p.closeness) * (0.5 + 0.5 * p.clarity), at, tau * 0.8);
    // Far away: more room, less direct sound.
    this.send.gain.setTargetAtTime(0.12 + 0.45 * (1 - p.closeness), at, 0.4);
    this.shapeParams(at, tau);
  }
}

function sanitise(p: VoiceParams): VoiceParams {
  return {
    pan: clampPan(p.pan),
    clarity: clamp01(p.clarity),
    closeness: clamp01(p.closeness),
    build: clamp01(p.build),
    activity: clamp01(p.activity),
  };
}

/** A feedback echo: input → (delay → feedback ↺) → output, plus the dry signal. */
function echo(ctx: BaseAudioContext, node: <T extends AudioNode>(n: T) => T, time: number, feedback: number, wet: number) {
  const inp = node(new GainNode(ctx));
  const out = node(new GainNode(ctx));
  const delay = node(new DelayNode(ctx, { delayTime: time, maxDelayTime: 2 }));
  const fb = node(new GainNode(ctx, { gain: feedback }));
  const damp = node(new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 2500 }));
  const wetGain = node(new GainNode(ctx, { gain: wet }));
  inp.connect(out);
  inp.connect(delay).connect(damp).connect(fb).connect(delay);
  damp.connect(wetGain).connect(out);
  return { inp, out, fb };
}

// ---------------------------------------------------------------------------------------------
// 1. Low drone: detuned saws and a sub, slowly breathing through a resonant low-pass. Holding the
//    phone longer adds a fifth, then an octave; moving it adds a tremolo.

const DRONE_LEVEL = 0.38;

class Drone extends Voice {
  readonly character = 'drone';
  private root = 38 + Math.floor(this.rng() * 12);
  private fifth!: GainNode;
  private octave!: GainNode;
  private lp!: BiquadFilterNode;
  private tremRate!: OscillatorNode;
  private tremDepth!: GainNode;
  private amp!: GainNode;

  protected begin(at: number): void {
    const { ctx } = this;
    const f = mtof(this.root);
    this.lp = this.node(new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 450, Q: 2.5 }));
    this.amp = this.node(new GainNode(ctx, { gain: DRONE_LEVEL }));
    this.lp.connect(this.amp).connect(this.input);
    const osc = (type: OscillatorType, freq: number, detune: number, gain: number) => {
      const o = this.source(new OscillatorNode(ctx, { type, frequency: freq, detune }), at);
      const g = this.node(new GainNode(ctx, { gain }));
      o.connect(g).connect(this.lp);
      this.glide.push(o.detune);
      return g;
    };
    osc('sawtooth', f, 7, 0.22);
    osc('sawtooth', f, -7, 0.22);
    osc('sine', f / 2, 0, 0.55);
    this.fifth = osc('sawtooth', f * 1.5, 3, 0);
    this.octave = osc('triangle', f * 2, -4, 0);
    // The filter breathes on its own, slowly (10 to 20 s a cycle).
    const lfo = this.source(new OscillatorNode(ctx, { frequency: 0.05 + this.rng() * 0.05 }), at);
    lfo.connect(this.node(new GainNode(ctx, { gain: 220 }))).connect(this.lp.frequency);
    this.tremRate = this.source(new OscillatorNode(ctx, { frequency: 0.3 }), at);
    this.tremDepth = this.node(new GainNode(ctx, { gain: 0.03 }));
    this.tremRate.connect(this.tremDepth).connect(this.amp.gain);
  }

  protected shapeParams(at: number, tau: number): void {
    const { build, activity } = this.p;
    this.fifth.gain.setTargetAtTime(0.16 * clamp01(build * 2), at, tau * 2);
    this.octave.gain.setTargetAtTime(0.14 * clamp01(build * 2 - 1), at, tau * 2);
    this.lp.frequency.setTargetAtTime(380 + 700 * build, at, tau * 2);
    this.tremRate.frequency.setTargetAtTime(0.3 + 5 * activity, at, 0.3);
    this.tremDepth.gain.setTargetAtTime(DRONE_LEVEL * (0.06 + 0.5 * activity), at, 0.3);
  }
}

// ---------------------------------------------------------------------------------------------
// 2. Soft pulse: a slow, repeating figure of soft notes with an echo. Moving the phone adds notes
//    in between; holding it longer adds high notes and a longer echo.

class Pulse extends Voice {
  readonly character = 'pulse';
  private root = 50 + Math.floor(this.rng() * 12);
  private sixteenth = 60 / (70 + Math.floor(this.rng() * 30)) / 4;
  private pattern: (number | null)[] = Array.from({ length: 16 }, (_, i) =>
    i % 2 || this.rng() < 0.35 ? null : PENTATONIC[Math.floor(this.rng() * 5)] + (this.rng() < 0.3 ? 12 : 0),
  );
  private step = 0;
  private next = 0;
  private bus!: GainNode;
  private fb!: GainNode;

  protected begin(at: number): void {
    const lp = this.node(new BiquadFilterNode(this.ctx, { type: 'lowpass', frequency: 2400 }));
    const e = echo(this.ctx, (n) => this.node(n), this.sixteenth * 3, 0.3, 0.35);
    this.bus = this.node(new GainNode(this.ctx, { gain: 1.2 }));
    this.bus.connect(lp).connect(e.inp);
    e.out.connect(this.input);
    this.fb = e.fb;
    if (!this.pattern.some((n) => n !== null)) this.pattern[0] = 0;
    this.next = at + 0.05;
  }

  protected shapeParams(at: number, tau: number): void {
    this.fb.gain.setTargetAtTime(0.28 + 0.27 * this.p.build, at, tau * 2);
  }

  protected events(until: number): void {
    while (this.next < until) {
      const t = this.next;
      const s = this.step % 16;
      const n = this.pattern[s];
      if (n !== null) this.note(t, this.root + n, 0.5);
      // Moving: notes in between, softer.
      else if (s % 2 && this.rng() < this.p.activity * 0.7) this.note(t, this.root + (this.pattern[(s + 1) % 16] ?? 7), 0.25);
      // Held long: an octave above on the beats.
      if (s % 8 === 0 && this.rng() < this.p.build) this.note(t, this.root + 12 + PENTATONIC[Math.floor(this.rng() * 5)], 0.22);
      this.step++;
      this.next += this.sixteenth;
    }
  }

  private note(t: number, midi: number, vel: number): void {
    const { ctx } = this;
    const f = mtof(midi);
    const detune = this.bendAt(t);
    const a = new OscillatorNode(ctx, { type: 'triangle', frequency: f, detune });
    const b = new OscillatorNode(ctx, { type: 'sine', frequency: f * 2, detune });
    const g = new GainNode(ctx, { gain: 0 });
    const gb = new GainNode(ctx, { gain: 0.3 });
    a.connect(g);
    b.connect(gb).connect(g);
    g.connect(this.bus);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vel, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0008, t + 0.55);
    a.start(t);
    b.start(t);
    a.stop(t + 0.6);
    b.stop(t + 0.6);
  }
}

// ---------------------------------------------------------------------------------------------
// 3. Noise wash: filtered noise that swells and recedes like breath or surf, over a low rumble.
//    Moving the phone makes the swells faster; holding it longer brings in a quiet chord.

class Wash extends Voice {
  readonly character = 'wash';
  private root = 50 + Math.floor(this.rng() * 12);
  private swellRate!: OscillatorNode;
  private pad!: GainNode;
  private bp!: BiquadFilterNode;

  protected begin(at: number): void {
    const { ctx } = this;
    this.bp = this.node(new BiquadFilterNode(ctx, { type: 'bandpass', frequency: 800 + this.rng() * 500, Q: 1.1 }));
    const swell = this.node(new GainNode(ctx, { gain: 0.55 }));
    this.noise(at).connect(this.bp).connect(swell).connect(this.input);
    const sweep = this.source(new OscillatorNode(ctx, { frequency: 0.04 + this.rng() * 0.04 }), at);
    sweep.connect(this.node(new GainNode(ctx, { gain: 500 }))).connect(this.bp.frequency);
    this.swellRate = this.source(new OscillatorNode(ctx, { frequency: 0.1 }), at);
    this.swellRate.connect(this.node(new GainNode(ctx, { gain: 0.42 }))).connect(swell.gain);
    const rumble = this.node(new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 220 }));
    this.noise(at).connect(rumble).connect(this.node(new GainNode(ctx, { gain: 0.5 }))).connect(this.input);
    this.pad = this.node(new GainNode(ctx, { gain: 0 }));
    this.pad.connect(this.input);
    for (const m of [this.root, this.root + 7, this.root + 15]) {
      const o = this.source(new OscillatorNode(ctx, { type: 'sine', frequency: mtof(m) }), at);
      o.connect(this.pad);
      this.glide.push(o.detune);
    }
  }

  protected shapeParams(at: number, tau: number): void {
    this.swellRate.frequency.setTargetAtTime(0.1 + 0.5 * this.p.activity, at, 0.4);
    this.pad.gain.setTargetAtTime(0.06 * clamp01(this.p.build * 1.5), at, tau * 3);
    this.bp.Q.setTargetAtTime(1.1 + 3 * this.p.activity, at, 0.4);
  }
}

// ---------------------------------------------------------------------------------------------
// 4. Bell plucks: sparse, irregular bell notes (FM) with an echo, like notifications from far off.
//    Moving the phone makes them come more often; holding it longer widens their range.

class Plucks extends Voice {
  readonly character = 'plucks';
  private root = 62 + Math.floor(this.rng() * 10);
  private mean = 0.55 + this.rng() * 0.6;
  private ratio = [3.5, 2.01, 1.41, 2.76][Math.floor(this.rng() * 4)];
  private next = 0;
  private bus!: GainNode;
  private fb!: GainNode;

  protected begin(at: number): void {
    const e = echo(this.ctx, (n) => this.node(n), 0.375 + this.rng() * 0.2, 0.35, 0.4);
    this.bus = this.node(new GainNode(this.ctx, { gain: 1 }));
    this.bus.connect(e.inp);
    e.out.connect(this.input);
    this.fb = e.fb;
    this.next = at + 0.15;
  }

  protected shapeParams(at: number, tau: number): void {
    this.fb.gain.setTargetAtTime(0.33 + 0.25 * this.p.build, at, tau * 2);
  }

  protected events(until: number): void {
    while (this.next < until) {
      this.pluck(this.next);
      const gap = -Math.log(1 - this.rng() * 0.95) * this.mean * (1 - 0.65 * this.p.activity);
      this.next += Math.max(0.09, gap);
    }
  }

  private pluck(t: number): void {
    const { ctx } = this;
    const range = 6 + Math.round(this.p.build * 7);
    const i = Math.floor(this.rng() * range);
    const f = mtof(this.root + 12 * Math.floor(i / 5) + PENTATONIC[i % 5]);
    const detune = this.bendAt(t);
    const car = new OscillatorNode(ctx, { frequency: f, detune });
    const mod = new OscillatorNode(ctx, { frequency: f * this.ratio, detune });
    const index = new GainNode(ctx, { gain: 0 });
    const amp = new GainNode(ctx, { gain: 0 });
    const pan = new StereoPannerNode(ctx, { pan: (this.rng() - 0.5) * 0.6 });
    mod.connect(index).connect(car.frequency);
    car.connect(amp).connect(pan).connect(this.bus);
    index.gain.setValueAtTime(f * 3, t);
    index.gain.exponentialRampToValueAtTime(f * 0.2, t + 1.2);
    amp.gain.setValueAtTime(0, t);
    amp.gain.linearRampToValueAtTime(0.2, t + 0.004);
    amp.gain.exponentialRampToValueAtTime(0.0005, t + 2.2);
    car.start(t);
    mod.start(t);
    car.stop(t + 2.3);
    mod.stop(t + 2.3);
  }
}

// ---------------------------------------------------------------------------------------------
// 5. Muffled headphone beat: kick, snare, hi-hat and a bass line, as if leaking from someone's
//    earbuds. At the edge of the focus zone only the tinny top of it is heard (a high-pass);
//    centred, the kick and bass come in full. Holding the phone longer brings in the bass, then
//    a chord stab; moving it adds hi-hats and kicks.

class Beat extends Voice {
  readonly character = 'beat';
  private root = 33 + Math.floor(this.rng() * 12);
  private sixteenth = 60 / (86 + Math.floor(this.rng() * 26)) / 4;
  private kicks = new Set([0, 8, ...[[], [6], [10], [3, 10], [14]][Math.floor(this.rng() * 5)]]);
  private bassline: (number | null)[] = Array.from({ length: 16 }, (_, i) =>
    i === 0 || (i % 2 === 0 ? this.rng() < 0.35 : this.rng() < 0.2) ? PENTATONIC[Math.floor(this.rng() * 5)] * (i ? 1 : 0) : null,
  );
  private step = 0;
  private next = 0;
  private bus!: GainNode;

  protected begin(at: number): void {
    this.bus = this.node(new GainNode(this.ctx, { gain: 0.8 }));
    this.bus.connect(this.input);
    this.next = at + 0.05;
  }

  protected shapeParams(): void {}

  protected events(until: number): void {
    const { activity, build } = this.p;
    while (this.next < until) {
      const t = this.next;
      const s = this.step % 16;
      const bar = Math.floor(this.step / 16);
      if (this.kicks.has(s) || (s === 14 && this.rng() < activity - 0.4)) this.kick(t);
      if (s === 4 || s === 12) this.snare(t);
      if (s % 2 === 0) this.hat(t, s % 4 === 2 ? 0.22 : 0.13, s % 4 === 2 ? 0.12 : 0.04);
      else if (this.rng() < activity * 0.8) this.hat(t, 0.09, 0.03);
      const b = this.bassline[s];
      if (build > 0.12 && b !== null) this.bass(t, this.root + b);
      if (build > 0.55 && s === 6 && bar % 2 === 1) this.stab(t);
      this.step++;
      this.next += this.sixteenth;
    }
  }

  private env(g: AudioParam, t: number, peak: number, decay: number): void {
    g.setValueAtTime(0, t);
    g.linearRampToValueAtTime(peak, t + 0.003);
    g.exponentialRampToValueAtTime(0.0005, t + decay);
  }

  private kick(t: number): void {
    const o = new OscillatorNode(this.ctx, { frequency: 150 });
    const g = new GainNode(this.ctx, { gain: 0 });
    o.frequency.setValueAtTime(150, t);
    o.frequency.exponentialRampToValueAtTime(45, t + 0.13);
    this.env(g.gain, t, 0.7, 0.42);
    o.connect(g).connect(this.bus);
    o.start(t);
    o.stop(t + 0.45);
  }

  private noiseHit(t: number, filter: BiquadFilterOptions, peak: number, decay: number): void {
    const src = new AudioBufferSourceNode(this.ctx, { buffer: this.kit.noise });
    const f = new BiquadFilterNode(this.ctx, filter);
    const g = new GainNode(this.ctx, { gain: 0 });
    this.env(g.gain, t, peak, decay);
    src.connect(f).connect(g).connect(this.bus);
    src.start(t, this.rng() * 1.5);
    src.stop(t + decay + 0.02);
  }

  private hat(t: number, peak: number, decay: number): void {
    this.noiseHit(t, { type: 'highpass', frequency: 7000 }, peak, decay);
  }

  private snare(t: number): void {
    this.noiseHit(t, { type: 'bandpass', frequency: 1900, Q: 0.7 }, 0.65, 0.18);
    const o = new OscillatorNode(this.ctx, { frequency: 185 });
    const g = new GainNode(this.ctx, { gain: 0 });
    this.env(g.gain, t, 0.25, 0.1);
    o.connect(g).connect(this.bus);
    o.start(t);
    o.stop(t + 0.12);
  }

  private bass(t: number, midi: number): void {
    const o = new OscillatorNode(this.ctx, { type: 'sawtooth', frequency: mtof(midi), detune: this.bendAt(t) });
    const f = new BiquadFilterNode(this.ctx, { type: 'lowpass', frequency: 700, Q: 3 });
    const g = new GainNode(this.ctx, { gain: 0 });
    f.frequency.setValueAtTime(900, t);
    f.frequency.exponentialRampToValueAtTime(160, t + 0.2);
    this.env(g.gain, t, 0.35, 0.26);
    o.connect(f).connect(g).connect(this.bus);
    o.start(t);
    o.stop(t + 0.28);
  }

  private stab(t: number): void {
    const f = new BiquadFilterNode(this.ctx, { type: 'lowpass', frequency: 1400 });
    const g = new GainNode(this.ctx, { gain: 0 });
    this.env(g.gain, t, 0.12, 0.35);
    f.connect(g).connect(this.bus);
    for (const m of [this.root + 24, this.root + 27, this.root + 31]) {
      const o = new OscillatorNode(this.ctx, { type: 'sawtooth', frequency: mtof(m), detune: this.bendAt(t) });
      o.connect(f);
      o.start(t);
      o.stop(t + 0.4);
    }
  }
}

const TONES: Record<CharacterId, ToneShape> = {
  drone: { type: 'lowpass', closed: 260, open: 6000 },
  pulse: { type: 'lowpass', closed: 300, open: 9000 },
  wash: { type: 'lowpass', closed: 300, open: 9000 },
  plucks: { type: 'lowpass', closed: 400, open: 12000 },
  // Sound leaking from earbuds is tinny: the high-pass lets only the top through until centred.
  beat: { type: 'highpass', closed: 500, open: 25 },
};

const CLASSES: Record<CharacterId, new (kit: Kit, seed: number, dry: AudioNode, wet: AudioNode, shape: ToneShape) => Voice> = {
  drone: Drone,
  pulse: Pulse,
  wash: Wash,
  plucks: Plucks,
  beat: Beat,
};

export const CHARACTER_LABELS: Record<CharacterId, string> = {
  drone: 'low drone',
  pulse: 'soft pulse',
  wash: 'noise wash',
  plucks: 'bell plucks',
  beat: 'muffled headphone beat',
};

export function makeVoice(character: CharacterId, kit: Kit, seed: number, dry: AudioNode, wet: AudioNode): Voice {
  return new CLASSES[character](kit, seed, dry, wet, TONES[character]);
}
