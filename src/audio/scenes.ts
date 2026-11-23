// The conversations of hijack mode: who speaks, when, and how. No words, only how people talk.
//
// Each person in the picture is in one conversation, with two sides: `near`, the one holding the
// phone, and `far`, the voice on the line. A Script writes it turn by turn, for as long as anyone
// listens. How long the phone has been held makes it more intimate (slower, softer, longer
// pauses); moving the phone makes it more agitated (faster, higher, falling into each other's
// words).
import { interject, makeLanguage, speak, STYLE, type Interjection, type Language, type Style } from './babble';
import { FRAME_S, level, synthesise, type Speaker } from './formant';
import { mulberry32 } from './random';
import type { SceneId } from '../settings';

export type Side = 'near' | 'far';

/** Something to be said: how long it takes is known, the sound is made when it is first asked for. */
export class Line {
  readonly seconds: number;
  private made: Float32Array<ArrayBuffer> | null = null;

  constructor(
    frames: number,
    readonly sampleRate: number,
    private readonly make: () => Float32Array<ArrayBuffer>,
  ) {
    this.seconds = (frames * Math.round(FRAME_S * sampleRate)) / sampleRate;
  }

  get samples(): Float32Array<ArrayBuffer> {
    return (this.made ??= this.make());
  }
}

/** One turn in a conversation. */
export interface Turn {
  side: Side;
  line: Line;
  /** Pause after the turn before (s); negative: they fall into each other's words. */
  gap: number;
  /** Loudness relative to a normal turn. */
  gain: number;
  /** Said by the other side while this goes on, `at` s into it. */
  aside?: { side: Side; line: Line; at: number; gain: number };
}

type Rng = () => number;
const pick = <T>(rng: Rng, items: readonly T[]): T => items[Math.min(items.length - 1, Math.floor(rng() * items.length))];
const between = (rng: Rng, a: number, b: number) => a + (b - a) * rng();

/** What to say next: a sentence in some style, or a small sound. */
type Say = { side: Side; gap: [number, number]; gain?: number; aside?: Interjection[] } & ({ style: Partial<Style> } | { sound: Interjection });

interface Scene {
  label: string;
  /** What is said next, given who spoke last and the number of turns so far. */
  next(rng: Rng, last: Side | null, n: number): Say;
  /** Say the first `n` turns, then the same again, for ever (a voice note on repeat). */
  repeat?: number;
  /** Nobody near the microphone speaks. */
  farOnly?: boolean;
}

const other = (s: Side | null): Side => (s === 'near' ? 'far' : 'near');

export const SCENES: Record<SceneId, Scene> = {
  // Someone calms them down: a long, slow voice on the line; they hardly answer.
  comfort: {
    label: 'being comforted',
    next: (rng, last) => {
      if (last === 'far' && rng() < 0.75) {
        const k = rng();
        if (k < 0.5) return { side: 'near', gap: [0.3, 0.9], gain: 0.8, sound: pick(rng, ['mm', 'mhm', 'yes', 'no']) };
        if (k < 0.65) return { side: 'near', gap: [0.2, 0.7], gain: 0.7, sound: 'sigh' };
        return { side: 'near', gap: [0.5, 1.3], gain: 0.8, style: { phrases: [1, 2], syllables: [2, 6], rate: 0.85, range: 0.75, breath: 0.35, mumble: 0.5, hesitate: 0.6, inhale: 0.6, end: 'fall', pause: [0.4, 1] } };
      }
      return { side: 'far', gap: [0.3, 0.9], aside: rng() < 0.3 ? ['mm', 'mhm'] : undefined, style: { phrases: [2, 4], syllables: [4, 9], rate: 0.84, range: 0.8, breath: 0.3, mumble: 0.35, hesitate: 0.1, end: 'fall', pause: [0.35, 0.8] } };
    },
  },
  // Two people who have a lot to tell each other.
  catchup: {
    label: 'catching up',
    next: (rng, last) => {
      const side = rng() < 0.85 ? other(last) : last ?? 'near';
      if (rng() < 0.22) return { side, gap: [0.02, 0.25], gain: 0.9, sound: pick(rng, ['aha', 'yes', 'no', 'mhm']) };
      return { side, gap: [-0.12, 0.3], aside: rng() < 0.45 ? ['mhm', 'aha', 'yes', 'no'] : undefined, style: { phrases: [1, 3], syllables: [5, 12], rate: 1.12, range: 1.35, mumble: 0.15, hesitate: 0.25, inhale: 0.5, end: pick(rng, ['fall', 'rise', 'rise', 'level']), pause: [0.1, 0.35] } };
    },
  },
  // A quarrel nobody around is supposed to hear.
  argument: {
    label: 'hushed argument',
    next: (rng, last, n) => {
      const side = rng() < 0.8 ? other(last) : last ?? 'near';
      if (rng() < 0.12) return { side, gap: [0.3, 1], gain: 0.8, sound: pick(rng, ['sigh', 'no', 'no']) };
      // Now and then nobody says anything for a while.
      const gap: [number, number] = n > 2 && rng() < 0.16 ? [1.4, 2.8] : [-0.4, 0.15];
      return { side, gap, gain: 1.05, aside: rng() < 0.2 ? ['no'] : undefined, style: { phrases: [1, 2], syllables: [4, 9], rate: 1.2, range: 1.55, breath: 0.12, mumble: 0.1, hesitate: 0.1, inhale: 0.55, end: pick(rng, ['fall', 'fall', 'rise']), pause: [0.08, 0.3] } };
    },
  },
  // A message from someone, played again and again.
  voicenote: {
    label: 'voice note on repeat',
    repeat: 3,
    farOnly: true,
    next: (_rng, _last, n) => ({ side: 'far', gap: n === 0 ? [1.3, 1.3] : [0.4, 0.9], style: { phrases: [2, 3], syllables: [5, 10], rate: 0.98, range: 1.1, breath: 0.12, mumble: 0.2, hesitate: 0.4, inhale: 0.7, end: n % 3 === 2 ? 'fall' : 'level', pause: [0.25, 0.7] } }),
  },
  // Something that must not be overheard: the near side whispers, the far one speaks under their breath.
  secret: {
    label: 'a secret',
    next: (rng, last) => {
      const side = rng() < 0.75 ? other(last) : last ?? 'near';
      if (rng() < 0.2) return { side, gap: [0.3, 1], gain: 0.8, sound: pick(rng, ['mm', 'yes', 'sigh']) };
      const near = side === 'near';
      return { side, gap: [0.2, 1.1], gain: near ? 0.85 : 0.9, style: { phrases: [1, 3], syllables: [3, 9], rate: 0.92, range: 0.8, whisper: near, breath: 0.5, mumble: 0.2, hesitate: 0.3, inhale: 0.6, end: pick(rng, ['fall', 'level', 'rise']), pause: [0.25, 0.8] } };
    },
  },
};

/** Two voices that cannot be mixed up. They are dealt at random, not guessed from how anyone looks. */
function makeSpeakers(rng: Rng): Record<Side, Speaker> {
  const kinds: { f0: [number, number]; tract: [number, number] }[] = [
    { f0: [88, 112], tract: [0.98, 1.04] },
    { f0: [118, 145], tract: [1.02, 1.09] },
    { f0: [168, 195], tract: [1.1, 1.16] },
    { f0: [200, 235], tract: [1.15, 1.21] },
  ];
  const a = Math.floor(rng() * kinds.length);
  const b = (a + (rng() < 0.5 ? 2 : rng() < 0.5 ? 1 : 3)) % kinds.length;
  const make = (k: (typeof kinds)[number]): Speaker => ({
    f0: between(rng, ...k.f0),
    tract: between(rng, ...k.tract),
    range: between(rng, 3.8, 6),
    breath: between(rng, 0.12, 0.3),
    rate: between(rng, 0.93, 1.1),
  });
  return { near: make(kinds[a]), far: make(kinds[b]) };
}

/** Loudness of a normal turn (dBFS, RMS of its loud parts). */
const TURN_DB = -18;

export class Script {
  private readonly language: Language;
  private readonly speakers: Record<Side, Speaker>;
  private readonly def: Scene;
  private last: Side | null = null;
  private n = 0;
  /** The turns of a scene that repeats. */
  private turns: Turn[] = [];

  constructor(
    scene: SceneId,
    /** For who they are: the same person has the same voices and language every time. */
    who: Rng,
    /** For what is said now. */
    private readonly rng: Rng,
    private readonly sampleRate: number,
  ) {
    this.def = SCENES[scene];
    this.language = makeLanguage(who);
    this.speakers = makeSpeakers(who);
  }

  get farOnly(): boolean {
    return !!this.def.farOnly;
  }

  static repeats(scene: SceneId): boolean {
    return !!SCENES[scene].repeat;
  }

  /** All the turns of a scene that repeats; null for the others. */
  tape(intimacy: number): Turn[] | null {
    const loop = this.def.repeat;
    if (!loop) return null;
    while (this.turns.length < loop) this.next(intimacy, 0);
    return this.turns;
  }

  /** Go on with turn number `n` of a scene that repeats. */
  seek(n: number): void {
    this.n = n;
  }

  /** The next turn. `intimacy` (0..1): how long the phone has been held; `agitation`: how much it moves. */
  next(intimacy: number, agitation: number): Turn {
    const loop = this.def.repeat;
    if (loop && this.turns.length === loop) return this.turns[this.n++ % loop];
    const turn = this.write(intimacy, agitation);
    if (loop) this.turns.push(turn);
    this.n++;
    return turn;
  }

  private write(intimacy: number, agitation: number): Turn {
    const say = this.def.next(this.rng, this.last, this.n);
    this.last = say.side;
    const calm = (1 - 0.14 * intimacy) * (1 + 0.22 * agitation);
    const lively = (1 - 0.25 * intimacy) * (1 + 0.4 * agitation);
    const gap = between(this.rng, ...say.gap);
    const line = this.voice(say, calm, lively, intimacy);
    const turn: Turn = {
      side: say.side,
      line,
      gap: gap > 0 ? gap * (1 + 0.8 * intimacy) * (1 - 0.6 * agitation) : gap,
      gain: (say.gain ?? 1) * (1 - 0.2 * intimacy) * (1 + 0.15 * agitation),
    };
    if (say.aside) {
      const aside = this.voice({ side: other(say.side), gap: [0, 0], sound: pick(this.rng, say.aside) }, calm, lively, intimacy);
      turn.aside = { side: other(say.side), line: aside, at: line.seconds * between(this.rng, 0.35, 0.8), gain: 0.5 };
    }
    return turn;
  }

  private voice(say: Say, rate: number, range: number, intimacy: number): Line {
    const speaker = this.speakers[say.side];
    const given: Partial<Style> = 'style' in say ? say.style : {};
    const style: Style = {
      ...STYLE,
      ...given,
      rate: (given.rate ?? 1) * rate,
      range: (given.range ?? 1) * range,
      breath: Math.min(0.75, (given.breath ?? 0) + 0.3 * intimacy),
    };
    const tracks = 'sound' in say ? interject(say.sound, speaker, style, this.rng) : speak(this.language, speaker, style, this.rng);
    // Its own random numbers, so it sounds the same whenever it is made.
    const seed = Math.floor(this.rng() * 2 ** 32);
    return new Line(tracks.frames, this.sampleRate, () => {
      const x = synthesise(tracks, speaker, this.sampleRate, mulberry32(seed));
      level(x, TURN_DB);
      return x;
    });
  }
}
