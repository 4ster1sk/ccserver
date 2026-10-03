// Host-side CLIs (login tokens, the commit signing key): runs each
// as a real child process against a throwaway DB, the way an operator would.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDb, closeDb } from '../db.js';
import { hashLoginToken } from '../loginTokens.js';
import { signingToolsAvailable } from '../commitSigning.js';

const CLI_DIR = import.meta.dirname;
let tmpRoot;
let env;
const savedDbPath = process.env.CCSERVER_DB_PATH;
const savedHomeRoot = process.env.CCSERVER_SANDBOX_HOME_ROOT;

before(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'ccserver-cli-test-'));
  process.env.CCSERVER_DB_PATH = join(tmpRoot, 'test.sqlite3');
  process.env.CCSERVER_SANDBOX_HOME_ROOT = join(tmpRoot, 'home');
  env = { ...process.env, CCSERVER_AUTH_MODE: 'passkey', LC_ALL: 'C' };
});

after(() => {
  closeDb();
  if (savedDbPath === undefined) delete process.env.CCSERVER_DB_PATH; else process.env.CCSERVER_DB_PATH = savedDbPath;
  if (savedHomeRoot === undefined) delete process.env.CCSERVER_SANDBOX_HOME_ROOT; else process.env.CCSERVER_SANDBOX_HOME_ROOT = savedHomeRoot;
  rmSync(tmpRoot, { recursive: true, force: true });
});

function runCli(script, args = []) {
  closeDb(); // let the child own the DB file while it runs
  return spawnSync(process.execPath, [join(CLI_DIR, script), ...args], { env, encoding: 'utf8', timeout: 30000 });
}

function tokenFlag(stdout) {
  const token = stdout.split('\n').map((l) => l.trim()).find((l) => /^[A-Za-z0-9_-]{40,}$/.test(l));
  assert.ok(token, `a token is printed: ${stdout}`);
  return getDb().prepare('SELECT allow_passkey_registration FROM login_tokens WHERE token_hash = ?')
    .get(hashLoginToken(token)).allow_passkey_registration;
}

test('issue-login-token: without the flag the token only logs in (security audit F2)', () => {
  const res = runCli('issue-login-token.js');
  assert.equal(res.status, 0, res.stderr);
  assert.equal(tokenFlag(res.stdout), 0);
});

test('issue-login-token --allow-passkey-registration: the token carries the single-use registration grant', () => {
  const res = runCli('issue-login-token.js', ['--allow-passkey-registration']);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(tokenFlag(res.stdout), 1);
  assert.match(res.stdout, /--allow-passkey-registration/);
});

test('issue-login-token rejects unknown arguments (a typo must not silently issue a login-only token)', () => {
  const res = runCli('issue-login-token.js', ['--allow-passkey-registraton']);
  assert.equal(res.status, 2);
});

test('commit-signing-key: status, import of a subkey export, dry-run delete, delete --yes', { skip: !signingToolsAvailable() && 'gpg not installed' }, () => {
  const gnupg = mkdtempSync(join('/tmp', 'ccs-cli-'));
  const master = mkdtempSync(join('/tmp', 'ccs-cli-m-'));
  const signHome = join(gnupg, 'g');
  try {
    env.CCSERVER_COMMIT_SIGNING_GNUPGHOME = signHome;
    const empty = runCli('commit-signing-key.js', ['status']);
    assert.equal(empty.status, 0, empty.stderr);
    assert.match(empty.stdout, /設定されていません/);

    const g = (args) => spawnSync('gpg', ['--homedir', master, '--batch', '--pinentry-mode', 'loopback', '--passphrase', 'cli test pass', ...args], { encoding: 'utf8' });
    g(['--quick-generate-key', 'CLI Test <cli@example.com>', 'ed25519', 'cert', '1y']);
    const fpr = spawnSync('gpg', ['--homedir', master, '--batch', '--with-colons', '--list-keys'], { encoding: 'utf8' })
      .stdout.split('\n').find((l) => l.startsWith('fpr:')).split(':')[9];
    g(['--quick-add-key', fpr, 'ed25519', 'sign', '1y']);
    const keyFile = join(master, 'sub.asc');
    g(['--armor', '--output', keyFile, '--export-secret-subkeys', fpr]);

    const imported = runCli('commit-signing-key.js', ['import', keyFile]);
    assert.equal(imported.status, 0, imported.stderr);
    assert.match(imported.stdout, /CLI Test <cli@example.com>/);
    assert.match(imported.stdout, /サブキー/);

    const pub = runCli('commit-signing-key.js', ['export-public']);
    assert.match(pub.stdout, /BEGIN PGP PUBLIC KEY BLOCK/);

    const dry = runCli('commit-signing-key.js', ['delete']);
    assert.equal(dry.status, 0);
    assert.match(dry.stdout, /--yes/);
    assert.match(runCli('commit-signing-key.js', ['status']).stdout, /ロック中/, 'dry run deletes nothing');

    const real = runCli('commit-signing-key.js', ['delete', '--yes']);
    assert.equal(real.status, 0, real.stderr);
    assert.match(runCli('commit-signing-key.js', ['status']).stdout, /設定されていません/);
  } finally {
    delete env.CCSERVER_COMMIT_SIGNING_GNUPGHOME;
    for (const d of [join(gnupg, 'g'), master]) spawnSync('gpgconf', ['--homedir', d, '--kill', 'all']);
    rmSync(gnupg, { recursive: true, force: true });
    rmSync(master, { recursive: true, force: true });
  }
});

test('commit-signing-key rejects unknown commands and arguments', () => {
  assert.equal(runCli('commit-signing-key.js', ['frobnicate']).status, 2);
  assert.equal(runCli('commit-signing-key.js', ['delete', '--yse']).status, 2);
});
