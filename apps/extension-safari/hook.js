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
      const failed = e.target.src || e.target.href || e.target.tagName;
      push('log', 'error', `Failed to load resource: ${failed}`);
      resourceFailed(abs(failed), TAG_TYPES[e.target.tagName] || 'Other');
    } else {
      push('exception', 'error', `Uncaught ${e.message}`, { url: e.filename, line: e.lineno, column: e.colno, stack: e.error && e.error.stack });
    }
  }, true);
  addEventListener('unhandledrejection', (e) => push('exception', 'error', `Unhandled promise rejection: ${str(e.reason)}`, { stack: e.reason && e.reason.stack }));
  addEventListener('securitypolicyviolation', (e) => push('log', 'error', `CSP violation: ${e.violatedDirective} blocked ${e.blockedURI}`, { url: e.sourceFile, line: e.lineNumber, column: e.columnNumber }));

  // ---- network ----------------------------------------------------------
  // Safari gives an extension no network events, so this records what the
  // page itself does: fetch() and XMLHttpRequest are wrapped (method, status,
  // MIME type, failures), and everything else (images, scripts, stylesheets,
  // iframes, the document itself) comes from Resource Timing, which has a
  // status only for same-origin / Timing-Allow-Origin responses. Request and
  // response bodies and headers are never read.
  const netBuf = [];
  let netSeq = 0;
  const net = (e) => {
    netBuf.push({ sequence: ++netSeq, timestamp: Date.now(), ...e });
    if (netBuf.length > MAX_ENTRIES) netBuf.shift();
  };
  const abs = (u) => { try { return new URL(u && u.url ? u.url : String(u), location.href).href; } catch { return String(u); } };
  const mime = (ct) => (String(ct || '').split(';')[0].trim() || undefined);
  const RESOURCE_TYPES = { img: 'Image', image: 'Image', script: 'Script', css: 'Stylesheet', link: 'Stylesheet', iframe: 'Document', frame: 'Document', navigation: 'Document', video: 'Media', audio: 'Media', beacon: 'Ping', font: 'Font' };
  const TAG_TYPES = { IMG: 'Image', SCRIPT: 'Script', LINK: 'Stylesheet', IFRAME: 'Document', VIDEO: 'Media', AUDIO: 'Media', SOURCE: 'Media' };

  if (typeof window.fetch === 'function') {
    const origFetch = window.fetch;
    window.fetch = function (input, init) {
      const method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
      const url = abs(input);
      const p = origFetch.apply(this, arguments);
      p.then(
        (res) => net({ kind: 'response', method, url, status: res.status || undefined, status_text: res.statusText || undefined, mime_type: mime(res.headers && res.headers.get('content-type')), resource_type: 'Fetch' }),
        (err) => net({ kind: 'failure', method, url, error_text: String((err && err.message) || err), resource_type: 'Fetch' }),
      );
      return p; // the page gets the original promise untouched
    };
  }

  if (typeof window.XMLHttpRequest === 'function') {
    const proto = XMLHttpRequest.prototype;
    const meta = new WeakMap();
    const origOpen = proto.open, origSend = proto.send;
    proto.open = function (method, url) {
      meta.set(this, { method: String(method).toUpperCase(), url: abs(url) });
      return origOpen.apply(this, arguments);
    };
    proto.send = function () {
      const m = meta.get(this);
      if (m) {
        const xhr = this;
        const fail = (why) => () => net({ kind: 'failure', ...m, error_text: why, resource_type: 'XHR' });
        xhr.addEventListener('load', () => net({ kind: 'response', ...m, status: xhr.status || undefined, status_text: xhr.statusText || undefined, mime_type: mime(xhr.getResponseHeader('content-type')), resource_type: 'XHR' }));
        xhr.addEventListener('error', fail('network error'));
        xhr.addEventListener('abort', fail('aborted'));
        xhr.addEventListener('timeout', fail('timeout'));
      }
      return origSend.apply(this, arguments);
    };
  }

  // Safari also reports Resource Timing entries for loads that FAILED, so a
  // timing entry is held for a moment: if the element's own error event
  // arrives for the same URL, the entry is dropped and only the failure is
  // recorded (otherwise a broken image would show as a status-less "response").
  const GRACE_MS = 250;
  const pending = new Set(); // { url, timer, entry }
  const failedUrls = new Set();
  const commit = (p) => { clearTimeout(p.timer); pending.delete(p); net(p.entry); };
  const flushPending = () => [...pending].forEach(commit);
  const fromTiming = (e) => {
    if (e.initiatorType === 'fetch' || e.initiatorType === 'xmlhttprequest') return; // already recorded above
    if (failedUrls.has(e.name)) return; // the error event got here first
    const p = { url: e.name, entry: { kind: 'response', method: 'GET', url: e.name, status: e.responseStatus || undefined, resource_type: RESOURCE_TYPES[e.initiatorType] || 'Other', timestamp: Math.round(performance.timeOrigin + (e.responseEnd || e.startTime || 0)) } };
    p.timer = setTimeout(() => commit(p), GRACE_MS);
    pending.add(p);
  };
  const resourceFailed = (url, resource_type) => {
    if (failedUrls.size > 500) failedUrls.clear();
    failedUrls.add(url);
    for (const p of [...pending]) if (p.url === url) { clearTimeout(p.timer); pending.delete(p); }
    net({ kind: 'failure', method: 'GET', url, error_text: 'failed to load', resource_type });
  };
  if (typeof PerformanceObserver === 'function') {
    try { new PerformanceObserver((list) => list.getEntries().forEach(fromTiming)).observe({ type: 'resource', buffered: true }); } catch { /* old Safari: no network entries for subresources */ }
  }
  addEventListener('DOMContentLoaded', () => {
    try {
      const n = performance.getEntriesByType('navigation')[0];
      if (n) net({ kind: 'response', method: 'GET', url: location.href, status: n.responseStatus || undefined, mime_type: mime(document.contentType), resource_type: 'Document' });
    } catch { /* ignore */ }
  });

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
    } else if (req.type === 'network') {
      flushPending(); // anything still in its grace period is reported now
      reply({ entries: netBuf.filter((e) => e.sequence > (req.since || 0)), lastSequence: netSeq });
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
