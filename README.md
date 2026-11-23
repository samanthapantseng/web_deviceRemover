# Device Remover

A live camera view that changes the phones it sees. It has three modes:

- **Remove**: phones are erased from people's hands, leaving the empty pose.
- **Grow**: the phone inflates, from its real size to twice as big.
- **Hijack**: the picture stays as it is; aim the camera at someone's phone and overhear "their"
  conversation in headphones. Nothing is intercepted: it is a synthesised murmur without words.

It runs in the browser, on the Mac alone or with an iPad as camera and screen while the Mac does
the work. Pictures never leave the local network, and nothing is saved unless you take a snapshot
or record.

```
camera → YOLO11-seg finds phones → tracker watches each one for about 1 s, then decides
       → remove: fill the hole (MI-GAN, Telea or stylised)
       → grow:   cut out the phone and the hand on it, draw it bigger
       → hijack: the phone nearest the centre → synthesised murmur
```

## Setup (once)

Needs Node 20+, Chrome, `curl` and [`uv`](https://docs.astral.sh/uv/).

```bash
npm install
```

```bash
npm run models
```

The second command puts the models (about 130 MB, not in git) into `public/models/`.

## Run on the Mac

```bash
npm run dev
```

Open <http://localhost:5173/> in Chrome and allow the camera. Ctrl-C in the Terminal stops it.

## Run with the iPad

Do "iPad: before the first time" below once. Then, each time:

1. Start the server and leave the window open:

   ```bash
   npm run dev:ipad
   ```

2. In a second Terminal window, start the Mac's processing window. Keep it visible and the Mac on
   power; modes and settings are changed here.

   ```bash
   npm run stream:mac
   ```

3. On the iPad, in Safari, open one of these and allow the camera:
   - **Wi-Fi** (same network as the Mac): the `Network:` address from step 1 plus `stream.html`,
     for example `https://10.21.12.136:8443/stream.html`
   - **Ethernet cable** (the iPad's Wi-Fi off): `https://192.168.77.1:8443/stream.html`

Double-tap the iPad for its panel: Remove / Grow / Hijack, screenshot, record, camera, mirror. In
hijack mode the sound plays on the iPad, so the headphones go there; if it says "tap for sound",
tap once. Ctrl-C in both Terminal windows stops everything.

## iPad: before the first time

**iPad: trust the certificate.** `npm run dev:ipad` shows `device-remover-ca.pem` in Finder the
first time.

1. AirDrop it to the iPad.
2. Settings → Profile Downloaded → Install.
3. Settings → General → About → Certificate Trust Settings → turn on **Device Remover local CA**.

**iPad: camera.** Settings → Apps → Safari → Camera → Allow, so a reload doesn't ask again.

**Mac: trust the certificate.** In Keychain Access, drag in
`~/Library/Application Support/Device Remover/certs/device-remover-ca.pem`, double-click
**Device Remover local CA** → Trust → **Always Trust**.

**Mac: camera.** The first time, the Mac's processing window asks for the camera: click **Allow**.
It isn't used, but the cable connection doesn't work without it.

**Ethernet cable** (optional, steadier than Wi-Fi): a USB-C Ethernet adapter on each device and one
cable. Set fixed addresses, router empty:

| | where | IP address | subnet mask |
|---|---|---|---|
| Mac | System Settings → Network → the adapter → Details → TCP/IP → Manually | `192.168.77.1` | `255.255.255.0` |
| iPad | Settings → Ethernet → the adapter → Configure IP → Manual | `192.168.77.2` | `255.255.255.0` |

## If it doesn't work

- **The page doesn't load on the iPad**: many public Wi-Fis keep devices apart. Use the cable, your
  own router or a phone's hotspot. A certificate warning means the iPad's trust step is missing.
- **Cable**: `ping -c 3 192.168.77.2` on the Mac should get replies. If not, check the plugs, the
  addresses, and that the iPad's Wi-Fi is off.
- **The page loads but no picture comes over the cable**: the Mac's camera question was blocked. Stop
  `stream:mac`, delete `~/Library/Application Support/Device Remover/chrome-stream`, start it again.
- **The picture freezes**: the Mac's window must be visible. Otherwise the iPad reconnects by itself;
  its panel also has Reconnect.
- **It is slow**: plug the Mac in, restart it, close other apps.
- **Hijack is silent on the iPad**: tap the picture once; check the volume; a phone has to be inside
  the dashed circle.
- **Someone else has the picture**: anyone on the same network who opens the stream page takes over.
  Use the cable, with the Mac's Wi-Fi off, or your own network.
- **Port 8443 is taken**: `npm run dev:ipad -- --port 8444`, then `PORT=8444 npm run stream:mac`, and
  `:8444` on the iPad.

## Keys

| Key | |
|---|---|
| `G` | remove ↔ grow |
| `H` | hijack on / off |
| `1` `2` `3` | remove's fill: MI-GAN, Telea, stylised (`3` again: next style) |
| `S` | snapshot, before and after |
| `V` | screen recording on / off (stops by itself after 5 minutes) |
| `F` | fullscreen |
| `D` | panel with all settings |
| `M` | show the mask |
| `X` | mirror |

On a touch screen, double-tap for the panel. Settings are remembered in the browser.

## Limits

- A phone stays visible for its first second, until the tracker has decided.
- Phone look-alikes (a dark wallet held upright) can be taken for phones; small or edge-on phones
  are missed.
- Everything is 640×480, so a grown phone looks soft.
- The iPad Pro has one USB-C port: with the Ethernet cable in it, use Bluetooth headphones or a hub.
- The iPad can't run the models fast enough on its own (2018 iPad Pro), hence the Mac.

## Code

`src/pipeline.ts` runs camera → `detect/` → `mask/` → `effects/` (one per mode). `fill/` has remove's
fills, `audio/` hijack's sound, `stream/` the iPad connection, `settings.ts` the defaults. Checks
with a video clip instead of a camera: `npm run check`, `check:stream` and `check:hijack`, each with
`-- captures/clip_moving.y4m` (made by `scripts/make_test_clip.sh <photo>`; the server has to be
running).

## Licences

MI-GAN weights and onnxruntime-web: MIT. OpenCV.js: Apache 2.0. Ultralytics YOLO11: AGPL-3.0, which
matters if the built site is published.
