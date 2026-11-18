import type { Snapshot } from './pipeline';

/** Before | after, side by side, as one canvas. */
export function sideBySide(snap: Snapshot): HTMLCanvasElement {
  const { before, after } = snap;
  const canvas = document.createElement('canvas');
  canvas.width = before.width + after.width;
  canvas.height = before.height;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(before, 0, 0);
  ctx.drawImage(after, before.width, 0);
  return canvas;
}

/** A left-right flipped copy of a canvas. */
export function mirrored(src: HTMLCanvasElement): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = src.width;
  canvas.height = src.height;
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(-1, 0, 0, 1, src.width, 0);
  ctx.drawImage(src, 0, 0);
  return canvas;
}

export function timestamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function toPngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG encoding failed'))), 'image/png'),
  );
}

/** Saves through the browser's normal download path: the image never leaves the machine. */
export async function downloadPng(canvas: HTMLCanvasElement, name: string): Promise<void> {
  downloadBlob(await toPngBlob(canvas), name);
}

export function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
