# BrowserSkill for Safari

Lets `bsk` (BrowserSkill's own CLI + daemon, unmodified in spirit) drive **Safari**, the same way the upstream extension drives Chrome/Edge — so Hermes Agent, Claude Code, Cursor, Codex, or any other `bsk`-aware agent harness can automate Safari too.

This is a from-scratch Safari extension speaking `bsk`'s real wire protocol (`bsk-protocol`), not a bridge process and not a separate tool.

This repo is just the extension — it doesn't carry BrowserSkill's own (large) source tree. `bsk` itself needs one small patch to its daemon before it will accept a Safari connection at all (it only recognizes `chrome-extension://` origins otherwise); that patch is [`daemon-origin-patch.diff`](daemon-origin-patch.diff) in this repo. Either:
- clone [Tencent/BrowserSkill](https://github.com/Tencent/BrowserSkill), apply `daemon-origin-patch.diff` (required) and `daemon-upload-patch.diff` (only needed for `upload`) with `git am`, and `cargo build -p bsk`, or
- use the [full fork](https://github.com/Nicktili72/BrowserSkill/tree/safari-support) (branch `safari-support`), which already has it applied and also contains this same extension under `apps/extension-safari/`.

## Status

**Working end-to-end**, verified against a real `bsk daemon` and real Safari: `session start/stop`, `tab_list/create/close/select/borrow/return`, `navigate`, `snapshot`, `observe`, `click`, `fill`, `press`, `select`, `focus`, `blur`, `wheel`, `scroll_to`, `get_html`, `wait_for_navigation`, `evaluate`, `console`, `network`, `upload`, `hover`, `reload`, `navigate_back`, `navigate_forward`, `window_resize`, `screenshot` (viewport, element crop, full page). Anything else in `bsk-protocol`'s `Method` enum (download, debug, record, request_help, emulate) returns a clean `unsupported` RPC error rather than silently no-op'ing.

Caveats on the newer ones: `observe` is just `snapshot` (no hover probing or paging); `wheel` dispatches a synthetic wheel event and then scrolls the nearest scrollable element itself (unless the page cancelled the event); `wait_for_navigation` is based on Safari's tab loading/complete status, so `networkidle` is approximated with a fixed 500 ms quiet period and a call made *before* a navigation starts returns immediately.

`evaluate` and `console` run through `hook.js`, a script the manifest loads into the **page's own JS world** (`"world": "MAIN"`) at `document_start`. Consequences: `console` captures `console.*` calls, uncaught exceptions, unhandled rejections, failed resource loads and CSP violations from page load onward (top frame only; the 1000-entry buffer resets on navigation) and works even under a strict Content-Security-Policy. `evaluate` uses indirect `eval`, so a page whose CSP forbids `unsafe-eval` (GitHub, for one) answers with an in-band `Uncaught EvalError … 'unsafe-eval' … not an allowed source` — there is no way around that from an extension. A tab loaded before the extension was enabled needs a reload (the calls report "page-world script unavailable"). Safari older than the one this was tested on (27.3) may ignore `"world": "MAIN"`; `hook.js` then injects itself as a `<script>`, which strict-CSP pages block.

`network` is recorded by `hook.js` from inside the page, because Safari gives extensions no network events: the page's own `fetch()` and `XMLHttpRequest` calls are wrapped (method, URL, status, status text, MIME type, and failures such as CORS/DNS errors), and everything else (images, scripts, stylesheets, iframes, fonts, the document itself) comes from Resource Timing and element load errors. **Status codes exist only for `fetch`/XHR** — Safari reports no HTTP status for subresources or the document, so those entries have none; a failed image/script/stylesheet load is reported once as a `failure`. Bodies and headers are never read; WebSocket, `sendBeacon` and requests made by the browser itself (favicon, prefetch) are not seen; entries are buffered per page load (1000 max) and start over on navigation.

`upload` needs a second, small daemon patch ([`daemon-upload-patch.diff`](daemon-upload-patch.diff); already applied on the fork's `safari-support` branch). Chrome's extension sets files from a path on disk; Safari's sandboxed extension can't read paths, so for Safari browsers the daemon also inlines each file's bytes (base64, **16 MiB per call**). The page gets real `File` objects via `DataTransfer` (`mode: input` sets `input.files` and fires `input`/`change`; `mode: drop` fires `dragenter`/`dragover`/`drop` with the files). Verified byte-exact (SHA-256 of a 3 MB file read back in the page). Against a stock daemon, `upload` answers `unsupported` with an explanation.

`hover` dispatches **synthetic** pointer/mouse events along the element chain (`over`/`enter`/`move`, and `out`/`leave` on the previous target, with `relatedTarget` and `pointerType: "mouse"`), so script-driven hover menus and tooltips open (verified on a nested jQuery UI menu). The browser's real `:hover` state can't be set from an extension, so **pure-CSS hover effects don't trigger**.

`reload`, `navigate_back` and `navigate_forward` (Safari's `tabs.goBack`/`goForward` when present, else `history.go` from the content script) wait for the load to start and finish and report `previous_url`/`final_url`; going back/forward with no history entry is a clear `not_found`. `window_resize` sets the Agent Window's outer size and reports what Safari actually applied. `screenshot` with a ref scrolls the element into view and crops the visible capture to it (an element taller than the viewport is clamped to the visible part). The **full-page** screenshot scrolls top to bottom, captures each viewport and stitches them on a canvas in the extension: fixed/sticky elements repeat in every frame, lazy content loads as it scrolls (about 11 frames in ~30 s for a 30,000 px article), and a page taller than 32,000 device pixels is **scaled down** to fit rather than cut off.

67/67 Node tests pass (`test/`), plus the page-driver logic (`content.js`) has been exercised live against real DOM. The toolbar icon's popup (`popup.html`) shows daemon connection + session status read-only by design: a popup-side "turn control off" would only stop *new* commands — the daemon keeps its socket either way — so it would be theatre, not a kill switch.

## Why Safari needed its own extension, not a port

The real BrowserSkill extension is built on `chrome.debugger` (CDP) for input, layout, and network capture. Safari has none of that. This extension instead:
- reads/acts on the page via a declared content script + `browser.tabs.sendMessage`, with its own lightweight ref registry (`@e1`-style, populated by `snapshot`) instead of CDP's accessibility tree,
- computes click/scroll coordinates via `getBoundingClientRect()` after explicitly activating+focusing the target tab (a backgrounded Safari tab returns zero-sized layout — confirmed while building this),
- has no equivalent of Chrome's dedicated "Agent Window": `windows.create({tabId})` does not move an existing tab in Safari (long-standing WebKit bug), and `tabs.move` isn't supported at all. So `tab_borrow` doesn't relocate a tab into a separate window like the Chrome extension does — it only marks the tab as session-owned, after a human approves it in a small confirmation popup (`confirm.html`/`confirm.js`). This is reported honestly to the daemon via the handshake's `interaction.borrow_confirmation: "always"`, not silently skipped.
- has no dialog interception (no `Page.javascriptDialogOpening` equivalent): a page's `alert()`/`confirm()` blocks that tab's JS thread with no way to observe or dismiss it remotely. `dialogs` is always reported as `[]`; a click that triggers a real dialog will hang until a human dismisses it or the CLI's own timeout fires.
- `tool.tab_create` still gets a real, working isolated window (`windows.create({url})` with no `tabId` works fine in Safari) — only *moving an existing tab* is the broken primitive.

## Build & run

```bash
./rebuild.sh   # regenerates + builds the Xcode wrapper (see the script's own header comment
               # for two real gotchas it works around: --copy-resources is required or the
               # built extension silently ships with no manifest.json, and the wrapper's
               # project-location must NOT be nested inside this folder or it recurses into
               # itself and fails)
```

Then, every time Safari has been fully quit (macOS resets this on every full quit — not a one-time step):
1. Safari → Develop → **Allow Unsigned Extensions**
2. Safari → Settings → Extensions → enable **"BrowserSkill for Safari"**, allow on every website
3. `BSK_AUTO_UPDATE=off bsk daemon start` (or export `BSK_AUTO_UPDATE=off` in your shell profile and let a `bsk` command auto-start it). **Keep auto-update off:** `bsk`'s daemon upgrades its own binary in the background, and the upgrade replaces your patched build with upstream's, which rejects Safari's origin — the extension then shows `[bsk] ws error` in Safari's extension error panel and never connects.
4. `bsk browsers` should show one connected Safari instance

### Signing / distribution

A Developer ID–signed, notarized build removes the "Allow Unsigned Extensions" requirement (confirmed: Safari 18.4+ supports Developer ID distribution outside the Mac App Store — see [Apple's docs](https://developer.apple.com/documentation/safariservices/distributing-your-safari-web-extension)). See [`NOTES.md`](NOTES.md) for the full archive/sign/notarize procedure, `check-notarization.sh` to staple and check, and a troubleshooting note for "Record not found" when stapling (it means the exported app isn't the build you submitted — resubmit the current export).

## Bugs found and fixed while building this (worth knowing if you touch this code)

- **`ref` vs `ref_`**: `bsk-protocol`'s Rust structs use `pub ref_: Option<String>` (trailing underscore to dodge the `ref` keyword) with `#[serde(rename = "ref", alias = "ref_")]` — the actual wire JSON key is `"ref"`. Reading `p.ref_` in JS (matching the Rust field name instead of the wire name) silently reads `undefined` forever. Same pattern for any other Rust-keyword-adjacent field name.
- **Top-level `const` colliding with a sibling script's global**: `manifest.json` loads `protocol.js` and `background.js` as two separate classic scripts sharing one global scope. `protocol.js`'s `function handshakeParams(...)` becomes a real global property; a `const { handshakeParams } = ...` at `background.js`'s own top level is then an illegal redeclaration — a `SyntaxError` that kills the entire file before it runs a single line, with zero runtime evidence beyond Safari's Settings → Extensions error panel. Any such cross-file lookups need to happen inside a function body, not at a script's top level.
- **`safari-web-extension-converter --copy-resources`**: without this flag, this build of the converter produces an extension target with an *empty* `Resources/` folder — no error, no warning, the extension just never appears in Safari's Extensions list at all. With the flag, the source directory is copied *verbatim* — never point `--project-location` at a path nested inside the source directory, or it recurses into its own output until it hits a path-length error.

## Agent skill notes

`bsk install-skill` installs Tencent's Chrome-oriented skill. [`skill/safari.md`](skill/safari.md) is a short Safari addendum for agents (unsupported commands, the site-access symptom, behaviour differences); after installing the skill run `skill/install-safari-notes.sh` to add it to every installed `browser-skill` and link it from `SKILL.md` (idempotent; re-run after `bsk install-skill --force`).
