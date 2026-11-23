// Someone's conversation, as it is heard: hijack mode's sound for one person (Web Audio).
// What is said comes from scenes.ts; this decides how much of it gets through to the listener.
//
//   near (who holds the phone) ─ muffled by distance ────────┐
//   far  (the voice on the line) ─ phone band ─ tiny speaker ┴─ break-in ─ door ─ pan ─ level ─┬─ dry
//                                                                                              └─ room
//
// The engine (engine.ts) gives it a few numbers about the phone in focus, about 25 times a second:
//
//   pan        where the phone is, left to right
//   clarity    how centred it is in the focus zone: 0 at the edge, 1 in the inner 30 %
//   closeness  how big the phone is in the picture
//   build      how long it has been held: the conversation gets more intimate
//   activity   how much the phone moves: the conversation gets more agitated
//
// - Edge = half a conversation, centre = all of it. At the edge you hear what everyone around
//   hears: the near side, muffled, placed where the phone is, with the room around it, and gaps
//   where the other one speaks (a faint, tinny trace of it at most). Towards the centre the near
//   voice comes close, and the far voice opens up in the middle of your head, as on the phone.
//   It is a murmur all the way in: there are no words to understand.
// - Breaking in. It starts with BREAK_IN_S of a digital signal breaking through: dropouts and
//   coarse, bit-crushed sound. Then it seals (the engine adds the hush of noise cancelling).
// - Already going on. It starts `elapsed` seconds into the person's own time, mid-sentence.
// - Pushed out. When focus leaves, it is shut off like a door: muffled and much quieter at once,
//   then fading while they talk on.
//
// Every change is a glide (setTargetAtTime), never a jump, so nothing clicks.
import type { SceneId } from '../settings';
import { Script, type Side, type Turn } from './scenes';

export interface VoiceParams {
  pan: number;
  clarity: number;
  closeness: number;
  build: number;
  activity: number;
}

/** What every conversation needs from the engine: the audio context and shared buffers. */
export interface Kit {
  ctx: BaseAudioContext;
  /** 2 s of white noise. */
  noise: AudioBuffer;
  /** Staircase curve for the bit-crushed sound while breaking in. */
  crush: Float32Array<ArrayBuffer>;
  /** tanh curve: the earpiece, pushed hard at the edge. */
  strain: Float32Array<ArrayBuffer>;
}

/** How long breaking in takes (s), until the seal. */
export const BREAK_IN_S = 0.8;
/** The near voice through the air of the carriage (low-pass, Hz): at the edge, and inside. */
const NEAR_LP = [1500, 11000] as const;
/** Its loudness; inside, the voice on the line is in front. */
const NEAR_GAIN = [1.5, 0.75] as const;
/** The far voice: the bottom of what the earpiece lets out (high-pass, Hz), its overdrive and its loudness. */
const FAR_HP = [1000, 260] as const;
const FAR_DRIVE = [3, 1.3] as const;
const FAR_GAIN = [0.4, 1.2] as const;
/** With nobody speaking near, the trace from the earpiece is all there is at the edge: let it be heard. */
const FAR_GAIN_ALONE = 1.6;
/** Behind the door, when pushed out: a low-pass at this (Hz). */
const DOOR_LP = 350;
/** The next turn is written this long (s) before the one now playing ends (turns can overlap by 0.4 s). */
const AHEAD_S = 0.7;

export const clamp01 = (v: number) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);
const clampPan = (v: number) => (Number.isFinite(v) ? Math.min(0.85, Math.max(-0.85, v)) : 0);
/** From a (edge) to b (inside), in equal ratios. */
const glide = ([a, b]: readonly [number, number], c: number) => a * (b / a) ** c;

/** Level by how close the phone is and how far in one is. */
const loudness = (closeness: number, c: number) => (0.5 + 0.5 * closeness) * (0.5 + 0.5 * c);

/** Small seeded random number generator: the same seed gives the same person the same voices. */
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

export class Conversation {
  /** When it has faded out and stops (context time); Infinity while it goes on. */
  stopAt = Infinity;

  private readonly ctx: BaseAudioContext;
  private readonly rng: () => number;
  private script!: Script;
  private p: VoiceParams = { pan: 0, clarity: 0, closeness: 0.5, build: 0, activity: 0 };
  private readonly nodes: AudioNode[] = [];
  private readonly playing = new Set<AudioBufferSourceNode>();
  /** Buffers of turns that come again (a voice note on repeat). */
  private readonly buffers = new WeakMap<Float32Array<ArrayBuffer>, AudioBuffer>();
  /** When the turn written last ends. */
  private cursor = 0;
  private sealAt = 0;
  private outAt = Infinity;
  /** The level it is heading for (to shut the door from). */
  private levelNow = 0;

  private readonly inputs: Record<Side, GainNode>;
  private readonly nearLp: BiquadFilterNode;
  private readonly nearBody: BiquadFilterNode;
  private readonly nearGain: GainNode;
  private readonly farDrive: GainNode;
  private readonly farMakeup: GainNode;
  private readonly farThin: BiquadFilterNode;
  private readonly farGain: GainNode;
  private readonly clean: GainNode;
  private readonly crushed: GainNode;
  private readonly gate: GainNode;
  private readonly door: BiquadFilterNode;
  private readonly panner: StereoPannerNode;
  private readonly level: GainNode;
  private readonly send: GainNode;

  constructor(
    readonly scene: SceneId,
    kit: Kit,
    private readonly seed: number,
    dry: AudioNode,
    wet: AudioNode,
  ) {
    const ctx = (this.ctx = kit.ctx);
    this.rng = mulberry32(seed ^ 0x5eed);
    const filter = (type: BiquadFilterType, frequency: number, gain = 0, Q = 0.7) => this.node(new BiquadFilterNode(ctx, { type, frequency, gain, Q }));
    const gain = (g: number) => this.node(new GainNode(ctx, { gain: g }));
    this.inputs = { near: gain(1), far: gain(1) };

    this.nearLp = filter('lowpass', NEAR_LP[0]);
    this.nearBody = filter('lowshelf', 200);
    this.nearGain = gain(NEAR_GAIN[0]);
    this.inputs.near.connect(this.nearLp).connect(this.nearBody).connect(this.nearGain);

    // A telephone carries 300 to 3400 Hz; two filters on each side make the steep edges one hears.
    this.farDrive = gain(FAR_DRIVE[0]);
    const strain = this.node(new WaveShaperNode(ctx, { curve: kit.strain, oversample: '2x' }));
    this.farMakeup = gain(1);
    this.farThin = filter('highpass', FAR_HP[0]);
    this.farGain = gain(FAR_GAIN[0]);
    this.inputs.far
      .connect(filter('highpass', 300))
      .connect(filter('highpass', 300))
      .connect(this.farDrive)
      .connect(strain)
      .connect(this.farMakeup)
      .connect(filter('lowpass', 3400))
      .connect(filter('lowpass', 3400))
      .connect(this.farThin)
      .connect(this.farGain);

    const mix = gain(1);
    this.nearGain.connect(mix);
    this.farGain.connect(mix);
    this.clean = gain(0);
    this.crushed = gain(1);
    this.gate = gain(0);
    mix.connect(this.clean).connect(this.gate);
    // Louder into the staircase, so that quiet syllables survive it.
    mix.connect(gain(2.5)).connect(this.node(new WaveShaperNode(ctx, { curve: kit.crush }))).connect(gain(0.4)).connect(this.crushed).connect(this.gate);
    this.door = filter('lowpass', 18000);
    this.panner = this.node(new StereoPannerNode(ctx, { pan: 0 }));
    this.level = gain(0);
    this.send = gain(0.4);
    this.gate.connect(this.door).connect(this.panner).connect(this.level);
    this.level.connect(dry);
    this.level.connect(this.send).connect(wet);
  }

  /** Break in at `at`, `elapsed` seconds into their conversation; sealed BREAK_IN_S later. */
  start(p: VoiceParams, at: number, elapsed: number): void {
    this.p = sanitise(p);
    this.sealAt = at + BREAK_IN_S;
    this.join(at, Math.max(0, elapsed));
    this.settle(at, 0, null);
    this.panner.pan.setValueAtTime(this.p.pan, at);
    this.levelNow = loudness(this.p.closeness, 0);
    this.level.gain.setValueAtTime(this.levelNow, at);
    // Breaking in: bursts that hold longer and longer.
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

  /** New numbers. */
  set(p: VoiceParams, at: number): void {
    if (at >= this.outAt) return;
    this.p = sanitise(p);
    // Still breaking in: follow the phone; the rest waits for the seal.
    if (at < this.sealAt) this.panner.pan.setTargetAtTime(this.p.pan, at, 0.25);
    else this.apply(at, at - this.sealAt < 1 ? 0.35 : 0.2);
  }

  /** Pushed out: shut off like a door, muffled and much quieter at once, then fading while they talk on. */
  tuneOut(at: number): void {
    if (this.outAt <= at) return;
    this.outAt = at;
    for (const prm of [this.level.gain, this.send.gain, this.gate.gain, this.clean.gain, this.crushed.gain]) hold(prm, at);
    this.gate.gain.setTargetAtTime(1, at, 0.005);
    this.clean.gain.setTargetAtTime(1, at, 0.005);
    this.crushed.gain.setTargetAtTime(0, at, 0.005);
    this.door.frequency.setTargetAtTime(DOOR_LP, at, 0.04);
    this.send.gain.setTargetAtTime(0.25, at, 0.1);
    this.level.gain.setTargetAtTime(this.levelNow * 0.35, at, 0.04);
    this.level.gain.setTargetAtTime(0, at + 0.3, 0.4);
    // By then the level is e^-12 (about -100 dB) below the door: stopping there cannot click.
    this.stopAt = at + 0.3 + 0.4 * 12;
  }

  /** Write the turns that start before `until`. */
  schedule(until: number): void {
    while (this.cursor - AHEAD_S < until && this.cursor < this.stopAt) this.say(this.script.next(this.p.build, this.p.activity));
  }

  dispose(): void {
    for (const s of this.playing) s.stop();
    for (const n of this.nodes) n.disconnect();
  }

  private node<T extends AudioNode>(n: T): T {
    this.nodes.push(n);
    return n;
  }

  /** Come in mid-sentence. */
  private join(at: number, elapsed: number): void {
    const { ctx } = this;
    // A message on repeat is the same message whenever one comes back to it; a talk has moved on.
    const now = Math.floor(elapsed * 10);
    this.script = new Script(this.scene, mulberry32(this.seed), mulberry32(this.seed + 1 + (Script.repeats(this.scene) ? 0 : now)), ctx.sampleRate);
    const tape = this.script.tape(this.p.build);
    if (tape) {
      let pos = elapsed % tape.reduce((s, t) => s + t.gap + t.samples.length / ctx.sampleRate, 0);
      for (let i = 0; ; i = (i + 1) % tape.length) {
        const seconds = tape[i].samples.length / ctx.sampleRate;
        if (pos < tape[i].gap + seconds) {
          this.script.seek(i + 1);
          this.cursor = at;
          this.play(tape[i], at + Math.max(0, tape[i].gap - pos), Math.max(0, pos - tape[i].gap));
          return;
        }
        pos -= tape[i].gap + seconds;
      }
    }
    // Something long enough to be joined midway, said by the one who can be overheard, if possible.
    let turn = this.script.next(this.p.build, this.p.activity);
    for (let i = 0; i < 6 && (turn.side !== 'near' || turn.samples.length < 1.6 * ctx.sampleRate); i++) turn = this.script.next(this.p.build, this.p.activity);
    this.play(turn, at, (turn.samples.length / ctx.sampleRate) * (0.15 + 0.35 * this.rng()));
  }

  private say(turn: Turn): void {
    // Never in the past (a late timer): it would start late and cut off the beginning.
    this.play(turn, Math.max(this.cursor + turn.gap, this.ctx.currentTime + 0.01), 0);
  }

  private play(turn: Turn, when: number, offset: number): void {
    this.source(turn.side, turn.samples, when, offset, turn.gain);
    if (turn.aside && turn.aside.at > offset) this.source(turn.aside.side, turn.aside.samples, when + turn.aside.at - offset, 0, turn.aside.gain);
    // Always forward, whatever the overlap.
    this.cursor = Math.max(this.cursor + 0.05, when + turn.samples.length / this.ctx.sampleRate - offset);
  }

  private source(side: Side, samples: Float32Array<ArrayBuffer>, when: number, offset: number, loud: number): void {
    const { ctx } = this;
    let buffer = this.buffers.get(samples);
    if (!buffer) {
      buffer = ctx.createBuffer(1, samples.length, ctx.sampleRate);
      buffer.copyToChannel(samples, 0);
      this.buffers.set(samples, buffer);
    }
    const src = new AudioBufferSourceNode(ctx, { buffer });
    const g = new GainNode(ctx, { gain: loud });
    src.connect(g).connect(this.inputs[side]);
    src.start(when, offset);
    this.playing.add(src);
    src.onended = () => {
      this.playing.delete(src);
      g.disconnect();
    };
  }

  /** Set the two voices for clarity c, at once (tau null) or gliding. */
  private settle(at: number, c: number, tau: number | null): void {
    const to = (p: AudioParam, v: number) => (tau === null ? p.setValueAtTime(v, at) : p.setTargetAtTime(v, at, tau));
    to(this.nearLp.frequency, glide(NEAR_LP, c));
    to(this.nearBody.gain, 3 * c);
    to(this.nearGain.gain, glide(NEAR_GAIN, c));
    const drive = glide(FAR_DRIVE, c);
    to(this.farDrive.gain, drive);
    to(this.farMakeup.gain, drive ** -0.75);
    to(this.farThin.frequency, glide(FAR_HP, c));
    to(this.farGain.gain, glide([this.script.farOnly ? FAR_GAIN_ALONE : FAR_GAIN[0], FAR_GAIN[1]], c));
  }

  private apply(at: number, tau: number): void {
    const { pan, clarity: c, closeness } = this.p;
    this.settle(at, c, tau);
    // Inside their head is in the middle of yours.
    this.panner.pan.setTargetAtTime(pan * (1 - c), at, 0.25);
    this.levelNow = loudness(closeness, c);
    this.level.gain.setTargetAtTime(this.levelNow, at, tau * 0.8);
    // What is overheard has the room around it (more when the phone is far); inside is dry.
    this.send.gain.setTargetAtTime(0.03 + (1 - c) * (0.3 + 0.25 * (1 - closeness)), at, 0.4);
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
