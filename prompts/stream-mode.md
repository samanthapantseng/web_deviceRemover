# Prompt: streaming mode (the iPad's camera and screen, the Mac does the work)

> **This is plan B** for the work-in-progress exhibition on **2026-11-24** (written 2026-11-17).
> Plan A, the standalone iPad version with all processing on the iPad, is still being worked on
> in parallel. Build this next to it without changing how the standalone version behaves.
> Aim for a version the user can try on the iPad within about a day.

## Context

Device Remover (this repo) is a live camera view in which phones are erased from people's
hands, leaving the empty pose. It is the user's MA thesis piece. It runs in the browser:

```
camera → YOLO11-seg (phone mask) → mask stabiliser → fill (MI-GAN / Telea / stylised) → composite
```

Read `README.md` and `DEVLOG.md` before starting. The last DEVLOG session ("First run on the
real iPad") explains why this mode exists.

For the exhibition the piece should be one object: an **iPad Pro 12.9" (2018, A12X, Safari
26.6)** whose camera looks at people and whose screen shows them without their phones. Running
the models on the iPad turned out to be 25 to 40 times slower than on the **MacBook Pro M2 Max
(Chrome 157)**:

| | iPad, Safari | Mac, Chrome |
|---|---|---|
| detect, yolo11s-seg 640 | 520 to 1,100 ms | 23 ms |
| MI-GAN | 220 to 550 ms | 45 ms |
| fill updates | 0.7 to 1.7 per second | 14 to 30 per second |

Safari also killed the page after 10 to 20 s, most likely because it ran out of memory.

Streaming mode splits the work. The iPad only captures and displays; the Mac runs the
existing pipeline, unchanged:

```
iPad, Safari: /stream.html                      Mac, Chrome: /?source=stream
  camera ───────── WebRTC video ────────────────▶ remote <video> → Pipeline (unchanged) → #view canvas
  screen ◀──────── WebRTC video ───────────────── #view.captureStream(30)

  signalling: the dev server that already serves both pages (npm run dev:ipad, https, port 8443)
```

**The user's priorities:** reliability and speed over image quality, and flicker is the worst
visual failure. For this mode, add one more: **it must recover by itself** from network drops
and page reloads, because nobody will stand next to it during the show.

## Ground rules

- **Branch.** Work on a separate branch (a worktree session is ideal), cut from `main` *after*
  the current iPad work there has been committed. This mode depends on it (`npm run dev:ipad`,
  `src/devReport.ts`, the certificates). If `git status` on `main` shows uncommitted changes,
  stop and ask the user before branching.
- **Plan A goes on in parallel on `main`.** Put new code in new files. Keep edits to shared
  files (`src/main.ts`, `src/camera.ts`, `vite.config.ts`, `package.json`, `README.md`,
  `DEVLOG.md`) small and in clearly separate blocks so the branch merges easily.
- **Don't change** the pipeline, detector, mask, effects or fills. If streaming seems to need a
  change there, stop and ask.
- **Leave these unchanged:** `npm run dev`, the standalone iPad page (`/` on `npm run dev:ipad`)
  and `npm run build` must behave exactly as before.
- **No new npm dependencies** without asking.
- **No internet services:** no public STUN or TURN servers and no hosted signalling. Frames stay
  on the local network and are never saved. They show visitors' faces.
- **Stop and ask the user** before:
  - adding a dependency;
  - anything they must change on the Mac or the iPad themselves, such as trusting a certificate
    in Keychain Access;
  - committing;
  - switching approach because the design below doesn't work. They want to be asked, not to
    find out afterwards.
- **Keep `DEVLOG.md` up to date:** what was tried, what worked and what failed, with numbers.
  The user uses it for process documentation. Add a new dated session at the end in the
  existing format (Verified / What failed, and the fix / Open), and match the existing plain,
  British-spelling tone.

## Design (decided; ask before deviating)

### 1. Signalling hub (dev server, iPad mode only)

Add a Vite plugin in a new file (e.g. `server/signalHub.ts`). Register it in `vite.config.ts`
next to `devReport()`, only in `--mode ipad` and with `apply: 'serve'`. Use no WebSocket
library: Server-Sent Events plus POST, in the style of the existing `/__report` middleware.

- `GET /__signal/events?role=ipad|mac` returns `text/event-stream`.
  - Keep one client per role; a new connection for a role closes the previous one.
  - Tell each side when the other joins or leaves (a `peer` event).
  - Send a comment line every 15 s as a heartbeat.
- `POST /__signal?role=ipad|mac` with a JSON body is forwarded to the other role. It returns 409
  if the other side isn't connected.
- Accept `role=mac` only from this Mac (reuse `fromThisMac()`); accept `role=ipad` from the
  network. Note in the README that on a shared network, someone else who opens the stream page
  would take over the screen. That is one more reason for the travel router (pitfall 8).
- Print joins and leaves in the terminal, in the style of the report lines
  (`[stream] iPad connected from 10.…`).
- **Non-trickle ICE.** Each side waits for ICE gathering to complete, then sends one offer and
  one answer. With no STUN server only host candidates are gathered, so this takes
  milliseconds, and the whole protocol is two messages.
- Make `printIpadUrl()` also print the stream address for the iPad and the Mac page address.

### 2. WebRTC connection

- `iceServers: []`: local network only.
- **The iPad always makes the offer; the Mac always answers.** A new offer replaces any existing
  connection on the Mac. Use one two-way video transceiver, or two one-way ones (your choice).
- The iPad's offer message also carries its capture size (`track.getSettings()` width and
  height) and which camera it uses (front or back).
- Prefer H.264 with `setCodecPreferences` where available, since both devices have a hardware
  encoder for it. Fall back to whatever is negotiated.
- `sender.setParameters`, both directions: `maxBitrate` around 3 Mbit/s, `maxFramerate` 30.
  Start with the default degradation preference; measure before tuning it.
- Receivers: set `jitterBufferTarget = 0` where supported, for the lowest latency. Check it
  doesn't cause stutter.
- No audio.

### 3. Mac page: `/?source=stream`

Reuse `index.html` and `src/main.ts`. In `main.ts`, add a third source next to `openStill` and
`openCamera`: `?source=stream` opens a remote `FrameSource` (new file
`src/stream/remoteSource.ts`). It waits for the iPad, then hands out the incoming stream
through a `<video>` element, with the same `nextFrame()` behaviour as the camera. Export
`frameWaiter` from `camera.ts` rather than copying it.

- **Size the pipeline from the capture size in the iPad's offer** (fitted to `MAX_SIDE`), not
  from the first received frame. WebRTC starts at a low resolution and ramps up, so the first
  frames can be 320×240 for several seconds. The resolution can also drop later under load:
  `drawImage` scales it, and nothing else may react. Only an orientation change (portrait ↔
  landscape) reloads the Mac page, as it does now.
- Send `#view` back with `view.captureStream(30)`, with `contentHint = 'motion'` on the track.
- **The Mac never mirrors in this mode.** Mirroring is done on the iPad, on the picture it
  shows.
- **When the iPad disconnects**, keep the models and the pipeline loaded and wait for the next
  offer. A reconnect must not reload anything on the Mac (except in the orientation case).
- Status line: "waiting for iPad…", "iPad connected · 640×480 · H264", "iPad gone, waiting…".
  The debug panel (`D`) works as now, plus the link stats (section 6). The fill and detector
  settings are made here, on the Mac.
- **Chrome throttles hidden or fully covered windows.** `requestAnimationFrame` and timers slow
  down, and a canvas that isn't painted sends no frames.
  - Warn on the page and in the report when `visibilityState` becomes `hidden`.
  - Add `scripts/stream_mac.sh` and an npm script for it (e.g. `npm run stream:mac`). It opens
    Chrome with its own profile (in `~/Library/Application Support/Device Remover/`) as an app
    window (`--app=`) at the Mac page.
  - Launch it with these flags: `--disable-backgrounding-occluded-windows
    --disable-renderer-backgrounding --disable-background-timer-throttling --no-first-run
    --no-default-browser-check`.
  - While it runs, keep the Mac awake with `caffeinate`.

### 4. iPad page: `stream.html` and `src/stream/ipad.ts`

This page is for the dev server only; don't add it to the production build.

- **Camera:** call `getUserMedia` with the same constraints as `openCamera()`: 640×480 ideal,
  30 fps, facing from `?camera=front|back`, default front. Send the stream to the Mac.
- **Display:** show the returned stream full screen in a `muted playsinline autoplay` `<video>`,
  with `object-fit: cover` (contain as an option), mirrored with CSS when the camera is the
  front one.
- **Never show the iPad's own raw camera.** Only processed frames from the Mac appear on screen.
- **Before the first frame:** a black screen with a small "connecting to the Mac…" line.
- **Controls:** wake lock, fullscreen and the double-tap panel, as on the main page.
  - Reuse `isTouchDevice`.
  - Copy the small `toggleFullscreen` and `keepAwake` helpers, or move them to a shared module if
    that is a small, clean change.
  - The panel here only has: camera front/back, mirror, cover/contain, fullscreen, reconnect,
    and the link stats.
- **Reporting:** report through `devReport.ts` (hello, status, errors, and a `stats` line every
  5 s), so a run on the iPad can be read in the Mac's terminal. Extend the terminal printer in
  `vite.config.ts` for the stream stats.

### 5. Recovery (the most important part)

The iPad drives recovery. It closes the old connection and starts a fresh one with a new offer
when:

- the page loads, or the event stream reconnects;
- the Mac joins;
- `connectionState` is `failed`, or has been `disconnected` for more than 3 s;
- no new frame has arrived for 3 s, even if the connection claims to be fine (a watchdog using
  `requestVideoFrameCallback`).

Retry with a back-off of 1, 2, 4, 5, 5… s, and never give up.

During an outage the iPad keeps the last frame on screen. After 3 s, a small, discreet
indicator appears in a corner. (The user may prefer fading to black; ask them once it works.)

**Targets:** the picture is back within 5 s after the network or the iPad page returns, and
within the model loading time (about 5 to 10 s) after the Mac page is reloaded.

### 6. Measuring

- **Link stats** on both sides, from `getStats()`, shown in the panels and sent in the report:
  - connection state;
  - the selected candidate pair (local and remote type: host, prflx or srflx);
  - round-trip time;
  - frames per second sent and received;
  - bitrate;
  - frames dropped and freezes;
  - codec and resolution.
- **Round-trip latency.** With `?latency`, the iPad page sends a canvas stream instead of the
  camera.
  - The canvas shows a test image (or a clip) with a frame counter drawn as a large black and
    white bar code in a corner, big enough to survive compression.
  - The Mac processes it like any other frame and sends it back.
  - The iPad reads the counter from the returned frames and reports the round trip in ms
    (median and 95th percentile).
  - This leaves out the camera's and screen's own delay, but includes everything that
    streaming adds.
  - Keep the bar code where the pipeline doesn't paint; the effect only paints over phones.

## Known pitfalls (verify these; don't assume)

1. **Hidden IP addresses.**
   - Chrome replaces its host IP candidates with random `.local` (mDNS) names unless the page
     has camera permission, and Safari does something similar.
   - The Mac page has no camera permission, and the school network blocks `.local` names: the
     iPad couldn't reach `<mac>.local` there, but the IP address worked.
   - It should work anyway. The iPad has camera permission, so it shares its real IP; the Mac
     reaches it, and the iPad learns the Mac's address from the incoming check (a prflx
     candidate).
   - Check the selected pair in the stats on a real network. If it fails, the options are: the
     Mac page asks for camera permission once and stops the track at once (in Chrome this
     lifts the mDNS hiding), or a Chrome policy or flag in the `stream_mac.sh` profile. Ask the
     user before picking one.
2. **Secure context on the Mac.**
   - WebGPU needs a secure context.
   - The Mac page must be served from the same server as the hub, to share its state:
     `https://localhost:8443/?source=stream`.
   - Check whether the Mac's Chrome trusts the Device Remover CA (`scripts/make_cert.sh`). If it
     doesn't, trusting it in Keychain Access is a one-time step for the user. Give them the
     steps; don't do it yourself.
   - Clicking through the certificate warning may be enough for testing, but it isn't fit for
     the exhibition.
   - Headless Chrome with `acceptInsecureCerts` (as in `headless_check.mjs`) already had WebGPU
     on port 8443.
3. **Resolution ramp at the start:** see section 3.
4. **A throttled Mac window:** see section 3.
5. **Autoplay in iPad Safari.** The returned video must be `muted` and `playsinline` to play
   without a tap. Check it again after a reconnect (new `srcObject`).
6. **Safari differs from Chrome** in support for `jitterBufferTarget`, `setCodecPreferences`
   and `degradationPreference`. Feature-detect each one.
7. **COOP/COEP headers** are on (cross-origin isolation, for the WASM fallback). WebRTC and media
   elements should be unaffected; confirm it.
8. **Venue Wi-Fi** may stop devices from reaching each other, and it will be crowded. The README
   already suggests a phone hotspot. For this mode, recommend a small travel router of the
   user's own (no internet needed), and say so in the README.

## Testing on this Mac (no iPad needed)

The Claude desktop app's browser pane blocks the camera. Drive the installed Chrome headless
with puppeteer-core, as `scripts/headless_check.mjs` does, with a `.y4m` clip as a fake camera.
`captures/clip_moving.y4m` exists; make more with `scripts/make_test_clip.sh`. Run Python
through `uv`.

Write `scripts/stream_check.mjs` (`npm run check:stream -- captures/clip_moving.y4m`), to run
against a running `npm run dev:ipad`:

- **Two separate headless Chrome instances**, like two devices:
  - "iPad": fake camera, iPad Safari user agent, touch, 1024×1366 viewport, on `/stream.html`;
  - "Mac": on `/?source=stream`.
- **Print a table:**
  - time to the first returned frame;
  - frames per second received on the iPad;
  - the Mac's fill fps, detect time and inpaint time, per fill mode as `headless_check.mjs`
    does (from `window.deviceRemover`);
  - round-trip latency, median and 95th percentile (`?latency`);
  - the selected candidate pair.
- **Recovery,** each with the time until frames are back:
  - reload the iPad page;
  - reload the Mac page;
  - close the Mac page for 10 s, then reopen it.
- **`--minutes N` soak mode:** print fps and latency every minute. Look for drift, growing
  latency and memory growth.
- **Save `captures/stream_sheet.jpg`:** frames as sent next to frames as received on the "iPad",
  to look at.

Also re-run `npm run check -- captures/clip_moving.y4m` and `npm run build`, to show the normal
mode is unchanged. Compare with the numbers in the README.

The local test can't show real Wi-Fi behaviour or the mDNS problem; say so in the DEVLOG.

## Test on the real iPad (the user does this)

Write a short checklist into the README section and give it to the user at the end:

1. Put the Mac and the iPad on the same network: their own router or a hotspot is better than
   venue Wi-Fi.
2. On the Mac, run `npm run dev:ipad`, then `npm run stream:mac`.
3. On the iPad, open the printed stream address in Safari. Use the IP form, e.g.
   `https://10.x.x.x:8443/stream.html`. Allow the camera.
4. Look at the result:
   - Does a phone disappear?
   - How does the lag feel when you wave?
   - Is the picture sharp enough on the 12.9" screen?
5. Try to break it:
   - reload the iPad page;
   - turn the iPad's Wi-Fi off for 10 s, then on again;
   - reload the Mac page;
   - leave it running for 30 min.
6. Run `?latency` once, to get the number.
7. For the show, turn on Guided Access (Settings → Accessibility → Guided Access) to keep
   Safari in front.

The Mac's terminal and `captures/device-report.jsonl` collect the numbers to read afterwards.

## Docs

- **README:** add a section "Streaming mode (the iPad's camera and screen, the Mac does the
  work)". Cover what it is, how to start it, the checklist, troubleshooting, and the network
  advice. Add the new files to the structure list. Keep the same plain tone as the rest.
- **DEVLOG:** add a dated session in the existing format, with numbers.

## Done when

- [ ] `npm run check:stream`:
  - connects;
  - the phone is removed in the frames the "iPad" receives;
  - every recovery case comes back within the targets;
  - the latency is measured and written down.
- [ ] A 30-minute soak on this Mac runs without growing latency or errors.
- [ ] The normal `npm run check` numbers and `npm run build` are unchanged, and the typecheck is
  clean.
- [ ] The README and DEVLOG are updated, and the iPad checklist has been given to the user.
- [ ] Nothing has been committed without the user's go-ahead.

## Not now (ask first, if tempting)

- **Higher-resolution output.** The iPad camera could send 1280×720 and the Mac could composite
  at that size. For now, stay at 640×480 like the standalone version.
- **Processing on the iPad as a fallback** when the Mac is gone.
- **The iPad's own live camera with only the patch from the Mac on top.** The background would
  lag less, but the patch would arrive late and phones would peek out.
- **Anything else:** several iPads, audio, settings sent from the iPad to the Mac, running from
  the production build or `vite preview`, anything over the internet.
