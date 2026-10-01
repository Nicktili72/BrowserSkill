import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { keyToCode, keyToModifiers } = require('../protocol.js');

test('keyToCode strips modifier prefixes down to a real DOM code', () => {
  assert.equal(keyToCode('Control+a'), 'KeyA');
  assert.equal(keyToCode('Shift+Tab'), 'Tab');
  assert.equal(keyToCode('Alt+Meta+F5'), 'F5');
  assert.equal(keyToCode('Control'), 'ControlLeft'); // a bare modifier is a key too
});

test('keyToModifiers extracts the prefix list from a combo', () => {
  assert.deepEqual(keyToModifiers('Control+a'), ['Control']);
  assert.deepEqual(keyToModifiers('Alt+Shift+F5'), ['Alt', 'Shift']);
  assert.deepEqual(keyToModifiers('Enter'), []);
});
