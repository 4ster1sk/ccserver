import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOsc52Handler } from '../../client/src/osc52.js';

const b64 = (s) => Buffer.from(s, 'utf-8').toString('base64');

test('strips OSC 52 writes and forwards decoded text', () => {
  const writes = [];
  const h = createOsc52Handler({ onWrite: (t) => writes.push(t) });
  const out = h.process(`before\x1b]52;c;${b64('hello world')}\x07after`);
  assert.equal(out, 'beforeafter');
  assert.deepEqual(writes, ['hello world']);
});

test('handles UTF-8 and empty (clear) payloads', () => {
  const writes = [];
  const h = createOsc52Handler({ onWrite: (t) => writes.push(t) });
  assert.equal(h.process(`\x1b]52;c;${b64('日本語テキスト')}\x07`), '');
  assert.deepEqual(writes, ['日本語テキスト']);

  h.process('\x1b]52;c;\x07');
  assert.deepEqual(writes, ['日本語テキスト', '']);
});

test('supports ESC \\ as terminator', () => {
  const writes = [];
  const h = createOsc52Handler({ onWrite: (t) => writes.push(t) });
  const out = h.process(`\x1b]52;c;${b64('x')}\x1b\\`);
  assert.equal(out, '');
  assert.deepEqual(writes, ['x']);
});

test('queries invoke onQuery and are stripped', () => {
  let queried = 0;
  const h = createOsc52Handler({ onWrite: () => {}, onQuery: () => queried++ });
  const out = h.process('\x1b]52;c;?\x07');
  assert.equal(out, '');
  assert.equal(queried, 1);
});

test('non-primary clipboards are ignored but still stripped', () => {
  const writes = [];
  const h = createOsc52Handler({ onWrite: (t) => writes.push(t) });
  const out = h.process(`\x1b]52;p;${b64('primary')}\x07\x1b]52;c;${b64('clip')}\x07`);
  assert.equal(out, '');
  assert.deepEqual(writes, ['clip']);
});

test('other OSC sequences pass through unchanged', () => {
  const h = createOsc52Handler({});
  assert.equal(h.process('\x1b]0;OpenCode\x07'), '\x1b]0;OpenCode\x07');
  assert.equal(h.process('\x1b]12;#eeeeee\x07'), '\x1b]12;#eeeeee\x07');
});

test('sequences split across chunks are held until terminated', () => {
  const writes = [];
  const h = createOsc52Handler({ onWrite: (t) => writes.push(t) });
  assert.equal(h.process('ab\x1b]52;c;'), 'ab');
  assert.equal(h.process(b64('hi')), '');
  assert.equal(h.process('\x07'), '');
  assert.deepEqual(writes, ['hi']);
});

test('invalid base64 does not throw', () => {
  const writes = [];
  const h = createOsc52Handler({ onWrite: (t) => writes.push(t) });
  assert.equal(h.process('\x1b]52;c;%%%notbase64\x07'), '');
  assert.deepEqual(writes, ['']);
});

test('malformed OSC 52 (no second semicolon) passes through', () => {
  const h = createOsc52Handler({});
  assert.equal(h.process('\x1b]52;c\x07'), '\x1b]52;c\x07');
});
