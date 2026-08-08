import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOutputTransform } from './outputTransform.js';

const SYNC_BEGIN = '\x1b[?2026h';
const SYNC_END = '\x1b[?2026l';

// A fake clock that starts at a fixed epoch; tests advance it manually so the
// coalescing window behaves deterministically.
function fakeClock(initial = 1_000_000) {
  let t = initial;
  return {
    now: () => t,
    advance: (ms) => { t += ms; },
  };
}

// Build a "whole-screen" frame repainting `rows` distinct rows (here 12 of a
// 24-row pty) with per-cell cursor positioning, wrapped in sync markers.
function fullFrame(rows = 12) {
  let s = SYNC_BEGIN;
  for (let r = 1; r <= rows; r++) s += `\x1b[${r};1H\x1b[31mcontent`;
  s += SYNC_END;
  return s;
}

function partialFrame() {
  return `${SYNC_BEGIN}\x1b[25;4H\x1b[31mx${SYNC_END}`;
}

test('returns null for apps that need no rewriting', () => {
  assert.equal(createOutputTransform('claude'), null);
  assert.equal(createOutputTransform('shell'), null);
  assert.equal(createOutputTransform(undefined), null);
  assert.ok(createOutputTransform('opencode'));
});

test('removes alternate-screen enter/leave sequences', () => {
  const t = createOutputTransform('opencode');
  assert.equal(t.transform('\x1b[?1049h'), '');
  assert.equal(t.transform('\x1b[?1049l'), '');
  assert.equal(t.transform('a\x1b[?1049hb'), 'ab');
  assert.equal(t.transform('\x1b[?1049h\x1b[?1049l'), '');
});

test('passes cursor-home and cursor positioning through untouched', () => {
  const t = createOutputTransform('opencode');
  assert.equal(t.transform('\x1b[H'), '\x1b[H');
  assert.equal(t.transform('\x1b[1;1H'), '\x1b[1;1H');
  assert.equal(t.transform('\x1b[12;34H'), '\x1b[12;34H');
});

test('leaves non-target sequences and plain text untouched', () => {
  const t = createOutputTransform('opencode');
  assert.equal(t.transform('hello'), 'hello');
  assert.equal(t.transform('\x1b[31mred\x1b[0m'), '\x1b[31mred\x1b[0m');
  assert.equal(t.transform('\x1b[?25l\x1b[?2026h\x1b[?2026l\x1b[?25h'), '\x1b[?25l' + SYNC_BEGIN + SYNC_END + '\x1b[?25h');
  assert.equal(t.transform('\x1b[2J\x1b[H'), '\x1b[2J\x1b[H'); // clears pass through
  assert.equal(t.transform('\x1b]0;title\x07'), '\x1b]0;title\x07'); // OSC untouched
});

test('first full frame does not push (screen was blank)', () => {
  const clock = fakeClock();
  const t = createOutputTransform('opencode', 24, { now: clock.now });
  const out = t.transform(fullFrame());
  assert.equal(out, fullFrame()); // unchanged: no scrollback push
});

test('full frame after a full frame pushes the previous screen into scrollback', () => {
  const clock = fakeClock();
  const t = createOutputTransform('opencode', 24, { now: clock.now });
  t.transform(fullFrame()); // screen painted
  clock.advance(3000);      // outside the coalescing window
  const out = t.transform(fullFrame());
  // Jump to row 24, then 24 line feeds, then the new frame.
  assert.equal(out, '\x1b[24;1H' + '\n'.repeat(24) + fullFrame());
});

test('pushes are coalesced: rapid full frames do not each push', () => {
  const clock = fakeClock();
  const t = createOutputTransform('opencode', 24, { now: clock.now });
  t.transform(fullFrame()); // screen painted
  clock.advance(500);       // inside the window since creation
  assert.equal(t.transform(fullFrame()), fullFrame()); // no push yet
  clock.advance(1600);      // now 2.1s since the screen was painted
  const push = '\x1b[24;1H' + '\n'.repeat(24);
  assert.equal(t.transform(fullFrame()), push + fullFrame()); // first push
  clock.advance(1000);      // inside the 2s window since the push
  assert.equal(t.transform(fullFrame()), fullFrame()); // coalesced
  clock.advance(1200);      // >2s since the push
  assert.equal(t.transform(fullFrame()), push + fullFrame());
});

test('partial frames pass through immediately and never push', () => {
  const clock = fakeClock();
  const t = createOutputTransform('opencode', 24, { now: clock.now });
  t.transform(fullFrame()); // screen painted
  clock.advance(3000);
  assert.equal(t.transform(partialFrame()), partialFrame()); // untouched
  clock.advance(1000);
  assert.equal(t.transform(partialFrame()), partialFrame());
});

test('a full frame after only partial frames does not push (no previous screen)', () => {
  const clock = fakeClock();
  const t = createOutputTransform('opencode', 24, { now: clock.now });
  t.transform(partialFrame()); // only a cursor cell painted
  clock.advance(3000);
  assert.equal(t.transform(fullFrame()), fullFrame());
});

test('rows update via setRows (window resize)', () => {
  const clock = fakeClock();
  const t = createOutputTransform('opencode', 24, { now: clock.now });
  t.transform(fullFrame());
  t.setRows(40);
  clock.advance(3000);
  // Push uses the new row count.
  assert.equal(t.transform(fullFrame()), '\x1b[40;1H' + '\n'.repeat(40) + fullFrame());
});

test('alternate-screen markers inside a frame are dropped too', () => {
  const t = createOutputTransform('opencode');
  const out = t.transform(SYNC_BEGIN + '\x1b[?1049h' + 'x' + '\x1b[?1049l' + SYNC_END);
  assert.equal(out, SYNC_BEGIN + 'x' + SYNC_END);
});

test('frame-size threshold adapts to pty rows', () => {
  const clock = fakeClock();
  const t = createOutputTransform('opencode', 30, { now: clock.now });
  // A 9-row frame: conversation-level redraw in a 30-row terminal.
  let frame = SYNC_BEGIN;
  for (let r = 1; r <= 9; r++) frame += `\x1b[${r};1H\x1b[31mcontent`;
  frame += SYNC_END;
  t.transform(frame); // screen painted
  clock.advance(3000);
  assert.equal(t.transform(frame), '\x1b[30;1H' + '\n'.repeat(30) + frame);
});

test('frames split across chunks are reassembled before the push decision', () => {
  const clock = fakeClock();
  const t = createOutputTransform('opencode', 24, { now: clock.now });
  t.transform(fullFrame());
  clock.advance(3000);
  const frame = fullFrame();
  // Split mid-frame (inside a word), then split the sync-end terminator.
  const terminator = frame.lastIndexOf(SYNC_END);
  const a = t.transform(frame.slice(0, terminator - 3));
  assert.equal(a, ''); // frame content is buffered until it completes
  const b = t.transform(frame.slice(terminator - 3, terminator));
  assert.equal(b, '');
  const c = t.transform('\x1b[?2026'); // prefix of the terminator held back
  assert.equal(c, '');
  const d = t.transform('l'); // completes the frame
  assert.equal(a + b + c + d, '\x1b[24;1H' + '\n'.repeat(24) + frame);
});

test('handles sequences split across chunks', () => {
  const t = createOutputTransform('opencode');
  assert.equal(t.transform('abc\x1b[?10'), 'abc');
  assert.equal(t.transform('49h'), ''); // completes \x1b[?1049h -> removed
  assert.equal(t.transform('\x1b'), '');
  assert.equal(t.transform('[?2026h'), ''); // frame starts: content is buffered
  assert.equal(t.transform('x'), '');
  assert.equal(t.transform('\x1b[?2026l'), SYNC_BEGIN + 'x' + SYNC_END); // frame completes
});

test('a partial sequence that turns out not to be a target is passed through', () => {
  const t = createOutputTransform('opencode');
  assert.equal(t.transform('a\x1b[42m'), 'a\x1b[42m'); // complete SGR, not a prefix
  assert.equal(t.transform('\x1b[?10'), ''); // held back (prefix of ?1049)
  assert.equal(t.transform('0x'), '\x1b[?100x'); // not a target after all
});

test('flush emits any held-back bytes', () => {
  const t = createOutputTransform('opencode');
  assert.equal(t.transform('abc\x1b'), 'abc');
  assert.equal(t.flush(), '\x1b');
});

test('mixed content in one chunk', () => {
  const t = createOutputTransform('opencode');
  const out = t.transform('\x1b[?1049h' + SYNC_BEGIN + 'frame' + SYNC_END + '\x1b[?1049l');
  assert.equal(out, SYNC_BEGIN + 'frame' + SYNC_END);
});

test('oversized frames pass through raw without pushing', () => {
  const clock = fakeClock();
  const t = createOutputTransform('opencode', 24, { now: clock.now });
  t.transform(fullFrame());
  clock.advance(3000);
  // A giant frame exceeds MAX_FRAME_BYTES mid-collection.
  const big = SYNC_BEGIN + 'x'.repeat(70 * 1024) + '\x1b[1;1H\x1b[31mz' + SYNC_END;
  const out = t.transform(big);
  assert.equal(out, big); // untouched, no push
  clock.advance(3000);
  // The capped frame still painted the screen, so the next full frame pushes it.
  assert.equal(t.transform(fullFrame()), '\x1b[24;1H' + '\n'.repeat(24) + fullFrame());
});
