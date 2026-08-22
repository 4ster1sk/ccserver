// GET /api/session-limit-reset: the scheduler panel's passive lookup for the
// last-known Claude Code session-limit reset time. Does not cover GET
// /api/usage itself -- that route spawns claude to capture the /usage
// dashboard, which isn't something a unit test should trigger.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { usageRoute } from './usage.js';
import { recordSessionLimitReset } from '../sessionLimitState.js';

let app;

before(async () => {
  app = Fastify();
  await app.register(usageRoute, { prefix: '/api' });
});

after(async () => {
  try { await app.close(); } catch { /* ignore */ }
});

test('GET /api/session-limit-reset: {resetAtMs: null} when the latest recorded value is stale', async () => {
  // Forcing a past value (rather than relying on the module's untouched
  // null state) keeps this deterministic regardless of what ran earlier --
  // the "nothing ever recorded" case itself is covered by
  // sessionLimitState.test.js.
  recordSessionLimitReset({ resetAtMs: Date.now() - 1000, source: 'session-output' });
  const res = await app.inject({ method: 'GET', url: '/api/session-limit-reset' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { resetAtMs: null });
});

test('GET /api/session-limit-reset: returns the latest recorded future reset', async () => {
  const resetAtMs = Date.now() + 60_000;
  recordSessionLimitReset({ resetAtMs, timeZone: 'Asia/Tokyo', source: 'session-output' });
  const res = await app.inject({ method: 'GET', url: '/api/session-limit-reset' });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.resetAtMs, resetAtMs);
  assert.equal(body.timeZone, 'Asia/Tokyo');
  assert.equal(body.source, 'session-output');
  assert.equal(typeof body.updatedAt, 'number');
});
