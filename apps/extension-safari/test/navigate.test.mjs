// tool.navigate must never reject on tab state: a closed tab (or one closed
// mid-poll) answers reached:'tab_closed'; a tab stuck 'loading' answers
// reached:'timeout' with the live url; a same-document navigation (status
// never leaves 'complete') settles immediately instead of burning 15s.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { makeBackground } = require('../background.js');

function makeEnv() {
  const tabs = new Map();
  let nextTabId = 100;
  let nextWindowId = 200;
  const browser = {
    storage: { local: { get: async () => ({}), set: async () => {} } },
    runtime: {
      getManifest: () => ({ version: '0.1.0' }),
      getURL: (p) => 'safari-web-extension://TESTID/' + p,
      onMessage: { addListener: () => {} },
    },
    windows: {
      create: async () => ({ id: nextWindowId++, tabs: [] }),
      update: async () => {},
      remove: async () => {},
    },
    tabs: {
      create: async (opts) => {
        const t = { id: nextTabId++, windowId: opts.windowId, url: opts.url || '', active: true, index: 0, status: 'complete', title: 'New Tab' };
        tabs.set(t.id, t);
        return t;
      },
      remove: async (id) => { tabs.delete(id); },
      update: async (id, opts) => {
        const t = tabs.get(id) || { id, windowId: 1, index: 0, status: 'complete' };
        Object.assign(t, opts);
        tabs.set(id, t);
        return t;
      },
      // Real Safari REJECTS tabs.get for a closed tab; mimic that exactly.
      get: async (id) => { const t = tabs.get(id); if (!t) throw new Error('no such tab'); return t; },
      query: async (q = {}) => [...tabs.values()].filter(
        (t) => (q.windowId === undefined || t.windowId === q.windowId) && (q.active === undefined || t.active === q.active),
      ),
      sendMessage: async () => ({ ok: true }),
      captureVisibleTab: async () => 'data:image/png;base64,QUJD',
    },
  };
  return {
    browser, WebSocket: class {}, console,
    crypto: { randomUUID: () => 'fixed-uuid' },
    navigator: { userAgent: 'Version/17.4 Safari/605.1.15' },
    setTimeout, clearTimeout, setInterval, clearInterval,
  };
}

async function seeded(env) {
  const bg = makeBackground(env);
  await bg.dispatch('tool.session_start', { session_id: 's1' });
  const { tab_id } = await bg.dispatch('tool.tab_create', { session_id: 's1', url: 'https://a.test/start' });
  return { bg, tab_id };
}

test('navigate settles immediately on a same-document navigation (status never leaves complete)', async () => {
  const env = makeEnv();
  const { bg, tab_id } = await seeded(env);
  const t0 = Date.now();
  const r = await bg.dispatch('tool.navigate', { session_id: 's1', tab_id, url: 'https://b.test/dest' });
  assert.equal(r.reached, 'complete');
  assert.equal(r.final_url, 'https://b.test/dest');
  assert.ok(Date.now() - t0 < 5_000, 'must not burn the 15s poll window when already complete');
});

test('a tab closed mid-navigation gives tab_closed, not a rejected call', async () => {
  const env = makeEnv();
  const { bg, tab_id } = await seeded(env);
  let n = 0;
  env.browser.tabs.update = async (id, opts) => {
    const t = { id, url: opts.url, status: 'loading' };
    // loading now, gone on the SECOND poll read (closed mid redirect chain)
    let polls = 0;
    env.browser.tabs.get = async () => { if (++polls === 1) return t; throw new Error('no such tab'); };
    return t;
  };
  const r = await bg.dispatch('tool.navigate', { session_id: 's1', tab_id, url: 'https://b.test/dest' });
  assert.equal(r.reached, 'tab_closed');
  assert.equal(r.final_url, 'https://b.test/dest'); // never claim an unreadable url
});

test('a tab stuck loading past the poll window reports timeout with the live url', async () => {
  const env = makeEnv();
  const { bg, tab_id } = await seeded(env);
  env.browser.tabs.get = async (id) => ({ id, windowId: 1, index: 0, status: 'loading', url: 'https://slow.test/chain' });
  const t0 = Date.now();
  const r = await bg.dispatch('tool.navigate', { session_id: 's1', tab_id, url: 'https://slow.test/chain' });
  assert.equal(r.reached, 'timeout');
  assert.equal(r.final_url, 'https://slow.test/chain');
  assert.ok(Date.now() - t0 >= 14_000, 'the full poll window must be honoured');
}, { timeout: 20_000 });
