#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
#  Open the Setup & Deployment guide  (macOS / Linux)
# ─────────────────────────────────────────────────────────────────────────────
#  Opens docs/index.html in your default browser. Needs NOTHING running — no
#  Docker, no Node, no server. This is the page to reach for when the board
#  itself won't start.
#
#  Usage:   ./open-guide.sh        (first time: chmod +x open-guide.sh)
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

# Resolve the repo from this script's own location, so it works from anywhere.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GUIDE="$SCRIPT_DIR/docs/index.html"

if [ ! -f "$GUIDE" ]; then
  echo "✖  Guide not found at: $GUIDE" >&2
  echo "   Run this from inside the repo (it expects ./docs/index.html)." >&2
  exit 1
fi

echo "📖  Opening the Setup & Deployment guide…"
echo "    $GUIDE"

case "$(uname -s)" in
  Darwin)
    open "$GUIDE"
    ;;
  Linux)
    # Try the usual suspects; fall back to printing the path.
    if command -v xdg-open >/dev/null 2>&1; then
      xdg-open "$GUIDE" >/dev/null 2>&1 &
    elif command -v sensible-browser >/dev/null 2>&1; then
      sensible-browser "$GUIDE" >/dev/null 2>&1 &
    elif command -v firefox >/dev/null 2>&1; then
      firefox "$GUIDE" >/dev/null 2>&1 &
    else
      echo "   No browser launcher found — open this file manually:"
      echo "   file://$GUIDE"
    fi
    ;;
  *)
    # Git Bash / MSYS on Windows lands here.
    if command -v start >/dev/null 2>&1; then
      start "" "$GUIDE"
    else
      echo "   Open this file manually:  file://$GUIDE"
    fi
    ;;
esac
