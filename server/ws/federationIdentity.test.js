// Real openssl-backed coverage (skips entirely if openssl is unavailable --
// see opensslAvailable(), matching the plan's decision 4 that federation is
// simply disabled without it rather than a hard test failure).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  federationHomeDir, keyPath, certPath, ensureIdentity, loadIdentity,
  opensslAvailable, keyPermissionsAreSafe, peerCertInfo, _resetIdentityCacheForTests,
} from './federationIdentity.js';

const skip = !opensslAvailable();
let tmpRoot;
const savedHome = process.env.CCSERVER_FEDERATION_HOME;

before(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'ccserver-federation-identity-'));
  process.env.CCSERVER_FEDERATION_HOME = join(tmpRoot, 'federation');
  _resetIdentityCacheForTests();
});

after(() => {
  _resetIdentityCacheForTests();
  if (savedHome === undefined) delete process.env.CCSERVER_FEDERATION_HOME;
  else process.env.CCSERVER_FEDERATION_HOME = savedHome;
  rmSync(tmpRoot, { recursive: true, force: true });
});

test('federationHomeDir honors CCSERVER_FEDERATION_HOME', () => {
  assert.equal(federationHomeDir(), join(tmpRoot, 'federation'));
  assert.equal(keyPath(), join(tmpRoot, 'federation', 'instance.key'));
  assert.equal(certPath(), join(tmpRoot, 'federation', 'instance.crt'));
});

test('ensureIdentity generates a 0600 key and a fingerprint, and is idempotent', { skip }, async () => {
  const id1 = await ensureIdentity();
  assert.match(id1.fingerprint, /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/, 'fingerprint256 is a colon-separated hex string');
  const mode1 = statSync(keyPath()).mode & 0o777;
  assert.equal(mode1, 0o600);

  _resetIdentityCacheForTests();
  const id2 = await ensureIdentity();
  assert.equal(id2.fingerprint, id1.fingerprint, 'a second call must not regenerate the keypair');
  assert.equal(id2.cert, id1.cert);
});

test('ensureIdentity re-asserts 0600 even if the file lost its permissions', { skip }, async () => {
  await ensureIdentity();
  chmodSync(keyPath(), 0o644);
  assert.equal(keyPermissionsAreSafe(), false);
  _resetIdentityCacheForTests();
  await ensureIdentity();
  assert.equal(keyPermissionsAreSafe(), true);
});

test('loadIdentity caches across calls until _resetIdentityCacheForTests', { skip }, async () => {
  await ensureIdentity();
  const a = loadIdentity();
  const b = loadIdentity();
  assert.equal(a, b, 'same object identity -- proves the module-level cache, not just equal content');
});

test('peerCertInfo returns null when getPeerCertificate() has no raw cert', () => {
  assert.equal(peerCertInfo({ getPeerCertificate: () => ({}) }), null);
  assert.equal(peerCertInfo({ getPeerCertificate: () => null }), null);
});
