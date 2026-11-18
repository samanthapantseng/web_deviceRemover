/**
 * Streaming mode: the iPad's Screenshot button. The iPad asks, the Mac makes the same
 * before/after picture as its own S key (the exact frame it received, next to the result) and
 * sends the PNG back. Both ways go over a WebRTC data channel on the same connection as the
 * video: straight between the two devices, never through the dev server.
 *
 *   iPad → Mac   {"type":"shot","id":…,"mirror":true}
 *   Mac → iPad   {"type":"shot-data","id":…,"bytes":N}, then N bytes in chunks of up to 64 KB
 *                or {"type":"shot-error","id":…,"reason":…}
 */

export const SHOT_CHANNEL = 'shots';
const CHUNK = 64 * 1024;

type Control =
  | { type: 'shot'; id: string; mirror: boolean }
  | { type: 'shot-data'; id: string; bytes: number }
  | { type: 'shot-error'; id: string; reason: string };

function parse(data: unknown): Control | null {
  if (typeof data !== 'string') return null;
  try {
    return JSON.parse(data) as Control;
  } catch {
    return null;
  }
}

/** Mac side: answer the iPad's requests on `dc`. `make(mirror)` returns the PNG. */
export function serveShots(dc: RTCDataChannel, make: (mirror: boolean) => Promise<Blob>): void {
  dc.binaryType = 'arraybuffer';
  dc.bufferedAmountLowThreshold = 256 * 1024;
  const send = (msg: Control) => dc.readyState === 'open' && dc.send(JSON.stringify(msg));
  dc.onmessage = (e) => {
    const msg = parse(e.data);
    if (msg?.type !== 'shot') return;
    void (async () => {
      try {
        const bytes = new Uint8Array(await (await make(msg.mirror)).arrayBuffer());
        send({ type: 'shot-data', id: msg.id, bytes: bytes.length });
        for (let i = 0; i < bytes.length; i += CHUNK) {
          if (dc.readyState !== 'open') return;
          if (dc.bufferedAmount > 1 << 20) await new Promise((r) => dc.addEventListener('bufferedamountlow', r, { once: true }));
          dc.send(bytes.subarray(i, i + CHUNK));
        }
      } catch (err) {
        send({ type: 'shot-error', id: msg.id, reason: (err as Error).message ?? String(err) });
      }
    })();
  };
}

interface Pending {
  id: string;
  bytes: number;
  parts: ArrayBuffer[];
  got: number;
  resolve: (b: Blob) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** iPad side: asks the Mac over the data channel of the current connection. */
export class ShotClient {
  private dc: RTCDataChannel | null = null;
  private pending: Pending | null = null;

  /** Use the data channel of a new connection (the old one's request, if any, fails). */
  attach(dc: RTCDataChannel): void {
    this.fail('the connection restarted');
    this.dc = dc;
    dc.binaryType = 'arraybuffer';
    dc.onmessage = (e) => {
      if (this.dc !== dc) return;
      this.receive(e.data);
    };
    dc.onclose = () => this.dc === dc && this.fail('the connection closed');
  }

  get ready(): boolean {
    return this.dc?.readyState === 'open';
  }

  get busy(): boolean {
    return !!this.pending;
  }

  /** The before/after PNG from the Mac, mirrored (each half) if the iPad shows it mirrored. */
  request(mirror: boolean, timeoutMs = 10_000): Promise<Blob> {
    const dc = this.dc;
    if (!dc || dc.readyState !== 'open') return Promise.reject(new Error('no connection to the Mac'));
    if (this.pending) return Promise.reject(new Error('a screenshot is already on its way'));
    const id = Math.random().toString(36).slice(2, 10);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail('the Mac did not answer'), timeoutMs);
      this.pending = { id, bytes: -1, parts: [], got: 0, resolve, reject, timer };
      dc.send(JSON.stringify({ type: 'shot', id, mirror } satisfies Control));
    });
  }

  private receive(data: unknown): void {
    const p = this.pending;
    if (!p) return;
    if (data instanceof ArrayBuffer) {
      if (p.bytes < 0) return;
      p.parts.push(data);
      p.got += data.byteLength;
      if (p.got >= p.bytes) this.finish(new Blob(p.parts, { type: 'image/png' }));
      return;
    }
    const msg = parse(data);
    if (!msg || msg.id !== p.id) return;
    if (msg.type === 'shot-data') p.bytes = msg.bytes;
    else if (msg.type === 'shot-error') this.fail(`on the Mac: ${msg.reason}`);
  }

  private finish(blob: Blob): void {
    const p = this.pending!;
    clearTimeout(p.timer);
    this.pending = null;
    p.resolve(blob);
  }

  private fail(reason: string): void {
    const p = this.pending;
    if (!p) return;
    clearTimeout(p.timer);
    this.pending = null;
    p.reject(new Error(reason));
  }
}
