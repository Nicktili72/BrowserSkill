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

Safari has no debugger/CDP, so everything is done from a content script plus `browser.tabs`/`windows`. What's implemented lives in `background.js`'s `tools` table; page-side logic in `content.js`'s `ops`. Still `unsupported`: `upload`, `download`, `network`, `console`, `debug`, `record`, `evaluate`, `hover`, `request_help`.

Candidates for next, roughly by effort: `evaluate`/`console` (needs injecting a script into the page's own world — blocked by strict CSP on some sites), then `network` (wrap `fetch`/XHR; misses images/scripts and anything before injection), `upload` (set a File on an input via `DataTransfer`), `hover` (synthetic mouse events only — CSS `:hover` won't trigger). Not feasible from an extension: `download` (no downloads API in Safari), dialog handling, trusted (`isTrusted`) input, moving a borrowed tab into the Agent Window.

## Updating the notarized app after changing extension JS

`rebuild.sh` starts with `rm -rf` on the wrapper folder — **including `export/`, the notarized app Safari may be using**. To ship a change without regenerating the project:
1. Copy the changed files into `../extension-safari-wrapper/BrowserSkill for Safari/BrowserSkill for Safari Extension/Resources/`.
2. Archive and export to a *new* folder (the commands under *Archive, sign, and export*, with a new `-archivePath` and `-exportPath`; use the system Xcode via `xcode-select -p`, not `Xcode-beta`, unless that's what's installed).
3. Zip, `notarytool submit --wait`, `stapler staple` on the new export.
4. Quit Safari, move the old `export/` aside, put the new one in place, and make sure it is the **only** registered copy: `pluginkit -mAvvv -p com.apple.Safari.web-extension | grep browserskill` (an `xcodebuild archive` registers its own build-intermediate copy under `DerivedData/…/ArchiveIntermediates/` — unregister that one with `lsregister -u` or Safari will load an un-notarized build). Re-register with `lsregister -f` on the new app.
5. Relaunch Safari and re-tick the extension in Settings → Extensions (a re-registered extension comes back off).
