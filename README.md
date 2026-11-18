# Device Remover

A live camera view in which phones are erased from people's hands, leaving the empty pose.
Critical-design prototype (v0, laptop webcam), inspired by Jonah Brucker-Cohen's *Device Inversions*.

Everything runs in the browser, on the device. No frame leaves the machine, and nothing is
saved unless you press the snapshot key.

```
camera → YOLO11-seg (phone-like objects) → tracker (watch 1.5 s, then decide) → mask stabiliser
       → fill (MI-GAN / Telea / stylised) → composite
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
| `M` | mask overlay: mask in magenta, erased objects in yellow, objects being watched in orange (dashed), objects decided against in grey (dashed), inpaint window in cyan |
| `S` | snapshot: before and after of the same frame, side by side, as a PNG download |
| `F` | fullscreen |
| `D` | debug panel |
| `X` | mirror |
| double-tap | debug panel, on a touch screen (it has buttons for snapshot and fullscreen) |

The debug panel shows display fps, fill fps, detection / mask / inpaint times, the active
backend and what the tracker is watching (e.g. `#4 watching 1.2/1.5 s · 80 %`: object 4, seen
for 1.2 s, looked like a phone in 80 % of its frames). It has sliders for confidence, watch
time, the share of frames needed, dilation, feather, hold frames, mask persistence, inpaint
crop size and fill smoothing, and a front / back camera choice (for a tablet).
Settings are remembered in the browser. The screen is kept awake while the page is open.

## Testing on the iPad

The iPad runs the same page in Safari; the Mac only serves the files. Safari allows the camera
only on `https` pages, so the Mac serves the page over https on the local network, with a
certificate the iPad has been told to trust.

On the Mac, in a second terminal (`npm run dev` can keep running for the Mac):

```bash
npm run dev:ipad
```

It prints the address for the iPad, e.g. `https://Samanthas-MacBook-Pro.local:8443/`.

**Once, the first time:** the command creates a certificate authority for this Mac and shows
its certificate, `device-remover-ca.pem`, in Finder (it lives in
`~/Library/Application Support/Device Remover/certs/`). Install it on the iPad:

1. AirDrop `device-remover-ca.pem` to the iPad (or email it to yourself and open the attachment).
2. iPad: **Settings → Profile Downloaded** (near the top) → **Install**, enter the passcode,
   **Install** again.
3. iPad: **Settings → General → About → Certificate Trust Settings** → turn on
   **Device Remover local CA**.

This certificate authority can only vouch for `.local` names and private network addresses,
so it cannot be misused to impersonate real websites. To undo: on the iPad, Settings → General
→ VPN & Device Management → the profile → Remove; on the Mac, delete the
`Device Remover` folder in Application Support.

**Then, every time:** iPad and Mac on the same Wi-Fi, open the printed address in Safari and
allow the camera. Double-tap the picture for the panel. The still test is at `/still.html`; its
captures land in `captures/` on the Mac.

While the iPad is connected, its timings, errors and status messages (never images) are printed
in the Mac's terminal and appended to `captures/device-report.jsonl`.

If the page does not load:

- Try the `Network` address Vite prints (`https://10.…:8443/`) instead of the `.local` name.
- University and venue Wi-Fi often stop devices from reaching each other. Then connect both the
  Mac and the iPad to an iPhone's Personal Hotspot.
- A certificate warning means the trust step (3) is missing.

Turning the iPad between portrait and landscape restarts the page in the new orientation.
Snapshots are saved to Downloads in the Files app.

**What to expect on the iPad Pro 12.9" (2018, A12X).** WebGPU works in Safari there, but the
models run 25 to 40 times slower than on the M2 Max: with the default detector, finding the
phone took 0.5 to 1.1 s per frame, MI-GAN 0.2 to 0.55 s, Telea about 0.1 s. With every fill
loaded at once, Safari closed the page after 10 to 20 s (most likely out of memory); now only
the fill in use is loaded. Lighter settings to try on the iPad, in the panel:
**Detector: yolo11s · 320** and **Fill: Telea** or **Stylised**.

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

The light variants for slower devices are the same models exported with `imgsz=320`, saved as
`yolo11s-seg-320.onnx` and `yolo11n-seg-320.onnx`. The detector reads the input size from the
model. On the test clip `yolo11s-seg-320` found the phone as reliably as the 640 version, with
a quarter of the work; `yolo11n-seg-320` found it in only 11 % of frames.

To check what a model expects:

```bash
uv run --python 3.12 --with onnx python scripts/inspect_onnx.py public/models/migan.onnx
```

## Testing without standing in front of the camera

- **Still test page**: <http://localhost:5173/still.html>. Capture a webcam frame (3 s
  countdown) or open an image; it runs detection and every fill once and times each step.
  With `npm run dev`, a webcam capture is also written to `captures/` (gitignored).
  `?img=captures/x.png&model=yolo11n-seg&cropSize=400` and similar parameters are accepted.
- **What the detector makes of your captures**: type what you are holding in the field on the
  still page before capturing (e.g. `book`), then run `npm run stills`. It lists every
  `captures/still-*.png` with its phone score with and without the top-category check, and
  what the model really thinks the turned-away objects are.
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

Not yet measured: a real webcam with a real person, and the iPad.

## Watching before erasing

Nothing is erased the moment it is detected. Each object that looks even slightly like a
phone (phone score at least half the threshold) is followed from frame to frame, also while it
moves (`src/detect/tracker.ts`). Every processed frame casts a vote: "phone" if "cell phone" is
its top category and scores at least the confidence threshold (0.70), otherwise "not phone";
a frame in which the object is not found also counts as "not phone".

- **Watching**: a new object is left alone for 1.5 s ("Watch a new object for" in the panel).
- **Deciding**: then it is erased if at least 67 % of its frames over the last 1.5 s said phone
  ("Erase if phone in at least").
- **Staying erased**: from then on it is erased in every frame it is found in, whatever that
  frame's score, until fewer than half that share (33 %) of its last 1.5 s say phone. Half, so
  an object right at the bar does not switch on and off. (The look-back is the watch time, but
  at least 1 s.)
- **Short losses**: an object out of sight for up to 1 s (a hand passing in front) keeps its
  status. After longer, it is forgotten, and if it comes back it is watched again from the start.

So every phone stays visible for about 1.5 s after it appears or comes back. A look-alike that
scores high for under about 1 s and then drops is never erased; one that stays high for longer
than two thirds of the watch time is. Setting the watch time to 0 erases at
once (the earlier behaviour, without the earlier blinking).

## How flicker is kept down

- **Per-object decisions**: see above. An erased object stays erased through frames where its
  score dips, and a look-alike's brief high score does not erase it.
- **Hold**: when detection drops out, the last mask is frozen for N frames (default 5), then
  the fill fades out over 180 ms.
- **Mask persistence**: a pixel that was phone stays masked for 150 ms, so a wobbling mask
  edge never exposes a sliver.
- **Dilation and feather** from one distance field: a round grow (default 0 px, which worked
  best on the real camera) and an 8 px soft edge.
- **Still inpaint window**: the window given to MI-GAN only moves when the phone nears its
  edge. A window that follows the phone pixel by pixel makes the fill shimmer.
- **Fill smoothing**: while the window is still, each new fill is blended with the previous.
- The mask is applied the moment it is known, over the previous fill, so the phone stays
  covered while the next fill is computed.

## Known limitations

- **Phone look-alikes.** The detector is a general model (80 everyday categories). Something
  only counts as a phone if "cell phone" is its best guess among all 80 (the top-category
  check, on by default). Objects it has no category for can still come out as "cell phone":
  on the real camera, a black wallet held upright scored 0.90, next to 0.94 for a real phone,
  so no threshold separates those two. Watching (above) stops look-alikes that score high only
  for a moment; one that the model is steadily sure about, like that wallet, is still erased
  after the 1.5 s.
- **A phone is visible for its first 1.5 s** in view, and again for 1.5 s when it comes back after
  more than 1 s out of sight. A phone the model is sure about in fewer than 67 % of frames is
  not erased at all; lowering "Erase if phone in at least" lets it through, along with more
  look-alikes.
- **Phones seen from far away or at odd angles are missed.** The detector knows COCO's
  "cell phone" class. In one test photo a phone about 30 px tall was not found.
  `yolo11n-seg` found a dark phone in 59 % of frames of a moving test clip; `yolo11s-seg`
  found it in all of them, which is why it is the default.
- **Fingers on the phone are erased with it.** YOLO's mask includes a thumb lying on the
  screen. With dilation, fingertips at the phone's edge go too; without it (the default now),
  leftover phone edges can show. On a stock photo, leftover finger fragments made MI-GAN paint
  skin-coloured blobs.
- **MI-GAN invents.** It was trained on scenes, not hands. When the phone fills a large part
  of its window it paints objects into the hand; keeping the hole under about 15 % of the
  window (the default) avoids most of it. Results vary with camera noise.
- **The fill is one cycle behind** (about 70 ms with MI-GAN). A fast-moving phone can peek out
  at the edges, and with the watch time at 0 a phone entering the frame is visible for one cycle. "Sync display to
  fill" in the debug panel trades this for a lagging picture.
- **After a phone leaves, the patch lingers** for about half a second (hold, then fade).
- **640×480** processing and display resolution.
- **Without WebGPU** it still runs (CPU, in a worker so the camera view stays smooth), but the
  fill updates only 2 to 4 times a second.
- **On the 2018 iPad Pro it is too slow for the default settings** (see "Testing on the iPad").
  A fill that is picked for the first time loads on demand, so the stylised fill stands in for
  a moment.
- The camera is assumed to be static, but nothing uses that yet (no background memory).

## Structure

```
src/
  main.ts            start-up, display loop, keys
  pipeline.ts        camera frame → detector → mask → effect, on its own async loop
  camera.ts          webcam and stand-in frame sources
  detect/yoloSeg.ts  YOLO11-seg inference and mask decoding
  detect/tracker.ts  follows each phone-like object and decides whether it is erased
  mask/              temporal stabiliser, distance field, inpaint-window tracker
  effects/           Effect interface; remove.ts is the erase effect
  fill/              Fill interface; migan.ts, telea.ts, stylised.ts
  runtime/ort.ts     onnxruntime-web set-up (WebGPU, CPU fallback)
  ui/panel.ts        debug panel
  still.ts           still-image test page
  devReport.ts       iPad mode only: sends timings and errors to the Mac's terminal
scripts/
  make_cert.sh       https certificate for npm run dev:ipad
```

To add a mode (phone inflating, and so on), implement `Effect` in `src/effects/` and pass it
to the `Pipeline` in `main.ts`; camera, detection and mask stabilisation are reused as they
are. To add a fill, implement `Fill` and register it in `src/fill/index.ts`.

## GitHub Pages

```bash
npm run build
```

`dist/` is a static site with relative paths, so it works from a project sub-path. It
contains the models (about 200 MB in all), which are not in git, so publish the built
`dist/` folder rather than building on GitHub. Pages cannot send the cross-origin isolation
headers; that only affects the CPU fallback (single-threaded there). The camera needs https,
which Pages provides.

## Licences of the parts

MI-GAN weights: MIT. onnxruntime-web: MIT. OpenCV.js: Apache 2.0. Ultralytics YOLO11 code and
weights: AGPL-3.0, which matters if the built site is published.
