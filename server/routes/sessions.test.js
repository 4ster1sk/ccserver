// POST /api/sessions validation (the shared createSessionViaApi body). Only
// the paths that fail BEFORE a pty spawn are exercised here -- spawning real
// agent CLIs is exactly what these tests must never do. The happy path's
// spawn behavior belongs to sessionManager tests / e2e.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sessionsRoute, createSessionViaApi } from './sessions.js';

let tmpRoot;
let app;

before(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'ccserver-sessions-route-'));
  app = Fastify();
  await app.register(sessionsRoute, { prefix: '/api' });
});

after(async () => {
  try { await app.close(); } catch { /* ignore */ }
  rmSync(tmpRoot, { recursive: true, force: true });
});

test('POST /sessions rejects invalid bodies with 400 before touching a pty', async () => {
  for (const body of [
    {},                                     // no cwd
    { cwd: '' },
    { cwd: 42 },
    { cwd: '/definitely/not/a/real/dir', app: 'claude' }, // nonexistent dir
    { cwd: '/', shell: false, app: 'claude' },            // root refusal (createSession)
    { cwd: tmpRoot, app: 'not-an-app' },
    { cwd: tmpRoot, sandboxOpts: 'gpg please' },
  ]) {
    const res = await app.inject({ method: 'POST', url: '/api/sessions', payload: body });
    assert.equal(res.statusCode, 400, JSON.stringify(body));
    assert.ok(res.json().error);
  }
});

test('createSessionViaApi returns result objects, not HTTP replies', async () => {
  const bad = await createSessionViaApi({});
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'validation');

  const badApp = await createSessionViaApi({ cwd: tmpRoot, app: 'gemini' });
  assert.equal(badApp.ok, false);
});

test('GET /sessions still lists (empty) without any live session', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/sessions' });
  assert.equal(res.statusCode, 200);
  assert.ok(Array.isArray(res.json().sessions));
});
