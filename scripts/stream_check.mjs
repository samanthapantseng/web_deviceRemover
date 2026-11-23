// Streaming mode, tested on this Mac without an iPad. Two separate headless Chrome instances,
// like two devices: one plays the iPad (a video file as its camera, an iPad user agent and touch,
// on /stream.html?latency), the other the Mac (/?source=stream). Prints speed and round-trip
// latency per fill mode, and how long the picture takes to come back after each interruption.
// Then hijack mode, switched on with the iPad's own controls: the sound has to play on the iPad
// page (measured, not heard) and not on the Mac's, and come back after interruptions.
//
//   npm run dev:ipad                                                   # in another terminal
//   npm run check:stream -- captures/clip_moving.y4m
//   npm run check:stream -- captures/clip_moving.y4m --minutes 30      # then a soak test
//   npm run check:stream -- captures/clip_moving.y4m --no-recovery     # skip the interruptions
//   npm run check:stream -- captures/clip_moving.y4m --hijack-only     # only hijack mode and its sound
//   BASE=https://localhost:8444/ npm run check:stream -- ...           # another server
//
// Writes captures/stream_sheet.jpg: what the "iPad" sent (left) and got back (right), 4 frames, and
// captures/stream_grow_sheet.jpg: the same in grow mode, switched on with the iPad's own controls.
// Both pages run on this Mac, so this says nothing about Wi-Fi; that needs the real iPad.
//
// Codec: the pages prefer H.264, but in headless Chrome the fake camera stops delivering frames
// once its first H.264 connection starts (a quirk of the test set-up: Safari on the iPad sends
// H.264 by default). So this check asks for VP8 (?codec=vp8 on the iPad page; the Mac follows
// the offer). CODEC=h264 npm run check:stream -- ... tries H.264 anyway.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const args = process.argv.slice(2);
const clip = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--minutes');
const minutes = args.includes('--minutes') ? Number(args[args.indexOf('--minutes') + 1]) || 0 : 0;
const hijackOnly = args.includes('--hijack-only');
const recovery = !args.includes('--no-recovery') && !hijackOnly;
if (!clip) {
  console.error('usage: node scripts/stream_check.mjs <clip.y4m> [--minutes N] [--no-recovery]');
  process.exit(1);
}
const base = process.env.BASE ?? 'https://localhost:8443/';
const codec = `&codec=${process.env.CODEC ?? 'vp8'}`;
const chrome = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'captures');
mkdirSync(outDir, { recursive: true });
// iPadOS Safari presents itself as a Mac; the touch screen gives it away (as in devReport.ts).
const IPAD_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6 Safari/605.1.15';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const problems = [];
const common = ['--no-first-run', '--no-default-browser-check', '--autoplay-policy=no-user-gesture-required'];

function watch(page, who) {
  page.on('pageerror', (e) => problems.push(`${who} page error: ${e.message}`));
  page.on('console', (m) => {
    const t = m.text();
    if (m.type() !== 'error') return;
    // onnxruntime noise, and the 409 a page gets while the other one is away (expected here).
    if (/VerifyEachNode|Rerunning with verbose|status of 409/.test(t)) return;
    problems.push(`${who}: ${t.slice(0, 300)}`);
  });
  page.on('response', (r) => r.status() >= 400 && !(r.status() === 409 && r.url().includes('__signal')) && problems.push(`${who} http ${r.status()} ${r.url()}`));
  return page;
}

const launch = (extra, viewport) =>
  puppeteer.launch({
    executablePath: chrome,
    headless: true,
    userDataDir: mkdtempSync(join(tmpdir(), 'device-remover-stream-')),
    args: [...common, ...extra],
    defaultViewport: viewport,
    // The dev server's certificate is only trusted by devices that installed its CA.
    acceptInsecureCerts: true,
  });

const ipadBrowser = await launch(
  ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${resolve(clip)}`],
  { width: 1024, height: 1366, hasTouch: true },
);
const macBrowser = await launch([], { width: 1280, height: 960 });

async function openMac() {
  const page = watch(await macBrowser.newPage(), 'Mac');
  await page.goto(`${base}?source=stream&fill=migan`, { waitUntil: 'domcontentloaded' });
  return page;
}

async function openIpad() {
  const page = watch(await ipadBrowser.newPage(), 'iPad');
  await page.setUserAgent(IPAD_UA);
  await page.goto(`${base}stream.html?latency${codec}`, { waitUntil: 'domcontentloaded' });
  return page;
}

/** ms from `since` until fn (evaluated in the page) is true. */
async function until(page, fn, arg, since = Date.now(), timeout = 90_000) {
  await page.waitForFunction(fn, { timeout, polling: 100 }, arg);
  return Date.now() - since;
}

const ipadState = (page) =>
  page.evaluate(() => {
    const sp = window.streamPage;
    const s = sp.stats();
    return { shownFps: s.shownFps, latency: sp.latency(), unreadable: sp.unreadable(), connections: sp.connections(), link: s };
  });
const macState = (page) =>
  page.evaluate(() => {
    const st = window.deviceRemover.pipeline.stats;
    return {
      fill: window.deviceRemover.effect.describe(),
      fillFps: st.pipelineFps,
      detectMs: st.detectMs,
      inpaintMs: st.effectMs,
      phones: st.phones,
      link: window.deviceRemoverStream.link(),
      heapMB: performance.memory ? performance.memory.usedJSHeapSize / 2 ** 20 : null,
    };
  });
const r0 = (v) => (typeof v === 'number' ? Math.round(v) : '–');
const r1 = (v) => (typeof v === 'number' ? +v.toFixed(1) : '–');

let exitCode = 0;
try {
  // 1. Start: Mac page first (it waits), then the iPad.
  let mac = await openMac();
  const t0 = Date.now();
  let ipad = await openIpad();
  const firstPicture = await until(ipad, () => window.streamPage?.framesShown() > 0, undefined, t0);
  await until(mac, () => !!window.deviceRemover);
  const first = await ipadState(ipad);
  console.log(`first picture on the "iPad" ${firstPicture} ms after opening it (includes loading the detector on the Mac)`);
  console.log(`route ${first.link.route} · codec ${first.link.codec}`);

  // 2. Each fill mode: Mac speed, what the iPad shows, round trip.
  //    Then grow mode, switched on with the iPad's mode slider.
  const rows = [];
  for (const fill of hijackOnly ? [] : ['migan', 'telea', 'stylised', 'grow']) {
    if (fill === 'grow') {
      await tapMode('grow');
      await sleep(4000); // it has grown to full size by the time it is measured
    } else await mac.evaluate((f) => window.deviceRemover.store.set('fill', f), fill);
    await sleep(2500);
    await ipad.evaluate(() => window.streamPage.resetLatency());
    await sleep(6000);
    const [i, m] = [await ipadState(ipad), await macState(mac)];
    rows.push({
      fill: m.fill,
      'iPad shows fps': r0(i.shownFps),
      'fill fps': r1(m.fillFps),
      'detect ms': r1(m.detectMs),
      'inpaint ms': r1(m.inpaintMs),
      phones: m.phones,
      'round trip ms': r0(i.latency?.median),
      'p95 ms': r0(i.latency?.p95),
      samples: i.latency?.n ?? 0,
      'rtt ms': r1(i.link.rttMs),
      'iPad gets': i.link.inRes ?? '–',
      'Mac gets': m.link.inRes ?? '–',
    });
  }
  if (rows.length) console.table(rows);
  if (rows.some((r) => !r.samples)) {
    problems.push('no round-trip samples for at least one fill mode (bar code unreadable?)');
  }

  // 3. A look: sent vs. received. First grow (still on), then back to remove with the iPad's mode slider.
  if (!hijackOnly) {
    await writeSheet('stream_grow_sheet.jpg');
    await tapMode('remove');
    await mac.evaluate(() => window.deviceRemover.store.set('fill', 'migan'));
    await sleep(2500);
    await writeSheet('stream_sheet.jpg');
  }

  /** Tap a name on the iPad's mode slider; the Mac must follow and the iPad must show it. */
  async function tapMode(mode) {
    const at = await ipad.evaluate((m) => {
      const r = document.querySelector(`.cam-dial [data-mode=${m}]`).getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    }, mode);
    await ipad.touchscreen.tap(at.x, at.y);
    await until(mac, (m) => window.deviceRemover.store.value.mode === m, mode, Date.now(), 5000);
    await until(ipad, (m) => window.streamPage.mode() === m && document.querySelector('.cam-dial [aria-checked=true]')?.dataset.mode === m, mode, Date.now(), 5000);
  }

  async function writeSheet(file) {
    const sheet = await ipad.evaluate(async () => {
      const urls = [];
      for (let k = 0; k < 4; k++) {
        urls.push(window.streamPage.grab());
        await new Promise((r) => setTimeout(r, 400));
      }
      const imgs = await Promise.all(urls.map((u) => new Promise((r) => Object.assign(new Image(), { onload: (e) => r(e.target), src: u }))));
      const c = document.createElement('canvas');
      c.width = imgs[0].width;
      c.height = imgs[0].height * imgs.length;
      imgs.forEach((im, k) => c.getContext('2d').drawImage(im, 0, k * im.height));
      return c.toDataURL('image/jpeg', 0.85);
    });
    writeFileSync(join(outDir, file), Buffer.from(sheet.split(',')[1], 'base64'));
    console.log(`wrote captures/${file} (left: sent, right: received)`);
  }

  /** In hijack mode: the sound of the iPad page over `ms`: share of the time someone speaks, loudness then, peak. */
  async function listen(ms) {
    return ipad.evaluate(async (ms) => {
      const t = performance.now();
      let n = 0;
      let heard = 0;
      let sum = 0;
      let peak = -Infinity;
      while (performance.now() - t < ms) {
        const { levels } = window.streamPage.sound();
        n++;
        if (levels && levels.rms > -45) {
          heard++;
          sum += 10 ** (levels.rms / 10);
        }
        if (levels) peak = Math.max(peak, levels.peak);
        await new Promise((r) => setTimeout(r, 40));
      }
      return { speaking: Math.round((100 * heard) / n), rms: heard ? 10 * Math.log10(sum / heard) : -Infinity, peak };
    }, ms);
  }

  // 4. Hijack: the Mac finds the phones, the iPad speaks.
  {
    // The clip's phone moves about: the focus zone is the whole picture.
    await mac.evaluate(() => {
      const { store } = window.deviceRemover;
      store.set('hijackZone', 2);
      store.set('hijackScene', 'catchup');
    });
    const inFocus = () => window.streamPage?.sound().running && window.streamPage.sound().key !== '';
    let t = Date.now();
    await tapMode('hijack');
    const started = await until(ipad, inFocus, undefined, t, 15_000);
    await sleep(2500);
    const heard = await listen(9000);
    const [i, m] = [await ipadState(ipad), await macState(mac)];
    const s = await ipad.evaluate(() => window.streamPage.sound());
    const macSound = await mac.evaluate(() => ({ engine: !!window.deviceRemover.sound.engine, hint: !document.getElementById('sound').classList.contains('hidden'), effect: window.deviceRemover.effect.describe() }));
    console.log(`hijack, tapped on the "iPad": someone in focus there after ${started} ms`);
    console.log(`  iPad: ${s.key} · speaking ${heard.speaking} % of the time, ${r1(heard.rms)} dB RMS, peak ${r1(heard.peak)} dB · slowest line written in ${r0(s.slowestMs)} ms · ${r0(i.shownFps)} fps shown`);
    console.log(`  Mac: own sound ${macSound.engine ? 'ON (wrong)' : 'off'}, hint ${macSound.hint ? 'SHOWN (wrong)' : 'hidden'} · pipeline ${r1(m.fillFps)} fps, detect ${r1(m.detectMs)} ms · ${macSound.effect}`);
    if (heard.speaking < 15) problems.push('hijack: nobody is heard on the iPad page');
    if (macSound.engine || macSound.hint) problems.push('hijack: the Mac page makes sound or asks for a click');

    // Left and right: as on the iPad's screen, which is mirrored with the front camera.
    const pans = await ipad.evaluate(async () => {
      const box = [...document.querySelectorAll('.panel input[type=checkbox]')][0]; // Mirror
      const engine = window.streamPage.engine();
      const real = engine.update.bind(engine);
      const seen = {};
      for (const on of [true, false]) {
        if (box.checked !== on) box.click();
        let pan = null;
        engine.update = (p, at) => {
          pan = p.pan;
          real(p, at);
        };
        await new Promise((r) => setTimeout(r, 700));
        seen[on] = pan;
      }
      engine.update = real;
      if (!box.checked) box.click();
      return seen;
    });
    console.log(`  phone to the left/right: ${r1(pans.true)} with the mirror on, ${r1(pans.false)} with it off (the clip moves, so not exactly opposite)`);
    if (pans.true * pans.false > 0.02) problems.push('hijack: the mirror does not swap left and right');

    // Interruptions.
    const rows2 = [];
    const silent = () => !window.streamPage || window.streamPage.sound().key === '';
    t = Date.now();
    await ipad.reload({ waitUntil: 'domcontentloaded' });
    rows2.push({ interruption: 'iPad page reloaded', 'in focus again after ms': await until(ipad, inFocus, undefined, t) });
    await sleep(3000);

    let c0 = await ipad.evaluate(() => window.streamPage.connections());
    t = Date.now();
    await mac.evaluate(() => window.deviceRemoverStream.dropLink());
    const fellSilent = await until(ipad, silent, undefined, t, 8000).catch(() => null);
    await until(ipad, (c) => window.streamPage.connections() > c && window.streamPage.linkFrames() > 0, c0, t);
    rows2.push({ interruption: 'connection died silently', 'silent after ms': fellSilent ?? 'never', 'in focus again after ms': await until(ipad, inFocus, undefined, t) });
    await sleep(3000);

    t = Date.now();
    await mac.reload({ waitUntil: 'domcontentloaded' });
    const gone = await until(ipad, silent, undefined, t, 8000).catch(() => null);
    rows2.push({ interruption: 'Mac page reloaded (models reload)', 'silent after ms': gone ?? 'never', 'in focus again after ms': await until(ipad, inFocus, undefined, t) });
    await until(mac, () => !!window.deviceRemover);
    await sleep(3000);

    // A phone nobody sees any more: the state "nobody" has to arrive.
    t = Date.now();
    await mac.evaluate(() => window.deviceRemover.store.set('hijackZone', 0.01));
    rows2.push({ interruption: 'phone out of the zone', 'silent after ms': await until(ipad, silent, undefined, t, 8000).catch(() => 'never') });
    t = Date.now();
    await mac.evaluate(() => window.deviceRemover.store.set('hijackZone', 2));
    await until(ipad, inFocus, undefined, t, 15_000);
    t = Date.now();
    await tapMode('remove');
    rows2.push({ interruption: 'Remove tapped', 'silent after ms': await until(ipad, silent, undefined, t, 8000).catch(() => 'never') });
    await sleep(6000);
    const after = await listen(1500);
    console.table(rows2);
    // Silence is -Infinity, which arrives here as null.
    if (after.peak !== null && after.peak > -80) problems.push(`hijack: still ${r1(after.peak)} dB on the iPad 6 s after Remove`);
    if (rows2.some((r) => r['silent after ms'] === 'never')) problems.push('hijack: the iPad did not fall silent');
    await mac.evaluate(() => window.deviceRemover.store.set('hijackScene', 'auto'));
  }

  // 5. Interruptions: time until the "iPad" shows new frames again.
  if (recovery) {
    const back = [];
    const connections = () => ipad.evaluate(() => window.streamPage.connections());
    const newLinkWithFrames = (c0) => window.streamPage.connections() > c0 && window.streamPage.linkFrames() > 0;

    let t = Date.now();
    await ipad.reload({ waitUntil: 'domcontentloaded' });
    back.push({ interruption: 'iPad page reloaded', 'picture back after ms': await until(ipad, () => window.streamPage?.framesShown() > 0, undefined, t) });

    let c0 = await connections();
    t = Date.now();
    await mac.evaluate(() => window.deviceRemoverStream.dropLink());
    back.push({ interruption: 'connection died silently', 'picture back after ms': await until(ipad, newLinkWithFrames, c0, t) });

    // The iPad stops sending but still gets the Mac's (now stale) picture: only the Mac can tell.
    c0 = await connections();
    t = Date.now();
    await ipad.evaluate(() => window.streamPage.stopSending());
    const stallBack = await until(ipad, newLinkWithFrames, c0, t);
    await sleep(3000);
    const macAfterStall = await macState(mac);
    back.push({
      interruption: 'iPad stopped sending (only the Mac notices)',
      'picture back after ms': stallBack,
      note: `Mac fill ${r1(macAfterStall.fillFps)} fps, receiving ${r0(macAfterStall.link.inFps)} fps afterwards`,
    });
    if (!(macAfterStall.link.inFps > 10)) problems.push('after the sending stall the Mac did not receive frames again');

    t = Date.now();
    await ipad.evaluate(() => window.streamPage.restartCamera());
    await sleep(3000);
    const macAfterCam = await macState(mac);
    back.push({
      interruption: 'iPad camera restarted',
      'picture back after ms': '–',
      note: `connection kept; Mac receiving ${r0(macAfterCam.link.inFps)} fps, fill ${r1(macAfterCam.fillFps)} fps 3 s later`,
    });
    if (!(macAfterCam.link.inFps > 10)) problems.push('after the camera restart the Mac did not receive frames');

    c0 = await connections();
    t = Date.now();
    await mac.reload({ waitUntil: 'domcontentloaded' });
    back.push({ interruption: 'Mac page reloaded (models reload)', 'picture back after ms': await until(ipad, newLinkWithFrames, c0, t) });

    await mac.close();
    await sleep(10_000);
    const indicator = await ipad.evaluate(() => !document.querySelector('#outage').classList.contains('hidden'));
    const held = await ipad.evaluate(() => !document.querySelector('#freeze').classList.contains('gone'));
    c0 = await connections();
    t = Date.now();
    mac = await openMac();
    back.push({
      interruption: 'Mac page closed 10 s, reopened',
      'picture back after ms': await until(ipad, newLinkWithFrames, c0, t),
      note: `during the gap: indicator ${indicator ? 'shown' : 'NOT shown'}, last picture ${held ? 'held' : 'NOT held'}`,
    });
    if (!indicator || !held) problems.push('during the Mac outage the iPad did not hold its picture or show the indicator');
    console.table(back);
    await until(mac, () => !!window.deviceRemover);
  }

  // 6. Soak: one line a minute. Steady connections count = no reconnects.
  if (minutes > 0) {
    console.log(`soak test, ${minutes} min:`);
    const soak = [];
    let reloads = 0;
    for (let k = 1; k <= minutes; k++) {
      let i, m, iHeap;
      try {
        await ipad.evaluate(() => window.streamPage.resetLatency());
        await sleep(60_000);
        [i, m] = [await ipadState(ipad), await macState(mac)];
        iHeap = await ipad.evaluate(() => (performance.memory ? performance.memory.usedJSHeapSize / 2 ** 20 : null));
      } catch {
        // The iPad page reloaded itself (its last-resort repair) while being read: note it, go on.
        reloads++;
        console.log(JSON.stringify({ min: k, note: 'the iPad page reloaded itself' }));
        await until(ipad, () => window.streamPage?.framesShown() > 0, undefined, Date.now(), 120_000);
        continue;
      }
      const line = {
        min: k,
        'iPad fps': r0(i.shownFps),
        'fill fps': r1(m.fillFps),
        phones: m.phones,
        'round trip ms': r0(i.latency?.median),
        'p95 ms': r0(i.latency?.p95),
        'freezes': i.link.freezes ?? '–',
        connections: i.connections,
        'iPad reloads': reloads,
        'Mac heap MB': r0(m.heapMB),
        'iPad heap MB': r0(iHeap),
      };
      soak.push(line);
      console.log(JSON.stringify(line));
    }
    console.table(soak);
  }
} catch (err) {
  problems.push(`check aborted: ${err.message}`);
} finally {
  await Promise.all([ipadBrowser.close(), macBrowser.close()]);
}

console.log(problems.length ? `problems:\n  ${problems.join('\n  ')}` : 'no console errors');
exitCode = problems.length ? 1 : 0;
// Not left to Node: sometimes something of the closed browsers keeps it from ending by itself.
process.exit(exitCode);
