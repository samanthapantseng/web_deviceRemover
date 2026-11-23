// Hijack mode: aim the camera at someone's phone and hear "their" conversation in headphones.
// Nothing is intercepted: it is a murmur without words, made up on the spot.
//
// The picture is left as it is. On every processed frame this effect:
//
// 1. Measures each phone the tracker has decided on: how far its centre is from the centre of
//    the picture (relative to the focus zone), how big it is, how long it has been held, and how
//    much it moves.
// 2. Decides which phone is in focus, with hysteresis so the sound does not flip between two
//    people:
//    - nothing in focus: the most centred phone inside the zone is locked on after LOCK_MS;
//    - something in focus: it stays in focus while it is inside the zone (with EXIT_ZONE of
//      slack), and while it is lost for less than "keep sound when phone lost" (a detection
//      dropout must not cut the sound); another phone takes over only when it is clearly more
//      centred (SWITCH_MARGIN), for SWITCH_MS, and not within MIN_FOCUS_MS of the last switch.
// 3. Tells the sound engine. Outside the zone, or with no phone: silence.
//
// Each person (tracker id) keeps the conversation, voices and language they were first given, and
// has a clock of their own: they have been talking since before the camera saw them (a random
// 0–2 min, fixed per person), so one comes in mid-sentence, and when one comes back it has moved
// on. The tracker forgets someone who is out of sight for more than 1 s, so turning away and back
// gives that person another conversation.
import { clamp01, type VoiceParams } from '../audio/conversation';
import type { SoundOutput } from '../audio/output';
import { SCENE_IDS, type SceneId, type Settings } from '../settings';
import type { Effect, EffectFrame, PickedPhone } from './types';

/** A phone inside the zone is locked on after this long (ms), so a sweep across a room does not trigger every phone. */
const LOCK_MS = 250;
/** A phone in focus stays in focus until it is this far out (1 = the edge of the zone). */
const EXIT_ZONE = 1.25;
/** Another phone must be this much closer to the centre (in zone radii) to take over… */
const SWITCH_MARGIN = 0.25;
/** …for this long (ms)… */
const SWITCH_MS = 600;
/** …and not sooner than this (ms) after the last switch. */
const MIN_FOCUS_MS = 1500;
/** The ring fades in and out over about this long (ms). */
const RING_FADE_MS = 400;

interface Person {
  scene: SceneId;
  seed: number;
  /** performance.now() at which their conversation "started" (before the camera saw them). */
  zero: number;
}

interface Measured {
  phone: PickedPhone;
  /** Distance of its centre from the picture's centre, in zone radii (1 = the edge of the zone). */
  d: number;
}

export class HijackEffect implements Effect {
  readonly id = 'hijack';

  private focus: { id: number; since: number; lastSeen: number; key: string; params: VoiceParams } | null = null;
  private challenger: { id: number; since: number } | null = null;
  private lastSwitch = -Infinity;
  private people = new Map<number, Person>();
  private deck: SceneId[] = [];
  private lastScene: SceneId | null = null;
  private salt = Math.floor(Math.random() * 2 ** 31);
  /** Per phone: last centre and how much it has been moving (0..1, smoothed). */
  private motion = new Map<number, { x: number; y: number; t: number; activity: number }>();
  private settings: Settings | null = null;
  private volume = -1;
  /** Where the ring is drawn (smoothed towards the focused phone) and how visible it is. */
  private ring = { x: 0, y: 0, r: 0, alpha: 0, target: false };
  private ringGoal = { x: 0, y: 0, r: 0 };
  private lastRender = 0;

  constructor(
    private width: number,
    private height: number,
    private sound: SoundOutput,
  ) {}

  watchMs(s: Settings): number {
    return s.hijackWatchMs;
  }

  describe(): string {
    const out = this.sound.status();
    const f = this.focus;
    if (!f) return `hijack · nothing in focus · ${out}`;
    const p = f.params;
    const pct = (v: number) => `${Math.round(v * 100)}`;
    const who = this.people.get(f.id);
    return `hijack · #${f.id} ${this.effectiveScene(who)} · clear ${pct(p.clarity)} · near ${pct(p.closeness)} · intimate ${pct(p.build)} · moving ${pct(p.activity)} · ${out}`;
  }

  reset(): void {
    this.volume = -1;
    this.focus = null;
    this.challenger = null;
    this.ring.alpha = 0;
    this.ring.target = false;
    this.sound.release();
  }

  deactivate(): void {
    this.reset();
  }

  onMask(f: EffectFrame): void {
    const s = f.settings;
    this.settings = s;
    this.sound.ensure();
    if (s.hijackVolume !== this.volume) this.sound.setVolume((this.volume = s.hijackVolume));
    const now = performance.now();
    const W = this.width;
    const H = this.height;
    const zone = Math.max(1, (s.hijackZone * Math.min(W, H)) / 2);
    const measured: Measured[] = f.phones.map((phone) => {
      const cx = (phone.x1 + phone.x2) / 2;
      const cy = (phone.y1 + phone.y2) / 2;
      this.track(phone, cx, cy, now);
      return { phone, d: Math.hypot(cx - W / 2, cy - H / 2) / zone };
    });
    for (const [id, m] of this.motion) if (now - m.t > 3000) this.motion.delete(id);

    // Which phone is in focus.
    const cur = this.focus ? measured.find((m) => m.phone.id === this.focus!.id) : undefined;
    if (this.focus && cur) this.focus.lastSeen = now;
    const keep = !!this.focus && (cur ? cur.d <= EXIT_ZONE : now - this.focus.lastSeen <= s.hijackHoldMs);
    const best = measured.filter((m) => m.phone.id !== this.focus?.id && m.d <= 1).sort((a, b) => a.d - b.d)[0];
    const better = !!best && (!keep || !cur || best.d < cur.d - SWITCH_MARGIN);
    let next: Measured | null = null;
    if (better) {
      if (this.challenger?.id !== best.phone.id) this.challenger = { id: best.phone.id, since: now };
      const waited = now - this.challenger.since >= (keep ? SWITCH_MS : LOCK_MS);
      if (waited && (!keep || now - this.lastSwitch >= MIN_FOCUS_MS)) next = best;
    } else this.challenger = null;

    const e = this.sound;
    if (next) {
      this.challenger = null;
      this.lastSwitch = now;
      const person = this.personFor(next.phone, s, now);
      const scene = this.effectiveScene(person);
      const params = this.paramsFor(next, s);
      const key = `${next.phone.id}:${scene}`;
      this.focus = { id: next.phone.id, since: now, lastSeen: now, key, params };
      e.focus(key, scene, person.seed, params, (now - person.zero) / 1000);
    } else if (!keep) {
      if (this.focus) e.release();
      this.focus = null;
    } else if (this.focus) {
      // In focus: new numbers if it was seen this frame; the last ones again while it is lost.
      if (cur) this.focus.params = this.paramsFor(cur, s);
      const person = this.people.get(this.focus.id) ?? this.personFor(cur?.phone ?? null, s, now, this.focus.id);
      const scene = this.effectiveScene(person);
      const key = `${this.focus.id}:${scene}`;
      // The setting was changed in the panel: hear the new conversation at once.
      if (key !== this.focus.key || e.focusKey !== key) {
        this.focus.key = key;
        e.focus(key, scene, person.seed, this.focus.params, (now - person.zero) / 1000);
      } else e.update(this.focus.params);
    }

    // Where to draw the ring: around the phone in focus, where it was last seen.
    const ringOn = this.focus && measured.find((m) => m.phone.id === this.focus!.id);
    if (ringOn) {
      const p = ringOn.phone;
      const r = 0.55 * Math.hypot(p.x2 - p.x1, p.y2 - p.y1);
      const x = (p.x1 + p.x2) / 2;
      const y = (p.y1 + p.y2) / 2;
      if (!this.ring.target || this.ring.alpha === 0) Object.assign(this.ring, { x, y, r });
      this.ringGoal = { x, y, r };
    }
    this.ring.target = !!this.focus;
  }

  async process(): Promise<void> {}

  render(ctx: CanvasRenderingContext2D, still = false): void {
    const s = this.settings;
    const now = performance.now();
    const dt = Math.min(100, now - this.lastRender);
    this.lastRender = now;
    if (!s?.hijackOverlay) return;
    const W = this.width;
    const H = this.height;
    // Focus zone: a faint circle in the centre.
    ctx.save();
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(255,255,255,0.28)';
    ctx.setLineDash([3, 6]);
    ctx.beginPath();
    ctx.arc(W / 2, H / 2, (s.hijackZone * Math.min(W, H)) / 2, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    // Ring around the phone being listened to: fades in while tuning in, follows the phone smoothly.
    const ring = this.ring;
    if (still) ring.alpha = ring.target ? 1 : 0;
    else ring.alpha = clamp01(ring.alpha + (ring.target ? 1 : -1) * (dt / RING_FADE_MS));
    const k = still ? 1 : 1 - Math.exp(-dt / 80);
    ring.x += (this.ringGoal.x - ring.x) * k;
    ring.y += (this.ringGoal.y - ring.y) * k;
    ring.r += (this.ringGoal.r - ring.r) * k;
    if (ring.alpha > 0) {
      ctx.lineWidth = 2;
      ctx.strokeStyle = `rgba(255,255,255,${(0.85 * ring.alpha).toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(ring.x, ring.y, Math.max(8, ring.r), 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  /** The numbers the sound is made from. */
  private paramsFor(m: Measured, s: Settings): VoiceParams {
    const p = m.phone;
    const cx = (p.x1 + p.x2) / 2;
    // Left and right as on screen: with the mirror on (X), as in a mirror.
    const pan = (cx / this.width) * 2 - 1;
    const size = Math.sqrt(Math.max(1, (p.x2 - p.x1) * (p.y2 - p.y1))) / Math.min(this.width, this.height);
    return {
      pan: s.mirror ? -pan : pan,
      // Fully clear in the inner 30 % of the zone, muffled towards its edge.
      clarity: clamp01((1 - m.d) / 0.7),
      // A phone about 6 % of the picture's height across is far; about 36 % is right in front.
      closeness: clamp01((size - 0.06) / 0.3),
      build: clamp01(p.erasedMs / (s.hijackBuildSeconds * 1000)),
      activity: this.motion.get(p.id)?.activity ?? 0,
    };
  }

  /** How much a phone moves: speed in phone lengths per second, smoothed (quick to rise, slow to settle). */
  private track(p: PickedPhone, x: number, y: number, now: number): void {
    const m = this.motion.get(p.id);
    if (!m) {
      this.motion.set(p.id, { x, y, t: now, activity: 0 });
      return;
    }
    const dt = Math.max(1, now - m.t) / 1000;
    const side = Math.max(8, Math.sqrt((p.x2 - p.x1) * (p.y2 - p.y1)));
    const speed = Math.hypot(x - m.x, y - m.y) / side / dt;
    // Below about half a phone length a second is the detector's own jitter, not movement.
    const target = clamp01((speed - 0.5) / 2.5);
    m.activity += (target - m.activity) * (target > m.activity ? 0.3 : 0.05);
    m.x = x;
    m.y = y;
    m.t = now;
  }

  /** The person holding this phone: their conversation, voices and clock, given the first time. */
  private personFor(phone: PickedPhone | null, s: Settings, now: number, id = phone?.id ?? 0): Person {
    let p = this.people.get(id);
    if (!p) {
      const seed = (Math.imul(id, 2654435761) ^ this.salt) >>> 0;
      // They were already talking: since the phone came into view (watch time + time
      // since the tracker decided), plus 0–2 min before that.
      const before = (seed % 120_000) + (phone ? phone.erasedMs : 0) + s.hijackWatchMs;
      p = { scene: this.drawScene(), seed, zero: now - before };
      this.people.set(id, p);
      // Ids only grow; keep the map from growing for ever in a long run.
      if (this.people.size > 200) this.people.delete(this.people.keys().next().value!);
    }
    return p;
  }

  private effectiveScene(p: Person | undefined): SceneId {
    const s = this.settings;
    if (s && s.hijackScene !== 'auto') return s.hijackScene;
    return p?.scene ?? 'catchup';
  }

  /** Conversations are dealt from a shuffled deck, so each comes up in turn and two people in a row never get the same one. */
  private drawScene(): SceneId {
    if (!this.deck.length) {
      this.deck = [...SCENE_IDS];
      for (let i = this.deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [this.deck[i], this.deck[j]] = [this.deck[j], this.deck[i]];
      }
      if (this.deck[this.deck.length - 1] === this.lastScene) this.deck.reverse();
    }
    const scene = this.deck.pop()!;
    this.lastScene = scene;
    return scene;
  }
}
