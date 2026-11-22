// Dev tool (not part of the extension): runs the REAL background.js against a real
// bsk daemon with a fake `browser`, to check wire compatibility without Safari.
// Start a daemon first (isolated: BSK_HOME=/tmp/x bsk daemon start), then:
//   node dev/ext-harness.cjs .        # from the extension directory
// and drive it with the bsk CLI (same BSK_HOME). 'decode result: missing field'
// errors come from the fake page, not the protocol. See NOTES.md.
const path = require('path');
const dir = path.resolve(process.argv[2]);
const { makeBackground } = require(path.join(dir, 'background.js'));

const ORIGIN = 'safari-web-extension://3610fd31-0161-4c6b-919a-ee9a3edb2c19';
class OriginWS extends WebSocket { constructor(u) { super(u, { headers: { Origin: ORIGIN } }); } }

const tabs = new Map(); let nextTab = 100, nextWin = 50;
const log = (...a) => console.log('[harness]', ...a);
const browser = {
  storage: { local: { get: async () => ({}), set: async () => {} } },
  runtime: { getManifest: () => ({ version: '0.1.0' }), getURL: (p) => 'safari-web-extension://3610fd31-0161-4c6b-919a-ee9a3edb2c19/' + p, onMessage: { addListener() {} } },
  windows: {
    create: async (o) => { const id = nextWin++; const t = { id: nextTab++, windowId: id, url: o.url || 'about:blank', status: 'complete', title: 'Fake', index: 0, active: true }; tabs.set(t.id, t); return { id, tabs: [t], width: o.width || 1000, height: o.height || 700 }; },
    update: async () => {}, remove: async () => {}, get: async (id) => ({ id, width: 1000, height: 700 }),
  },
  tabs: {
    create: async (o) => { const t = { id: nextTab++, windowId: o.windowId, url: o.url || 'about:blank', status: 'complete', title: 'Fake Page', index: 0, active: true }; tabs.set(t.id, t); return t; },
    get: async (id) => { const t = tabs.get(id); if (!t) throw new Error('no tab'); return { ...t }; },
    update: async (id, o) => { const t = tabs.get(id); Object.assign(t, o); return { ...t }; },
    remove: async (id) => tabs.delete(id), query: async () => [...tabs.values()], reload: async () => {},
    captureVisibleTab: async () => 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    sendMessage: async (id, msg) => {
      const t = tabs.get(id);
      if (msg.op === 'snapshot') return { ok: true, text: `URL: ${t.url}\nTITLE: Fake\n\nELEMENTS:\n[e1] a "Link" -> /x\n\nPAGE TEXT:\nhello`, refCount: 1, truncated: false };
      if (msg.op === 'viewportSize') return { ok: true, width: 1, height: 1 };
      if (msg.op === 'upload') {
        const crypto = require('crypto');
        const info = msg.files.map((f) => ({ name: f.name, b64len: f.dataBase64.length, sha256: crypto.createHash('sha256').update(Buffer.from(f.dataBase64, 'base64')).digest('hex') }));
        console.log('[harness] UPLOAD RECEIVED', JSON.stringify(info));
        return { ok: true, fileNames: msg.files.map((f) => f.name), usedSelector: msg.selector };
      }
      if (msg.op === 'click') return { ok: true, x: 1, y: 2, usedRef: msg.ref };
      return { ok: true };
    },
  },
};
const bg = makeBackground({ browser, WebSocket: OriginWS, console, crypto: globalThis.crypto, navigator: { userAgent: 'Version/27.3 Safari/605.1.15' }, setTimeout, clearTimeout, setInterval, clearInterval, document: undefined });
bg.connect();
process.on('SIGINT', () => process.exit(0));
