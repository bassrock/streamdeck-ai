#!/bin/sh
# Dev helpers for the AI Quota plugin. Run via npm (npm run link) or directly.
set -eu

PLUGIN_ID="com.danielbrooks.aiquota"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$REPO/$PLUGIN_ID.sdPlugin"
DEST_DIR="$HOME/Library/Application Support/com.elgato.StreamDeck/Plugins"
DEST="$DEST_DIR/$PLUGIN_ID.sdPlugin"
APP="/Applications/Elgato Stream Deck.app"
LOG_DIR="$HOME/Library/Logs/ElgatoStreamDeck"

case "${1:-}" in
  link)
    [ -d "$SRC" ] || { echo "plugin source missing: $SRC" >&2; exit 1; }
    mkdir -p "$DEST_DIR"
    if [ -L "$DEST" ]; then
      echo "already linked -> $(readlink "$DEST")"
    elif [ -e "$DEST" ]; then
      echo "refusing to replace a real directory at:" >&2
      echo "  $DEST" >&2
      echo "Move it aside first if you are sure." >&2
      exit 1
    else
      ln -s "$SRC" "$DEST"
      echo "linked $DEST -> $SRC"
    fi
    defaults write com.elgato.StreamDeck developer_mode -bool YES
    echo "developer_mode enabled (gives you Restart plugin in the right-click menu)"
    ;;
  reload)
    # Match the entry point, not the plugin id: the id also appears in the command
    # line of test scripts and anything else run from the plugin folder.
    pid=$(pgrep -f "$PLUGIN_ID.sdPlugin/bin/plugin.js" | head -1)
    if [ -z "$pid" ]; then
      echo "plugin is not running (place the action on a dial first)"
      exit 0
    fi
    kill "$pid"
    i=0
    while [ $i -lt 15 ]; do
      sleep 1; i=$((i+1))
      new=$(pgrep -f "$PLUGIN_ID.sdPlugin/bin/plugin.js" | head -1)
      if [ -n "$new" ] && [ "$new" != "$pid" ]; then
        echo "reloaded: $pid -> $new"
        exit 0
      fi
    done
    echo "plugin did not come back; try: $0 restart" >&2
    exit 1
    ;;
  unlink)
    if [ -L "$DEST" ]; then rm "$DEST"; echo "removed symlink $DEST"
    else echo "nothing linked at $DEST"; fi
    ;;
  restart)
    # The executable is named "Stream Deck", not "Elgato Stream Deck"; killing the
    # wrong name fails silently and the app never rescans for plugin changes.
    killall "Stream Deck" 2>/dev/null || true
    # The app needs a moment to release the USB device before relaunching.
    i=0; while pgrep -x "Stream Deck" >/dev/null 2>&1 && [ $i -lt 60 ]; do i=$((i+1)); sleep 0.5; done
    # Launching too soon after the quit gets LSOpenURLs error -600, so retry.
    j=0
    while [ $j -lt 5 ]; do
      if open -a "$APP" 2>/dev/null; then break; fi
      j=$((j+1)); sleep 2
    done
    [ $j -lt 5 ] || { echo "could not relaunch Stream Deck" >&2; exit 1; }
    echo "Stream Deck restarted"
    ;;
  logs)
    # The app rotates StreamDeck.log to StreamDeck.1.log and so on, so always read
    # the newest by modification time rather than a fixed name.
    n="${2:-25}"
    newest=$(ls -t "$LOG_DIR"/StreamDeck*.log 2>/dev/null | head -1)
    if [ -z "$newest" ]; then
      echo "no Stream Deck log found in $LOG_DIR" >&2
      exit 1
    fi
    echo "--- plugin log: what each poll actually saw ---"
    if [ -f "$SRC/logs/aiquota.log" ]; then
      tail -n "$n" "$SRC/logs/aiquota.log"
    else
      echo "(none yet; the plugin writes this once it runs)"
    fi
    echo
    echo "--- $(basename "$newest"): app's view of this plugin ---"
    found=$(grep -a "$PLUGIN_ID" "$newest" | tail -n 8)
    if [ -n "$found" ]; then echo "$found"; else echo "(nothing for this plugin in that file)"; fi
    ;;
  status)
    printf 'link:        '; if [ -L "$DEST" ]; then readlink "$DEST"; else echo "not linked"; fi
    printf 'app running: '; pgrep -x "Stream Deck" >/dev/null 2>&1 && echo yes || echo no
    printf 'plugin proc: '; pgrep -f "$PLUGIN_ID.sdPlugin/bin/plugin.js" >/dev/null 2>&1 && echo yes || echo no
    printf 'dev mode:    '; defaults read com.elgato.StreamDeck developer_mode 2>/dev/null || echo "unset"
    ;;
  *)
    echo "usage: dev.sh {link|unlink|reload|restart|logs [n]|status}" >&2
    exit 64
    ;;
esac
