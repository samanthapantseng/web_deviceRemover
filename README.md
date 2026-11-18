# Device Remover

A live camera view in which phones are erased from people's hands, leaving the empty pose.
A second mode, **grow**, does the opposite: the phone inflates (see "Grow mode").

It runs in the browser, in one of two ways (see "Two ways to run it"): on the Mac alone with
its webcam, or with an iPad as camera and screen while the Mac does the work. Either way no
frame leaves the local network, and nothing is saved unless you press the snapshot key.

```
camera → YOLO11-seg (phone-like objects) → tracker (watch 1.5 s, then decide) → mask stabiliser
       → remove: fill (MI-GAN / Telea / stylised) → composite
       → grow:   the phone's mask + the hand on it → draw it bigger, growing over time
```

## Setup

Needs Node 20+ and Chrome (WebGPU). The models are not in the repository; fetch them once:

```bash
npm install
```

```bash
npm run models
```

`npm run models` needs `curl` and [`uv`](https://docs.astral.sh/uv/). It downloads MI-GAN
(30 MB, checksum verified) and exports the YOLO models, into `public/models/`.

## Two ways to run it

All commands are typed in Terminal on the Mac, in the project folder
(`cd` into it first). Ctrl-C in a Terminal window stops what runs there.

| | Mac only | iPad streaming |
|---|---|---|
| camera | the Mac's webcam | the iPad's camera |
| picture shown on | the Mac's screen | the iPad's screen |
| models run on | the Mac | the Mac |
| Terminal windows | one | two |
| open on the Mac | <http://localhost:5173/> in Chrome | opens by itself |
| open on the iPad | – | `https://<Mac's address>:8443/stream.html` in Safari |

### Mac only (the laptop's webcam)

1. Terminal: start the server and leave the window open.

   ```bash
   npm run dev
   ```

2. In Chrome on the Mac, open <http://localhost:5173/> and allow the camera.

`F` for fullscreen, `D` for the debug panel (see "Keys").

### iPad streaming (the iPad's camera and screen, the Mac does the work)

The iPad only films and shows; the Mac runs the models and sends the finished picture back.
Before the first time, the iPad and the Mac each have to trust the project's certificate once:
the iPad as in "Testing on the iPad" (steps 1 to 3), the Mac as in "Streaming mode" (Keychain
Access).

1. **Terminal window 1, the server.** Start it and leave the window open:

   ```bash
   npm run dev:ipad
   ```

   Wait until it says `ready`. Note the address after `Network:`, for example
   `https://10.21.12.136:8443/`: that is the Mac's address on this Wi-Fi.

2. **Terminal window 2, the Mac's processing window.** Open a second Terminal window (⌘N),
   `cd` into the project folder again, and run:

   ```bash
   npm run stream:mac
   ```

   A Chrome window opens and says "waiting for the iPad…". (A privacy warning there means the
   Mac does not trust the certificate yet: **Advanced → Proceed to localhost** works for now.)
   Leave this window open and visible; the fill mode is changed here (`1` `2` `3`, `D` for the
   panel).

3. **On the iPad**, on the same Wi-Fi as the Mac: in Safari, open the address from step 1 with
   `stream.html` added, for example `https://10.21.12.136:8443/stream.html`, and allow the
   camera. After a few seconds the picture appears, phones removed. Double-tap for the iPad's
   own small panel (it has Screenshot and Record buttons).

To stop: Ctrl-C in both Terminal windows. The address changes on another network; step 1 always
prints the current one. If port 8443 is already taken (another `npm run dev:ipad` running),
use another port in both windows and on the iPad:

```bash
npm run dev:ipad -- --port 8444
```

```bash
PORT=8444 npm run stream:mac
```

More on how it works, what to do when it freezes, and the numbers: "Streaming mode" below.
The iPad can also run everything on its own, without the Mac, but the 2018 iPad Pro is too slow
for that: see "Testing on the iPad".

## Keys

| Key | |
|---|---|
| `G` | mode: remove ↔ grow |
| `1` `2` `3` | fill mode: MI-GAN, Telea, stylised (press `3` again to step through blur / flat / void) |
| `M` | mask overlay: mask in magenta, erased objects in yellow, objects being watched in orange (dashed), objects decided against in grey (dashed), inpaint window in cyan |
| `S` | snapshot: before and after of the same frame, side by side, as a PNG download |
| `V` | screen recording on / off: only the "after" picture, as an MP4 download (see below) |
| `F` | fullscreen |
| `D` | debug panel |
| `X` | mirror |
| double-tap | debug panel, on a touch screen (it has buttons for snapshot, recording and fullscreen) |

**Screen recording** (`V`, or **Record** in the panel; the button then reads **Stop recording
· 0:12**). It records only the "after" picture as it is on screen, mirrored as shown, the whole
frame (640×480), without the mask overlay (`M`) or the panel, as an MP4 at about 4 Mb/s (30 MB
a minute). A small red **REC 0:12** shows in the bottom-left corner while recording. On stop it
downloads to Downloads; **Save last recording** in the panel saves it again (until the next
recording starts). It stops and saves by itself after 5 minutes (`?recordMax=<seconds>`
changes that). The iPad stream page has the same button (see "Screen recording on the iPad").
In streaming mode, the Mac page's own Record records the Mac's picture, which is not mirrored
there.

The debug panel shows display fps, pipeline fps, detection / mask / effect times (effect: the
inpainting, or in grow mode the cutting out), the mode with its backend or current size, and
what the tracker is watching (e.g. `#4 watching 1.2/1.5 s · 80 %`: object 4, seen for 1.2 s,
looked like a phone in 80 % of its frames). It has the mode (remove / grow), the grow
settings, sliders for confidence, watch time, the share of frames needed, dilation, feather,
hold frames, mask persistence, inpaint crop size and fill smoothing, and a front / back camera
choice (for a tablet).
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

## Streaming mode (the iPad's camera and screen, the Mac does the work)

Plan B for the exhibition. The iPad only films and shows; the Mac runs the models at its own
speed. The iPad sends its camera to the Mac, and the Mac sends the finished picture back:

```
iPad, Safari: /stream.html                      Mac, Chrome: /?source=stream
  camera ───────── video ───────────────────────▶ the same pipeline as always
  screen ◀──────── video ──────────────────────── the finished picture
```

The two pages connect directly with WebRTC, the technology video calls use, on the local
network only: no internet, no outside servers. The dev server only introduces them to each
other. Nothing is recorded. The iPad never shows its own raw camera; it shows only what comes
back from the Mac, so phones stay hidden even while things start up.

**Start it** as in "Two ways to run it" above. Mac and iPad have to be on the same network; your
own small travel router or a phone hotspot is better than venue Wi-Fi (see below). The order
does not matter, and either side can be reloaded at any time: the iPad reconnects by itself. Settings for the fill and the detector are made on the Mac (`D` for the panel). On the
iPad, double-tap for its own small panel: screenshot, screen recording, camera front/back,
mirror, fill the screen, reconnect, and the connection's numbers.

**Screenshot on the iPad**: the panel's first button (or `S` on a keyboard). The same picture
as `S` on the Mac: before and after of the same frame, side by side, the whole camera frame
(not cropped to the screen), each half mirrored like the iPad shows it. The Mac makes it and
sends it back over the same direct connection as the video (not through the dev server). A
short white flash confirms the tap; a moment later Safari's share sheet opens: **Save Image**
puts it in Photos, **AirDrop** sends it to the Mac. If Safari decides the tap was too long ago
to open the sheet, a **Screenshot ready · tap to save** button appears at the bottom; tap it.
Where there is no share sheet, it downloads instead (Files → Downloads). It needs the
connection to the Mac; without one, the iPad says so.

**Screen recording on the iPad**: **Record** in the panel (or `V` on a keyboard); the same
button then reads **Stop recording · 0:12**. It records only the "after" picture, what the iPad
shows, mirrored as shown, the whole frame (640×480), as an MP4 at about 4 Mb/s (30 MB a
minute). It is recorded on the iPad itself, so nothing extra goes over the network. While
recording, a small red **REC 0:12** shows in the bottom-left corner, quiet like the reconnect
indicator. On stop the file downloads (Safari asks first; it goes to Files → Downloads). If no
download happened, **Save last recording** in the panel saves it again (until the next
recording starts). A recording stops and saves by itself after 5 minutes, so a forgotten one
cannot fill the iPad's memory (`?recordMax=<seconds>` on the page's address changes that). During
a reconnect the recording holds the last picture.

**Once, on the Mac:** WebGPU needs a page Chrome trusts, so the Mac has to trust the same
certificate authority the iPad does (`npm run stream:mac` says when it doesn't). Open
**Keychain Access**, drag in `~/Library/Application Support/Device Remover/certs/device-remover-ca.pem`,
double-click **Device Remover local CA**, open **Trust**, set **When using this certificate** to
**Always Trust**, close the window and enter your password. (For a quick test, clicking
**Advanced → Proceed to localhost** on the warning also works.)

**The Mac's window** must stay open and should stay visible: Chrome slows down hidden windows,
and the iPad would then freeze. `npm run stream:mac` opens it in a separate Chrome profile with
that slowing-down switched off, and keeps the Mac awake while it runs. Keep the Mac on power.

**If it doesn't connect, or freezes:**

- The iPad's panel shows the connection's numbers. The Mac's terminal prints both pages'
  numbers every 30 s (`link …`) and every connection made (`[stream] …`).
- Without a picture, the iPad holds the last one, and after 3 s a small orange dot appears
  bottom right. It tries again after 1, 2, 4 and then every 5 s, for as long as it is open.
- It repairs itself: the Mac tells the iPad when nothing arrives from it any more, the iPad
  restarts its camera if the camera stops delivering, and as a last resort the iPad page
  reloads (when the Mac has asked three times in 30 s).
- So that a reload never brings back Safari's camera question with nobody there to answer it:
  on the iPad, **Settings → Apps → Safari → Camera → Allow** (or, for this site only, the page
  menu in Safari's address bar → Website Settings → Camera → Allow).
- The codec is H.264 by default (hardware on both devices). If the picture stutters or freezes
  repeatedly, try `?codec=vp8` on the iPad's address; the Mac follows.
- Venue and university Wi-Fi often stop devices from reaching each other, and at an exhibition
  the Wi-Fi is full of visitors' phones. Your own router (no internet needed) avoids both.
- Anyone on the same network who opens the stream page takes over the Mac's picture (the newest
  page wins). Another reason for your own network.
- `?latency` on the iPad's address measures the round trip with a counter in the corner
  (shown in its panel and the terminal). Only for testing: the counter is visible.

**Measured on this Mac** (both pages in headless Chrome on the M2 Max, a video file as the
iPad's camera, VP8; Wi-Fi not included):

| | MI-GAN | Telea | Stylised |
|---|---|---|---|
| frames shown on the "iPad" | 30 fps | 28 fps | 30 fps |
| fill updates on the Mac | 13.6 fps | 28.7 fps | 30.1 fps |
| round trip iPad → Mac → iPad, median (95 %) | 68 ms (86) | 68 ms (101) | 68 ms (84) |

Picture back after: iPad page reloaded 0.3 s; connection dead without notice 4.6 s; the iPad
stopped sending (only the Mac can notice) 4.7 s; Mac page reloaded 0.6 s; Mac page closed for
10 s and reopened 1.1 s. A camera restart on the iPad keeps the connection.

**Test on the real iPad**, and note what you see:

1. Start it as above, with the iPad on the network you will use (or as close to it as you can),
   and Safari's camera permission set to Allow (see above).
2. Look: does a phone disappear? How does the lag feel when you wave? Is the picture sharp
   enough on the 12.9" screen?
3. Break it: reload the iPad page; turn the iPad's Wi-Fi off for 10 s and on again; reload the
   Mac page; leave it running for 30 min.
4. Once, add `?latency` to the iPad's address, for the round-trip number.
5. For the show: Guided Access on the iPad (Settings → Accessibility → Guided Access) keeps
   Safari in front. Restart the Mac before, and open only what the piece needs: when the Mac
   ran out of memory in a test (many apps open, 19 days without restart), the stream slowed to
   a fill update every second or so.

The numbers end up in the Mac's terminal and in `captures/device-report.jsonl`.

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
- **Live view on a still image**: `http://localhost:5173/?src=captures/x.png`. Add
  `&mode=grow` (or `&mode=remove`) to start in that mode without changing the saved setting.
- The still page also shows grow mode, fully grown: mask + hand, the mask with finger gaps
  filled, the exact mask, the convex outline and the rectangle.
- **Headless check**: plays a clip as a fake webcam in the installed Chrome and prints
  timings for every fill mode.

```bash
bash scripts/make_test_clip.sh captures/some_photo.png
```

```bash
npm run check -- captures/clip_moving.y4m
```

- `?backend=wasm` forces the CPU fallback; `?model=yolo11n-seg` tries another detector.
- The check ends with grow mode (full size in 3 s) and writes `captures/check_grow_sheet.jpg`:
  4 views a second apart while it grows, then 4 consecutive views at full size.

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

## Grow mode

`G` (or "Mode" in the panel) switches between remove and grow. In grow mode nothing is
erased: once the tracker has decided on a phone (the same watching as above), the phone is
drawn bigger on top of the picture, around its own centre, fingers lying on it included. It
starts at its real size (1×) and inflates to 2× over 5 s (smooth start and end), each phone
counted from when it was picked; switching to grow mode starts every phone from 1× again.
When the phone is put away, it shrinks back and fades out in 0.25 s. All of it is in the
panel ("Grow: …").

"Grow: shape" decides what is enlarged:

- **precise mask + hand (person mask)** (default): as the next one, plus the hand holding the
  phone, taken from the "person" mask the detector computes in the same pass. It starts from
  the person pixels that cover the phone (at least 5 % of the phone's length inside its
  outline, where the phone itself is not: fingers on it) and spreads through the person mask,
  but only within "Grow: hand reach" (25 % of the phone's length) in a straight line from
  those fingers, fading out over the last 40 %. A face or body next to the phone is not in
  front of it, so it does not start there; where it touches the hand within the reach, it
  comes along faded.
- **precise mask + fingers on it**: the detector's own mask of the phone, with its
  precise, soft edge, and the dents fingers make in it filled with the fingers that are there.
  The filling is a morphological closing (grow the mask by a radius, shrink it back by as
  much): every dent narrower than about twice the radius is filled, the rest of the outline
  stays exactly as it was. "Grow: fill finger gaps" sets the radius as a share of the phone's
  size (15 %); at 0 it is the exact mask, with notches where fingers cover the phone.
- **convex outline + fingers on it**: the mask's convex hull. A phone is a rounded rectangle,
  so this comes out close to the rectangle, with a straight line where the hand leaves it.
- **rectangle + fingers on it**: the smallest rotated, round-cornered rectangle around the
  mask; a phone seen at an angle takes in some background at a corner.

How it works (`src/effects/grow.ts`):

- **No inpainting.** A bigger copy around the phone's own centre covers the real phone, so
  MI-GAN is not needed and not even loaded until remove mode is switched on. The effect costs
  1–3 ms a frame for the mask, 4–11 ms with the hand (bigger for a phone close to the camera);
  the pipeline stays at 22–29 fps.
- **The picture is always the current frame.** Only the shape is smoothed over frames ("Grow:
  shape smoothing", 0.5: the mask, or the outline / rectangle), so a moving phone does not
  smear, and the drawn position follows the phone smoothly instead of jumping at the
  detector's rate.
- **Smooth edge.** The detector's mask is normally on/off per pixel; enlarged, every step
  would show. In grow mode the detector also returns an anti-aliased mask, computed from the
  model's own mask values. Convex outline and rectangle are clip paths, sharp at any size.
- **The whole phone.** The model cuts its mask off at the phone's box, which is sometimes a
  little tight. In grow mode the mask is painted 8 % beyond the box. Holes in the mask are
  filled and specks (pieces under 5 % of it) are left out.
- **Several phones**: each grows on its own clock; the biggest is drawn first, so one that has
  only just been picked stays visible on top.

Limits:

- **The person mask is the whole person.** With the hand shape, a face, hair or body touching
  the hand close to the fingers comes along (faded) within the reach; a smaller reach keeps
  less of the hand and less of the rest. Untested: a phone held in front of the body, where
  the person mask is all around it.
- **Without the hand shape, only fingers over the phone grow**, and only where they make a
  dent narrower than the fill: where the whole hand covers a long stretch of the phone's edge
  (four fingers side by side), the outline follows the hand.
- **The hand disappears** where the giant phone covers it.
- **At 1× the real phone can peek out** when the hand moves: the copy is the same size as the
  phone and one detector cycle (about 35 ms) behind it. This goes away as it grows.
- **Soft when big.** The camera picture is 640×480, so the enlarged phone is an enlarged
  low-resolution image.
- The hand shape is tested on photos (two webcam stills of the user, two stock photos) and the
  moving test clip, not yet live with a real person.

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
  effects/           Effect interface; remove.ts erases the phone, grow.ts inflates it
  fill/              Fill interface; migan.ts, telea.ts, stylised.ts
  runtime/ort.ts     onnxruntime-web set-up (WebGPU, CPU fallback)
  ui/panel.ts        debug panel
  still.ts           still-image test page
  devReport.ts       iPad mode only: sends timings and errors to the Mac's terminal
  stream/            streaming mode: ipad.ts (the iPad's page), remoteSource.ts (the Mac's
                     side), link.ts (WebRTC set-up, statistics), signal.ts, latency.ts,
                     shots.ts (the iPad's before/after screenshot, made on the Mac)
  recorder.ts        screen recording of the "after" picture (Mac page and iPad stream page)
server/
  signalHub.ts       streaming mode: introduces the two pages to each other (dev server only)
stream.html          streaming mode: the iPad's page
scripts/
  make_cert.sh       https certificate for npm run dev:ipad
  stream_mac.sh      streaming mode: opens the Mac's page (npm run stream:mac)
  stream_check.mjs   streaming mode, tested on this Mac (npm run check:stream)
```

To add a mode, implement `Effect` in `src/effects/`, add it to `ModeId` in `settings.ts` and
to `effectFor` in `main.ts`; camera, detection, tracker and mask stabilisation are reused as
they are. To add a fill, implement `Fill` and register it in `src/fill/index.ts`.

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
