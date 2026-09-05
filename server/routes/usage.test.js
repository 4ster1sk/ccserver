// GET /api/session-limit-reset: the scheduler panel's passive lookup for the
// last-known Claude Code session-limit reset time. Does not cover GET
// /api/usage itself -- that route spawns claude to capture the /usage
// dashboard, which isn't something a unit test should trigger.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
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

// GET /api/usage?app=opencode with the Go toggle off short-circuits before
// any key read or network fetch -- pinned to a temp config (and a temp,
// keyless XDG_DATA_HOME) so the host's real auth.json can never leak in.
test('GET /api/usage?app=opencode: disabled toggle returns a config error', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccserver-usage-route-'));
  const savedConfig = process.env.CCSERVER_SANDBOX_CONFIG;
  const savedDataHome = process.env.XDG_DATA_HOME;
  const savedAuthContent = process.env.OPENCODE_AUTH_CONTENT;
  const savedGoUsageEnv = process.env.CCSERVER_OPENCODE_GO_USAGE;
  try {
    writeFileSync(join(dir, 'sandbox.config.json'), JSON.stringify({ opencodeGoUsage: false }));
    process.env.CCSERVER_SANDBOX_CONFIG = join(dir, 'sandbox.config.json');
    process.env.XDG_DATA_HOME = join(dir, 'data-home');
    delete process.env.OPENCODE_AUTH_CONTENT;
    delete process.env.CCSERVER_OPENCODE_GO_USAGE;
    const res = await app.inject({ method: 'GET', url: '/api/usage?app=opencode' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.usage, null);
    assert.match(body.error, /disabled by config/);
  } finally {
    if (savedConfig === undefined) delete process.env.CCSERVER_SANDBOX_CONFIG;
    else process.env.CCSERVER_SANDBOX_CONFIG = savedConfig;
    if (savedDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = savedDataHome;
    if (savedAuthContent === undefined) delete process.env.OPENCODE_AUTH_CONTENT;
    else process.env.OPENCODE_AUTH_CONTENT = savedAuthContent;
    if (savedGoUsageEnv === undefined) delete process.env.CCSERVER_OPENCODE_GO_USAGE;
    else process.env.CCSERVER_OPENCODE_GO_USAGE = savedGoUsageEnv;
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
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
