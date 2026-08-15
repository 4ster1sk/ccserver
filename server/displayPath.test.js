import { test } from 'node:test';
import assert from 'node:assert/strict';
import { displayPath } from '../client/src/displayPath.js';

const HOME = '/home/u';

test('displayPath: $HOME itself becomes ~', () => {
  assert.equal(displayPath(HOME, HOME), '~');
});

test('displayPath: path under $HOME becomes ~ + remainder', () => {
  assert.equal(displayPath('/home/u/foo', HOME), '~/foo');
  assert.equal(displayPath('/home/u/foo/bar', HOME), '~/foo/bar');
});

test('displayPath: string-prefix semantics (home + "/" prefix replaces)', () => {
  // The check is against home + "/", so a sibling dir (/home/u2) does NOT
  // match /home/u even though it shares the bare string prefix.
  assert.equal(displayPath('/home/u2/foo', HOME), '/home/u2/foo');
  assert.equal(displayPath('/home/u/foo', '/home/'), '~/u/foo');
});

test('displayPath: outside $HOME is returned unchanged', () => {
  assert.equal(displayPath('/tmp/x', HOME), '/tmp/x');
  assert.equal(displayPath('/home', HOME), '/home');
});

test('displayPath: trailing slash on $HOME is tolerated', () => {
  assert.equal(displayPath('/home/u/foo', '/home/u/'), '~/foo');
  // A bare home without its trailing slash does not prefix-match: per the
  // spec, "/home/u" === home + "/" would need the path to have the slash.
  assert.equal(displayPath('/home/u', '/home/u/'), '/home/u');
});

test('displayPath: empty and falsy inputs', () => {
  assert.equal(displayPath('', HOME), '');
  assert.equal(displayPath(null, HOME), '');
  assert.equal(displayPath(undefined, HOME), '');
});

test('displayPath: missing home returns the path unchanged', () => {
  assert.equal(displayPath('/home/u/foo', null), '/home/u/foo');
  assert.equal(displayPath('/home/u/foo', ''), '/home/u/foo');
  assert.equal(displayPath('/home/u/foo', undefined), '/home/u/foo');
});

test('displayPath: windows-style paths are not transformed', () => {
  assert.equal(displayPath('C:\\Users\\u\\foo', 'C:\\Users\\u'), 'C:\\Users\\u\\foo');
  assert.equal(displayPath('D:\\data', 'C:\\Users\\u'), 'D:\\data');
});

test('displayPath: / as $HOME', () => {
  // "/" === home -> "~". For other paths the trailing-slash normalization
  // turns home into "", so everything prefix-matches (spec quirk; homedir()
  // never returns "/" in practice).
  assert.equal(displayPath('/', '/'), '~');
  assert.equal(displayPath('/foo', '/'), '~/foo');
});
