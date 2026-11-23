import './style.css';
import { openCamera, openStill, type CameraFacing, type FrameSource } from './camera';
import { YoloSegDetector } from './detect/yoloSeg';
import { report, reporting, startReporting, wasmMemoryMB } from './devReport';
import { LiveSound } from './audio/engine';
import { CHARACTER_LABELS } from './audio/voices';
import { GrowEffect } from './effects/grow';
import { HijackEffect } from './effects/hijack';
import { RemoveEffect } from './effects/remove';
import { FillSet } from './fill';
import { Pipeline } from './pipeline';
import { ScreenRecorder } from './recorder';
import { CHARACTERS, FILL_ORDER, MODE_ORDER, SettingsStore, STYLE_ORDER, type ModeId } from './settings';
import { downloadBlob, downloadPng, mirrored, sideBySide, timestamp, toPngBlob } from './snapshot';
import type { ModeControl } from './stream/modeLink';
import { openRemote, type RemoteSource } from './stream/remoteSource';
import { DebugPanel, isTouchDevice } from './ui/panel';
import { noZoom } from './ui/noZoom';

startReporting();
noZoom();

const store = new SettingsStore();
const settings = store.value;
// Hijack mode's sound. Browsers allow sound only after a click or key press on the page.
const sound = new LiveSound();
const unlockSound = () => settings.mode === 'hijack' && sound.ensure();
window.addEventListener('keydown', unlockSound);
window.addEventListener('pointerdown', unlockSound);

const view = document.querySelector<HTMLCanvasElement>('#view')!;
const status = document.querySelector<HTMLDivElement>('#status')!;
const hint = document.querySelector<HTMLDivElement>('#hint')!;
const panel = new DebugPanel(store);
document.body.append(panel.root);
if (isTouchDevice) hint.textContent = 'double-tap for settings';

function say(text: string, isError = false): void {
  status.textContent = text;
  status.classList.toggle('error', isError);
  status.classList.toggle('hidden', !text);
  if (text && !text.includes('%')) report('status', { text, isError });
}

function applyLayout(): void {
  view.style.objectFit = settings.cover ? 'cover' : 'contain';
}
applyLayout();

store.onChange((_s, key) => {
  if (key === 'cover') applyLayout();
  // The front camera is shown mirrored, like a mirror; the back camera is not.
  if (key === 'camera') store.set('mirror', settings.camera === 'front');
  // The detector and camera are opened once at start-up; switching is rare, so just reload.
  if (key === 'detector' || key === 'camera') location.reload();
});

type FullscreenDoc = Document & { webkitFullscreenElement?: Element | null; webkitExitFullscreen?: () => void };
type FullscreenEl = HTMLElement & { webkitRequestFullscreen?: () => void };

function toggleFullscreen(): void {
  const doc = document as FullscreenDoc;
  const el = document.documentElement as FullscreenEl;
  if (doc.fullscreenElement ?? doc.webkitFullscreenElement) {
    if (typeof doc.exitFullscreen === 'function') void doc.exitFullscreen().catch(() => undefined);
    else doc.webkitExitFullscreen?.();
  } else if (typeof el.requestFullscreen === 'function') {
    void el.requestFullscreen().catch(() => undefined);
  } else {
    el.webkitRequestFullscreen?.(); // older Safari on iPad
  }
}

/** Keep the screen on while the piece runs (an iPad locks itself after a few minutes). */
async function keepAwake(): Promise<void> {
  const nav = navigator as Navigator & { wakeLock?: { request(type: 'screen'): Promise<unknown> } };
  try {
    await nav.wakeLock?.request('screen');
  } catch {
    /* unsupported, or not allowed until the first tap */
  }
}
void keepAwake();
document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && void keepAwake());
window.addEventListener('pointerdown', () => void keepAwake(), { once: true });

async function main(): Promise<void> {
  // 1. Camera first, so there is a picture on screen while the models load.
  // ?src=<image url>     use a still image instead of the camera (for timing and testing)
  // ?model=<name>        try another detector without changing the saved setting
  // ?camera=front|back   which camera, without changing the saved setting
  // ?runFor=<seconds>    stop processing after that long (for memory and timing tests)
  // ?fill=migan|telea|stylised   start with that fill, without changing the saved setting
  // ?mode=remove|grow|hijack     start in that mode, without changing the saved setting
  const params = new URLSearchParams(location.search);
  const modeParam = params.get('mode') as ModeId | null;
  if (modeParam && MODE_ORDER.includes(modeParam)) settings.mode = modeParam;
  panel.refresh();
  const fillParam = params.get('fill') as (typeof FILL_ORDER)[number] | null;
  if (fillParam && FILL_ORDER.includes(fillParam)) settings.fill = fillParam;
  const still = params.get('src');
  const model = params.get('model') ?? settings.detector;
  const camParam = params.get('camera');
  const facing: CameraFacing = camParam === 'front' || camParam === 'back' ? camParam : settings.camera;
  let source: FrameSource;
  // Streaming mode (?source=stream, npm run dev:ipad only): the frames come from the iPad's
  // stream page and the result goes back to it. The iPad mirrors what it shows, so the Mac does not.
  const streamMode = params.get('source') === 'stream';
  let remote: RemoteSource | null = null;
  if (streamMode) settings.mirror = false;
  // The iPad's Remove / Grow switch changes the mode here, like G does.
  const modeControl: ModeControl = {
    get: () => settings.mode,
    set: (mode) => {
      report('status', { text: `${mode} mode, switched on the iPad` });
      store.set('mode', mode);
    },
    onChange: (changed) => store.onChange((_s, key) => key === 'mode' && changed()),
  };
  say(still ? 'loading image…' : streamMode ? 'waiting for the iPad…' : 'waiting for camera…');
  try {
    source = still ? await openStill(still) : streamMode ? (remote = await openRemote(say, modeControl)) : await openCamera(facing);
  } catch (err) {
    const denied = err instanceof DOMException && err.name === 'NotAllowedError';
    say(denied ? 'Camera access was blocked. Allow it for this page and reload.' : `Camera error: ${(err as Error).message}`, true);
    return;
  }
  view.width = source.width;
  view.height = source.height;
  const ctx = view.getContext('2d', { alpha: false })!;

  // Turning a tablet swaps the camera image between landscape and portrait. Everything is
  // sized for the first frame, so start over in the new orientation.
  const video = source.element;
  if (video instanceof HTMLVideoElement) {
    const landscape = source.width >= source.height;
    video.addEventListener('resize', () => {
      if (video.videoWidth && video.videoWidth >= video.videoHeight !== landscape) {
        say('orientation changed, restarting…');
        location.reload();
      }
    });
  }

  const detector = new YoloSegDetector();
  const fills = new FillSet();
  const remove = new RemoveEffect(source.width, source.height, fills);
  const grow = new GrowEffect(source.width, source.height);
  const hijack = new HijackEffect(source.width, source.height, sound);
  const effectFor = (mode: ModeId) => (mode === 'grow' ? grow : mode === 'hijack' ? hijack : remove);
  const pipeline = new Pipeline(source, detector, effectFor(settings.mode), settings);
  pipeline.debugRect = () => (pipeline.activeEffect === remove ? remove.rect : null);
  store.onChange((_s, key) => {
    if (key === 'mode') pipeline.setEffect(effectFor(settings.mode));
  });

  // 2. Display loop: screen rate, independent of how fast the models run.
  let displayFps = 0;
  let lastFrame = 0;
  let lastStats = 0;
  const recorder = new ScreenRecorder();
  let lastRecorded = 0;
  // Hijack mode without sound yet: say how to get it.
  const soundHint = document.createElement('div');
  soundHint.id = 'sound';
  soundHint.className = 'hidden';
  soundHint.textContent = 'click or press any key for sound';
  document.body.append(soundHint);
  let soundHintShown = false;
  const stats = () => {
    const st = pipeline.stats;
    return {
      displayFps,
      pipelineFps: st.pipelineFps,
      detectMs: st.detectMs,
      inferMs: st.inferMs,
      maskMs: st.maskMs,
      inpaintMs: st.effectMs,
      phones: st.phones,
      bestScore: st.bestScore,
      objects: st.objects,
      rejected: st.rejected,
      held: st.held,
      detector: `${model} · ${detector.backend}`,
      effect: pipeline.activeEffect.describe(),
      source: source.label,
    };
  };
  const frame = (now: number) => {
    // Two callbacks can share a timestamp; dividing by zero would leave the average NaN for good.
    if (lastFrame && now > lastFrame) displayFps += 0.1 * (1000 / (now - lastFrame) - displayFps);
    lastFrame = now;
    pipeline.render(ctx);
    const wantHint = settings.mode === 'hijack' && !sound.running;
    if (wantHint !== soundHintShown) soundHint.classList.toggle('hidden', !(soundHintShown = wantHint));
    // Screen recording, at most 30 frames a second: the picture as on screen, but without the
    // mask overlay (drawn again without it only while the overlay is on).
    if (recorder.recording && now - lastRecorded >= 1000 / 30 - 4) {
      lastRecorded = now;
      if (settings.showMask) recorder.paint((c) => pipeline.render(c, false));
      else recorder.draw(view, view.width, view.height, false);
    }
    if (panel.visible && now - lastStats > 250) {
      lastStats = now;
      panel.setStats(stats());
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  if (reporting) setInterval(() => report('stats', { ...stats(), cropSize: settings.cropSize, wasmMB: wasmMemoryMB() }), 5000);

  const snapshot = () => void pipeline.snapshot().then((snap) => downloadPng(sideBySide(snap), `device-remover_${timestamp()}.png`));

  // Screen recording (V, or Record in the panel): only the "after" picture, downloaded as a
  // video when stopped. Stops by itself after ?recordMax seconds (default 5 minutes).
  const recordMax = Number(params.get('recordMax')) || 300;
  const recIndicator = document.createElement('div');
  recIndicator.id = 'rec';
  recIndicator.className = 'hidden';
  document.body.append(recIndicator);
  const note = (text: string) => {
    say(text);
    setTimeout(() => status.textContent === text && say(''), 3000);
  };
  recorder.onChange = () => updateRecordUi();
  recorder.onFile = (file) => {
    report('status', { text: `recording saved: ${file.name}, ${(file.size / 2 ** 20).toFixed(1)} MB` });
    downloadBlob(file, file.name);
  };
  const toggleRecording = () => {
    if (recorder.recording) return recorder.stop();
    if (!ScreenRecorder.supported) return note('this browser cannot record the screen');
    try {
      // In hijack mode the recording has the sound too.
      const audio = settings.mode === 'hijack' ? sound.stream() : null;
      recorder.start(view.width, view.height, `device-remover_${timestamp()}`, recordMax, audio);
      lastRecorded = 0;
      report('status', { text: `recording started, ${view.width}×${view.height}` });
    } catch (err) {
      note(`cannot record: ${(err as Error).message}`);
    }
  };
  const updateRecordUi = () => {
    const t = recorder.seconds;
    const time = `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
    recordButton.textContent = recorder.recording ? `Stop recording · ${time}` : 'Record';
    recordButton.classList.toggle('recording', recorder.recording);
    saveRecordingButton.classList.toggle('gone', recorder.recording || !recorder.last);
    recIndicator.textContent = `REC ${time}`;
    recIndicator.classList.toggle('hidden', !recorder.recording);
  };
  setInterval(() => recorder.recording && updateRecordUi(), 500);

  // 3. Keys and touch work from the start, also while models are still loading.
  let beforeHijack: ModeId = settings.mode === 'hijack' ? 'remove' : settings.mode;
  window.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
    // Typing a letter in a focused <select> picks an option; leave those keys alone.
    if (e.target instanceof HTMLSelectElement) return;
    switch (e.key.toLowerCase()) {
      case '1':
      case '2':
        store.set('fill', FILL_ORDER[Number(e.key) - 1]);
        break;
      case '3':
        // Pressing 3 while already on the stylised fill steps through its variants.
        if (settings.fill === 'stylised') {
          store.set('style', STYLE_ORDER[(STYLE_ORDER.indexOf(settings.style) + 1) % STYLE_ORDER.length]);
        }
        store.set('fill', 'stylised');
        break;
      case 'g':
        store.set('mode', settings.mode === 'grow' ? 'remove' : 'grow');
        break;
      case 'h':
        // Hijack on; pressed again, back to the mode before.
        if (settings.mode === 'hijack') store.set('mode', beforeHijack);
        else {
          beforeHijack = settings.mode;
          store.set('mode', 'hijack');
          sound.ensure();
        }
        break;
      case 'm':
        store.set('showMask', !settings.showMask);
        break;
      case 'x':
        store.set('mirror', !settings.mirror);
        break;
      case 'd':
        panel.toggle();
        break;
      case 'f':
        toggleFullscreen();
        break;
      case 's':
        snapshot();
        break;
      case 'v':
        toggleRecording();
        break;
      default:
        return;
    }
    e.preventDefault();
  });

  // Without a keyboard: double-tap the picture for the panel, which has buttons for the rest.
  let lastTap = 0;
  view.addEventListener('pointerup', (e) => {
    if (e.pointerType === 'mouse') return;
    if (e.timeStamp - lastTap < 350) {
      panel.toggle();
      lastTap = 0;
    } else {
      lastTap = e.timeStamp;
    }
  });
  panel.addAction('Snapshot', snapshot);
  const recordButton = panel.addAction('Record', toggleRecording);
  // In case the download did not happen: the last recording stays until the next one starts.
  const saveRecordingButton = panel.addAction('Save last recording', () => recorder.last && downloadBlob(recorder.last, recorder.last.name));
  saveRecordingButton.classList.add('gone');
  panel.addAction('Fullscreen', toggleFullscreen);
  // Hijack mode: hear a character for 5 s without a phone (the one chosen, or each in turn).
  let testIndex = 0;
  panel.addAction('Test sound', () => {
    sound.ensure();
    const character = settings.hijackSound === 'auto' ? CHARACTERS[testIndex++ % CHARACTERS.length] : settings.hijackSound;
    if (!sound.engine) return note('no sound: this browser has no Web Audio');
    sound.setVolume(settings.hijackVolume);
    sound.engine.preview(character, Math.floor(Math.random() * 2 ** 31));
    note(`test sound: ${CHARACTER_LABELS[character]}`);
  });
  panel.addAction('Close', () => panel.toggle());

  // 4. Detector, then the fills in the background (the stylised one is ready instantly).
  say('loading phone detector…');
  try {
    await detector.init(model, (f) => say(`loading phone detector… ${Math.round(f * 100)}%`));
  } catch (err) {
    say(`Detector failed to load: ${(err as Error).message}`, true);
    return;
  }
  report('status', { text: `detector ${model} on ${detector.backend}, camera ${source.label}` });
  pipeline.start();
  // Streaming mode: only now, with the detector running, does the iPad get pictures back.
  remote?.sendBack(view);
  // Streaming mode: the iPad's Screenshot button gets the same before/after as S here, each
  // half mirrored like the iPad shows it.
  remote?.onScreenshot((mirror) =>
    pipeline.snapshot().then((snap) => toPngBlob(sideBySide(mirror ? { before: mirrored(snap.before), after: mirrored(snap.after) } : snap))),
  );
  const runFor = Number(params.get('runFor'));
  if (runFor > 0) setTimeout(() => (pipeline.stop(), say(`stopped after ${runFor} s (?runFor)`)), runFor * 1000);
  // Only the fill in use is loaded; another one loads when it is picked (stylised meanwhile).
  // Grow mode needs no fill: it is loaded when remove mode is switched on.
  await fills.ensure('stylised');
  if (settings.mode === 'remove') {
    say(`loading ${fills.get(settings.fill).label}…`);
    await fills.ensure(settings.fill);
  }
  say('');
  store.onChange((_s, key) => {
    if ((key === 'fill' || key === 'mode') && settings.mode === 'remove') void fills.ensure(settings.fill).then(reportFills);
  });
  function reportFills(): void {
    const states = FILL_ORDER.map((id) => {
      const f = fills.get(id);
      const st = fills.state(id);
      return st === 'ready' ? `${f.label} on ${f.backend()}` : st === 'failed' ? `${f.label} FAILED: ${fills.error(id) ?? ''}` : `${f.label} not loaded`;
    });
    report('status', { text: `fills: ${states.join(' · ')}` });
  }
  reportFills();
  setTimeout(() => hint.classList.add('hidden'), isTouchDevice ? 10000 : 6000);

  // Exposed for timing runs from the console / automated checks.
  // `effect` is the one in use; `remove` and `grow` are both modes' effects.
  Object.assign(window, {
    deviceRemover: {
      pipeline,
      get effect() {
        return pipeline.activeEffect;
      },
      remove,
      grow,
      hijack,
      sound,
      detector,
      store,
      displayFps: () => displayFps,
    },
  });
}

void main();
