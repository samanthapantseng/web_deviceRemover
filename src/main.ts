import './style.css';
import { openCamera, openStill, type FrameSource } from './camera';
import { YoloSegDetector } from './detect/yoloSeg';
import { RemoveEffect } from './effects/remove';
import { FillSet } from './fill';
import { Pipeline } from './pipeline';
import { FILL_ORDER, SettingsStore, STYLE_ORDER } from './settings';
import { downloadPng, sideBySide, timestamp } from './snapshot';
import { DebugPanel } from './ui/panel';

const store = new SettingsStore();
const settings = store.value;

const view = document.querySelector<HTMLCanvasElement>('#view')!;
const status = document.querySelector<HTMLDivElement>('#status')!;
const hint = document.querySelector<HTMLDivElement>('#hint')!;
const panel = new DebugPanel(store);
document.body.append(panel.root);

function say(text: string, isError = false): void {
  status.textContent = text;
  status.classList.toggle('error', isError);
  status.classList.toggle('hidden', !text);
}

function applyLayout(): void {
  view.style.objectFit = settings.cover ? 'cover' : 'contain';
}
applyLayout();

store.onChange((_s, key) => {
  if (key === 'cover') applyLayout();
  // The detector is created once at start-up; switching model is rare, so just reload.
  if (key === 'detector') location.reload();
});

function toggleFullscreen(): void {
  if (document.fullscreenElement) void document.exitFullscreen();
  else void document.documentElement.requestFullscreen().catch(() => undefined);
}

async function main(): Promise<void> {
  // 1. Camera first, so there is a picture on screen while the models load.
  // ?src=<image url>  use a still image instead of the camera (for timing and testing)
  // ?model=<name>     try another detector without changing the saved setting
  const params = new URLSearchParams(location.search);
  const still = params.get('src');
  const model = params.get('model') ?? settings.detector;
  let source: FrameSource;
  say(still ? 'loading image…' : 'waiting for camera…');
  try {
    source = still ? await openStill(still) : await openCamera();
  } catch (err) {
    const denied = err instanceof DOMException && err.name === 'NotAllowedError';
    say(denied ? 'Camera access was blocked. Allow it for this page and reload.' : `Camera error: ${(err as Error).message}`, true);
    return;
  }
  view.width = source.width;
  view.height = source.height;
  const ctx = view.getContext('2d', { alpha: false })!;

  const detector = new YoloSegDetector();
  const fills = new FillSet();
  const effect = new RemoveEffect(source.width, source.height, fills);
  const pipeline = new Pipeline(source, detector, effect, settings);
  pipeline.debugRect = () => effect.rect;

  // 2. Display loop: screen rate, independent of how fast the models run.
  let displayFps = 0;
  let lastFrame = 0;
  let lastStats = 0;
  const frame = (now: number) => {
    if (lastFrame) displayFps += 0.1 * (1000 / (now - lastFrame) - displayFps);
    lastFrame = now;
    pipeline.render(ctx);
    if (panel.visible && now - lastStats > 250) {
      lastStats = now;
      const st = pipeline.stats;
      panel.setStats({
        displayFps,
        pipelineFps: st.pipelineFps,
        detectMs: st.detectMs,
        inferMs: st.inferMs,
        maskMs: st.maskMs,
        inpaintMs: st.effectMs,
        phones: st.phones,
        bestScore: st.bestScore,
        held: st.held,
        detector: `${model} · ${detector.backend}`,
        fill: effect.describe(),
        source: source.label,
      });
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);

  // 3. Keys work from the start, also while models are still loading.
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
        void pipeline.snapshot().then((snap) => downloadPng(sideBySide(snap), `device-remover_${timestamp()}.png`));
        break;
      default:
        return;
    }
    e.preventDefault();
  });

  // 4. Detector, then the fills in the background (the stylised one is ready instantly).
  say('loading phone detector…');
  try {
    await detector.init(model, (f) => say(`loading phone detector… ${Math.round(f * 100)}%`));
  } catch (err) {
    say(`Detector failed to load: ${(err as Error).message}`, true);
    return;
  }
  pipeline.start();
  say('loading fill models…');
  await fills.load();
  say('');
  setTimeout(() => hint.classList.add('hidden'), 6000);

  // Exposed for timing runs from the console / automated checks.
  Object.assign(window, { deviceRemover: { pipeline, effect, detector, store, displayFps: () => displayFps } });
}

void main();
