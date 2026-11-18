/**
 * Streaming mode, the Mac side (`/?source=stream`): the iPad's camera, received over WebRTC,
 * as a FrameSource for the unchanged pipeline, and the finished picture sent back.
 *
 * The iPad always makes the offer; this page always answers. A new offer replaces the old
 * connection, while the models and the pipeline stay loaded.
 */
import { fit, frameWaiter, type FrameSource } from '../camera';
import { report, reporting } from '../devReport';
import { LinkMeter, limitSender, lowLatency, newPeer, NO_LINK, preferCodec, waitForCandidates, type LinkStats } from './link';
import { serveShots, SHOT_CHANNEL } from './shots';
import { Signal, type SignalMessage } from './signal';

type Say = (text: string, isError?: boolean) => void;
type Offer = Extract<SignalMessage, { type: 'offer' }>;

export interface RemoteSource extends FrameSource {
  readonly element: HTMLVideoElement;
  /**
   * Start sending `view` back to the iPad. Call once the detector runs: until then the iPad
   * keeps its last picture, instead of getting unprocessed frames with the phones still in.
   */
  sendBack(view: HTMLCanvasElement): void;
  /**
   * How to make the iPad's screenshot (its Screenshot button): a before/after PNG, each half
   * mirrored if `mirror` (the iPad shows the picture mirrored). See shots.ts.
   */
  onScreenshot(make: (mirror: boolean) => Promise<Blob>): void;
}

const even = (v: number) => Math.max(2, Math.round(v / 2) * 2);

/** Resolves once the first frame from the iPad has arrived (its size sets the pipeline's). */
export function openRemote(say: Say): Promise<RemoteSource> {
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.autoplay = true;
  // Unlike a camera, a received WebRTC stream only renders frames into a video element that is
  // in the page (outside it: one frame, then nothing, and no frame callbacks). So it is in the
  // page, tiny and behind the picture.
  video.style.cssText = 'position:fixed;left:0;top:0;width:4px;height:4px;z-index:-1;pointer-events:none';
  document.body.append(video);

  let pc: RTCPeerConnection | null = null;
  let transceiver: RTCRtpTransceiver | null = null;
  let currentId = '';
  let latestOffer = '';
  let offer: Offer | null = null;
  let outTrack: MediaStreamTrack | null = null;
  let meter: LinkMeter | null = null;
  let stats: LinkStats = NO_LINK;
  let notes = '';
  let connections = 0;
  let queue = Promise.resolve();
  let started = false;
  let waitingShown = false;
  let connectedAt = 0;
  let lastFrameAt = 0;
  let restartAskedAt = 0;
  let makeShot: ((mirror: boolean) => Promise<Blob>) | null = null;
  const shot = (mirror: boolean) => {
    report('status', { text: 'screenshot asked for by the iPad' });
    return makeShot ? makeShot(mirror) : Promise.reject(new Error('the detector is still loading'));
  };

  const waiting = (text: string) => {
    // Before the first frame main.ts shows its own "waiting for the iPad…".
    if (!started) return;
    waitingShown = true;
    say(text);
  };

  const signal = new Signal('mac', {
    onHello: (peer) => !peer && waiting('waiting for the iPad…'),
    onPeer: (present) => !present && waiting('the iPad is gone, waiting for it…'),
    onMessage: (msg) => {
      if (msg.type !== 'offer') return;
      latestOffer = msg.id;
      queue = queue.then(() => answer(msg)).catch((err: unknown) => console.error('[stream] answering the iPad failed', err));
    },
    onReplaced: () => {
      pc?.close();
      say('Another Mac page took over the stream; this one has stopped.', true);
    },
  });

  async function answer(o: Offer): Promise<void> {
    if (o.id !== latestOffer) return; // a newer offer is already queued
    pc?.close();
    const p = newPeer();
    pc = p;
    currentId = o.id;
    offer = o;
    connections++;
    connectedAt = 0;
    restartAskedAt = 0;
    p.ontrack = (e) => {
      if (pc !== p) return;
      video.srcObject = e.streams[0] ?? new MediaStream([e.track]);
      void video.play().catch(() => undefined);
    };
    p.onconnectionstatechange = () => {
      if (pc !== p) return;
      report('status', { text: `link ${p.connectionState}` });
      if (p.connectionState === 'connected') connectedAt = performance.now();
      if (p.connectionState === 'connected' && waitingShown) {
        waitingShown = false;
        say('');
      }
    };
    // The iPad's screenshot requests (an iPad page from before this channel existed has none).
    p.ondatachannel = (e) => {
      if (pc === p && e.channel.label === SHOT_CHANNEL) serveShots(e.channel, shot);
    };
    await p.setRemoteDescription({ type: 'offer', sdp: o.sdp });
    const t = p.getTransceivers().find((x) => x.receiver.track.kind === 'video');
    if (!t) throw new Error('the offer has no video');
    transceiver = t;
    t.direction = 'sendrecv';
    notes = `${preferCodec(t, o.codec ?? 'h264')} · ${lowLatency(t.receiver)}`;
    await t.sender.replaceTrack(outTrack);
    await p.setLocalDescription(await p.createAnswer());
    await waitForCandidates(p);
    if (pc !== p) return;
    meter = new LinkMeter(p);
    // If the iPad left meanwhile, it sends a new offer when it is back.
    if (!(await signal.send({ type: 'answer', id: o.id, sdp: p.localDescription!.sdp }))) return;
    await signal.send({ type: 'state', id: o.id, sending: !!outTrack });
    void limitSender(t.sender);
  }

  function sendBack(view: HTMLCanvasElement): void {
    const track = view.captureStream(30).getVideoTracks()[0];
    track.contentHint = 'motion';
    outTrack = track;
    const t = transceiver;
    const id = currentId;
    if (!t || !pc) return; // the next answer carries it
    void t.sender
      .replaceTrack(track)
      .then(() => limitSender(t.sender))
      .then(() => signal.send({ type: 'state', id, sending: true }))
      .catch((err: unknown) => console.error('[stream] could not start sending', err));
  }

  // Watchdog for the iPad → Mac direction, which the iPad cannot see: it keeps getting the
  // Mac's picture even when its own frames stopped arriving (camera or encoder stalled, one-way
  // network loss). No new frame for 3 s while connected: ask the iPad for a new connection.
  const vfc = video as HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number };
  if (typeof vfc.requestVideoFrameCallback === 'function') {
    const onFrame = () => {
      lastFrameAt = performance.now();
      vfc.requestVideoFrameCallback!(onFrame);
    };
    vfc.requestVideoFrameCallback(onFrame);
    setInterval(() => {
      const now = performance.now();
      if (!pc || !connectedAt || pc.connectionState !== 'connected' || !signal.peerPresent) return;
      // Asked already: ask again only if nothing has changed 10 s later.
      if (now - restartAskedAt < 10_000) return;
      const since = now - Math.max(lastFrameAt, connectedAt);
      if (since < 3000) return;
      restartAskedAt = now;
      report('status', { text: `no frames from the iPad for ${(since / 1000).toFixed(1)} s, asking it to reconnect` });
      void signal.send({ type: 'restart', id: currentId, reason: 'the Mac gets no frames' });
    }, 500);
  }

  // Connection stats: every second for the panel, every 5 s to the report.
  let tick = 0;
  setInterval(() => {
    const m = meter;
    if (!m) return;
    void m.read().then((s) => {
      if (m !== meter) return;
      stats = s;
      if (reporting && tick++ % 5 === 0) report('link', { role: 'mac', ...s, connections });
    });
  }, 1000);

  document.addEventListener('visibilitychange', () => {
    // A page being closed or reloaded also turns hidden for a moment: only warn if it stays so.
    if (document.visibilityState !== 'hidden') return;
    setTimeout(() => {
      if (document.visibilityState === 'hidden') {
        console.warn('[stream] the Mac page is hidden: Chrome slows it down and the iPad may freeze. Keep this window visible (npm run stream:mac).');
      }
    }, 2000);
  });

  // For tests and the console.
  Object.assign(window, {
    deviceRemoverStream: {
      link: () => stats,
      connections: () => connections,
      sending: () => !!outTrack,
      /** Drop the connection without telling the iPad, as a dead network would. */
      dropLink: () => {
        pc?.close();
        pc = null;
        meter = null;
      },
    },
  });

  return new Promise((resolve) => {
    const onSize = () => {
      if (started || !video.videoWidth || !offer) return;
      started = true;
      // The received frame gives the shape (it follows the iPad's orientation); the offer gives
      // the size. WebRTC starts small and ramps up, so the first frame may be 320×240 for a while.
      const target = fit(offer.width, offer.height);
      const s = Math.max(target.width, target.height) / Math.max(video.videoWidth, video.videoHeight);
      const width = even(video.videoWidth * s);
      const height = even(video.videoHeight * s);
      report('status', { text: `iPad stream: ${offer.facing} camera ${offer.width}×${offer.height}, processing at ${width}×${height}` });
      resolve({
        element: video,
        width,
        height,
        get label() {
          const rtt = stats.rttMs === null ? '–' : stats.rttMs.toFixed(0);
          const fps = stats.inFps === null ? '–' : stats.inFps.toFixed(0);
          return `iPad ${width}×${height} · ${stats.codec} · ${stats.route} · rtt ${rtt} ms · in ${fps} fps · #${connections} · ${notes}`;
        },
        nextFrame: frameWaiter(video),
        stop: () => {
          pc?.close();
          signal.stop();
        },
        sendBack,
        onScreenshot: (make) => {
          makeShot = make;
        },
      });
    };
    video.addEventListener('loadedmetadata', onSize);
    video.addEventListener('resize', onSize);
  });
}
