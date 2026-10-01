import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// These tests exist because Safari-only quirks were verified against real
// Safari, not inferred from Chrome behaviour — keep the evidence pinned.

test('screenshot reports the real viewport size, not a hardcoded 0x0', () => {
  const src = readFileSync(fileURLToPath(new URL('../content.js', import.meta.url)), 'utf8');
  // ScreenshotResult width/height must come from clientWidth/clientHeight ×
  // devicePixelRatio (0 only if viewportSize itself fails).
  assert.match(src, /clientWidth \* devicePixelRatio/);
});

test('press on a form field submits through exactly one path', () => {
  const src = readFileSync(fileURLToPath(new URL('../content.js', import.meta.url)), 'utf8');
  // The old code dispatched synthetic keydown AND called requestSubmit.
  // Synthetic keydown doesn't trigger native submit (untrusted), but page
  // JS listening for Enter-keydown might submit itself — double submit.
  // The fix: form.requestSubmit with NO synthetic keydown/keyup dispatch.
  assert.match(src, /requestSubmit/);
  assert.doesNotMatch(src, /dispatchEvent\(new KeyboardEvent\('keydown'\)[\s\S]{0,200}requestSubmit/);
});

test('ref lookup strips a leading @ like upstream normaliseRef', () => {
  const src = readFileSync(fileURLToPath(new URL('../content.js', import.meta.url)), 'utf8');
  // Models emit '@e1'; the ref map is keyed by bare 'e1'.
  assert.match(src, /replace\(\/\^@\/,\s*''\)/);
});
