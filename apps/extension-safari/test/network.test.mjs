// network: fetch/XHR wrapping, Resource Timing, element load failures, and the
// since/limit/max_text_chars paging. Fakes stand in for the page's fetch, XHR
// and PerformanceObserver; real-Safari behaviour is checked live (NOTES.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { loadWorlds, plain } from './worlds.helper.mjs';

const require = createRequire(import.meta.url);
const { makeBackground } = require('../background.js');

function setup({ fetchImpl, nav = [] } = {}) {
  const observers = [];
  class FakeXHR {
    constructor() { this.listeners = {}; this.status = 0; this.statusText = ''; }
    open(method, url) { this.openedWith = [method, url]; }
    addEventListener(t, f) { (this.listeners[t] ||= []).push(f); }
    getResponseHeader(h) { return h.toLowerCase() === 'content-type' ? this.contentType : null; }
    send() { this.sent = true; }
    finish(type, init = {}) { Object.assign(this, init); (this.listeners[type] || []).forEach((f) => f()); }
  }
  const origSend = FakeXHR.prototype.send;
  const w = loadWorlds({
    mainGlobals: {
      location: { href: 'https://site.test/app/page' }, URL,
      document: { contentType: 'text/html; charset=utf-8' },
      performance: { timeOrigin: 1000, getEntriesByType: () => nav },
      fetch: fetchImpl || (async () => ({ status: 200, statusText: 'OK', headers: { get: () => 'application/json; charset=utf-8' } })),
      XMLHttpRequest: FakeXHR,
      setTimeout, clearTimeout,
      PerformanceObserver: class { constructor(cb) { this.cb = cb; observers.push(this); } observe() {} },
    },
  });
  const net = async (m = {}) => plain(await w.call({ op: 'network', ...m }));
  return { w, net, observers, FakeXHR, origSend };
}

const settle = () => new Promise((r) => setImmediate(r));

test('fetch: records a response (absolute URL, method, status, bare MIME type) and returns the page its own promise result', async () => {
  const response = { status: 404, statusText: 'Not Found', headers: { get: () => 'application/json; charset=utf-8' } };
  const { w, net } = setup({ fetchImpl: async () => response });
  const got = await w.main.fetch('/api/items?id=1', { method: 'post' });
  assert.equal(got, response); // untouched
  await settle();
  const [e] = (await net()).entries;
  assert.deepEqual([e.kind, e.method, e.url, e.status, e.status_text, e.mime_type, e.resource_type],
    ['response', 'POST', 'https://site.test/api/items?id=1', 404, 'Not Found', 'application/json', 'Fetch']);
});

test('fetch: a rejection becomes a failure entry and still rejects for the page; Request-like input is understood', async () => {
  const { w, net } = setup({ fetchImpl: async () => { throw new TypeError('Load failed'); } });
  await assert.rejects(() => w.main.fetch({ url: 'https://other.test/x', method: 'PUT' }), /Load failed/);
  await settle();
  const [e] = (await net()).entries;
  assert.deepEqual([e.kind, e.method, e.url, e.error_text, e.resource_type], ['failure', 'PUT', 'https://other.test/x', 'Load failed', 'Fetch']);
  assert.equal(e.status, undefined);
});

test('XHR: load, error, abort and timeout each produce the right entry', async () => {
  const { w, net, FakeXHR } = setup();
  const run = (type, init) => { const x = new FakeXHR(); x.open('get', '/a.json'); x.send(); x.finish(type, init); };
  run('load', { status: 200, statusText: 'OK', contentType: 'text/plain;charset=utf-8' });
  run('error'); run('abort'); run('timeout');
  const e = (await net()).entries;
  assert.deepEqual(e.map((x) => [x.kind, x.error_text ?? x.status]), [['response', 200], ['failure', 'network error'], ['failure', 'aborted'], ['failure', 'timeout']]);
  assert.deepEqual([e[0].method, e[0].url, e[0].mime_type, e[0].resource_type], ['GET', 'https://site.test/a.json', 'text/plain', 'XHR']);
});

test('Resource Timing: subresources are recorded, fetch/XHR duplicates are skipped, status only when the browser exposes it', async () => {
  const { net, observers } = setup();
  observers[0].cb({ getEntries: () => [
    { name: 'https://cdn.test/a.png', initiatorType: 'img', responseStatus: 200, responseEnd: 50 },
    { name: 'https://cdn.test/app.js', initiatorType: 'script', responseStatus: 0, responseEnd: 80 }, // cross-origin: no status
    { name: 'https://cdn.test/site.css', initiatorType: 'link', responseEnd: 90 },
    { name: 'https://site.test/api', initiatorType: 'fetch', responseStatus: 200 },
    { name: 'https://site.test/old', initiatorType: 'xmlhttprequest', responseStatus: 200 },
    { name: 'https://x.test/weird', initiatorType: 'other' },
  ] });
  const e = (await net()).entries;
  assert.deepEqual(e.map((x) => [x.url.split('/').pop(), x.status, x.resource_type]),
    [['a.png', 200, 'Image'], ['app.js', undefined, 'Script'], ['site.css', undefined, 'Stylesheet'], ['weird', undefined, 'Other']]);
  assert.equal(e[0].timestamp, 1050); // timeOrigin + responseEnd
});

test('the document itself is recorded once DOMContentLoaded fires', async () => {
  const { w, net } = setup({ nav: [{ responseStatus: 200 }] });
  w.bus.emit({ type: 'DOMContentLoaded' });
  const [e] = (await net()).entries;
  assert.deepEqual([e.url, e.status, e.mime_type, e.resource_type], ['https://site.test/app/page', 200, 'text/html', 'Document']);
});

test('a failed <img>/<script>/<link> load is a network failure with the right resource type', async () => {
  const { w, net } = setup();
  w.bus.emit({ type: 'error', target: { tagName: 'IMG', src: '/missing.png' } });
  w.bus.emit({ type: 'error', target: { tagName: 'LINK', href: 'https://cdn.test/x.css' } });
  const e = (await net()).entries;
  assert.deepEqual(e.map((x) => [x.kind, x.url, x.resource_type, x.error_text]),
    [['failure', 'https://site.test/missing.png', 'Image', 'failed to load'], ['failure', 'https://cdn.test/x.css', 'Stylesheet', 'failed to load']]);
});

test('a failed load is one failure, whether the error event comes before or after its Resource Timing entry', async () => {
  const timing = (name) => ({ name, initiatorType: 'img', responseStatus: 0, responseEnd: 10 });
  const a = setup(); // timing first (what Safari does), then the error event
  a.observers[0].cb({ getEntries: () => [timing('https://cdn.test/a.png')] });
  a.w.bus.emit({ type: 'error', target: { tagName: 'IMG', src: 'https://cdn.test/a.png' } });
  assert.deepEqual((await a.net()).entries.map((x) => [x.kind, x.url]), [['failure', 'https://cdn.test/a.png']]);

  const b = setup(); // error first, then timing
  b.w.bus.emit({ type: 'error', target: { tagName: 'IMG', src: 'https://cdn.test/b.png' } });
  b.observers[0].cb({ getEntries: () => [timing('https://cdn.test/b.png'), timing('https://cdn.test/ok.png')] });
  assert.deepEqual((await b.net()).entries.map((x) => [x.kind, x.url]), [['failure', 'https://cdn.test/b.png'], ['response', 'https://cdn.test/ok.png']]);
});

test('a timing entry with no matching failure is committed on its own after the grace period', async () => {
  const s = setup();
  s.observers[0].cb({ getEntries: () => [{ name: 'https://cdn.test/slow.js', initiatorType: 'script', responseStatus: 200, responseEnd: 5 }] });
  await new Promise((r) => setTimeout(r, 320));
  assert.deepEqual((await s.net()).entries.map((x) => [x.kind, x.status]), [['response', 200]]);
});

test('network honours since / limit / max_text_chars and keeps at most 1000 entries', async () => {
  const { w, net, FakeXHR } = setup();
  const xhr = (url) => { const x = new FakeXHR(); x.open('get', url); x.send(); x.finish('load', { status: 200 }); };
  for (let i = 1; i <= 5; i++) xhr(`/r${i}`);
  xhr('/' + 'x'.repeat(40));

  const p1 = await net({ limit: 2 });
  assert.deepEqual([p1.entries.map((x) => x.url.split('/').pop()), p1.nextSince, p1.truncated], [['r1', 'r2'], 2, true]);
  const p2 = await net({ since: p1.nextSince, limit: 10 });
  assert.deepEqual([p2.entries.length, p2.nextSince, p2.truncated], [4, 6, false]);
  assert.deepEqual([(await net({ since: 6 })).entries.length, (await net({ since: 6 })).nextSince], [0, 6]);
  const cut = (await net({ since: 5, maxTextChars: 30 })).entries[0];
  assert.deepEqual([cut.url.length, cut.truncated], [30, true]);

  for (let i = 0; i < 1100; i++) xhr('/bulk');
  const r = await net({ limit: 500 });
  assert.equal(r.entries[0].sequence, 107); // 1106 recorded, oldest 106 dropped
});

test('network without the page-world script is a clean unsupported error', async () => {
  const w = loadWorlds({ withMain: false });
  const r = await w.call({ op: 'network', ackMs: 20 });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'unsupported');
});

test('background maps tool.network to the page op and back to wire names', async () => {
  const seen = [];
  const tabs = new Map([[7, { id: 7, windowId: 1, index: 0, status: 'complete' }]]);
  const browser = {
    storage: { local: { get: async () => ({}), set: async () => {} } },
    runtime: { getManifest: () => ({ version: '0' }), getURL: (p) => p, onMessage: { addListener() {} } },
    windows: { create: async () => ({ id: 1, tabs: [] }), update: async () => {}, remove: async () => {} },
    tabs: {
      get: async (id) => tabs.get(id), update: async (id, o) => Object.assign(tabs.get(id), o), query: async () => [], captureVisibleTab: async () => '',
      sendMessage: async (_t, msg) => { seen.push(msg); return { ok: true, entries: [{ sequence: 1, kind: 'response', url: 'https://x/', truncated: false }], nextSince: 1, truncated: false }; },
    },
  };
  const bg = makeBackground({ browser, WebSocket: class {}, console, crypto: {}, navigator: {}, setTimeout, clearTimeout, setInterval, clearInterval });
  const r = await bg.dispatch('tool.network', { session_id: 's', tab_id: 7, since: 3, limit: 5, max_text_chars: 99 });
  assert.deepEqual(r, { tab_id: 7, entries: [{ sequence: 1, kind: 'response', url: 'https://x/', truncated: false }], next_since: 1, truncated: false });
  assert.deepEqual(seen[0], { op: 'network', since: 3, limit: 5, maxTextChars: 99 });
});
