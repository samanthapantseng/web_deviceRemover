// Still-image test page: the same modules as the live view, run on a single frame.
//   still.html                      capture from the webcam or open a file
//   still.html?img=captures/x.png   run on an image straight away
//   &model=yolo11s-seg &conf=0.2    override the detector / threshold
//   &cropSize=400 &dilate=8 ...     override any numeric setting
//   &save=name                      (dev server only) also write the result sheet to captures/name.png
import './style.css';
import { captureStill, loadImage } from './camera';
import { YoloSegDetector } from './detect/yoloSeg';
import { RemoveEffect } from './effects/remove';
import type { EffectFrame } from './effects/types';
import { FillSet } from './fill';
import { AlphaCanvas } from './mask/alphaCanvas';
import { MaskStabilizer } from './mask/stabilizer';
import { SettingsStore, type DetectorModel, type FillId, type Settings, type StyleVariant } from './settings';
import { downloadPng, timestamp, toPngBlob } from './snapshot';
import { makeCanvas } from './types';

const params = new URLSearchParams(location.search);
const base = new SettingsStore().value;
const settings: Settings = {
  ...base,
  detector: (params.get('model') as DetectorModel | null) ?? base.detector,
  confidence: Number(params.get('conf') ?? base.confidence),
  fillSmoothing: 0,
  mirror: false,
};
// Any numeric setting can be overridden for an experiment, e.g. &cropSize=400&dilate=8
for (const [key, value] of params) {
  const k = key as keyof Settings;
  if (typeof settings[k] === 'number' && value !== '' && Number.isFinite(Number(value))) {
    (settings as unknown as Record<string, number>)[k] = Number(value);
  }
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const sheet = $<HTMLCanvasElement>('sheet');
const report = $<HTMLPreElement>('report');
const msg = $<HTMLSpanElement>('msg');
const captureBtn = $<HTMLButtonElement>('capture');
const saveBtn = $<HTMLButtonElement>('save');
const fileInput = $<HTMLInputElement>('file');

const detector = new YoloSegDetector();
const fills = new FillSet();

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[xs.length >> 1];
const RUNS = 5;

async function saveToProject(canvas: HTMLCanvasElement, name: string): Promise<boolean> {
  if (!import.meta.env.DEV) return false;
  const res = await fetch(`__capture?name=${encodeURIComponent(name)}`, { method: 'POST', body: await toPngBlob(canvas) });
  return res.ok;
}

async function run(frame: HTMLCanvasElement): Promise<void> {
  const { width, height } = frame;
  msg.textContent = 'running…';
  const stabilizer = new MaskStabilizer(width, height);
  const alphaCanvas = new AlphaCanvas(width, height);
  const effect = new RemoveEffect(width, height, fills);

  // Detection (first run is a warm-up for this input, then timed runs).
  let det = await detector.detect(frame, width, height, { conf: settings.confidence });
  const pre: number[] = [];
  const infer: number[] = [];
  const post: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    det = await detector.detect(frame, width, height, { conf: settings.confidence });
    pre.push(det.preMs);
    infer.push(det.inferMs);
    post.push(det.postMs);
  }
  const boxes = det.boxes.map((b) => ({ ...b }));

  const maskTimes: number[] = [];
  let mask = stabilizer.update(null, null, { dilate: 0, feather: 0, holdFrames: 0, persistFrames: 1 });
  for (let i = 0; i < RUNS; i++) {
    const t = performance.now();
    mask = stabilizer.update(boxes.length ? det.mask : null, det.bounds, {
      dilate: settings.dilate,
      feather: settings.feather,
      holdFrames: settings.holdFrames,
      persistFrames: 1,
    });
    alphaCanvas.write(mask);
    maskTimes.push(performance.now() - t);
  }

  const tiles: { label: string; canvas: HTMLCanvasElement }[] = [{ label: 'before', canvas: frame }];
  const lines: string[] = [];

  // Mask overlay tile.
  {
    const { canvas, ctx } = makeCanvas(width, height);
    ctx.drawImage(frame, 0, 0);
    const tint = makeCanvas(width, height);
    tint.ctx.fillStyle = '#ff00c8';
    tint.ctx.fillRect(0, 0, width, height);
    tint.ctx.globalCompositeOperation = 'destination-in';
    tint.ctx.drawImage(alphaCanvas.canvas, 0, 0);
    ctx.globalAlpha = 0.5;
    ctx.drawImage(tint.canvas, 0, 0);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = '#ffe600';
    ctx.fillStyle = '#ffe600';
    ctx.lineWidth = 1.5;
    ctx.font = '12px ui-monospace, Menlo, monospace';
    for (const b of boxes) {
      ctx.strokeRect(b.x1, b.y1, b.x2 - b.x1, b.y2 - b.y1);
      ctx.fillText(b.score.toFixed(2), b.x1, b.y1 - 4);
    }
    tiles.push({ label: `mask (${boxes.length} phone${boxes.length === 1 ? '' : 's'})`, canvas });
  }

  const variants: { fill: FillId; style?: StyleVariant; label: string }[] = [
    { fill: 'migan', label: 'MI-GAN' },
    { fill: 'telea', label: 'Telea' },
    { fill: 'stylised', style: 'blur', label: 'stylised: blur' },
    { fill: 'stylised', style: 'flat', label: 'stylised: flat' },
    { fill: 'stylised', style: 'void', label: 'stylised: void' },
  ];
  for (const v of variants) {
    const s: Settings = { ...settings, fill: v.fill, style: v.style ?? settings.style };
    const f: EffectFrame = { frame, width, height, mask, maskCanvas: alphaCanvas.canvas, boxes, settings: s };
    const { canvas, ctx } = makeCanvas(width, height);
    ctx.drawImage(frame, 0, 0);
    const times: number[] = [];
    if (mask.present) {
      effect.onMask(f);
      await effect.process(f); // warm-up
      for (let i = 0; i < RUNS; i++) {
        await effect.process(f);
        times.push(effect.fillMs);
      }
      effect.render(ctx, true);
    }
    const ready = fills.state(v.fill) === 'ready';
    const ms = times.length ? `${median(times).toFixed(1)} ms` : '–';
    tiles.push({ label: ready ? `${v.label} · ${ms}` : `${v.label} · NOT LOADED (${fills.error(v.fill) ?? '?'})`, canvas });
    lines.push(`fill ${v.label.padEnd(15)} ${ms.padStart(9)}   ${fills.get(v.fill).backend()}`);
  }

  // Result sheet: all tiles in a row, labelled.
  const cols = Math.min(tiles.length, 4);
  const rows = Math.ceil(tiles.length / cols);
  sheet.width = cols * width;
  sheet.height = rows * (height + 22);
  const sc = sheet.getContext('2d')!;
  sc.fillStyle = '#000';
  sc.fillRect(0, 0, sheet.width, sheet.height);
  sc.font = '13px ui-monospace, Menlo, monospace';
  tiles.forEach((t, i) => {
    const x = (i % cols) * width;
    const y = Math.floor(i / cols) * (height + 22);
    sc.fillStyle = '#fff';
    sc.fillText(t.label, x + 6, y + 15);
    sc.drawImage(t.canvas, x, y + 22);
  });

  const summary = {
    crossOriginIsolated: self.crossOriginIsolated,
    frame: `${width}×${height}`,
    detector: `${settings.detector} · ${detector.backend}`,
    confidence: settings.confidence,
    phones: boxes.map((b) => ({ score: +b.score.toFixed(3), box: [b.x1, b.y1, b.x2, b.y2].map(Math.round) })),
    hole: mask.present ? mask.roi : null,
    crop: effect.rect,
    medianMs: {
      detectPre: +median(pre).toFixed(2),
      detectInfer: +median(infer).toFixed(2),
      detectPost: +median(post).toFixed(2),
      mask: +median(maskTimes).toFixed(2),
    },
  };
  report.textContent = `${JSON.stringify(summary, null, 2)}\n\n${lines.join('\n')}`;
  Object.assign(window, { stillReport: { ...summary, fills: lines } });
  msg.textContent = boxes.length ? 'done' : 'done: no phone detected in this frame';
  saveBtn.disabled = false;

  const save = params.get('save');
  if (save) await saveToProject(sheet, `${save}.png`);
}

async function main(): Promise<void> {
  try {
    await detector.init(settings.detector, (f) => (msg.textContent = `loading detector… ${Math.round(f * 100)}%`));
    msg.textContent = 'loading fill models…';
    await fills.load();
  } catch (err) {
    msg.textContent = `failed: ${(err as Error).message}`;
    console.error(err);
    return;
  }
  msg.textContent = 'ready';
  captureBtn.disabled = false;

  captureBtn.onclick = async () => {
    captureBtn.disabled = true;
    try {
      const frame = await captureStill((s) => (msg.textContent = s ? `hold your phone up… ${s}` : 'captured'));
      const stamp = timestamp();
      const saved = await saveToProject(frame, `still-${stamp}.png`);
      await run(frame);
      if (saved) {
        await saveToProject(sheet, `result-${stamp}.png`);
        msg.textContent += ` · saved captures/still-${stamp}.png and captures/result-${stamp}.png`;
      }
    } catch (err) {
      msg.textContent = `capture failed: ${(err as Error).message}`;
    }
    captureBtn.disabled = false;
  };
  fileInput.onchange = async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    const url = URL.createObjectURL(file);
    try {
      await run(await loadImage(url));
    } catch (err) {
      msg.textContent = `could not open that file as an image: ${(err as Error).message}`;
    }
    URL.revokeObjectURL(url);
  };
  saveBtn.onclick = () => void downloadPng(sheet, `device-remover_still_${timestamp()}.png`);

  const img = params.get('img');
  if (img) {
    try {
      await run(await loadImage(img));
    } catch (err) {
      msg.textContent = `could not run on ${img}: ${(err as Error).message}`;
    }
  }
}

void main();
