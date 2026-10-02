#!/bin/sh
# Drives the Property Inspector's own JavaScript in a headless browser, with the
# Stream Deck WebSocket stubbed, and checks its protocol against what plugin.js
# expects. No network, no Stream Deck app, no hardware.
set -eu

REPO="$(cd "$(dirname "$0")/.." && pwd)"
PI="$REPO/com.danielbrooks.aiquota.sdPlugin/ui/quota.html"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
WORK="${TMPDIR:-/tmp}/aiquota-pi-test"

[ -f "$PI" ] || { echo "missing $PI" >&2; exit 1; }
[ -x "$CHROME" ] || { echo "Google Chrome not found; skipping PI test" >&2; exit 0; }

rm -rf "$WORK"; mkdir -p "$WORK"

# The page assigns ws.onmessage internally; expose it so the harness can push frames.
sed 's#  ws.onmessage = (e) => {#  ws.onmessage = window.__ws_onmessage = (e) => {#' \
  "$PI" > "$WORK/pi.html"
grep -q "__ws_onmessage" "$WORK/pi.html" || { echo "could not instrument the PI" >&2; exit 1; }

cp "$REPO/test/property-inspector.harness.html" "$WORK/harness.html"

OUT=$("$CHROME" --headless --disable-gpu --allow-file-access-from-files \
  --dump-dom --virtual-time-budget=5000 "file://$WORK/harness.html" 2>/dev/null |
  python3 -c "
import sys, re, html
d = sys.stdin.read()
m = re.search(r'<div id=\"out\"[^>]*>(.*?)</div>', d, re.S)
print(html.unescape(re.sub('<[^>]+>', '', m.group(1))) if m else 'EMPTY - harness did not run')")

echo "$OUT"
case "$OUT" in
  *"RESULT: PASS"*) exit 0 ;;
  *) echo "property inspector test did not pass" >&2; exit 1 ;;
esac
