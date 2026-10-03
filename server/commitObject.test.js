import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseCommitPayload,
  checkCommitPolicy,
  CommitPayloadError,
  MAX_COMMIT_PAYLOAD_BYTES,
} from './commitObject.js';

const TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const PARENT = 'a'.repeat(40);
const NOW = 1_800_000_000;
const ME = { name: 'Ada Lovelace', email: 'ada@example.com' };

function commit({ headers = null, message = 'subject line\n\nbody\n', time = NOW } = {}) {
  const lines = headers ?? [
    `tree ${TREE}`,
    `parent ${PARENT}`,
    `author ${ME.name} <${ME.email}> ${time} +0900`,
    `committer ${ME.name} <${ME.email}> ${time} +0900`,
  ];
  return Buffer.from(`${lines.join('\n')}\n\n${message}`);
}

function code(fn) {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof CommitPayloadError, `expected CommitPayloadError, got ${err}`);
    return err.code;
  }
  assert.fail('expected a throw');
}

test('parses an ordinary commit', () => {
  const c = parseCommitPayload(commit());
  assert.equal(c.tree, TREE);
  assert.deepEqual(c.parents, [PARENT]);
  assert.deepEqual(c.author, { name: ME.name, email: ME.email, time: NOW, tz: '+0900' });
  assert.equal(c.committer.time, NOW);
  assert.equal(c.subject, 'subject line');
  assert.equal(c.encoding, null);
  assert.equal(c.objectFormat, 'sha1');
});

test('root commits, merges, encoding header and sha256 ids are accepted', () => {
  const root = parseCommitPayload(commit({ headers: [`tree ${TREE}`, `author A <a@x> ${NOW} +0000`, `committer A <a@x> ${NOW} +0000`] }));
  assert.deepEqual(root.parents, []);
  const merge = parseCommitPayload(commit({
    headers: [`tree ${TREE}`, `parent ${PARENT}`, `parent ${'b'.repeat(40)}`, `author A <a@x> ${NOW} +0000`, `committer A <a@x> ${NOW} +0000`, 'encoding ISO-8859-1'],
  }));
  assert.equal(merge.parents.length, 2);
  assert.equal(merge.encoding, 'ISO-8859-1');
  const sha256 = parseCommitPayload(commit({ headers: [`tree ${'c'.repeat(64)}`, `parent ${'d'.repeat(64)}`, `author A <a@x> ${NOW} +0000`, `committer A <a@x> ${NOW} +0000`] }));
  assert.equal(sha256.objectFormat, 'sha256');
  assert.equal(parseCommitPayload(commit({ message: '' })).subject, '');
});

test('refuses anything that is not a plain unsigned commit', () => {
  // A tag object (git tag -s hands gpg.program exactly this).
  assert.equal(code(() => parseCommitPayload(Buffer.from(`object ${PARENT}\ntype commit\ntag v1\ntagger A <a@x> ${NOW} +0000\n\nmsg\n`))), 'not-a-commit');
  // Arbitrary data.
  assert.equal(code(() => parseCommitPayload(Buffer.from('hello world'))), 'not-a-commit');
  assert.equal(code(() => parseCommitPayload(Buffer.alloc(0))), 'empty');
  assert.equal(code(() => parseCommitPayload(Buffer.alloc(MAX_COMMIT_PAYLOAD_BYTES + 1, 0x61))), 'too-large');
  assert.equal(code(() => parseCommitPayload(Buffer.from(`tree ${TREE}\x00\n\nx`))), 'not-a-commit');
  assert.equal(code(() => parseCommitPayload('not a buffer')), 'bad-request');
});

test('refuses already-signed commits and mergetags', () => {
  const base = [`tree ${TREE}`, `author A <a@x> ${NOW} +0000`, `committer A <a@x> ${NOW} +0000`];
  assert.equal(code(() => parseCommitPayload(commit({ headers: [...base, 'gpgsig -----BEGIN PGP SIGNATURE-----', ' abc'] }))), 'already-signed');
  assert.equal(code(() => parseCommitPayload(commit({ headers: [...base, 'gpgsig-sha256 x'] }))), 'already-signed');
  assert.equal(code(() => parseCommitPayload(commit({ headers: [...base, `mergetag object ${PARENT}`, ' type commit'] }))), 'mergetag');
});

test('refuses malformed, reordered, duplicated or unknown headers', () => {
  const author = `author A <a@x> ${NOW} +0000`;
  const committer = `committer A <a@x> ${NOW} +0000`;
  for (const headers of [
    [author, `tree ${TREE}`, committer],
    [`tree ${TREE}`, committer, author],
    [`tree ${TREE}`, author, author, committer],
    [`tree ${TREE}`, author, committer, committer],
    [`tree ${TREE}`, author, committer, 'x-custom value'],
    [`tree ${TREE}`, author, committer, ' continuation'],
    [`tree ${TREE.slice(1)}`, author, committer],
    [`tree ${TREE}`, `parent ${'d'.repeat(64)}`, author, committer],
    [`tree ${TREE}`, 'author no-email-here 1 +0000', committer],
    [`tree ${TREE}\r`, author, committer],
  ]) {
    assert.ok(['not-a-commit', 'bad-ident'].includes(code(() => parseCommitPayload(commit({ headers })))), headers.join(' | '));
  }
});

test('refuses non-UTF-8 headers', () => {
  const bad = Buffer.concat([Buffer.from(`tree ${TREE}\nauthor A`), Buffer.from([0xff]), Buffer.from(` <a@x> ${NOW} +0000\ncommitter A <a@x> ${NOW} +0000\n\nm`)]);
  assert.equal(code(() => parseCommitPayload(bad)), 'not-a-commit');
});

test('policy: author and committer must be the signing identity', () => {
  assert.equal(checkCommitPolicy(parseCommitPayload(commit()), { identity: ME, nowSec: NOW }), null);
  // Email compare is case-insensitive.
  assert.equal(checkCommitPolicy(parseCommitPayload(commit()), { identity: { ...ME, email: 'ADA@example.com' }, nowSec: NOW }), null);
  const otherAuthor = commit({ headers: [`tree ${TREE}`, `author Linus <l@x> ${NOW - 86400 * 365} +0000`, `committer ${ME.name} <${ME.email}> ${NOW} +0000`] });
  assert.equal(checkCommitPolicy(parseCommitPayload(otherAuthor), { identity: ME, nowSec: NOW }).code, 'identity-mismatch');
  const otherCommitter = commit({ headers: [`tree ${TREE}`, `author ${ME.name} <${ME.email}> ${NOW} +0000`, `committer Ada <${ME.email}> ${NOW} +0000`] });
  assert.equal(checkCommitPolicy(parseCommitPayload(otherCommitter), { identity: ME, nowSec: NOW }).code, 'identity-mismatch');
});

test('policy: the committer date must be close to now', () => {
  const old = parseCommitPayload(commit({ time: NOW - 3600 }));
  assert.equal(checkCommitPolicy(old, { identity: ME, nowSec: NOW }).code, 'stale-timestamp');
  const future = parseCommitPayload(commit({ time: NOW + 3600 }));
  assert.equal(checkCommitPolicy(future, { identity: ME, nowSec: NOW }).code, 'stale-timestamp');
  const fresh = parseCommitPayload(commit({ time: NOW - 30 }));
  assert.equal(checkCommitPolicy(fresh, { identity: ME, nowSec: NOW }), null);
});

// What git really hands gpg.program: capture it with a gpg.program that
// just copies stdin, and make sure the parser accepts every shape git makes.
test('accepts the exact payloads git produces for a commit and a merge', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'commit-object-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const capture = join(dir, 'capture.sh');
  writeFileSync(capture, `#!/bin/sh\ncat > "${dir}/payload-$$"\necho "[GNUPG:] SIG_CREATED D 22 8 00 1 X" >&2\necho sig\n`, { mode: 0o755 });
  const repo = join(dir, 'repo');
  const env = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_COUNT: '0',
    GIT_AUTHOR_NAME: ME.name,
    GIT_AUTHOR_EMAIL: ME.email,
    GIT_COMMITTER_NAME: ME.name,
    GIT_COMMITTER_EMAIL: ME.email,
  };
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { env });
  git('config', 'gpg.program', capture);
  git('config', 'commit.gpgsign', 'false');
  git('commit', '-q', '--allow-empty', '-m', 'root');
  git('checkout', '-q', '-b', 'side');
  git('commit', '-q', '--allow-empty', '-m', 'side');
  git('checkout', '-q', 'main');
  git('commit', '-q', '--allow-empty', '-m', 'main');
  // The capture "signature" is not a real one, so git refuses to finish --
  // the payload is what matters here.
  for (const args of [['commit', '-S', '--allow-empty', '-m', 'signed'], ['merge', '-S', '--no-ff', '-m', 'merge', 'side']]) {
    try { git(...args); } catch { /* bogus signature: expected */ }
  }
  const payloads = readdirSync(dir).filter((f) => f.startsWith('payload-')).map((f) => readFileSync(join(dir, f)));
  assert.ok(payloads.length >= 1, 'git invoked gpg.program');
  for (const p of payloads) {
    const c = parseCommitPayload(p);
    assert.equal(checkCommitPolicy(c, { identity: ME, nowSec: c.committer.time }), null);
  }
});
