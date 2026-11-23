// A small formant speech synthesiser (after Klatt 1980): turns control tracks into a voice.
// Pure arithmetic, no Web Audio, so it can also run in a test without a browser.
//
//   glottal pulses (voice) ─┐
//   breath noise ───────────┴→ nose (blended in) → F1 → … → F6 ────┬→ voice
//   hiss (s, f, sch …) ──────→ band-pass ──────────────────────────┘
//
// It knows nothing about language: babble.ts decides what is "said" and fills the tracks.

/** Length of one control frame (s). */
export const FRAME_S = 0.005;

/** What makes one speaker sound different from another. */
export interface Speaker {
  /** Pitch at rest (Hz). */
  f0: number;
  /** How far the pitch moves on stressed syllables (semitones). */
  range: number;
  /** Formant scale: 1 for a long vocal tract (deep voice), 1.2 for a short one. */
  tract: number;
  /** 0..1: how breathy the voice is at rest. */
  breath: number;
  /** Speaking rate, 1 = normal. */
  rate: number;
}

/** Control tracks: one value per frame. Amplitudes are 0..1. */
export interface Tracks {
  frames: number;
  /** Pitch (Hz). */
  f0: Float32Array;
  /** Voice, breath and hiss. */
  av: Float32Array;
  ah: Float32Array;
  af: Float32Array;
  /** Formants (Hz), already scaled to the speaker. */
  f1: Float32Array;
  f2: Float32Array;
  f3: Float32Array;
  /** 0..1: through the nose. */
  nasal: Float32Array;
  /** Centre (Hz) and bandwidth (Hz) of the hiss. */
  fc: Float32Array;
  fb: Float32Array;
  /** 0..1: breathiness (softer pulses, more air). */
  breath: Float32Array;
}

export function makeTracks(frames: number): Tracks {
  const a = () => new Float32Array(frames);
  return { frames, f0: a(), av: a(), ah: a(), af: a(), f1: a(), f2: a(), f3: a(), nasal: a(), fc: a(), fb: a(), breath: a() };
}

/** Two-pole resonator with unity gain at 0 Hz. */
class Resonator {
  a = 1;
  b = 0;
  c = 0;
  y1 = 0;
  y2 = 0;
  set(freq: number, bw: number, sr: number): void {
    const r = Math.exp((-Math.PI * bw) / sr);
    this.c = -r * r;
    this.b = 2 * r * Math.cos((2 * Math.PI * Math.min(freq, sr * 0.45)) / sr);
    this.a = 1 - this.b - this.c;
  }
  run(x: number): number {
    const y = this.a * x + this.b * this.y1 + this.c * this.y2;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }
}

/** The opposite of a Resonator: a notch. */
class AntiResonator {
  a = 1;
  b = 0;
  c = 0;
  x1 = 0;
  x2 = 0;
  set(freq: number, bw: number, sr: number): void {
    const r = Math.exp((-Math.PI * bw) / sr);
    const c = -r * r;
    const b = 2 * r * Math.cos((2 * Math.PI * freq) / sr);
    const a = 1 / (1 - b - c);
    this.a = a;
    this.b = -b * a;
    this.c = -c * a;
  }
  run(x: number): number {
    const y = this.a * x + this.b * this.x1 + this.c * this.x2;
    this.x2 = this.x1;
    this.x1 = x;
    return y;
  }
}

/** Band-pass with unity gain at its centre. */
class BandPass {
  b0 = 0;
  a1 = 0;
  a2 = 0;
  x1 = 0;
  x2 = 0;
  y1 = 0;
  y2 = 0;
  set(freq: number, bw: number, sr: number): void {
    const w = (2 * Math.PI * Math.min(freq, sr * 0.42)) / sr;
    const alpha = Math.sin(w) / (2 * Math.max(0.3, freq / Math.max(50, bw)));
    const a0 = 1 + alpha;
    this.b0 = alpha / a0;
    this.a1 = (-2 * Math.cos(w)) / a0;
    this.a2 = (1 - alpha) / a0;
  }
  run(x: number): number {
    const y = this.b0 * (x - this.x2) - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1;
    this.x1 = x;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }
}

/** Roughly normal, about -1..1 (sd 0.33). */
const gauss = (rng: () => number) => (rng() + rng() + rng()) * (2 / 3) - 1;

/**
 * Speak the tracks. The result is not levelled: the caller brings it to the loudness it wants.
 */
export function synthesise(t: Tracks, speaker: Speaker, sr: number, rng: () => number): Float32Array<ArrayBuffer> {
  const hop = Math.round(FRAME_S * sr);
  const out = new Float32Array(t.frames * hop);
  const r1 = new Resonator();
  const r2 = new Resonator();
  const r3 = new Resonator();
  const r4 = new Resonator();
  const r5 = new Resonator();
  const r6 = new Resonator();
  const nasalPole = new Resonator();
  const nasalZero = new AntiResonator();
  const hiss = new BandPass();
  const hiss2 = new BandPass();
  // The upper formants hardly move; they carry the speaker's colour.
  const k = speaker.tract;
  r4.set(3450 * k, 190, sr);
  r5.set(4250 * k, 230, sr);
  r6.set(5200 * k, 380, sr);
  // The nose: fixed filters, blended in. (Retuning a notch while it sounds clicks.)
  nasalPole.set(280, 90, sr);
  nasalZero.set(520, 130, sr);
  // Formants are retuned every millisecond, so they glide.
  const sub = Math.max(1, Math.round(sr / 1000));

  let phase = 0;
  let period = 1; // this pulse's length relative to the pitch (jitter)
  let pulse = 1; // this pulse's strength (shimmer)
  let tilt = 0;
  let tilt2 = 0;
  let prevNoise = 0;
  // A slow, small wandering of the pitch: a held note that does not wander sounds like a machine.
  let wander = 0;
  let wanderGoal = 0;

  for (let i = 0; i < t.frames; i++) {
    const j = Math.min(i + 1, t.frames - 1);
    const breath = t.breath[i];
    const nasal = t.nasal[i];
    hiss.set(t.fc[i] || 4000, t.fb[i] || 2000, sr);
    hiss2.set((t.fc[i] || 4000) * 1.55, (t.fb[i] || 2000) * 1.3, sr);
    const open = 0.56 + 0.24 * breath;
    // Softer voices lose their top: tilt cut-off from 9 kHz (pressed) to 1 kHz (very breathy).
    const tiltHz = 9000 * 0.11 ** breath;
    const tk = 1 - Math.exp((-2 * Math.PI * tiltHz) / sr);
    const tk2 = 1 - Math.exp((-2 * Math.PI * Math.min(12000, tiltHz * 4)) / sr);
    if (rng() < 0.06) wanderGoal = gauss(rng) * 0.012;
    for (let n = 0; n < hop; n++) {
      const x = n / hop;
      if (n % sub === 0) {
        // Wide first formant when breathy or nasal: the resonance leaks away.
        r1.set(t.f1[i] + (t.f1[j] - t.f1[i]) * x, 60 + 55 * breath + 70 * nasal, sr);
        r2.set(t.f2[i] + (t.f2[j] - t.f2[i]) * x, 85 + 40 * breath + 40 * nasal, sr);
        r3.set(t.f3[i] + (t.f3[j] - t.f3[i]) * x, 140 + 60 * breath, sr);
      }
      const av = t.av[i] + (t.av[j] - t.av[i]) * x;
      const ah = t.ah[i] + (t.ah[j] - t.ah[i]) * x;
      const af = t.af[i] + (t.af[j] - t.af[i]) * x;
      const f0 = t.f0[i] + (t.f0[j] - t.f0[i]) * x;
      wander += (wanderGoal - wander) * 0.0004;

      phase += ((f0 * (1 + wander)) / sr) * period;
      if (phase >= 1) {
        phase -= 1;
        period = 1 + 0.011 * gauss(rng);
        pulse = 1 + 0.07 * gauss(rng);
      }
      // Glottal flow derivative (KLGLOTT88): the folds open, then close abruptly.
      const isOpen = phase < open;
      let g = 0;
      if (isOpen) {
        const u = phase / open;
        g = (2 * u - 3 * u * u) * pulse;
      }
      tilt += (g - tilt) * tk;
      tilt2 += (tilt - tilt2) * tk2;
      const noise = rng() * 2 - 1;
      // Breath comes in puffs while the voice is on (the folds gate it).
      const puff = av > 0.02 ? (isOpen ? 1 : 0.3) : 1;
      // Differenced noise: the lips radiate high frequencies better (the pulses have this already).
      const air = (noise - 0.9 * prevNoise) * puff * (ah * 0.5 + av * breath * 0.3);
      const hp = noise - prevNoise;
      prevNoise = noise;
      let v = tilt2 * av + air;
      const nose = nasal + (t.nasal[j] - nasal) * x;
      v += (nasalPole.run(nasalZero.run(v)) - v) * nose;
      v = r6.run(r5.run(r4.run(r3.run(r2.run(r1.run(v))))));
      // The hiss: high-passed noise through two bands, not through the throat.
      const h = af > 0.001 ? (hiss.run(hp) + 0.5 * hiss2.run(hp)) * af * 0.75 : 0;
      out[i * hop + n] = v + h;
    }
  }
  return out;
}

/** Bring a piece of speech to `db` (RMS of its loud parts, dBFS), without ever passing ±0.95. */
export function level(x: Float32Array, db: number): void {
  // Loudness of the speech itself: windows well below the loudest ones (pauses) do not count.
  const w = 1024;
  const e: number[] = [];
  for (let i = 0; i + w <= x.length; i += w) {
    let s = 0;
    for (let n = 0; n < w; n++) s += x[i + n] * x[i + n];
    e.push(s / w);
  }
  if (!e.length) return;
  const top = Math.max(...e);
  if (top <= 0) return;
  const loud = e.filter((v) => v > top * 0.03);
  const rms = Math.sqrt(loud.reduce((a, b) => a + b, 0) / loud.length);
  let peak = 0;
  for (const v of x) peak = Math.max(peak, Math.abs(v));
  const gain = Math.min(10 ** (db / 20) / rms, 0.95 / peak);
  for (let i = 0; i < x.length; i++) x[i] *= gain;
}
