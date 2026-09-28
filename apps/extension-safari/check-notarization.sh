#!/bin/bash
# Run anytime after submitting for notarization (see NOTES.md) to check
# whether Apple's ticket database has caught up yet. No admin password
# needed, safe to run as often as you like.
set -euo pipefail
cd "$(dirname "$0")"
WRAPPER_DIR="../$(basename "$PWD")-wrapper"
APP="$WRAPPER_DIR/export/BrowserSkill for Safari.app"

if [ ! -d "$APP" ]; then
  echo "No export found at: $APP"
  echo "Run the archive/export steps in NOTES.md first."
  exit 1
fi

echo "=== Attempting to staple ==="
if xcrun stapler staple "$APP" 2>&1; then
  echo ""
  echo "✅ READY — quit Safari, relaunch this app, and the extension should"
  echo "   now load without Develop → Allow Unsigned Extensions."
else
  echo ""
  echo "⏳ Not yet. Not a local problem — see NOTES.md's notarization section."
fi
