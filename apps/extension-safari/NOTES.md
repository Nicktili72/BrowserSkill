# Dev notes

Working notes for whoever picks this up next — not user-facing (see `README.md` for that).

## Signing & notarization

`rebuild.sh` produces an ad-hoc-signed debug build, fine for local development (with Safari's Develop → Allow Unsigned Extensions on). To remove that requirement for real use, sign with a Developer ID and notarize — confirmed possible for Safari Web Extensions outside the App Store since Safari 18.4+ ([Apple's docs](https://developer.apple.com/documentation/safariservices/distributing-your-safari-web-extension)).

**Prerequisites** (one-time, per machine, via Xcode's GUI — no command-line path exists for creating the certificate itself):
- Xcode → Settings → Accounts → your team → Manage Certificates → **+** → **Developer ID Application**
- An app-specific password from appleid.apple.com → Sign-In and Security → App-Specific Passwords
- `xcrun notarytool store-credentials "<profile-name>" --apple-id "<your-apple-id>" --team-id <YOUR_TEAM_ID>` (run this yourself in Terminal — it prompts for the password interactively; don't pass it as a bare CLI arg if you can avoid it, and never put it in a script or commit it)

**Archive, sign, and export** (replace `<TEAM_ID>` — your Developer ID Application cert's team, which can differ from an "Apple Development" cert's team on the same account):
```bash
cd "../extension-safari-wrapper/BrowserSkill for Safari"   # sibling of this folder, from rebuild.sh
xcodebuild archive \
  -project "BrowserSkill for Safari.xcodeproj" -scheme "BrowserSkill for Safari" \
  -configuration Release -archivePath ../BrowserSkill.xcarchive \
  CODE_SIGN_STYLE=Manual DEVELOPMENT_TEAM=<TEAM_ID> CODE_SIGN_IDENTITY="Developer ID Application" \
  PROVISIONING_PROFILE_SPECIFIER="" -allowProvisioningUpdates

# If archive fails with "Invalid trust settings" naming a *different*
# certificate (e.g. your Apple Development one) — that's a stale trust
# override on that unrelated cert, not this one. CODE_SIGN_STYLE=Manual
# with the Developer ID identity set explicitly, as above, sidesteps it
# entirely rather than needing to fix that cert's trust settings.

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

**Then check readiness** with `./check-notarization.sh` (sibling of this file) — see below for what it's actually waiting on.

### The propagation gap (confirmed, not a local problem)

`notarytool submit --wait` reporting `Accepted` does **not** mean `stapler staple` will work yet. Apple runs the notarization *approval* pipeline and the ticket-*serving* database (what `stapler`/Gatekeeper actually query) as separate backend systems, and there's a real, sometimes multi-hour sync gap between them.

How this was confirmed here, in order, all ruling out a local cause:
1. `codesign --verify --deep --strict` on the exported app: passes cleanly.
2. cdhashes on disk match the ticket's cdhashes exactly (`notarytool log <id>`).
3. `sudo pkill -HUP ocspd` (forces a fresh check instead of a cached verdict): no change.
4. Live packet-level evidence — captured with:
   ```bash
   /usr/bin/log stream --style compact --predicate 'process == "stapler"' &
   xcrun stapler staple "BrowserSkill for Safari.app"
   ```
   showed the actual HTTPS request to Apple completing with a clean **200 response in ~267ms** (TLS fine, trust evaluation fine, "finished successfully" at the network layer) — but only **~2.6KB** back, consistent with a "ticket not found" answer rather than an actual ticket. Not a network, DNS, or cache problem; Apple's ticket DB genuinely hadn't indexed this submission yet.
5. Safari's own extension loading was confirmed to hit the exact same local verdict as `spctl` — it is **not** a separate, more lenient check. Until `check-notarization.sh` reports ready, Safari will not load a Developer ID build without Allow Unsigned Extensions, no matter how "Accepted" `notarytool` reports it.

No further local diagnostic added value beyond this — it's purely waiting on Apple's side. Re-run `check-notarization.sh` occasionally; no other action needed.
