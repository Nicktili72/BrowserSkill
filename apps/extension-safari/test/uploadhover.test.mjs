// upload + hover. Page logic runs content.js in a vm with a tiny fake DOM;
// real-Safari behaviour (does `input.files = dt.files` stick, does a drop
// event carry the files) is checked live — see NOTES.md.
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
const b64 = (bytes) => Buffer.from(bytes).toString('base64');

// build(el) -> { '<selector>': element }. `pointAt` is what elementFromPoint returns.
function loadContent(build = () => ({}), pointAt = () => null) {
  const events = [];
  const elements = {};
  let handler;
  const doc = { body: {}, querySelector: (s) => elements[s] || null, querySelectorAll: () => [], elementFromPoint: () => pointAt() };
  class Ev { constructor(type, init = {}) { this.type = type; Object.assign(this, init); } }
  class FakeFile { constructor(parts, name, opts = {}) { this.name = name; this.type = opts.type || ''; this.bytes = Buffer.concat(parts.map((p) => Buffer.from(p))); this.size = this.bytes.length; } }
  class FakeDT { constructor() { const files = []; this.files = files; this.items = { add: (f) => files.push(f) }; } }
  const sb = {
    document: doc, browser: { runtime: { onMessage: { addListener: (f) => { handler = f; } } } },
    getComputedStyle: () => ({}), innerWidth: 1000, innerHeight: 800, devicePixelRatio: 1,
    Event: Ev, MouseEvent: Ev, PointerEvent: Ev, DragEvent: Ev, File: FakeFile, DataTransfer: FakeDT,
    atob: (s) => Buffer.from(s, 'base64').toString('binary'), Uint8Array, setTimeout, TextEncoder, TextDecoder,
  };
  sb.window = sb;
  vm.runInNewContext(contentSrc, sb);
  const el = (props = {}) => Object.defineProperties({
    isConnected: true, parentElement: null, scrollIntoView() {},
    getBoundingClientRect: () => ({ x: 100, y: 200, width: 40, height: 20 }),
    dispatchEvent(ev) { events.push([ev.type, this.id, ev.bubbles, ev.relatedTarget ? ev.relatedTarget.id : null, ev.pointerType]); return true; },
  }, Object.getOwnPropertyDescriptors(props));
  Object.assign(elements, build(el));
  return { call: async (m) => handler(m), events };
}
const trace = (events) => plain(events.map((e) => `${e[0]}@${e[1]}`));

// ---------- upload ----------
test('upload puts File objects with the exact bytes, name and guessed MIME type on the input, then fires input+change', async () => {
  let input;
  const h = loadContent((el) => ({ '#f': (input = el({ id: 'f', tagName: 'INPUT', type: 'file', multiple: true, files: null })) }));
  const binary = Uint8Array.from([0xff, 0x00, 0x10, 0x80]); // not valid UTF-8: must survive byte-for-byte
  const r = await h.call({ op: 'upload', selector: '#f', files: [{ name: 'photo.JPG', dataBase64: b64(binary) }, { name: 'x.unknown', dataBase64: b64('hi') }] });
  assert.deepEqual(plain([r.ok, r.fileNames]), [true, ['photo.JPG', 'x.unknown']]);
  assert.deepEqual(plain(input.files.map((f) => [f.name, f.type, f.size])), [['photo.JPG', 'image/jpeg', 4], ['x.unknown', '', 2]]);
  assert.deepEqual([...input.files[0].bytes], [0xff, 0x00, 0x10, 0x80]);
  assert.deepEqual(plain(h.events.map((e) => e[0])), ['input', 'change']);
});

test('upload rejects non-file inputs, several files on a single input, and an empty list', async () => {
  const h = loadContent((el) => ({
    '#d': el({ id: 'd', tagName: 'DIV' }),
    '#single': el({ id: 's', tagName: 'INPUT', type: 'file', multiple: false }),
  }));
  const f = (n) => ({ name: n, dataBase64: b64('x') });
  assert.equal((await h.call({ op: 'upload', selector: '#d', files: [f('a')] })).error.code, 'invalid_params');
  assert.match((await h.call({ op: 'upload', selector: '#single', files: [f('a'), f('b')] })).error.message, /multiple/);
  assert.equal((await h.call({ op: 'upload', selector: '#single', files: [] })).error.code, 'invalid_params');
});

test('upload in drop mode fires dragenter, dragover, drop on the element, carrying the files', async () => {
  const drops = [];
  const h = loadContent((el) => ({ '#z': el({ id: 'z', tagName: 'DIV', dispatchEvent(ev) { drops.push(ev); return true; } }) }));
  const r = await h.call({ op: 'upload', selector: '#z', mode: 'drop', files: [{ name: 'a.txt', dataBase64: b64('hi') }] });
  assert.equal(r.ok, true);
  assert.deepEqual(plain(drops.map((e) => e.type)), ['dragenter', 'dragover', 'drop']);
  assert.deepEqual(plain([drops[2].dataTransfer.files[0].name, drops[2].clientX, drops[2].clientY]), ['a.txt', 120, 210]);
});

// ---------- hover ----------
test('hover fires over/enter/move down the chain, then out/leave on the old target when the pointer moves elsewhere', async () => {
  let a, b, cur;
  const h = loadContent((el) => {
    const root = el({ id: 'root' });
    const menu = el({ id: 'menu', parentElement: root });
    a = el({ id: 'a', parentElement: menu });
    b = el({ id: 'b', parentElement: root });
    return { '#a': a, '#b': b };
  }, () => cur);
  cur = a;
  const r = await h.call({ op: 'hover', selector: '#a', settleMs: 0 });
  assert.deepEqual(plain([r.ok, r.x, r.y]), [true, 120, 210]);
  assert.deepEqual(trace(h.events), ['pointerover@a', 'mouseover@a', 'pointerenter@root', 'mouseenter@root', 'pointerenter@menu', 'mouseenter@menu', 'pointerenter@a', 'mouseenter@a', 'pointermove@a', 'mousemove@a']);

  h.events.length = 0;
  cur = b;
  await h.call({ op: 'hover', selector: '#b', settleMs: 0 });
  assert.deepEqual(trace(h.events), ['pointerout@a', 'mouseout@a', 'pointerleave@a', 'mouseleave@a', 'pointerleave@menu', 'mouseleave@menu', 'pointerover@b', 'mouseover@b', 'pointerenter@b', 'mouseenter@b', 'pointermove@b', 'mousemove@b']);
});

test('hover events carry relatedTarget (where the pointer came from / went to) and pointerType "mouse"', async () => {
  let a, b, cur;
  const h = loadContent((el) => ({ '#a': (a = el({ id: 'a' })), '#b': (b = el({ id: 'b' })) }), () => cur);
  cur = a; await h.call({ op: 'hover', selector: '#a', settleMs: 0 });
  h.events.length = 0;
  cur = b; await h.call({ op: 'hover', selector: '#b', settleMs: 0 });
  const rel = Object.fromEntries(h.events.map((e) => [e[0], e[3]]));
  assert.deepEqual(plain([rel.mouseout, rel.mouseleave, rel.mouseover, rel.mouseenter]), ['b', 'b', 'a', 'a']);
  assert.deepEqual(plain(h.events.filter((e) => e[0].startsWith('pointer')).map((e) => e[4])), Array(h.events.filter((e) => e[0].startsWith('pointer')).length).fill('mouse'));
});

test('hovering the same element again only moves; enter/leave do not bubble, over/out/move do', async () => {
  let a, cur;
  const h = loadContent((el) => ({ '#a': (a = el({ id: 'a' })) }), () => cur);
  cur = a;
  await h.call({ op: 'hover', selector: '#a', settleMs: 0 });
  const bubbles = Object.fromEntries(h.events.map((e) => [e[0], e[2]]));
  assert.deepEqual(plain([bubbles.mouseover, bubbles.mouseenter, bubbles.mousemove]), [true, false, true]);
  h.events.length = 0;
  await h.call({ op: 'hover', selector: '#a', settleMs: 0 });
  assert.deepEqual(plain(h.events.map((e) => e[0])), ['pointermove', 'mousemove']);
});

test('hover waits settle_ms before returning', async () => {
  let a, cur;
  const h = loadContent((el) => ({ '#a': (a = el({ id: 'a' })) }), () => cur);
  cur = a;
  const t0 = Date.now();
  await h.call({ op: 'hover', selector: '#a', settleMs: 80 });
  assert.ok(Date.now() - t0 >= 70);
});

// ---------- background ----------
function bgWith(sendMessage) {
  const tabs = new Map([[7, { id: 7, windowId: 1, index: 0, status: 'complete' }]]);
  const browser = {
    storage: { local: { get: async () => ({}), set: async () => {} } },
    runtime: { getManifest: () => ({ version: '0' }), getURL: (p) => p, onMessage: { addListener() {} } },
    windows: { create: async () => ({ id: 1, tabs: [] }), update: async () => {}, remove: async () => {} },
    tabs: { get: async (id) => tabs.get(id), update: async (id, o) => Object.assign(tabs.get(id), o), query: async () => [], captureVisibleTab: async () => '', sendMessage },
  };
  return makeBackground({ browser, WebSocket: class {}, console, crypto: {}, navigator: {}, setTimeout, clearTimeout, setInterval, clearInterval });
}

test('tool.upload maps inline bytes to the page op; a daemon that sent only a path gets a clear unsupported error', async () => {
  const seen = [];
  const bg = bgWith(async (_t, msg) => { seen.push(msg); return { ok: true, fileNames: ['a.png'], usedSelector: '#f' }; });
  const r = await bg.dispatch('tool.upload', { session_id: 's', tab_id: 7, selector: '#f', mode: 'input', files: [{ transfer_id: 't1', name: 'a.png', staged_path: '/tmp/x', data_base64: 'QUJD' }] });
  assert.deepEqual(r, { tab_id: 7, used_ref: undefined, used_selector: '#f', file_names: ['a.png'], dialogs: [] });
  assert.deepEqual(seen[0], { op: 'upload', ref: undefined, selector: '#f', mode: 'input', files: [{ name: 'a.png', dataBase64: 'QUJD' }] });
  await assert.rejects(
    () => bg.dispatch('tool.upload', { session_id: 's', tab_id: 7, selector: '#f', files: [{ transfer_id: 't1', name: 'a.png', staged_path: '/tmp/x' }] }),
    (e) => e.code === 'unsupported' && /Safari-aware bsk daemon/.test(e.message),
  );
  assert.equal(seen.length, 1); // the second call never reached the page
});

test('tool.hover maps wire params and result', async () => {
  const seen = [];
  const bg = bgWith(async (_t, msg) => { seen.push(msg); return { ok: true, usedRef: '@e1', x: 5, y: 6 }; });
  const r = await bg.dispatch('tool.hover', { session_id: 's', tab_id: 7, ref: '@e1', modifiers: ['Shift'], settle_ms: 20 });
  assert.deepEqual(r, { tab_id: 7, used_ref: '@e1', used_selector: undefined, x: 5, y: 6, dialogs: [] });
  assert.deepEqual(seen[0], { op: 'hover', ref: '@e1', selector: undefined, modifiers: ['Shift'], settleMs: 20 });
});
