# Device Remover

A live camera view in which phones are erased from people's hands, leaving the empty pose.
Critical-design prototype (v0, laptop webcam), inspired by Jonah Brucker-Cohen's *Device Inversions*.

Everything runs in the browser, on the device. No frame leaves the machine, and nothing is
saved unless you press the snapshot key.

```
camera → YOLO11-seg (phone mask) → mask stabiliser → fill (MI-GAN / Telea / stylised) → composite
```

## Setup

Needs Node 20+ and Chrome (WebGPU). The models are not in the repository; fetch them once:

```bash
npm install
```

```bash
npm run models
```

```bash
npm run dev
```

Then open <http://localhost:5173/> in Chrome and allow the camera.

`npm run models` needs `curl` and [`uv`](https://docs.astral.sh/uv/). It downloads MI-GAN
(30 MB, checksum verified) and exports the YOLO models, into `public/models/`.

## Keys

| Key | |
|---|---|
| `1` `2` `3` | fill mode: MI-GAN, Telea, stylised (press `3` again to step through blur / flat / void) |
| `M` | mask overlay: mask in magenta, detection box in yellow, inpaint window in cyan |
| `S` | snapshot: before and after of the same frame, side by side, as a PNG download |
| `F` | fullscreen |
| `D` | debug panel |
| `X` | mirror |

The debug panel shows display fps, fill fps, detection / mask / inpaint times and the active
backend, and has sliders for confidence, dilation, feather, hold frames, mask persistence,
inpaint crop size and fill smoothing. Settings are remembered in the browser.

## Exporting the YOLO model by hand

`npm run models` does this for you. The equivalent manual steps:

```bash
pip install ultralytics onnx onnxslim onnxruntime
```

```bash
yolo export model=yolo11s-seg.pt format=onnx imgsz=640 opset=17 simplify=True
```

Copy the resulting `yolo11s-seg.onnx` to `public/models/`. `yolo11n-seg` is exported the same
way; it is faster but misses phones (see below). Switch between them in the debug panel.

To check what a model expects:

```bash
uv run --python 3.12 --with onnx python scripts/inspect_onnx.py public/models/migan.onnx
```

## Testing without standing in front of the camera

- **Still test page**: <http://localhost:5173/still.html>. Capture a webcam frame (3 s
  countdown) or open an image; it runs detection and every fill once and times each step.
  With `npm run dev`, a webcam capture is also written to `captures/` (gitignored).
  `?img=captures/x.png&model=yolo11n-seg&cropSize=400` and similar parameters are accepted.
- **Live view on a still image**: `http://localhost:5173/?src=captures/x.png`.
- **Headless check**: plays a clip as a fake webcam in the installed Chrome and prints
  timings for every fill mode.

```bash
bash scripts/make_test_clip.sh captures/some_photo.png
```

```bash
npm run check -- captures/clip_moving.y4m
```

- `?backend=wasm` forces the CPU fallback; `?model=yolo11n-seg` tries another detector.

## Measured performance

MacBook Pro M2 Max, Chrome 157 (headless, 640×480 @ 30 fps clip as camera), production build,
yolo11s-seg. The same pipeline in a visible Chromium window displayed at 120 fps.

| Fill | Fill updates | Detect | Mask | Inpaint | Display |
|---|---|---|---|---|---|
| MI-GAN (WebGPU) | 14.8 fps | 23 ms | 0.6 ms | 42 ms | 60 fps |
| Telea (OpenCV.js) | 29.8 fps | 23 ms | 0.6 ms | 8 ms | 60 fps |
| Stylised (canvas) | 29.9 fps | 24 ms | 0.7 ms | 0.9 ms | 60 fps |
| MI-GAN, no WebGPU | 2.1 fps | 250 ms | 1 ms | 260 ms | 60 fps |

Not yet measured: a real webcam with a real person.

## How flicker is kept down

- **Detection hysteresis**: a phone that was accepted stays accepted down to half the
  confidence threshold.
- **Hold**: when detection drops out, the last mask is frozen for N frames (default 5), then
  the fill fades out over 180 ms.
- **Mask persistence**: a pixel that was phone stays masked for 150 ms, so a wobbling mask
  edge never exposes a sliver.
- **Dilation and feather** from one distance field: a round 12 px grow and an 8 px soft edge.
- **Still inpaint window**: the window given to MI-GAN only moves when the phone nears its
  edge. A window that follows the phone pixel by pixel makes the fill shimmer.
- **Fill smoothing**: while the window is still, each new fill is blended with the previous.
- The mask is applied the moment it is known, over the previous fill, so the phone stays
  covered while the next fill is computed.

## Known limitations

- **Phones seen from far away or at odd angles are missed.** The detector knows COCO's
  "cell phone" class. In one test photo a phone about 30 px tall was not found.
  `yolo11n-seg` found a dark phone in 59 % of frames of a moving test clip; `yolo11s-seg`
  found it in all of them, which is why it is the default.
- **Fingers on the phone are erased with it.** YOLO's mask includes a thumb lying on the
  screen, and the 12 px dilation removes fingertips at the phone's edge. Less dilation is not
  the answer: leftover finger fragments make MI-GAN paint skin-coloured blobs.
- **MI-GAN invents.** It was trained on scenes, not hands. When the phone fills a large part
  of its window it paints objects into the hand; keeping the hole under about 15 % of the
  window (the default) avoids most of it. Results vary with camera noise.
- **The fill is one cycle behind** (about 70 ms with MI-GAN). A fast-moving phone can peek out
  at the edges, and a phone entering the frame is visible for one cycle. "Sync display to
  fill" in the debug panel trades this for a lagging picture.
- **After a phone leaves, the patch lingers** for about half a second (hold, then fade).
- **640×480** processing and display resolution.
- **Without WebGPU** it still runs (CPU, in a worker so the camera view stays smooth), but the
  fill updates only 2 to 4 times a second.
- The camera is assumed to be static, but nothing uses that yet (no background memory).

## Structure

```
src/
  main.ts            start-up, display loop, keys
  pipeline.ts        camera frame → detector → mask → effect, on its own async loop
  camera.ts          webcam and stand-in frame sources
  detect/yoloSeg.ts  YOLO11-seg inference and mask decoding
  mask/              temporal stabiliser, distance field, inpaint-window tracker
  effects/           Effect interface; remove.ts is the erase effect
  fill/              Fill interface; migan.ts, telea.ts, stylised.ts
  runtime/ort.ts     onnxruntime-web set-up (WebGPU, CPU fallback)
  ui/panel.ts        debug panel
  still.ts           still-image test page
```

To add a mode (phone inflating, and so on), implement `Effect` in `src/effects/` and pass it
to the `Pipeline` in `main.ts`; camera, detection and mask stabilisation are reused as they
are. To add a fill, implement `Fill` and register it in `src/fill/index.ts`.

## GitHub Pages

```bash
npm run build
```

`dist/` is a static site with relative paths, so it works from a project sub-path. It
contains the models (about 145 MB in all), which are not in git, so publish the built
`dist/` folder rather than building on GitHub. Pages cannot send the cross-origin isolation
headers; that only affects the CPU fallback (single-threaded there). The camera needs https,
which Pages provides.

## Licences of the parts

MI-GAN weights: MIT. onnxruntime-web: MIT. OpenCV.js: Apache 2.0. Ultralytics YOLO11 code and
weights: AGPL-3.0, which matters if the built site is published.
