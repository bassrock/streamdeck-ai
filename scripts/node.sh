#!/bin/sh
# Runs a script on the same Node the Stream Deck app uses for plugins, so results
# match what the plugin actually does and nothing depends on which nvm version
# happens to be active. Falls back to whatever node is on PATH.
set -eu

BUNDLED_DIR="$HOME/Library/Application Support/com.elgato.StreamDeck/NodeJS"
NODE=""

if [ -d "$BUNDLED_DIR" ]; then
  # Highest version present, so a Stream Deck update that bumps Node still works.
  for candidate in $(ls -1 "$BUNDLED_DIR" 2>/dev/null | sort -rV); do
    if [ -x "$BUNDLED_DIR/$candidate/node" ]; then
      NODE="$BUNDLED_DIR/$candidate/node"
      break
    fi
  done
fi

if [ -z "$NODE" ]; then
  NODE="$(command -v node || true)"
  [ -n "$NODE" ] || { echo "no node found: install Node, or the Stream Deck app" >&2; exit 1; }
  echo "note: using $($NODE --version) from PATH; the app's bundled Node was not found" >&2
fi

exec "$NODE" "$@"
