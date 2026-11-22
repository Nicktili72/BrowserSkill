# Safari notes

Read this first when `bsk browsers` shows **Safari** in the BROWSER column. The
rest of this skill describes the Chrome extension; the Safari extension speaks
the same protocol but has no debugger, so some things differ.

## Not supported — returns `unsupported`

Do not retry these or look for another way to get the same effect on the page;
tell the user it isn't available in Safari.

`download`, `debug`, `record`, `request_help`, `emulate`.

## Screenshots

`screenshot` captures the visible viewport; `--ref @eN` crops to that element
(scrolled into view; clamped if taller than the viewport); `--full-page` scrolls
and stitches the whole page (slow on long pages — about 30 s for 30,000 px —
and fixed/sticky headers and sidebars repeat in every frame; very tall pages are
scaled down to fit 32,000 px).

## When pages don't respond (site access)

Safari only lets the extension read sites the user has allowed. Signs it hasn't:
`bsk tab list` shows an **empty title and URL**, `snapshot`/`click` fail with
"no response from page", `wait-for-navigation` times out. Stop and ask the user
to open Safari → Settings → Extensions → BrowserSkill for Safari and choose
**Always Allow on Every Website…** (and confirm). Reinstalling the extension
resets this and the on/off switch. Do not keep retrying.

## Behaviour differences

- **Input is synthetic** (`isTrusted: false`). Almost all sites accept it; some
  anti-bot or banking pages ignore it. `fill` refuses password fields.
- **Tabs:** `tab create` opens a separate window. `tab borrow` does **not** move
  the tab; it needs the user to approve a small popup (default 60 s wait).
- **Dialogs:** `alert()`/`confirm()` can't be seen or dismissed; a click that
  opens one hangs until the user dismisses it. `dialogs` is always empty.
- **`hover`** fires script-level mouse/pointer events (JS menus, tooltips,
  React/Radix/jQuery hover work). Pure-CSS `:hover` effects do **not** trigger.
- **`evaluate`** runs in the page's JS world with indirect `eval`. Sites whose
  Content-Security-Policy forbids `unsafe-eval` (e.g. GitHub) return
  `ok:false` with an `EvalError` — that is final. `console` and `network` still
  work there.
- **`console` / `network`** buffer from page load (top frame only, 1000 entries)
  and **start over on navigation**; a `--since` cursor is per page load.
  `network` has an HTTP status only for `fetch`/XHR (images, scripts and the
  document show no status); WebSocket and browser-initiated requests are not
  seen; bodies/headers are never captured.
- **`upload`** takes ≤ **16 MiB per call**, as `--mode input` (a file input) or
  `--mode drop`. It needs the Safari-aware daemon; against a stock daemon it
  says so.
- **`observe`** is the same as `snapshot` (no hover probing or paging).
- **`wait-for-navigation`**: `networkidle` is approximated (load + 500 ms), and
  a call made before the navigation has started returns immediately — issue it
  after the action that causes the navigation.
- A tab that was already open before the extension was enabled needs a reload
  before `evaluate`/`console`/`network` work on it ("page-world script
  unavailable").

## Daemon

Start it with `BSK_AUTO_UPDATE=off`. `bsk` otherwise upgrades itself to the
upstream build, which rejects Safari's connection (`ws error` in Safari's
extension panel) and cannot do `upload`.
