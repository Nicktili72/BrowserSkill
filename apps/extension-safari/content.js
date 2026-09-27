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
  function resolve({ ref, selector }) {
    if (ref) {
      const el = refs.get(ref);
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
      for (const t of ['keydown', 'keypress', 'keyup']) {
        el.dispatchEvent(new KeyboardEvent(t, { key: m.key, code: m.code, bubbles: true, cancelable: true }));
      }
      if (m.key === 'Enter' && el.form) el.form.requestSubmit(el.form.querySelector('[type=submit],button:not([type])') || undefined);
      return { usedRef, usedSelector };
    },
    scrollTo: (m) => {
      const { el, usedRef, usedSelector } = resolve(m);
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height, usedRef, usedSelector };
    },
    // captureVisibleTab returns a PNG at device pixels; this reports its
    // actual dimensions so background.js can fill ScreenshotResult's
    // required width/height without decoding the PNG itself.
    viewportSize: () => ({
      width: Math.round(document.documentElement.clientWidth * devicePixelRatio),
      height: Math.round(document.documentElement.clientHeight * devicePixelRatio),
    }),
  };

  browser.runtime.onMessage.addListener((m) => {
    if (!m || !ops[m.op]) return;
    try { return Promise.resolve({ ok: true, ...ops[m.op](m) }); }
    catch (e) { return Promise.resolve({ ok: false, error: e.code ? e : { code: 'protocol_error', message: String(e.message || e) } }); }
  });
})();
