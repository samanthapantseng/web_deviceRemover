// Streaming mode, tested on this Mac without an iPad. Two separate headless Chrome instances,
// like two devices: one plays the iPad (a video file as its camera, an iPad user agent and touch,
// on /stream.html?latency), the other the Mac (/?source=stream). Prints speed and round-trip
// latency per fill mode, and how long the picture takes to come back after each interruption.
//
//   npm run dev:ipad                                                   # in another terminal
//   npm run check:stream -- captures/clip_moving.y4m
//   npm run check:stream -- captures/clip_moving.y4m --minutes 30      # then a soak test
//   npm run check:stream -- captures/clip_moving.y4m --no-recovery     # skip the interruptions
//   BASE=https://localhost:8444/ npm run check:stream -- ...           # another server
//   DEVICE=quest npm run check:stream -- captures/clip_moving.y4m      # as Quest Browser (headset camera),
//                                                                       # with the room view on a pretend headset
//   SHOW_CONSOLE=1 …                                                   # print both pages' console
//
// Writes captures/stream_sheet.jpg: what the "iPad" sent (left) and got back (right), 4 frames.
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
const recovery = !args.includes('--no-recovery');
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
// DEVICE=quest: the stream page as Quest Browser on a Quest 3 opens it, so it takes the
// headset-camera path (here the only camera, the video file, counts as the headset camera).
const quest = process.env.DEVICE === 'quest';
const QUEST_UA =
  'Mozilla/5.0 (X11; Linux x86_64; Quest 3) AppleWebKit/537.36 (KHTML, like Gecko) OculusBrowser/41.2.0 SamsungBrowser/4.0 Chrome/138.0.0.0 VR Safari/537.36';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A pretend headset for the room view (DEVICE=quest): just enough WebXR for questXr.ts to run.
// The head stays still at the origin looking down -z; the eyes 6.4 cm apart; each eye's view
// 80° wide (the default camera setting), side by side in a 1280×480 canvas. One right
// controller whose buttons the check presses. capture() returns the next frame as a JPEG.
function fakeXr() {
  const point = (x, y, z, w = 1) => new DOMPointReadOnly(x, y, z, w);
  const rigid = (x) => {
    const m = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 0, 0, 1]);
    const inv = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -x, 0, 0, 1]);
    const t = { position: point(x, 0, 0), orientation: point(0, 0, 0, 1), matrix: m };
    t.inverse = { position: point(-x, 0, 0), orientation: point(0, 0, 0, 1), matrix: inv, inverse: t };
    return t;
  };
  const f = 1 / Math.tan((80 * Math.PI) / 180 / 2);
  const aspect = 640 / 480;
  const near = 0.05;
  const far = 50;
  const proj = new Float32Array([f, 0, 0, 0, 0, f * aspect, 0, 0, 0, 0, (far + near) / (near - far), -1, 0, 0, (2 * far * near) / (near - far), 0]);
  const views = [
    { eye: 'left', projectionMatrix: proj, transform: rigid(-0.032) },
    { eye: 'right', projectionMatrix: proj, transform: rigid(0.032) },
  ];
  const pose = { transform: rigid(0), views };
  const buttons = Array.from({ length: 6 }, () => ({ pressed: false, value: 0 }));
  const state = { canvas: null, wantCapture: null, frames: 0 };
  class FakeSession extends EventTarget {
    inputSources = [{ handedness: 'right', gamepad: { buttons, axes: [0, 0, 0, 0] } }];
    visibilityState = 'visible';
    environmentBlendMode = 'alpha-blend';
    frameRate = 90;
    ended = false;
    async requestReferenceSpace() {
      return new EventTarget();
    }
    updateRenderState() {}
    requestAnimationFrame(cb) {
      return setTimeout(() => {
        if (this.ended) return;
        state.frames++;
        cb(performance.now(), { getViewerPose: () => pose });
        if (state.wantCapture && state.canvas) {
          state.wantCapture(state.canvas.toDataURL('image/jpeg', 0.85));
          state.wantCapture = null;
        }
      }, 11);
    }
    async end() {
      this.ended = true;
      this.dispatchEvent(new Event('end'));
    }
  }
  class FakeLayer {
    constructor(_session, gl) {
      this.framebuffer = null;
      gl.canvas.width = 1280;
      gl.canvas.height = 480;
      state.canvas = gl.canvas;
    }
    getViewport(view) {
      return { x: view.eye === 'left' ? 0 : 640, y: 0, width: 640, height: 480 };
    }
  }
  Object.defineProperty(navigator, 'xr', {
    value: { isSessionSupported: async () => true, requestSession: async () => new FakeSession() },
  });
  window.XRWebGLLayer = FakeLayer;
  window.__fakeXr = {
    frames: () => state.frames,
    capture: () => new Promise((r) => (state.wantCapture = r)),
    // Held for a few frames, like a real press.
    press: (i) => {
      buttons[i].pressed = true;
      setTimeout(() => (buttons[i].pressed = false), 120);
    },
  };
}
const problems = [];
const common = ['--no-first-run', '--no-default-browser-check', '--autoplay-policy=no-user-gesture-required'];

function watch(page, who) {
  page.on('pageerror', (e) => problems.push(`${who} page error: ${e.message}`));
  page.on('console', (m) => {
    const t = m.text();
    if (process.env.SHOW_CONSOLE) console.log(`  [${who} console.${m.type()}] ${t.slice(0, 300)}`);
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
  await page.setUserAgent(quest ? QUEST_UA : IPAD_UA);
  if (quest) await page.evaluateOnNewDocument(fakeXr);
  // As a Quest: also ask for the room view's patches (there is no headset here to enter it).
  await page.goto(`${base}stream.html?latency${codec}${quest ? '&patches' : ''}`, { waitUntil: 'domcontentloaded' });
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
  const rows = [];
  const patchRows = [];
  for (const fill of ['migan', 'telea', 'stylised']) {
    await mac.evaluate((f) => window.deviceRemover.store.set('fill', f), fill);
    await sleep(2500);
    await ipad.evaluate(() => window.streamPage.resetLatency());
    await sleep(6000);
    const [i, m] = [await ipadState(ipad), await macState(mac)];
    if (quest) {
      const [qp, mp] = await Promise.all([ipad.evaluate(() => window.streamPage.patches()), mac.evaluate(() => window.deviceRemoverStream.patches())]);
      patchRows.push({
        fill: m.fill,
        'patches got': qp.received,
        'with image': qp.withImage,
        'patch delay ms': r0(qp.delayMs),
        'Mac sent': mp.sent,
        'Mac empty': mp.empty,
        'Mac skipped': mp.skipped,
        unreadable: mp.unreadable,
        'KB / patch': r1(mp.avgKB),
        numbering: qp.stamping,
      });
    }
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
  console.table(rows);
  if (quest) {
    console.log('room view patches (counts since the page opened; delay: frame stamped → patch arrived):');
    console.table(patchRows);
    if (!patchRows.at(-1)?.['with image']) problems.push('no patches with an image arrived');
  }
  if (rows.some((r) => !r.samples)) {
    problems.push('no round-trip samples for at least one fill mode (bar code unreadable?)');
  }

  // 2b. As a Quest: the room view, on the pretend headset.
  if (quest) {
    await mac.evaluate(() => window.deviceRemover.store.set('fill', 'telea'));
    await ipad.waitForSelector('.enter-xr:not(.gone)', { timeout: 10_000 });
    const mac0 = await mac.evaluate(() => window.deviceRemoverStream.patches());
    await ipad.click('.enter-xr');
    await sleep(4000);
    const rv = await ipad.evaluate(() => window.streamPage.roomView());
    const xrFrames = await ipad.evaluate(() => window.__fakeXr.frames());
    const mac1 = await mac.evaluate(() => window.deviceRemoverStream.patches());
    console.log(
      `room view: ${rv.active ? 'on' : 'OFF'} · ${xrFrames} headset frames · ${rv.patches} patches placed, ${rv.empty} empty, ${rv.unplaced} not placed · patch delay ${r0(rv.patchDelayMs)} ms`,
    );
    console.log(
      `  Mac meanwhile: ${mac1.sent - mac0.sent} sent, ${mac1.skipped - mac0.skipped} skipped (busy), ${r1(mac1.avgKB)} KB each, extra cover ${mac1.margin} px, encoding ${r1(mac1.encodeMs)} ms`,
    );
    if (!rv.active) problems.push('the room view did not start');
    if (!rv.patches) problems.push('no patch was placed in the room view');
    const shot = (what) => ipad.evaluate(() => window.__fakeXr.capture()).then((url) => ({ what, url }));
    const views = [await shot('patches only')];
    // B: the whole frame, half-transparent (lining up).
    await ipad.evaluate(() => window.__fakeXr.press(5));
    await sleep(2000);
    const macFull = await mac.evaluate(() => window.deviceRemoverStream.patches().full);
    if (!macFull) problems.push('B did not switch the Mac to whole frames');
    views.push(await shot('whole frame (B)'));
    // A: the settings panel.
    await ipad.evaluate(() => window.__fakeXr.press(4));
    await sleep(800);
    views.push(await shot('settings panel (A)'));
    const sent = await ipad.evaluate(() => window.streamPage.grab());
    const sheet = await ipad.evaluate(async (urls, sentUrl) => {
      const load = (u) => new Promise((r) => Object.assign(new Image(), { onload: (e) => r(e.target), src: u }));
      const imgs = await Promise.all(urls.map(load));
      const cam = await load(sentUrl);
      const c = document.createElement('canvas');
      c.width = 1280;
      c.height = 480 * (imgs.length + 1);
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#555';
      ctx.fillRect(0, 0, c.width, c.height);
      // Row 0: what the camera sent (left half of grab()), as the left eye would see it.
      ctx.drawImage(cam, 0, 0, cam.width / 2, cam.height, 0, 0, 640, 480);
      imgs.forEach((im, k) => ctx.drawImage(im, 0, 480 * (k + 1)));
      return c.toDataURL('image/jpeg', 0.85);
    }, views.map((v) => v.url), sent);
    writeFileSync(join(outDir, 'quest_room_view.jpg'), Buffer.from(sheet.split(',')[1], 'base64'));
    console.log(`wrote captures/quest_room_view.jpg (camera frame; then left | right eye: ${views.map((v) => v.what).join('; ')})`);
    await ipad.evaluate(() => window.streamPage.exitRoomView());
    await sleep(500);
  }

  // 3. A look: sent vs. received.
  await mac.evaluate(() => window.deviceRemover.store.set('fill', 'migan'));
  await sleep(2500);
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
  writeFileSync(join(outDir, 'stream_sheet.jpg'), Buffer.from(sheet.split(',')[1], 'base64'));
  console.log('wrote captures/stream_sheet.jpg (left: sent, right: received)');

  // 4. Interruptions: time until the "iPad" shows new frames again.
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

  // 5. Soak: one line a minute. Steady connections count = no reconnects.
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
process.exitCode = exitCode;
