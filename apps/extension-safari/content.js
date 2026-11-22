// Page-side driver (isolated world, one instance per tab/frame). Answers
// {op, ...} messages from background.js and returns {ok, ...} or
// {ok:false, error:{code, message}}.
//
// Element targeting: bsk's protocol lets a caller address an element by
// `selector` (plain CSS, always available) or `ref_` (an id from the most
// recent tool.snapshot). We support both; refs live only until the next
// snapshot or a page navigation, same as the real extension.
(() => {
  if (window.__bskContent) return;
  window.__bskContent = true;

  const refs = new Map(); // 'e1' -> Element, refreshed on every snapshot
  const SEL = 'a[href],button,input,select,textarea,[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[contenteditable=""],[contenteditable=true]';

  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none';
  };
  const clean = (s) => String(s || '').trim().replace(/\s+/g, ' ').slice(0, 80);
  const label = (el) => {
    const btn = el.tagName === 'INPUT' && ['button', 'submit', 'reset'].includes(el.type);
    return clean(el.getAttribute('aria-label') || el.labels?.[0]?.innerText || el.placeholder || el.innerText || (btn && el.value) || el.title || el.alt);
  };
  const describe = (el) => `${el.tagName.toLowerCase()}${el.type ? `[${el.type}]` : ''} "${label(el)}"`;

  function snapshot(maxChars) {
    refs.clear();
    const lines = [];
    let n = 0;
    for (const el of document.querySelectorAll(SEL)) {
      if (el.disabled || !visible(el)) continue;
      const id = 'e' + ++n;
      refs.set(id, el);
      const val = el.type !== 'password' && el.value && el.tagName !== 'BUTTON' && !['button', 'submit'].includes(el.type) ? ` value="${clean(el.value)}"` : '';
      const href = el.tagName === 'A' ? ` -> ${clean(el.getAttribute('href'))}` : '';
      lines.push(`[${id}] ${describe(el)}${val}${href}`);
    }
    const text = (document.body?.innerText || '').replace(/\n{3,}/g, '\n\n').slice(0, Math.max(0, maxChars - 1));
    let full = `URL: ${location.href}\nTITLE: ${document.title}\n\nELEMENTS:\n${lines.join('\n')}\n\nPAGE TEXT:\n${text}`;
    let truncated = false;
    if (full.length > maxChars) { full = full.slice(0, maxChars); truncated = true; }
    return { text: full, refCount: refs.size, truncated };
  }

  // Resolves {ref, selector} to one element, or throws {code, message}.
  // A leading '@' is stripped so '@e1' and 'e1' both resolve — this matches
  // upstream's ref-store normaliseRef() and is why @e1 stays in the snapshot
  // format and in tool schemas (see NOTES.md).
  function resolve({ ref, selector }) {
    if (ref) {
      const key = ref.replace(/^@/, '');
      const el = refs.get(key);
      if (!el || !el.isConnected) throw { code: 'not_found', message: `ref ${ref} not found; call snapshot again` };
      return { el, usedRef: ref, usedSelector: undefined };
    }
    if (selector) {
      const el = document.querySelector(selector);
      if (!el) throw { code: 'not_found', message: `no element matches selector ${selector}` };
      return { el, usedRef: undefined, usedSelector: selector };
    }
    throw { code: 'invalid_params', message: 'ref or selector is required' };
  }

  function centerOf(el) {
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }

  // Focused element, descending into open shadow roots.
  const activeElement = () => {
    let a = document.activeElement;
    while (a?.shadowRoot?.activeElement) a = a.shadowRoot.activeElement;
    return a;
  };

  // Nearest ancestor that can actually scroll, else the page itself.
  const scroller = (el) => {
    for (let n = el; n && n !== document.body && n !== document.documentElement; n = n.parentElement) {
      const s = getComputedStyle(n);
      if (/(auto|scroll)/.test(s.overflowY + s.overflowX) && (n.scrollHeight > n.clientHeight || n.scrollWidth > n.clientWidth)) return n;
    }
    return window;
  };

  // Request/response with hook.js in the page world over window CustomEvents
  // (JSON strings only). hook.js acks immediately, so "no ack" means the
  // page-world script isn't there (blocked by CSP, or the tab was loaded
  // before the extension was enabled) — distinct from a slow evaluation.
  let reqSeq = 0;
  function callMain(req, { ackMs = 1500, timeoutMs = 30000 } = {}) {
    return new Promise((resolve, reject) => {
      const id = ++reqSeq;
      let ackTimer, doneTimer;
      const finish = (fn, v) => { clearTimeout(ackTimer); clearTimeout(doneTimer); removeEventListener('bsk-res', on); fn(v); };
      const on = (ev) => {
        let r;
        try { r = JSON.parse(ev.detail); } catch { return; }
        if (r.id !== id) return;
        if (r.ack) { clearTimeout(ackTimer); return; }
        finish(resolve, r);
      };
      addEventListener('bsk-res', on);
      ackTimer = setTimeout(() => finish(reject, { code: 'unsupported', message: 'page-world script unavailable on this page (blocked by its Content-Security-Policy, or the tab loaded before the extension was enabled — reload it)' }), ackMs);
      doneTimer = setTimeout(() => finish(reject, { code: 'timeout', message: `no result after ${timeoutMs} ms` }), timeoutMs);
      dispatchEvent(new CustomEvent('bsk-req', { detail: JSON.stringify({ id, ...req }) }));
    });
  }

  const setValue = (el, v) => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
  };

  const ops = {
    snapshot: (m) => snapshot(m.maxChars || 8000),
    click: (m) => {
      const { el, usedRef, usedSelector } = resolve(m);
      const { x, y } = centerOf(el);
      el.click();
      return { x, y, usedRef, usedSelector };
    },
    fill: (m) => {
      const { el, usedRef, usedSelector } = resolve(m);
      if (el.type === 'password') throw { code: 'permission_denied', message: 'refusing to fill a password field' };
      el.focus();
      if (el.isContentEditable) {
        if (m.clearBefore !== false) el.textContent = '';
        el.textContent += m.value;
      } else {
        setValue(el, m.clearBefore === false ? (el.value || '') + m.value : m.value);
      }
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { usedRef, usedSelector, valueLength: m.value.length };
    },
    press: (m) => {
      let el = document.activeElement || document.body;
      let usedRef, usedSelector;
      if (m.ref || m.selector) ({ el, usedRef, usedSelector } = resolve(m));
      el.focus?.();
      // m.modifiers arrives as ['Control','Alt','Shift','Meta'] subsets —
      // mapped to the KeyboardEvent booleans (and echoed back as `code`s by
      // background.js). No modifier = exactly the old behaviour.
      const mods = m.modifiers || [];
      const hasMod = (n) => mods.includes(n);
      // Enter on a form field: submit the form ONCE, via requestSubmit, and
      // skip the synthetic event dispatch entirely — page JS that listens for
      // Enter-keydown would otherwise fire, so the submit would happen twice.
      // Untrusted synthetic keydown does NOT trigger native Enter-submit on
      // its own; without this branch, JS-submitting pages got requestSubmit
      // as a second submit. See NOTES.md.
      const submitOnEnter = m.key === 'Enter' && el.form && !hasMod('Control') && !hasMod('Alt') && !hasMod('Meta');
      if (!submitOnEnter) {
        for (const t of ['keydown', 'keypress', 'keyup']) {
          el.dispatchEvent(new KeyboardEvent(t, {
            key: m.key, code: m.code, bubbles: true, cancelable: true,
            ctrlKey: hasMod('Control'), altKey: hasMod('Alt'), metaKey: hasMod('Meta'),
          }));
        }
      } else {
        el.form.requestSubmit(el.form.querySelector('[type=submit],button:not([type])') || undefined);
      }
      return { usedRef, usedSelector };
    },
    scrollTo: (m) => {
      const { el, usedRef, usedSelector } = resolve(m);
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height, usedRef, usedSelector };
    },
    evaluate: async (m) => {
      const r = await callMain({ type: 'eval', expression: m.expression, awaitPromise: m.awaitPromise }, { ackMs: m.ackMs, timeoutMs: m.timeoutMs });
      return { evalOk: r.evalOk, value: r.value, error: r.error };
    },
    console: async (m) => {
      const limit = Math.min(m.limit || 100, 500);
      const maxText = Math.min(m.maxTextChars || 2000, 10000);
      const r = await callMain({ type: 'console', since: m.since || 0, includeStack: !!m.includeStack }, { ackMs: m.ackMs });
      const page = r.entries.slice(0, limit);
      const entries = page.map((e) => {
        const text = String(e.text);
        const out = { sequence: e.sequence, kind: e.kind, level: e.level, text: text.slice(0, maxText), url: e.url, line: e.line, column: e.column, timestamp: e.timestamp, truncated: text.length > maxText };
        if (e.stack_trace) out.stack_trace = e.stack_trace;
        return out;
      });
      return { entries, nextSince: entries.length ? entries[entries.length - 1].sequence : m.since || 0, truncated: r.entries.length > limit };
    },
    network: async (m) => {
      const limit = Math.min(m.limit || 100, 500);
      const maxText = Math.min(m.maxTextChars || 2000, 10000);
      const r = await callMain({ type: 'network', since: m.since || 0 }, { ackMs: m.ackMs });
      const clip = (s) => (s === undefined ? [undefined, false] : [String(s).slice(0, maxText), String(s).length > maxText]);
      const entries = r.entries.slice(0, limit).map((e) => {
        const [url, urlCut] = clip(e.url);
        const [errorText, errCut] = clip(e.error_text);
        return { sequence: e.sequence, kind: e.kind, method: e.method, url, status: e.status, status_text: e.status_text, mime_type: e.mime_type, resource_type: e.resource_type, error_text: errorText, timestamp: e.timestamp, truncated: urlCut || errCut };
      });
      return { entries, nextSince: entries.length ? entries[entries.length - 1].sequence : m.since || 0, truncated: r.entries.length > limit };
    },
    getHtml: (m) => {
      const { el, usedRef, usedSelector } = m.ref || m.selector ? resolve(m) : { el: document.documentElement };
      const bytes = new TextEncoder().encode(el.outerHTML);
      const max = m.maxBytes || 524288;
      const truncated = bytes.length > max;
      const html = truncated ? new TextDecoder().decode(bytes.slice(0, max)) : el.outerHTML;
      return { html, truncated, byteSize: bytes.length, usedRef, usedSelector };
    },
    select: (m) => {
      const { el, usedRef, usedSelector } = resolve(m);
      if (el.tagName !== 'SELECT') throw { code: 'invalid_params', message: 'target is not a <select>' };
      const values = m.values || [];
      if (!el.multiple && values.length !== 1) throw { code: 'invalid_params', message: 'a single-select needs exactly one value' };
      const missing = values.find((v) => ![...el.options].some((o) => o.value === v));
      if (missing !== undefined) throw { code: 'not_found', message: `no option with value ${JSON.stringify(missing)}` };
      for (const o of el.options) o.selected = values.includes(o.value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      const sel = [...el.selectedOptions];
      return { usedRef, usedSelector, multiple: el.multiple, selectedValues: sel.map((o) => o.value), selectedLabels: sel.map((o) => o.label) };
    },
    focus: (m) => {
      const { el, usedRef, usedSelector } = resolve(m);
      el.focus();
      return { usedRef, usedSelector, focused: activeElement() === el };
    },
    blur: (m) => {
      const { el, usedRef, usedSelector } = resolve(m);
      const wasFocused = activeElement() === el;
      el.blur();
      return { usedRef, usedSelector, wasFocused, focused: activeElement() === el };
    },
    // A synthetic WheelEvent (untrusted) does not scroll anything by itself,
    // so after dispatching it for the page's own handlers we scroll the
    // nearest scrollable ancestor ourselves — unless a handler cancelled it.
    wheel: (m) => {
      let el, usedRef, usedSelector, x = innerWidth / 2, y = innerHeight / 2;
      if (m.ref || m.selector) { ({ el, usedRef, usedSelector } = resolve(m)); ({ x, y } = centerOf(el)); }
      const target = document.elementFromPoint(x, y) || el || document.body;
      const mods = m.modifiers || [];
      const dx = m.deltaX || 0, dy = m.deltaY || 0;
      const notCancelled = target.dispatchEvent(new WheelEvent('wheel', {
        bubbles: true, cancelable: true, clientX: x, clientY: y, deltaX: dx, deltaY: dy, deltaMode: 0,
        ctrlKey: mods.includes('Control'), altKey: mods.includes('Alt'), shiftKey: mods.includes('Shift'), metaKey: mods.includes('Meta'),
      }));
      if (notCancelled) scroller(target).scrollBy({ left: dx, top: dy, behavior: 'instant' });
      return { usedRef, usedSelector, x, y, deltaX: dx, deltaY: dy };
    },
    // captureVisibleTab returns a PNG at device pixels; this reports its
    // actual dimensions so background.js can fill ScreenshotResult's
    // required width/height without decoding the PNG itself.
    viewportSize: () => ({
      width: Math.round(document.documentElement.clientWidth * devicePixelRatio),
      height: Math.round(document.documentElement.clientHeight * devicePixelRatio),
    }),
  };

  // Ops may be sync or async (evaluate/console wait on the page world).
  browser.runtime.onMessage.addListener((m) => {
    if (!m || !ops[m.op]) return;
    return (async () => ops[m.op](m))().then(
      (r) => ({ ok: true, ...r }),
      (e) => ({ ok: false, error: e.code ? e : { code: 'protocol_error', message: String(e.message || e) } }),
    );
  });
})();
