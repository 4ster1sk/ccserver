import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  selectSigningKey,
  signingToolsAvailable,
  generateSigningKey,
  importSigningKey,
  getSigningKey,
  getSigningStatus,
  unlockSigningKey,
  lockSigningKey,
  signPayload,
  exportPublicKey,
  deleteSigningKey,
  validateIdentity,
  SigningError,
} from './commitSigning.js';

const NOW = 1_800_000_000;

test('selectSigningKey prefers the newest usable signing subkey', () => {
  const listing = [
    `sec:u:255:22:AAAA:1700000000:${NOW + 1000}::u:::cSC:::#::ed25519:::0:`,
    'fpr:::::::::PRIMARYFPR:',
    'grp:::::::::PRIMARYGRIP:',
    'uid:u::::1700000000::H::Ada Lovelace <ada@example.com>::::::::::0:',
    `ssb:u:255:22:BBBB:1700000001:${NOW + 1000}:::::s:::+::ed25519::`,
    'fpr:::::::::OLDSUBFPR:',
    'grp:::::::::OLDSUBGRIP:',
    `ssb:u:255:22:CCCC:1700000500:${NOW + 1000}:::::s:::+::ed25519::`,
    'fpr:::::::::NEWSUBFPR:',
    'grp:::::::::NEWSUBGRIP:',
    // Expired, and an encryption subkey: both ignored.
    `ssb:e:255:22:DDDD:1700000900:${NOW - 1}:::::s:::+::ed25519::`,
    'fpr:::::::::EXPIREDFPR:',
    'grp:::::::::EXPIREDGRIP:',
    `ssb:u:255:18:EEEE:1700000901:0:::::e:::+::cv25519::`,
    'fpr:::::::::ENCFPR:',
    'grp:::::::::ENCGRIP:',
  ].join('\n');
  const key = selectSigningKey(listing, NOW);
  assert.equal(key.primaryFingerprint, 'PRIMARYFPR');
  assert.equal(key.signingFingerprint, 'NEWSUBFPR');
  assert.equal(key.signingKeygrip, 'NEWSUBGRIP');
  assert.equal(key.nameReal, 'Ada Lovelace');
  assert.equal(key.nameEmail, 'ada@example.com');
  assert.equal(key.usesSubkey, true);
  assert.equal(key.primarySecretPresent, false);
});

test('selectSigningKey: empty listing is "not configured", unusable keys throw', () => {
  assert.equal(selectSigningKey(''), null);
  const stubOnly = [
    'sec:u:255:22:AAAA:1700000000:0::u:::cSC:::#::ed25519:::0:',
    'fpr:::::::::P:', 'grp:::::::::G:',
    'uid:u::::1::H::A <a@x.io>::::::::::0:',
  ].join('\n');
  assert.throws(() => selectSigningKey(stubOnly, NOW), (e) => e.code === 'no-signing-key');
  const two = `${stubOnly}\n${stubOnly}`;
  assert.throws(() => selectSigningKey(two, NOW), (e) => e.code === 'multiple-keys');
  const revoked = stubOnly.replace('sec:u', 'sec:r');
  assert.throws(() => selectSigningKey(revoked, NOW), (e) => e.code === 'key-unusable');
});

test('validateIdentity rejects injection-prone values', () => {
  assert.deepEqual(validateIdentity(' Ada ', 'ada@example.com '), { nameReal: 'Ada', nameEmail: 'ada@example.com' });
  for (const [n, e] of [['A\nB', 'a@b.io'], ['A <x>', 'a@b.io'], ['A', 'not-an-email'], ['', 'a@b.io']]) {
    assert.throws(() => validateIdentity(n, e), SigningError);
  }
});

// The real thing, against the host's GnuPG.
const haveGpg = signingToolsAvailable();
let home;
let saved;

before(() => {
  saved = process.env.CCSERVER_COMMIT_SIGNING_GNUPGHOME;
  // Short path: gpg-agent's socket must fit in sockaddr_un.
  home = mkdtempSync(join('/tmp', 'ccs-sig-'));
  process.env.CCSERVER_COMMIT_SIGNING_GNUPGHOME = join(home, 'g');
});

after(async () => {
  try { await deleteSigningKey(); } catch { /* best effort */ }
  if (saved === undefined) delete process.env.CCSERVER_COMMIT_SIGNING_GNUPGHOME;
  else process.env.CCSERVER_COMMIT_SIGNING_GNUPGHOME = saved;
  rmSync(home, { recursive: true, force: true });
});

const PASS = Buffer.from('correct horse battery');

test('generate -> locked -> unlock -> sign -> lock -> delete', { skip: !haveGpg && 'gpg not installed' }, async () => {
  assert.equal(await getSigningKey(), null);
  assert.equal((await getSigningStatus()).configured, false);

  const key = await generateSigningKey({ nameReal: 'Ada Lovelace', nameEmail: 'ada@example.com', passphrase: Buffer.from(PASS) });
  assert.equal(key.usesSubkey, true);
  assert.equal(key.nameEmail, 'ada@example.com');
  await assert.rejects(
    generateSigningKey({ nameReal: 'X', nameEmail: 'x@example.com', passphrase: Buffer.from(PASS) }),
    (e) => e.code === 'already-configured',
  );

  let status = await getSigningStatus();
  assert.equal(status.configured, true);
  assert.equal(status.needsPassphrase, true);
  assert.equal(status.unlocked, false, 'a fresh key starts locked');

  await assert.rejects(signPayload(Buffer.from('x'), key.signingFingerprint), (e) => e.code === 'locked');
  await assert.rejects(unlockSigningKey(Buffer.from('wrong passphrase')), (e) => e.code === 'wrong-passphrase');
  assert.equal((await getSigningStatus()).unlocked, false, 'a wrong passphrase is not left cached');

  await unlockSigningKey(Buffer.from(PASS));
  status = await getSigningStatus();
  assert.equal(status.unlocked, true);

  const payload = Buffer.from('tree 4b825dc642cb6eb9a060e54bf8d69288fbee4904\n\nmsg\n');
  const signed = await signPayload(payload, key.signingFingerprint);
  assert.match(signed.signature.toString(), /BEGIN PGP SIGNATURE/);
  assert.ok(signed.status.some((l) => l.startsWith('[GNUPG:] SIG_CREATED ')));
  await assert.rejects(signPayload(payload, 'F'.repeat(40)), (e) => e.code === 'key-changed');

  // The signature verifies against the exported public key.
  const pub = await exportPublicKey();
  assert.match(pub, /BEGIN PGP PUBLIC KEY BLOCK/);
  const vhome = mkdtempSync(join('/tmp', 'ccs-ver-'));
  try {
    writeFileSync(join(vhome, 'pub.asc'), pub);
    writeFileSync(join(vhome, 'data'), payload);
    writeFileSync(join(vhome, 'data.asc'), signed.signature);
    execFileSync('gpg', ['--homedir', vhome, '--batch', '--import', join(vhome, 'pub.asc')], { stdio: 'ignore' });
    execFileSync('gpg', ['--homedir', vhome, '--batch', '--verify', join(vhome, 'data.asc'), join(vhome, 'data')], { stdio: 'ignore' });
  } finally {
    try { execFileSync('gpgconf', ['--homedir', vhome, '--kill', 'all'], { stdio: 'ignore' }); } catch { /* ignore */ }
    rmSync(vhome, { recursive: true, force: true });
  }

  await lockSigningKey();
  assert.equal((await getSigningStatus()).unlocked, false);
  await assert.rejects(signPayload(payload, key.signingFingerprint), (e) => e.code === 'locked');

  await deleteSigningKey();
  assert.equal(await getSigningKey(), null);
});

test('import accepts a --export-secret-subkeys export and rejects public-only data', { skip: !haveGpg && 'gpg not installed' }, async () => {
  // Make a "master" key somewhere else and export only its signing subkey.
  const master = mkdtempSync(join('/tmp', 'ccs-mst-'));
  try {
    const g = (args, input) => execFileSync('gpg', ['--homedir', master, '--batch', '--pinentry-mode', 'loopback', '--passphrase', PASS.toString(), ...args], { input, stdio: ['pipe', 'pipe', 'ignore'] });
    g(['--quick-generate-key', 'Grace Hopper <grace@example.com>', 'ed25519', 'cert', '1y']);
    const fpr = execFileSync('gpg', ['--homedir', master, '--batch', '--with-colons', '--list-keys'], { encoding: 'utf8' })
      .split('\n').find((l) => l.startsWith('fpr:')).split(':')[9];
    g(['--quick-add-key', fpr, 'ed25519', 'sign', '1y']);
    const subkeys = g(['--armor', '--export-secret-subkeys', fpr]);
    const publicOnly = g(['--armor', '--export', fpr]);

    await assert.rejects(importSigningKey(publicOnly), (e) => e.code === 'bad-key');
    assert.equal(await getSigningKey(), null, 'a failed import leaves nothing behind');

    const key = await importSigningKey(subkeys);
    assert.equal(key.primaryFingerprint, fpr);
    assert.equal(key.primarySecretPresent, false, 'only the subkey secret came over');
    assert.equal(key.nameReal, 'Grace Hopper');
    assert.equal((await getSigningStatus()).unlocked, false);
    await unlockSigningKey(Buffer.from(PASS));
    const signed = await signPayload(Buffer.from('payload'), key.signingFingerprint);
    assert.ok(signed.status.some((l) => l.startsWith('[GNUPG:] SIG_CREATED ')));
    await deleteSigningKey();
  } finally {
    try { execFileSync('gpgconf', ['--homedir', master, '--kill', 'all'], { stdio: 'ignore' }); } catch { /* ignore */ }
    rmSync(master, { recursive: true, force: true });
  }
});
