import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { handshakeParams, keyToCode, rpcOk, rpcErr, PROTOCOL_VERSION, MIN_COMPATIBLE_PROTOCOL } = require('../protocol.js');

test('handshake params match bsk-cli daemon/state.rs constants', () => {
  const p = handshakeParams({ instanceId: 'i1', extVersion: '0.1.0', browserVersion: '17.4', label: 'Safari' });
  assert.equal(p.protocol_version, '1.3');
  assert.equal(p.protocol_version, PROTOCOL_VERSION);
  assert.equal(p.min_compatible_protocol, MIN_COMPATIBLE_PROTOCOL);
  assert.equal(p.min_compatible_peer, '0.0.0');
  assert.deepEqual(p.browser, { name: 'Safari', version: '17.4' });
  assert.equal(p.instance_id, 'i1');
});

test('keyToCode covers named keys, letters and digits, falls back otherwise', () => {
  assert.equal(keyToCode('Enter'), 'Enter');
  assert.equal(keyToCode('a'), 'KeyA');
  assert.equal(keyToCode('Z'), 'KeyZ');
  assert.equal(keyToCode('5'), 'Digit5');
  assert.equal(keyToCode('F5'), 'F5');
});

test('rpcOk/rpcErr build ResponseFrame-shaped objects', () => {
  assert.deepEqual(rpcOk('id1', { pong: true }), { id: 'id1', result: { pong: true } });
  assert.deepEqual(rpcErr('id2', 'not_found', 'nope'), { id: 'id2', error: { code: 'not_found', message: 'nope' } });
});
