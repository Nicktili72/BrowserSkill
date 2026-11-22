// get_html / select / focus / blur / wheel / observe / wait_for_navigation.
// Page-side logic runs content.js in a vm with a tiny fake DOM (no jsdom
// dependency); background routing runs against the same mocked `browser`
// shape as background.test.mjs. Real-Safari behaviour is checked live — see
// NOTES.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { makeBackground } = require('../background.js');
const contentSrc = readFileSync(fileURLToPath(new URL('../content.js', import.meta.url)), 'utf8');

const plain = (x) => JSON.parse(JSON.stringify(x));

// ---------- page side ----------
// build(el) -> { '<selector>': element }; `el` makes fake elements bound to
// THIS page's document/event log.
function loadContent(build = () => ({})) {
  const events = [];
  const scrolls = [];
  const elements = {};
  let handler;
  const doc = {
    documentElement: { outerHTML: '<html><body>héllo</body></html>' },
    body: {}, activeElement: null,
    querySelector: (s) => elements[s] || null,
    querySelectorAll: () => [],
    elementFromPoint: () => elements['#target'] || doc.body,
  };
  class Ev { constructor(type, init = {}) { this.type = type; Object.assign(this, init); } }
  const sb = {
    document: doc, browser: { runtime: { onMessage: { addListener: (f) => { handler = f; } } } },
    getComputedStyle: (n) => n.style || { overflowX: 'visible', overflowY: 'visible' },
    innerWidth: 1000, innerHeight: 800, devicePixelRatio: 1,
    scrollBy: (o) => scrolls.push(['window', o]),
    Event: Ev, WheelEvent: Ev, KeyboardEvent: Ev,
    TextEncoder, TextDecoder, HTMLTextAreaElement: class {}, HTMLSelectElement: class {}, HTMLInputElement: class {},
  };
  sb.window = sb;
  vm.runInNewContext(contentSrc, sb);
  const el = (props = {}) => {
    const e = {
      isConnected: true, parentElement: null,
      scrollIntoView() {}, getBoundingClientRect: () => ({ x: 10, y: 20, width: 100, height: 40 }),
      dispatchEvent(ev) { events.push(ev); return !this.cancel; },
      focus() { doc.activeElement = this; }, blur() { if (doc.activeElement === this) doc.activeElement = null; },
      scrollBy(o) { scrolls.push(['el', o]); },
    };
    return Object.defineProperties(e, Object.getOwnPropertyDescriptors(props)); // keeps getters live
  };
  Object.assign(elements, build(el));
  return { call: async (m) => handler(m), events, scrolls };
}

test('get_html returns the document by default and truncates on a UTF-8 byte budget', async () => {
  const h = loadContent();
  const full = await h.call({ op: 'getHtml' });
  assert.equal(full.ok, true);
  assert.equal(full.html, '<html><body>héllo</body></html>');
  assert.equal(full.truncated, false);
  assert.equal(full.byteSize, 32); // é is 2 bytes
  const cut = await h.call({ op: 'getHtml', maxBytes: 10 });
  assert.equal(cut.truncated, true);
  assert.equal(cut.byteSize, 32);
  assert.ok(cut.html.length <= 10);
});

test('select sets the value, fires input+change, and rejects unknown values / non-selects', async () => {
  const h = loadContent((el) => {
    const opts = [{ value: 'a', label: 'Alpha', selected: true }, { value: 'b', label: 'Beta', selected: false }];
    return {
      '#s': el({ tagName: 'SELECT', multiple: false, options: opts, get selectedOptions() { return opts.filter((o) => o.selected); } }),
      '#d': el({ tagName: 'DIV' }),
    };
  });
  const ok = await h.call({ op: 'select', selector: '#s', values: ['b'] });
  assert.deepEqual(plain([ok.ok, ok.selectedValues, ok.selectedLabels, ok.multiple]), [true, ['b'], ['Beta'], false]);
  assert.deepEqual(plain(h.events.map((e) => e.type)), ['input', 'change']);
  assert.equal((await h.call({ op: 'select', selector: '#s', values: ['zzz'] })).error.code, 'not_found');
  assert.equal((await h.call({ op: 'select', selector: '#s', values: ['a', 'b'] })).error.code, 'invalid_params');
  assert.equal((await h.call({ op: 'select', selector: '#d', values: ['a'] })).error.code, 'invalid_params');
});

test('focus reports whether the element really holds focus; blur reports the before/after', async () => {
  const h = loadContent((el) => ({ '#i': el() }));
  assert.equal((await h.call({ op: 'focus', selector: '#i' })).focused, true);
  const b = await h.call({ op: 'blur', selector: '#i' });
  assert.deepEqual([b.wasFocused, b.focused], [true, false]);
  assert.equal((await h.call({ op: 'blur', selector: '#i' })).wasFocused, false);
});

test('wheel dispatches the event, then scrolls the nearest scrollable ancestor — or does nothing if the page cancelled it', async () => {
  const h = loadContent((el) => {
    const parent = el({ style: { overflowY: 'auto', overflowX: 'visible' }, scrollHeight: 900, clientHeight: 300, scrollWidth: 100, clientWidth: 100 });
    return { '#target': el({ parentElement: parent }) };
  });
  const r = await h.call({ op: 'wheel', deltaY: 120 });
  assert.deepEqual([r.ok, r.x, r.y, r.deltaY], [true, 500, 400, 120]);
  assert.equal(h.events[0].type, 'wheel');
  assert.deepEqual(plain(h.scrolls), [['el', { left: 0, top: 120, behavior: 'instant' }]]);

  const cancelled = loadContent((el) => ({ '#target': el({ cancel: true }) }));
  await cancelled.call({ op: 'wheel', deltaY: 50 });
  assert.deepEqual(plain(cancelled.scrolls), []); // a handler cancelled it -> we don't scroll
});

test('wheel with no scrollable ancestor falls back to scrolling the window', async () => {
  const h = loadContent((el) => ({ '#target': el() }));
  await h.call({ op: 'wheel', deltaX: 5, deltaY: 7 });
  assert.deepEqual(plain(h.scrolls), [['window', { left: 5, top: 7, behavior: 'instant' }]]);
});

// ---------- background routing ----------
function bgWith(sendMessage, tabStatus = 'complete') {
  const tabs = new Map([[7, { id: 7, windowId: 1, index: 0, status: tabStatus }]]);
  const browser = {
    storage: { local: { get: async () => ({}), set: async () => {} } },
    runtime: { getManifest: () => ({ version: '0' }), getURL: (p) => p, onMessage: { addListener() {} } },
    windows: { create: async () => ({ id: 1, tabs: [] }), update: async () => {}, remove: async () => {} },
    tabs: {
      get: async (id) => { const t = tabs.get(id); if (!t) throw new Error('gone'); return t; },
      update: async (id, o) => Object.assign(tabs.get(id), o), query: async () => [],
      sendMessage, captureVisibleTab: async () => '',
    },
  };
  const bg = makeBackground({ browser, WebSocket: class {}, console, crypto: {}, navigator: {}, setTimeout, clearTimeout, setInterval, clearInterval });
  return { bg, tabs };
}

test('each new tool maps wire params to the page op and the result back to wire names (dialogs always present)', async () => {
  const seen = [];
  const { bg } = bgWith(async (_t, msg) => {
    seen.push(msg);
    return { ok: true, html: '<p>', truncated: false, byteSize: 3, usedRef: '@e1', multiple: false, selectedValues: ['b'], selectedLabels: ['B'], focused: true, wasFocused: false, x: 1, y: 2, deltaX: 3, deltaY: 4, text: 'T', refCount: 2 };
  });
  const base = { session_id: 's', tab_id: 7 };
  assert.deepEqual(await bg.dispatch('tool.get_html', { ...base, ref: '@e1', max_bytes: 9 }), { html: '<p>', truncated: false, byte_size: 3, tab_id: 7, dialogs: [] });
  assert.deepEqual(await bg.dispatch('tool.select', { ...base, ref: '@e1', values: ['b'] }), { tab_id: 7, used_ref: '@e1', used_selector: undefined, multiple: false, selected_values: ['b'], selected_labels: ['B'], dialogs: [] });
  assert.equal((await bg.dispatch('tool.focus', { ...base, ref: '@e1' })).focused, true);
  assert.deepEqual((await bg.dispatch('tool.blur', { ...base, ref: '@e1' })).was_focused, false);
  assert.deepEqual(await bg.dispatch('tool.wheel', { ...base, delta_y: 4, delta_x: 3 }), { tab_id: 7, used_ref: '@e1', used_selector: undefined, x: 1, y: 2, delta_x: 3, delta_y: 4, dialogs: [] });
  assert.deepEqual(await bg.dispatch('tool.observe', { ...base, max_tokens: 100 }), { text: 'T', ref_count: 2, tab_id: 7, truncated: false, dialogs: [] });
  assert.deepEqual(seen.map((m) => m.op), ['getHtml', 'select', 'focus', 'blur', 'wheel', 'snapshot']);
  assert.equal(seen[0].maxBytes, 9);
  assert.equal(seen[4].deltaY, 4);
  assert.equal(seen[5].maxChars, 400);
});

test('wait_for_navigation returns the requested phase when complete, commit immediately, and timeout otherwise', async () => {
  const done = bgWith(async () => ({ ok: true }), 'complete').bg;
  assert.equal((await done.dispatch('tool.wait_for_navigation', { session_id: 's', tab_id: 7 })).reached, 'load');
  assert.equal((await done.dispatch('tool.wait_for_navigation', { session_id: 's', tab_id: 7, wait_until: 'domcontentloaded' })).reached, 'domcontentloaded');
  const loading = bgWith(async () => ({ ok: true }), 'loading').bg;
  assert.equal((await loading.dispatch('tool.wait_for_navigation', { session_id: 's', tab_id: 7, wait_until: 'commit' })).reached, 'commit');
  assert.equal((await loading.dispatch('tool.wait_for_navigation', { session_id: 's', tab_id: 7, timeout_ms: 1 })).reached, 'timeout');
  await assert.rejects(() => loading.dispatch('tool.wait_for_navigation', { session_id: 's', tab_id: 99 }), (e) => e.code === 'not_found');
});
