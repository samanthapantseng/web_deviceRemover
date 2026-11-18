/**
 * Streaming mode: WebRTC set-up shared by the iPad's stream page and the Mac page, and the
 * connection statistics both of them show and report.
 */

/** Per direction. 640×480 at 30 fps needs about 1 to 2 Mbit/s; this leaves headroom. */
export const MAX_BITRATE = 3_000_000;

/** Local network only: no STUN or TURN server, so frames never leave the network. */
export function newPeer(): RTCPeerConnection {
  return new RTCPeerConnection({ iceServers: [] });
}

/**
 * Wait until all candidates are gathered, so offer and answer carry them and no further
 * messages are needed. Without a STUN server only local addresses are gathered: milliseconds.
 */
export function waitForCandidates(pc: RTCPeerConnection, timeoutMs = 2000): Promise<void> {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') return resolve();
    const done = () => {
      pc.removeEventListener('icegatheringstatechange', check);
      clearTimeout(timer);
      resolve();
    };
    const check = () => pc.iceGatheringState === 'complete' && done();
    pc.addEventListener('icegatheringstatechange', check);
    const timer = setTimeout(done, timeoutMs);
  });
}

export type CodecChoice = 'h264' | 'vp8' | 'any';

/**
 * `?codec=h264|vp8|any` on the iPad's address. The iPad puts it in its offer and the Mac
 * follows, so one place decides. Default H.264: both devices have a hardware encoder for it.
 */
export function codecFromUrl(): CodecChoice {
  const c = new URLSearchParams(location.search).get('codec');
  return c === 'vp8' || c === 'any' ? c : 'h264';
}

/** Put the chosen codec first. Returns what was asked for, for the panels. */
export function preferCodec(t: RTCRtpTransceiver, choice: CodecChoice): string {
  if (choice === 'any') return 'codec: browser default';
  if (typeof t.setCodecPreferences !== 'function' || typeof RTCRtpReceiver.getCapabilities !== 'function') return 'codec: browser default (cannot choose)';
  const codecs = RTCRtpReceiver.getCapabilities('video')?.codecs ?? [];
  const wanted = (c: { mimeType: string }) => c.mimeType.toLowerCase() === `video/${choice}`;
  if (!codecs.some(wanted)) return `codec: browser default (no ${choice})`;
  try {
    t.setCodecPreferences([...codecs.filter(wanted), ...codecs.filter((c) => !wanted(c))]);
    return `${choice.toUpperCase()} preferred`;
  } catch {
    return 'codec: browser default (refused)';
  }
}

/** Cap bitrate and frame rate. Only possible once negotiated (Safari has no encodings before). */
export async function limitSender(sender: RTCRtpSender): Promise<void> {
  try {
    const p = sender.getParameters();
    if (!p.encodings?.length) return;
    for (const e of p.encodings) {
      e.maxBitrate = MAX_BITRATE;
      e.maxFramerate = 30;
    }
    await sender.setParameters(p);
  } catch (err) {
    console.warn('[stream] could not limit the bitrate', err);
  }
}

/**
 * Ask the receiver to keep as little video buffered as possible (lowest delay, at the risk of
 * stutter on a bad network). `?buffer=default` on either page leaves the browser's choice.
 */
export function lowLatency(receiver: RTCRtpReceiver): string {
  if (new URLSearchParams(location.search).get('buffer') === 'default') return 'buffer: browser default';
  const r = receiver as unknown as Record<string, unknown>;
  try {
    if ('jitterBufferTarget' in r) {
      r.jitterBufferTarget = 0;
      return 'buffer: minimal';
    }
    if ('playoutDelayHint' in r) {
      r.playoutDelayHint = 0;
      return 'buffer: minimal (playoutDelayHint)';
    }
  } catch {
    /* unsupported value */
  }
  return 'buffer: browser default (unsupported)';
}

export interface LinkStats {
  state: RTCPeerConnectionState | 'none';
  /** Candidate types of the pair in use, e.g. "host → prflx udp". */
  route: string;
  rttMs: number | null;
  inFps: number | null;
  inKbps: number | null;
  inRes: string | null;
  outFps: number | null;
  outKbps: number | null;
  outRes: string | null;
  codec: string;
  /** Average time a received frame waited in the jitter buffer. */
  bufferMs: number | null;
  dropped: number | null;
  freezes: number | null;
  /** Why the sender lowered quality, if it did (bandwidth, cpu). */
  limit: string;
}

export const NO_LINK: LinkStats = {
  state: 'none',
  route: '–',
  rttMs: null,
  inFps: null,
  inKbps: null,
  inRes: null,
  outFps: null,
  outKbps: null,
  outRes: null,
  codec: '–',
  bufferMs: null,
  dropped: null,
  freezes: null,
  limit: '',
};

type Stat = Record<string, unknown> & { type: string; id: string; timestamp: number };
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const res = (s: Stat | undefined) => (s && num(s.frameWidth) ? `${String(s.frameWidth)}×${String(s.frameHeight)}` : null);

/** Reads getStats() and turns byte counters into rates. One per connection. */
export class LinkMeter {
  private prev = new Map<string, { bytes: number; t: number }>();

  constructor(private pc: RTCPeerConnection) {}

  async read(): Promise<LinkStats> {
    const report = await this.pc.getStats();
    const all: Stat[] = [];
    report.forEach((s: Stat) => all.push(s));
    const byId = (id: unknown) => (typeof id === 'string' ? (report.get(id) as Stat | undefined) : undefined);

    let pair = byId(all.find((s) => s.type === 'transport' && s.selectedCandidatePairId)?.selectedCandidatePairId);
    pair ??= all.find((s) => s.type === 'candidate-pair' && (s.selected === true || (s.nominated === true && s.state === 'succeeded')));
    const local = byId(pair?.localCandidateId);
    const remote = byId(pair?.remoteCandidateId);
    const route = local && remote ? `${String(local.candidateType)} → ${String(remote.candidateType)} ${String(local.protocol ?? '')}`.trim() : '–';

    const inbound = all.find((s) => s.type === 'inbound-rtp' && s.kind === 'video');
    const outbound = all.find((s) => s.type === 'outbound-rtp' && s.kind === 'video');
    const codecOf = (s: Stat | undefined) => {
      const c = byId(s?.codecId);
      return c ? String(c.mimeType).replace(/^video\//i, '') : null;
    };
    const jbDelay = num(inbound?.jitterBufferDelay);
    const jbCount = num(inbound?.jitterBufferEmittedCount);

    return {
      state: this.pc.connectionState,
      route,
      rttMs: num(pair?.currentRoundTripTime) !== null ? (pair!.currentRoundTripTime as number) * 1000 : null,
      inFps: num(inbound?.framesPerSecond),
      inKbps: this.rate(inbound, 'bytesReceived'),
      inRes: res(inbound),
      outFps: num(outbound?.framesPerSecond),
      outKbps: this.rate(outbound, 'bytesSent'),
      outRes: res(outbound),
      codec: [...new Set([codecOf(inbound), codecOf(outbound)].filter(Boolean))].join('/') || '–',
      bufferMs: jbDelay !== null && jbCount ? (jbDelay / jbCount) * 1000 : null,
      dropped: num(inbound?.framesDropped),
      freezes: num(inbound?.freezeCount),
      limit: typeof outbound?.qualityLimitationReason === 'string' && outbound.qualityLimitationReason !== 'none' ? outbound.qualityLimitationReason : '',
    };
  }

  private rate(s: Stat | undefined, key: string): number | null {
    const bytes = num(s?.[key]);
    if (!s || bytes === null) return null;
    const prev = this.prev.get(s.id);
    this.prev.set(s.id, { bytes, t: s.timestamp });
    if (!prev || s.timestamp <= prev.t) return null;
    return ((bytes - prev.bytes) * 8) / (s.timestamp - prev.t); // bits per ms = kbit/s
  }
}

/** Multi-line summary for the panels. */
export function describeLink(s: LinkStats): string {
  const f = (v: number | null, unit = '') => (v === null ? '–' : `${v.toFixed(0)}${unit}`);
  const mb = (kbps: number | null) => (kbps === null ? '–' : `${(kbps / 1000).toFixed(1)} Mb/s`);
  return [
    `link      ${s.state} · ${s.route}`,
    `rtt       ${f(s.rttMs, ' ms')} · buffer ${f(s.bufferMs, ' ms')} · ${s.codec}`,
    `in        ${f(s.inFps, ' fps')} · ${mb(s.inKbps)} · ${s.inRes ?? '–'}`,
    `out       ${f(s.outFps, ' fps')} · ${mb(s.outKbps)} · ${s.outRes ?? '–'}${s.limit ? ` · limited by ${s.limit}` : ''}`,
    `dropped   ${f(s.dropped)} · freezes ${f(s.freezes)}`,
  ].join('\n');
}
