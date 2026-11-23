/**
 * Streaming mode, the iPad's side (stream.html): sends the camera to the Mac and shows, full
 * screen, the picture the Mac sends back. Nothing is processed here, and the iPad's own camera
 * picture is never shown: only finished frames from the Mac.
 *
 * The panel's Remove / Grow switch sets the Mac's mode (modeLink.ts).
 *
 * This page drives recovery. It starts a fresh connection whenever the Mac page appears, the
 * connection fails, or no frame has arrived for 3 s, and keeps trying for as long as it is open.
 *
 *   ?camera=front|back   which camera (default: the saved choice, front at first)
 *   ?latency             measure the round trip with a frame counter in the corner (test only)
 *   ?codec=h264|vp8|any  video codec for both directions (default h264); the Mac follows
 *   ?buffer=default      leave the browser's own jitter buffer (default: as small as possible)
 *   ?recordMax=<s>       a screen recording stops by itself after this long (default 300 s)
 */
import '../style.css';
import './stream.css';
import { report, reporting, startReporting } from '../devReport';
import { downloadBlob, timestamp } from '../snapshot';
import { isTouchDevice } from '../ui/panel';
import { codecFromUrl, describeLink, LinkMeter, limitSender, lowLatency, newPeer, NO_LINK, preferCodec, waitForCandidates, type LinkStats } from './link';
import { Stamper, StampReader } from './latency';
import { IPAD_MODES, MODE_CHANNEL, ModeClient, type IpadMode } from './modeLink';
import { ScreenRecorder } from '../recorder';
import { keepScreenOn, toggleFullscreen } from './screen';
import { SHOT_CHANNEL, ShotClient } from './shots';
import { Signal, type SignalMessage } from './signal';

startReporting();
keepScreenOn();

// ---------------------------------------------------------------- settings (this page only)

type Facing = 'front' | 'back';
interface Prefs {
  camera: Facing;
  /** Mirror the picture, like a mirror. On by default for the front camera. */
  mirror: boolean;
  /** Fill the screen (crops the edges) instead of letterboxing. */
  cover: boolean;
}
const PREFS_KEY = 'device-remover.stream.v1';

function loadPrefs(): Prefs {
  const defaults: Prefs = { camera: 'front', mirror: true, cover: true };
  try {
    return { ...defaults, ...(JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as Partial<Prefs>) };
  } catch {
    return defaults;
  }
}

function savePrefs(): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* private mode: settings just won't persist */
  }
}

const params = new URLSearchParams(location.search);
const prefs = loadPrefs();
const camParam = params.get('camera');
if (camParam === 'front' || camParam === 'back') prefs.camera = camParam;
const latencyMode = params.has('latency');
const codec = codecFromUrl();

// ---------------------------------------------------------------- screen

const out = document.querySelector<HTMLVideoElement>('#out')!;
const freeze = document.querySelector<HTMLCanvasElement>('#freeze')!;
const status = document.querySelector<HTMLDivElement>('#status')!;
const outage = document.querySelector<HTMLDivElement>('#outage')!;
out.muted = true;
out.playsInline = true;

function say(text: string, isError = false): void {
  status.textContent = text;
  status.classList.toggle('error', isError);
  status.classList.toggle('hidden', !text);
  if (text) report('status', { text, isError });
}

function applyLayout(): void {
  for (const e of [out, freeze]) {
    e.style.objectFit = prefs.cover ? 'cover' : 'contain';
    e.style.transform = prefs.mirror ? 'scaleX(-1)' : '';
  }
}
applyLayout();

/** Keep the last picture on screen while a new connection starts (instead of black). */
function holdPicture(): void {
  if (!freeze.classList.contains('gone') || !framesThisLink || !out.videoWidth) return;
  freeze.width = out.videoWidth;
  freeze.height = out.videoHeight;
  freeze.getContext('2d')!.drawImage(out, 0, 0);
  freeze.classList.remove('gone');
}

function releasePicture(): void {
  freeze.classList.add('gone');
}

// ---------------------------------------------------------------- screenshot

/**
 * Before and after of the same frame, side by side, like S on the Mac: the Mac makes it from
 * the frame it received and sends the PNG back over the connection (shots.ts). Each half is
 * mirrored like the picture here. On the iPad the share sheet opens ("Save Image" puts it in
 * Photos, or AirDrop it to the Mac); elsewhere, or with no share sheet, it downloads.
 */
const shots = new ShotClient();

/** Safari opens the share sheet only shortly after a tap. If the picture took longer, this button asks for one more tap. */
const saveButton = el('button', 'btn save-shot gone', 'Screenshot ready · tap to save');
let readyFile: File | null = null;
let readyTimer: ReturnType<typeof setTimeout> | undefined;
saveButton.onclick = () => {
  if (readyFile) save(readyFile, false);
};

function note(text: string): void {
  say(text);
  setTimeout(() => status.textContent === text && say(''), 3000);
}

function showSaveButton(file: File | null): void {
  clearTimeout(readyTimer);
  readyFile = file;
  saveButton.classList.toggle('gone', !file);
  // Not saved within a minute: let it go.
  if (file) readyTimer = setTimeout(() => showSaveButton(null), 60_000);
}

function save(file: File, firstTry: boolean): void {
  if (isTouchDevice && navigator.canShare?.({ files: [file] })) {
    navigator
      .share({ files: [file] })
      .then(() => showSaveButton(null))
      .catch((err: Error) => {
        if (err.name === 'AbortError') showSaveButton(null); // the sheet was closed without saving
        else if (err.name === 'NotAllowedError' && firstTry) showSaveButton(file); // too long after the tap
        else {
          showSaveButton(null);
          downloadBlob(file, file.name);
        }
      });
  } else {
    downloadBlob(file, file.name);
  }
}

async function screenshot(): Promise<void> {
  if (shots.busy) return;
  if (!shots.ready) {
    note('the screenshot comes from the Mac: no connection to it right now');
    return;
  }
  flash.classList.remove('flash');
  void flash.offsetWidth; // restart the animation
  flash.classList.add('flash');
  showSaveButton(null);
  const t0 = performance.now();
  try {
    const blob = await shots.request(prefs.mirror);
    report('status', { text: `screenshot from the Mac: ${Math.round(blob.size / 1024)} KB in ${Math.round(performance.now() - t0)} ms` });
    save(new File([blob], `device-remover_ipad_${timestamp()}.png`, { type: 'image/png' }), true);
  } catch (err) {
    note(`no screenshot: ${(err as Error).message}`);
  }
}

// ---------------------------------------------------------------- screen recording

/**
 * Records what this screen shows, the "after" picture from the Mac (recorder.ts), and
 * downloads it when stopped (Files → Downloads on the iPad). Stops by itself after
 * ?recordMax seconds (default 5 minutes), so a forgotten recording cannot fill the memory.
 */
const recorder = new ScreenRecorder();
const recordMax = Number(params.get('recordMax')) || 300;
/** Small and quiet, like the reconnect indicator: whoever runs the piece can see it is recording. */
const recIndicator = el('div', 'hidden');
recIndicator.id = 'rec';
recorder.onChange = () => updateRecordUi();
recorder.onFile = (file) => {
  report('status', { text: `recording saved: ${file.name}, ${(file.size / 2 ** 20).toFixed(1)} MB` });
  downloadBlob(file, file.name);
};

function toggleRecording(): void {
  if (recorder.recording) {
    recorder.stop();
    return;
  }
  if (!ScreenRecorder.supported) {
    note('this browser cannot record the screen');
    return;
  }
  const held = !freeze.classList.contains('gone');
  const w = held ? freeze.width : out.videoWidth;
  const h = held ? freeze.height : out.videoHeight;
  if (!w || !h) {
    note('no picture to record yet');
    return;
  }
  try {
    recorder.start(w, h, `device-remover_ipad_${timestamp()}`, recordMax);
    recorder.draw(held ? freeze : out, w, h, prefs.mirror);
    report('status', { text: `recording started, ${w}×${h}` });
  } catch (err) {
    note(`cannot record: ${(err as Error).message}`);
  }
}

function updateRecordUi(): void {
  const t = recorder.seconds;
  const time = `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
  recordButton.textContent = recorder.recording ? `Stop recording · ${time}` : 'Record';
  recordButton.classList.toggle('recording', recorder.recording);
  saveRecordingButton.classList.toggle('gone', recorder.recording || !recorder.last);
  recIndicator.textContent = `REC ${time}`;
  recIndicator.classList.toggle('hidden', !recorder.recording);
}
setInterval(() => recorder.recording && updateRecordUi(), 500);

// ---------------------------------------------------------------- panel (double-tap, or D)

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

const panel = el('div', 'panel hidden');
const actions = el('div', 'actions');
const statsBox = el('pre', 'stats');
panel.append(el('div', 'panel-title', 'Device Remover · stream (iPad)'), actions, statsBox);
const togglePanel = () => panel.classList.toggle('hidden');
/** A short white flash over the picture when a screenshot is taken. */
const flash = el('div');
flash.id = 'shot-flash';
document.body.append(flash, saveButton, recIndicator);
function addAction(label: string, run: () => void): HTMLButtonElement {
  const b = el('button', 'btn', label);
  b.onclick = run;
  actions.append(b);
  return b;
}
addAction('Screenshot', () => void screenshot());
const recordButton = addAction('Record', toggleRecording);
/** In case the download did not happen: the last recording stays until the next one starts. */
const saveRecordingButton = addAction('Save last recording', () => recorder.last && downloadBlob(recorder.last, recorder.last.name));
saveRecordingButton.classList.add('gone');
addAction('Fullscreen', toggleFullscreen);
addAction('Reconnect', () => void connect('reconnect button'));
addAction('Close', togglePanel);

// Remove or grow the phones. The mode is the Mac's; the switch shows what the Mac says it is in.
const modes = new ModeClient();
{
  const row = el('div', 'row');
  const head = el('div', 'row-head');
  const value = el('span', 'value');
  head.append(el('span', undefined, 'Mode'), value);
  const group = el('div', 'modes');
  const labels = { remove: 'Remove', grow: 'Grow' };
  const buttons = IPAD_MODES.map((mode) => {
    const b = el('button', 'btn', labels[mode]);
    b.onclick = () => askMode(mode);
    group.append(b);
    return { mode, b };
  });
  modes.onChange = () => {
    for (const { mode, b } of buttons) {
      b.disabled = modes.mode === null;
      b.classList.toggle('chosen', modes.mode === mode);
      b.setAttribute('aria-pressed', String(modes.mode === mode));
    }
    value.textContent = modes.mode === null ? 'no connection to the Mac' : modes.mode === 'hijack' ? 'hijack (set on the Mac)' : '';
  };
  modes.onChange();
  row.append(head, group);
  panel.insertBefore(row, actions);
}

function askMode(mode: IpadMode): void {
  if (!modes.request(mode)) note('the mode is set on the Mac: no connection to it right now');
}
{
  const row = el('label', 'row');
  const head = el('div', 'row-head');
  head.append(el('span', undefined, 'Camera (reloads)'));
  const select = el('select');
  for (const f of ['front', 'back'] as const) {
    const o = el('option', undefined, f);
    o.value = f;
    select.append(o);
  }
  select.value = prefs.camera;
  select.onchange = () => {
    prefs.camera = select.value as Facing;
    prefs.mirror = prefs.camera === 'front';
    savePrefs();
    const p = new URLSearchParams(location.search);
    p.delete('camera');
    location.search = p.toString();
  };
  row.append(head, select);
  panel.append(row);
}
for (const [key, label] of [
  ['mirror', 'Mirror'],
  ['cover', 'Fill screen (crop edges)'],
] as const) {
  const row = el('label', 'row check');
  const input = el('input');
  input.type = 'checkbox';
  input.checked = prefs[key];
  input.onchange = () => {
    prefs[key] = input.checked;
    savePrefs();
    applyLayout();
  };
  row.append(input, el('span', undefined, label));
  panel.append(row);
}
panel.append(el('div', 'keys', isTouchDevice ? 'Double-tap the picture to show or hide this panel.' : 'D panel · G remove / grow · S screenshot · V record · F fullscreen · R reconnect'));
document.body.append(panel);

let lastTap = 0;
document.addEventListener('pointerup', (e) => {
  if (e.pointerType === 'mouse' || panel.contains(e.target as Node)) return;
  if (e.timeStamp - lastTap < 350) {
    togglePanel();
    lastTap = 0;
  } else {
    lastTap = e.timeStamp;
  }
});
window.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey || e.repeat || e.target instanceof HTMLSelectElement) return;
  const k = e.key.toLowerCase();
  if (k === 'd') togglePanel();
  else if (k === 'g') askMode(modes.mode === 'grow' ? 'remove' : 'grow');
  else if (k === 's') void screenshot();
  else if (k === 'v') toggleRecording();
  else if (k === 'f') toggleFullscreen();
  else if (k === 'r') void connect('R key');
});

// ---------------------------------------------------------------- connection state

let signal: Signal;
let pc: RTCPeerConnection | null = null;
let transceiver: RTCRtpTransceiver | null = null;
let meter: LinkMeter | null = null;
let offerId = '';
let connections = 0;
let notes = '';
let stopped = false;

let answered = false;
/** The Mac sends nothing while its detector loads; the frame watchdog waits for this. */
let macSending = false;
let startedAt = 0;
let connectedAt = 0;
let sendingSince = 0;
let disconnectedSince = 0;

/** The stream of the current connection, so frames of an old one are not counted. */
let linkStream: MediaStream | null = null;
let framesThisLink = 0;
let linkFirstFrameAt = 0;
let lastFrameAt = 0;
let framesShown = 0;

let failures = 0;
let retrying = false;
let retryTimer: ReturnType<typeof setTimeout> | undefined;

let sendTrack: MediaStreamTrack;
let sendStream: MediaStream;
let frameSize: () => { width: number; height: number };
let reader: StampReader | null = null;

/** Close any connection and start a new one with a fresh offer. */
async function connect(reason: string): Promise<void> {
  if (stopped || !sendTrack) return;
  clearTimeout(retryTimer);
  retrying = false;
  if (!signal.connected || !signal.peerPresent) return; // the hub's events call us when the Mac page is there
  const id = Math.random().toString(36).slice(2, 10);
  offerId = id;
  connections++;
  holdPicture();
  pc?.close();
  const p = newPeer();
  pc = p;
  meter = new LinkMeter(p);
  answered = false;
  macSending = false;
  startedAt = performance.now();
  connectedAt = 0;
  sendingSince = 0;
  disconnectedSince = 0;
  linkStream = null;
  framesThisLink = 0;
  report('status', { text: `connecting (#${connections}): ${reason}` });

  const t = p.addTransceiver(sendTrack, { direction: 'sendrecv', streams: [sendStream] });
  transceiver = t;
  // The screenshot's way back from the Mac, on the same connection.
  shots.attach(p.createDataChannel(SHOT_CHANNEL));
  modes.attach(p.createDataChannel(MODE_CHANNEL));
  notes = `${preferCodec(t, codec)} · ${lowLatency(t.receiver)}`;
  p.ontrack = (e) => {
    if (pc !== p) return;
    linkStream = e.streams[0] ?? new MediaStream([e.track]);
    out.srcObject = linkStream;
    void out.play().catch(() => undefined);
  };
  p.onconnectionstatechange = () => {
    if (pc !== p) return;
    if (p.connectionState === 'connected') connectedAt = performance.now();
    report('status', { text: `link ${p.connectionState}` });
  };

  await p.setLocalDescription(await p.createOffer());
  await waitForCandidates(p);
  if (pc !== p) return;
  const { width, height } = frameSize();
  const ok = await signal.send({ type: 'offer', id, sdp: p.localDescription!.sdp, width, height, facing: prefs.camera, codec });
  if (!ok && pc === p) retry('the offer did not reach the Mac page');
}

/** Try again after a pause that grows with each failure in a row: 1, 2, 4, 5, 5… s. */
function retry(reason: string): void {
  if (retrying || stopped) return;
  retrying = true;
  const delay = [1000, 2000, 4000, 5000][Math.min(failures, 3)];
  failures++;
  report('status', { text: `reconnecting in ${delay / 1000} s: ${reason}` });
  retryTimer = setTimeout(() => void connect(reason), delay);
}

async function onMessage(msg: SignalMessage): Promise<void> {
  if (!pc || msg.type === 'offer' || msg.id !== offerId) return;
  if (msg.type === 'answer') {
    const p = pc;
    try {
      await p.setRemoteDescription({ type: 'answer', sdp: msg.sdp });
      answered = true;
      if (transceiver) void limitSender(transceiver.sender);
    } catch (err) {
      console.error('[stream] the answer did not fit', err);
      if (pc === p) retry('bad answer');
    }
  } else if (msg.type === 'state') {
    if (msg.sending && !macSending) sendingSince = performance.now();
    macSending = msg.sending;
  } else if (msg.type === 'restart') {
    // The Mac gets nothing from us. A new connection usually fixes it; if it keeps happening,
    // something on this side is stuck (in tests: the video encoder), and only a reload helps.
    const now = performance.now();
    macRestarts = now - lastMacRestartAt < 30_000 ? macRestarts + 1 : 1;
    lastMacRestartAt = now;
    if (macRestarts >= 3) {
      report('status', { text: `the Mac got no frames ${macRestarts} times in a row, reloading this page` });
      location.reload();
      return;
    }
    retry(msg.reason);
  }
}
let macRestarts = 0;
let lastMacRestartAt = -Infinity;

/** Healthy: the current connection delivered a frame in the last second and a half. */
const healthy = () => framesThisLink > 0 && performance.now() - lastFrameAt < 1500;

// Watchdog: decides when to start over. Checked twice a second.
setInterval(() => {
  const now = performance.now();
  // A second without frames: keep the last picture in the freeze canvas, so it stays on screen
  // whatever the video element does when its stream ends. The indicator only after 3 s.
  if (lastFrameAt > 0 && now - lastFrameAt > 1000) holdPicture();
  // The camera stopped delivering frames (it can, while the track still says "live").
  if (cameraWatch && !restartingCamera && document.visibilityState === 'visible' && now - cameraFrameAt > 3000) void restartCamera();
  const stale = lastFrameAt > 0 && now - lastFrameAt > 3000;
  outage.textContent = signal?.peerPresent ? 'reconnecting' : 'waiting for the Mac';
  outage.classList.toggle('hidden', !stale);
  if (!pc || retrying || stopped || !signal.connected || !signal.peerPresent) return;
  const st = pc.connectionState;
  if (!answered) {
    if (now - startedAt > 5000) retry('no answer from the Mac page');
    return;
  }
  if (st === 'failed' || st === 'closed') return retry(`connection ${st}`);
  if (st === 'disconnected') {
    disconnectedSince ||= now;
    if (now - disconnectedSince > 3000) retry('connection lost');
    return;
  }
  disconnectedSince = 0;
  if (st !== 'connected') {
    if (now - startedAt > 10_000) retry('could not connect');
    return;
  }
  if (!macSending) {
    if (now - startedAt > 90_000) retry('the Mac page never started sending');
    return;
  }
  const since = framesThisLink ? lastFrameAt : Math.max(sendingSince, connectedAt);
  if (now - since > 3000) retry('no frames for 3 s');
}, 500);

// Every received frame.
function onFrame(): void {
  if (out.srcObject && out.srcObject === linkStream) {
    const now = performance.now();
    lastFrameAt = now;
    framesShown++;
    // Live again (a new connection, or the same one after a stall): drop the held picture.
    releasePicture();
    if (!framesThisLink++) {
      linkFirstFrameAt = now;
      failures = 0;
      say('');
      report('status', { text: `picture from the Mac (#${connections}), ${Math.round(now - startedAt)} ms after connecting` });
    }
    reader?.read(out);
    recorder.draw(out, out.videoWidth, out.videoHeight, prefs.mirror);
  }
}
const vfc = out as HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number };
if (typeof vfc.requestVideoFrameCallback === 'function') {
  const loop = () => {
    onFrame();
    vfc.requestVideoFrameCallback!(loop);
  };
  vfc.requestVideoFrameCallback(loop);
} else {
  let last = -1;
  setInterval(() => {
    const n = out.getVideoPlaybackQuality?.().totalVideoFrames ?? 0;
    if (n !== last) {
      last = n;
      onFrame();
    }
  }, 1000 / 60);
}

// ---------------------------------------------------------------- stats

let stats: LinkStats = NO_LINK;
let shownFps = 0;
let lastCount = 0;
let lastCountAt = performance.now();
let tick = 0;

function statsText(): string {
  const lat = reader?.summary();
  const age = lastFrameAt ? `${((performance.now() - lastFrameAt) / 1000).toFixed(1)} s ago` : 'none yet';
  const { width, height } = frameSize ? frameSize() : { width: 0, height: 0 };
  return [
    `picture   ${shownFps.toFixed(0)} fps · last frame ${age}`,
    describeLink(stats),
    `latency   ${lat ? `median ${lat.median.toFixed(0)} ms · p95 ${lat.p95.toFixed(0)} ms (${lat.n})` : latencyMode ? 'measuring…' : '– (open with ?latency)'}`,
    `camera    ${prefs.camera} · sending ${width}×${height}${latencyMode ? ' with frame counter' : ''}`,
    `Mac       ${signal?.peerPresent ? (macSending ? 'sending' : answered ? 'loading the detector…' : 'connecting…') : 'page not open'}`,
    `link #${connections} · ${notes}`,
  ].join('\n');
}

setInterval(() => {
  const now = performance.now();
  shownFps = ((framesShown - lastCount) * 1000) / (now - lastCountAt);
  lastCount = framesShown;
  lastCountAt = now;
  const m = meter;
  void (m ? m.read() : Promise.resolve(NO_LINK)).then((s) => {
    if (m !== meter) return;
    stats = s;
    if (!panel.classList.contains('hidden')) statsBox.textContent = statsText();
    if (reporting && tick++ % 5 === 0) {
      const lat = reader?.summary();
      report('link', { role: 'ipad', ...s, shownFps, latencyMs: lat?.median, latencyP95: lat?.p95, latencyN: lat?.n, connections });
    }
  });
}, 1000);

// ---------------------------------------------------------------- camera

let cam: MediaStream | null = null;
let camTrack: MediaStreamTrack | null = null;
/** The camera, never shown: its frame size follows the iPad's orientation, and in the latency
 *  test it is the picture the counter is drawn on. Also tells when the camera stalls. */
let local: HTMLVideoElement | null = null;
let stamper: Stamper | null = null;
/** Whether camera frames can be seen arriving (frame callbacks); only then is there a stall watchdog. */
let cameraWatch = false;
let cameraFrameAt = 0;
/** Restarts since the camera last delivered a frame. */
let cameraRestarts = 0;
let restartingCamera = false;
document.addEventListener('visibilitychange', () => {
  // Safari pauses the camera while the page is hidden: no stall to see there.
  if (document.visibilityState === 'visible') cameraFrameAt = performance.now();
});

function openCamera(): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      width: { ideal: 640 },
      height: { ideal: 480 },
      frameRate: { ideal: 30 },
      facingMode: prefs.camera === 'back' ? 'environment' : 'user',
    },
  });
}

function useCamera(stream: MediaStream): void {
  cam = stream;
  camTrack = stream.getVideoTracks()[0];
  camTrack.addEventListener('ended', () => void restartCamera('the camera track ended'));
}

/**
 * Get the camera again without reloading the page (a reload could bring back Safari's camera
 * question, with nobody there to answer it). Reload only if that fails.
 */
async function restartCamera(reason = 'the camera stopped delivering frames'): Promise<void> {
  if (restartingCamera || stopped || !local) return;
  if (cameraRestarts >= 3) {
    report('status', { text: `${reason}; three camera restarts did not help, reloading the page` });
    location.reload();
    return;
  }
  restartingCamera = true;
  cameraRestarts++;
  report('status', { text: `${reason}, restarting it` });
  try {
    const old = cam;
    useCamera(await openCamera());
    old?.getTracks().forEach((t) => t.stop());
    local.srcObject = cam;
    await local.play();
    cameraFrameAt = performance.now();
    if (!stamper && camTrack) {
      // The latency test keeps sending its canvas, which now draws the new camera.
      sendTrack = camTrack;
      sendStream = new MediaStream([camTrack]);
      await transceiver?.sender.replaceTrack(camTrack);
    }
  } catch (err) {
    console.error('[stream] could not restart the camera, reloading', err);
    setTimeout(() => location.reload(), 1000);
  } finally {
    restartingCamera = false;
  }
}

// ---------------------------------------------------------------- start

async function main(): Promise<void> {
  if (!navigator.mediaDevices?.getUserMedia) {
    say('Camera API unavailable: open this page over https (npm run dev:ipad).', true);
    return;
  }
  say('starting the camera…');
  try {
    useCamera(await openCamera());
  } catch (err) {
    const denied = err instanceof DOMException && err.name === 'NotAllowedError';
    say(denied ? 'Camera access was blocked. Allow it for this page and reload.' : `Camera error: ${(err as Error).message}`, true);
    return;
  }

  const v = document.createElement('video');
  v.muted = true;
  v.playsInline = true;
  v.srcObject = cam;
  await v.play();
  while (!v.videoWidth) await new Promise((r) => setTimeout(r, 30));
  const vfc = v as HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number };
  if (typeof vfc.requestVideoFrameCallback === 'function') {
    const onCameraFrame = () => {
      cameraFrameAt = performance.now();
      cameraRestarts = 0;
      vfc.requestVideoFrameCallback!(onCameraFrame);
    };
    vfc.requestVideoFrameCallback(onCameraFrame);
    cameraWatch = true;
  }
  cameraFrameAt = performance.now();
  local = v;

  stamper = latencyMode ? new Stamper(v) : null;
  reader = stamper ? new StampReader(stamper) : null;
  sendTrack = stamper ? stamper.track : camTrack!;
  sendStream = new MediaStream([sendTrack]);
  frameSize = () => (stamper ? { width: stamper.width, height: stamper.height } : { width: v.videoWidth, height: v.videoHeight });
  report('status', { text: `camera ${prefs.camera} ${v.videoWidth}×${v.videoHeight}${latencyMode ? ', latency test' : ''}` });

  say('looking for the Mac page…');
  signal = new Signal('ipad', {
    // The event stream (re)connected: at start, or after the dev server restarted or the Wi-Fi
    // dropped. The video connection does not depend on it, so a running picture is left alone.
    onHello: (peer) => {
      if (healthy()) return;
      if (peer) void connect('the Mac page is there');
      else say('waiting for the Mac page… (npm run stream:mac)');
    },
    onPeer: (present) => {
      if (present) void connect('the Mac page arrived');
      else {
        holdPicture();
        modes.detach();
        report('status', { text: 'the Mac page left' });
      }
    },
    onMessage: (msg) => void onMessage(msg),
    onReplaced: () => {
      stopped = true;
      clearTimeout(retryTimer);
      pc?.close();
      cam?.getTracks().forEach((t) => t.stop());
      say('This page was opened again somewhere else, so this copy has stopped. Reload to take over.', true);
    },
  });

  // For tests and the console.
  Object.assign(window, {
    streamPage: {
      framesShown: () => framesShown,
      linkFrames: () => framesThisLink,
      linkFirstFrameAt: () => linkFirstFrameAt,
      connections: () => connections,
      stats: () => ({ ...stats, shownFps }),
      latency: () => reader?.summary() ?? null,
      unreadable: () => reader?.unreadable ?? 0,
      resetLatency: () => reader?.reset(),
      reconnect: () => connect('test'),
      mode: () => modes.mode,
      camera: () => {
        const ts = (camTrack as (MediaStreamTrack & { stats?: { deliveredFrames: number; totalFrames: number } }) | null)?.stats;
        return {
          readyState: camTrack?.readyState,
          muted: camTrack?.muted,
          delivered: ts?.deliveredFrames ?? null,
          total: ts?.totalFrames ?? null,
          localFrames: v.getVideoPlaybackQuality().totalVideoFrames,
          sinceCameraFrameMs: Math.round(performance.now() - cameraFrameAt),
        };
      },
      restartCamera: () => restartCamera('test'),
      /** Stop sending without telling anyone, as a stalled camera or encoder would. */
      stopSending: () => transceiver?.sender.replaceTrack(null),
      /** What was sent (the camera) next to what came back, as a JPEG data URL. */
      grab: () => {
        const w = out.videoWidth || v.videoWidth;
        const h = out.videoHeight || v.videoHeight;
        const c = el('canvas');
        c.width = w * 2;
        c.height = h;
        const ctx = c.getContext('2d')!;
        ctx.drawImage(v, 0, 0, w, h);
        if (out.videoWidth) ctx.drawImage(out, w, 0, w, h);
        return c.toDataURL('image/jpeg', 0.85);
      },
    },
  });
}

void main();
