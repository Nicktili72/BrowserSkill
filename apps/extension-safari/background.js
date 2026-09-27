// BrowserSkill Safari extension — background page (MV2, persistent).
// Connects to the real `bsk` daemon on ws://127.0.0.1:52800/extension and
// implements a reduced tool set: session_start/stop, tab_list/create/close/
// select/borrow/return, navigate, snapshot, click, fill, press, scroll_to,
// screenshot. Anything else in bsk-protocol's Method enum gets a clean
// `unsupported` error rather than silently doing nothing — see NOTES.md
// for what's out of scope and why.
//
// Known Safari limitation baked into this design: `windows.create({tabId})`
// does not move the tab (long-standing WebKit bug, unlike Chrome), and
// `tabs.move` isn't supported at all. So unlike the real BrowserSkill
// extension, tab_borrow does NOT relocate the tab into a separate Agent
// Window — it only marks the tab as owned by the session, after the human
// approves it in confirm.html. tab_create still gets a real isolated
// window, since creating one *with a URL* (no tabId) works fine.

const WS_URL = 'ws://127.0.0.1:52800/extension';
const HEARTBEAT_MS = 20000;

// Loaded from protocol.js: via require() under Node (tests), or the
// global object in the real extension (manifest.json loads it as a
// separate classic script; see protocol.js's own end-of-file comment for
// why it explicitly attaches its `const` exports to `self`).
//
// This lookup itself must stay INSIDE makeBackground(), not at this file's
// top level: `handshakeParams` etc. are already global properties (via
// protocol.js's function declarations / explicit self.* assignment), and a
// top-level `const` with the same name as an existing global is a
// SyntaxError ("duplicate variable that shadows a global property") that
// silently kills the whole script in a real Safari background page — a
// plain function-scoped const shadowing them is fine.
const protocolModule = () => (typeof require !== 'undefined' ? require('./protocol.js') : self);

function makeBackground(env) {
  const { browser, WebSocket, console, crypto, setTimeout, clearTimeout, setInterval, clearInterval } = env;
  const { handshakeParams, NO_DIALOGS, keyToCode, rpcOk, rpcErr } = protocolModule();
  const sessions = new Map(); // session_id -> { agentWindowId, agentTabIds:Set<number>, borrowed:Map<tabId,{originalWindowId,originalIndex}> }
  const pendingConfirmations = new Map(); // requestId -> resolve(allow)
  let ws = null;
  let reconnectDelay = 500;
  let heartbeatTimer = null;
  let instanceId = null;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function getInstanceId() {
    if (instanceId) return instanceId;
    const stored = await browser.storage.local.get('instanceId');
    if (stored.instanceId) return (instanceId = stored.instanceId);
    instanceId = crypto.randomUUID();
    await browser.storage.local.set({ instanceId });
    return instanceId;
  }

  function safariVersion() {
    const m = /Version\/([\d.]+)/.exec(env.navigator?.userAgent || '');
    return m ? m[1] : '0.0';
  }

  async function connect() {
    ws = new WebSocket(WS_URL);
    ws.onopen = async () => {
      reconnectDelay = 500;
      const params = handshakeParams({
        instanceId: await getInstanceId(),
        extVersion: browser.runtime.getManifest().version,
        browserVersion: safariVersion(),
        label: 'Safari',
      });
      ws.send(JSON.stringify({ id: 'handshake', method: 'system.handshake', params }));
    };
    ws.onclose = () => {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 1.5, 10000);
    };
    ws.onerror = (e) => console.error('[bsk] ws error', e);
    ws.onmessage = (e) => handleFrame(JSON.parse(e.data));
  }

  function handleFrame(frame) {
    if (frame.method) {
      dispatch(frame.method, frame.params || {}).then(
        (result) => send(rpcOk(frame.id, result)),
        (err) => send(rpcErr(frame.id, err?.code || 'protocol_error', err?.message || String(err))),
      );
      return;
    }
    if (frame.id === 'handshake') {
      if (frame.error) { console.error('[bsk] handshake rejected', frame.error); ws.close(); return; }
      heartbeatTimer = setInterval(() => send({ event: 'system.heartbeat', payload: {} }), HEARTBEAT_MS);
    }
    // Frames we don't act on (events like session.user_interrupt): the
    // reduced scope here has no interrupt-gate UI to wire them into.
  }

  function send(frameLike) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(frameLike));
  }

  function requireSession(p) {
    const s = sessions.get(p.session_id);
    if (!s) throw { code: 'not_found', message: `unknown session ${p.session_id}` };
    return s;
  }

  async function defaultTabId(sessionId) {
    const s = sessions.get(sessionId);
    if (s) {
      const [t] = await browser.tabs.query({ windowId: s.agentWindowId, active: true });
      if (t) return t.id;
    }
    const [t] = await browser.tabs.query({ active: true, currentWindow: true });
    if (!t) throw { code: 'not_found', message: 'no active tab and no session agent window' };
    return t.id;
  }

  // A backgrounded tab can report zero-sized/garbage layout (confirmed
  // against this Mac's WebKit while building this extension — clientWidth,
  // innerWidth and getBoundingClientRect() all collapsed to 0 on a
  // non-frontmost tab). Every op that reads or acts on layout brings its
  // tab to the front first, which also matches showing the user what the
  // agent is doing rather than acting invisibly behind other windows.
  async function activateTab(tabId) {
    const tab = await browser.tabs.update(tabId, { active: true });
    await browser.windows.update(tab.windowId, { focused: true });
    return tab;
  }

  async function page(tabId, msg) {
    await activateTab(tabId);
    let res;
    try { res = await browser.tabs.sendMessage(tabId, msg); }
    catch { throw { code: 'not_found', message: `tab ${tabId} has no content script (restricted page, or still loading)` }; }
    if (!res) throw { code: 'protocol_error', message: 'no response from page' };
    if (!res.ok) throw res.error;
    return res;
  }

  function requestBorrowConfirmation(tab, timeoutMs) {
    return new Promise(async (resolve) => {
      const requestId = 'borrow-' + Date.now() + '-' + Math.random().toString(36).slice(2);
      const url = browser.runtime.getURL('confirm.html') +
        '?requestId=' + encodeURIComponent(requestId) +
        '&title=' + encodeURIComponent(tab.title || '') +
        '&url=' + encodeURIComponent(tab.url || '');
      let win;
      try { win = await browser.windows.create({ url, type: 'popup', width: 420, height: 220, focused: true }); }
      catch { resolve(false); return; } // can't prompt the human -> fail closed
      let done = false;
      const finish = (allow) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        pendingConfirmations.delete(requestId);
        browser.windows.remove(win.id).catch(() => {});
        resolve(allow);
      };
      const timer = setTimeout(() => finish(false), timeoutMs);
      pendingConfirmations.set(requestId, finish);
    });
  }

  const NO_DIALOGS_KEY = 'dialogs';
  const withDialogs = (obj) => ({ ...obj, [NO_DIALOGS_KEY]: NO_DIALOGS });

  const tools = {
    'system.ping': async () => ({ pong: true }),

    'tool.session_start': async (p) => {
      const opts = { url: 'about:blank', focused: p.unattended ? false : p.focused !== false };
      if (p.width) opts.width = p.width;
      if (p.height) opts.height = p.height;
      const win = await browser.windows.create(opts);
      sessions.set(p.session_id, {
        agentWindowId: win.id,
        agentTabIds: new Set((win.tabs || []).map((t) => t.id)),
        borrowed: new Map(),
      });
      return {
        interaction: { borrow_confirmation: 'always', request_help: 'disabled' },
        agent_window_id: win.id,
      };
    },

    'tool.session_stop': async (p) => {
      const s = requireSession(p);
      const returned = [...s.borrowed.keys()];
      s.borrowed.clear();
      try { await browser.windows.remove(s.agentWindowId); } catch { /* already closed */ }
      sessions.delete(p.session_id);
      return { returned_tab_ids: returned, return_failures: [] };
    },

    'tool.tab_list': async () => {
      // Reduced scope: `scope` (user/agent/all) is not filtered — every
      // call sees every tab, same as `all`.
      const tabs = await browser.tabs.query({});
      return { tabs: tabs.map((t) => ({ tab_id: t.id, title: t.title, url: t.url, window_id: t.windowId, active: t.active })) };
    },

    'tool.tab_create': async (p) => {
      const s = requireSession(p);
      const opts = { windowId: s.agentWindowId, url: p.url || 'about:blank' };
      if (p.active !== undefined) opts.active = p.active;
      if (p.index !== undefined) opts.index = p.index;
      const tab = await browser.tabs.create(opts);
      s.agentTabIds.add(tab.id);
      return { tab_id: tab.id, window_id: tab.windowId, url: tab.url || '' };
    },

    'tool.tab_close': async (p) => {
      await browser.tabs.remove(p.tab_id);
      for (const s of sessions.values()) { s.agentTabIds.delete(p.tab_id); s.borrowed.delete(p.tab_id); }
      return { tab_id: p.tab_id };
    },

    'tool.tab_select': async (p) => {
      const tab = await activateTab(p.tab_id);
      return { tab_id: p.tab_id, window_id: tab.windowId };
    },

    'tool.tab_borrow': async (p) => {
      const s = requireSession(p);
      const tab = await browser.tabs.get(p.tab_id);
      const allowed = await requestBorrowConfirmation(tab, p.confirmation_timeout_ms || 60000);
      if (!allowed) throw { code: 'user_aborted', message: 'user denied borrowing this tab' };
      s.borrowed.set(p.tab_id, { originalWindowId: tab.windowId, originalIndex: tab.index });
      // Not moved (Safari can't reparent an existing tab reliably — see
      // header comment); agent_window_id reports the tab's own window.
      return { tab_id: p.tab_id, original_window_id: tab.windowId, original_index: tab.index, agent_window_id: tab.windowId };
    },

    'tool.tab_return': async (p) => {
      const s = requireSession(p);
      const info = s.borrowed.get(p.tab_id);
      if (!info) throw { code: 'not_found', message: `tab ${p.tab_id} was not borrowed by this session` };
      s.borrowed.delete(p.tab_id);
      const tab = await browser.tabs.get(p.tab_id).catch(() => null);
      return {
        tab_id: p.tab_id,
        returned_to_window_id: tab ? tab.windowId : info.originalWindowId,
        returned_to_index: tab ? tab.index : info.originalIndex,
        fallback: false,
      };
    },

    'tool.navigate': async (p) => {
      const tabId = p.tab_id ?? (await defaultTabId(p.session_id));
      await browser.tabs.update(tabId, { url: p.url });
      let reached = 'timeout';
      for (let i = 0; i < 30; i++) {
        const t = await browser.tabs.get(tabId);
        if (t.status === 'complete') { reached = 'complete'; break; }
        await sleep(500);
      }
      const t = await browser.tabs.get(tabId);
      return withDialogs({ tab_id: tabId, url: p.url, final_url: t.url, reached });
    },

    'tool.snapshot': async (p) => {
      const tabId = p.tab_id ?? (await defaultTabId(p.session_id));
      const r = await page(tabId, { op: 'snapshot', maxChars: p.max_tokens ? p.max_tokens * 4 : 8000 });
      return withDialogs({ text: r.text, ref_count: r.refCount, tab_id: tabId, truncated: r.truncated });
    },

    'tool.click': async (p) => {
      const tabId = p.tab_id ?? (await defaultTabId(p.session_id));
      const r = await page(tabId, { op: 'click', ref: p.ref, selector: p.selector });
      return withDialogs({ tab_id: tabId, used_ref: r.usedRef, used_selector: r.usedSelector, x: r.x, y: r.y });
    },

    'tool.fill': async (p) => {
      const tabId = p.tab_id ?? (await defaultTabId(p.session_id));
      const r = await page(tabId, { op: 'fill', ref: p.ref, selector: p.selector, value: p.value, clearBefore: p.clear_before });
      return withDialogs({ tab_id: tabId, used_ref: r.usedRef, used_selector: r.usedSelector, value_length: r.valueLength });
    },

    'tool.press': async (p) => {
      const tabId = p.tab_id ?? (await defaultTabId(p.session_id));
      const r = await page(tabId, { op: 'press', ref: p.ref, selector: p.selector, key: p.key, code: keyToCode(p.key) });
      return withDialogs({ tab_id: tabId, key: p.key, code: keyToCode(p.key), modifiers: p.modifiers || [], used_ref: r.usedRef, used_selector: r.usedSelector });
    },

    'tool.scroll_to': async (p) => {
      const tabId = p.tab_id ?? (await defaultTabId(p.session_id));
      const r = await page(tabId, { op: 'scrollTo', ref: p.ref, selector: p.selector });
      return withDialogs({ tab_id: tabId, used_ref: r.usedRef, used_selector: r.usedSelector, x: r.x, y: r.y, width: r.width, height: r.height });
    },

    'tool.screenshot': async (p) => {
      const tabId = p.tab_id ?? (await defaultTabId(p.session_id));
      const tab = await activateTab(tabId);
      await sleep(150); // let the tab actually paint after gaining focus
      const dataUrl = await browser.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
      const m = /^data:image\/png;base64,(.*)$/.exec(String(dataUrl));
      if (!m) throw { code: 'protocol_error', message: 'captureVisibleTab returned an unexpected format' };
      const dims = await page(tabId, { op: 'viewportSize' }).catch(() => ({ width: 0, height: 0 }));
      return withDialogs({ image_base64: m[1], width: dims.width, height: dims.height, format: 'png', tab_id: tabId });
    },
  };

  async function dispatch(method, params) {
    const handler = tools[method];
    if (!handler) throw { code: 'unsupported', message: `${method} is not implemented in the Safari extension` };
    return handler(params);
  }

  browser.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'borrow-confirm-result') {
      const finish = pendingConfirmations.get(msg.requestId);
      if (finish) finish(!!msg.allow);
    }
  });

  return { connect, dispatch, sessions };
}

if (typeof module !== 'undefined') {
  module.exports = { makeBackground };
} else {
  makeBackground({ browser, WebSocket, console, crypto, navigator, setTimeout, clearTimeout, setInterval, clearInterval }).connect();
}
