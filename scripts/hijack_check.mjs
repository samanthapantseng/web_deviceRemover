// Hijack mode, checked without a person or headphones: the installed Chrome, headless, a video
// file as the webcam, and the sound measured instead of heard.
//
//   npm run dev                                       # in another terminal
//   npm run check:hijack -- captures/clip_moving.y4m
//
// 1. Live, with the clip (which has a phone in it) as the webcam: no sound before a click; after
//    a click, how long until the phone is heard; each character's level and peak; silence again
//    after switching to remove mode; a screen recording in hijack mode has a sound track.
// 2. Live, with a picture without a phone: silence the whole time.
// 3. Each character rendered offline into captures/hijack_<character>.wav (15 s: breaking in at
//    the edge of the zone, the leak, moving into the centre, building up inside, moving, still,
//    pushed out), with measurements of each stage. These files are for listening.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const [clip = 'captures/clip_moving.y4m'] = process.argv.slice(2);
const base = process.env.BASE ?? 'http://localhost:5173/';
const chrome = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'captures');
mkdirSync(outDir, { recursive: true });
const downloads = mkdtempSync(join(tmpdir(), 'device-remover-hijack-dl-'));

const browser = await puppeteer.launch({
  executablePath: chrome,
  headless: true,
  userDataDir: mkdtempSync(join(tmpdir(), 'device-remover-hijack-')),
  args: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    `--use-file-for-fake-video-capture=${resolve(clip)}`,
    '--no-first-run',
    '--no-default-browser-check',
  ],
  defaultViewport: { width: 1280, height: 960 },
  acceptInsecureCerts: true,
});

const problems = [];
async function open(query) {
  const page = await browser.newPage();
  page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/VerifyEachNode|Rerunning with verbose/.test(m.text())) problems.push(m.text().slice(0, 300));
  });
  page.on('response', (r) => r.status() >= 400 && problems.push(`http ${r.status()} ${r.url()}`));
  await page.goto(`${base}?${query}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction('window.deviceRemover && window.deviceRemover.pipeline.stats.pipelineFps > 0', { timeout: 90_000 });
  return page;
}

/** dB of what is left when the low band is taken out of the total. */
const above = (total, low) => 10 * Math.log10(Math.max(1e-30, 10 ** (total / 10) - 10 ** (low / 10)));
const fmt = (db) => (Number.isFinite(db) ? +db.toFixed(1) : 'silent');

try {
  // ---- 1. Live, with the clip as the webcam ----
  const page = await open('mode=hijack&recordMax=3');
  const cdp = await page.createCDPSession();
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });
  const before = await page.evaluate(() => ({
    running: window.deviceRemover.sound.running,
    hint: !document.getElementById('sound').classList.contains('hidden'),
  }));
  await page.mouse.click(5, 5); // the "click for sound"
  const live = await page.evaluate(async () => {
    const dr = window.deviceRemover;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const db = () => dr.sound.engine.levels();
    dr.store.set('mirror', false);
    dr.store.set('hijackZone', 2); // the whole picture: the clip's phone is not always in the centre
    dr.store.set('hijackSound', 'auto');
    // A fresh start, as if the phone had just come into view.
    dr.pipeline.tracker.reset();
    dr.effect.reset();
    const t0 = performance.now();
    let heardAt = null;
    let focusAt = null;
    while (performance.now() - t0 < 6000) {
      await sleep(25);
      if (focusAt === null && dr.sound.engine?.focusKey) focusAt = performance.now() - t0;
      if (heardAt === null && db().rms > -50) heardAt = performance.now() - t0;
    }
    const rows = [];
    for (const c of ['drone', 'pulse', 'wash', 'plucks', 'beat']) {
      dr.store.set('hijackSound', c);
      await sleep(2500); // tuning in to the new character
      let sum = 0;
      let n = 0;
      let peak = -Infinity;
      const t = performance.now();
      while (performance.now() - t < 3000) {
        const l = db();
        if (Number.isFinite(l.rms)) sum += 10 ** (l.rms / 10);
        n++;
        peak = Math.max(peak, l.peak);
        await sleep(40);
      }
      rows.push({ character: c, 'rms dB': 10 * Math.log10(sum / n), 'peak dB': peak, mode: dr.effect.describe().replace(/^hijack · /, '') });
    }
    dr.store.set('hijackSound', 'auto');
    // Leaving hijack mode: silence.
    dr.store.set('mode', 'remove');
    const tOff = performance.now();
    let silentAt = null;
    while (performance.now() - tOff < 8000) {
      await sleep(50);
      if (db().peak === -Infinity || db().peak < -90) {
        silentAt = performance.now() - tOff;
        break;
      }
    }
    dr.store.set('mode', 'hijack');
    await sleep(3000);
    return { focusAt, heardAt, rows, silentAt, after: { running: dr.sound.running, hint: !document.getElementById('sound').classList.contains('hidden') } };
  });
  // Screen recording in hijack mode (stops by itself after 3 s, ?recordMax=3).
  await page.keyboard.press('v');
  await new Promise((r) => setTimeout(r, 6000));
  const files = readdirSync(downloads).filter((f) => /\.(mp4|webm)$/.test(f));
  let recording = 'no file';
  if (files.length) {
    const probe = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name', '-of', 'csv=p=0', join(downloads, files[0])]).toString();
    recording = `${files[0].replace(/^.*\./, '')}: ${probe.trim().split('\n').join(', ')}`;
  }
  await page.close();

  // ---- 2. Live, a picture without a phone ----
  const blank = await open('mode=hijack&src=captures/test_blank.png');
  await blank.mouse.click(5, 5);
  const empty = await blank.evaluate(async () => {
    const dr = window.deviceRemover;
    dr.store.set('hijackZone', 2);
    let loudest = -Infinity;
    const t = performance.now();
    while (performance.now() - t < 6000) {
      await new Promise((r) => setTimeout(r, 50));
      loudest = Math.max(loudest, dr.sound.engine?.levels().peak ?? -Infinity);
    }
    return { running: dr.sound.running, loudest, mode: dr.effect.describe() };
  });

  // ---- 3. Offline renders, for listening ----
  const renders = await blank.evaluate(async () => {
    const { SoundEngine, CEILING } = await import('/src/audio/engine.ts');
    const SECONDS = 15;
    const SR = 44100;
    const lerp = (a, b, x) => a + (b - a) * Math.min(1, Math.max(0, x));
    const out = [];
    for (const c of ['drone', 'pulse', 'wash', 'plucks', 'beat']) {
      const ctx = new OfflineAudioContext(2, SECONDS * SR, SR);
      const e = new SoundEngine(ctx, 0.5);
      // 0–3 s at the edge of the zone, on the left (0–0.8 s breaking in, then the leak);
      // 3–5 s moving into the centre; 5–9 s inside, building up; 9–11 s moving; 11–12 s still;
      // at 12 s pushed out.
      const params = (t) => ({
        pan: lerp(-0.6, 0, (t - 3) / 2),
        clarity: lerp(0.1, 1, (t - 3) / 2),
        closeness: 0.6,
        build: lerp(0, 1, (t - 5) / 4),
        activity: t >= 9 && t < 11 ? 0.9 : 0,
      });
      e.focus('render', c, 12345, params(0), 37.3, 0); // joined 37.3 s into their sound
      for (let t = 0.05; t < SECONDS; t += 0.05) {
        if (t < 12) e.update(params(t), t);
        else if (t - 0.05 < 12) e.release(12);
        e.scheduleUntil(t + 0.3);
      }
      const buf = await ctx.startRendering();
      const L = buf.getChannelData(0);
      const R = buf.getChannelData(1);
      const stat = (from, to) => {
        let s = 0;
        let p = 0;
        for (let i = Math.floor(from * SR); i < Math.floor(to * SR); i++) {
          s += (L[i] * L[i] + R[i] * R[i]) / 2;
          p = Math.max(p, Math.abs(L[i]), Math.abs(R[i]));
        }
        const n = Math.floor(to * SR) - Math.floor(from * SR);
        return { rms: 10 * Math.log10(s / n || 1e-30), peak: 20 * Math.log10(p || 1e-15) };
      };
      // Left minus right, dB (positive: heard on the left).
      const balance = (from, to) => {
        let l = 0;
        let r = 0;
        for (let i = Math.floor(from * SR); i < Math.floor(to * SR); i++) {
          l += L[i] * L[i];
          r += R[i] * R[i];
        }
        return 10 * Math.log10((l || 1e-30) / (r || 1e-30));
      };
      // Energy below about 200 Hz, dB RMS (two one-pole low-passes).
      const a = Math.exp((-2 * Math.PI * 200) / SR);
      const low = new Float32Array(L.length);
      let y1 = 0;
      let y2 = 0;
      for (let i = 0; i < L.length; i++) {
        y1 = (1 - a) * ((L[i] + R[i]) / 2) + a * y1;
        y2 = (1 - a) * y1 + a * y2;
        low[i] = y2;
      }
      const lowRms = (from, to) => {
        let s = 0;
        const i0 = Math.floor(from * SR);
        const i1 = Math.floor(to * SR);
        for (let i = i0; i < i1; i++) s += low[i] * low[i];
        return 10 * Math.log10(s / (i1 - i0) || 1e-30);
      };
      // 16-bit stereo WAV.
      const n = L.length;
      const wav = new DataView(new ArrayBuffer(44 + n * 4));
      const str = (o, s) => [...s].forEach((ch, i) => wav.setUint8(o + i, ch.charCodeAt(0)));
      str(0, 'RIFF');
      wav.setUint32(4, 36 + n * 4, true);
      str(8, 'WAVEfmt ');
      wav.setUint32(16, 16, true);
      wav.setUint16(20, 1, true);
      wav.setUint16(22, 2, true);
      wav.setUint32(24, SR, true);
      wav.setUint32(28, SR * 4, true);
      wav.setUint16(32, 4, true);
      wav.setUint16(34, 16, true);
      str(36, 'data');
      wav.setUint32(40, n * 4, true);
      for (let i = 0; i < n; i++) {
        wav.setInt16(44 + i * 4, Math.max(-1, Math.min(1, L[i])) * 32767, true);
        wav.setInt16(46 + i * 4, Math.max(-1, Math.min(1, R[i])) * 32767, true);
      }
      let bin = '';
      const bytes = new Uint8Array(wav.buffer);
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      out.push({
        character: c,
        rumbleIn: lowRms(0.3, 0.78),
        rumbleSealed: lowRms(0.9, 1.6),
        edge: { ...stat(1.2, 2.9), balance: balance(1.2, 2.9), low: lowRms(1.2, 2.9) },
        inside: { ...stat(5.5, 9), balance: balance(5.5, 9), low: lowRms(5.5, 9) },
        // Above ~200 Hz, so the rumble coming back does not count.
        beforeDoor: stat(11.5, 12).rms,
        beforeDoorLow: lowRms(11.5, 12),
        behindDoor: stat(12.1, 12.3).rms,
        behindDoorLow: lowRms(12.1, 12.3),
        all: stat(0, SECONDS),
        end: stat(14.5, 15),
        ceiling: 20 * Math.log10(CEILING),
        wav: btoa(bin),
      });
    }
    return out;
  });
  await blank.close();
  for (const r of renders) writeFileSync(join(outDir, `hijack_${r.character}.wav`), Buffer.from(r.wav, 'base64'));

  // ---- Report ----
  console.log(`before any click: sound running ${before.running}, hint shown ${before.hint} (headless Chrome may allow sound without a click; the real browser does not)`);
  console.log(`after the click, from a fresh start: in focus after ${fmt(live.focusAt)} ms, heard (above -50 dB) after ${fmt(live.heardAt)} ms`);
  console.table(live.rows.map((r) => ({ ...r, 'rms dB': fmt(r['rms dB']), 'peak dB': fmt(r['peak dB']) })));
  console.log(`switched to remove mode: silent after ${live.silentAt === null ? 'NOT within 8 s' : `${Math.round(live.silentAt)} ms`}; back in hijack: running ${live.after.running}, hint shown ${live.after.hint}`);
  console.log(`screen recording in hijack mode: ${recording}`);
  console.log(`picture without a phone, 6 s: loudest peak ${fmt(empty.loudest)} dB · ${empty.mode}`);
  console.log('offline renders (15 s each), dB. Bass: energy below ~200 Hz; L−R: positive = heard on the left (the phone is on the left at the edge):');
  console.table(
    renders.map((r) => ({
      character: r.character,
      'rumble breaking in': fmt(r.rumbleIn),
      'bass sealed (leak)': fmt(r.rumbleSealed),
      'edge rms': fmt(r.edge.rms),
      'edge bass': fmt(r.edge.low),
      'edge L−R': fmt(r.edge.balance),
      'inside rms': fmt(r.inside.rms),
      'inside bass': fmt(r.inside.low),
      'inside L−R': fmt(r.inside.balance),
      'door drop (>200 Hz)': fmt(above(r.behindDoor, r.behindDoorLow) - above(r.beforeDoor, r.beforeDoorLow)),
      'peak (all)': fmt(r.all.peak),
      'last 0.5 s peak': fmt(r.end.peak),
    })),
  );
  console.log(`ceiling ${fmt(renders[0].ceiling)} dB`);
  console.log(problems.length ? `problems:\n  ${problems.join('\n  ')}` : 'no console errors');
  console.log(`wrote ${renders.map((r) => `captures/hijack_${r.character}.wav`).join(', ')}`);
  process.exitCode = problems.length ? 1 : 0;
} finally {
  await browser.close();
}
