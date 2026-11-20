// The sound characters of hijack mode, all synthesised with the Web Audio API: no recordings.
//
// A Voice is one person's soundscape. The engine (engine.ts) gives it a few numbers about the
// phone in focus, about 25 times a second:
//
//   pan        where the phone is, left to right
//   clarity    how centred it is in the focus zone: 0 at the edge, 1 in the inner 30 %
//   closeness  how big the phone is in the picture
//   build      how long it has been held: more layers the longer someone is on their phone
//   activity   how much the phone moves: busier rhythm, faster movement
//
// What every character shares (the base class below):
//
// - Edge = leak, centre = inside their head. At clarity 0 the sound is what leaks out of
//   someone's earbuds: a small speaker pushed hard (overdriven and lopsided, so even a bass line
//   comes out as a thin buzz), no bass, the hiss of the top still there, quiet, placed where the
//   phone is, with some of the room around it. At clarity 1 it is what they hear: full range, a little extra bass (earbuds
//   pressed in), dry, and in the middle of your head.
// - Breaking in. A voice starts with BREAK_IN_S of a digital signal breaking through: dropouts
//   and coarse, bit-crushed sound, still the thin leak. Then it seals (the engine adds the hush
//   of noise cancelling closing in) and opens up to wherever the phone is in the zone.
// - Already playing. A voice starts `elapsed` seconds into the person's own timeline, so it is
//   joined mid-phrase, as something that was going on before anyone listened.
// - Pushed out. When focus leaves, the sound is shut off like a door: muffled and much quieter
//   at once, then fading while it keeps playing.
//
// Every change is a glide (setTargetAtTime), never a jump, so nothing clicks. Each character
// connects its sound to `input`.
import type { CharacterId } from '../settings';

export interface VoiceParams {
  pan: number;
  clarity: number;
  closeness: number;
  build: number;
  activity: number;
}

/** What every voice needs from the engine: the audio context and shared buffers. */
export interface Kit {
  ctx: BaseAudioContext;
  /** 2 s of white noise, looped by noise sources (started at random offsets). */
  noise: AudioBuffer;
  /** Staircase curve for the bit-crushed sound while breaking in. */
  crush: Float32Array<ArrayBuffer>;
  /** tanh curve for the leak's overdrive (a small speaker pushed hard). */
  strain: Float32Array<ArrayBuffer>;
}

/** How long breaking in takes (s), until the seal. */
export const BREAK_IN_S = 0.8;
/** The leak, at the edge of the zone: only what is between these two (high-pass, low-pass, Hz). */
const LEAK_HP = 650;
const LEAK_LP = 9000;
/** Inside: the full range. */
const FULL_HP = 20;
const FULL_LP = 18000;
/** Extra bass when fully inside (dB, low shelf at 120 Hz): earbuds pressed in. */
const INSIDE_BASS_DB = 5;
/** The leak's overdrive (input gain into a tanh) and its bump around 2.5 kHz (dB): a small, strained speaker. */
const LEAK_DRIVE = 14;
const LEAK_PRESENCE_DB = 6;
/** Offset into the overdrive at the edge: the speaker bends one way more than the other (even overtones). */
const LEAK_BIAS = 0.35;
/** Behind the door, when pushed out: a low-pass at this (Hz). */
const DOOR_LP = 350;

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

/** Stop a parameter's planned changes at `at`, keeping the value it has then. */
function hold(p: AudioParam, at: number): void {
  if (typeof p.cancelAndHoldAtTime === 'function') p.cancelAndHoldAtTime(at);
  else p.cancelScheduledValues(at);
}

/** Gain after the overdrive, so that driving harder does not also make it louder. */
function makeupFor(drive: number): number {
  return drive ** -0.75;
}

/** A 16th-note grid `elapsed` seconds in: the number of the next step and when it falls. */
function gridAt(at: number, elapsed: number, sixteenth: number): { step: number; next: number } {
  const step = Math.ceil(elapsed / sixteenth - 1e-9);
  return { step, next: at + step * sixteenth - elapsed };
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
  /** All nodes, disconnected when the voice ends. */
  private readonly nodes: AudioNode[] = [];

  private readonly clean: GainNode;
  private readonly crushed: GainNode;
  private readonly gate: GainNode;
  private readonly drive: GainNode;
  private readonly makeup: GainNode;
  private readonly bias: ConstantSourceNode;
  private readonly presence: BiquadFilterNode;
  private readonly toneHp: BiquadFilterNode;
  private readonly toneLp: BiquadFilterNode;
  private readonly toneBass: BiquadFilterNode;
  private readonly panner: StereoPannerNode;
  private readonly level: GainNode;
  private readonly send: GainNode;
  private sealAt = 0;
  private outAt = Infinity;
  /** The level the voice is heading for (to shut the door from). */
  private levelNow = 0;

  constructor(
    protected readonly kit: Kit,
    seed: number,
    dry: AudioNode,
    wet: AudioNode,
  ) {
    const ctx = (this.ctx = kit.ctx);
    this.rng = mulberry32(seed);
    this.input = this.node(new GainNode(ctx));
    this.clean = this.node(new GainNode(ctx, { gain: 0 }));
    this.crushed = this.node(new GainNode(ctx, { gain: 1 }));
    const crush = this.node(new WaveShaperNode(ctx, { curve: kit.crush }));
    this.gate = this.node(new GainNode(ctx, { gain: 0 }));
    this.drive = this.node(new GainNode(ctx, { gain: LEAK_DRIVE }));
    const strain = this.node(new WaveShaperNode(ctx, { curve: kit.strain, oversample: '2x' }));
    this.makeup = this.node(new GainNode(ctx, { gain: makeupFor(LEAK_DRIVE) }));
    this.bias = new ConstantSourceNode(ctx, { offset: LEAK_BIAS });
    this.bias.connect(strain);
    this.presence = this.node(new BiquadFilterNode(ctx, { type: 'peaking', frequency: 2500, Q: 0.9, gain: LEAK_PRESENCE_DB }));
    this.toneHp = this.node(new BiquadFilterNode(ctx, { type: 'highpass', frequency: LEAK_HP, Q: 0.7 }));
    this.toneLp = this.node(new BiquadFilterNode(ctx, { type: 'lowpass', frequency: LEAK_LP, Q: 0.7 }));
    this.toneBass = this.node(new BiquadFilterNode(ctx, { type: 'lowshelf', frequency: 120, gain: 0 }));
    this.panner = this.node(new StereoPannerNode(ctx, { pan: 0 }));
    this.level = this.node(new GainNode(ctx, { gain: 0 }));
    this.send = this.node(new GainNode(ctx, { gain: 0.4 }));
    this.input.connect(this.clean).connect(this.gate);
    this.input.connect(crush).connect(this.crushed).connect(this.gate);
    this.gate.connect(this.drive).connect(strain).connect(this.makeup).connect(this.presence).connect(this.toneHp).connect(this.toneLp).connect(this.toneBass).connect(this.panner).connect(this.level);
    this.level.connect(dry);
    this.level.connect(this.send).connect(wet);
  }

  /**
   * dB added to the leak (fading out towards the centre), so that every character's leak is
   * about 10–12 dB below its inside level (measured with npm run check:hijack). Without it a
   * bass-heavy sound all but vanishes at the edge, and bright bells are louder there than inside.
   */
  protected readonly leakLiftDb: number = 0;

  /** Start the continuous sources of this character at `at`, `elapsed` seconds into its timeline. */
  protected abstract begin(at: number, elapsed: number): void;
  /** React to `this.p` (the base already handles the leak/inside filters, pan, level and room). */
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

  /** A sine LFO already `elapsed` seconds into its cycle, so a slow swell is joined midway. */
  protected lfo(freq: number, at: number, elapsed: number): OscillatorNode {
    const phase = 2 * Math.PI * ((freq * elapsed) % 1);
    // sin(ωt + φ) = sin φ · cos ωt + cos φ · sin ωt
    const wave = this.ctx.createPeriodicWave([0, Math.sin(phase)], [0, Math.cos(phase)], { disableNormalization: true });
    return this.source(new OscillatorNode(this.ctx, { frequency: freq, periodicWave: wave }), at);
  }

  /** Break in at `at`, `elapsed` seconds into this person's sound; sealed BREAK_IN_S later. */
  start(p: VoiceParams, at: number, elapsed: number): void {
    this.p = sanitise(p);
    this.sealAt = at + BREAK_IN_S;
    this.source(this.bias, at);
    this.makeup.gain.setValueAtTime(this.makeupAt(0), at);
    this.begin(at, Math.max(0, elapsed));
    // Breaking in: the thin leak, placed where the phone is, coming through in bursts that
    // hold longer and longer.
    this.panner.pan.setValueAtTime(this.p.pan, at);
    this.levelNow = (0.45 + 0.55 * this.p.closeness) * 0.4;
    this.level.gain.setValueAtTime(this.levelNow, at);
    for (let t = at; t < this.sealAt; t += 0.02 + this.rng() * 0.07) {
      const on = this.rng() < 0.3 + 0.6 * ((t - at) / BREAK_IN_S);
      this.gate.gain.setTargetAtTime(on ? (this.rng() < 0.3 ? 0.5 : 1) : 0, t, 0.002);
    }
    // The seal: the signal holds, the crushed sound clears, and it opens up.
    this.gate.gain.setTargetAtTime(1, this.sealAt, 0.003);
    this.crushed.gain.setTargetAtTime(0, this.sealAt, 0.02);
    this.clean.gain.setTargetAtTime(1, this.sealAt, 0.02);
    this.apply(this.sealAt, 0.35);
  }

  /** New numbers for this voice. */
  set(p: VoiceParams, at: number): void {
    if (at >= this.outAt) return;
    this.p = sanitise(p);
    if (at < this.sealAt) {
      // Still breaking in: follow the phone; the rest waits for the seal.
      this.panner.pan.setTargetAtTime(this.p.pan, at, 0.25);
      this.shapeParams(at, 0.3);
      return;
    }
    this.apply(at, at - this.sealAt < 1 ? 0.35 : 0.2);
  }

  /** Pushed out: shut off like a door, muffled and much quieter at once, then fading while it plays on. */
  tuneOut(at: number): void {
    if (this.outAt <= at) return;
    this.outAt = at;
    const params = [this.level.gain, this.toneLp.frequency, this.toneHp.frequency, this.toneBass.gain, this.send.gain];
    params.push(this.drive.gain, this.makeup.gain, this.presence.gain, this.bias.offset);
    for (const prm of [...params, this.gate.gain, this.clean.gain, this.crushed.gain]) hold(prm, at);
    this.gate.gain.setTargetAtTime(1, at, 0.005);
    this.clean.gain.setTargetAtTime(1, at, 0.005);
    this.crushed.gain.setTargetAtTime(0, at, 0.005);
    this.toneLp.frequency.setTargetAtTime(DOOR_LP, at, 0.04);
    this.toneHp.frequency.setTargetAtTime(FULL_HP, at, 0.04);
    this.toneBass.gain.setTargetAtTime(0, at, 0.04);
    this.drive.gain.setTargetAtTime(1, at, 0.04);
    this.makeup.gain.setTargetAtTime(1, at, 0.04);
    this.presence.gain.setTargetAtTime(0, at, 0.04);
    this.bias.offset.setTargetAtTime(0, at, 0.04);
    this.send.gain.setTargetAtTime(0.25, at, 0.1);
    this.level.gain.setTargetAtTime(this.levelNow * 0.3, at, 0.04);
    this.level.gain.setTargetAtTime(0, at + 0.3, 0.4);
    // By then the level is e^-12 (about -100 dB) below the door: stopping there cannot click.
    this.stopAt = at + 0.3 + 0.4 * 12;
    for (const s of this.sources) s.stop(this.stopAt);
  }

  /** Schedule what this voice plays up to `until`. */
  schedule(until: number): void {
    this.events(Math.min(until, this.stopAt));
  }

  dispose(): void {
    for (const n of this.nodes) n.disconnect();
  }

  /** Gain after the overdrive at clarity c: undoes the drive's loudness, plus the character's leak lift. */
  private makeupAt(c: number): number {
    return makeupFor(1 + (LEAK_DRIVE - 1) * (1 - c)) * 10 ** ((this.leakLiftDb * (1 - c)) / 20);
  }

  private apply(at: number, tau: number): void {
    const { pan, clarity: c, closeness } = this.p;
    this.toneHp.frequency.setTargetAtTime(LEAK_HP * (FULL_HP / LEAK_HP) ** c, at, tau);
    this.toneLp.frequency.setTargetAtTime(LEAK_LP * (FULL_LP / LEAK_LP) ** c, at, tau);
    this.toneBass.gain.setTargetAtTime(INSIDE_BASS_DB * c, at, tau);
    this.drive.gain.setTargetAtTime(1 + (LEAK_DRIVE - 1) * (1 - c), at, tau);
    this.makeup.gain.setTargetAtTime(this.makeupAt(c), at, tau);
    this.presence.gain.setTargetAtTime(LEAK_PRESENCE_DB * (1 - c), at, tau);
    this.bias.offset.setTargetAtTime(LEAK_BIAS * (1 - c), at, tau);
    // Inside their head is in the middle of yours.
    this.panner.pan.setTargetAtTime(pan * (1 - c), at, 0.25);
    this.levelNow = (0.45 + 0.55 * closeness) * (0.4 + 0.6 * c);
    this.level.gain.setTargetAtTime(this.levelNow, at, tau * 0.8);
    // The leak has the room around it (more when the phone is far); inside is dry.
    this.send.gain.setTargetAtTime(0.03 + (1 - c) * (0.3 + 0.25 * (1 - closeness)), at, 0.4);
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

const DRONE_LEVEL = 0.22;

class Drone extends Voice {
  readonly character = 'drone';
  protected readonly leakLiftDb = 16;
  private root = 38 + Math.floor(this.rng() * 12);
  private fifth!: GainNode;
  private octave!: GainNode;
  private lp!: BiquadFilterNode;
  private tremRate!: OscillatorNode;
  private tremDepth!: GainNode;
  private amp!: GainNode;

  protected begin(at: number, elapsed: number): void {
    const { ctx } = this;
    const f = mtof(this.root);
    this.lp = this.node(new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 450, Q: 2.5 }));
    this.amp = this.node(new GainNode(ctx, { gain: DRONE_LEVEL }));
    this.lp.connect(this.amp).connect(this.input);
    const osc = (type: OscillatorType, freq: number, detune: number, gain: number) => {
      const o = this.source(new OscillatorNode(ctx, { type, frequency: freq, detune }), at);
      const g = this.node(new GainNode(ctx, { gain }));
      o.connect(g).connect(this.lp);
      return g;
    };
    osc('sawtooth', f, 7, 0.22);
    osc('sawtooth', f, -7, 0.22);
    osc('sine', f / 2, 0, 0.55);
    this.fifth = osc('sawtooth', f * 1.5, 3, 0);
    this.octave = osc('triangle', f * 2, -4, 0);
    // The filter breathes on its own, slowly (10 to 20 s a cycle).
    const lfo = this.lfo(0.05 + this.rng() * 0.05, at, elapsed);
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
  protected readonly leakLiftDb = 1;
  private root = 50 + Math.floor(this.rng() * 12);
  private sixteenth = 60 / (70 + Math.floor(this.rng() * 30)) / 4;
  private pattern: (number | null)[] = Array.from({ length: 16 }, (_, i) =>
    i % 2 || this.rng() < 0.35 ? null : PENTATONIC[Math.floor(this.rng() * 5)] + (this.rng() < 0.3 ? 12 : 0),
  );
  private step = 0;
  private next = 0;
  private bus!: GainNode;
  private fb!: GainNode;

  protected begin(at: number, elapsed: number): void {
    const lp = this.node(new BiquadFilterNode(this.ctx, { type: 'lowpass', frequency: 2400 }));
    const e = echo(this.ctx, (n) => this.node(n), this.sixteenth * 3, 0.3, 0.35);
    this.bus = this.node(new GainNode(this.ctx, { gain: 1.2 }));
    this.bus.connect(lp).connect(e.inp);
    e.out.connect(this.input);
    this.fb = e.fb;
    if (!this.pattern.some((n) => n !== null)) this.pattern[0] = 0;
    ({ step: this.step, next: this.next } = gridAt(at, elapsed, this.sixteenth));
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
    const a = new OscillatorNode(ctx, { type: 'triangle', frequency: f });
    const b = new OscillatorNode(ctx, { type: 'sine', frequency: f * 2 });
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

  protected begin(at: number, elapsed: number): void {
    const { ctx } = this;
    this.bp = this.node(new BiquadFilterNode(ctx, { type: 'bandpass', frequency: 800 + this.rng() * 500, Q: 1.1 }));
    const swell = this.node(new GainNode(ctx, { gain: 0.55 }));
    this.noise(at).connect(this.bp).connect(swell).connect(this.input);
    const sweep = this.lfo(0.04 + this.rng() * 0.04, at, elapsed);
    sweep.connect(this.node(new GainNode(ctx, { gain: 500 }))).connect(this.bp.frequency);
    this.swellRate = this.lfo(0.1, at, elapsed);
    this.swellRate.connect(this.node(new GainNode(ctx, { gain: 0.42 }))).connect(swell.gain);
    const rumble = this.node(new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 220 }));
    this.noise(at).connect(rumble).connect(this.node(new GainNode(ctx, { gain: 0.5 }))).connect(this.input);
    this.pad = this.node(new GainNode(ctx, { gain: 0 }));
    this.pad.connect(this.input);
    for (const m of [this.root, this.root + 7, this.root + 15]) {
      const o = this.source(new OscillatorNode(ctx, { type: 'sine', frequency: mtof(m) }), at);
      o.connect(this.pad);
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
  protected readonly leakLiftDb = -9;
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
    // Joined midway: a note is already ringing.
    this.pluck(at, 0.3 + this.rng() * 1.2);
    this.next = at + 0.3 + this.rng() * this.mean;
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

  /** A bell note at t; with `age`, one that started that long ago and is already decaying. */
  private pluck(t: number, age = 0): void {
    const { ctx } = this;
    const range = 6 + Math.round(this.p.build * 7);
    const i = Math.floor(this.rng() * range);
    const f = mtof(this.root + 12 * Math.floor(i / 5) + PENTATONIC[i % 5]);
    const car = new OscillatorNode(ctx, { frequency: f });
    const mod = new OscillatorNode(ctx, { frequency: f * this.ratio });
    const index = new GainNode(ctx, { gain: 0 });
    const amp = new GainNode(ctx, { gain: 0 });
    const pan = new StereoPannerNode(ctx, { pan: (this.rng() - 0.5) * 0.6 });
    mod.connect(index).connect(car.frequency);
    car.connect(amp).connect(pan).connect(this.bus);
    // Exponential decays, so a note `age` old is the same curve joined later.
    const decay = (from: number, to: number, length: number) => from * (to / from) ** Math.min(1, age / length);
    index.gain.setValueAtTime(decay(f * 3, f * 0.2, 1.2), t);
    index.gain.exponentialRampToValueAtTime(f * 0.2, t + Math.max(0.01, 1.2 - age));
    amp.gain.setValueAtTime(0, t);
    amp.gain.linearRampToValueAtTime(age ? decay(0.2, 0.0005, 2.2) : 0.2, t + 0.004);
    amp.gain.exponentialRampToValueAtTime(0.0005, t + Math.max(0.05, 2.2 - age));
    const end = t + Math.max(0.1, 2.3 - age);
    car.start(t);
    mod.start(t);
    car.stop(end);
    mod.stop(end);
  }
}

// ---------------------------------------------------------------------------------------------
// 5. Muffled headphone beat: kick, snare, hi-hat and a bass line. At the edge of the focus zone
//    only the tinny leak of it is heard; centred, the kick and bass come in full. Holding the
//    phone longer brings in the bass, then a chord stab; moving it adds hi-hats and kicks.

class Beat extends Voice {
  readonly character = 'beat';
  protected readonly leakLiftDb = 8;
  private root = 33 + Math.floor(this.rng() * 12);
  private sixteenth = 60 / (86 + Math.floor(this.rng() * 26)) / 4;
  private kicks = new Set([0, 8, ...[[], [6], [10], [3, 10], [14]][Math.floor(this.rng() * 5)]]);
  private bassline: (number | null)[] = Array.from({ length: 16 }, (_, i) =>
    i === 0 || (i % 2 === 0 ? this.rng() < 0.35 : this.rng() < 0.2) ? PENTATONIC[Math.floor(this.rng() * 5)] * (i ? 1 : 0) : null,
  );
  private step = 0;
  private next = 0;
  private bus!: GainNode;

  protected begin(at: number, elapsed: number): void {
    this.bus = this.node(new GainNode(this.ctx, { gain: 0.8 }));
    this.bus.connect(this.input);
    ({ step: this.step, next: this.next } = gridAt(at, elapsed, this.sixteenth));
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
    const o = new OscillatorNode(this.ctx, { type: 'sawtooth', frequency: mtof(midi) });
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
      const o = new OscillatorNode(this.ctx, { type: 'sawtooth', frequency: mtof(m) });
      o.connect(f);
      o.start(t);
      o.stop(t + 0.4);
    }
  }
}

const CLASSES: Record<CharacterId, new (kit: Kit, seed: number, dry: AudioNode, wet: AudioNode) => Voice> = {
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
  return new CLASSES[character](kit, seed, dry, wet);
}
