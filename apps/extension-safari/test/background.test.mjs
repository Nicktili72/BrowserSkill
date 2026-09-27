// Exercises makeBackground()'s tool dispatch against a mocked `browser`
// namespace — no real WebSocket/Safari needed. Covers the reduced tool
// set's actual behavior, not the wire transport (see transport.test.mjs
// for the handshake/heartbeat framing).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { makeBackground } = require('../background.js');

function makeEnv({ sendMessage } = {}) {
  const calls = [];
  const tabs = new Map();
  const listeners = [];
  let nextTabId = 100;
  let nextWindowId = 200;

  const browser = {
    storage: { local: { get: async () => ({}), set: async () => {} } },
    runtime: {
      getManifest: () => ({ version: '0.1.0' }),
      getURL: (p) => 'safari-web-extension://TESTID/' + p,
      onMessage: { addListener: (f) => listeners.push(f) },
    },
    windows: {
      create: async (opts) => { calls.push(['windows.create', opts]); const id = nextWindowId++; return { id, tabs: [] }; },
      update: async (id, opts) => calls.push(['windows.update', id, opts]),
      remove: async (id) => calls.push(['windows.remove', id]),
    },
    tabs: {
      create: async (opts) => {
        calls.push(['tabs.create', opts]);
        const t = { id: nextTabId++, windowId: opts.windowId, url: opts.url || '', active: opts.active !== false, index: 0, status: 'complete', title: 'New Tab' };
        tabs.set(t.id, t);
        return t;
      },
      remove: async (id) => { calls.push(['tabs.remove', id]); tabs.delete(id); },
      update: async (id, opts) => {
        calls.push(['tabs.update', id, opts]);
        const t = tabs.get(id) || { id, windowId: 1, index: 0, status: 'complete' };
        Object.assign(t, opts);
        tabs.set(id, t);
        return t;
      },
      get: async (id) => { const t = tabs.get(id); if (!t) throw new Error('no such tab'); return t; },
      query: async (q = {}) => [...tabs.values()].filter(
        (t) => (q.windowId === undefined || t.windowId === q.windowId) && (q.active === undefined || t.active === q.active),
      ),
      sendMessage: sendMessage || (async () => ({ ok: true })),
      captureVisibleTab: async () => 'data:image/png;base64,QUJD',
    },
  };

  const env = {
    browser, WebSocket: class {}, console,
    crypto: { randomUUID: () => 'fixed-uuid' },
    navigator: { userAgent: 'Version/17.4 Safari/605.1.15' },
    setTimeout, clearTimeout, setInterval, clearInterval,
  };
  return { env, calls, tabs, listeners };
}

async function seedSession(bg, sessionId = 's1') {
  return bg.dispatch('tool.session_start', { session_id: sessionId });
}

test('session_start opens a window and reports the fixed interaction policy', async () => {
  const { env, calls } = makeEnv();
  const bg = makeBackground(env);
  const r = await seedSession(bg);
  assert.equal(r.interaction.borrow_confirmation, 'always');
  assert.equal(r.interaction.request_help, 'disabled');
  assert.equal(r.agent_window_id, calls.find((c) => c[0] === 'windows.create')[1] && 200);
});

test('tab_create always targets the session agent window, not the caller-supplied window', async () => {
  const { env, calls } = makeEnv();
  const bg = makeBackground(env);
  const { agent_window_id } = await seedSession(bg);
  const r = await bg.dispatch('tool.tab_create', { session_id: 's1', url: 'https://example.com' });
  assert.equal(r.window_id, agent_window_id);
  const created = calls.find((c) => c[0] === 'tabs.create');
  assert.equal(created[1].windowId, agent_window_id);
});

test('tab_create without a started session is a clean not_found, not a crash', async () => {
  const bg = makeBackground(makeEnv().env);
  await assert.rejects(
    () => bg.dispatch('tool.tab_create', { session_id: 'missing', url: 'https://x' }),
    (e) => e.code === 'not_found',
  );
});

test('click/fill route to the content script and pass through its result shape, with dialogs always present', async () => {
  const messages = [];
  const { env } = makeEnv({
    sendMessage: async (tabId, msg) => {
      messages.push({ tabId, msg });
      if (msg.op === 'click') return { ok: true, x: 12, y: 34, usedRef: 'e1' };
      if (msg.op === 'fill') return { ok: true, usedSelector: '#q', valueLength: 5 };
      return { ok: true };
    },
  });
  const bg = makeBackground(env);
  await seedSession(bg);
  const tab = await bg.dispatch('tool.tab_create', { session_id: 's1' });

  const click = await bg.dispatch('tool.click', { session_id: 's1', tab_id: tab.tab_id, ref: 'e1' });
  assert.deepEqual(click, { tab_id: tab.tab_id, used_ref: 'e1', used_selector: undefined, x: 12, y: 34, dialogs: [] });

  const fill = await bg.dispatch('tool.fill', { session_id: 's1', tab_id: tab.tab_id, selector: '#q', value: 'hello' });
  assert.equal(fill.used_selector, '#q');
  assert.equal(fill.value_length, 5);
  assert.deepEqual(fill.dialogs, []);

  assert.equal(messages[0].msg.op, 'click');
  assert.equal(messages[1].msg.op, 'fill');
  assert.equal(messages[1].msg.value, 'hello');
});

test('a content-script error (e.g. stale ref) surfaces as that error code, not protocol_error', async () => {
  const { env } = makeEnv({ sendMessage: async () => ({ ok: false, error: { code: 'not_found', message: 'ref e9 not found; call snapshot again' } }) });
  const bg = makeBackground(env);
  await seedSession(bg);
  const tab = await bg.dispatch('tool.tab_create', { session_id: 's1' });
  await assert.rejects(
    () => bg.dispatch('tool.click', { session_id: 's1', tab_id: tab.tab_id, ref: 'e9' }),
    (e) => e.code === 'not_found' && /call snapshot again/.test(e.message),
  );
});

test('an unimplemented method is a clean unsupported error, not a silent no-op', async () => {
  const bg = makeBackground(makeEnv().env);
  await assert.rejects(
    () => bg.dispatch('tool.upload', { session_id: 's1' }),
    (e) => e.code === 'unsupported' && /tool\.upload/.test(e.message),
  );
});

test('tab_borrow denies (fail-closed) when the human never answers the confirm popup before the timeout', async () => {
  const { env } = makeEnv();
  const bg = makeBackground(env);
  await seedSession(bg);
  const tab = await bg.dispatch('tool.tab_create', { session_id: 's1', url: 'https://example.com' });
  await assert.rejects(
    () => bg.dispatch('tool.tab_borrow', { session_id: 's1', tab_id: tab.tab_id, confirmation_timeout_ms: 5 }),
    (e) => e.code === 'user_aborted',
  );
});

test('tab_borrow succeeds once confirm.js\'s message arrives, and does not falsely report the tab as moved', async () => {
  const { env, calls, listeners } = makeEnv();
  const bg = makeBackground(env);
  await seedSession(bg);
  const tab = await bg.dispatch('tool.tab_create', { session_id: 's1', url: 'https://example.com' });

  const borrowPromise = bg.dispatch('tool.tab_borrow', { session_id: 's1', tab_id: tab.tab_id, confirmation_timeout_ms: 5000 });
  await new Promise((r) => setImmediate(r)); // let the popup-creation microtask run first

  const popup = calls.find((c) => c[0] === 'windows.create' && c[1].type === 'popup');
  assert.ok(popup, 'expected a popup window for the borrow confirmation');
  const requestId = new URL(popup[1].url.replace('safari-web-extension://TESTID/', 'https://x/')).searchParams.get('requestId');
  assert.ok(requestId);
  assert.equal(listeners.length, 1, 'background must register exactly one onMessage listener for confirm.js replies');

  listeners[0]({ type: 'borrow-confirm-result', requestId, allow: true });

  const result = await Promise.race([borrowPromise, new Promise((r) => setTimeout(() => r('timeout'), 200))]);
  assert.notEqual(result, 'timeout', 'expected the borrow confirmation to resolve without waiting for its timeout');
  assert.equal(result.tab_id, tab.tab_id);
  assert.equal(result.agent_window_id, tab.window_id, "must report the tab's own window, not the Agent Window it was never moved into");
});
