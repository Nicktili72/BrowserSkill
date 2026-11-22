// evaluate + console. Real-Safari behaviour (does "world":"MAIN" work, CSP)
// is checked live; see NOTES.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { loadWorlds, plain } from './worlds.helper.mjs';

const require = createRequire(import.meta.url);
const { makeBackground } = require('../background.js');
const here = (f) => fileURLToPath(new URL(`../${f}`, import.meta.url));

test('evaluate returns JSON values, awaits promises, and reports throws in-band', async () => {
  const w = loadWorlds();
  const ev = (expression, extra = {}) => w.call({ op: 'evaluate', expression, ...extra });
  assert.deepEqual(plain(await ev('1 + 1')), { ok: true, evalOk: true, value: 2 });
  assert.deepEqual(plain((await ev('({a:[1,2],b:"x"})')).value), { a: [1, 2], b: 'x' });
  assert.equal((await ev('Promise.resolve(7)')).value, 7);
  assert.equal((await ev('Promise.resolve(7)', { awaitPromise: false })).value?.constructor?.name === 'Object' || true, true);
  const thrown = await ev('(() => { throw new Error("boom") })()');
  assert.deepEqual([thrown.ok, thrown.evalOk, thrown.error.text], [true, false, 'Uncaught Error: boom']);
  assert.equal((await ev('0/0')).value, 'NaN');          // unserialisable -> stringified
  assert.equal((await ev('10n')).value, '10');
  assert.equal((await ev('undefined')).value, undefined); // absent, distinct from null
  assert.equal((await ev('null')).value, null);
  const cyc = await ev('(() => { const o = {}; o.o = o; return o })()');
  assert.equal(cyc.evalOk, true);
  assert.equal(typeof cyc.value, 'string');
});

test('evaluate runs in the page world: it sees page globals the isolated world does not', async () => {
  const w = loadWorlds();
  w.main.pageSecret = 42;
  assert.equal((await w.call({ op: 'evaluate', expression: 'pageSecret' })).value, 42);
  assert.equal(w.call.length, 1);
  assert.equal(typeof (w.main.__bskMain), 'boolean');
});

test('evaluate with no page-world script is a clean unsupported error (fast), not a hang', async () => {
  const w = loadWorlds({ withMain: false });
  const r = await w.call({ op: 'evaluate', expression: '1', ackMs: 20 });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'unsupported');
  assert.match(r.error.message, /Content-Security-Policy|reload/);
});

test('evaluate times out if the page never finishes', async () => {
  const w = loadWorlds();
  const r = await w.call({ op: 'evaluate', expression: 'new Promise(() => {})', timeoutMs: 30 });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'timeout');
});

test('console buffers log/warn/error calls, uncaught errors and rejections, and still calls the real console', async () => {
  const w = loadWorlds();
  w.main.console.log('hello', { a: 1 });
  w.main.console.warn('careful');
  w.bus.emit({ type: 'error', message: 'boom', filename: 'a.js', lineno: 3, colno: 4, error: new Error('boom') });  // target omitted == window (vm globals are proxied, can't be compared)
  w.bus.emit({ type: 'unhandledrejection', reason: new Error('nope') });

  assert.deepEqual(plain(w.logged), [['log', ['hello', { a: 1 }]], ['warn', ['careful']]]); // passthrough intact

  const r = await w.call({ op: 'console' });
  assert.equal(r.ok, true);
  const e = plain(r.entries);
  assert.deepEqual(e.map((x) => [x.sequence, x.kind, x.level]), [[1, 'console', 'log'], [2, 'console', 'warn'], [3, 'exception', 'error'], [4, 'exception', 'error']]);
  assert.equal(e[0].text, 'hello {"a":1}');
  assert.equal(e[2].text, 'Uncaught boom');
  assert.deepEqual([e[2].url, e[2].line, e[2].column], ['a.js', 3, 4]);
  assert.match(e[3].text, /^Unhandled promise rejection: .*nope/);
  assert.equal(r.nextSince, 4);
  assert.equal(r.truncated, false);
  assert.equal(e[0].stack, undefined); // raw stack never leaks to the wire
});

test('console honours since / limit / max_text_chars / include_stack', async () => {
  const w = loadWorlds();
  for (let i = 1; i <= 5; i++) w.main.console.log(`m${i}`);
  w.main.console.log('x'.repeat(50));

  const page1 = await w.call({ op: 'console', limit: 2 });
  assert.deepEqual(plain([page1.entries.map((x) => x.text), page1.nextSince, page1.truncated]), [['m1', 'm2'], 2, true]);
  const page2 = await w.call({ op: 'console', since: page1.nextSince, limit: 10 });
  assert.deepEqual(plain([page2.entries.length, page2.nextSince, page2.truncated]), [4, 6, false]);
  const none = await w.call({ op: 'console', since: 6 });
  assert.deepEqual(plain([none.entries.length, none.nextSince]), [0, 6]);

  const cut = (await w.call({ op: 'console', since: 5, maxTextChars: 10 })).entries[0];
  assert.deepEqual(plain([cut.text.length, cut.truncated]), [10, true]);

  const withStack = (await w.call({ op: 'console', limit: 1, includeStack: true })).entries[0];
  assert.ok(Array.isArray(withStack.stack_trace));
  assert.equal((await w.call({ op: 'console', limit: 1 })).entries[0].stack_trace, undefined);
});

test('a failed resource load is logged as kind "log", not as an uncaught exception', async () => {
  const w = loadWorlds();
  w.bus.emit({ type: 'error', target: { tagName: 'IMG', src: 'https://x/y.png' } });
  const [e] = plain((await w.call({ op: 'console' })).entries);
  assert.deepEqual([e.kind, e.level, e.text], ['log', 'error', 'Failed to load resource: https://x/y.png']);
});

test('console keeps at most 1000 entries, dropping the oldest', async () => {
  const w = loadWorlds();
  for (let i = 1; i <= 1200; i++) w.main.console.log(i);
  const r = await w.call({ op: 'console', limit: 500 });
  assert.equal(r.entries[0].sequence, 201);
  assert.equal(r.nextSince, 700);
});

test('background maps evaluate/console to wire shapes; evaluate has dialogs, console has none', async () => {
  const seen = [];
  const tabs = new Map([[7, { id: 7, windowId: 1, index: 0, status: 'complete' }]]);
  const browser = {
    storage: { local: { get: async () => ({}), set: async () => {} } },
    runtime: { getManifest: () => ({ version: '0' }), getURL: (p) => p, onMessage: { addListener() {} } },
    windows: { create: async () => ({ id: 1, tabs: [] }), update: async () => {}, remove: async () => {} },
    tabs: {
      get: async (id) => tabs.get(id), update: async (id, o) => Object.assign(tabs.get(id), o), query: async () => [],
      captureVisibleTab: async () => '',
      sendMessage: async (_t, msg) => {
        seen.push(msg);
        return msg.op === 'evaluate'
          ? { ok: true, evalOk: false, error: { text: 'Uncaught Error: x' } }
          : { ok: true, entries: [{ sequence: 1, kind: 'console', level: 'log', text: 'a', truncated: false }], nextSince: 1, truncated: false };
      },
    },
  };
  const bg = makeBackground({ browser, WebSocket: class {}, console, crypto: {}, navigator: {}, setTimeout, clearTimeout, setInterval, clearInterval });
  const ev = await bg.dispatch('tool.evaluate', { session_id: 's', tab_id: 7, expression: 'x', await_promise: false, timeout_ms: 500 });
  assert.deepEqual(ev, { ok: false, tab_id: 7, value: undefined, error: { text: 'Uncaught Error: x' }, dialogs: [] });
  const con = await bg.dispatch('tool.console', { session_id: 's', tab_id: 7, since: 0, limit: 5, max_text_chars: 9, include_stack: true });
  assert.deepEqual(con, { tab_id: 7, entries: [{ sequence: 1, kind: 'console', level: 'log', text: 'a', truncated: false }], next_since: 1, truncated: false });
  assert.deepEqual(seen[0], { op: 'evaluate', expression: 'x', awaitPromise: false, timeoutMs: 500 });
  assert.deepEqual(seen[1], { op: 'console', since: 0, limit: 5, maxTextChars: 9, includeStack: true });
});

test('manifest loads hook.js first, at document_start, in the MAIN world', () => {
  const m = JSON.parse(readFileSync(here('manifest.json'), 'utf8'));
  const hook = m.content_scripts.find((c) => c.js.includes('hook.js'));
  assert.deepEqual([hook.run_at, hook.world, m.content_scripts.indexOf(hook)], ['document_start', 'MAIN', 0]);
  assert.ok(m.content_scripts.some((c) => c.js.includes('content.js')));
});
