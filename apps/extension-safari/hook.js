// Page-world (MAIN) script: records console output and uncaught errors from
// document_start, and answers `evaluate` / `console` requests from content.js
// over window CustomEvents ('bsk-req' -> 'bsk-res', JSON strings only, so
// nothing but plain data crosses between the two JS worlds).
//
// manifest.json declares this with "world": "MAIN". If Safari ignores that
// key the file runs in the isolated world instead; the bottom of this file
// detects that (`browser.runtime.id` is set only there) and injects the same
// function into the page as a <script> element — which a strict page CSP can
// block, in which case content.js reports the page world as unavailable.
//
// Trust note: the page can see and forge these events, but everything they
// carry is about the page's own state, which the page controls anyway.
(() => {
function bskMain() {
  if (window.__bskMain) return;
  window.__bskMain = true;

  const MAX_ENTRIES = 1000;
  const buf = [];
  let seq = 0;

  // instanceof fails for errors from another realm (iframes), so ask the tag.
  const isError = (v) => Object.prototype.toString.call(v) === '[object Error]';
  const str = (v) => {
    try {
      if (typeof v === 'string') return v;
      if (isError(v)) return v.stack || `${v.name}: ${v.message}`;
      if (typeof v === 'object' && v !== null) return JSON.stringify(v) ?? String(v);
      return String(v);
    } catch { return Object.prototype.toString.call(v); }
  };

  // WebKit stack lines look like "fn@https://x/a.js:3:4"; V8-style
  // "at fn (https://x/a.js:3:4)" is handled too.
  const frames = (stack) => String(stack || '').split('\n').map((l) => {
    const m = /^\s*(?:at\s+)?(?:(.*?)(?:@|\s\())?(\S+?):(\d+):(\d+)\)?\s*$/.exec(l);
    return m ? { function_name: m[1] || undefined, url: m[2], line: +m[3], column: +m[4] } : null;
  }).filter(Boolean);

  const push = (kind, level, text, extra) => {
    buf.push({ sequence: ++seq, kind, level, text, timestamp: Date.now(), ...extra });
    if (buf.length > MAX_ENTRIES) buf.shift();
  };

  for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
    const orig = console[level];
    console[level] = function (...args) {
      try {
        const stack = new Error().stack;
        const where = frames(stack)[1] || {}; // [0] is this wrapper, [1] the caller
        push('console', level, args.map(str).join(' '), { url: where.url, line: where.line, column: where.column, stack });
      } catch { /* never break the page's own logging */ }
      return orig.apply(this, args);
    };
  }

  addEventListener('error', (e) => {
    if (e.target && e.target !== window) { // a failed <img>/<script>/<link> load
      push('log', 'error', `Failed to load resource: ${e.target.src || e.target.href || e.target.tagName}`);
    } else {
      push('exception', 'error', `Uncaught ${e.message}`, { url: e.filename, line: e.lineno, column: e.colno, stack: e.error && e.error.stack });
    }
  }, true);
  addEventListener('unhandledrejection', (e) => push('exception', 'error', `Unhandled promise rejection: ${str(e.reason)}`, { stack: e.reason && e.reason.stack }));
  addEventListener('securitypolicyviolation', (e) => push('log', 'error', `CSP violation: ${e.violatedDirective} blocked ${e.blockedURI}`, { url: e.sourceFile, line: e.lineNumber, column: e.columnNumber }));

  const serialize = (v) => {
    if (v === undefined) return undefined;
    if (typeof v === 'number' && !Number.isFinite(v)) return String(v);
    if (typeof v === 'bigint' || typeof v === 'function' || typeof v === 'symbol') return String(v);
    if (typeof Node !== 'undefined' && v instanceof Node) return (v.outerHTML || v.textContent || String(v)).slice(0, 2000);
    try {
      const json = JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? String(x) : x));
      if (json === undefined) return String(v);
      if (json.length > 512 * 1024) return `[result too large: ${json.length} chars]`;
      return JSON.parse(json);
    } catch { return String(v); } // circular, throwing getters, …
  };

  addEventListener('bsk-req', async (ev) => {
    let req;
    try { req = JSON.parse(ev.detail); } catch { return; }
    const reply = (obj) => dispatchEvent(new CustomEvent('bsk-res', { detail: JSON.stringify({ id: req.id, ...obj }) }));
    reply({ ack: true });
    if (req.type === 'console') {
      const entries = buf.filter((e) => e.sequence > (req.since || 0)).map(({ stack, ...e }) => (req.includeStack && stack ? { ...e, stack_trace: frames(stack).slice(1).filter((f) => !/^webkit-masked-url:/.test(f.url)) } : e));
      reply({ entries, lastSequence: seq });
    } else if (req.type === 'eval') {
      try {
        let v = (0, eval)(req.expression); // indirect eval: global scope, like Runtime.evaluate
        if (req.awaitPromise !== false && v && typeof v.then === 'function') v = await v;
        reply({ evalOk: true, value: serialize(v) });
      } catch (e) {
        const text = isError(e) ? `Uncaught ${e.name}: ${e.message}` : `Uncaught ${str(e)}`;
        reply({ evalOk: false, error: { text } });
      }
    }
  });
}

if (typeof module !== 'undefined') {
  module.exports = { bskMain };
} else if (typeof browser !== 'undefined' && browser.runtime && browser.runtime.id) {
  // Isolated world (manifest "world" ignored). Safari also defines `browser`
  // in the MAIN world, but only here is runtime.id set. Inject into the page world.
  try {
    const s = document.createElement('script');
    s.textContent = `(${bskMain.toString()})()`;
    (document.documentElement || document).appendChild(s);
    s.remove();
  } catch { /* blocked: evaluate/console will report the page world as unavailable */ }
} else {
  bskMain();
}
})();
