# BrowserSkill for Safari

Lets `bsk` (BrowserSkill's own CLI + daemon, unmodified in spirit) drive **Safari**, the same way the upstream extension drives Chrome/Edge — so Hermes Agent, Claude Code, Cursor, Codex, or any other `bsk`-aware agent harness can automate Safari too.

This is a from-scratch Safari extension speaking `bsk`'s real wire protocol (`bsk-protocol`), not a bridge process and not a separate tool. One small patch to the daemon (`crates/bsk-cli/src/daemon/ws.rs`, branch `safari-support`) is the only change to the Rust side.

## Status

**Working end-to-end**, verified against a real `bsk daemon` and real Safari: `session start/stop`, `tab_list/create/close/select/borrow/return`, `navigate`, `snapshot`, `click`, `fill`, `press`, `scroll_to`, `screenshot`. Anything else in `bsk-protocol`'s `Method` enum (upload, download, network, console, debug, record, evaluate, hover, wheel, focus/blur, select, get_html, observe, wait_*, request_help) returns a clean `unsupported` RPC error rather than silently no-op'ing.

11/11 Node tests pass (`test/`), plus the page-driver logic (`content.js`) has been exercised live against real DOM.

## Why Safari needed its own extension, not a port

The real BrowserSkill extension is built on `chrome.debugger` (CDP) for input, layout, and network capture. Safari has none of that. This extension instead:
- reads/acts on the page via a declared content script + `browser.tabs.sendMessage`, with its own lightweight ref registry (`@e1`-style, populated by `snapshot`) instead of CDP's accessibility tree,
- computes click/scroll coordinates via `getBoundingClientRect()` after explicitly activating+focusing the target tab (a backgrounded Safari tab returns zero-sized layout — confirmed while building this),
- has no equivalent of Chrome's dedicated "Agent Window": `windows.create({tabId})` does not move an existing tab in Safari (long-standing WebKit bug), and `tabs.move` isn't supported at all. So `tab_borrow` doesn't relocate a tab into a separate window like the Chrome extension does — it only marks the tab as session-owned, after a human approves it in a small confirmation popup (`confirm.html`/`confirm.js`). This is reported honestly to the daemon via the handshake's `interaction.borrow_confirmation: "always"`, not silently skipped.
- has no dialog interception (no `Page.javascriptDialogOpening` equivalent): a page's `alert()`/`confirm()` blocks that tab's JS thread with no way to observe or dismiss it remotely. `dialogs` is always reported as `[]`; a click that triggers a real dialog will hang until a human dismisses it or the CLI's own timeout fires.
- `tool.tab_create` still gets a real, working isolated window (`windows.create({url})` with no `tabId` works fine in Safari) — only *moving an existing tab* is the broken primitive.

## Build & run

```bash
cd apps/extension-safari
./rebuild.sh   # regenerates + builds the Xcode wrapper (see the script's own header comment
               # for two real gotchas it works around: --copy-resources is required or the
               # built extension silently ships with no manifest.json, and the wrapper's
               # project-location must NOT be nested inside this folder or it recurses into
               # itself and fails)
```

Then, every time Safari has been fully quit (macOS resets this on every full quit — not a one-time step):
1. Safari → Develop → **Allow Unsigned Extensions**
2. Safari → Settings → Extensions → enable **"BrowserSkill for Safari"**, allow on every website
3. `bsk daemon start` (or let a `bsk` command auto-start it)
4. `bsk browsers` should show one connected Safari instance

### Signing / distribution

A Developer ID–signed, notarized build removes the "Allow Unsigned Extensions" requirement for end users (confirmed: Safari 18.4+ supports Developer ID distribution outside the Mac App Store — see [Apple's docs](https://developer.apple.com/documentation/safariservices/distributing-your-safari-web-extension)). The export/notarize flow (`xcodebuild archive` → `-exportArchive` with `method: developer-id` → `notarytool submit --wait` → `stapler staple`) has been run successfully once against this build; stapling occasionally lags Apple's ticket-CDN propagation by longer than a few minutes, which is a known, unrelated-to-this-code quirk — retry `stapler staple` later rather than treating it as a build problem.

## Bugs found and fixed while building this (worth knowing if you touch this code)

- **`ref` vs `ref_`**: `bsk-protocol`'s Rust structs use `pub ref_: Option<String>` (trailing underscore to dodge the `ref` keyword) with `#[serde(rename = "ref", alias = "ref_")]` — the actual wire JSON key is `"ref"`. Reading `p.ref_` in JS (matching the Rust field name instead of the wire name) silently reads `undefined` forever. Same pattern for any other Rust-keyword-adjacent field name.
- **Top-level `const` colliding with a sibling script's global**: `manifest.json` loads `protocol.js` and `background.js` as two separate classic scripts sharing one global scope. `protocol.js`'s `function handshakeParams(...)` becomes a real global property; a `const { handshakeParams } = ...` at `background.js`'s own top level is then an illegal redeclaration — a `SyntaxError` that kills the entire file before it runs a single line, with zero runtime evidence beyond Safari's Settings → Extensions error panel. Any such cross-file lookups need to happen inside a function body, not at a script's top level.
- **`safari-web-extension-converter --copy-resources`**: without this flag, this build of the converter produces an extension target with an *empty* `Resources/` folder — no error, no warning, the extension just never appears in Safari's Extensions list at all. With the flag, the source directory is copied *verbatim* — never point `--project-location` at a path nested inside the source directory, or it recurses into its own output until it hits a path-length error.
