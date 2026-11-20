# Device Remover

A live camera view in which phones are erased from people's hands, leaving the empty pose.
A second mode, **grow**, does the opposite: the phone inflates (see "Grow mode").
A third, **hijack**, leaves the picture alone: aim the camera at someone's phone and hear
"their" soundscape in headphones, made up from what the camera sees (see "Hijack mode").

It runs in the browser, in one of two ways (see "Two ways to run it"): on the Mac alone with
its webcam, or with an iPad as camera and screen while the Mac does the work (connected over
Wi-Fi or by an Ethernet cable). Either way no frame leaves the local network, and nothing is
saved unless you take a snapshot (`S`) or a screen recording (`V`).

```
camera → YOLO11-seg (phone-like objects) → tracker (watch 1.5 s, then decide) → mask stabiliser
       → remove: fill (MI-GAN / Telea / stylised) → composite
       → grow:   the phone's mask + the hand on it → draw it bigger, growing over time
       → hijack: the phone nearest the centre → a synthesised soundscape → headphones
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

| | Mac only | iPad streaming, over Wi-Fi | iPad streaming, over an Ethernet cable |
|---|---|---|---|
| camera | the Mac's webcam | the iPad's camera | the iPad's camera |
| picture shown on | the Mac's screen | the iPad's screen | the iPad's screen |
| models run on | the Mac | the Mac | the Mac |
| iPad and Mac connected by | – | the same Wi-Fi | one Ethernet cable, an adapter on each side |
| Terminal windows | one | two | two |
| open on the Mac | <http://localhost:5173/> in Chrome | opens by itself | opens by itself |
| open on the iPad | – | `https://<Mac's address>:8443/stream.html` (it changes with the network) | `https://192.168.77.1:8443/stream.html` (always the same) |
| once, before the first time | – | certificate on iPad and Mac | the same, plus fixed addresses (see "Streaming over an Ethernet cable") |

Both streaming columns are the same streaming mode with the same commands; only the
connection between the two devices differs.

### Mac only (the laptop's webcam)

1. Terminal: start the server and leave the window open.

   ```bash
   npm run dev
   ```

2. In Chrome on the Mac, open <http://localhost:5173/> and allow the camera.

`F` for fullscreen, `D` for the debug panel (see "Keys").

### iPad streaming (the iPad's camera and screen, the Mac does the work)

The iPad only films and shows; the Mac runs the models and sends the finished picture back.
The two are connected either over Wi-Fi or by an Ethernet cable; the steps are the same, only
the address the iPad opens differs (step 3).

Before the first time, the iPad and the Mac each have to trust the project's certificate once:
the iPad as in "Testing on the iPad" (steps 1 to 3), the Mac as in "Streaming mode" (Keychain
Access). For the cable, also set the fixed addresses once ("Streaming over an Ethernet cable").

1. **Terminal window 1, the server.** Start it and leave the window open:

   ```bash
   npm run dev:ipad
   ```

   Wait until it says `ready`. The lines after `Network:` are the Mac's addresses, for example
   `https://10.21.12.136:8443/` on Wi-Fi. With the cable plugged in, one of them is
   `https://192.168.77.1:8443/`.

2. **Terminal window 2, the Mac's processing window.** Open a second Terminal window (⌘N),
   `cd` into the project folder again, and run:

   ```bash
   npm run stream:mac
   ```

   A Chrome window opens and says "waiting for the iPad…". (A privacy warning there means the
   Mac does not trust the certificate yet: **Advanced → Proceed to localhost** works for now.)
   The first time, Chrome asks at the top of this window to use the camera: click **Allow**.
   The cable needs it (see "Streaming over an Ethernet cable"); the Mac's camera itself is not
   used, and Chrome remembers the answer. Leave this window open and visible; the mode and the
   fill are changed here (`G` remove / grow, `1` `2` `3` fill, `D` for the panel).

3. **On the iPad**, in Safari, open:
   - **over Wi-Fi** (the iPad on the same Wi-Fi as the Mac): the address from step 1 with
     `stream.html` added, for example `https://10.21.12.136:8443/stream.html`;
   - **over the cable** (the iPad's Wi-Fi off): `https://192.168.77.1:8443/stream.html`.

   Allow the camera. After a few seconds the picture appears, phones removed (or growing, in
   grow mode), and Terminal window 1 prints `[stream] iPad page connected from …` with the
   iPad's address (`192.168.77.2` over the cable). Double-tap for the iPad's own small panel
   (it has Screenshot and Record buttons).

To stop: Ctrl-C in both Terminal windows. Over Wi-Fi the address changes on another network;
step 1 always prints the current one. Over the cable it stays `192.168.77.1`, so a Safari
bookmark works. If port 8443 is already taken (another `npm run dev:ipad` running), use
another port in both windows and on the iPad:

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
| `H` | hijack mode on; again: back to the mode before (see "Hijack mode") |
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
other. The stream itself is not stored anywhere; only a screenshot or a screen recording, when
you ask for one (see below), saves a file. The iPad never shows its own raw camera; it shows
only what comes back from the Mac, so phones stay hidden even while things start up.

**Start it** as in "Two ways to run it" above. Mac and iPad have to be on the same network:
the same Wi-Fi (your own small travel router or a phone hotspot is better than venue Wi-Fi, see
below), or one Ethernet cable between them (see "Streaming over an Ethernet cable"). The order
does not matter, and either side can be reloaded at any time: the iPad reconnects by itself.
Settings for the mode (remove / grow), the fill and the detector are made on the Mac (`D` for
the panel). On the iPad, double-tap for its own small panel: screenshot, screen recording,
camera front/back, mirror, fill the screen, reconnect, and the connection's numbers.

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
  the Wi-Fi is full of visitors' phones. Your own router (no internet needed) or the Ethernet
  cable avoids both.
- Anyone on the same network who opens the stream page takes over the Mac's picture (the newest
  page wins). Another reason for your own network. Over the cable, see "Who else can reach the
  Mac" in "Streaming over an Ethernet cable".
- Over the cable: see "If the cable doesn't connect" there.
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

**Measured on the real iPad** (18 Nov, real Wi-Fi, H.264, 3 Mbit/s, `?latency`): round trip
177 ms median (202 ms for 95 %). On calm Wi-Fi most of that is fixed steps: compressing and
decompressing twice, and the processing on the Mac. On uneven Wi-Fi both browsers hold frames
longer before showing them (in one session about 94 ms on the Mac and 125 ms on the iPad), and
the lag grows with it. A lower bitrate (tried from 3 down to 0.6 Mbit/s, briefly) made no
visible difference; at 640×480 the video only uses about 1.7–1.9 Mbit/s.

**Test on the real iPad**, and note what you see:

1. Start it as above, with the iPad on the network you will use (or as close to it as you can),
   and Safari's camera permission set to Allow (see above).
2. Look: does a phone disappear? How does the lag feel when you wave? Is the picture sharp
   enough on the 12.9" screen?
3. Break it: reload the iPad page; turn the iPad's Wi-Fi off for 10 s and on again (over the
   cable: pull the cable out for 10 s and plug it back in); reload the Mac page; leave it
   running for 30 min.
4. Once, add `?latency` to the iPad's address, for the round-trip number.
5. For the show: Guided Access on the iPad (Settings → Accessibility → Guided Access) keeps
   Safari in front. Restart the Mac before, and open only what the piece needs: when the Mac
   ran out of memory in a test (many apps open, 19 days without restart), the stream slowed to
   a fill update every second or so.

The numbers end up in the Mac's terminal and in `captures/device-report.jsonl`.

## Streaming over an Ethernet cable

The same streaming mode, with a cable instead of Wi-Fi:

```
iPad ── USB-C Ethernet adapter ── Ethernet cable ── USB-C Ethernet adapter ── Mac
192.168.77.2                                                         192.168.77.1
```

No router, no Wi-Fi, no internet: the two devices are a network of their own. Tested on 20 Nov
with the real iPad: the picture comes through, and a ping over the cable takes about 1.5 ms
(the link runs at 1 Gbit/s).

What changes compared with Wi-Fi:

- The venue's Wi-Fi no longer matters: no network that stops devices from reaching each other,
  no visitors' phones crowding it.
- None of Wi-Fi's unevenness, which made both browsers hold frames longer (about 94 ms on the
  Mac and 125 ms on the iPad in one session, see "Measured on the real iPad" above). How much
  lag this saves on the real iPad has not been measured yet: add `?latency` to the iPad's
  address to measure it.
- What stays is the fixed part of the lag: compressing and decompressing twice, and the
  processing (about 70–100 ms round trip in the test on this Mac, without any network).

### What you need

- **One Ethernet cable** (also called LAN or network cable; any "Cat 5e" or "Cat 6"). Ethernet
  works up to 100 m, so the Mac can be further from the iPad than a USB cable allows.
- **For the iPad: a USB-C to Ethernet adapter.** The iPad has one USB-C port, so an adapter
  that also has a USB-C charging socket ("PD", "Power Delivery", "pass-through charging") lets
  it charge at the same time; then use a charger of 30 W or more, since the adapter takes part
  of the power. Without one, the iPad runs on its battery.
- **For the Mac: a USB-C to Ethernet adapter** (this MacBook Pro has no Ethernet port). The one
  tested shows up in macOS as **AX88179B**, the chip inside it.

With its adapter plugged in, the iPad's Settings show an **Ethernet** entry below Wi-Fi. Once
the cable is in at both ends, the small lights on the adapters' sockets usually come on.

### Once: fixed addresses

Without a router, nothing hands out addresses on the cable, and the ones the devices then pick
for themselves (169.254.x.x) are not covered by the certificate. So each gets a fixed address,
set once. The setting belongs to the adapter: a different adapter needs it again.

**On the Mac:** System Settings → Network → the adapter (**AX88179B**) → Details… → TCP/IP →
Configure IPv4: **Manually**. IP address `192.168.77.1`, subnet mask `255.255.255.0`, router
left empty → OK.

**On the iPad:** Settings → Ethernet → the adapter → Configure IP → **Manual**. IP address
`192.168.77.2`, subnet mask `255.255.255.0`, router left empty → Save. Turn the iPad's
**Wi-Fi** off, so the cable is its only connection.

The router stays empty on both, so the Mac keeps using its Wi-Fi for the internet. To check the
cable, on the Mac:

```bash
ping -c 3 192.168.77.2
```

Three replies of a millisecond or two mean the cable works.

### Each time

As in "Two ways to run it": both Terminal windows, then, on the iPad with its Wi-Fi off,
`https://192.168.77.1:8443/stream.html`. The cable can be plugged in before or after the server
starts: the certificate always includes `192.168.77.1`.

### Why the Mac's window asks for the camera

Chrome lets a page use all of the Mac's network connections for WebRTC only if the page may use
the camera. Without that permission it offers only the connection the Mac uses for the
internet, usually Wi-Fi, which the iPad on the cable cannot reach. The first try over the cable
failed exactly so (20 Nov): the iPad page loaded, but no picture came. So the Mac's page asks
for the camera, puts it away at once, and never uses it.

The answer is remembered in the stream window's own Chrome profile, so it asks only once (once
per port: with `PORT=8444` it asks again). When it asks, Terminal window 1 prints the result:
`camera permission granted: the Ethernet cable can be used`, or `no camera permission …` /
`camera permission blocked …`. Over Wi-Fi the stream works either way.

If **Block** was clicked by mistake: stop the window (Ctrl-C in Terminal window 2), delete its
profile, and start it again; it asks again. This also resets the settings made in that window
(mode, fill, sliders) to their defaults.

```bash
rm -rf ~/Library/Application\ Support/Device\ Remover/chrome-stream
```

### Who else can reach the Mac

Over the cable, only the iPad is on that network. But as long as the Mac is also on Wi-Fi, the
server answers there too: someone on that Wi-Fi who opens the stream page would take over the
picture (the newest page wins). With the Mac's Wi-Fi off, the cable is its only network; the
piece needs no internet. The stream with the Mac's Wi-Fi off has not been tried yet.

### If the cable doesn't connect

- **No Ethernet entry in the iPad's Settings:** the iPad does not see its adapter. Unplug it
  and plug it in again. Some adapters power their Ethernet part only when a charger is
  connected to them.
- **`ping -c 3 192.168.77.2` gets no replies:** push both plugs in until they click and check
  the lights, then the fixed addresses above (both masks `255.255.255.0`, the iPad's Wi-Fi off).
- **`npm run dev:ipad` does not list `https://192.168.77.1:8443/`:** the Mac does not have the
  address at the moment (cable out, or the Mac's setting above). The server need not be
  restarted; the iPad can connect once the address is there.
- **The page loads on the iPad but no picture comes:** see the camera permission above.
  Terminal window 1 shows `[stream] iPad page connected from 192.168.77.2`, and then
  `[Mac Chrome] status: link failed`.
- **Other addresses:** if `192.168.77.x` is already used by another network on the Mac, pick
  another private range, for example Mac `192.168.78.1` and iPad `192.168.78.2`, and start the
  server with `DEVICE_REMOVER_WIRED_IP=192.168.78.1 npm run dev:ipad` so the certificate always
  includes it. It has to be a private address (`10.x`, `172.16.x`–`172.31.x` or `192.168.x`):
  those are the only ones the certificate authority can vouch for.

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
  `&mode=grow`, `&mode=hijack` (or `&mode=remove`) to start in that mode without changing the
  saved setting.
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
- **Hijack check**: the same fake webcam, with the sound measured instead of heard (see
  "Hijack mode"); also writes the five characters as sound files to `captures/`.

```bash
npm run check:hijack -- captures/clip_moving.y4m
```

## Measured performance

MacBook Pro M2 Max, Chrome 157 (headless, 640×480 @ 30 fps clip as camera), production build,
yolo11s-seg. The same pipeline in a visible Chromium window displayed at 120 fps.

| Fill | Fill updates | Detect | Mask | Inpaint | Display |
|---|---|---|---|---|---|
| MI-GAN (WebGPU) | 14.8 fps | 23 ms | 0.6 ms | 42 ms | 60 fps |
| Telea (OpenCV.js) | 29.8 fps | 23 ms | 0.6 ms | 8 ms | 60 fps |
| Stylised (canvas) | 29.9 fps | 24 ms | 0.7 ms | 0.9 ms | 60 fps |
| MI-GAN, no WebGPU | 2.1 fps | 250 ms | 1 ms | 260 ms | 60 fps |

Not measured this way: a real webcam with a real person. The iPad: see "Testing on the iPad"
(on its own) and "Streaming mode" (with the Mac).

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
- The hand shape is tested on photos (two webcam stills, two stock photos) and the moving test
  clip, not yet live with a real person.
- Not yet tested in streaming mode. The Mac runs grow mode the same way there (the same
  pipeline); the iPad only shows the result.

## Hijack mode

`H` (or "Mode" in the panel) switches it on; `H` again goes back to the mode before. So far
for the Mac on its own (its webcam, headphones on the Mac); not tried in streaming mode.

Aim the camera at someone's phone and hear "their" soundscape in headphones. Nothing is
intercepted: the sound is synthesised in the browser (Web Audio, no recordings) from a few
things the camera sees of the phone. The picture stays as it is, with a faint dashed circle in
the middle, the **focus zone**, and a white ring around the phone being listened to ("Hijack:
show focus zone and ring" in the panel turns both off).

**Sound only after a click.** Browsers play sound only after a click or key press on the page.
Until then a note says "click or press any key for sound". Pressing `H` counts.

**What is heard**

- **Silence**, unless a phone is in focus. A phone is in focus once the tracker has decided on
  it (the same watching as in the other modes, but for 0.5 s instead of 1 s: "Hijack: watch a
  new phone for") and it has been inside the focus zone for 0.25 s.
- Then the person's sound **breaks in**, over 0.8 s: a digital signal coming through in
  bursts, coarse and thin, over the low rumble of the carriage. Then it **seals**: the rumble is
  cut off with a soft thump, a short hiss like noise cancelling closing in, and the sound opens
  up.
- It is **already playing**: each person's sound has been going since before the camera saw
  them (a random 0–2 minutes, fixed per person), so it is joined mid-phrase, and when you come
  back to the same person it has moved on without you.
- **The edge of the zone is the leak, the centre is inside their head.** At the edge you hear
  what leaks out of someone's earbuds: a small speaker pushed hard (no bass, a strained buzz,
  the hiss of the top), quiet, placed where the phone is, with some room around it. Towards the
  centre it becomes what they hear: full, with a little extra bass, dry, and in the middle of
  your head.
- When focus leaves, you are **pushed out**: the sound is shut off like a door (muffled and
  much quieter at once), keeps playing behind it while it fades, and the rumble of the
  carriage comes back for a moment before the silence.
- Each person gets one of five **characters**, dealt in turn (two people in a row never get the
  same one), each with its own key, tempo and pattern:
  - **low drone**: detuned saws and a sub, breathing slowly through a filter
  - **soft pulse**: a slow repeating figure of soft notes with an echo
  - **noise wash**: filtered noise swelling and receding like breath or surf, over a rumble
  - **bell plucks**: sparse, irregular bell notes with an echo, like far-off notifications
  - **muffled headphone beat**: kick, snare, hi-hat and bass
- "Hijack: sound" in the panel gives everyone the same character instead (to try them out).
  **Test sound** in the panel plays one for 5 s without a phone: each press the next one, or
  the one chosen there.

**What the camera changes in the sound**

| from the camera | in the sound |
|---|---|
| how close the phone is to the centre of the zone | from the leak (edge) to inside their head (inner 30 %), gradually |
| where it is, left to right | at the edge: left to right in the headphones, as on screen (with the mirror on, `X`, as in a mirror); towards the centre it moves into the middle of your head |
| how big it is in the picture | close: louder; far: quieter, and at the edge with more room |
| how long it has been held | more layers (a fifth, higher notes, the bass, a longer echo), full after 30 s ("Hijack: holding time to full build-up") |
| how much it moves | busier rhythm, faster tremolo and swells (under half a phone length a second counts as still) |

**Focus** (`src/effects/hijack.ts`):

- The phone in focus stays in focus while it is inside the zone (with 25 % slack), and for 2 s
  after it is lost ("Hijack: keep sound when phone lost"), so a detection dropout does not cut
  the sound. Then you are pushed out (above).
- Another phone takes over only when it is clearly more centred (by a quarter of the zone's
  radius) for 0.6 s, and not within 1.5 s of the last switch.
- Leaving hijack mode pushes you out too; so does the camera stopping (no new frame for 3 s).
- "Hijack: focus zone (radius)" sets the zone's size (default: 30 % of the picture height).

**Volume and safety.** "Hijack: volume" in the panel (default 50 %). At the end of the chain a
limiter, a soft clipper and a fixed ceiling keep every sample below -1.9 dBFS, whatever the
volume setting or a fault in a sound. How loud that is in the headphones depends on the Mac's
own volume.

**Screen recording** (`V`) in hijack mode has the sound too (in Chrome: MP4, H.264 + AAC).

**Measured** (`npm run check:hijack`: headless Chrome on the M2 Max, the moving test clip as
webcam, focus zone set to the whole picture, volume 50 %):

- From a fresh start, the phone was in focus after 0.85 s and heard after 0.88 s.
- Live levels while in focus (3 s each, the clip's phone about 55–70 % towards the centre):
  drone -20.3, pulse -25.6, wash -23.0, plucks -24.6, beat -23.8 dB RMS; highest peak -9.1 dB.
- Rendered offline (the files below):
  - inside: drone -20.8, pulse -24.0, wash -22.6, plucks -27.5, beat -24.8 dB RMS, centred
    (left and right within 0.5 dB);
  - the leak at the edge: -31.9 to -37.7 dB RMS, 7 to 14 dB below inside, 8 dB louder on the
    phone's side, and 9 to 31 dB less bass (below 200 Hz) than inside;
  - the rumble while breaking in: about -28 dB RMS, cut off by 18 to 26 dB at the seal;
  - the door: 5 to 9 dB quieter (above 200 Hz) within 0.3 s, then fading;
  - highest peak -6.7 dB (the ceiling is -1.9 dB); silent (below -74 dB) 3 s after being pushed out.
- Silent 2.8 s after switching to remove mode. A picture without a phone: silent for all 6 s.
- The leak's level is calibrated per character (`leakLiftDb` in `src/audio/voices.ts`):
  without it the drone and the beat, which are mostly bass, were 23 to 29 dB below inside at
  the edge, nearly inaudible, and the bells were louder at the edge than inside.
- These are measurements, not listening: how it sounds has not been judged by ear here.

**To hear the characters without a camera:** `npm run check:hijack` (dev server running) writes
`captures/hijack_drone.wav` and so on, 15 s each, joined 37 s into the person's sound: breaking
in at the edge of the zone, on the left (0–0.8 s), the leak (to 3 s), moving into the centre
(3–5 s), inside, building up (5–9 s), moving (9–11 s), still (11–12 s), pushed out (at 12 s).

Limits:

- **Turning away for more than 1 s and back gives the person a new sound**: the tracker
  forgets them, and the sound is tied to the tracker's id, not to how the person looks.
- **Phones the detector misses make no sound**: far away, edge-on, held at the ear (see "Known
  limitations").
- **Left and right follow the screen.** With the laptop turned to face others and you behind
  it, turn the mirror off (`X`) so that someone on your left is heard on the left.
- Not yet tried live, with a real person and headphones. Not tried in streaming mode, where
  the sound would play on the Mac, not on the iPad.

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
  settings.ts        all settings, their defaults, remembered in the browser
  camera.ts          webcam and stand-in frame sources
  snapshot.ts        before/after snapshot (S) and file downloads
  types.ts           small shared types
  detect/yoloSeg.ts  YOLO11-seg inference and mask decoding
  detect/tracker.ts  follows each phone-like object and decides whether it is erased
  mask/              temporal stabiliser, distance field, inpaint-window tracker
  effects/           Effect interface; remove.ts erases the phone, grow.ts inflates it,
                     hijack.ts picks the phone in focus and drives the sound
  audio/             hijack mode's sound: engine.ts (output chain, limiter, scheduling),
                     voices.ts (the five characters)
  fill/              Fill interface; migan.ts, telea.ts, stylised.ts
  runtime/ort.ts     onnxruntime-web set-up (WebGPU, CPU fallback)
  ui/panel.ts        debug panel
  still.ts           still-image test page
  devReport.ts       iPad mode only: sends timings and errors to the Mac's terminal
  stream/            streaming mode: ipad.ts (the iPad's page), remoteSource.ts (the Mac's
                     side), link.ts (WebRTC set-up, statistics), signal.ts, latency.ts,
                     shots.ts (the iPad's before/after screenshot, made on the Mac),
                     screen.ts (fullscreen and keeping the iPad awake)
  recorder.ts        screen recording of the "after" picture (Mac page and iPad stream page)
server/
  signalHub.ts       streaming mode: introduces the two pages to each other (dev server only)
stream.html          streaming mode: the iPad's page
scripts/
  fetch_models.sh    downloads and exports the models (npm run models)
  headless_check.mjs a clip as fake webcam, timings for every mode (npm run check)
  hijack_check.mjs   hijack mode's sound, measured; writes the characters as .wav (npm run check:hijack)
  make_test_clip.sh  turns a photo into a moving test clip for the check
  stills_report.mjs  what the detector makes of your captures (npm run stills)
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
