// Unit tests for the lightweight virtual screen model (screenModel.js).
// No MCP SDK / bwrap / agent CLIs needed -- pure module tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createScreenModel } from './screenModel.js';

test('plain text lands on the screen line by line', () => {
  const s = createScreenModel();
  s.feed('hello\r\nworld');
  assert.deepEqual(s.screenRows(), ['hello', 'world']);
});

test('CR overwrites the current line (the spinner pattern)', () => {
  const s = createScreenModel();
  s.feed('⠋ analyzing…');
  const v1 = s.version();
  s.feed('\r⠙ analyzing…');
  assert.ok(s.version() > v1, 'a new frame is a visible change');
  s.feed('\r⠹ analyzing…');
  assert.ok(s.version() > v1);
  assert.deepEqual(s.screenRows(), ['⠹ analyzing…'], 'only the latest frame survives');
});

test('spinner drawn with line erase + fixed cursor leaves a single line', () => {
  const s = createScreenModel();
  s.feed('line 1\n');
  s.feed('\r\x1b[2K⠋ working\r\x1b[2K⠙ working\r\x1b[2K⠹ working');
  assert.deepEqual(s.screenRows(), ['line 1', '⠹ working']);
});

test('line erase modes: K 0 clears cursor-to-EOL, K 2 the whole line', () => {
  const s = createScreenModel();
  s.feed('0123456789\r\n');
  s.feed('\x1b[5G'); // CHA: cursor to column 5 (1-based)
  s.feed('ab');
  assert.deepEqual(s.screenRows(), ['0123456789', '    ab']);
  s.feed('\r\x1b[5G\x1b[K');
  assert.deepEqual(s.screenRows(), ['0123456789', ''], 'K0 erases from the cursor to EOL');
  s.feed('\r\x1b[2K');
  assert.deepEqual(s.screenRows(), ['0123456789', ''], 'K2 erases the whole line');
});

test('cursor positioning: CUP moves the write target, overwriting in place', () => {
  const s = createScreenModel();
  s.feed('row one\r\nrow two\r\nrow three');
  s.feed('\x1b[2;1Hreplaced');
  assert.deepEqual(s.screenRows(), ['row one', 'replaced', 'row three']);
});

test('display erase: ED 2 clears everything; ED 0 clears cursor to screen end', () => {
  const s = createScreenModel();
  s.feed('a\r\nb\r\nc');
  s.feed('\x1b[2J');
  assert.deepEqual(s.screenRows(), ['']);
  s.feed('x\r\ny\r\nz');
  s.feed('\x1b[2;2H\x1b[J'); // cursor at (2,2), erase to end
  assert.deepEqual(s.screenRows(), ['x', 'y']);
});

test('alternate screen: ?1049 h/l toggles the flag without clearing content', () => {
  const s = createScreenModel();
  s.feed('main screen');
  assert.equal(s.altScreenActive(), false);
  s.feed('\x1b[?1049h');
  assert.equal(s.altScreenActive(), true);
  assert.deepEqual(s.screenRows(), ['main screen'], 'content is kept across the switch');
  s.feed('\x1b[?1049l');
  assert.equal(s.altScreenActive(), false);
});

test('scrolling: rows beyond the cap drop the oldest (bounded memory)', () => {
  const s = createScreenModel({ rows: 5 });
  for (let i = 0; i < 20; i++) s.feed(`line ${i}\r\n`);
  assert.equal(s.screenRows().length, 5);
  assert.deepEqual(s.screenRows(), ['line 16', 'line 17', 'line 18', 'line 19', '']);
});

test('line wrap: text wider than the width wraps to the next row', () => {
  const s = createScreenModel({ cols: 8 });
  s.feed('1234567890');
  assert.deepEqual(s.screenRows(), ['12345678', '90']);
});

test('unknown / ignored CSI sequences are dropped harmlessly (SGR, cursor hide, OSC)', () => {
  const s = createScreenModel();
  s.feed('\x1b[31m\x1b[1mred text\x1b[0m');
  s.feed('\x1b[?25l');
  s.feed('\x1b]0;title\x07');
  s.feed(' visible');
  assert.deepEqual(s.screenRows(), ['red text visible']);
});

test('escape sequences split across chunk boundaries are joined correctly', () => {
  const s = createScreenModel();
  const full = 'first\r\x1b[2Kline\r\x1b[31mred\x1b[0m end';
  // Feed one byte at a time -- every sequence boundary is a chunk boundary.
  for (const ch of full) s.feed(ch);
  assert.deepEqual(s.screenRows(), ['red end']);
});

test('OSC split across chunks (BEL terminator in a later chunk)', () => {
  const s = createScreenModel();
  s.feed('before\x1b]0;long ');
  s.feed('title\x07after');
  assert.deepEqual(s.screenRows(), ['beforeafter']);
});

test('UTF-8 multibyte characters split across byte chunks never mojibake', () => {
  const s = createScreenModel();
  const bytes = new TextEncoder().encode('分析中… done');
  // Split at a byte boundary inside the second character ('析' = 3 bytes).
  s.feed(bytes.slice(0, 4));
  s.feed(bytes.slice(4, 8));
  s.feed(bytes.slice(8));
  assert.deepEqual(s.screenRows(), ['分析中… done']);
});

test('version() counts visible changes; cursor-only movement does not', () => {
  const s = createScreenModel();
  s.feed('abc');
  const v = s.version();
  s.feed('\r'); // CR alone: no visible change
  assert.equal(s.version(), v);
  s.feed('\x1b[2C'); // cursor right: no visible change
  assert.equal(s.version(), v);
  s.feed('d'); // a real change
  assert.equal(s.version(), v + 1);
});
