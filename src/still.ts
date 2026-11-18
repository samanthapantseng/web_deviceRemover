// Still-image test page: the same modules as the live view, run on a single frame.
//   still.html                      capture from the webcam or open a file
//   still.html?img=captures/x.png   run on an image straight away
//   &model=yolo11s-seg &conf=0.2    override the detector / threshold
//   &cropSize=400 &dilate=8 ...     override any numeric setting
//   &save=name                      (dev server only) also write the result sheet to captures/name.png
//   &camera=back                    capture from an iPad's rear camera
//   &top=0                          turn off the top-category check (compare with &top=1)
//   &detectOnly                     skip the fills and grow (fast; used by scripts/stills_report.mjs)
//   &growMax=3                      size of the two grow tiles (any numeric setting, as above)
import './style.css';
import { captureStill, loadImage } from './camera';
import { YoloSegDetector } from './detect/yoloSeg';
import { report as sendReport, startReporting } from './devReport';
import { GrowEffect } from './effects/grow';
import { RemoveEffect } from './effects/remove';
import type { EffectFrame, PickedPhone } from './effects/types';
import { FillSet } from './fill';
import { AlphaCanvas } from './mask/alphaCanvas';
import { MaskStabilizer } from './mask/stabilizer';
import { SettingsStore, type DetectorModel, type FillId, type Settings, type StyleVariant } from './settings';
import { downloadPng, timestamp, toPngBlob } from './snapshot';
import { makeCanvas } from './types';

startReporting();

const params = new URLSearchParams(location.search);
const base = new SettingsStore().value;
const settings: Settings = {
  ...base,
  camera: params.get('camera') === 'back' ? 'back' : params.get('camera') === 'front' ? 'front' : base.camera,
  detector: (params.get('model') as DetectorModel | null) ?? base.detector,
  confidence: Number(params.get('conf') ?? base.confidence),
  topClassOnly: params.has('top') ? params.get('top') !== '0' : base.topClassOnly,
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
const labelInput = $<HTMLInputElement>('label');

/** "Blue notebook!" → "blue-notebook", for file names. */
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30);

const detector = new YoloSegDetector();
const fills = new FillSet();

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[xs.length >> 1];
const RUNS = 5;
const detectOnly = params.has('detectOnly');

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
  const opts = { conf: settings.confidence, topClassOnly: settings.topClassOnly };
  let det = await detector.detect(frame, width, height, opts);
  const pre: number[] = [];
  const infer: number[] = [];
  const post: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    det = await detector.detect(frame, width, height, opts);
    pre.push(det.preMs);
    infer.push(det.inferMs);
    post.push(det.postMs);
  }
  const boxes = det.boxes.map((b) => ({ ...b }));
  const phones: PickedPhone[] = boxes.map((b, i) => ({ ...b, id: i + 1, erasedMs: 0 }));
  const rejected = det.rejected.map((r) => ({ ...r }));
  // One line on what the detector made of this frame.
  const verdict = [
    ...boxes.map((b) => `PHONE ${b.score.toFixed(2)} (next best: ${b.next.name} ${b.next.score.toFixed(2)})`),
    ...rejected.map((r) => `not a phone: ${r.top.name} ${r.top.score.toFixed(2)} beats phone ${r.score.toFixed(2)}`),
  ].join(' · ') || 'nothing phone-like';

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
      ctx.fillText(`phone ${b.score.toFixed(2)}`, b.x1, b.y1 - 4);
    }
    // Look-alikes the top-category check turned away, in cyan.
    ctx.strokeStyle = '#00e5ff';
    ctx.fillStyle = '#00e5ff';
    ctx.setLineDash([4, 4]);
    for (const r of rejected) {
      ctx.strokeRect(r.x1, r.y1, r.x2 - r.x1, r.y2 - r.y1);
      ctx.fillText(`${r.top.name} ${r.top.score.toFixed(2)} > phone ${r.score.toFixed(2)}`, r.x1, r.y2 + 14);
    }
    ctx.setLineDash([]);
    tiles.push({ label: `mask (${boxes.length} phone${boxes.length === 1 ? '' : 's'})`, canvas });
  }

  const variants: { fill: FillId; style?: StyleVariant; label: string }[] = [
    { fill: 'migan', label: 'MI-GAN' },
    { fill: 'telea', label: 'Telea' },
    { fill: 'stylised', style: 'blur', label: 'stylised: blur' },
    { fill: 'stylised', style: 'flat', label: 'stylised: flat' },
    { fill: 'stylised', style: 'void', label: 'stylised: void' },
  ];
  for (const v of detectOnly ? [] : variants) {
    const s: Settings = { ...settings, fill: v.fill, style: v.style ?? settings.style };
    const f: EffectFrame = { frame, width, height, mask, maskCanvas: alphaCanvas.canvas, phoneAlpha: null, personAlpha: null, phones, settings: s };
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

  // Grow mode, fully grown: mask + hand, mask with finger gaps filled, the exact mask, and the other shapes.
  if (!detectOnly && boxes.length) {
    // One more detection, with the anti-aliased mask grow mode asks for (kept out of the timings above).
    const extra = await detector.detect(frame, width, height, { ...opts, soft: true, person: true });
    const soft = extra.soft;
    const personAlpha = extra.person;
    const kinds = [
      { label: `grow mask + hand ${Math.round(settings.growReach * 100)} %`, shape: 'hand', fill: settings.growFill },
      { label: `grow mask, gaps ${Math.round(settings.growFill * 100)} %`, shape: 'mask', fill: settings.growFill },
      { label: 'grow exact mask', shape: 'mask', fill: 0 },
      { label: 'grow hull', shape: 'hull', fill: 0 },
      { label: 'grow rectangle', shape: 'rectangle', fill: 0 },
    ] as const;
    for (const { label, shape, fill } of kinds) {
      const size = settings.growMax;
      const grown = phones.map((p) => ({ ...p, erasedMs: settings.growSeconds * 1000 }));
      const s: Settings = { ...settings, growShape: shape, growFill: fill };
      const f: EffectFrame = { frame, width, height, mask, maskCanvas: alphaCanvas.canvas, phoneAlpha: soft, personAlpha, phones: grown, settings: s };
      // A new effect (not reset()), so the phone counts as picked long ago, not just now.
      const grow = new GrowEffect(width, height);
      grow.onMask(f);
      const t = performance.now();
      await grow.process(f);
      const cutMs = performance.now() - t;
      const { canvas, ctx } = makeCanvas(width, height);
      ctx.drawImage(frame, 0, 0);
      grow.render(ctx, true);
      tiles.push({ label: `${label} ${size}× · ${cutMs.toFixed(1)} ms`, canvas });
      lines.push(`${label.padEnd(20)} ${`${cutMs.toFixed(1)} ms`.padStart(9)}`);
    }
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
    topClassOnly: settings.topClassOnly,
    verdict,
    phones: boxes.map((b) => ({
      score: +b.score.toFixed(3),
      next: `${b.next.name} ${b.next.score.toFixed(3)}`,
      box: [b.x1, b.y1, b.x2, b.y2].map(Math.round),
    })),
    rejected: rejected.map((r) => ({
      phone: +r.score.toFixed(3),
      top: `${r.top.name} ${r.top.score.toFixed(3)}`,
      box: [r.x1, r.y1, r.x2, r.y2].map(Math.round),
    })),
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
  sendReport('still', { summary: { ...summary, fills: lines } });
  msg.textContent = verdict;
  saveBtn.disabled = false;

  const save = params.get('save');
  if (save) await saveToProject(sheet, `${save}.png`);
}

async function main(): Promise<void> {
  try {
    await detector.init(settings.detector, (f) => (msg.textContent = `loading detector… ${Math.round(f * 100)}%`));
    msg.textContent = 'loading fill models…';
    if (!detectOnly) await fills.load();
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
      const frame = await captureStill((s) => (msg.textContent = s ? `hold your phone up… ${s}` : 'captured'), 3, settings.camera);
      const label = slug(labelInput.value);
      const name = `${timestamp()}${label ? `-${label}` : ''}`;
      const saved = await saveToProject(frame, `still-${name}.png`);
      await run(frame);
      if (saved) {
        await saveToProject(sheet, `result-${name}.png`);
        msg.textContent += ` · saved captures/still-${name}.png`;
      }
    } catch (err) {
      msg.textContent = `capture failed: ${(err as Error).message}`;
      console.error('[still] capture failed', err);
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
