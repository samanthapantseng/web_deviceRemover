// What the murmuring voices "say": an invented language with the rhythm and melody of speech and
// no words in it. Nobody's conversation, so there is nothing to understand, however close you get.
//
// A Language is a small vocabulary of made-up words, a few of them very frequent, as in a real
// language: hearing the same short words again and again is much of what makes speech sound like
// speech. speak() strings them into phrases, gives them stress, melody, pauses and breaths, and
// fills the control tracks for the synthesiser (formant.ts). interject() makes the small sounds
// between the words: mhm, yes, a sigh. (No laughing: it never sounded like a laugh.)
import { FRAME_S, makeTracks, type Speaker, type Tracks } from './formant';

type Rng = () => number;
type Formants = readonly [number, number, number];

const pick = <T>(rng: Rng, list: readonly T[]): T => list[Math.min(list.length - 1, Math.floor(rng() * list.length))];
const between = (rng: Rng, a: number, b: number) => a + (b - a) * rng();
const intBetween = (rng: Rng, a: number, b: number) => Math.floor(between(rng, a, b + 1 - 1e-9));

// ---------------------------------------------------------------------------------------------
// Sounds. Formants are those of a deep voice (long vocal tract); the speaker's `tract` scales them.

const VOWELS: Record<string, Formants> = {
  i: [290, 2250, 2950],
  I: [400, 1920, 2550],
  e: [420, 2080, 2620],
  E: [560, 1760, 2500],
  a: [720, 1260, 2560],
  o: [440, 820, 2480],
  O: [570, 900, 2450],
  u: [320, 800, 2280],
  U: [430, 1020, 2300],
  V: [640, 1200, 2420],
  '@': [490, 1420, 2470],
  y: [290, 1750, 2150],
  Q: [420, 1500, 2250], // ö
};
/** Vowels that move: from one to the other. */
const GLIDES: Record<string, [string, string]> = { aI: ['a', 'I'], aU: ['a', 'U'], OI: ['O', 'I'], eI: ['e', 'I'], oU: ['o', 'U'] };

/** One steady piece of sound; the tracks are drawn as steps and then smoothed into transitions. */
interface Piece {
  /** Length (s). */
  d: number;
  /** Formants; null: those of the neighbouring sound (h, breath). */
  f: Formants | null;
  av?: number;
  ah?: number;
  af?: number;
  fc?: number;
  fb?: number;
  nasal?: number;
  /** Extra breathiness here (sighs). */
  breath?: number;
}

const P: Formants = [220, 820, 2150]; // lips closing
const T: Formants = [220, 1720, 2620]; // tongue tip
const K: Formants = [230, 1900, 2350]; // tongue back

const CONSONANTS: Record<string, Piece[]> = {
  p: [{ d: 0.06, f: P }, { d: 0.01, f: P, af: 0.3, fc: 1100, fb: 1500 }, { d: 0.03, f: P, ah: 0.6 }],
  t: [{ d: 0.052, f: T }, { d: 0.012, f: T, af: 0.5, fc: 4300, fb: 3000 }, { d: 0.032, f: T, ah: 0.6 }],
  k: [{ d: 0.055, f: K }, { d: 0.014, f: K, af: 0.45, fc: 2000, fb: 1300 }, { d: 0.036, f: K, ah: 0.6 }],
  b: [{ d: 0.05, f: P, av: 0.2 }, { d: 0.008, f: P, av: 0.3, af: 0.12, fc: 1100, fb: 1500 }],
  d: [{ d: 0.045, f: T, av: 0.2 }, { d: 0.008, f: T, av: 0.3, af: 0.17, fc: 4000, fb: 3000 }],
  g: [{ d: 0.05, f: K, av: 0.2 }, { d: 0.01, f: K, av: 0.3, af: 0.16, fc: 2000, fb: 1300 }],
  f: [{ d: 0.085, f: [300, 1000, 2250], af: 0.22, fc: 5200, fb: 6500 }],
  s: [{ d: 0.095, f: [300, 1500, 2600], af: 0.6, fc: 6300, fb: 3200 }],
  S: [{ d: 0.095, f: [300, 1750, 2500], af: 0.62, fc: 3100, fb: 2000 }],
  x: [{ d: 0.085, f: [400, 1500, 2400], af: 0.42, fc: 1750, fb: 1200, ah: 0.2 }],
  h: [{ d: 0.06, f: null, ah: 0.55 }],
  v: [{ d: 0.06, f: [280, 1000, 2250], av: 0.42, af: 0.08, fc: 5200, fb: 6500 }],
  z: [{ d: 0.07, f: [280, 1500, 2600], av: 0.36, af: 0.3, fc: 6300, fb: 3200 }],
  m: [{ d: 0.07, f: [280, 1000, 2200], av: 0.5, nasal: 1 }],
  n: [{ d: 0.062, f: [280, 1580, 2600], av: 0.5, nasal: 1 }],
  N: [{ d: 0.07, f: [290, 2050, 2650], av: 0.48, nasal: 1 }],
  l: [{ d: 0.058, f: [350, 1150, 2750], av: 0.62 }],
  r: [{ d: 0.055, f: [360, 1200, 1750], av: 0.6 }],
  R: [{ d: 0.062, f: [470, 1150, 2350], av: 0.45, af: 0.14, fc: 1300, fb: 1000 }], // in the throat
  w: [{ d: 0.055, f: [310, 680, 2200], av: 0.62 }],
  j: [{ d: 0.052, f: [280, 2150, 2900], av: 0.62 }],
};

// ---------------------------------------------------------------------------------------------
// The invented language.

interface Syllable {
  onset: string[];
  vowel: string;
  coda: string[];
}
interface Word {
  syllables: Syllable[];
  /** Index of the stressed syllable; -1 for the small words. */
  stress: number;
}

export interface Language {
  small: Word[];
  words: Word[];
}

/** Sounds a language likes: repeated entries are more frequent. A consonant cluster is 'S+t'. */
interface Flavour {
  onsets: string[];
  vowels: string[];
  codas: string[];
}

const list = (s: string) => s.split(' ');
const FLAVOURS: Flavour[] = [
  // Closed syllables, throaty sounds, rounded vowels.
  {
    onsets: list('d d d v v n n m m g b h h z S f l k t R j d+R S+t g+l b+R S+p t+s'),
    vowels: list('a a e E I I O U aI aI aU i o y Q @ @ u'),
    codas: list('- - - - n n n t s x l m R n+t s+t x+t k N'),
  },
  // Open syllables, pure vowels.
  {
    onsets: list('k p t t d d m m n n l l s s r r b v f g p+r t+r k+w j S'),
    vowels: list('a a a e e i i o o o u E'),
    codas: list('- - - - - - - - - n s r l'),
  },
  // Diphthongs, soft r, many unstressed vowels.
  {
    onsets: list('w w d d n n m l l r j s s t t k b g h f S v s+t p+l t+r k+l'),
    vowels: list('@ @ I I E E V a eI aI oU i u O U'),
    codas: list('- - - - n n t t d s l m z N k n+t s+t l+d'),
  },
];

const cluster = (s: string) => (s === '-' ? [] : s.split('+'));

export function makeLanguage(rng: Rng): Language {
  const fl = pick(rng, FLAVOURS);
  const syllable = (reduced: boolean): Syllable => ({
    onset: rng() < 0.12 ? [] : cluster(pick(rng, fl.onsets)),
    vowel: reduced ? pick(rng, ['@', '@', 'I', fl.vowels[0]]) : pick(rng, fl.vowels),
    coda: reduced && rng() < 0.6 ? [] : cluster(pick(rng, fl.codas)),
  });
  const small: Word[] = Array.from({ length: 9 }, () => {
    const s = syllable(true);
    // Small words are light: never a cluster in front.
    return { syllables: [{ ...s, onset: s.onset.slice(0, 1), coda: s.coda.slice(0, 1) }], stress: -1 };
  });
  const words: Word[] = Array.from({ length: 70 }, () => {
    const n = pick(rng, [1, 1, 2, 2, 2, 3]);
    const stress = n === 3 ? pick(rng, [0, 1]) : 0;
    return { syllables: Array.from({ length: n }, (_, i) => syllable(i !== stress && rng() < 0.75)), stress };
  });
  return { small, words };
}

/** Frequent words far more often than rare ones (Zipf). */
const zipf = <T>(rng: Rng, items: T[]): T => items[Math.min(items.length - 1, Math.floor(items.length ** rng() - 1))];

// ---------------------------------------------------------------------------------------------
// Speaking.

/** How something is said. */
export interface Style {
  /** Phrases, and syllables per phrase (from, to). */
  phrases: [number, number];
  syllables: [number, number];
  /** Relative to the speaker: 1 = as they normally do. */
  rate: number;
  range: number;
  /** 0..1: added breathiness; whisper: no voice at all. */
  breath: number;
  whisper: boolean;
  /** 0..1: how little the mouth moves. */
  mumble: number;
  /** Melody at the end of the last phrase. */
  end: 'fall' | 'rise' | 'level';
  /** Chances: of hesitating in a phrase, of an audible breath before one. */
  hesitate: number;
  inhale: number;
  /** Pause between phrases (s). */
  pause: [number, number];
}

export const STYLE: Style = {
  phrases: [1, 2],
  syllables: [5, 11],
  rate: 1,
  range: 1,
  breath: 0,
  whisper: false,
  mumble: 0.25,
  end: 'fall',
  hesitate: 0.15,
  inhale: 0.4,
  pause: [0.18, 0.5],
};

export type Interjection = 'mhm' | 'mm' | 'aha' | 'yes' | 'no' | 'sigh';

/** Pieces in time, with the melody as (time, semitones) points and accents on top. */
class Score {
  pieces: (Piece & { t: number })[] = [];
  melody: { t: number; st: number }[] = [];
  accents: { t0: number; t1: number; st: number }[] = [];
  t = 0;
  add(p: Piece, stretch = 1, loud = 1): void {
    this.pieces.push({ ...p, d: p.d * stretch, av: (p.av ?? 0) * loud, ah: (p.ah ?? 0) * loud, af: (p.af ?? 0) * loud, t: this.t });
    this.t += p.d * stretch;
  }
  rest(d: number): void {
    this.add({ d, f: null });
  }
  pitch(st: number, at = this.t): void {
    this.melody.push({ t: at, st });
  }
}

/** A stretch of invented speech. */
export function speak(lang: Language, speaker: Speaker, style: Style, rng: Rng): Tracks {
  const s = new Score();
  s.rest(0.03);
  const phrases = intBetween(rng, ...style.phrases);
  const range = speaker.range * style.range;
  const rate = speaker.rate * style.rate;
  for (let p = 0; p < phrases; p++) {
    if (p) s.rest(between(rng, ...style.pause));
    if (rng() < style.inhale) inhale(s, rng);
    const last = p === phrases - 1;
    // Each phrase starts a little lower than the one before.
    phrase(s, lang, style, rng, rate, range, 1 - 0.12 * p, last ? style.end : rng() < 0.5 ? 'level' : 'rise');
  }
  s.rest(0.06);
  return render(s, speaker, style, rng);
}

/** A small sound between the words. */
export function interject(kind: Interjection, speaker: Speaker, style: Style, rng: Rng): Tracks {
  const s = new Score();
  const r = speaker.range * style.range;
  const slow = 1 / (speaker.rate * style.rate);
  const M: Piece = { d: 0.17, f: [280, 1000, 2200], av: 0.6, nasal: 1 };
  const vowel = (v: string, d: number, av = 0.9): Piece => ({ d, f: VOWELS[v], av });
  s.rest(0.03);
  switch (kind) {
    case 'mhm':
      // Half nasal vowel, half hum: a pure hum sounds like a synthesizer.
      s.pitch(0.3 * r);
      s.add({ d: 0.05, f: VOWELS['@'], av: 0.4, nasal: 0.5 }, slow);
      s.add({ ...M, d: 0.09 }, slow);
      s.add({ d: 0.07, f: VOWELS['@'], av: 0.08, ah: 0.4, nasal: 0.4 });
      s.pitch(-0.2 * r);
      s.add({ d: 0.09, f: VOWELS['@'], av: 0.75, nasal: 0.5 }, slow);
      s.add({ ...M, d: 0.07 }, slow, 0.8);
      s.add({ ...M, d: 0.07 }, slow, 0.4);
      s.pitch(1.3 * r);
      break;
    case 'mm':
      s.pitch(1.0 * r);
      s.add({ d: 0.045, f: VOWELS['@'], ah: 0.35 });
      s.add({ d: 0.09, f: VOWELS['@'], av: 0.7, nasal: 0.45 }, slow);
      s.add({ ...M, d: 0.07 }, slow, 0.85);
      s.add({ ...M, d: 0.07 }, slow, 0.5);
      s.add({ ...M, d: 0.06 }, slow, 0.2);
      s.pitch(-1.2 * r);
      break;
    case 'aha':
      s.pitch(0.2 * r);
      s.add(vowel('a', 0.1, 0.7), slow);
      s.add({ d: 0.07, f: VOWELS.a, ah: 0.5 });
      s.add(vowel('a', 0.2), slow);
      s.pitch(1.3 * r);
      break;
    case 'yes':
      s.pitch(0.9 * r);
      s.add(CONSONANTS.j[0], slow);
      s.add(vowel('a', between(rng, 0.16, 0.34)), slow);
      s.add(vowel('@', 0.08, 0.5), slow);
      s.pitch(-0.7 * r);
      break;
    case 'no':
      s.pitch(1.2 * r);
      s.add(CONSONANTS.n[0], slow * 1.2);
      s.add(vowel('e', between(rng, 0.18, 0.36)), slow);
      s.pitch(-1.1 * r);
      break;
    case 'sigh': {
      s.pitch(1.2 * r);
      const d = between(rng, 0.5, 0.9);
      for (let i = 0; i < 6; i++) {
        const k = (1 - i / 6) ** 1.3;
        s.add({ d: d / 6, f: VOWELS['@'], av: 0.22 * k, ah: 0.75 * k, breath: 0.6 });
      }
      s.pitch(-1.6 * r);
      break;
    }
  }
  s.rest(0.08);
  return render(s, speaker, style, rng);
}

/** A breath taken in. The settings come from a search with macOS's sound classifier: many others sound like a burp or a snake. */
function inhale(s: Score, rng: Rng): void {
  const d = 0.31 * between(rng, 0.8, 1.25);
  for (const k of [0.25, 0.7, 1, 0.9, 0.6, 0.2]) s.add({ d: d / 6, f: [870, 1420, 2740], ah: 0.1 * k, af: 0.028 * k, fc: 2480, fb: 4050 });
  s.rest(0.06);
}

function phrase(s: Score, lang: Language, style: Style, rng: Rng, rate: number, range: number, height: number, end: Style['end']): void {
  // Words: small ones in between the others, until the phrase is long enough.
  const goal = intBetween(rng, ...style.syllables);
  const words: Word[] = [];
  let count = 0;
  let sinceContent = 0;
  while (count < goal) {
    const small = sinceContent < 2 && rng() < (sinceContent ? 0.35 : 0.6);
    const w = small ? zipf(rng, lang.small) : zipf(rng, lang.words);
    sinceContent = small ? sinceContent + 1 : 0;
    words.push(w);
    count += w.syllables.length;
  }
  // A phrase does not end on a small word.
  if (words[words.length - 1].stress < 0) words.push(zipf(rng, lang.words));
  const total = words.reduce((n, w) => n + w.syllables.length, 0);

  s.pitch(0.55 * range * height);
  let i = 0;
  words.forEach((w, wi) => {
    if (wi && rng() < style.hesitate * 0.5) {
      // Hesitating: the vowel before drags on, or an "ehm".
      if (rng() < 0.5) {
        s.add({ d: between(rng, 0.14, 0.3), f: VOWELS['@'], av: 0.5 }, 1);
        if (rng() < 0.6) s.add({ d: between(rng, 0.1, 0.2), f: [280, 1000, 2200], av: 0.4, nasal: 1 });
      }
      s.rest(between(rng, 0.1, 0.45));
    }
    // Every second or third content word carries the melody.
    const accent = w.stress >= 0 && (wi === words.length - 1 || rng() < 0.6);
    w.syllables.forEach((syl, si) => {
      const stressed = si === w.stress;
      const progress = i / Math.max(1, total - 1);
      const lastSyllable = i === total - 1;
      // Timing: stressed syllables are longer, the end of a phrase slows down, all a bit uneven.
      const dur = ((stressed ? 0.125 : 0.07) * (lastSyllable ? 1.75 : i === total - 2 ? 1.2 : 1) * Math.exp(between(rng, -0.22, 0.22))) / rate;
      const squeeze = ((stressed ? 1 : 0.78) * Math.exp(between(rng, -0.12, 0.12))) / rate ** 0.7;
      // Softer towards the end of the phrase, as the breath runs out.
      const loud = (stressed ? 1 : 0.68) * (1 - 0.35 * progress) * Math.exp(between(rng, -0.12, 0.12));
      const crisp = 1 - 0.45 * style.mumble;
      for (const c of syl.onset) for (const piece of CONSONANTS[c]) s.add(piece, squeeze, loud * (piece.af ? crisp : 1));
      const v0 = s.t;
      const g = GLIDES[syl.vowel];
      if (g) {
        s.add({ d: dur * 0.6, f: VOWELS[g[0]], av: 1 }, 1, loud);
        s.add({ d: dur * 0.5, f: VOWELS[g[1]], av: 0.75 }, 1, loud);
      } else {
        const open = VOWELS[syl.vowel][0] > 480 ? 1 : 0.8;
        s.add({ d: dur, f: VOWELS[syl.vowel], av: open }, 1, loud);
      }
      const v1 = s.t;
      for (const c of syl.coda) for (const piece of CONSONANTS[c]) s.add(piece, squeeze * 0.85, loud * 0.8 * (piece.af ? crisp : 1));
      if (stressed && accent) s.accents.push({ t0: v0 - 0.07, t1: v1 + 0.09, st: range * between(rng, 0.45, 1) * (1 - 0.35 * progress) });
      if (lastSyllable) {
        if (end === 'fall') {
          s.pitch(-0.35 * range * height, v0);
          s.pitch(-0.95 * range, v1);
        } else if (end === 'rise') {
          s.pitch(-0.1 * range, v0);
          s.pitch(1.0 * range, v1);
        } else {
          s.pitch(0, v0);
          s.pitch(0.08 * range, v1);
        }
      }
      i++;
    });
  });
}

// ---------------------------------------------------------------------------------------------
// From the score to the tracks.

/** Smooth a track of steps with a raised-cosine window `ms` wide (the transitions between sounds). */
function smooth(x: Float32Array, ms: number): Float32Array {
  const half = Math.round(ms / 1000 / FRAME_S / 2);
  if (half < 1) return x;
  const w: number[] = [];
  for (let k = -half; k <= half; k++) w.push(0.5 + 0.5 * Math.cos((Math.PI * k) / (half + 1)));
  const out = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) {
    let sum = 0;
    let n = 0;
    for (let k = -half; k <= half; k++) {
      const j = i + k;
      if (j < 0 || j >= x.length) continue;
      sum += x[j] * w[k + half];
      n += w[k + half];
    }
    out[i] = sum / n;
  }
  return out;
}

function render(s: Score, speaker: Speaker, style: Style, rng: Rng): Tracks {
  const frames = Math.ceil(s.t / FRAME_S) + 1;
  const t = makeTracks(frames);
  const breath = Math.min(1, speaker.breath + style.breath);

  // Pieces without formants of their own take those of what comes next (an h is shaped like its
  // vowel); silence keeps the mouth where it was.
  const formants: Formants[] = [];
  let ahead: Formants = VOWELS['@'];
  for (let i = s.pieces.length - 1; i >= 0; i--) {
    ahead = s.pieces[i].f ?? ahead;
    formants[i] = ahead;
  }

  s.pieces.forEach((p, i) => {
    const a = Math.round(p.t / FRAME_S);
    const b = Math.min(frames, Math.max(a + 1, Math.round((p.t + p.d) / FRAME_S)));
    for (let k = a; k < b; k++) {
      t.f1[k] = formants[i][0] * speaker.tract * (style.whisper ? 1.12 : 1);
      t.f2[k] = formants[i][1] * speaker.tract;
      t.f3[k] = formants[i][2] * speaker.tract;
      t.av[k] = style.whisper ? 0 : p.av ?? 0;
      t.ah[k] = (p.ah ?? 0) + (style.whisper ? (p.av ?? 0) * 1.1 : 0);
      t.af[k] = (p.af ?? 0) * (style.whisper ? 0.6 : 1);
      t.nasal[k] = p.nasal ?? 0;
      t.fc[k] = p.fc ?? 0;
      t.fb[k] = p.fb ?? 0;
      t.breath[k] = Math.min(1, breath + (p.breath ?? 0));
    }
  });
  for (let k = 1; k < frames; k++) if (!t.f1[k]) [t.f1[k], t.f2[k], t.f3[k], t.breath[k]] = [t.f1[k - 1], t.f2[k - 1], t.f3[k - 1], t.breath[k - 1]];
  // The hiss keeps its colour through the fades at its edges.
  for (let k = 1; k < frames; k++) if (!t.fc[k]) [t.fc[k], t.fb[k]] = [t.fc[k - 1], t.fb[k - 1]];
  for (let k = frames - 2; k >= 0; k--) if (!t.fc[k] || (t.af[k] === 0 && t.af[k + 1] > 0)) [t.fc[k], t.fb[k]] = [t.fc[k + 1], t.fb[k + 1]];

  const move = 46 + 46 * style.mumble;
  t.f1 = smooth(t.f1, move * 0.85);
  t.f2 = smooth(t.f2, move);
  t.f3 = smooth(t.f3, move);
  t.av = smooth(t.av, 24);
  t.ah = smooth(t.ah, 22);
  t.af = smooth(t.af, 14);
  t.nasal = smooth(t.nasal, 30);
  t.breath = smooth(t.breath, 60);

  // Melody: the line through its points, the accents on top, and a slow drift.
  const st = new Float32Array(frames);
  const pts = s.melody.length ? [...s.melody].sort((a, b) => a.t - b.t) : [{ t: 0, st: 0 }];
  let m = 0;
  for (let k = 0; k < frames; k++) {
    const now = k * FRAME_S;
    while (m < pts.length - 1 && pts[m + 1].t <= now) m++;
    const a = pts[m];
    const b = pts[m + 1];
    st[k] = !b || now <= a.t ? a.st : a.st + ((b.st - a.st) * (now - a.t)) / Math.max(1e-6, b.t - a.t);
  }
  for (const acc of s.accents) {
    const a = Math.max(0, Math.round(acc.t0 / FRAME_S));
    const b = Math.min(frames, Math.round(acc.t1 / FRAME_S));
    for (let k = a; k < b; k++) st[k] += acc.st * (0.5 - 0.5 * Math.cos((2 * Math.PI * (k - a)) / Math.max(1, b - a)));
  }
  let drift = 0;
  let goal = 0;
  for (let k = 0; k < frames; k++) {
    if (rng() < FRAME_S * 2.5) goal = between(rng, -0.6, 0.6);
    drift += (goal - drift) * 0.06;
    t.f0[k] = st[k] + drift;
  }
  t.f0 = smooth(t.f0, 60);
  for (let k = 0; k < frames; k++) t.f0[k] = speaker.f0 * 2 ** (t.f0[k] / 12);
  return t;
}
