#!/bin/bash
# Regenerates and builds the Xcode wrapper from scratch.
#
# The wrapper MUST live outside this directory (../extension-safari-wrapper),
# not nested inside it: `safari-web-extension-converter --copy-resources`
# copies the *entire* source directory verbatim, and a project-location
# nested inside its own source recurses into itself until it hits a path
# length error. --copy-resources itself is also required — without it this
# Xcode/Safari build silently produces an empty Resources/ folder (no
# manifest.json), and the extension never appears in Safari at all, no
# error shown anywhere. See NOTES.md.
set -euo pipefail
cd "$(dirname "$0")"

WRAPPER_DIR="../extension-safari-wrapper"
export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode-beta.app/Contents/Developer}"

echo "=== Regenerating Xcode project ==="
rm -rf "$WRAPPER_DIR"
(cd .. && xcrun safari-web-extension-converter extension-safari \
  --project-location extension-safari-wrapper \
  --app-name "BrowserSkill for Safari" --macos-only --no-open --no-prompt --copy-resources)

echo "=== Building ==="
cd "$WRAPPER_DIR/BrowserSkill for Safari"
xcodebuild -project "BrowserSkill for Safari.xcodeproj" -scheme "BrowserSkill for Safari" \
  -configuration Debug -derivedDataPath ../build build

APP="../build/Build/Products/Debug/BrowserSkill for Safari.app"
echo "=== Built: $APP ==="
echo "Next: fully quit Safari, then run:  open \"$(pwd)/$APP\""
