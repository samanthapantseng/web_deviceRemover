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
