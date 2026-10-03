// REST surface of the host commit signing key, against the host's real
// GnuPG (skipped without it). The passkey (PRF) half needs a real
// authenticator and is covered by commitSigningCrypto's own test plus the
// guards below (passkey mode only, step-up for delete).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commitSigningRoute } from './commitSigning.js';
import { approvalsRoute } from './approvals.js';
import { signingToolsAvailable, deleteSigningKey } from '../commitSigning.js';
import { waitForUnlock, installApprovalGuards } from '../ws/commitSignService.js';
import { listApprovals, _resetWaitersForTests } from '../ws/approvals.js';
import { closeDb } from '../db.js';

const haveGpg = signingToolsAvailable();
const PASS = 'route test passphrase';
let root;
let app;
const saved = {};

before(async () => {
  root = mkdtempSync(join('/tmp', 'ccs-sigroute-'));
  for (const k of ['CCSERVER_DB_PATH', 'CCSERVER_COMMIT_SIGNING_GNUPGHOME', 'CCSERVER_AUTH_MODE']) saved[k] = process.env[k];
  process.env.CCSERVER_DB_PATH = join(root, 'db.sqlite3');
  process.env.CCSERVER_COMMIT_SIGNING_GNUPGHOME = join(root, 'g');
  process.env.CCSERVER_AUTH_MODE = 'none';
  installApprovalGuards();
  app = Fastify();
  await app.register(commitSigningRoute, { prefix: '/api' });
  await app.register(approvalsRoute, { prefix: '/api' });
});

after(async () => {
  await deleteSigningKey();
  _resetWaitersForTests();
  closeDb();
  await app.close();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  rmSync(root, { recursive: true, force: true });
});

const post = (url, payload) => app.inject({ method: 'POST', url, payload });
const get = (url) => app.inject({ method: 'GET', url });

test('status before any key: not configured, no passkeys outside passkey mode', { skip: !haveGpg && 'gpg not installed' }, async () => {
  const r = await get('/api/commit-signing/status');
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().configured, false);
  assert.deepEqual(r.json().passkeys, { available: false, enrolled: 0 });
  assert.equal((await get('/api/commit-signing/public-key')).statusCode, 404);
  assert.equal((await post('/api/commit-signing/unlock', { passphrase: PASS })).statusCode, 404);
});

test('generate: validation, then a locked key; a second generate is refused', { skip: !haveGpg && 'gpg not installed' }, async () => {
  assert.equal((await post('/api/commit-signing/generate', { nameReal: 'A', nameEmail: 'nope', passphrase: PASS })).statusCode, 400);
  assert.equal((await post('/api/commit-signing/generate', { nameReal: 'A', nameEmail: 'a@example.com', passphrase: 'short' })).statusCode, 400);
  const r = await post('/api/commit-signing/generate', { nameReal: 'Route Bot', nameEmail: 'route@example.com', passphrase: PASS });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().key.nameEmail, 'route@example.com');
  assert.ok(!r.body.includes(PASS), 'the passphrase is never echoed');
  assert.equal((await post('/api/commit-signing/generate', { nameReal: 'X', nameEmail: 'x@example.com', passphrase: PASS })).statusCode, 409);
  const st = (await get('/api/commit-signing/status')).json();
  assert.equal(st.configured, true);
  assert.equal(st.unlocked, false);
  assert.match((await get('/api/commit-signing/public-key')).json().publicKeyArmored, /PUBLIC KEY BLOCK/);
});

test('unlock: a wrong passphrase is 401 and leaves it locked; the right one releases waiting commits', { skip: !haveGpg && 'gpg not installed' }, async () => {
  const waiting = waitForUnlock({ cwd: '/srv/proj', app: 'claude' });
  const [pending] = listApprovals().pending.filter((a) => a.kind === 'commit_signing_unlock');
  assert.ok(pending);
  // The banner cannot approve an unlock request without unlocking.
  assert.equal((await post(`/api/approvals/${pending.id}/decision`, { decision: 'approved' })).statusCode, 400);

  const bad = await post('/api/commit-signing/unlock', { passphrase: 'wrong wrong wrong' });
  assert.equal(bad.statusCode, 401);
  assert.equal((await get('/api/commit-signing/status')).json().unlocked, false);

  const ok = await post('/api/commit-signing/unlock', { passphrase: PASS });
  assert.equal(ok.statusCode, 200, ok.body);
  assert.equal(await waiting, true, 'the waiting commit goes ahead');
  assert.equal((await get('/api/commit-signing/status')).json().unlocked, true);
  const row = listApprovals().history.find((a) => a.id === pending.id);
  assert.equal(row.status, 'approved');
  assert.ok(!JSON.stringify(row).includes(PASS), 'the approvals table never sees the passphrase');

  assert.equal((await post('/api/commit-signing/lock', {})).statusCode, 200);
  assert.equal((await get('/api/commit-signing/status')).json().unlocked, false);
});

test('passkey endpoints are passkey-mode only', { skip: !haveGpg && 'gpg not installed' }, async () => {
  for (const url of ['enroll-options', 'enroll-verify', 'unlock-options', 'unlock-verify']) {
    assert.equal((await post(`/api/commit-signing/passkeys/${url}`, {})).statusCode, 400, url);
  }
});

test('delete: needs a fresh step-up in passkey mode, not otherwise', { skip: !haveGpg && 'gpg not installed' }, async () => {
  process.env.CCSERVER_AUTH_MODE = 'passkey';
  try {
    const refused = await post('/api/commit-signing/delete-key', {});
    assert.equal(refused.statusCode, 403);
    assert.equal(refused.json().code, 'STEPUP_REQUIRED');
    assert.equal((await get('/api/commit-signing/status')).json().configured, true);
  } finally {
    process.env.CCSERVER_AUTH_MODE = 'none';
  }
  assert.equal((await post('/api/commit-signing/delete-key', {})).statusCode, 200);
  assert.equal((await get('/api/commit-signing/status')).json().configured, false);
});

test('import rejects junk', { skip: !haveGpg && 'gpg not installed' }, async () => {
  assert.equal((await post('/api/commit-signing/import', {})).statusCode, 400);
  assert.equal((await post('/api/commit-signing/import', { keyArmored: 'not a key' })).statusCode, 400);
  assert.equal((await get('/api/commit-signing/status')).json().configured, false);
});
