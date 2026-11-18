import './style.css';
import { openCamera, openStill, type CameraFacing, type FrameSource } from './camera';
import { YoloSegDetector } from './detect/yoloSeg';
import { report, reporting, startReporting, wasmMemoryMB } from './devReport';
import { GrowEffect } from './effects/grow';
import { RemoveEffect } from './effects/remove';
import { FillSet } from './fill';
import { Pipeline } from './pipeline';
import { FILL_ORDER, MODE_ORDER, SettingsStore, STYLE_ORDER, type ModeId } from './settings';
import { downloadPng, sideBySide, timestamp } from './snapshot';
import { openRemote, type RemoteSource } from './stream/remoteSource';
import { DebugPanel, isTouchDevice } from './ui/panel';

startReporting();

const store = new SettingsStore();
const settings = store.value;

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
  // ?mode=remove|grow            start in that mode, without changing the saved setting
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
  say(still ? 'loading image…' : streamMode ? 'waiting for the iPad…' : 'waiting for camera…');
  try {
    source = still ? await openStill(still) : streamMode ? (remote = await openRemote(say)) : await openCamera(facing);
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
  const effectFor = (mode: ModeId) => (mode === 'grow' ? grow : remove);
  const pipeline = new Pipeline(source, detector, effectFor(settings.mode), settings);
  pipeline.debugRect = () => (pipeline.activeEffect === remove ? remove.rect : null);
  store.onChange((_s, key) => {
    if (key === 'mode') pipeline.setEffect(effectFor(settings.mode));
  });

  // 2. Display loop: screen rate, independent of how fast the models run.
  let displayFps = 0;
  let lastFrame = 0;
  let lastStats = 0;
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
    if (panel.visible && now - lastStats > 250) {
      lastStats = now;
      panel.setStats(stats());
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  if (reporting) setInterval(() => report('stats', { ...stats(), cropSize: settings.cropSize, wasmMB: wasmMemoryMB() }), 5000);

  const snapshot = () => void pipeline.snapshot().then((snap) => downloadPng(sideBySide(snap), `device-remover_${timestamp()}.png`));

  // 3. Keys and touch work from the start, also while models are still loading.
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
  panel.addAction('Fullscreen', toggleFullscreen);
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
      detector,
      store,
      displayFps: () => displayFps,
    },
  });
}

void main();
