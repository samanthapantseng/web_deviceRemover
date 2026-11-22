/**
 * Streaming mode: the page side of the dev server's signalling hub (server/signalHub.ts).
 * Server-Sent Events in, POST out. Only connection details travel this way, never frames.
 */

import type { CodecChoice } from './link';

export type Role = 'ipad' | 'mac';

export type SignalMessage =
  /** iPad → Mac: a new connection. Replaces any earlier one. */
  | {
      type: 'offer';
      id: string;
      sdp: string;
      /** Size of the frames the iPad sends (its camera, or the latency test canvas). */
      width: number;
      height: number;
      /** Which camera: the iPad's front or back one, or a Quest's passthrough ("headset") camera. */
      facing: 'front' | 'back' | 'headset';
      /** Which codec both sides should prefer (from ?codec= on the iPad's address). */
      codec: CodecChoice;
    }
  /** Mac → iPad: the answer to the offer with the same id. */
  | { type: 'answer'; id: string; sdp: string }
  /** Mac → iPad: whether processed frames are being sent yet (not while the detector loads). */
  | { type: 'state'; id: string; sending: boolean }
  /** Mac → iPad: nothing arrives from the iPad any more; please start a new connection. */
  | { type: 'restart'; id: string; reason: string };

export interface SignalHandlers {
  /** The event stream (re)connected; `peer`: whether the other page is there. */
  onHello?(peer: boolean): void;
  /** The other page arrived or left. */
  onPeer?(present: boolean): void;
  onMessage(msg: SignalMessage): void;
  /** A newer page took this role over; this one has stopped listening. */
  onReplaced?(): void;
}

export class Signal {
  /** Whether the other page is connected to the hub, as far as this page knows. */
  peerPresent = false;
  private es: EventSource | null = null;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;

  constructor(
    private role: Role,
    private handlers: SignalHandlers,
  ) {
    this.open();
  }

  get connected(): boolean {
    return this.es?.readyState === EventSource.OPEN;
  }

  /** Send a message to the other page. false if it could not be delivered (hub or peer absent). */
  async send(msg: SignalMessage): Promise<boolean> {
    try {
      const res = await fetch(`__signal?role=${this.role}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(msg),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.retry);
    this.es?.close();
  }

  private open(): void {
    const es = new EventSource(`__signal/events?role=${this.role}`);
    this.es = es;
    const data = (e: Event) => JSON.parse((e as MessageEvent<string>).data) as Record<string, unknown>;
    es.addEventListener('hello', (e) => {
      this.peerPresent = data(e).peer === true;
      this.handlers.onHello?.(this.peerPresent);
    });
    es.addEventListener('peer', (e) => {
      this.peerPresent = data(e).present === true;
      this.handlers.onPeer?.(this.peerPresent);
    });
    es.addEventListener('message', (e) => this.handlers.onMessage(data(e) as unknown as SignalMessage));
    es.addEventListener('replaced', () => {
      this.stop();
      this.handlers.onReplaced?.();
    });
    es.onerror = () => {
      // While the hub is unreachable we cannot know whether the other page is still there.
      this.peerPresent = false;
      // CONNECTING: the browser retries by itself. CLOSED (e.g. the server answered with an
      // error during a restart): it has given up, so start over.
      if (es.readyState === EventSource.CLOSED && !this.stopped) {
        clearTimeout(this.retry);
        this.retry = setTimeout(() => this.open(), 2000);
      }
    };
  }
}
