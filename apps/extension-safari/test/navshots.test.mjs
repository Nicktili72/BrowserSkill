// reload / navigate_back / navigate_forward / window_resize, and the
// screenshot variants (element crop, full page + read/release). Browser APIs
// and the canvas work are faked (`env.imaging`); real-Safari behaviour is
// checked live — see NOTES.md.
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
const PNG = 'data:image/png;base64,';

function setup({ tab = {}, native = true, sendMessage, imaging, windows = {}, stuck = false } = {}) {
  const t = { id: 7, windowId: 1, index: 0, status: 'complete', url: 'https://site.test/a', ...tab };
  const calls = [];
  // A navigation "starts" (status loading) and finishes after two polls.
  const begin = (url) => { if (url) t.url = url; t.status = 'loading'; t.polls = 0; };
  const tabs = {
    get: async (id) => { if (id !== 7) throw new Error('gone'); if (!stuck && t.status === 'loading' && ++t.polls >= 2) t.status = 'complete'; return { ...t }; },
    update: async (_id, o) => Object.assign(t, o), query: async () => [t],
    reload: async (id, o) => { calls.push(['reload', id, o]); begin(); },
    sendMessage: sendMessage || (async (_id, msg) => { calls.push(['msg', msg]); if (msg.op === 'history') begin(msg.delta < 0 ? 'https://site.test/prev' : 'https://site.test/next'); return { ok: true }; }),
    captureVisibleTab: async () => `${PNG}FRAME`,
  };
  if (native) {
    tabs.goBack = async (id) => { calls.push(['goBack', id]); begin('https://site.test/prev'); };
    tabs.goForward = async (id) => { calls.push(['goForward', id]); begin('https://site.test/next'); };
  }
  let n = 0;
  const browser = {
    storage: { local: { get: async () => ({}), set: async () => {} } },
    runtime: { getManifest: () => ({ version: '0' }), getURL: (p) => p, onMessage: { addListener() {} } },
    windows: { create: async () => ({ id: 200, tabs: [] }), update: async (id, o) => calls.push(['windows.update', id, o]), remove: async () => {}, get: async (id) => ({ id, width: 1280, height: 800, ...windows }) },
    tabs,
  };
  const bg = makeBackground({
    browser, WebSocket: class {}, console, crypto: { randomUUID: () => `uuid-${++n}` }, navigator: {}, imaging,
    setTimeout: (f) => setImmediate(f), clearTimeout, setInterval, clearInterval, // sleeps are instant
  });
  return { bg, t, calls };
}

// ---------- reload / back / forward ----------
test('reload waits for the reload to finish and reports previous/final URL; hard bypasses the cache', async () => {
  const { bg, calls } = setup();
  const r = await bg.dispatch('tool.reload', { session_id: 's', tab_id: 7, hard: true });
  assert.deepEqual(plain(r), { tab_id: 7, previous_url: 'https://site.test/a', final_url: 'https://site.test/a', reached: 'load', dialogs: [] });
  assert.deepEqual(calls[0], ['reload', 7, { bypassCache: true }]);
  assert.deepEqual((await bg.dispatch('tool.reload', { session_id: 's', tab_id: 7 })).reached, 'load');
  assert.deepEqual(calls[1], ['reload', 7, { bypassCache: false }]);
});

test('reload that never finishes reports reached: "timeout" instead of hanging', async () => {
  const { bg } = setup({ stuck: true });
  const r = await bg.dispatch('tool.reload', { session_id: 's', tab_id: 7, timeout_ms: 20 });
  assert.equal(r.reached, 'timeout');
});

test('navigate_back/forward use the native tabs API when Safari has it, and the content script otherwise', async () => {
  for (const native of [true, false]) {
    const { bg, calls } = setup({ native });
    const back = await bg.dispatch('tool.navigate_back', { session_id: 's', tab_id: 7 });
    assert.deepEqual(plain([back.previous_url, back.final_url, back.reached]), ['https://site.test/a', 'https://site.test/prev', 'load']);
    assert.ok(native ? calls.some((c) => c[0] === 'goBack') : calls.some((c) => c[0] === 'msg' && c[1].op === 'history' && c[1].delta === -1));
    const fwd = await bg.dispatch('tool.navigate_forward', { session_id: 's', tab_id: 7 });
    assert.equal(fwd.final_url, 'https://site.test/next');
    assert.ok(native ? calls.some((c) => c[0] === 'goForward') : calls.some((c) => c[0] === 'msg' && c[1].delta === 1));
  }
});

test('navigate_back with no history entry is a clear not_found, not a silent success', async () => {
  const { bg } = setup({ native: false, sendMessage: async () => ({ ok: true }) }); // history.go did nothing
  await assert.rejects(() => bg.dispatch('tool.navigate_back', { session_id: 's', tab_id: 7 }), (e) => e.code === 'not_found' && /no history entry/.test(e.message));
});

// ---------- window_resize ----------
test('window_resize resizes the session window and reports the resulting size', async () => {
  const { bg, calls } = setup({ windows: { width: 1000, height: 700 } });
  await bg.dispatch('tool.session_start', { session_id: 's' });
  const r = await bg.dispatch('tool.window_resize', { session_id: 's', width: 1000, height: 700 });
  assert.deepEqual(plain(r), { window_id: 200, width: 1000, height: 700 });
  assert.deepEqual(calls.find((c) => c[0] === 'windows.update'), ['windows.update', 200, { width: 1000, height: 700 }]);
  await assert.rejects(() => bg.dispatch('tool.window_resize', { session_id: 'nope', width: 500, height: 500 }), (e) => e.code === 'not_found');
});

// ---------- screenshot: element crop ----------
test('screenshot with a ref scrolls to the element and crops at device-pixel scale; without one it is the viewport', async () => {
  const cropped = [];
  const imaging = { crop: async (dataUrl, r) => { cropped.push([dataUrl, r]); return { base64: 'CROPPED', width: 60, height: 80 }; } };
  const { bg } = setup({
    imaging,
    sendMessage: async (_id, msg) => (msg.op === 'rect' ? { ok: true, x: 10, y: 20, width: 30, height: 40, dpr: 2 } : { ok: true, width: 1000, height: 700 }),
  });
  const el = await bg.dispatch('tool.screenshot', { session_id: 's', tab_id: 7, ref: '@e3' });
  assert.deepEqual(plain([el.image_base64, el.width, el.height, el.format]), ['CROPPED', 60, 80, 'png']);
  assert.deepEqual(plain(cropped[0]), [`${PNG}FRAME`, { x: 20, y: 40, width: 60, height: 80 }]);
  const full = await bg.dispatch('tool.screenshot', { session_id: 's', tab_id: 7 });
  assert.deepEqual(plain([full.image_base64, full.width, full.height]), ['FRAME', 1000, 700]);
  assert.equal(cropped.length, 1);
});

// ---------- screenshot: full page ----------
function pageSender({ height, vh = 800, vw = 1000, dpr = 2, startY = 300, noScroll = false }) {
  const log = [];
  const send = async (_id, msg) => {
    log.push(msg);
    if (msg.op === 'scrollMetrics') return { ok: true, height, vh, vw, dpr, y: startY };
    if (msg.op === 'scrollToY') return { ok: true, y: noScroll ? 0 : Math.min(msg.y, height - vh), height };
    return { ok: true };
  };
  return { send, log };
}

test('full-page screenshot scrolls frame by frame, stitches at device scale, restores the scroll position, and is readable in chunks', async () => {
  const stitched = [];
  const bytes = Uint8Array.from({ length: 500000 }, (_, i) => i % 251);
  const imaging = { stitch: async (frames, w, h, scale) => { stitched.push([frames.map((f) => f.y), w, h, scale]); return { bytes, width: w, height: h }; } };
  const { send, log } = pageSender({ height: 2000 });
  const { bg } = setup({ imaging, sendMessage: send });
  const r = await bg.dispatch('tool.screenshot_full_page', { session_id: 's', tab_id: 7 });
  assert.deepEqual(plain([r.scope, r.width, r.height, r.format, r.byte_size, r.tab_id]), ['follow', 2000, 4000, 'png', 500000, 7]);
  assert.match(r.capture_id, /^cap_/);
  assert.deepEqual(plain(stitched[0].slice(0, 3)), [[0, 1600, 2400], 2000, 4000]); // frames at 0, 800, clamped 1200 (device px)
  assert.deepEqual(log.filter((m) => m.op === 'scrollToY').map((m) => m.y), [0, 800, 1600, 300]); // last one restores startY

  // read it back in <= 192 KiB chunks and reassemble
  const parts = [];
  let offset = 0, guard = 0;
  for (;;) {
    const c = await bg.dispatch('tool.screenshot_read', { session_id: 's', capture_id: r.capture_id, offset });
    parts.push(Buffer.from(c.data_base64, 'base64'));
    offset = c.next_offset;
    if (c.eof || ++guard > 10) break;
  }
  assert.deepEqual(parts.map((p) => p.length), [196608, 196608, 106784]);
  assert.ok(Buffer.concat(parts).equals(Buffer.from(bytes)));

  // other sessions can't read or release it; the owner can, once
  await assert.rejects(() => bg.dispatch('tool.screenshot_read', { session_id: 'other', capture_id: r.capture_id, offset: 0 }), (e) => e.code === 'not_found');
  assert.equal((await bg.dispatch('tool.screenshot_release', { session_id: 'other', capture_id: r.capture_id })).released, false);
  assert.equal((await bg.dispatch('tool.screenshot_release', { session_id: 's', capture_id: r.capture_id })).released, true);
  assert.equal((await bg.dispatch('tool.screenshot_release', { session_id: 's', capture_id: r.capture_id })).released, false);
  await assert.rejects(() => bg.dispatch('tool.screenshot_read', { session_id: 's', capture_id: r.capture_id, offset: 0 }), (e) => e.code === 'not_found');
});

test('a very tall page is scaled down to fit (never cut off); one that cannot scroll yields a single frame', async () => {
  const stitched = [];
  const imaging = { stitch: async (frames, w, h, scale) => { stitched.push([frames.length, w, h, scale, frames.at(-1).y]); return { bytes: new Uint8Array(10), width: w, height: h }; } };
  const tall = setup({ imaging, sendMessage: pageSender({ height: 20000 }).send });
  const r = await tall.bg.dispatch('tool.screenshot_full_page', { session_id: 's', tab_id: 7 });
  const [frames, w, h, scale, lastY] = stitched[0];
  assert.equal(scale, 0.8); // 20000 css px * dpr 2 = 40000 device px -> fit 32000
  assert.deepEqual([w, h, r.width, r.height], [1600, 32000, 1600, 32000]);
  assert.equal(frames, Math.ceil(20000 / 800)); // every viewport of the page was captured
  assert.equal(lastY, (20000 - 800) * 2); // the final frame reaches the bottom (device px, unscaled)

  const flat = setup({ imaging, sendMessage: pageSender({ height: 5000, noScroll: true }).send });
  await flat.bg.dispatch('tool.screenshot_full_page', { session_id: 's', tab_id: 7 });
  assert.equal(stitched[1][0], 1); // scrollToY made no progress -> don't loop forever
  assert.equal(stitched[1][3], 1); // 5000 css px fits, no scaling
});

test('stopping a session frees its full-page captures', async () => {
  const imaging = { stitch: async (_f, w, h) => ({ bytes: new Uint8Array(10), width: w, height: h }) };
  const { bg } = setup({ imaging, sendMessage: pageSender({ height: 800 }).send });
  await bg.dispatch('tool.session_start', { session_id: 's' });
  const r = await bg.dispatch('tool.screenshot_full_page', { session_id: 's', tab_id: 7, scope: 'current' });
  assert.equal(r.scope, 'current');
  await bg.dispatch('tool.session_stop', { session_id: 's' });
  await assert.rejects(() => bg.dispatch('tool.screenshot_read', { session_id: 's', capture_id: r.capture_id, offset: 0 }), (e) => e.code === 'not_found');
});

// ---------- page side ----------
function loadContent(build = () => ({})) {
  const elements = {};
  const log = [];
  let handler;
  const doc = { documentElement: { scrollHeight: 5000 }, body: { scrollHeight: 6200 }, querySelector: (s) => elements[s] || null, querySelectorAll: () => [] };
  const sb = {
    document: doc, browser: { runtime: { onMessage: { addListener: (f) => { handler = f; } } } },
    getComputedStyle: () => ({}), innerWidth: 1000, innerHeight: 800, devicePixelRatio: 2, scrollY: 40,
    scrollTo: (o) => { log.push(['scrollTo', o]); sb.scrollY = Math.min(o.top, 5400); },
    history: { go: (d) => log.push(['history.go', d]) },
  };
  sb.window = sb;
  vm.runInNewContext(contentSrc, sb);
  Object.assign(elements, build());
  return { call: async (m) => handler(m), log };
}

test('page ops: rect scrolls the element into view and returns geometry+dpr; metrics/scroll/history behave', async () => {
  const seen = [];
  const h = loadContent(() => ({ '#e': { isConnected: true, scrollIntoView: (o) => seen.push(o), getBoundingClientRect: () => ({ x: 5, y: 6, width: 7, height: 8 }) } }));
  const r = await h.call({ op: 'rect', selector: '#e' });
  assert.deepEqual(plain([r.ok, r.x, r.y, r.width, r.height, r.dpr]), [true, 5, 6, 7, 8, 2]);
  assert.deepEqual(plain(seen[0]), { block: 'center', inline: 'center', behavior: 'instant' });
  assert.deepEqual(plain(await h.call({ op: 'scrollMetrics' })), { ok: true, height: 6200, vh: 800, vw: 1000, dpr: 2, y: 40 });
  assert.deepEqual(plain(await h.call({ op: 'scrollToY', y: 900 })), { ok: true, y: 900, height: 6200 });
  assert.deepEqual(plain(h.log.at(-1)), ['scrollTo', { top: 900, behavior: 'instant' }]);
  await h.call({ op: 'history', delta: -1 });
  assert.deepEqual(plain(h.log.at(-1)), ['history.go', -1]);
});
