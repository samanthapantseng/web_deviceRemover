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

## 2026-11-18 · grow mode (branch `grow`)

A second mode: instead of erasing the phone, it inflates. Decided with the user before any
code: the phone is cut out along its **exact mask** (a fitted rectangle is the fallback if
that looks wonky), drawn **on top of everything** (no hand model; the hand disappears behind
it), grows **from its centre**, and **inflates over time** to 5×. My defaults, accepted:
starts at 1.2× the moment the tracker picks it, 30 s to full size, shrinks back and fades in
0.25 s when it is gone, same watch time as remove mode, `G` / panel / `?mode=grow`, remove
stays the default.

### What was built

- `src/effects/grow.ts`: per phone (tracker id), cut the camera pixels under its mask into a
  square sprite centred on the mask's centre; draw it scaled around that centre. Size from the
  time since the tracker decided on it (`erasedMs`, new in the tracker's verdict), smoothstep
  from start to max size.
- No inpainting: the bigger copy covers the real phone. MI-GAN is only loaded when remove mode
  is switched on.
- Mode switching: `Pipeline.setEffect`, each effect has `reset()`; the pipeline holds one
  effect for the whole frame, so a switch mid-frame cannot mix them.
- Still page: two extra tiles, grow at start size and fully grown. Headless check: a grow pass
  and `captures/check_grow_sheet.jpg`.

### What failed, and the fix

- **Stair-stepped edge at 5×.** The detector's mask is on/off per camera pixel, so each step
  became a 5 px block. A 3×3 blur of the on/off mask helped little. Fix: in grow mode the
  detector keeps its per-pixel mask values (logits) and turns them into an anti-aliased edge
  (0.5 + logit / |gradient|, the signed distance to the edge). On one real webcam still: 517
  partly transparent pixels around the outline, about one per edge pixel, as intended.
- **Straight cuts through the phone's corners.** Visible only once the edge was smooth: the
  model's box was a little tight on the real webcam still, and the mask is cut at the box, so
  the enlarged phone had flat sides at the top, bottom and lower left. Fix: in grow mode the
  mask is painted 8 % of the box's longer side beyond the box (remove mode unchanged).
- **Hole in the giant phone.** On a stock photo the mask had a gap over a face on the phone's
  screen; at 5× the blue background showed through a large blob. Fix: gaps fully enclosed by
  the mask are filled (flood fill from the box border). Notches open to the edge (fingers) are
  left alone.
- **Switching back to grow showed the phone at 5× at once**, because the tracker had picked it
  long before. Growth now counts from the later of "picked" and "grow mode switched on".
  Checked: 1.2× 0.1 s after the switch, 2.6× at 0.8 s, 5.0× at 2.4 s (2 s growth for the test).
- **`?mode=grow` started in grow mode but the panel said "remove".** URL parameters change the
  settings without going through the store, so the panel was not updated. Fixed with a panel
  refresh after the parameters (this also fixes the same issue for `?fill=`).

### Measured (this Mac, headless Chrome, 640×480)

| | pipeline | detect | effect | display |
|---|---|---|---|---|
| grow, moving test clip | 29.8 fps | 24.4 ms | 0.4 ms | 60 fps |
| grow, live view on a webcam still | 29.9 fps | 25.4 ms | 0.5 ms | 60 fps |
| remove, MI-GAN, same run (unchanged) | 13.7 fps | 23.6 ms | 47 ms | 60 fps |

Cutting out one phone on the still page: 1–5 ms (cold) per call. On a webcam still, growth
over 4 s (test setting) read 1.3×, 1.8×, 2.8×, 3.9×, 4.9×, 5.0× at 0.6 s steps. A phone that
stops counting (confidence raised to 0.99) was let go by the tracker after 0.8 s, then shrank
and faded and was gone 0.3 s later.

### Not verified

- A real camera with a real person: the edge wobble ×5 on real camera noise, and whether 0.5
  cut-out smoothing is enough or too much (blurs a moving phone).
- The iPad, in either way of running it.
- Two phones at once (each should grow on its own clock; the code path is the same per id).

### Open

- If the exact mask looks wonky on the real camera: fitted rectangle (rotated box from the
  mask), as agreed.
- Fingers on the phone are enlarged with it, and fingers over its edge leave an enlarged notch.

### 2026-11-18 · grow mode, take 2: rectangle, 1× → 2× in 5 s

The user tried the mask cut-out on the real camera: the mask did not work well. Decided: the
fitted rectangle, so that fingers on the phone grow with it. And the slow growth did not work
because the picture keeps moving: new defaults 1× when picked, 2× at the end, 5 s.

- **Rectangle.** A rotated rectangle with rounded corners (radius 12 % of the short side) is
  fitted to the phone's mask (holes filled, painted 8 % beyond the box as before). Everything
  inside it is drawn bigger. It is a clip path set in drawing space, so its edge stays sharp
  at any size (the mask version had to anti-alias the mask for that). The picture inside is
  the current frame; only the rectangle's angle and size are smoothed ("Grow: shape
  smoothing", 0.5), and the centre is not, because the picture is cut around it and must match
  the frame.
- **First fit, failed: the mask's principal axis** for the angle. On the moving test clip the
  phone is seen at an angle and its mask is a slanted four-sided shape; the principal axis was
  off by about 6°, and the rectangle around everything took in a strip of sofa. Fix: the
  smallest rectangle that encloses the mask (it has a side along one edge of the mask's
  convex hull; every hull edge is tried). The strip shrank to a small corner. A phone seen at
  an angle is a trapezoid, so some background at a corner remains.
- The mask cut-out stays as a second shape in the panel ("the phone's own outline").
- **Saved settings.** Settings are saved as a whole, so the user's browser already held the
  old 1.2 / 5 / 30 s, and new defaults would not have reached it. A saved value equal to an
  old default is now dropped on load (`OLD_DEFAULTS` in `settings.ts`). Checked: old defaults
  load as 1 / 2 / 5 s; hand-set values (smoothing 0.3, confidence 0.7, sizes 1.5 and 3) stay.

Measured (headless, moving clip): pipeline 29.5 fps, detect 28.5 ms, effect 0.3 ms, display
60 fps. Fitting and copying one phone on the still page: 4–11 ms cold. Leaving (shrink and
fade) and `G` switching unchanged; switching back to grow restarts at 1×.

Not verified: the rectangle on a real camera with a real person.

### 2026-11-18 · grow mode, take 3: the phone's outline plus the fingers on it

The user found the rectangle "really bad" and asked for the mask look plus the fingers. Two
ways were discussed: (1) fill the mask out to its convex hull, which brings the fingers over the
phone but cuts the hand off along a straight line where it leaves the phone; (2) add a hand mask
(YOLO's person mask, or a separate hand/skin model) to bring whole fingers. Decided: build (1)
first and test it.

- **Outline shape ("hull", now the default).** Convex hull of the phone's mask (holes filled,
  painted 8 % beyond the box). Pieces of the mask under 5 % of it are left out as specks, but
  not every piece except the biggest: a finger across the phone can split the mask in two.
  Centre: the hull's centre of area. The outline is kept as its distance from the centre in 120
  directions (every 3°), blended with the previous frame's ("Grow: shape smoothing", 0.5), and
  drawn as a clip path, so the edge is sharp at any size and the picture inside is the current
  frame (the exact-mask shape blends pictures, which smears a moving phone).
- Rectangle and exact mask stay as the other two shapes in the panel. A saved "rectangle"
  (only ever the default) moves to the new default; a shape chosen by hand stays.
- Seen on stills: on the user's webcam still, the two fingers over the screen are enlarged
  without the notch, the phone keeps its rounded corners, and the outline runs straight
  across the hand where it leaves the phone. On a stock photo the thumb grows with the phone
  and the background corner of the rectangle is gone. On the moving clip the strip of sofa
  the rectangle took in is gone.

Measured (headless, moving clip; another session was using the Mac at the same time, MI-GAN
fell to 8 fps from 11 to 14): grow 28.5 fps, effect 0.6 ms, display 60 fps. Outline fit and copy
on the still page: 5–13 ms cold. Leaving, `G` switching and the saved-settings move checked.

Not verified: the outline on a real camera with a real person.

### 2026-11-18 · grow mode, take 4: the precise mask plus the fingers on it

The convex outline was "not what I wanted": a phone is a rounded rectangle, so its convex hull
looks like the rectangle. The user wants the exact mask, which is much more precise, plus the
fingers on it.

- **Finger gaps filled by a morphological closing** of the mask (holes filled, specks left
  out): grow it by r with one distance field, shrink it back by r with a second. Every dent
  narrower than about 2r is filled, with what is there (the fingers), and the rest of the
  outline stays exactly the mask's, including its anti-aliased edge. The new edge across a
  filled dent is anti-aliased from the second distance field. r is "Grow: fill finger gaps",
  a share of the phone's size (square root of its area), default 15 %; 0 gives the exact mask.
  A border of r + 2 px is added around the area, so the shrinking also works at the frame's
  edge.
- **Only the shape is smoothed now, not the picture.** The exact-mask version blended each
  cut-out (picture and alpha) with the previous one, which smears a moving phone. Now the mask
  alone is blended (aligned on the phone's centre) and the colour is always the current frame.
- This is the default shape again ("precise mask + fingers on it"); convex outline and
  rectangle stay in the panel. Saved "rectangle" or "hull" (both only ever defaults) load as
  the mask.
- Seen on stills: on the user's webcam still the two fingers over the screen are enlarged
  instead of leaving a notch; the top, left and bottom edges are identical to the exact mask;
  lower right the outline still follows the hand where it covers a long stretch of the edge
  (wider than the fill). On a stock photo the thumb on the screen grows with the phone.

Measured (headless, moving clip): grow 27.3 fps (stylised fill 27.9 in the same run), effect
1.9 ms with the gaps filled, display 60 fps. On the still page (cold, bigger phones): 10–20 ms
with the gaps filled, 3–5 ms without. Leaving, `G` switching and saved settings checked.

Not verified: on a real camera with a real person; whether 15 % is the right fill there.

### 2026-11-18 · grow mode, take 5: the hand, from the person mask (option 2a)

On the user's snapshot (phone held up, four fingers across it) the fingers were lost: they
cover one band 67 px wide, and the gap fill bridges about 20 px (52 px at most; filling 67 px
needs a radius of about 34 px, which gives the convex outline). The phone mask cannot say where
the hand is. Decided: try 2a, the "person" mask YOLO computes in the same pass.

- **Detector:** with `person: true` it also decodes the people (score ≥ 0.25, NMS, up to 6)
  inside each erased phone's reach area (phone box + 60 % of its longer side), each inside its
  own box, anti-aliased like the soft phone mask. Only asked for when the grow shape is "hand".
- **Seen first:** the person mask follows the hand and fingers well, but it is the whole
  person: on the snapshot the hand runs into the head; with the phone at the ear everything
  around the phone is person (face, hair, body). Only against a room background is it just the
  hand.
- **Hand shape (now the default):** the precise mask with gaps filled, plus person pixels
  that start from the fingers covering the phone and spread through the person mask.
  - First try: start from person pixels inside the phone's convex hull, spread up to 35 % of
    the phone's length along the hand. Failed: a giant faded eye under the phone on the
    snapshot, and a ghost of the mouth and eye with the phone at the ear.
  - The mouth ghost came from wrong starting points: thin slivers of cheek inside the hull
    along the wobbly mask edge. Fix: start only from pixels at least 5 % of the phone's length
    inside the outline. Fingers covering the phone reach that deep.
  - The spread also ran along the hand into the face. Fix: limit it by straight-line distance
    from the fingers (a distance field), and fade by that distance.
  - With both fixes and a reach of 25 % (default): the snapshot shows a giant hand holding the
    giant phone, the palm fading over the forehead; the phone at the ear keeps the face clean;
    stock photos and the clip carry the hand along and fade into the real one. At 35 % a little
    of the face near the eye still came along on the snapshot.
- **Test page bug, found on the way:** the still page's grow tiles were partly drawn below
  full size on fast images: "grow mode switched on" was 0 (page load), and a phone "picked 5 s
  ago" on a page loaded under 5 s ago was capped there. Now it starts at "never". The live app
  was not affected (the tracker picks phones after the page loads). Some still-page grow tiles
  in the takes above (fast images) were therefore shown smaller than 2×.

Measured warm, live page on stills (headless): mask 1–3 ms, hand 4–11 ms per frame; pipeline
22.5–28.8 fps with the hand (26–29 without). Moving clip: grow 28 fps, effect 4.2 ms; remove
unchanged. Leaving, `G` switching and saved settings (old default shapes load as hand) checked.

Not verified: live with a real person; a phone held in front of the body (person mask all
around it: the spread would take in clothing near the fingers, faded); two people close
together.

## 2026-11-18 · screenshot button on the iPad stream page

Asked for by the user: a screenshot button in the iPad's menu. Added as the first button of the
stream page's panel (`src/stream/ipad.ts`), and `S` on a keyboard.

First version: the iPad saved the picture on its screen (result only), because on the iPad the
camera picture and the result arrive at different times. The user wanted the before/after of
the Mac's `S`, since every frame goes to the Mac anyway. Second version (`src/stream/shots.ts`):

- The tap asks the Mac over a WebRTC data channel on the same connection as the video (the iPad
  adds it to its offer; the Mac picks it up in `remoteSource.ts`). The Mac makes the same
  picture as its `S` (`pipeline.snapshot()`: the frame it received, and the result), mirrors
  each half if the iPad shows it mirrored, and sends the PNG back on the channel in 64 KB
  pieces. Straight between the devices: the signalling hub still carries no pictures.
- Saving on the iPad: Safari's share sheet (Save Image to Photos, AirDrop to the Mac). Safari
  opens it only shortly after a tap; if the picture takes too long and Safari refuses, a
  "Screenshot ready · tap to save" button appears and one more tap opens the sheet. No share
  sheet (a Mac, for testing): a download. A 0.35 s white flash confirms the tap.
- No connection to the Mac: the iPad says so (it cannot make the picture without the Mac). A
  request that gets no answer fails after 10 s with a message.

Checked with two headless Chromes (a touch "iPad" with the moving clip, and the Mac, MI-GAN):
three screenshots in a row, each a 1280×480 PNG (820 to 830 KB) in the share sheet 120 to 160 ms
after the tap, while the tap still counted as the user's; before on the left with the phone,
after on the right without it, the same frame, both mirrored like the iPad shows it. Safari's
refusal imitated: the "tap to save" button appeared, the second tap opened the sheet and the
button went away. No share sheet: the PNG downloaded. Link to the Mac dropped: "no connection to
it right now". No console errors.

The stream check (`npm run check:stream -- … --no-recovery`) ran normally with the channel.
Speeds were lower than on 17 Nov because the Mac was busy (another session's tests, and a
Chrome tab using a full core): the plain Mac check fell from 13.5 to 10.6 MI-GAN fills a second
at the same time. Alternating runs gave 10.8 (channel off), 9.9 (on), 6.2 (off) MI-GAN fills a
second, so the channel itself costs nothing measurable; the swings are the load.

Not yet tried on the real iPad: how long the picture takes over Wi-Fi (about 0.8 MB), and
whether Safari still opens the share sheet straight away or needs the second tap.

## 2026-11-18 · screen recording on the iPad stream page

Asked for by the user: a screen-recording button that records only the "after" picture and
saves to Downloads. Added as **Record** in the iPad panel (`V` on a keyboard),
`src/recorder.ts`.

- Recorded on the iPad, from the picture the Mac sends back: every frame shown is drawn,
  mirrored as shown, into a canvas whose stream goes to a MediaRecorder (MP4/H.264 where the
  browser can, else WebM; 4 Mb/s). Nothing extra goes over the network, and the Mac is not
  involved. The alternative, recording on the Mac (its own picture, one compression step
  fewer) and sending the file to the iPad, was not built: a long recording is tens of MB over
  Wi-Fi.
- The button turns into "Stop recording · 0:12"; a small red "REC 0:12" in the bottom-left
  corner while recording. On stop the file downloads; "Save last recording" saves it again
  until the next recording starts. Stops and saves by itself after 5 min (`?recordMax=`), my
  choice, against filling the iPad's memory (about 30 MB a minute, held in memory until saved).

Checked with two headless Chromes (touch "iPad" with the moving clip, Mac with MI-GAN): a 5 s
recording by tap gave an H.264 MP4, 640×480, 5.6 s, about 27 fps, 3.8 Mb/s; a frame from it shows
the after picture only, mirrored like the screen. Button label, the REC indicator and "Save last
recording" appear and go as they should; that button started a second download (headless Chrome
then holds back a second download from the same page, as Chrome does without the user's
permission). Automatic stop with `?recordMax=3`, started with `V`: a 3.0 s file. No console
errors.

Not verified on the real iPad: Safari's MP4 recording of the received stream, whether the
download starts by itself after Stop or needs "Save last recording", and the iPad's frame rate
while recording.

## 2026-11-18 · screen recording on the Mac page (Mac solo)

Asked for by the user: the same screen recording on the Mac on its own. `V` or **Record** in the
Mac's panel, with the same button label, REC indicator, "Save last recording" and 5-minute stop
as on the iPad. The recorder (`src/recorder.ts`) and its CSS (`style.css`) are shared by both
pages.

Moved to its own branch, `capture` (off `main`), at the user's request, so it can be merged
without grow mode; it was written in the grow folder alongside grow mode's uncommitted work.

- What is recorded: the picture as on screen (mirrored as shown, the whole 640×480 frame),
  without the mask overlay and the panel. With the overlay off, each display frame is copied
  from the screen canvas, at most 30 a second; with it on, the picture is drawn a second time
  without it (`Pipeline.render(ctx, false)`). The effects' `render` works from elapsed time, so
  a second call in the same frame changes nothing.
- `DebugPanel.addAction` now returns its button (for the changing label).

Checked in headless Chrome with the moving clip as webcam (MI-GAN, mask overlay on while
recording): an H.264 MP4, 640×480, 4.5 s for a 4.2 s tap-to-tap recording, about 29 fps,
4.1 Mb/s; a frame from it shows the clean after picture, mirrored, with no overlay, box or panel,
while the screen showed all three. Display stayed at 60 fps. "Save last recording" started a
second download; automatic stop with `?recordMax=3`, started with `V`, gave a 3 s file. The
iPad recording test was run again after the move: same results. No console errors.

## 2026-11-18 · lag on the real iPad, and a bitrate test

The stream lags clearly more than Mac only. From the log of the first real iPad session
(10:24–10:50 UTC; `captures/device-report-stream.jsonl`):

- The link itself was healthy: H.264, 640×480, 30 fps and about 2.8 Mbit/s in each direction,
  direct route between the two devices.
- Network round trip: median 17–20 ms, with spikes of 290–440 ms.
- **Receive buffers** (average time a frame waits before it is shown): **Mac 94 ms** (Chrome,
  with the minimal buffer setting applied), **iPad 125 ms** (Safari; up to 227 ms).
- So most of the extra lag (roughly 250–350 ms in all, partly estimated) is the two receive
  buffers, about 220 ms. Both browsers grow their buffer when frames arrive unevenly (Wi-Fi
  jitter), and shrink it only slowly. The network itself adds about 20 ms.
- Not about lag: the first connection (10:32) delivered no frames for 106 s, and the iPad did
  not react to the Mac's restart requests until the page reloaded (10:33:51). Not explained
  yet; Safari in the background would explain it.

### Tried: a bitrate setting (removed again)

- A bitrate cap per direction, chosen on the iPad: **Bitrate, each way** in its panel
  (3 / 2 / 1.5 / 1 / 0.6 Mbit/s, remembered, reconnects), or `?kbps=` in its address. The
  offer carries it and the Mac follows. Default unchanged (3 Mbit/s).
- Both pages' panels, their `link` reports and the terminal line show the cap (`(cap 1000)`).
- `KBPS=1000 npm run check:stream -- …` runs the headless check with a cap; its table now
  shows what each side sends.

### Verified (headless, this Mac, VP8, no Wi-Fi)

| cap | sent per direction | round trip, median by fill mode |
|---|---|---|
| 3000 | 3017–3048 kb/s | 99–100 ms |
| 1000 | 933–1025 kb/s | 99–100 ms in one run, 67–69 ms in another |
| 600 | 584–606 kb/s | 63–93 ms |

The cap holds in both directions. The round-trip numbers are too noisy to tell whether a lower
bitrate helps: the Mac was busy (detection 30–67 ms, against 28 ms yesterday), and without
Wi-Fi there is no queuing, which is what a lower bitrate is meant to reduce. Typecheck passes.

### On the real iPad (16:39–16:42 UTC, `?latency`, front and back camera)

| cap | iPad sends / gets | round trip median (p95) | iPad buffer | Mac buffer | reports |
|---|---|---|---|---|---|
| 3000 | 1703 / 1944 kb/s | 177 ms (202) | 49 ms | 28 ms | 16 |
| 2000 | 1869 / 1946 kb/s | 143 ms (177) | 29 ms | 36 ms | 4 |
| 1500 | 1211 / 1424 kb/s | 139 ms (173) | 26 ms | 36 ms | 2 |
| 1000 | 977 / 967 kb/s | 112 ms (229) | 21 ms | 31 ms | 3 |
| 600 | 505 / 580 kb/s | 135 ms (174) | 37 ms | 25 ms | 7 |

- No visible improvement at lower bitrates; **kept at 3 Mbit/s**.
- At 640×480 the encoders use only about 1.7–1.9 Mbit/s, so a cap of 3 or 2 changes nothing;
  only 1.5 and below hold them back.
- The lower caps had only 5–15 s each (2–7 reports), too little to tell their differences
  apart from chance.
- The network was much calmer than in the morning: round trip 7–10 ms (morning 17–20),
  buffers iPad 21–49 ms and Mac 25–36 ms (morning 125 and 94). On this network, the round trip
  of about 180 ms at 3 Mbit/s is mostly the fixed steps: compressing and decompressing twice,
  and the processing on the Mac. A lower bitrate does not shorten those.
- The first real-Wi-Fi round-trip number: 177 ms median at 3 Mbit/s (headless, without Wi-Fi:
  68–100 ms).

The bitrate setting was then removed again at the user's request and never merged: streaming
stays at 3 Mbit/s. Raw logs: `captures/device-report-stream.jsonl` (morning session) and
`captures/device-report-bitrate.jsonl` (bitrate test), both gitignored.

## 2026-11-18 · grow and capture merged into main

Both branches were merged into `main` locally, conflicts resolved by hand, each merge committed
by the user.

- **grow** (`1ebb9a5`): one conflict, in README.md. On GitHub the line "Critical-design
  prototype (v0, laptop webcam) …" had been deleted (`d43a858`); `grow` still had it, with its
  new line about grow mode below. Resolved: the deleted line stays deleted, the grow line stays.
- **capture** (`af33429`): three conflicts, all from both branches adding to the same places.
  DEVLOG.md (both added sections at the end: both kept, grow first); `src/main.ts` (imports:
  both kept); `src/ui/panel.ts` (key hint: now lists both `G` and `V`). README.md,
  `pipeline.ts` and the stream files merged by themselves.
- Branches `grow`, `stream` and `capture` deleted once their work was in `main` on GitHub;
  GitHub now only has `main`.

Checked after the capture merge, headless Chrome with the moving clip as webcam: typecheck
passes; MI-GAN 13.7 fps, Telea 30, stylised 30, grow 30.2 fps (effect 4.3 ms); no console
errors. Screen recording in grow mode (`?mode=grow&recordMax=3`), once with the mask overlay off
and once on: two MP4 files; a frame from the second shows the phone at 2×, mirrored, without
the overlay.

README brought up to date afterwards: recording also saves files (`V`, not only `S`); the
streaming mode's "nothing is recorded" now says the stream itself is not stored; the
streaming steps mention grow mode and `G`; the real iPad's round trip (177 ms) is in "Streaming
mode"; grow mode's limits say it is not yet tested in streaming mode; the structure lists the
files that were missing.

Not verified: grow mode in streaming mode; the iPad's Screenshot and Record buttons after the
merge (the stream files merged without conflicts, and grow mode does not touch them).

## 2026-11-19 · hijack mode, first version (branch `hijack`)

The third prototype: aim the camera at someone's phone and hear "their" soundscape in
headphones. Talked through with the user before any code; their choices:

- **Mac only** first (the laptop's webcam; they will test by turning the laptop towards people).
- **A private listener**: the person who aims, on headphones.
- **Silence between people**: nothing comes out of the headphones unless a phone is in focus.
- **Completely separate** from remove and grow: its own mode (`H`); the picture is left as it is.
- **Abstract, synthesised sound**, including a "muffled headphone beat". Recordings were
  considered (a "literal" or "hybrid" version: what their phone might be playing) and set
  aside because they need a library of sounds. Discussed before choosing: with a laptop webcam
  the screen is rarely visible, orientation is confused with viewing angle, a phone at the ear
  is where the detector already misses, thumb scrolling is lost in the mask's jitter, and
  clothing colour shifts with the webcam's exposure. So only coarse inputs are used.

### What was built

- `src/audio/voices.ts`: five characters, all Web Audio synthesis (drone, pulse, noise wash,
  bell plucks, muffled headphone beat). Shared by all: a filter that opens with clarity
  (low-pass; for the beat a high-pass, tinny → full), panning, level from closeness, reverb
  send, and a pitch glide when tuning in and out. Seeded variations per person (key, tempo,
  pattern).
- `src/audio/engine.ts`: one voice in focus at a time, a noise sweep when tuning in and out,
  a generated room reverb, and at the end limiter → tanh soft clip → ceiling 0.8 (-1.9 dBFS).
  Rhythmic events scheduled 0.3 s ahead on a 50 ms timer. A watchdog fades the sound out when
  no update came for 3 s. Works on an OfflineAudioContext too, for the test renders.
- `src/effects/hijack.ts`: measures each picked phone (distance from the centre in zone radii,
  size, time held, speed in phone lengths per second), chooses the phone in focus with
  hysteresis (lock after 0.25 s inside the zone; keep while inside 1.25× the zone and for 2 s
  after it is lost; switch only to a phone a quarter radius more centred, for 0.6 s, not within
  1.5 s of the last switch), and draws the zone and a ring.
- Pipeline: an effect can now set its own watch time (hijack: 0.5 s, so the sound comes sooner)
  and is told when it is switched out (`deactivate`, to stop the sound).
- Screen recording in hijack mode includes the sound (a cloned track of the engine's output).
- Panel: the hijack settings, and a "Test sound" button. Sound starts on the first click or
  key press (browser rule); a note says so until then.
- `scripts/hijack_check.mjs` (`npm run check:hijack`): measures the sound in headless Chrome,
  and renders each character to `captures/hijack_<character>.wav` for listening.

### Tuning the levels (measured, not heard)

The first run had the drone about 7 dB louder than the pulse (live RMS -19.2 against -29.6),
and the beat at the zone's edge 19 dB below its centred level (its high-pass started at
1400 Hz). Changed: drone level 0.5 → 0.38; pulse bus 0.9 → 1.2; beat: kick 0.9 → 0.7, hats
and snare up, high-pass at the edge 1400 → 500 Hz. After that (offline renders, clear part):
drone -22.2, pulse -23.8, wash -24.3, plucks -25.9, beat -26.9 dB RMS; the beat's edge is
8.5 dB below its clear level, the others 4 to 6.5 dB.

### Checked

- `npm run check:hijack -- captures/clip_moving.y4m`: in focus 0.81 s and heard 0.86 s after a
  fresh start; each character heard; silent 2.6 s after switching to remove mode; a picture
  without a phone silent for 6 s; highest peak -5.9 dB (ceiling -1.9); the recording is MP4
  with H.264 and AAC; no console errors.
- `npm run check`: remove and grow unchanged (MI-GAN 14.2 fps, Telea 30, stylised 29.9,
  grow 30).
- In the app's browser pane (a regular, not headless, browser) with still images: before a
  click the "click or press any key for sound" note shows; after it the sound runs. On a stock
  photo the phone is picked up (bell plucks, clear 100 %, near 100 %), with the ring around it.
- Typecheck and production build pass.

Not verified: how any of it sounds (nobody has listened yet); live with a real person, a moving
laptop and headphones; how the focus behaves when sweeping across several people.

