import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatResets } from './usageResetFormat.js';

test('formatResets: null/undefined -> null', () => {
  assert.equal(formatResets(null), null);
  assert.equal(formatResets(undefined), null);
});

test('formatResets: renders M/D HH:MM in local time, zero-padded', () => {
  const d = new Date(2026, 0, 5, 9, 3); // Jan 5 2026, 09:03 local
  assert.equal(formatResets(d.getTime()), '1/5 09:03');
});
