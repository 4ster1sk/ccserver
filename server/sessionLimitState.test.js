import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recordSessionLimitReset, getLatestSessionLimitReset } from './sessionLimitState.js';

test('getLatestSessionLimitReset: null before anything is recorded', () => {
  assert.equal(getLatestSessionLimitReset(), null);
});

test('recordSessionLimitReset + getLatestSessionLimitReset: round-trips a future value', () => {
  const resetAtMs = Date.now() + 60_000;
  recordSessionLimitReset({ resetAtMs, timeZone: 'Asia/Tokyo', source: 'session-output' });
  const latest = getLatestSessionLimitReset();
  assert.equal(latest.resetAtMs, resetAtMs);
  assert.equal(latest.timeZone, 'Asia/Tokyo');
  assert.equal(latest.source, 'session-output');
  assert.equal(typeof latest.updatedAt, 'number');
});

test('recordSessionLimitReset: a later call overwrites the earlier one', () => {
  recordSessionLimitReset({ resetAtMs: Date.now() + 60_000, source: 'usage' });
  const second = Date.now() + 120_000;
  recordSessionLimitReset({ resetAtMs: second, source: 'session-output' });
  const latest = getLatestSessionLimitReset();
  assert.equal(latest.resetAtMs, second);
  assert.equal(latest.source, 'session-output');
});

test('recordSessionLimitReset: null/undefined timeZone is preserved (server-local, no zone attached)', () => {
  recordSessionLimitReset({ resetAtMs: Date.now() + 60_000, source: 'usage' });
  assert.equal(getLatestSessionLimitReset().timeZone, null);
});

test('recordSessionLimitReset: non-finite resetAtMs is ignored', () => {
  recordSessionLimitReset({ resetAtMs: Date.now() + 60_000, source: 'usage' });
  const before = getLatestSessionLimitReset();
  recordSessionLimitReset({ resetAtMs: NaN, source: 'session-output' });
  recordSessionLimitReset({ resetAtMs: undefined, source: 'session-output' });
  assert.deepEqual(getLatestSessionLimitReset(), before);
});

test('getLatestSessionLimitReset: a past value is filtered out (treated as stale)', () => {
  recordSessionLimitReset({ resetAtMs: Date.now() - 1000, source: 'session-output' });
  assert.equal(getLatestSessionLimitReset(), null);
});
