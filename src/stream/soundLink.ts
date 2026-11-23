/**
 * Streaming mode: hijack mode's sound, on the iPad. The Mac decides who is in focus (it has the
 * pictures) and sends a few numbers; the iPad makes the voices itself and plays them, into
 * headphones on the iPad. No sound is streamed, so the network cannot make it stutter.
 *
 *   Mac → iPad   {"type":"sound","n":…,"volume":0.5,"focus":null | {"key","scene","seed","elapsed","p"}}
 *   iPad → Mac   {"type":"heard","running":true,"key":"4:secret","db":-24}
 *
 * The Mac always sends the whole state, about 30 times a second while someone is in focus and 10
 * times otherwise, over an unreliable data channel (newest wins): a lost message does not matter,
 * and after a reconnect the next one puts everything right. Without any for 3 s the iPad falls
 * silent by itself (the sound engine's watchdog).
 */
import type { VoiceParams } from '../audio/conversation';
import type { LiveSound } from '../audio/engine';
import type { SoundOutput } from '../audio/output';
import type { SceneId } from '../settings';

export const SOUND_CHANNEL = 'sound';
/** Newest wins: nothing is sent again, and an old message never holds up a new one. */
export const SOUND_CHANNEL_OPTIONS: RTCDataChannelInit = { ordered: false, maxRetransmits: 0 };

/** While nothing changes, the state is sent this often (ms). */
const BEAT_MS = 100;
/** And at most this often while it does. */
const MIN_GAP_MS = 30;
/** The effect has not called for this long (detector stuck, another mode): nothing to say any more. */
const STALE_MS = 3000;

interface Focus {
  key: string;
  scene: SceneId;
  seed: number;
  /** How long (s) the conversation has been going on, now. */
  elapsed: number;
  p: VoiceParams;
}

type Message =
  | { type: 'sound'; n: number; volume: number; focus: Focus | null; test?: { id: number; scene: SceneId; seed: number } }
  | { type: 'heard'; running: boolean; key: string; db: number | null };

function parse(data: unknown): Message | null {
  if (typeof data !== 'string') return null;
  try {
    return JSON.parse(data) as Message;
  } catch {
    return null;
  }
}

const short = (v: number) => Math.round(v * 1000) / 1000;

/** Mac side: takes what the hijack effect says and passes it on. */
export class RemoteSound implements SoundOutput {
  private dc: RTCDataChannel | null = null;
  private n = 0;
  private volume = 0.5;
  private current: (Focus & { at: number }) | null = null;
  private test: { id: number; scene: SceneId; seed: number; until: number } | null = null;
  private calledAt = -Infinity;
  private sentAt = -Infinity;
  private heard: { running: boolean; key: string; db: number | null } | null = null;

  constructor() {
    setInterval(() => {
      const now = performance.now();
      if (this.current && now - this.calledAt > STALE_MS) this.current = null;
      // Quiet outside hijack mode, but a little longer than it: the last "nobody" must arrive.
      if (now - this.calledAt < 2 * STALE_MS || this.test) this.send();
    }, BEAT_MS);
  }

  /** Use the data channel of a new connection. */
  attach(dc: RTCDataChannel): void {
    this.dc = dc;
    this.heard = null;
    dc.onmessage = (e) => {
      const msg = parse(e.data);
      if (this.dc === dc && msg?.type === 'heard') this.heard = { running: msg.running, key: msg.key, db: msg.db };
    };
    dc.onopen = () => this.send();
    dc.onclose = () => {
      if (this.dc !== dc) return;
      this.dc = null;
      this.heard = null;
    };
  }

  ensure(): void {
    this.calledAt = performance.now();
  }

  setVolume(v: number): void {
    this.volume = v;
  }

  get focusKey(): string {
    return this.current?.key ?? '';
  }

  focus(key: string, scene: SceneId, seed: number, p: VoiceParams, elapsed: number): void {
    this.calledAt = performance.now();
    this.current = { key, scene, seed, p, elapsed, at: this.calledAt };
    this.send();
  }

  update(p: VoiceParams): void {
    this.calledAt = performance.now();
    if (!this.current) return;
    this.current.p = p;
    if (this.calledAt - this.sentAt >= MIN_GAP_MS) this.send();
  }

  release(): void {
    this.calledAt = performance.now();
    this.current = null;
    this.send();
  }

  /** The panel's "Test sound": a conversation for a few seconds, without a phone. */
  preview(scene: SceneId, seed: number): boolean {
    if (this.dc?.readyState !== 'open') return false;
    this.test = { id: Math.floor(Math.random() * 2 ** 31), scene, seed, until: performance.now() + 1000 };
    this.send();
    return true;
  }

  status(): string {
    if (this.dc?.readyState !== 'open') return 'the iPad is not connected';
    if (!this.heard) return 'waiting for the iPad';
    if (!this.heard.running) return 'the iPad needs a tap for sound';
    return this.heard.db === null ? 'iPad silent' : `iPad ${this.heard.db.toFixed(0)} dB`;
  }

  private send(): void {
    if (this.dc?.readyState !== 'open') return;
    const now = (this.sentAt = performance.now());
    const c = this.current;
    if (this.test && now > this.test.until) this.test = null;
    const t = this.test;
    const msg: Message = {
      type: 'sound',
      n: ++this.n,
      volume: this.volume,
      focus: c && {
        key: c.key,
        scene: c.scene,
        seed: c.seed,
        elapsed: short(c.elapsed + (now - c.at) / 1000),
        p: { pan: short(c.p.pan), clarity: short(c.p.clarity), closeness: short(c.p.closeness), build: short(c.p.build), activity: short(c.p.activity) },
      },
      ...(t && { test: { id: t.id, scene: t.scene, seed: t.seed } }),
    };
    try {
      this.dc.send(JSON.stringify(msg));
    } catch {
      /* the channel closed this moment: the next connection carries on */
    }
  }
}

/** iPad side: follows what the Mac says. */
export class SoundClient {
  private dc: RTCDataChannel | null = null;
  private newest = 0;
  private tested = 0;

  constructor(
    private readonly sound: LiveSound,
    /** The picture is shown mirrored: left and right are swapped. */
    private readonly mirrored: () => boolean,
  ) {
    setInterval(() => this.tell(), 1000);
  }

  /** Use the data channel of a new connection. What sounds goes on: a reconnect is not an ending. */
  attach(dc: RTCDataChannel): void {
    this.dc = dc;
    this.newest = 0;
    dc.onopen = () => this.tell();
    dc.onmessage = (e) => {
      const msg = parse(e.data);
      if (this.dc !== dc || msg?.type !== 'sound' || msg.n <= this.newest) return;
      this.newest = msg.n;
      this.follow(msg);
    };
  }

  /** The Mac page is gone: silence. */
  detach(): void {
    this.dc = null;
    this.sound.release();
  }

  /** Sound was switched on or off here: the Mac's panel shows it. */
  tell(): void {
    if (this.dc?.readyState !== 'open') return;
    const { running, engine } = this.sound;
    const db = engine && running ? engine.levels().rms : -Infinity;
    try {
      this.dc.send(JSON.stringify({ type: 'heard', running, key: this.sound.focusKey, db: Number.isFinite(db) ? short(db) : null } satisfies Message));
    } catch {
      /* closing */
    }
  }

  private follow(msg: Extract<Message, { type: 'sound' }>): void {
    this.sound.ensure();
    this.sound.setVolume(msg.volume);
    if (!this.sound.running) return;
    if (msg.test && msg.test.id !== this.tested) {
      this.tested = msg.test.id;
      this.sound.engine?.preview(msg.test.scene, msg.test.seed);
    }
    const f = msg.focus;
    if (!f) {
      if (this.sound.focusKey) this.sound.release();
      return;
    }
    const p = { ...f.p, pan: this.mirrored() ? -f.p.pan : f.p.pan };
    // The seed too: after the Mac page was reloaded, its numbering of the phones starts over.
    const key = `${f.key}:${f.seed}`;
    if (this.sound.focusKey === key) this.sound.update(p);
    else this.sound.focus(key, f.scene, f.seed, p, f.elapsed);
  }
}
