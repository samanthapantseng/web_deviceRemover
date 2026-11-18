#!/usr/bin/env bash
# Streaming mode, the Mac's side: opens the processing page (https://localhost:8443/?source=stream)
# in its own Chrome window and keeps the Mac awake while it is open.
#
#   npm run dev:ipad        # first, in another terminal
#   npm run stream:mac      # then this; leave the terminal open, Ctrl-C closes the window
#
# Chrome slows down windows that are hidden or fully covered, and a canvas that is not painted
# sends no frames, so the iPad would freeze. This window runs with that throttling switched off,
# in a profile of its own (your normal Chrome and its tabs are not touched). Keep it visible
# anyway if you can, and keep the Mac on power.
set -euo pipefail

PORT="${PORT:-8443}"
URL="${1:-https://localhost:$PORT/?source=stream}"
CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
SUPPORT="$HOME/Library/Application Support/Device Remover"
PROFILE="$SUPPORT/chrome-stream"
CA="$SUPPORT/certs/device-remover-ca.pem"

if ! curl -sk --max-time 3 -o /dev/null "https://localhost:$PORT/"; then
  echo "Nothing answers on https://localhost:$PORT/. Start \"npm run dev:ipad\" in another terminal first." >&2
  exit 1
fi
[ -x "$CHROME" ] || { echo "Google Chrome not found at $CHROME (set CHROME=...)." >&2; exit 1; }

# WebGPU needs a secure page, so Chrome has to trust the dev server's certificate.
if [ -f "$CA" ] && ! security verify-cert -c "$SUPPORT/certs/server.pem" -p ssl -s localhost >/dev/null 2>&1; then
  cat <<EOF

  This Mac does not trust the Device Remover certificate yet, so Chrome will show a warning.
  For a quick test: click "Advanced", then "Proceed to localhost".
  To fix it once (README, "Streaming mode"): open Keychain Access, drag in
    $CA
  double-click "Device Remover local CA", open "Trust", set "When using this certificate" to
  "Always Trust", close the window and enter your password.

EOF
fi

mkdir -p "$PROFILE"
echo "Opening $URL (Ctrl-C here closes it)."
# caffeinate: no display or system sleep for as long as this script (then Chrome) runs.
caffeinate -dis -w $$ &
exec "$CHROME" \
  --user-data-dir="$PROFILE" \
  --app="$URL" \
  --no-first-run \
  --no-default-browser-check \
  --disable-backgrounding-occluded-windows \
  --disable-renderer-backgrounding \
  --disable-background-timer-throttling
