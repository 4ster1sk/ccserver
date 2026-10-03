// End to end, with nothing faked but the human: a real git commit inside a
// "sandbox" (a plain process with the sandbox's git config) whose gpg.program
// is sandbox-gpg-sign-wrapper.cjs, a real git broker (sign-commit relayed to
// this process over IPC), commitSignService's checks, and the host's real
// GnuPG with a passphrase-protected key. The approval waiter is answered by
// the test the way the unlock route does it.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startGitBroker } from './git-broker.js';
import { createSignHandler } from './commitSignService.js';
import {
  signingToolsAvailable, generateSigningKey, unlockSigningKey, lockSigningKey,
  deleteSigningKey, exportPublicKey,
} from '../commitSigning.js';
import { listSignatures } from '../commitSigningDb.js';
import { closeDb } from '../db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WRAPPER = join(__dirname, 'sandbox-gpg-sign-wrapper.cjs');
const PASS = 'e2e passphrase 123';
const haveGpg = signingToolsAvailable();

let root;
let repo;
let broker;
let key;
let gpgShim;
let pubkeyPath;
let unlockRequests = 0;
let answerUnlock = 'unlock';
const savedEnv = {};

// Async on purpose: the sign handler runs in THIS process, so a blocking
// spawnSync would deadlock the IPC reply it is waiting for.
function sandboxGit(args, extraEnv = {}) {
  return new Promise((resolve) => {
    const child = spawn('git', ['-C', repo, ...args], { env: sandboxEnv(extraEnv) });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

function sandboxEnv(extraEnv) {
  return {
      PATH: process.env.PATH,
      HOME: root,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      // What sandbox.js injects for a signing launch.
      GIT_CONFIG_COUNT: '5',
      GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: key.nameReal,
      GIT_CONFIG_KEY_1: 'user.email', GIT_CONFIG_VALUE_1: key.nameEmail,
      GIT_CONFIG_KEY_2: 'user.signingkey', GIT_CONFIG_VALUE_2: `${key.signingFingerprint}!`,
      GIT_CONFIG_KEY_3: 'commit.gpgsign', GIT_CONFIG_VALUE_3: 'true',
      GIT_CONFIG_KEY_4: 'gpg.program', GIT_CONFIG_VALUE_4: gpgShim,
      CCSANDBOX_GIT_BROKER_SOCK: broker.sockPath,
      CCSANDBOX_GIT_BROKER_TOKEN: broker.token,
      CCSANDBOX_SIGNING_PUBKEY: pubkeyPath,
      ...extraEnv,
  };
}

before(async () => {
  if (!haveGpg) return;
  for (const k of ['CCSERVER_COMMIT_SIGNING_GNUPGHOME']) savedEnv[k] = process.env[k];
  root = mkdtempSync(join('/tmp', 'ccs-e2e-'));
  process.env.CCSERVER_COMMIT_SIGNING_GNUPGHOME = join(root, 'g');
  key = await generateSigningKey({ nameReal: 'Sandbox Bot', nameEmail: 'bot@example.com', passphrase: Buffer.from(PASS) });
  pubkeyPath = join(root, 'pub.asc');
  writeFileSync(pubkeyPath, await exportPublicKey());
  // The sandbox runs the wrapper through its fixed node path; here a shim.
  gpgShim = join(root, 'gpg-sign');
  writeFileSync(gpgShim, `#!/bin/sh\nexec "${process.execPath}" "${WRAPPER}" "$@"\n`, { mode: 0o755 });

  repo = join(root, 'repo');
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { env: { ...process.env, GIT_CONFIG_COUNT: '0' } });

  const handler = createSignHandler({ cwd: repo, app: 'claude', key }, {
    waitForUnlock: async () => {
      unlockRequests++;
      if (answerUnlock !== 'unlock') return false;
      await unlockSigningKey(Buffer.from(PASS));
      return true;
    },
  });
  broker = await startGitBroker({ cwd: repo, app: 'claude', signHandler: handler });
  assert.ok(broker, 'a broker starts for a repo with no remotes when signing is on');
});

after(async () => {
  if (!haveGpg) return;
  try { broker?.proc.kill('SIGTERM'); } catch { /* gone */ }
  try { rmSync(broker.dir, { recursive: true, force: true }); } catch { /* gone */ }
  await deleteSigningKey();
  closeDb();
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  rmSync(root, { recursive: true, force: true });
});

test('a locked key: the commit waits for the unlock, then is signed and verifies', { skip: !haveGpg && 'gpg not installed' }, async () => {
  const r = await sandboxGit(['commit', '--allow-empty', '-m', 'first signed commit']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(unlockRequests, 1, 'the cold key asked for an unlock exactly once');

  const v = await sandboxGit(['verify-commit', 'HEAD']);
  assert.equal(v.status, 0, v.stderr);
  assert.match(v.stderr, /Good signature/);

  const log = listSignatures({ limit: 5 });
  assert.equal(log[0].subject, 'first signed commit');
  assert.equal(log[0].fingerprint, key.signingFingerprint);
});

test('an unlocked key signs straight away; merges are signed too', { skip: !haveGpg && 'gpg not installed' }, async () => {
  const before = unlockRequests;
  assert.equal((await sandboxGit(['checkout', '-q', '-b', 'side'])).status, 0);
  assert.equal((await sandboxGit(['commit', '--allow-empty', '-m', 'side'])).status, 0);
  assert.equal((await sandboxGit(['checkout', '-q', 'main'])).status, 0);
  const m = await sandboxGit(['merge', '--no-ff', '-m', 'merge side', 'side']);
  assert.equal(m.status, 0, m.stderr);
  assert.equal(unlockRequests, before);
  assert.equal((await sandboxGit(['verify-commit', 'HEAD'])).status, 0);
});

test('a commit under someone else\'s identity is refused and not created', { skip: !haveGpg && 'gpg not installed' }, async () => {
  const head = (await sandboxGit(['rev-parse', 'HEAD'])).stdout.trim();
  const r = await sandboxGit(['commit', '--allow-empty', '-m', 'impostor'], { GIT_AUTHOR_NAME: 'Linus', GIT_AUTHOR_EMAIL: 'l@example.com' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /identity-mismatch/);
  assert.equal((await sandboxGit(['rev-parse', 'HEAD'])).stdout.trim(), head, 'no unsigned commit slipped through');
});

test('a backdated commit is refused', { skip: !haveGpg && 'gpg not installed' }, async () => {
  const r = await sandboxGit(['commit', '--allow-empty', '-m', 'old'], { GIT_COMMITTER_DATE: '2001-01-01T00:00:00Z' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /stale-timestamp/);
});

test('tags are not signed', { skip: !haveGpg && 'gpg not installed' }, async () => {
  const r = await sandboxGit(['tag', '-s', '-m', 'v1', 'v1']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /not-a-commit/);
});

test('a wrong token gets nothing signed', { skip: !haveGpg && 'gpg not installed' }, async () => {
  const r = await sandboxGit(['commit', '--allow-empty', '-m', 'x'], { CCSANDBOX_GIT_BROKER_TOKEN: 'nope' });
  assert.notEqual(r.status, 0);
});

test('a key locked again and an unlock that is rejected: the commit fails', { skip: !haveGpg && 'gpg not installed' }, async () => {
  await lockSigningKey();
  answerUnlock = 'reject';
  const r = await sandboxGit(['commit', '--allow-empty', '-m', 'rejected']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /locked/);
});
