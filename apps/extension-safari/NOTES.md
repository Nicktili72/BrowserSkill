# Dev notes

Working notes for whoever picks this up next — not user-facing (see `README.md` for that).

## Signing & notarization

`rebuild.sh` produces an ad-hoc-signed debug build, fine for local development (with Safari's Develop → Allow Unsigned Extensions on). To remove that requirement for real use, sign with a Developer ID and notarize — confirmed possible for Safari Web Extensions outside the App Store since Safari 18.4+ ([Apple's docs](https://developer.apple.com/documentation/safariservices/distributing-your-safari-web-extension)).

**Prerequisites** (one-time, per machine, via Xcode's GUI — no command-line path exists for creating the certificate itself):
- Xcode → Settings → Accounts → your team → Manage Certificates → **+** → **Developer ID Application**
- An app-specific password from appleid.apple.com → Sign-In and Security → App-Specific Passwords
- `xcrun notarytool store-credentials "<profile-name>" --apple-id "<your-apple-id>" --team-id <YOUR_TEAM_ID>` (run this yourself in Terminal — it prompts for the password interactively; don't pass it as a bare CLI arg if you can avoid it, and never put it in a script or commit it)

**Archive, sign, and export** (`rebuild.sh` names the wrapper `../$(basename "$PWD")-wrapper` — a sibling of this repo, so from this repo's root it's `../browserskill-safari-extension-wrapper` once you've run `rebuild.sh` at least once):
```bash
cd "../browserskill-safari-extension-wrapper/BrowserSkill for Safari"
xcodebuild archive \
  -project "BrowserSkill for Safari.xcodeproj" -scheme "BrowserSkill for Safari" \
  -configuration Release -archivePath ../BrowserSkill.xcarchive \
  CODE_SIGN_STYLE=Manual DEVELOPMENT_TEAM=<TEAM_ID> CODE_SIGN_IDENTITY="Developer ID Application" \
  PROVISIONING_PROFILE_SPECIFIER="" -allowProvisioningUpdates

# If archive fails with "Invalid trust settings" naming a *different*
# certificate (e.g. an "Apple Development" one on the same account) —
# that's a stale trust override on that unrelated cert, not this one.
# CODE_SIGN_STYLE=Manual with the Developer ID identity set explicitly,
# as above, sidesteps it entirely rather than needing to fix that cert.

cd ..
cat > exportOptions.plist <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>method</key><string>developer-id</string>
  <key>teamID</key><string><TEAM_ID></string>
  <key>signingStyle</key><string>manual</string>
  <key>signingCertificate</key><string>Developer ID Application</string>
</dict></plist>
EOF
xcodebuild -exportArchive -archivePath BrowserSkill.xcarchive -exportPath export -exportOptionsPlist exportOptions.plist
```

**Notarize:**
```bash
cd export
ditto -c -k --keepParent "BrowserSkill for Safari.app" "BrowserSkill for Safari.zip"
xcrun notarytool submit "BrowserSkill for Safari.zip" --keychain-profile "<profile-name>" --wait
```

**Then staple:** `./check-notarization.sh` (sibling of this file) runs `stapler staple` on the export and tells you if it worked.

### If `stapler` says "Record not found"

Almost always: **the app you're stapling isn't the build you submitted.** Notarization tickets are keyed by cdhash, and any re-export or re-sign (even of identical source) produces a new cdhash. An earlier version of these notes blamed a multi-hour Apple-side "propagation gap" — that was wrong. The real case: a build was submitted 2026-09-27, the app was re-exported 2026-10-01, and the new binary's cdhash was never submitted. Resubmitting the current export stapled immediately.

Diagnose in 30 seconds:
```bash
codesign -dvvv "BrowserSkill for Safari.app" 2>&1 | grep ^CDHash
xcrun notarytool log <submission-id> --keychain-profile "<profile-name>" | grep -A1 'BrowserSkill for Safari.app"'   # cdhash of the notarized binary
```
If they differ, re-zip the *current* export and resubmit (the **Notarize** step above), then staple. Always zip, submit, and staple the same export — don't re-export in between.

Safari's extension loader uses the same Gatekeeper verdict as `spctl -a -vvv -t exec <app>`; until that says "Notarized Developer ID", Safari won't load the build without Develop → Allow Unsigned Extensions.

## `bsk` auto-update will undo the daemon patch

The daemon checks for new `bsk` releases and, by default, replaces its own binary with the upstream one (`bsk status` prints "A new bsk version is available ... The daemon will upgrade bsk automatically"). Upstream doesn't have the `safari-web-extension://` origin patch, so after an upgrade the daemon answers the extension's WebSocket handshake with `403 Origin not in chrome-extension allow-list`, and Safari's Settings → Extensions → BrowserSkill panel shows `[bsk] ws error (background.js:...)`.

- Start the daemon with `BSK_AUTO_UPDATE=off` (switch is in `crates/bsk-cli/src/cli/update.rs`; any value other than `off` leaves auto-update on). The "new version available" notice still prints — it's only a hint.
- Quick check that the running binary is patched: `strings $(which bsk) | grep -c safari-web-extension` (non-zero = patched), or probe the handshake: `curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:52800/extension -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' -H 'Origin: safari-web-extension://3610fd31-0161-4c6b-919a-ee9a3edb2c19'` should print `101`, not `403`.
- If it did get replaced: rebuild with `cargo build -p bsk`, `bsk daemon stop`, restart with the env var set.
- Safari keeps an extension's error entries until the extension reloads, so a stale `ws error` can remain after the cause is fixed; quit and relaunch Safari (or untick/retick the extension) to clear it.

## Command coverage vs the Chrome extension

Safari has no debugger/CDP, so everything is done from a content script plus `browser.tabs`/`windows`. What's implemented lives in `background.js`'s `tools` table; page-side logic in `content.js`'s `ops`. Still `unsupported`: `download`, `debug`, `record`, `request_help`, `emulate`. Not feasible from an extension: `download` (no downloads API in Safari), dialog handling, trusted (`isTrusted`) input, real `:hover`, moving a borrowed tab into the Agent Window. `debug`/`record` depend on the full debugger protocol; `emulate` (viewport/UA/touch) has no Safari equivalent.

## The page-world script (`hook.js`) — what was learned on real Safari 27.3

- **`"world": "MAIN"` in `manifest.json` is honoured**, and a MAIN-world content script is exempt from the page's CSP (console capture works on GitHub). `evaluate` is not exempt: it needs `eval`, which strict pages forbid; that comes back as an in-band `EvalError`, not an RPC error.
- **Safari defines `window.browser` (with `runtime.sendMessage`) in the MAIN world** once an extension has a MAIN-world script, so *any web page* can message the background page. Hence the sender check at the top of `background.js`'s `onMessage` listener: only URLs under `browser.runtime.getURL('')` (confirm.html, popup.html) may drive it. Keep it.
- Because `browser` exists in both worlds, "am I in the isolated world?" must test `browser.runtime.id` (set only there), not `typeof browser`. The first version tested `typeof browser` and wrongly took the CSP-blockable injection path on GitHub.
- `hook.js` and `content.js` talk over `window` CustomEvents (`bsk-req`/`bsk-res`, JSON strings), with an immediate ack so "script not there" (1.5 s) is distinguishable from "slow evaluation". A page can forge those events, but they only carry the page's own state.
- **`network` (in `hook.js`)**: wraps `fetch`/XHR for status + failures, and uses a `PerformanceObserver` for everything else. Verified on real Safari 27.3 (Wikipedia, GitHub): Resource Timing's `responseStatus` is **not** populated for subresources (same-origin or not), so those entries have no status. Safari *does* emit Resource Timing entries for loads that failed, so each timing entry is held 250 ms and dropped if the element's `error` event for the same URL arrives (otherwise a broken `<img>` shows up as a status-less "response" plus a failure). A `bsk network --since N` cursor is per page load — after a navigation it can be past the end of the new buffer.
- **`upload` and the second daemon patch.** The daemon only sends the extension a `staged_path`; the extension can't call `transfer.read` (the daemon accepts only `audit.request` from extensions) and the sandboxed appex can't read the path. `daemon-upload-patch.diff` makes the daemon, for browsers whose handshake name is Safari, add `UploadFile.data_base64` (16 MiB cap per call, `invalid_params` beyond it; schema regenerated). The audit record is written *before* the bytes are inlined, so file contents never reach the audit log. Verified live: 3 MB binary, SHA-256 identical read back inside the page (`crypto.subtle`); `mode: drop` into a Dropzone; single-input-with-two-files and non-file-target errors.
- **`hover` fidelity details that mattered.** jQuery UI/Radix-style hover menus depend on `relatedTarget` (jQuery emulates `mouseenter` from `mouseover`+`relatedTarget`) and `pointerType === 'mouse'`; without them a nested menu stayed closed even though the first level opened. Both are now set. Pure-CSS `:hover` (e.g. the-internet.herokuapp.com/hovers) stays unreachable.
- **Screenshots.** Safari only offers `captureVisibleTab`, so element crops and full-page captures are built on a `<canvas>` in the background page (decode with `new Image()` + `decode()` — `fetch(dataUrl)` risks the extension CSP). Verified live: a 30,115 px Wikipedia page → 1343×32000 PNG (14.5 MB) in ~32 s, bottom of the page (footer) present, scroll position restored. Safari's canvas coped with 32,000 px; `sips` (handy for inspecting results) silently refuses to crop images over ~16k px — use ImageIO/CoreGraphics instead. `screenshot_read` hands the stored PNG out in 192 KiB chunks (256 KiB base64); `screenshot_release` or `session_stop` frees it (5 captures max, oldest evicted).
- **Navigation commands.** After `reload`/back/forward the tab's `status` may still read `complete` for a moment, so `afterNavAction` first waits (≤1.2 s) for it to leave `complete` or for the URL to change; for back/forward, "nothing happened" is reported as `not_found` ("no history entry").
- Reinstalling the app resets Safari's per-site permission *and* the enable toggle (the panel says "You have not allowed this extension on any websites yet"). Until the user re-ticks it and clicks "Always Allow on Every Website…" (then confirms), tabs report an empty title/URL, `wait_for_navigation` times out and content-script calls hang or return "no response from page" — easy to mistake for a code bug.

## Updating the notarized app after changing extension JS

`rebuild.sh` starts with `rm -rf` on the wrapper folder — **including `export/`, the notarized app Safari may be using**. To ship a change without regenerating the project:
1. Copy the changed files into `../extension-safari-wrapper/BrowserSkill for Safari/BrowserSkill for Safari Extension/Resources/`.
2. Archive and export to a *new* folder (the commands under *Archive, sign, and export*, with a new `-archivePath` and `-exportPath`; use the system Xcode via `xcode-select -p`, not `Xcode-beta`, unless that's what's installed).
3. Zip, `notarytool submit --wait`, `stapler staple` on the new export.
4. Quit Safari, move the old `export/` aside, put the new one in place, and make sure it is the **only** registered copy: `pluginkit -mAvvv -p com.apple.Safari.web-extension | grep browserskill` (an `xcodebuild archive` registers its own build-intermediate copy under `DerivedData/…/ArchiveIntermediates/` — unregister that one with `lsregister -u` or Safari will load an un-notarized build). Re-register with `lsregister -f` on the new app.
5. Relaunch Safari and re-tick the extension in Settings → Extensions (a re-registered extension comes back off).
