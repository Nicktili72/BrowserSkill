// BrowserSkill Safari extension — background page (MV2, persistent).
// Connects to the real `bsk` daemon on ws://127.0.0.1:52800/extension and
// implements a reduced tool set: session_start/stop, tab_list/create/close/
// select/borrow/return, navigate, snapshot, observe, click, fill, press,
// select, focus, blur, wheel, scroll_to, get_html, wait_for_navigation,
// evaluate, console, network, upload, hover, reload, navigate_back/forward,
// window_resize, screenshot (viewport, element crop, full page + read/release).
// Anything else in bsk-protocol's Method enum gets a clean
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
const MAX_DEVICE_HEIGHT = 32000; // full-page screenshot: taller pages are scaled down to this (canvas size limits)
const READ_CHUNK_BYTES = 192 * 1024; // base64 makes this 256 KiB on the wire

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

// Image work for element-crop and full-page screenshots. Safari only offers
// captureVisibleTab, so cropping/stitching happens on a canvas in the
// background page. Injected as `env.imaging` in tests.
function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function domImaging(doc) {
  const decode = async (dataUrl) => { const img = new Image(); img.src = dataUrl; await img.decode(); return img; };
  const png = async (canvas) => {
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
    return new Uint8Array(await blob.arrayBuffer());
  };
  const canvas = (w, h) => { const c = doc.createElement('canvas'); c.width = w; c.height = h; return c; };
  return {
    async crop(dataUrl, r) {
      const img = await decode(dataUrl);
      const x = Math.max(0, Math.round(r.x)), y = Math.max(0, Math.round(r.y));
      const w = Math.min(img.naturalWidth - x, Math.round(r.width)), h = Math.min(img.naturalHeight - y, Math.round(r.height));
      if (w <= 0 || h <= 0) throw { code: 'not_found', message: 'element is outside the visible area' };
      const c = canvas(w, h);
      c.getContext('2d').drawImage(img, x, y, w, h, 0, 0, w, h);
      const bytes = await png(c);
      return { base64: toBase64(bytes), width: w, height: h };
    },
    // `scale` < 1 shrinks everything so a very tall page still fits the canvas.
    async stitch(frames, width, height, scale = 1) {
      const c = canvas(width, height);
      const ctx = c.getContext('2d');
      for (const f of frames) {
        const img = await decode(f.dataUrl);
        ctx.drawImage(img, 0, Math.round(f.y * scale), Math.round(img.naturalWidth * scale), Math.round(img.naturalHeight * scale));
      }
      return { bytes: await png(c), width, height };
    },
  };
}

function makeBackground(env) {
  const { browser, WebSocket, console, crypto, setTimeout, clearTimeout, setInterval, clearInterval } = env;
  const imaging = env.imaging || domImaging(env.document);
  const { handshakeParams, NO_DIALOGS, keyToCode, keyToModifiers, rpcOk, rpcErr } = protocolModule();
  const sessions = new Map(); // session_id -> { agentWindowId, agentTabIds:Set<number>, borrowed:Map<tabId,{originalWindowId,originalIndex}> }
  const captures = new Map(); // capture_id -> { sessionId, bytes } (full-page screenshots awaiting screenshot_read)
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
    // Inbound frames we don't act on: the reduced tool set never carries
    // inbound events here (session.user_interrupt is daemon-internal — the
    // daemon handles it inside handle_inbound_text, so nothing like it ever
    // reaches this loop). Anything unexpected is ignored; worst case, a
    // malformed frame idles the socket until the daemon's 20s heartbeat
    // timeout tears it down.
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

  // After an action that starts a navigation (reload/back/forward): wait for it
  // to start (status leaves 'complete', or the URL changes), then for it to
  // finish. `expectChange` makes "nothing happened" an error (no history entry).
  async function afterNavAction(tabId, before, { want = 'load', timeoutMs = 30000, expectChange = false } = {}) {
    const deadline = Date.now() + timeoutMs;
    const live = () => browser.tabs.get(tabId).catch(() => null);
    let tab = await live();
    const started = () => tab && (tab.status !== 'complete' || tab.url !== before.url);
    for (let i = 0; i < 8 && tab && !started(); i++) { await sleep(150); tab = await live(); }
    if (!tab) throw { code: 'not_found', message: `tab ${tabId} was closed` };
    if (expectChange && !started()) throw { code: 'not_found', message: 'there is no history entry in that direction' };
    while (tab && tab.status !== 'complete' && Date.now() < deadline) { await sleep(250); tab = await live(); }
    if (!tab) throw { code: 'not_found', message: `tab ${tabId} was closed` };
    const done = tab.status === 'complete';
    if (done && want === 'networkidle') await sleep(500); // ponytail: approximation, see wait_for_navigation
    return { final_url: tab.url, reached: done ? want : 'timeout' };
  }

  async function historyGo(tabId, delta) {
    const native = delta < 0 ? browser.tabs.goBack : browser.tabs.goForward;
    if (typeof native === 'function') return native.call(browser.tabs, tabId);
    return page(tabId, { op: 'history', delta }); // content script fallback
  }

  async function capturePng(tabId) {
    const tab = await activateTab(tabId);
    await sleep(150); // let the tab actually paint after gaining focus
    const dataUrl = await browser.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    if (!/^data:image\/png;base64,/.test(String(dataUrl))) throw { code: 'protocol_error', message: 'captureVisibleTab returned an unexpected format' };
    return String(dataUrl);
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
      for (const [id, c] of captures) if (c.sessionId === p.session_id) captures.delete(id);
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
      let t;
      // A tab closed/lost mid-poll must not reject the whole call: the
      // daemon needs an answer, and an RPC *error* says far less than
      // reached:'tab_closed'. Same-document (pushState) navigations never
      // leave 'complete', so the loop breaks immediately and reports the
      // live tab state (this also no longer burns the full 15 s on them).
      const live = (tabId) => browser.tabs.get(tabId).catch(() => null);
      let poll = await live(tabId);
      for (let i = 0; i < 30 && poll && poll.status !== 'complete'; i++) {
        await sleep(500);
        poll = await live(tabId);
      }
      if (!poll) {
        reached = 'tab_closed';
        t = { url: p.url }; // don't claim a final_url we cannot read
      } else {
        t = poll;
        reached = poll.status === 'complete' ? 'complete' : 'timeout';
      }
      return withDialogs({ tab_id: tabId, url: p.url, final_url: t.url, reached });
    },

    'tool.snapshot': async (p) => {
      const tabId = p.tab_id ?? (await defaultTabId(p.session_id));
      const r = await page(tabId, { op: 'snapshot', maxChars: p.max_tokens ? p.max_tokens * 4 : 8000 });
      return withDialogs({ text: r.text, ref_count: r.refCount, tab_id: tabId, truncated: r.truncated });
    },

    // observe = snapshot here: no hover probing, cursor paging or depth cap
    // (the extension has no VOM tree), so those params are ignored and
    // `hover_probe` is omitted, which the protocol allows.
    'tool.observe': async (p) => {
      const tabId = p.tab_id ?? (await defaultTabId(p.session_id));
      const r = await page(tabId, { op: 'snapshot', maxChars: p.max_tokens ? p.max_tokens * 4 : 8000 });
      return withDialogs({ text: r.text, ref_count: r.refCount, tab_id: tabId, truncated: r.truncated });
    },

    // Runs in the page's own JS world via hook.js. A JS *throw* is an
    // in-band `ok:false` result (per the protocol); "page world not
    // reachable" is an RPC error instead (see content.js callMain).
    'tool.evaluate': async (p) => {
      const tabId = p.tab_id ?? (await defaultTabId(p.session_id));
      const r = await page(tabId, { op: 'evaluate', expression: p.expression, awaitPromise: p.await_promise, timeoutMs: p.timeout_ms });
      return withDialogs({ ok: r.evalOk, tab_id: tabId, value: r.value, error: r.error });
    },

    'tool.console': async (p) => {
      const tabId = p.tab_id ?? (await defaultTabId(p.session_id));
      const r = await page(tabId, { op: 'console', since: p.since, limit: p.limit, maxTextChars: p.max_text_chars, includeStack: p.include_stack });
      return { tab_id: tabId, entries: r.entries, next_since: r.nextSince, truncated: r.truncated };
    },

    'tool.network': async (p) => {
      const tabId = p.tab_id ?? (await defaultTabId(p.session_id));
      const r = await page(tabId, { op: 'network', since: p.since, limit: p.limit, maxTextChars: p.max_text_chars });
      return { tab_id: tabId, entries: r.entries, next_since: r.nextSince, truncated: r.truncated };
    },

    // The daemon inlines each file's bytes as `data_base64` for Safari (the
    // sandboxed extension cannot read `staged_path`) — see NOTES.md. A daemon
    // without that patch sends only the path, which we cannot use.
    'tool.upload': async (p) => {
      const tabId = p.tab_id ?? (await defaultTabId(p.session_id));
      const files = p.files || [];
      if (files.some((f) => typeof f.data_base64 !== 'string')) {
        throw { code: 'unsupported', message: 'tool.upload needs the Safari-aware bsk daemon (it inlines file bytes); this daemon sent only a file path, which Safari cannot read' };
      }
      const r = await page(tabId, { op: 'upload', ref: p.ref, selector: p.selector, mode: p.mode, files: files.map((f) => ({ name: f.name, dataBase64: f.data_base64 })) });
      return withDialogs({ tab_id: tabId, used_ref: r.usedRef, used_selector: r.usedSelector, file_names: r.fileNames });
    },

    'tool.hover': async (p) => {
      const tabId = p.tab_id ?? (await defaultTabId(p.session_id));
      const r = await page(tabId, { op: 'hover', ref: p.ref, selector: p.selector, modifiers: p.modifiers, settleMs: p.settle_ms });
      return withDialogs({ tab_id: tabId, used_ref: r.usedRef, used_selector: r.usedSelector, x: r.x, y: r.y });
    },

    'tool.get_html': async (p) => {
      const tabId = p.tab_id ?? (await defaultTabId(p.session_id));
      const r = await page(tabId, { op: 'getHtml', ref: p.ref, selector: p.selector, maxBytes: p.max_bytes });
      return withDialogs({ html: r.html, truncated: r.truncated, byte_size: r.byteSize, tab_id: tabId });
    },

    'tool.select': async (p) => {
      const tabId = p.tab_id ?? (await defaultTabId(p.session_id));
      const r = await page(tabId, { op: 'select', ref: p.ref, selector: p.selector, values: p.values });
      return withDialogs({ tab_id: tabId, used_ref: r.usedRef, used_selector: r.usedSelector, multiple: r.multiple, selected_values: r.selectedValues, selected_labels: r.selectedLabels });
    },

    'tool.focus': async (p) => {
      const tabId = p.tab_id ?? (await defaultTabId(p.session_id));
      const r = await page(tabId, { op: 'focus', ref: p.ref, selector: p.selector });
      return withDialogs({ tab_id: tabId, used_ref: r.usedRef, used_selector: r.usedSelector, focused: r.focused });
    },

    'tool.blur': async (p) => {
      const tabId = p.tab_id ?? (await defaultTabId(p.session_id));
      const r = await page(tabId, { op: 'blur', ref: p.ref, selector: p.selector });
      return withDialogs({ tab_id: tabId, used_ref: r.usedRef, used_selector: r.usedSelector, was_focused: r.wasFocused, focused: r.focused });
    },

    'tool.wheel': async (p) => {
      const tabId = p.tab_id ?? (await defaultTabId(p.session_id));
      const r = await page(tabId, { op: 'wheel', ref: p.ref, selector: p.selector, deltaX: p.delta_x, deltaY: p.delta_y, modifiers: p.modifiers });
      return withDialogs({ tab_id: tabId, used_ref: r.usedRef, used_selector: r.usedSelector, x: r.x, y: r.y, delta_x: r.deltaX, delta_y: r.deltaY });
    },

    // Safari's tab API only reports loading/complete, so every phase after
    // `commit` is "tab status is complete". `networkidle` adds a fixed
    // quiet period because there are no network events to watch.
    // ponytail: approximates networkidle; real idle detection would need the
    // (unavailable) network layer. Also: a call made *before* a navigation
    // has started sees the old page's 'complete' and returns at once.
    'tool.wait_for_navigation': async (p) => {
      const tabId = p.tab_id ?? (await defaultTabId(p.session_id));
      const want = p.wait_until || 'load';
      const deadline = Date.now() + (p.timeout_ms || 30000);
      const live = () => browser.tabs.get(tabId).catch(() => null);
      let tab = await live();
      const done = () => want === 'commit' || tab.status === 'complete';
      while (tab && !done() && Date.now() < deadline) { await sleep(250); tab = await live(); }
      if (!tab) throw { code: 'not_found', message: `tab ${tabId} was closed while waiting` };
      if (done() && want === 'networkidle') await sleep(500);
      return withDialogs({ tab_id: tabId, reached: done() ? want : 'timeout' });
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
      // Combine explicit `params.modifiers` with any modifier *name* in the
      // key string: 'Control+a' -> ['Control'] + KeyA, and even a bare
      // 'Control' (keyToCode's fallback keeps the name) yields ['Control'].
      const mods = [...new Set([
        ...(p.modifiers || []),
        ...MODIFIER_NAMES.filter((m) => m === p.key || p.key.includes(`+${m}+`) || p.key.endsWith(`+${m}`) || p.key.endsWith(`+${m}+`)),
      ])];
      const r = await page(tabId, { op: 'press', ref: p.ref, selector: p.selector, key: p.key, code: keyToCode(p.key), modifiers: mods });
      return withDialogs({ tab_id: tabId, key: p.key, code: keyToCode(p.key), modifiers: mods, used_ref: r.usedRef, used_selector: r.usedSelector });
    },

    'tool.scroll_to': async (p) => {
      const tabId = p.tab_id ?? (await defaultTabId(p.session_id));
      const r = await page(tabId, { op: 'scrollTo', ref: p.ref, selector: p.selector });
      return withDialogs({ tab_id: tabId, used_ref: r.usedRef, used_selector: r.usedSelector, x: r.x, y: r.y, width: r.width, height: r.height });
    },

    // Viewport by default; with a ref/selector the element is scrolled into
    // view and the capture is cropped to it (clamped to what is visible).
    'tool.screenshot': async (p) => {
      const tabId = p.tab_id ?? (await defaultTabId(p.session_id));
      await activateTab(tabId);
      const rect = p.ref || p.selector ? await page(tabId, { op: 'rect', ref: p.ref, selector: p.selector }) : null;
      const dataUrl = await capturePng(tabId);
      if (rect) {
        const k = rect.dpr || 1;
        const c = await imaging.crop(dataUrl, { x: rect.x * k, y: rect.y * k, width: rect.width * k, height: rect.height * k });
        return withDialogs({ image_base64: c.base64, width: c.width, height: c.height, format: 'png', tab_id: tabId });
      }
      const dims = await page(tabId, { op: 'viewportSize' }).catch(() => ({ width: 0, height: 0 }));
      return withDialogs({ image_base64: dataUrl.slice('data:image/png;base64,'.length), width: dims.width, height: dims.height, format: 'png', tab_id: tabId });
    },

    // Scroll top to bottom, capture each viewport, stitch on a canvas. Limits:
    // fixed/sticky elements repeat in every frame, and a page taller than
    // MAX_DEVICE_HEIGHT device pixels is scaled down to fit (never cut off).
    'tool.screenshot_full_page': async (p) => {
      const tabId = p.tab_id ?? (await defaultTabId(p.session_id));
      const follow = p.scope !== 'current';
      const deadline = Date.now() + (p.timeout_ms || 120000);
      await activateTab(tabId);
      const m = await page(tabId, { op: 'scrollMetrics' });
      const dpr = m.dpr || 1;
      let height = m.height;
      const frames = [];
      let want = 0, lastY = -1;
      for (let n = 0; n < 200; n++) {
        const s = await page(tabId, { op: 'scrollToY', y: want });
        if (follow) height = Math.max(height, s.height);
        if (s.y === lastY) break; // clamped at the bottom: no progress
        lastY = s.y;
        await sleep(250); // lazy content / sticky headers settle
        frames.push({ dataUrl: await capturePng(tabId), y: Math.round(s.y * dpr) });
        if (s.y + m.vh >= height) break;
        if (Date.now() > deadline) throw { code: 'timeout', message: 'full-page capture timed out' };
        want = s.y + m.vh;
      }
      await page(tabId, { op: 'scrollToY', y: m.y }).catch(() => {}); // put the page back
      const deviceH = Math.round(height * dpr);
      const scale = deviceH > MAX_DEVICE_HEIGHT ? MAX_DEVICE_HEIGHT / deviceH : 1;
      const out = await imaging.stitch(frames, Math.round(m.vw * dpr * scale), Math.round(deviceH * scale), scale);
      const id = `cap_${crypto.randomUUID()}`;
      captures.set(id, { sessionId: p.session_id, bytes: out.bytes });
      while (captures.size > 5) captures.delete(captures.keys().next().value); // oldest out
      return withDialogs({ scope: follow ? 'follow' : 'current', capture_id: id, width: out.width, height: out.height, format: 'png', tab_id: tabId, byte_size: out.bytes.length });
    },

    'tool.screenshot_read': async (p) => {
      const c = captures.get(p.capture_id);
      if (!c || c.sessionId !== p.session_id) throw { code: 'not_found', message: 'unknown capture_id (released, evicted, or from another session)' };
      const start = Math.min(p.offset || 0, c.bytes.length);
      const end = Math.min(start + READ_CHUNK_BYTES, c.bytes.length);
      return { data_base64: toBase64(c.bytes.subarray(start, end)), next_offset: end, eof: end >= c.bytes.length };
    },

    'tool.screenshot_release': async (p) => {
      const c = captures.get(p.capture_id);
      const owned = !!c && c.sessionId === p.session_id;
      if (owned) captures.delete(p.capture_id);
      return { released: owned };
    },

    'tool.reload': async (p) => {
      const tabId = p.tab_id ?? (await defaultTabId(p.session_id));
      const before = await browser.tabs.get(tabId);
      await browser.tabs.reload(tabId, { bypassCache: !!p.hard });
      const r = await afterNavAction(tabId, before, { want: p.wait_until, timeoutMs: p.timeout_ms });
      return withDialogs({ tab_id: tabId, previous_url: before.url, ...r });
    },

    'tool.navigate_back': async (p) => {
      const tabId = p.tab_id ?? (await defaultTabId(p.session_id));
      const before = await browser.tabs.get(tabId);
      await historyGo(tabId, -1);
      const r = await afterNavAction(tabId, before, { want: p.wait_until, timeoutMs: p.timeout_ms, expectChange: true });
      return withDialogs({ tab_id: tabId, previous_url: before.url, ...r });
    },

    'tool.navigate_forward': async (p) => {
      const tabId = p.tab_id ?? (await defaultTabId(p.session_id));
      const before = await browser.tabs.get(tabId);
      await historyGo(tabId, 1);
      const r = await afterNavAction(tabId, before, { want: p.wait_until, timeoutMs: p.timeout_ms, expectChange: true });
      return withDialogs({ tab_id: tabId, previous_url: before.url, ...r });
    },

    'tool.window_resize': async (p) => {
      const s = requireSession(p);
      await browser.windows.update(s.agentWindowId, { width: p.width, height: p.height });
      const w = await browser.windows.get(s.agentWindowId);
      return { window_id: w.id, width: w.width, height: w.height };
    },
  };

  async function dispatch(method, params) {
    const handler = tools[method];
    if (!handler) throw { code: 'unsupported', message: `${method} is not implemented in the Safari extension` };
    return handler(params);
  }

  function wsConnected() {
    // Readiness probe only — the popup's status line uses this.
    return !!(ws && ws.readyState === 1);
  }

  function activeSessionId() {
    // Newest session first: sessions are only added/removed by
    // session_start/session_stop, so insertion order = start order.
    for (const id of [...sessions.keys()].reverse()) if (sessions.get(id)) return id;
    return null;
  }

  function status() {
    return { connected: wsConnected(), activeSession: activeSessionId(), tabCount: [...sessions.values()].reduce((n, s) => n + s.agentTabIds.size, 0) };
  }

  browser.runtime.onMessage.addListener((msg, sender) => {
    // Safari exposes browser.runtime.sendMessage to page-world scripts, so a
    // web page can reach this listener. Only our own extension pages
    // (confirm.html, popup.html) may drive it.
    if (!String(sender?.url || '').startsWith(browser.runtime.getURL(''))) return;
    if (msg?.type === 'borrow-confirm-result') {
      const finish = pendingConfirmations.get(msg.requestId);
      if (finish) finish(!!msg.allow);
    }
    // The toolbar popup (browser_action.default_popup) is a *page action*
    // popup: its own chrome-untrusted origin, with no DOM access to this
    // page, so the read-only status line is answered over runtime
    // messaging. Kept read-only on purpose — see popup.html.
    if (msg?.type === 'bsk-status-request') return Promise.resolve(status());
  });

  return { connect, dispatch, sessions, status };
}

if (typeof module !== 'undefined') {
  module.exports = { makeBackground };
} else {
  makeBackground({ browser, WebSocket, console, crypto, navigator, document, setTimeout, clearTimeout, setInterval, clearInterval }).connect();
}
