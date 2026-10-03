// Host-side commit signing key (plan: sandbox-no-secrets). Replaces the GPG
// vault: sandboxes no longer get any signing socket. They hand the commit
// to the host (sandbox-gpg-sign-wrapper.cjs -> git-broker.js ->
// ws/commitSignService.js), and the host signs it here with a key that
// never leaves this machine.
//
// The key lives in a dedicated GNUPGHOME (paths.js `commitSigningHome`,
// default ~/.local/share/ccserver/signing-gnupg), NOT the operator's own
// ~/.gnupg: the intended content is a signing SUBKEY exported with
// `gpg --export-secret-subkeys` from the operator's master key, so the
// primary secret key is a stub here and a host compromise costs one
// revocable subkey, not the identity. (A dedicated key can also be
// generated here for hosts without a master key.) See docs-site
// sandbox/commit-signing.md for the operator runbook.
//
// Passphrase: the key is expected to be passphrase-protected. Nothing here
// stores the passphrase. unlock() PRESETs it into this home's own gpg-agent
// (allow-preset-passphrase; preset entries do not expire on their own) and
// lock() kills that agent, which is the only place it ever lives. The agent
// never asks interactively (pinentry-program /bin/false, every gpg call runs
// with --pinentry-mode error), so a locked key fails fast instead of popping
// a pinentry nobody can see on a headless host.
//
// The passphrase is handed to gpg-connect-agent on stdin (PRESET_PASSPHRASE,
// hex) and to gpg on an extra pipe (--passphrase-fd 3) -- never argv or env,
// both readable through /proc by any process of the same user.
//
// Every gpg operation goes through one queue: unlock / lock / sign / import
// must not interleave on the same agent.

import { spawn, execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolvePath, PATH_IDS } from './paths.js';

const GPG_TIMEOUT_MS = 30_000;
const AGENT_CONF = [
  // unlock() presets the passphrase; nothing ever prompts.
  'allow-preset-passphrase',
  'pinentry-program /bin/false',
  'disable-scdaemon',
  '',
].join('\n');

export const MIN_PASSPHRASE_LENGTH = 8;
const MAX_PASSPHRASE_BYTES = 1024;
const MAX_IDENTITY_LEN = 200;

export function signingHome() {
  return resolvePath(PATH_IDS.commitSigningHome);
}

export function signingToolsAvailable() {
  try {
    for (const bin of ['gpg', 'gpgconf', 'gpg-connect-agent']) {
      execFileSync(bin, ['--version'], { timeout: 5000, stdio: 'ignore' });
    }
    return true;
  } catch {
    return false;
  }
}

export class SigningError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// --- serialization -----------------------------------------------------------

let queue = Promise.resolve();
function serialized(fn) {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

// --- process helper ----------------------------------------------------------

// Runs one GnuPG tool against the signing home. input: stdin bytes;
// passphrase: Buffer written to fd 3 (pair with --passphrase-fd 3).
// Resolves { code, stdout: Buffer, stderr: string }; never rejects on a
// non-zero exit (callers decide), rejects only if the binary is missing.
function run(bin, args, { input = null, passphrase = null, timeoutMs = GPG_TIMEOUT_MS } = {}) {
  const home = signingHome();
  return new Promise((resolve, reject) => {
    const stdio = ['pipe', 'pipe', 'pipe'];
    if (passphrase) stdio.push('pipe');
    let child;
    try {
      child = spawn(bin, args, {
        stdio,
        env: { ...process.env, GNUPGHOME: home, LC_ALL: 'C' },
      });
    } catch (err) {
      reject(err);
      return;
    }
    const out = [];
    const err = [];
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, timeoutMs);
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    for (const s of child.stdio) s?.on?.('error', () => {});
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString('utf8') });
    });
    if (passphrase) {
      child.stdio[3].end(Buffer.concat([passphrase, Buffer.from('\n')]));
    }
    child.stdin.end(input ?? undefined);
  });
}

const gpg = (args, opts) => run('gpg', ['--homedir', signingHome(), '--batch', '--no-tty', ...args], opts);
const agent = (commands) => run('gpg-connect-agent', ['--homedir', signingHome()], { input: `${commands.join('\n')}\n/bye\n` });

// --- home --------------------------------------------------------------------

export function ensureSigningHome() {
  const home = signingHome();
  mkdirSync(home, { recursive: true, mode: 0o700 });
  // gpg refuses (warns, and with some versions fails) on a group/other-
  // accessible homedir; mkdir's mode never fixes a pre-existing dir.
  chmodSync(home, 0o700);
  writeFileSync(join(home, 'gpg-agent.conf'), AGENT_CONF, { mode: 0o600 });
  return home;
}

// --- key discovery -------------------------------------------------------------

// Undo GnuPG's colon-listing escaping (\xHH, used for ':' and non-printables).
function unescapeColon(s) {
  return s.replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

function parseUid(raw) {
  const m = /^(.*?)\s*<([^<>]+)>$/.exec(unescapeColon(raw));
  if (!m || !m[1]) return null;
  return { name: m[1], email: m[2] };
}

const unusable = (validity) => ['r', 'e', 'd', 'i', 'n'].includes(validity);
const secretPresent = (token) => token !== '#' && token !== '>';

// `gpg --with-colons --with-keygrip --list-secret-keys` -> the key to sign
// with, or throws SigningError. Pure (exported for tests).
//
// One primary key per home. The signing key is the newest usable secret
// subkey with the 's' capability; failing that the primary itself, if it
// can sign and its secret is present. Field numbers per GnuPG's
// doc/DETAILS (1-based there, 0-based here): 1 validity, 4 keyid,
// 5 created, 6 expires, 9 fpr/grip/uid, 11 capabilities, 14 secret token.
export function selectSigningKey(listing, nowSec = Math.floor(Date.now() / 1000)) {
  const keys = [];
  let primary = null;
  let uid = null;
  let last = null;
  for (const line of listing.split('\n')) {
    const f = line.split(':');
    switch (f[0]) {
      case 'sec':
        if (primary) throw new SigningError('multiple-keys', 'the signing home holds more than one key; keep exactly one');
        primary = { kind: 'sec', validity: f[1], keyId: f[4], created: Number(f[5]) || 0, expires: Number(f[6]) || null, caps: f[11] || '', secret: secretPresent(f[14]) };
        last = primary;
        keys.push(primary);
        break;
      case 'ssb':
        last = { kind: 'ssb', validity: f[1], keyId: f[4], created: Number(f[5]) || 0, expires: Number(f[6]) || null, caps: f[11] || '', secret: secretPresent(f[14]) };
        keys.push(last);
        break;
      case 'fpr':
        if (last && !last.fpr) last.fpr = f[9];
        break;
      case 'grp':
        if (last && !last.grip) last.grip = f[9];
        break;
      case 'uid':
        if (!uid && !unusable(f[1])) uid = parseUid(f[9] || '');
        break;
      default:
        break;
    }
  }
  if (!primary) return null;
  if (unusable(primary.validity) || (primary.expires && primary.expires <= nowSec)) {
    throw new SigningError('key-unusable', 'the signing key is revoked or expired');
  }
  if (!uid) throw new SigningError('no-identity', 'the signing key has no "Name <email>" user id');
  const canSign = (k) => k.caps.includes('s') && k.secret && !unusable(k.validity) && !(k.expires && k.expires <= nowSec) && k.fpr && k.grip;
  const subkeys = keys.filter((k) => k.kind === 'ssb' && canSign(k)).sort((a, b) => b.created - a.created);
  const signer = subkeys[0] || (canSign(primary) ? primary : null);
  if (!signer) throw new SigningError('no-signing-key', 'no usable signing (sub)key with its secret part in the signing home');
  return {
    primaryFingerprint: primary.fpr,
    signingFingerprint: signer.fpr,
    signingKeygrip: signer.grip,
    keyId: signer.fpr.slice(-16),
    nameReal: uid.name,
    nameEmail: uid.email,
    createdAt: signer.created ? signer.created * 1000 : null,
    expiresAt: signer.expires ? signer.expires * 1000 : null,
    usesSubkey: signer.kind === 'ssb',
    primarySecretPresent: primary.secret,
  };
}

async function readKey() {
  if (!existsSync(signingHome())) return null;
  const r = await gpg(['--with-colons', '--with-keygrip', '--list-secret-keys']);
  if (r.code !== 0 && r.stdout.length === 0) return null;
  return selectSigningKey(r.stdout.toString('utf8'));
}

// The configured signing key (see selectSigningKey), or null when none is
// set up. Throws SigningError when a key is there but cannot sign.
export function getSigningKey() {
  return serialized(readKey);
}

// KEYINFO's CACHED / PROTECTION fields for the signing keygrip:
//   S KEYINFO <grip> <type> <serial> <idstr> <cached> <protection> ...
async function keyInfo(grip) {
  const r = await agent([`KEYINFO ${grip}`]);
  const line = r.stdout.toString('utf8').split('\n').find((l) => l.startsWith('S KEYINFO '));
  if (!line) return { cached: false, protection: '-' };
  const t = line.trim().split(/\s+/);
  return { cached: t[6] === '1', protection: t[7] || '-' };
}

// { toolsAvailable, configured, key, unlocked, needsPassphrase, error }
export function getSigningStatus() {
  return serialized(async () => {
    if (!signingToolsAvailable()) {
      return { toolsAvailable: false, configured: false, key: null, unlocked: false, needsPassphrase: false, error: null };
    }
    let key;
    try {
      key = await readKey();
    } catch (err) {
      return { toolsAvailable: true, configured: true, key: null, unlocked: false, needsPassphrase: false, error: err.message };
    }
    if (!key) return { toolsAvailable: true, configured: false, key: null, unlocked: false, needsPassphrase: false, error: null };
    const info = await keyInfo(key.signingKeygrip);
    const needsPassphrase = info.protection !== 'C';
    return { toolsAvailable: true, configured: true, key, unlocked: !needsPassphrase || info.cached, needsPassphrase, error: null };
  });
}

// --- signing ------------------------------------------------------------------

const PROBE_PAYLOAD = Buffer.from('ccserver commit-signing unlock probe\n');

async function trySign(payload, signingFingerprint) {
  // --pinentry-mode error: a key whose passphrase is not in the agent's
  // cache fails at once ("No pinentry") instead of prompting.
  const r = await gpg(
    ['--pinentry-mode', 'error', '--status-fd', '2', '--armor', '--detach-sign', '--local-user', `${signingFingerprint}!`],
    { input: payload },
  );
  const status = r.stderr.split('\n').filter((l) => l.startsWith('[GNUPG:] '));
  if (r.code === 0 && status.some((l) => l.startsWith('[GNUPG:] SIG_CREATED '))) {
    return { ok: true, signature: r.stdout, status };
  }
  const locked = /No pinentry|Bad passphrase|FAILURE sign 67108949|Operation cancelled/.test(r.stderr);
  return { ok: false, locked, detail: status.join('\n') || r.stderr.split('\n').find(Boolean) || `gpg exited ${r.code}` };
}

// Signs `payload` (Buffer) with the signing key `signingFingerprint`.
// Resolves { signature: Buffer (armored detached sig), status: [...] } --
// status is gpg's own [GNUPG:] lines, which git needs (SIG_CREATED).
// Throws SigningError 'locked' when the passphrase is not cached,
// 'key-changed' when the home's signing key is no longer that one.
export function signPayload(payload, signingFingerprint) {
  return serialized(async () => {
    const key = await readKey();
    if (!key) throw new SigningError('not-configured', 'no commit signing key is set up on the host');
    if (key.signingFingerprint !== signingFingerprint) {
      throw new SigningError('key-changed', 'the host signing key changed after this session was launched; relaunch it');
    }
    const r = await trySign(payload, signingFingerprint);
    if (r.ok) return { signature: r.signature, status: r.status };
    if (r.locked) throw new SigningError('locked', 'the commit signing key is locked');
    throw new SigningError('sign-failed', `gpg could not sign: ${r.detail}`);
  });
}

// --- unlock / lock -----------------------------------------------------------

export function validatePassphrase(passphrase) {
  if (!Buffer.isBuffer(passphrase) || passphrase.length === 0) {
    throw new SigningError('bad-passphrase', 'a passphrase is required');
  }
  if (passphrase.length > MAX_PASSPHRASE_BYTES) throw new SigningError('bad-passphrase', 'the passphrase is too long');
  // --passphrase-fd reads one line.
  if (passphrase.includes(0x0a) || passphrase.includes(0x0d)) {
    throw new SigningError('bad-passphrase', 'the passphrase must not contain line breaks');
  }
}

// Caches `passphrase` (Buffer, zeroed by the caller) in the signing agent
// and proves it by signing a probe. A wrong passphrase is cleared again and
// throws SigningError 'wrong-passphrase'. A key without a passphrase is
// already "unlocked"; this is then a no-op.
export function unlockSigningKey(passphrase) {
  return serialized(async () => {
    const key = await readKey();
    if (!key) throw new SigningError('not-configured', 'no commit signing key is set up on the host');
    const info = await keyInfo(key.signingKeygrip);
    if (info.protection === 'C') return key;
    validatePassphrase(passphrase);
    const hex = passphrase.toString('hex').toUpperCase();
    const preset = await agent([`PRESET_PASSPHRASE ${key.signingKeygrip} -1 ${hex}`]);
    if (preset.code !== 0 || !preset.stdout.toString('utf8').includes('OK')) {
      throw new SigningError('agent-failed', 'the signing agent refused the passphrase (allow-preset-passphrase missing?)');
    }
    const probe = await trySign(PROBE_PAYLOAD, key.signingFingerprint);
    if (!probe.ok) {
      await agent([`CLEAR_PASSPHRASE --mode=normal ${key.signingKeygrip}`]);
      if (probe.locked) throw new SigningError('wrong-passphrase', 'wrong passphrase');
      throw new SigningError('sign-failed', `gpg could not sign: ${probe.detail}`);
    }
    return key;
  });
}

// Forgets the cached passphrase by stopping the signing home's agent.
// Idempotent, never throws.
export function lockSigningKey() {
  return serialized(async () => {
    if (!existsSync(signingHome())) return;
    try { await run('gpgconf', ['--homedir', signingHome(), '--kill', 'gpg-agent']); } catch { /* not installed: nothing cached */ }
  });
}

// --- setup ---------------------------------------------------------------------

export function validateIdentity(nameReal, nameEmail) {
  if (typeof nameReal !== 'string' || typeof nameEmail !== 'string') {
    throw new SigningError('bad-identity', 'nameReal and nameEmail are required strings');
  }
  const name = nameReal.trim();
  const email = nameEmail.trim();
  if (!name || name.length > MAX_IDENTITY_LEN || /[\r\n<>]/.test(name)) {
    throw new SigningError('bad-identity', 'nameReal must be 1-200 characters without line breaks or <>');
  }
  if (email.length > MAX_IDENTITY_LEN || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email)) {
    throw new SigningError('bad-identity', 'nameEmail must look like an email address');
  }
  return { nameReal: name, nameEmail: email };
}

async function assertNoKey() {
  if (await readKey().catch(() => true)) {
    throw new SigningError('already-configured', 'a signing key is already set up; delete it first');
  }
}

// Generates a dedicated key: an Ed25519 certify-only primary plus an Ed25519
// signing subkey, both expiring after `expire` (gpg syntax, default 1y),
// protected by `passphrase`. For hosts without a master key of their own --
// importing a subkey of the operator's key is the recommended setup.
export function generateSigningKey({ nameReal, nameEmail, passphrase, expire = '1y' }) {
  return serialized(async () => {
    const id = validateIdentity(nameReal, nameEmail);
    validatePassphrase(passphrase);
    if (passphrase.length < MIN_PASSPHRASE_LENGTH) {
      throw new SigningError('bad-passphrase', `the passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters`);
    }
    if (!/^(?:0|\d{1,4}[dwmy]?)$/.test(expire)) throw new SigningError('bad-request', 'bad expiry');
    await assertNoKey();
    ensureSigningHome();
    const uid = `${id.nameReal} <${id.nameEmail}>`;
    const loopback = ['--pinentry-mode', 'loopback', '--passphrase-fd', '3'];
    const gen = await gpg([...loopback, '--quick-generate-key', uid, 'ed25519', 'cert', expire], { passphrase });
    if (gen.code !== 0) throw new SigningError('gpg-failed', 'key generation failed');
    const listing = await gpg(['--with-colons', '--list-secret-keys']);
    const fpr = listing.stdout.toString('utf8').split('\n').find((l) => l.startsWith('fpr:'))?.split(':')[9];
    if (!fpr) throw new SigningError('gpg-failed', 'key generation failed');
    const sub = await gpg([...loopback, '--quick-add-key', fpr, 'ed25519', 'sign', expire], { passphrase });
    if (sub.code !== 0) throw new SigningError('gpg-failed', 'signing subkey generation failed');
    // The agent cached the passphrase while generating: start locked, like
    // every other way of arriving at a configured key.
    await run('gpgconf', ['--homedir', signingHome(), '--kill', 'gpg-agent']);
    return readKey();
  });
}

// Imports an exported secret key (armored or binary), normally the output
// of `gpg --armor --export-secret-subkeys <KEYID>!`. Protected keys import
// as-is; their passphrase is first needed at unlock.
export function importSigningKey(keyData) {
  return serialized(async () => {
    if (!Buffer.isBuffer(keyData) || keyData.length === 0 || keyData.length > 1024 * 1024) {
      throw new SigningError('bad-request', 'key data is required (at most 1 MiB)');
    }
    await assertNoKey();
    ensureSigningHome();
    const r = await gpg(['--pinentry-mode', 'error', '--import-options', 'import-minimal', '--import'], { input: keyData });
    let key = null;
    let problem = null;
    try {
      key = await readKey();
    } catch (err) {
      problem = err.message;
    }
    if (!key) {
      // Leave nothing half-imported behind (public-only keys, extra keys).
      wipeHome();
      if (problem) throw new SigningError('bad-key', problem);
      throw new SigningError('bad-key', r.code === 0
        ? 'the data held no secret key (export it with --export-secret-subkeys)'
        : 'gpg could not import the key data');
    }
    await run('gpgconf', ['--homedir', signingHome(), '--kill', 'gpg-agent']);
    return key;
  });
}

// ASCII-armored public key (primary + subkeys): what goes into GitHub's
// "GPG keys" settings and what sandboxes verify against.
export function exportPublicKey() {
  return serialized(async () => {
    const key = await readKey();
    if (!key) return null;
    const r = await gpg(['--armor', '--export', key.primaryFingerprint]);
    return r.code === 0 ? r.stdout.toString('utf8') : null;
  });
}

function wipeHome() {
  const home = signingHome();
  try { execFileSync('gpgconf', ['--homedir', home, '--kill', 'all'], { timeout: 5000, stdio: 'ignore' }); } catch { /* best effort */ }
  rmSync(home, { recursive: true, force: true });
}

// Removes the key (and its agent) from the host for good.
export function deleteSigningKey() {
  return serialized(async () => { wipeHome(); });
}

// --- auto-lock -----------------------------------------------------------------

const AUTO_LOCK_SWEEP_MS = 5 * 60 * 1000;
let sweepTimer = null;

// Passkey mode only: with no live login session left, nobody can answer an
// unlock or launch approval anyway, so drop the cached passphrase. (Same
// policy the GPG vault had. Token/none mode has no session table to go by.)
export function startAutoLockSweep({ hasActiveLogin }) {
  stopAutoLockSweep();
  sweepTimer = setInterval(() => {
    try {
      if (!hasActiveLogin()) lockSigningKey();
    } catch { /* DB closing */ }
  }, AUTO_LOCK_SWEEP_MS);
  sweepTimer.unref?.();
}

export function stopAutoLockSweep() {
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = null;
}
