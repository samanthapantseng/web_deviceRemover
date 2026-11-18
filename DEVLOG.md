# Devlog

Machine: MacBook Pro M2 Max, 64 GB. Chrome 157. All numbers are from this machine.

## 2026-11-12 · session 1: verify the parts, still-image pipeline

### Verified

- **MI-GAN download link works.** `migan.onnx` (29.5 MB, MIT). The same repo also has
  `migan_pipeline_v2.onnx`, which crops around the mask itself (NonZero / ScatterND ops).
  We do our own cropping, so the simpler `migan.onnx` is used.
- **MI-GAN inputs/outputs** (`scripts/inspect_onnx.py` plus a probe run in onnxruntime):
  `image` uint8 `[N,3,H,W]` RGB, `mask` uint8 `[N,1,H,W]` (255 = keep, 0 = fill),
  output `result` uint8 `[N,3,H,W]`. Pixels outside the hole come back unchanged. The graph
  resizes to 512×512 internally, so the cost is the same for any input size. About 170 ms on
  CPU in Python, so WebGPU is needed for live use.
- **YOLO11n-seg and YOLO11s-seg export to ONNX** with Ultralytics (opset 17, imgsz 640).
  Input `images` `[1,3,640,640]`, outputs `output0` `[1,116,8400]` and `output1`
  `[1,32,160,160]`.
- **OpenCV.js 4.12 includes `inpaint`** (Telea). About 6 ms for a typical hole in Node.
- **Both models run on WebGPU** with onnxruntime-web 1.31.1 (`onnxruntime-web/webgpu`, the
  native WebGPU provider), first in the Claude desktop app's Chromium 156, then in Chrome 157.
- **Whole pipeline on one still** (stock photo, phone filling half the frame, 640×426),
  median of 5: detect 15.1 ms model + 1.7 pre + 0.9 post (yolo11n), mask 2.6 ms,
  MI-GAN 43.3 ms, Telea 9.1 ms, stylised 0.2 ms.

### What failed, and the fix

- **OpenCV.js froze the tab.** The module object has a `then` method, and Vite's CommonJS
  interop copies it onto the result of `await import('@techstark/opencv-js')`, so the await
  never finishes. Fix: `src/fill/opencv.ts` uses a static default import and only hands the
  module out wrapped in `{ cv }`.
- **The desktop app's browser pane blocks the camera** and stops rendering when hidden
  (`img.decode()` never resolved). `loadImage` now uses `createImageBitmap`.

## 2026-11-12 · session 2: live loop, measurements, production build

The Claude in Chrome extension was not connected and the desktop app's browser pane blocks
the camera. Workaround that turned out better than either: drive the installed Chrome
headless with a video file as a fake webcam (`scripts/headless_check.mjs`). Test clips are
a stock photo with added noise, static and slowly panning (`scripts/make_test_clip.sh`).
**No real webcam or real person has been in front of this yet.**

### Live loop

Ran on the first try. Display loop and pipeline loop are separate: the camera is drawn at
screen rate and the newest fill is laid on top.

Chrome 157 headless, 640×480 @ 30 fps clip as camera, production build, yolo11s-seg:

| Fill | Fill updates | Detect | Mask | Inpaint | Display |
|---|---|---|---|---|---|
| MI-GAN (WebGPU) | 14.8 fps | 23 ms | 0.6 ms | 42 ms | 60 fps |
| Telea (OpenCV.js) | 29.8 fps | 23 ms | 0.6 ms | 8 ms | 60 fps |
| Stylised (canvas) | 29.9 fps | 24 ms | 0.7 ms | 0.9 ms | 60 fps |

On the dev server MI-GAN was at 13.0 to 13.4 fps. In a visible Chromium window on the
laptop's 120 Hz screen the display ran at 120 fps. Targets were display ≥ 15 fps and fill
≥ 8 to 10 fps.

### Decision: yolo11s-seg instead of yolo11n-seg

Phone recall on the panning clip (dark phone, screen towards the camera, score per frame):

| | median score | found at conf 0.25 | mask present with hysteresis + hold | longest gap |
|---|---|---|---|---|
| yolo11n-seg | 0.31 | 59 % | 92 % | 28 frames (about 0.5 s) |
| yolo11s-seg | 0.87 | 100 % | 100 % | none |

yolo11s costs about 10 ms more per frame (23 ms against 13 ms). Since dropouts are the most
visible failure, it is now the default. yolo11n is still in the debug panel. Based on one
scene; to be repeated on a real webcam frame, especially with the phone's back to the camera.

### Finding: MI-GAN needs context

On a noisy camera frame MI-GAN painted cyan and pink junk into the hand, where on the clean
still it had continued the sofa. Same mask. The difference was how much of its window the
hole filled:

- window 276 px (hole about a third of it): coloured object in the hand
- window 352 px: less, still a dark blob
- window 448 px: clean continuation of the background
- window 352 px with dilation 6 instead of 12: worse, skin-coloured blobs. Leftover finger
  fragments at the hole edge get "continued", so less dilation is not a way to save fingers.

Change: every fill declares how much context it wants. MI-GAN gets a window 2.6× the hole's
longer side (hole under about 15 % of the area); Telea stays tight at 1.5×.

### Flicker, measured

Static clip with noise. Mean frame-to-frame brightness change inside the filled area, relative
to the camera noise outside it (1.0 = as restless as the camera noise):

- MI-GAN, fill smoothing 0.5: 0.36
- MI-GAN, no smoothing: 0.88
- Telea: 0.13
- Stylised blur: 0.03

So with smoothing the fill is calmer than the camera image around it. (Measured before the
switch to yolo11s and the wider window.)

### Appearing and disappearing

Clip with the phone present for 3 s, absent for 3 s. The fill is on within one cycle of the
phone appearing (the phone is visible for that one cycle). When it disappears the mask is
held for about 350 ms (5 frames), then fades over about 200 ms. No stale fill flashes when
it comes back.

### What failed, and the fix

- **Same camera frame processed twice.** Waiting on `video.currentTime` fired at screen rate,
  not camera rate. Now uses `requestVideoFrameCallback`.
- **Production build hung at "loading phone detector".** Vite put onnxruntime into a chunk
  shared with app code; onnxruntime starts its worker threads by loading its own file in a
  Worker, which then crashed on `document`. Fix: onnxruntime gets its own chunk
  (`vite.config.ts`). The dev server never showed this.
- **CPU fallback froze the picture** (display 4 fps), because WASM inference ran on the main
  thread. Fix: without WebGPU, run onnxruntime in its worker (`env.wasm.proxy`). First attempt
  hung: in that mode the input buffers are transferred to the worker and our reused arrays
  came back empty. Now copies are handed over. Result: display 60 fps, fill 2 to 4 fps.
- `scripts/copy_ort.mjs` copied four onnxruntime binaries (90 MB); only one is used.

### Observations

- Fingers: wrapped around the phone's edge they survive in principle, but a thumb on the
  screen is part of YOLO's phone mask, and the 12 px dilation takes fingertips. In the test
  scene the hand ends at the palm. Candidate fix: subtract MediaPipe hand landmarks from the
  mask and let the inpainter work around the fingers. Not built; needs a decision.
- A phone about 30 px tall (person far away) was not detected at all.

### Still to do

1. Real webcam: still test, then the live view, with the phone's back to the camera.
2. Decide on finger handling after seeing real frames.
3. Later modes (inflate, audio hijack) and background memory, as planned.

## 2026-11-17 · session 3: running it on the iPad (test mode)

Target: iPad Pro 12.9" (3rd generation, A12X, 2018), iPadOS 26.7.3, Safari. Same code, same
repository; the Mac serves the files, Safari on the iPad does all the work.

### What was added

- **`npm run dev:ipad`**: the dev server on https, reachable from the network, port 8443 (next
  to the plain `npm run dev` on 5173, which is unchanged). Safari only allows the camera on
  https, so this needs a certificate the iPad trusts.
- **`scripts/make_cert.sh`**: a certificate authority for this Mac (made once, installed on the
  iPad once) and a server certificate re-issued on every start for the Mac's Bonjour name
  (`Samanthas-MacBook-Pro.local`) and current addresses, so a new network needs no reinstall.
  The authority is limited (name constraints) to `.local`, `localhost` and private addresses.
  Keys are kept outside the project folder.
- **Touch**: double-tap opens the panel; the panel has Snapshot / Fullscreen / Close buttons and
  bigger controls on touch screens. Front / back camera choice. Screen kept awake. Turning the
  iPad restarts the page in the new orientation.
- **Remote report**: in iPad mode the page sends timings, errors and status (no images) to the
  Mac's terminal and `captures/device-report.jsonl`, so a run on the iPad can be read on the Mac.

### Verified (on the Mac, not on the iPad)

- Apple's own certificate check (`security verify-cert`, the same trust code as iOS) accepts
  the certificate for the `.local` name and the IP, and rejects a certificate for
  www.google.com signed by the same authority (name constraints enforced).
- `curl` over the `.local` name with only this authority trusted: page, models and onnxruntime
  load over HTTP/2 with the isolation headers. Without the authority: refused.
- From a network address, test stills in `captures/` and the certificate keys are refused
  (403); from the Mac itself the stills still load for the test pages.
- Headless Chrome over https on the `.local` name: same numbers as before (MI-GAN 14 fps, Telea
  28.6, stylised 31.1, display 60). With an iPad Safari user agent, touch screen and a 480×640
  portrait frame: double-tap, panel buttons, 16 px controls, phone found (0.97), MI-GAN 13 fps.
- The still-test capture through the iPad server lands in `captures/` on the Mac, and its
  timings arrive in the report.
- The plain `npm run dev` and the production build are unchanged; the reporter is not in the
  build.

### What failed, and the fix

- **Port 5174 was taken.** Two `npm run dev` servers were running (VS Code and another
  terminal); when the config changed, both restarted and one moved to 5174. Vite moves extra
  servers to 5174, 5175…, so the iPad server uses 8443 instead.
- **"display NaN fps"** (older bug): two screen frames with the same timestamp divided by zero
  and the average stayed NaN. Now skipped.

### First run on the real iPad

The `.local` name did not load on the school network (Bonjour is probably blocked); the IP
address did. Safari 26.6 on the A12X **has WebGPU** (shader-f16, workgroup storage 16 KB, 256
invocations per workgroup, buffers up to 256 MB) and both models ran on it. Front camera
640×480, display at 80 to 130 fps (120 Hz screen).

But everything is 25 to 40 times slower than on the M2 Max:

| | iPad Pro 2018, Safari | M2 Max, Chrome |
|---|---|---|
| detect, yolo11s-seg 640 | 520 to 1,100 ms | 23 ms |
| MI-GAN | 220 to 550 ms | 45 ms |
| Telea | about 110 ms | 9 ms |
| fill updates | 0.7 to 1.7 per second | 14 to 30 per second |

**The page died 10 to 20 s after all three fills had loaded**, four times, with no error
reported. Safari reloads a page whose process was killed, which matches a second "hello" in
the report each time. Most likely out of memory: MI-GAN and the detector on the GPU, OpenCV.js
and onnxruntime's four CPU worker threads were all loaded together.

Changes:

- Fills load only when first used (stylised stands in meanwhile); the live view no longer
  loads MI-GAN and OpenCV.js unless they are picked. The still test page still loads all three.
- onnxruntime uses one CPU thread when WebGPU does the work (no change in speed on the Mac).
- Light detectors: the same models exported for 320×320 input. The detector now reads its
  input size from the model.

Detectors on the moving test clip (Mac, raw detections per frame, threshold 0.25):

| | input | inference | phone found | median score | longest gap |
|---|---|---|---|---|---|
| yolo11s-seg | 640 | 23.1 ms | 100 % | 0.87 | 0 |
| yolo11n-seg | 640 | 13.8 ms | 58 % | 0.31 | 26 frames |
| yolo11s-seg-320 | 320 | 12.8 ms | 100 % | 0.61 | 1 frame |
| yolo11n-seg-320 | 320 | 11.5 ms | 11 % | 0 | 82 frames |

`yolo11s-seg-320` is the one to try on the iPad: a quarter of the work of the default, and in
this clip just as reliable (lower scores, but always above the threshold). The removal looked
as clean as with the 640 model. On the Mac the GPU is not the bottleneck, so it is only 1.8×
faster there; on the iPad, where it is, a gain closer to 4× is expected, i.e. roughly 150 to
250 ms per detection. That is still only 3 to 5 fill updates a second: below the 8 to 10
aimed for.

### Second iPad run, and the memory leak

On the second run only the detector and Telea were loaded (lazy loading worked; Telea took 11
to 45 ms), but the detector was still the 640 one, and the page still restarted after about
45 s, then again after about 15 s. So it was not only MI-GAN's memory.

Safari on the Mac (26.6.2) shows the same thing and can be measured (`footprint` on its page
process, the page running on a still image with `?src=`):

- Safari, models on WebGPU: memory grows by 100 to 150 MB a second, 2 GB → 7 GB in 30 s, and is
  never given back. It stops growing when processing stops.
- Safari, models on the CPU (`?backend=wasm`): flat at about 1 GB.
- Chrome, same page: flat (about 1.1 GB).

So it is Safari plus onnxruntime's WebGPU path. Every browser on the iPad uses Safari's engine,
so another browser there would not help. The iPad has a few GB, which explains a crash within a
minute.

Tried, not solved:

- Keeping model inputs and outputs in GPU buffers we own and reuse (`src/runtime/gpuIO.ts`).
- Telling onnxruntime to reuse all its GPU buffers (`storageBufferCacheMode` etc. 'simple').
- One run with both looked flat, but a control run of the same setup later leaked too, so that
  run was probably not processing at all. Both are kept as opt-in experiments (`?gpuio=1`,
  `?cache=simple`); the default is unchanged.
- Skipping the erase effect and the mask canvas did not stop the growth either, which points
  further at onnxruntime's WebGPU path in Safari.

Added for testing: `?fill=`, `?runFor=` (stop after N s), `?report` (reporting on the plain dev
server too), and onnxruntime's WebAssembly memory size in the reports.

Careful: every Safari leak test leaves a tab holding gigabytes until it is closed; after a dozen
the Mac had 40 GB in swap and the Chrome check ran 40 % slower.

### Rectangles taken for phones: top-category check

Report from the user: holding anything roughly rectangular made it count as a phone.

How detection worked: YOLO11s-seg scores every region of the image for all 80 COCO categories,
each score on its own (they do not share out to 1). We only read the "cell phone" score and
took anything at 0.25 or more (0.125 near a phone already found). So a book scoring "book 0.8,
cell phone 0.3" counted as a phone.

Change: a region only counts as a phone if "cell phone" is its highest score of all 80
(panel: "Phone must be the top category", on by default; `&top=0` on the still page turns it
off). Overlapping regions are now decided once per object by their strongest reading, so a
neighbouring region of the same book that happens to say "phone" cannot slip through. What was
turned away shows in the panel ("not phone: book 0.80 (phone 0.31)") and as cyan boxes on the
still page.

Checked on the stock photos and the moving clip: every real phone still found with the same
score; their next-best category scored at most 0.03. Phone found in 100 % of clip frames with
the check on and off; post-processing 0.22 ms either way.

For measuring: the still page now has a field for what is being held (saved as
`still-<time>-<label>.png`), and `npm run stills` lists, for every capture, the phone score with
and without the check and what the model really thinks a turned-away object is. Not yet run on
real look-alike objects; that needs captures from the user.

### First real-camera measurements, new defaults, re-confirmation

The user's webcam captures (`npm run stills`): real phone, screen to camera 0.94; black wallet
held upright like a phone **0.90**; the same wallet flat or at the frame edge, a pencil case and
an empty hand: nothing; a book (Augé, *Non-Places*): turned away by the top-category check
("laptop 0.50" beats phone 0.26). So the upright wallet cannot be separated from a phone by any
threshold. To this model a dark rounded rectangle in fingers is a phone, which is also what a
phone looks like from the back.

From the user, after trying it live: look-alikes briefly score high, then drop, which is not a
big problem; but at threshold 0.70 a wallet at 0.40 stayed "a phone", because once accepted
an object was kept down to half the threshold (0.35) with no time limit.

Changes:

- Defaults set by the user: dilation 0 px (works best on the real camera), threshold 0.70.
- Re-confirmation: below the threshold an object only counts as a phone if it reached the full
  threshold within the last 1.5 s (panel slider "Weaker score may carry a phone for", 0 to 5 s).
  The panel shows "sure 0.8 s ago" next to the phone's score.

Checked on the moving clip, frame by frame (fill: stylised):

| threshold | window | frames sure | weak frames | weak frames still counted | phone counted | longest carried on weak scores |
|---|---|---|---|---|---|---|
| 0.92 | no limit | 0 | 163 | 163 | 100 % | 11.5 s |
| 0.92 | 1.5 s | 0 | 170 | 0 | 0 % | 0 s |
| 0.88 | no limit | 50 | 110 | 110 | 100 % | 1.6 s |
| 0.88 | 1.5 s | 61 | 99 | 97 | 99 % | 1.5 s |
| 0.88 | 0.5 s | 65 | 91 | 67 | 85 % | 0.5 s |

The first row is the reported problem: carried for 11.5 s without ever being sure. With the
window, a phone that is sure about a third of the time stays counted 99 % of the time.

### Watching before erasing (replaces re-confirmation)

From the user, after trying re-confirmation live: a wallet or pencil case was erased at once,
then let go a few seconds later; they did not like that confusion. They asked for the machine
to watch an object for at least 3 s, then decide, accepting that phones are no longer erased
immediately.

Change (`src/detect/tracker.ts`): the detector now reports every phone-like object (phone
score at least half the threshold, top category or not) and the tracker decides which ones are
erased; only their masks are painted. Objects are matched frame to frame by overlap or nearby
centre, so a moving phone keeps its identity. Each processed frame is a vote: "phone" when phone
is the top category at or above the threshold, else "not phone" (also when not found).

- Erased once the object is 3 s old and at least 67 % of its last 3 s of votes said phone.
- Stays erased in every frame it is found, whatever the score, until fewer than 33 % (half the
  bar) of its last 3 s said phone. My choice, to stop an object right at the bar switching on
  and off.
- Unseen for up to 1 s (and at least two frames, for slow devices): keeps its status. Longer:
  forgotten, watched again from the start when it returns.
- Panel: "Watch a new object for" (0 to 6 s; 0 erases at once) and "Erase if phone in at least"
  (30 to 100 %) replace "Weaker score may carry a phone for"; a line per object followed, e.g.
  `#4 watching 1.2/3.0 s · 80 %`. The mask overlay draws watched objects dashed orange and
  objects decided against dashed grey. Saved settings that no longer exist are dropped on load.

Checked with synthetic detections at 15 fps (the tracker on its own, in Node):

| case | result |
|---|---|
| phone 0.93, moving | erased at 3.04 s, then every frame, no switching |
| wallet 0.90 for 0.6 s, then 0.40 | never erased |
| wallet steady at 0.90 | erased at 3.04 s (the known limit) |
| phone, hand covers it for 0.6 s | same object, stays erased |
| phone gone 2 s, back | new object, erased 3.04 s after it returns |
| phone sure in 75 % of frames | erased at 3.04 s, no switching |
| phone sure in 55 % of frames | never erased (erased at 3.04 s with the bar at 50 %) |
| phone next to a wallet at 0.40 | phone erased, wallet not |
| phone jumping 70 px per frame | one object, erased at 3.04 s |
| book: phone 0.36, laptop higher | never erased |
| erased phone turns into "book" | let go about 2 s later |
| 1 fps, phone 0.93 | erased at 3.0 s |

And live on the moving clip (headless Chrome, stylised fill, 10 s per row, tracker reset
before each):

| threshold | watch | bar | frames sure | first erased | erased from then on | on/off switches |
|---|---|---|---|---|---|---|
| 0.70 | 3 s | 67 % | 100 % | 3.05 s | 100 % | 1 |
| 0.88 | 3 s | 67 % | 39 % | never | – | 0 |
| 0.88 | 3 s | 30 % | 33 % | 3.14 s | 100 % | 1 |
| 0.92 | 3 s | 67 % | 0 % | never | – | 0 |
| 0.70 | 0 s | 67 % | 99 % | at once | 100 % | 0 |

Timings unchanged (detect 25 ms, MI-GAN 46 ms, 13.5 fills per second); `npm run stills` gives
the same scores as before.

### 2026-11-18 · watch time 1.5 s

The user found 3 s far too long; the default is now 1.5 s (the look-back for the vote is then
1.5 s as well). Rechecked:

| case | at 3 s | at 1.5 s |
|---|---|---|
| clip, threshold 0.70 | erased at 3.05 s, no switching | erased at 1.53 s, no switching |
| clip, threshold 0.88 (sure in 38 % of frames) | never | never |
| wallet 0.90 for 0.6 s, then 0.40 | never | never |
| wallet 0.90 for 1.2 s, then 0.40 | never | erased at 1.5 s, let go about 1 s later |
| phone sure in 55 % of frames (random) | never | erased after 5.9 s, switched on and off twice |
| phone gone 2 s, back | erased 3.0 s after return | erased 1.5 s after return |
| real 1 fps | erased at 3.0 s | erased at 2.0 s (two frames) |

What the shorter watch costs: a look-alike that stays high for more than about 1 s can be
erased and then let go, and over the shorter look-back an object right at the bar switches more
often, because fewer frames are averaged.

### Open

- Decision for the user: keep hunting the Safari leak (uncertain; even fixed, the 2018 iPad
  would update the fill only a few times a second), run the iPad on the CPU (no leak, but very
  slow), or show the Mac on 24 Nov and leave the iPad for a native app (Core ML, Neural Engine)
  later.
- Chrome's fake camera cropped a portrait clip to 480×480; what Safari's camera delivers in
  portrait is to be seen on the device.

## 2026-11-17 · streaming mode (plan B, branch `stream`)

The iPad is 25 to 40 times too slow to run the models (session 3). Plan B, built on its own
branch while plan A (the iPad on its own) goes on: the iPad only films and shows, the Mac does
the work. The brief is in `prompts/stream-mode.md`.

How it works: the iPad's page (`stream.html`) sends its camera to the Mac's page
(`/?source=stream`) over WebRTC; the Mac runs the unchanged pipeline on it and sends the
finished canvas back (`captureStream`). The dev server introduces the two pages to each other
(`server/signalHub.ts`, Server-Sent Events plus POST, no new dependency). No STUN or TURN
server, so only local addresses are used. The Mac only starts sending once the detector runs,
so the iPad never shows unprocessed frames; until then, and during any outage, the iPad holds
its last picture.

Recovery, all automatic:

- The iPad makes a new connection when the Mac page appears, when the connection fails, or when
  no frame has come for 3 s; it retries after 1, 2, 4, 5, 5… s, for good.
- The Mac answers every new offer and keeps its models loaded.
- The Mac watches the other direction, which the iPad cannot see (it keeps getting the Mac's
  picture even when its own frames stopped arriving): no frame from the iPad for 3 s, and it
  asks the iPad for a new connection.
- The iPad restarts its camera when the camera stops delivering frames (without a reload,
  which could bring back Safari's camera question).
- Last resort: when the Mac has asked three times in 30 s, the iPad page reloads.

### Verified (this Mac only, two headless Chromes; not yet on the iPad)

`npm run check:stream` (new): one Chrome plays the iPad (video file as camera, iPad user agent),
the other the Mac. Round trip measured with a frame counter drawn as a bar code into the
corner (`?latency`) and read back from the returned frames. Final run, VP8:

| fill | frames shown on the "iPad" | fill updates on the Mac | detect | round trip, median (95 %) |
|---|---|---|---|---|
| MI-GAN | 30 fps | 13.6 fps | 25 ms | 68 ms (86) |
| Telea | 28 fps | 28.7 fps | 25 ms | 68 ms (101) |
| Stylised | 30 fps | 30.1 fps | 25 ms | 68 ms (84) |

The fill rates are those of the standalone page (`npm run check` in the same session: MI-GAN
13.6, Telea 29.2, stylised 30). First picture 1.4 s after opening the iPad page (detector
cached). Picture back after:

| interruption | picture back after |
|---|---|
| iPad page reloaded | 0.3 s |
| connection dead without notice | 4.6 s (3 s watchdog, 1 s pause, connect) |
| the iPad stops sending, only the Mac notices | 4.7 s (Mac receives 22 fps again) |
| iPad camera restarted | connection kept, Mac receives 23 fps 3 s later |
| Mac page reloaded, models reload | 0.6 s |
| Mac page closed for 10 s, reopened | 1.1 s (meanwhile: last picture held, indicator shown) |

The phone is removed in the frames that come back (`captures/stream_sheet.jpg`). The standalone
page and `npm run build` are unchanged.

**30-minute soak** (`npm run check:stream -- … --minutes 30`, MI-GAN, VP8), one line a minute:

- Minutes 1 to 12: steady. Round trip 67 to 69 ms (95 %: 101), 22 to 30 fps shown on the
  "iPad", no reconnect, Mac heap going up and down between 71 and 137 MB (no growth). MI-GAN
  filled at 7.5 to 8.6 fps, not 13.6: the user's own Chrome had a tab at 90 to 100 % CPU the
  whole time.
- From minute 13 the whole Mac was overloaded: load average from about 5 to over 200 (640 the
  next morning), swap 15 GB of 16, later 20 of 21.5 GB, 10 GB held by the kernel. The stream
  slowed to 12 to 17 fps shown, 1.5 fps fill and 240 to 290 ms round trip, but kept running:
  the Mac's watchdog asked for new connections and the iPad page reloaded itself twice, as
  designed. At minute 27 the test script itself tripped over such a reload (fixed: the soak now
  notes the reload and carries on).
- So: no sign of the stream wearing down over time while the machine was healthy, and it
  survives a machine in trouble, slowly. A clean 30 minutes on a freshly restarted Mac is still
  to be done.

### What failed, and the fix

- **The Mac processed one frozen frame.** The fill ran at 3.5 fps on the same picture: the
  "iPad" had stopped sending. In headless Chrome the fake camera stops delivering frames as soon
  as its first H.264 connection starts; after a page reload it works, and with VP8 both
  directions ran at 30 fps from the start. Most likely a quirk of the test set-up (fake camera
  plus Chrome's H.264 encoder); Safari on the iPad uses H.264 by default. The pages keep
  preferring H.264 (hardware encoders on both devices); the check uses `?codec=vp8`, and the
  same parameter on the real iPad switches both directions to VP8.
- **That stall was invisible to the iPad**: it kept getting the Mac's picture at 30 fps, only
  the content no longer changed. Hence the Mac's watchdog, the camera restart and the reload as
  last resort. With H.264 in the test, the repair took about 20 s (three requests, then the
  reload) and the stream then ran normally (28 fps, 84 ms round trip).
- **One slow full run with VP8 too**: the Mac received only a few frames a second for a while.
  Not reproduced in four later runs; the user's own Chrome had a tab at 100 % CPU on the same
  Mac. The Mac's watchdog would now ask for a new connection if it happened again.
- **A received WebRTC stream only renders into a video element that is in the page.** The Mac's
  video is now in the page, 4 px, behind the picture. (In the end not the cause of the frozen
  frame, but needed.)
- **The first run hit a server restart** (my own tsconfig change) and loaded half a page.
- **"Mac page hidden" warning when closing it.** A closing page turns hidden for a moment; the
  warning now waits 2 s.

### Not verified

- Anything about Wi-Fi: both pages ran on one Mac. On a real network the round trip adds the
  Wi-Fi delay twice.
- Hidden addresses: the Mac page has no camera permission, so Chrome hides its local address
  behind a random `.local` name, which the school network does not resolve. Expected to work
  anyway, because the iPad (with camera permission) shares its real address and the Mac
  reaches it; the panel shows the route (`host → prflx` on the iPad would be this case).
- This Mac does not trust the Device Remover certificate yet, so the Mac's window shows a
  warning until it is trusted in Keychain Access (README, "Streaming mode"). Clicking through
  works for a test.
- Safari: support for `jitterBufferTarget` (smallest buffer) and `setCodecPreferences` (both
  checked before use; the panel says which applied), and whether a page reload asks for the
  camera again (README: set Safari's camera permission to Allow).
- `npm run stream:mac` was only dry-run (with Chrome replaced by `true`): the certificate
  check, the server check and `caffeinate` work; the Chrome window itself was not opened here.

### Open

- Restart the Mac (19 days up, swap full) and re-run the 30-minute soak.
- The real iPad test (README checklist).
- What the iPad should show during an outage: now the last picture with a small orange dot;
  fading to black is a one-line change.
