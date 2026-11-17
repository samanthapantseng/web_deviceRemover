// Runs the live view in the installed Google Chrome (headless, throw-away profile) with a video
// file standing in for the webcam, and prints timings for every fill mode. No real camera, no
// person needed, so it can be re-run after every change.
//
//   bash scripts/make_test_clip.sh captures/some_photo.png        # once: writes captures/clip_*.y4m
//   npm run dev                                                   # in another terminal
//   npm run check -- captures/clip_moving.y4m
//   npm run check -- captures/clip_moving.y4m "backend=wasm"      # extra URL parameters
//   BASE=http://localhost:4173/ npm run check -- captures/clip_moving.y4m   # against `npm run preview`
//   BASE=https://localhost:8443/ npm run check -- captures/clip_moving.y4m  # against `npm run dev:ipad`
//
// Also writes captures/check_sheet.jpg (8 consecutive views, MI-GAN) and captures/check_before_after.jpg.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const [clip, query = ''] = process.argv.slice(2);
if (!clip) {
  console.error('usage: node scripts/headless_check.mjs <clip.y4m> [url query]');
  process.exit(1);
}
const base = process.env.BASE ?? 'http://localhost:5173/';
const chrome = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'captures');
mkdirSync(outDir, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: chrome,
  headless: true,
  userDataDir: mkdtempSync(join(tmpdir(), 'device-remover-check-')),
  args: [
    '--use-fake-ui-for-media-stream', // auto-accept the camera prompt (this profile only)
    '--use-fake-device-for-media-stream',
    `--use-file-for-fake-video-capture=${resolve(clip)}`,
    '--no-first-run',
    '--no-default-browser-check',
  ],
  defaultViewport: { width: 1280, height: 960 },
  // The iPad server's certificate is only trusted by devices that installed its CA; this
  // throw-away browser profile has not.
  acceptInsecureCerts: true,
});

try {
  const page = await browser.newPage();
  const problems = [];
  page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/VerifyEachNode|Rerunning with verbose/.test(m.text())) problems.push(m.text().slice(0, 300));
  });
  page.on('response', (r) => r.status() >= 400 && problems.push(`http ${r.status()} ${r.url()}`));

  await page.goto(`${base}?${query}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction('window.deviceRemover', { timeout: 90_000 });

  const result = await page.evaluate(async () => {
    const dr = window.deviceRemover;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const view = document.getElementById('view');
    const W = view.width;
    const H = view.height;
    dr.store.set('mirror', false);
    const rows = [];
    for (const fill of ['migan', 'telea', 'stylised']) {
      dr.store.set('fill', fill);
      await sleep(6000);
      const s = dr.pipeline.stats;
      rows.push({
        fill: dr.effect.describe(),
        'display fps': Math.round(dr.displayFps()),
        'fill fps': +s.pipelineFps.toFixed(1),
        'detect ms': +s.detectMs.toFixed(1),
        'mask ms': +s.maskMs.toFixed(2),
        'inpaint ms': +s.effectMs.toFixed(1),
        phones: s.phones,
        score: +s.bestScore.toFixed(2),
      });
    }
    dr.store.set('fill', 'migan');
    await sleep(2500);
    const sheet = document.createElement('canvas');
    sheet.width = W * 4;
    sheet.height = H * 2;
    const sc = sheet.getContext('2d');
    for (let i = 0; i < 8; i++) {
      sc.drawImage(view, (i % 4) * W, Math.floor(i / 4) * H);
      await sleep(150);
    }
    const snap = await dr.pipeline.snapshot();
    const pair = document.createElement('canvas');
    pair.width = W * 2;
    pair.height = H;
    pair.getContext('2d').drawImage(snap.before, 0, 0);
    pair.getContext('2d').drawImage(snap.after, W, 0);
    return {
      browser: navigator.userAgent.replace(/.*((?:Headless)?Chrome\/[\d.]+).*/, '$1'),
      frame: `${W}×${H}`,
      detector: dr.detector.backend,
      rows,
      sheet: sheet.toDataURL('image/jpeg', 0.88),
      pair: pair.toDataURL('image/jpeg', 0.92),
    };
  });

  const save = (name, dataUrl) => writeFileSync(join(outDir, name), Buffer.from(dataUrl.split(',')[1], 'base64'));
  save('check_sheet.jpg', result.sheet);
  save('check_before_after.jpg', result.pair);
  console.log(`${result.browser} · frame ${result.frame} · detector on ${result.detector}`);
  console.table(result.rows);
  console.log(problems.length ? `problems:\n  ${problems.join('\n  ')}` : 'no console errors');
  console.log('wrote captures/check_sheet.jpg and captures/check_before_after.jpg');
  process.exitCode = problems.length ? 1 : 0;
} finally {
  await browser.close();
}
