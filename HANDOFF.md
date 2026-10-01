# Handoff — "Complete the extension" (bsk ↔ **Safari** E2E handshake — **Safari ONLY**, Chrome paths out of scope)

**Goal:** connect Safari (Hermes Safari Bridge / ActionTrigger path) to the `bsk` daemon → `bsk browsers` lists Safari and `bsk execute_script` (or `page.action`) works on `https://example.com`. Repo: `/Users/nicktiliakos/browserskill-safari` (CLI at `target/debug/bsk`). **Chrome was explicitly excluded by the user — do not spend time on `apps/extension` (MV3), `browser_exec`, or any Chrome route; the doctor hint about the Chrome Web Store extension is irrelevant here.**

## What is DONE (verified)
- `protocol.js`: `hello` → `system.handshake` with `params` envelope fixed; `Ctrl`→`Control` key-mapping fixed (MD5 `6de58f42477e372d59eca7c474d715ec`, byte-identical to installed app). `node --test` passes (22/22 root suite).
- Installed Safari wrapper `/Applications/Hermes Safari Bridge.app` is **fully correct**: `com.apple.Safari.extension` manifest with `ActionTrigger`, proper `browser_action`, **no** `debugger` permission → daemon-side **ActionTrigger path works for Safari; no CDP, no Mac restart needed** (old "Code=7 / needs debugger / needs restart" note was WRONG — confirmed empirically). Entitlements complete (`network.client`+`network.server`+`app_sandbox`) on app and appex.
- `bsk daemon start` default mode = **client relay + local WS server**: binds `127.0.0.1:52800` (`ws server listening` log; verified via `lsof`) **and** dials `wss://<relay>/relay/daemon` sending the account `id_token` (relay = `relay.hermes-agent.dev` staging / `relay.nousresearch.com` prod). **Idle-exits after 600 s.** `--mode server` (+`--public-url`, accepts any `ws://`/`wss://` URL, per `crates/bsk-cli/src/daemon/lifecycle.rs`) exists for REMOTE pairing only — not needed here.
- **Relay ≠ browser.** The 25-min `connected` window (23:09→23:34) ended `idle timeout` with **ZERO webextension sockets** — relay routing never mattered; no extension was ever *loaded* into any browser. That is THE gap. `bsk doctor` says exactly this (`FAIL extension connected`).
- Origin allow-list accepts `safari-web-extension://<uuid>`; `BSK_WS_ALLOW_ANY=1` override available (untested E2E). `bsk doctor` itself confirms Safari reaches `127.0.0.1` without `network.client` — loopback/TCC note moot.

## The blocker (the only one) and its exact shape
**Extension not loaded in Safari → `safari_webextensiond` never spawns → `bsk browsers` = 0.** No programmatic path on this machine (all verified):
- `browser_exec` refuses while `use_real_profile: true` (current `~/.hermes/config.yaml`). Mechanism (from `browser_tool_real_profile.py`/`browser_connect.py`): real-profile mode copies the user's real Chrome profile and drives THAT with `--remote-debugging-port=0` (verified via `DevToolsActivePort` match); an explicit `--remote-debugging-port=9222` launch never enters that path, and `browser_exec` never relaunches browsers under real-profile mode — it reads a **session-start browser snapshot** (was empty: `use_browsers` was `["safari"]`, Safari was DOWN, and `bsk daemon stop` may have killed `browser-bridge-daemon.py`). Irrelevant anyway — Chrome is out of scope.
- GUI automation dead: cua-driver/cua_node not installed (`Cannot get Window Server state (cua-driver unavailable)`); `osascript`/Quartz keystroke injection TCC-DENIED (tried & denied twice — do not retry).
- `killall Safari` does NOT reset the extension registry (verified — no `safari_webextensiond` spawn afterward): Safari's real prefs live under `~/Library/Containers/com.apple.Safari/Data/Library/...` (TCC-denied to Terminal, no FDA), and loading requires Safari restart + `SafariActionTriggerManager` trigger + the toggle ON.

## What "done" looks like (acceptance)
- `pgrep -x safari_webextensiond` shows a process AND `bsk browsers` lists Safari, AND
- `bsk execute_script` (or `page.action`) succeeds against `https://example.com`.
NOT acceptance: relay `connected`/`ready` log lines (that's the relay, not a browser).

## Next steps, in order
1. **User action, ~2 min — the only real gate:** quit Safari → relaunch Safari → open **Hermes Safari Bridge.app** once (Launchpad; auto-triggers `SafariActionTriggerManager` to LOAD the extension — container existence ≠ loaded) → Safari **Settings → Extensions → Website Access → Turn On "Hermes Safari Bridge"**. **Keep Safari OPEN the whole test** (quitting Safari kills `safari_webextensiond`).
2. Optional UI-automation enabler first: `use_real_profile: false` in `~/.hermes/config.yaml` + **restart Hermes** → `browser_exec` works against Safari (Chrome irrelevant under `use_browsers: ["safari"]` — the default-browser check reads the live browser list, not the Safari-default setting; verified against source).
3. Check who owns :52800 before assuming a daemon exists: `lsof -nP -iTCP:52800 -sTCP:LISTEN` (a Python `browser-bridge-daemon.py` = Hermes's connector, NOT bsk). If empty → `bsk daemon start` as a persistent background process (10-min idle death).
4. Verify: `bsk browsers` (expect Safari) → `bsk session start` → `bsk execute_script` on `https://example.com`. Do **NOT** restart the daemon mid-test (daemon restart/stop also kills `safari_webextensiond` — observed twice).
5. Fallback if the extension still never appears: **Full Mac restart** (clears the stuck Safari webextensiond registration per prior notes) — ask the user first, never schedule it unattended. Wildcards after that: `BSK_WS_ALLOW_ANY=1`; `--mode server --public-url ws://<ssh -R tunnel>` (relay-routed daemon that never ran — research first).

## Gotchas (don't re-learn the hard way)
- `pgrep -fl bsk` / `pgrep -x bsk` match **Hermes's browser-bridge-daemon.py** (also on :52800). `bsk daemon stop` kills *whichever* daemon is registered in `~/.bsk/daemon.json` — accidentally killing Hermes's connector (done once) wedges Hermes automation and fakes `bsk status` output. Verify identity with `ps -p <pid> -o command` / `lsof -nP -iTCP:52800 -sTCP:LISTEN` before any kill/stop.
- `bsk session start` connects to an **already-running** daemon via `~/.bsk/run/daemon.sock` and never launches a browser (help: "connection always comes from a real browser with the extension loaded"). Run it ONLY after `safari_webextensiond` shows in `pgrep -x`.
- `~/Library/Containers/com.hermesagent.Hermes-Safari-Bridge(.Extension)` existing ≠ extension loaded — sandbox containers persist empty.
- Daemon log (JSON lines): `~/.bsk/daemon.log.YYYY-MM-DD` — `connecting/connected/ready` = relay; `ws server listening` = the local server that would receive the extension socket. Today's relay entries were Hermes's connector, not bsk.
- No `bsk setup` command exists (doctor only). No `safari-web-extension-packager` on this Mac; converter `--installation-type` unavailable → static-trust path untestable as written.

## Status line (as of 2026-10-01, end of session)
Code fixes: **complete**. Installed build: **complete + correct**. Connection test: **blocked** on one user action (Next step 1). End-of-session live state: Safari **NOT running**, `safari_webextensiond` **NOT running**, no `bsk` process (daemon was `stop`ped, so relaunch needed), `bsk browsers` → `(no browsers connected)`, config = `use_real_profile: true` + `use_browsers: ["chrome"]` (Chrome out of scope; `use_browsers: ["safari"]` + `use_real_profile: false` would enable Safari UI automation).

**First move in a new chat:** do Next step 1 (or step 2 → restart Hermes → drive Safari's UI via `browser_exec`/`computer_use`), then steps 3-4 **without restarting the daemon mid-test**.
