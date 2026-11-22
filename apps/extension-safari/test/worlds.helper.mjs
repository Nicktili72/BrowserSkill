// Shared by evalconsole.test.mjs and network.test.mjs: runs hook.js (page
// world) and content.js (isolated world) in two vm contexts that only share
// an event bus — the same isolation as the real two worlds.
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { bskMain } = require('../hook.js');
const contentSrc = readFileSync(fileURLToPath(new URL('../content.js', import.meta.url)), 'utf8');

export const plain = (x) => JSON.parse(JSON.stringify(x));

function makeBus() {
  const listeners = new Map();
  return {
    on: (t, f) => { (listeners.get(t) || listeners.set(t, new Set()).get(t)).add(f); },
    off: (t, f) => listeners.get(t)?.delete(f),
    emit: (ev) => { for (const f of [...(listeners.get(ev.type) || [])]) f(ev); return true; },
  };
}
class CustomEv { constructor(type, init = {}) { this.type = type; this.detail = init.detail; } }

export function loadWorlds({ withMain = true, mainGlobals = {} } = {}) {
  const bus = makeBus();
  const shared = { addEventListener: bus.on, removeEventListener: bus.off, dispatchEvent: bus.emit, CustomEvent: CustomEv };
  const logged = [];
  const main = { ...shared, console: { log: (...a) => logged.push(['log', a]), info() {}, warn: (...a) => logged.push(['warn', a]), error() {}, debug() {} }, Node: undefined, ...mainGlobals };
  main.window = main;
  if (withMain) vm.runInNewContext(`(${bskMain.toString()})()`, main);

  let handler;
  const iso = { ...shared, setTimeout, clearTimeout, browser: { runtime: { onMessage: { addListener: (f) => { handler = f; } } } } };
  iso.window = iso;
  vm.runInNewContext(contentSrc, iso);
  return { main, logged, bus, call: (m) => handler(m) };
}

