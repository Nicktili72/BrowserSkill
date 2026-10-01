// Pure wire-protocol helpers, shared by background.js (classic script) and
// the Node test harness (via module.exports). No browser API calls here.

const PROTOCOL_VERSION = '1.3';
// Lowest daemon protocol we require; matches bsk-cli's MIN_COMPATIBLE_PROTOCOL
// floor so a much-older daemon fails the handshake instead of half-working.
const MIN_COMPATIBLE_PROTOCOL = '1.0';
const CLIENT_NAME = 'browser-skill-safari-extension';

function handshakeParams({ instanceId, extVersion, browserVersion, label }) {
  return {
    client: CLIENT_NAME,
    version: extVersion,
    protocol_version: PROTOCOL_VERSION,
    instance_id: instanceId,
    browser: { name: 'Safari', version: browserVersion },
    label,
    min_compatible_peer: '0.0.0', // deprecated field; daemon ignores on read
    min_compatible_protocol: MIN_COMPATIBLE_PROTOCOL,
  };
}

// Safari has no CDP dialog interception (Page.javascriptDialogOpening), so a
// page's alert()/confirm()/prompt() blocks that tab's JS thread with no way
// for us to observe or auto-dismiss it. dialogs is always empty; a click
// that triggers one will hang until the human dismisses it or the CLI's
// request times out. See NOTES.md.
const NO_DIALOGS = [];

// KeyboardEvent.code for the keys `bsk` actually sends (Enter/Tab/Escape/
// arrows/space + plain characters, which use "Key<X>"/"Digit<N>"). Anything
// else falls back to `key` itself — good enough for the MVP tool set; a
// wrong `code` only affects the (rarely inspected) result field, not whether
// the keypress fires.
const KEY_CODES = {
  Enter: 'Enter', Tab: 'Tab', Escape: 'Escape', Backspace: 'Backspace',
  Delete: 'Delete', ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown',
  ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight', ' ': 'Space', Home: 'Home',
  End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
};
function keyToCode(key) {
  if (key === 'Control' || key === 'Alt' || key === 'Meta' || key === 'Shift') return key + 'Left';
  if (KEY_CODES[key]) return KEY_CODES[key];
  // Combos like 'Control+a': the real `code` is the MAIN key ('KeyA'), and
  // the prefix names the modifier(s). Without this the whole combo string
  // leaked through as a junk `code`.
  const plus = key.lastIndexOf('+');
  if (plus > 0) {
    const mods = key.slice(0, plus).split('+');
    const main = key.slice(plus + 1);
    if (mods.every((m) => m === 'Control' || m === 'Alt' || m === 'Meta' || m === 'Shift') && main) return keyToCode(main);
  }
  if (/^[a-zA-Z]$/.test(key)) return 'Key' + key.toUpperCase();
  if (/^[0-9]$/.test(key)) return 'Digit' + key;
  return key;
}

// 'Control+Alt+Delete' -> ['Control','Alt'] (empty when `key` has no
// modifier prefix). These go out in tool.press's `modifiers` wire field.
function keyToModifiers(key) {
  const plus = key.lastIndexOf('+');
  if (plus <= 0) return [];
  const mods = key.slice(0, plus).split('+');
  return mods.every((m) => m === 'Control' || m === 'Alt' || m === 'Meta' || m === 'Shift') && key.slice(plus + 1)
    ? mods
    : [];
}

function rpcOk(id, result) {
  return { id, result };
}
function rpcErr(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  return { id, error };
}

if (typeof module !== 'undefined') {
  module.exports = { PROTOCOL_VERSION, MIN_COMPATIBLE_PROTOCOL, handshakeParams, NO_DIALOGS, keyToCode, keyToModifiers, rpcOk, rpcErr };
} else {
  // manifest.json loads this as a separate classic script from
  // background.js: `const`/`let` top-level bindings do NOT become
  // properties of the shared global object the way `function`
  // declarations do, so background.js can't see NO_DIALOGS (or the
  // other const-only exports) as a bare identifier without this.
  self.PROTOCOL_VERSION = PROTOCOL_VERSION;
  self.MIN_COMPATIBLE_PROTOCOL = MIN_COMPATIBLE_PROTOCOL;
  self.NO_DIALOGS = NO_DIALOGS;
}
