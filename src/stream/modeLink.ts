/**
 * Streaming mode: the iPad's Remove / Grow switch. The mode lives on the Mac (its own setting,
 * the same one G changes there); the iPad asks for a mode and shows whichever one the Mac says
 * it is in. Like the screenshot (shots.ts), this goes over a WebRTC data channel on the same
 * connection as the video: straight between the two devices.
 *
 *   Mac → iPad   {"type":"mode","mode":"grow"}       when the channel opens and on every change
 *   iPad → Mac   {"type":"set-mode","mode":"grow"}
 */
import type { ModeId } from '../settings';

export const MODE_CHANNEL = 'mode';

/** What the iPad can switch to. Hijack is not among them: its sound plays on the Mac. */
export const IPAD_MODES = ['remove', 'grow'] as const satisfies readonly ModeId[];
export type IpadMode = (typeof IPAD_MODES)[number];

type Message = { type: 'mode'; mode: ModeId } | { type: 'set-mode'; mode: IpadMode };

function parse(data: unknown): Message | null {
  if (typeof data !== 'string') return null;
  try {
    return JSON.parse(data) as Message;
  } catch {
    return null;
  }
}

/** The Mac page's mode setting, as the switch needs it (main.ts). */
export interface ModeControl {
  get(): ModeId;
  set(mode: IpadMode): void;
  onChange(changed: () => void): void;
}

/** Mac side: carries out what the iPad asks for and keeps it told. */
export class ModeServer {
  private dc: RTCDataChannel | null = null;

  constructor(private control: ModeControl) {
    control.onChange(() => this.tell());
  }

  /** Use the data channel of a new connection. */
  attach(dc: RTCDataChannel): void {
    this.dc = dc;
    dc.onopen = () => this.tell();
    dc.onmessage = (e) => {
      if (this.dc !== dc) return;
      const msg = parse(e.data);
      if (msg?.type === 'set-mode' && IPAD_MODES.includes(msg.mode)) this.control.set(msg.mode);
    };
    this.tell();
  }

  private tell(): void {
    if (this.dc?.readyState === 'open') this.dc.send(JSON.stringify({ type: 'mode', mode: this.control.get() } satisfies Message));
  }
}

/** iPad side. */
export class ModeClient {
  /** The Mac's mode; null while there is no connection to it. */
  mode: ModeId | null = null;
  onChange: () => void = () => undefined;
  private dc: RTCDataChannel | null = null;

  /** Use the data channel of a new connection. */
  attach(dc: RTCDataChannel): void {
    this.dc = dc;
    this.show(null);
    dc.onmessage = (e) => {
      const msg = parse(e.data);
      if (this.dc === dc && msg?.type === 'mode') this.show(msg.mode);
    };
    dc.onclose = () => this.dc === dc && this.detach();
  }

  /** The Mac page is gone (the channel itself only notices many seconds later). */
  detach(): void {
    this.dc = null;
    this.show(null);
  }

  /** Ask the Mac for a mode. False when there is no connection to it. */
  request(mode: IpadMode): boolean {
    if (this.dc?.readyState !== 'open') return false;
    this.dc.send(JSON.stringify({ type: 'set-mode', mode } satisfies Message));
    return true;
  }

  private show(mode: ModeId | null): void {
    if (mode === this.mode) return;
    this.mode = mode;
    this.onChange();
  }
}
