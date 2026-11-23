// Hijack mode, checked without a person or headphones: the installed Chrome, headless, a video
// file as the webcam, and the sound measured instead of heard.
//
//   npm run dev                                       # in another terminal
//   npm run check:hijack -- captures/clip_moving.y4m
//
// 1. Live, with the clip (which has a phone in it) as the webcam: no sound before a click; after
//    a click, how long until the phone is heard; each conversation's level, how much of the time
//    someone is speaking, and what writing it costs; silence again after switching to remove
//    mode; a screen recording in hijack mode has a sound track.
// 2. Live, with a picture without a phone: silence the whole time.
// 3. Each conversation rendered offline into captures/hijack_<scene>.wav (28 s: breaking in at the
//    edge of the zone on the left, overheard there, moving into the centre from 12 s, inside from
//    14 s, pushed out at 24 s), with measurements of each stage. These files are for listening.
//    On macOS, its sound classifier says what it hears in them (scripts/ears.swift).
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
    dr.store.set('hijackScene', 'auto');
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
    for (const c of ['comfort', 'catchup', 'argument', 'voicenote', 'secret']) {
      dr.store.set('hijackScene', c);
      await sleep(2500); // breaking in
      let sum = 0;
      let heard = 0;
      let n = 0;
      let peak = -Infinity;
      let slowest = 0; // longest time between two display frames: does writing turns hold up the picture?
      let last = performance.now();
      let watching = true;
      const watch = () => {
        const now = performance.now();
        slowest = Math.max(slowest, now - last);
        last = now;
        if (watching) requestAnimationFrame(watch);
      };
      requestAnimationFrame(watch);
      const t = performance.now();
      while (performance.now() - t < 9000) {
        const l = db();
        if (l.rms > -45) {
          heard++;
          sum += 10 ** (l.rms / 10);
        }
        n++;
        peak = Math.max(peak, l.peak);
        await sleep(40);
      }
      watching = false;
      rows.push({ conversation: c, 'speaking %': Math.round((100 * heard) / n), 'rms dB (speaking)': 10 * Math.log10(sum / Math.max(1, heard)), 'peak dB': peak, 'slowest frame ms': Math.round(slowest), 'pipeline fps': Math.round(dr.pipeline.stats.pipelineFps), mode: dr.effect.describe().replace(/^hijack · /, '') });
    }
    dr.store.set('hijackScene', 'auto');
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
    const SECONDS = 28;
    const SR = 48000;
    const lerp = (a, b, x) => a + (b - a) * Math.min(1, Math.max(0, x));
    const out = [];
    for (const c of ['comfort', 'catchup', 'argument', 'voicenote', 'secret']) {
      const ctx = new OfflineAudioContext(2, SECONDS * SR, SR);
      const e = new SoundEngine(ctx, 0.5);
      const params = (t) => ({
        pan: -0.6,
        clarity: lerp(0.05, 1, (t - 12) / 2),
        closeness: 0.6,
        build: 0.1,
        activity: 0,
      });
      const t0 = performance.now();
      e.focus('render', c, 12345, params(0), 37.3, 0); // joined 37.3 s into it
      for (let t = 0.05; t < SECONDS; t += 0.05) {
        if (t < 24) e.update(params(t), t);
        else if (t - 0.05 < 24) e.release(24);
        e.scheduleUntil(t + 0.3);
      }
      const writeMs = performance.now() - t0;
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
      // Someone speaking: 50 ms windows within 25 dB of the loudest in that stretch.
      const speaking = (from, to) => {
        const w = Math.round(0.05 * SR);
        const e2 = [];
        for (let i = Math.floor(from * SR); i + w < Math.floor(to * SR); i += w) {
          let s = 0;
          for (let k = 0; k < w; k++) s += L[i + k] * L[i + k] + R[i + k] * R[i + k];
          e2.push(s);
        }
        const top = Math.max(...e2);
        return (100 * e2.filter((v) => v > top * 10 ** -2.5).length) / e2.length;
      };
      // Energy above about 2 kHz relative to all, dB (one-pole, twice): how open it sounds.
      const a = Math.exp((-2 * Math.PI * 2000) / SR);
      const top = (from, to) => {
        let y1 = 0;
        let y2 = 0;
        let s = 0;
        let all = 0;
        for (let i = Math.floor(from * SR); i < Math.floor(to * SR); i++) {
          const x = (L[i] + R[i]) / 2;
          y1 = (1 - a) * x + a * y1;
          y2 = (1 - a) * (x - y1) + a * y2;
          const h = x - y1 - y2;
          s += h * h;
          all += x * x;
        }
        return 10 * Math.log10((s || 1e-30) / (all || 1e-30));
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
        scene: c,
        edge: { ...stat(1.2, 12), balance: balance(1.2, 12), speaking: speaking(1.2, 12), top: top(1.2, 12) },
        inside: { ...stat(14.5, 24), balance: balance(14.5, 24), speaking: speaking(14.5, 24), top: top(14.5, 24) },
        all: stat(0, SECONDS),
        end: stat(27.5, 28),
        writeMs,
        ceiling: 20 * Math.log10(CEILING),
        wav: btoa(bin),
      });
    }
    return out;
  });
  await blank.close();
  for (const r of renders) writeFileSync(join(outDir, `hijack_${r.scene}.wav`), Buffer.from(r.wav, 'base64'));

  // ---- Report ----
  console.log(`before any click: sound running ${before.running}, hint shown ${before.hint} (headless Chrome may allow sound without a click; the real browser does not)`);
  console.log(`after the click, from a fresh start: in focus after ${fmt(live.focusAt)} ms, heard (above -50 dB) after ${fmt(live.heardAt)} ms`);
  console.table(live.rows.map((r) => ({ ...r, 'rms dB (speaking)': fmt(r['rms dB (speaking)']), 'peak dB': fmt(r['peak dB']) })));
  console.log(`switched to remove mode: silent after ${live.silentAt === null ? 'NOT within 8 s' : `${Math.round(live.silentAt)} ms`}; back in hijack: running ${live.after.running}, hint shown ${live.after.hint}`);
  console.log(`screen recording in hijack mode: ${recording}`);
  console.log(`picture without a phone, 6 s: loudest peak ${fmt(empty.loudest)} dB · ${empty.mode}`);
  console.log('offline renders (28 s each). L−R: positive = heard on the left, where the phone is. Top: share above 2 kHz, dB:');
  console.table(
    renders.map((r) => ({
      conversation: r.scene,
      'edge rms': fmt(r.edge.rms),
      'edge speaking %': Math.round(r.edge.speaking),
      'edge L−R': fmt(r.edge.balance),
      'edge top': fmt(r.edge.top),
      'inside rms': fmt(r.inside.rms),
      'inside speaking %': Math.round(r.inside.speaking),
      'inside L−R': fmt(r.inside.balance),
      'inside top': fmt(r.inside.top),
      'peak (all)': fmt(r.all.peak),
      'last 0.5 s peak': fmt(r.end.peak),
      'written in ms': Math.round(r.writeMs),
    })),
  );
  console.log(`ceiling ${fmt(renders[0].ceiling)} dB`);
  // What macOS hears: in the overheard part, and inside.
  if (process.platform === 'darwin') {
    const dir = mkdtempSync(join(tmpdir(), 'device-remover-ears-'));
    const parts = [];
    for (const r of renders) {
      const file = join(outDir, `hijack_${r.scene}.wav`);
      for (const [part, from, seconds] of [['edge', 1.2, 10.8], ['inside', 14.5, 9.5]]) {
        const cut = join(dir, `${r.scene}_${part}.wav`);
        execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-ss', String(from), '-t', String(seconds), '-i', file, '-af', 'volume=8dB', cut]);
        parts.push(cut);
      }
    }
    try {
      const ears = join(dir, 'ears');
      execFileSync('swiftc', ['-O', join(dirname(fileURLToPath(import.meta.url)), 'ears.swift'), '-o', ears]);
      console.log("what macOS's sound classifier hears (real speech: speech 0.99):");
      console.log(execFileSync(ears, parts).toString().trim());
    } catch (err) {
      console.log(`sound classifier not available: ${String(err.message).split('\n')[0]}`);
    }
  }
  console.log(problems.length ? `problems:\n  ${problems.join('\n  ')}` : 'no console errors');
  console.log(`wrote ${renders.map((r) => `captures/hijack_${r.scene}.wav`).join(', ')}`);
  process.exitCode = problems.length ? 1 : 0;
} finally {
  await browser.close();
}
