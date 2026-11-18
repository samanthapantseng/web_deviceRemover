// Decides which phone-like objects are erased, by watching each one for a while first.
//
// Every object the detector reports as even slightly phone-like is followed from frame to
// frame, also while it moves. On every processed frame it gets a vote: "phone" when "cell
// phone" is its top category and scores at or above the threshold; "not phone" otherwise,
// also for a frame in which it was not seen at all.
//
// - Watching: a new object is left alone for `watchMs` (default 1.5 s).
// - Deciding: after that it is erased if at least `share` of its votes over the last `watchMs`
//   said phone (default two thirds).
// - Staying erased: from then on it is erased in every frame it is seen, whatever that frame's
//   score, until fewer than half of `share` of its recent votes say phone (a third, by default).
//   Half, so that an object right at the bar does not switch on and off.
// - Short losses: an object unseen for up to `graceMs` (1 s) keeps its status. After that it is
//   forgotten; if it comes back, it is watched again from the start.
//
// The decision is per object, not per frame: that is what keeps a look-alike that scores high
// for a moment from being erased, and an erased phone from blinking when one frame scores low.
import { iou, type Box } from '../types';

/** What the detector reports for one object in one frame. */
export interface Sighting extends Box {
  /** The model's "cell phone" score. */
  score: number;
  /** "cell phone" is the model's highest score of all 80 categories for this object. */
  phoneIsTop: boolean;
}

export interface WatchOptions {
  /** A frame says "phone" when the phone score is at least this (and phone is the top category). */
  conf: number;
  /** How long a new object is watched before it may be erased (ms). 0: decide at once. */
  watchMs: number;
  /** Share of frames (0..1) over the last `watchMs` that must say "phone" for it to be erased. */
  share: number;
  /** How long an object may go unseen and keep its status (ms). */
  graceMs?: number;
}

/** The tracker's view of one object, for the sighting it was matched to this frame. */
export interface Verdict {
  /** Stable while the object is followed. */
  id: number;
  erase: boolean;
  /** ms since it was first seen. */
  ageMs: number;
  /** Share of recent frames in which it looked like a phone, 0..1. */
  share: number;
  /** ms since it was decided on (erased); 0 while it is not. Grow mode sizes the phone by this. */
  erasedMs: number;
}

interface Track {
  id: number;
  box: Box;
  firstSeen: number;
  lastSeen: number;
  /** Processed frames in a row without a sighting. */
  missed: number;
  votes: { t: number; yes: boolean }[];
  share: number;
  erased: boolean;
  /** When it was last decided on. */
  erasedAt: number;
}

/** > 0 when two boxes could be the same object one frame apart; the higher, the closer. */
function closeness(a: Box, b: Box): number {
  const overlap = iou(a, b);
  const side = Math.max(a.x2 - a.x1, a.y2 - a.y1, b.x2 - b.x1, b.y2 - b.y1, 1);
  const dist = Math.hypot(a.x1 + a.x2 - b.x1 - b.x2, a.y1 + a.y2 - b.y1 - b.y2) / 2 / side;
  // A moving phone may not overlap its last box, but its centre is still near.
  return overlap > 0 || dist < 1 ? overlap + 1 - Math.min(dist, 1) : 0;
}

export class PhoneTracker {
  private tracks: Track[] = [];
  private nextId = 1;

  /** Feed one frame's sightings; returns one verdict per sighting, in the same order. */
  update(seen: Sighting[], now: number, o: WatchOptions): Verdict[] {
    const grace = o.graceMs ?? 1000;
    // With watchMs = 0 the decision is immediate, but release still looks at the last second.
    const window = Math.max(o.watchMs, 1000);

    // 1. Pair sightings with known objects, closest pairs first.
    const pairs: [number, Track, number][] = [];
    for (const t of this.tracks) {
      seen.forEach((s, si) => {
        const c = closeness(t.box, s);
        if (c > 0) pairs.push([c, t, si]);
      });
    }
    pairs.sort((a, b) => b[0] - a[0]);
    const trackOf: (Track | undefined)[] = new Array(seen.length);
    const matched = new Set<Track>();
    for (const [, t, si] of pairs) {
      if (matched.has(t) || trackOf[si]) continue;
      matched.add(t);
      trackOf[si] = t;
    }

    // 2. Anything left over is a new object: start watching it.
    seen.forEach((s, si) => {
      if (trackOf[si]) return;
      const t: Track = { id: this.nextId++, box: s, firstSeen: now, lastSeen: now, missed: 0, votes: [], share: 0, erased: false, erasedAt: 0 };
      this.tracks.push(t);
      matched.add(t);
      trackOf[si] = t;
    });

    // 3. Votes: seen and looking like a phone, or not.
    seen.forEach((s, si) => {
      const t = trackOf[si]!;
      t.box = { x1: s.x1, y1: s.y1, x2: s.x2, y2: s.y2 };
      t.lastSeen = now;
      t.missed = 0;
      t.votes.push({ t: now, yes: s.phoneIsTop && s.score >= o.conf });
    });
    for (const t of this.tracks) {
      if (matched.has(t)) continue;
      t.missed++;
      t.votes.push({ t: now, yes: false });
    }

    // 4. Forget objects unseen for longer than the grace period (and at least two frames, for slow devices).
    this.tracks = this.tracks.filter((t) => t.missed < 2 || now - t.lastSeen <= grace);

    // 5. Decide.
    for (const t of this.tracks) {
      while (t.votes.length && t.votes[0].t < now - window) t.votes.shift();
      t.share = t.votes.length ? t.votes.filter((v) => v.yes).length / t.votes.length : 0;
      if (!t.erased) {
        t.erased = now - t.firstSeen >= o.watchMs && t.share >= o.share;
        if (t.erased) t.erasedAt = now;
      } else if (t.share < o.share / 2) t.erased = false;
    }

    return trackOf.map((t) => ({
      id: t!.id,
      erase: t!.erased,
      ageMs: now - t!.firstSeen,
      share: t!.share,
      erasedMs: t!.erased ? now - t!.erasedAt : 0,
    }));
  }

  /**
   * Up to `max` lines on what is being followed, erased objects first, each with the share of
   * its recent frames that said phone, e.g. "#4 watching 1.2/1.5 s · 80 %".
   */
  summary(now: number, watchMs: number, max = 3): string[] {
    return [...this.tracks]
      .sort((a, b) => Number(b.erased) - Number(a.erased) || a.firstSeen - b.firstSeen)
      .slice(0, max)
      .map((t) => {
        const age = now - t.firstSeen;
        const state = t.erased ? 'erased' : age < watchMs ? `watching ${(age / 1000).toFixed(1)}/${(watchMs / 1000).toFixed(1)} s` : 'not erased';
        return `#${t.id} ${state} · ${Math.round(t.share * 100)} %`;
      });
  }

  /** Number of objects being followed. */
  get size(): number {
    return this.tracks.length;
  }

  reset(): void {
    this.tracks = [];
  }
}
