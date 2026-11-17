// What the detector makes of each still image, with the top-category check on and off.
// Runs the still test page in the installed Chrome (headless) against the dev server.
//
//   npm run dev                                      # in another terminal
//   npm run stills                                   # every captures/still-*.png
//   npm run stills -- captures/a.png captures/b.png  # just these
//   MODEL=yolo11s-seg-320 npm run stills             # another detector
//
// Label your captures (the text field on still.html) so the table says what each one shows.
import { readdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import puppeteer from 'puppeteer-core';

const base = process.env.BASE ?? 'http://localhost:5173/';
const chrome = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const model = process.env.MODEL ? `&model=${process.env.MODEL}` : '';
let files = process.argv.slice(2);
if (!files.length) {
  files = readdirSync('captures')
    .filter((f) => /^still-.*\.png$/.test(f))
    .sort()
    .map((f) => join('captures', f));
}
if (!files.length) {
  console.error('No captures/still-*.png yet: capture some on still.html first.');
  process.exit(1);
}

const browser = await puppeteer.launch({
  executablePath: chrome,
  headless: true,
  userDataDir: mkdtempSync(join(tmpdir(), 'device-remover-stills-')),
  acceptInsecureCerts: true,
});
const page = await browser.newPage();
const run = async (file, top) => {
  await page.goto(`${base}still.html?img=${encodeURIComponent(file)}&top=${top}&detectOnly${model}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction('window.stillReport', { timeout: 60_000 });
  return page.evaluate(() => window.stillReport);
};

const rows = [];
let threshold = '?';
try {
  for (const file of files) {
    const on = await run(file, 1);
    const off = await run(file, 0);
    threshold = on.confidence;
    const label = basename(file, '.png').replace(/^still-\d{8}-\d{6}-?/, '') || '(no label)';
    const phones = (r) => r.phones.map((p) => p.score.toFixed(2)).join(', ') || '–';
    rows.push({
      image: label,
      'phone without check': phones(off),
      'phone with check': phones(on),
      'turned away (what it really thinks)': on.rejected.map((r) => `${r.top} > phone ${r.phone.toFixed(2)}`).join('; ') || '–',
      'next best for phones': on.phones.map((p) => p.next).join('; ') || '–',
    });
  }
} finally {
  await browser.close();
}
console.log(`detector ${model ? process.env.MODEL : 'yolo11s-seg (default)'} · threshold ${threshold}`);
console.table(rows);
