import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createSignHandler, waitForUnlock, resolvePendingUnlocks, installApprovalGuards,
  requestLaunchApproval, resolveLaunchSigningKey, requestSignApproval, grantSessionSigning,
} from './commitSignService.js';
import { requestApproval, decideApproval, listApprovals, _resetWaitersForTests } from './approvals.js';
import { closeDb } from '../db.js';

const KEY = { nameReal: 'Ada', nameEmail: 'ada@example.com', signingFingerprint: 'F'.repeat(40), keyId: 'FFFF' };
const TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const NOW = 1_800_000_000_000;

let root;
let repo;
let outside;

before(() => {
  root = mkdtempSync(join(tmpdir(), 'ccs-signsvc-'));
  repo = join(root, 'repo');
  outside = join(root, 'outside');
  mkdirSync(outside);
  execFileSync('git', ['init', '-q', repo], { env: { ...process.env, GIT_CONFIG_COUNT: '0' } });
  symlinkSync(outside, join(repo, 'escape'));
});

after(() => {
  _resetWaitersForTests();
  closeDb();
  rmSync(root, { recursive: true, force: true });
});

function payload({ email = KEY.nameEmail, time = NOW / 1000, tree = TREE, nameReal = KEY.nameReal } = {}) {
  return Buffer.from(`tree ${tree}\nauthor ${nameReal} <${email}> ${time} +0000\ncommitter ${nameReal} <${email}> ${time} +0000\n\nsubject\n`).toString('base64');
}

function handler(over = {}, opts = {}) {
  const signed = [];
  const recorded = [];
  const h = createSignHandler({ cwd: repo, app: 'claude', key: KEY, ...opts }, {
    now: () => NOW,
    signPayload: async (buf, fpr) => { signed.push(fpr); return { signature: Buffer.from('SIG'), status: ['[GNUPG:] SIG_CREATED D'] }; },
    recordSignature: (r) => recorded.push(r),
    checkObjects: async () => null,
    ...over,
  });
  return { h, signed, recorded };
}

test('a good commit is signed with the launch key and recorded', async () => {
  const { h, signed, recorded } = handler();
  const r = await h({ payload: payload(), dir: repo });
  assert.equal(r.ok, true);
  assert.equal(Buffer.from(r.signature, 'base64').toString(), 'SIG');
  assert.deepEqual(r.status, ['[GNUPG:] SIG_CREATED D']);
  assert.deepEqual(signed, [KEY.signingFingerprint]);
  assert.equal(recorded[0].tree, TREE);
  assert.equal(recorded[0].subject, 'subject');
  assert.equal(recorded[0].payloadSha256.length, 64);
});

test('refusals carry a reason and never reach gpg', async () => {
  const { h, signed } = handler();
  const cases = [
    [{ payload: Buffer.from('arbitrary data').toString('base64'), dir: repo }, 'not-a-commit'],
    [{ payload: payload({ email: 'someone@else.com', nameReal: 'Linus' }), dir: repo }, 'identity-mismatch'],
    [{ payload: payload({ time: NOW / 1000 - 86400 }), dir: repo }, 'stale-timestamp'],
    [{ payload: payload(), dir: outside }, 'outside-project'],
    [{ payload: payload(), dir: join(repo, 'escape') }, 'outside-project'],
    [{ payload: payload(), dir: 'relative/path' }, 'bad-request'],
    [{ dir: repo }, 'bad-request'],
  ];
  for (const [req, reason] of cases) {
    const r = await h(req);
    assert.equal(r.ok, false);
    assert.equal(r.reason, reason, JSON.stringify(req).slice(0, 80));
  }
  assert.deepEqual(signed, []);
});

test('objects must exist in the repository (real git, replace refs off)', async () => {
  const { h } = handler({ checkObjects: undefined });
  const r = await h({ payload: payload({ tree: 'b'.repeat(40) }), dir: repo });
  assert.equal(r.reason, 'unknown-object');
  // The empty tree is "known" to every repository.
  assert.equal((await h({ payload: payload(), dir: repo })).ok, true);
});

test('rate limit per launch', async () => {
  const { h } = handler({ rateLimit: { max: 2, windowMs: 60_000 } });
  assert.equal((await h({ payload: payload(), dir: repo })).ok, true);
  assert.equal((await h({ payload: payload(), dir: repo })).ok, true);
  assert.equal((await h({ payload: payload(), dir: repo })).reason, 'rate-limited');
});

test('a locked key waits for one unlock, then signs; a refused unlock fails the commit', async () => {
  let locked = true;
  const waits = [];
  const sign = async () => {
    if (locked) throw Object.assign(new Error('locked'), { code: 'locked' });
    return { signature: Buffer.from('S'), status: [] };
  };
  const ok = handler({ signPayload: sign, waitForUnlock: async (ctx) => { waits.push(ctx); locked = false; return true; } });
  assert.equal((await ok.h({ payload: payload(), dir: repo })).ok, true);
  assert.equal(waits.length, 1);
  assert.equal(waits[0].cwd, repo);

  locked = true;
  const no = handler({ signPayload: sign, waitForUnlock: async () => false });
  const r = await no.h({ payload: payload(), dir: repo });
  assert.equal(r.reason, 'locked');
});

test('waitForUnlock: concurrent commits share one approval; an unlock resolves it; the banner cannot approve it', async () => {
  installApprovalGuards();
  const p1 = waitForUnlock({ cwd: repo, app: 'claude' });
  const p2 = waitForUnlock({ cwd: repo, app: 'claude' });
  assert.equal(p1, p2, 'one request for all waiting commits');
  const pending = listApprovals().pending.filter((a) => a.kind === 'commit_signing_unlock');
  assert.equal(pending.length, 1);
  assert.equal(JSON.stringify(pending[0]).includes('passphrase'), false);

  const viaBanner = decideApproval(pending[0].id, 'approved');
  assert.equal(viaBanner.ok, false, '"approve" from the banner is refused');
  assert.match(viaBanner.message, /unlock the signing key/);

  resolvePendingUnlocks();
  assert.equal(await p1, true);

  const p3 = waitForUnlock({ cwd: repo, app: 'claude' });
  const [again] = listApprovals().pending.filter((a) => a.kind === 'commit_signing_unlock');
  assert.equal(decideApproval(again.id, 'rejected').ok, true, 'the banner may reject');
  assert.equal(await p3, false);
});

test('requestLaunchApproval: only "approved" lets the launch through', async () => {
  for (const [status, ok] of [['approved', true], ['rejected', false], ['expired', false]]) {
    const run = requestLaunchApproval({ cwd: repo, app: 'claude', backend: 'bwrap', key: KEY }, {
      request: async (input) => {
        assert.equal(input.kind, 'commit_signing_launch');
        assert.match(input.summary, /ada@example\.com/);
        assert.equal(input.payload.fingerprint, KEY.signingFingerprint);
        return { status };
      },
    });
    if (ok) await run; else await assert.rejects(run, /launch refused/);
  }
  // And through the real approvals table.
  const real = requestLaunchApproval({ cwd: repo, app: 'claude', backend: 'bwrap', key: KEY }, { request: (i) => requestApproval(i) });
  const [row] = listApprovals().pending.filter((a) => a.kind === 'commit_signing_launch');
  decideApproval(row.id, 'approved');
  await real;
});

test('resolveLaunchSigningKey: no key or an unusable key refuses with a clear message', async () => {
  await assert.rejects(resolveLaunchSigningKey({ getSigningKey: async () => null }), /no signing key is set up/);
  await assert.rejects(resolveLaunchSigningKey({ getSigningKey: async () => { throw new Error('expired'); } }), /cannot be used: expired/);
  assert.equal(await resolveLaunchSigningKey({ getSigningKey: async () => KEY }), KEY);
});

test('approval mode "launch" (the default) never asks per commit', async () => {
  const { h } = handler({ requestSignApproval: async () => assert.fail('asked') });
  assert.equal((await h({ payload: payload(), dir: repo })).ok, true);
});

test('approval mode "sign": each commit asks after the checks; only "approved" signs', async () => {
  const asked = [];
  let answer = true;
  const { h, signed } = handler({ requestSignApproval: async (ctx) => { asked.push(ctx); return answer; } }, { approveEachSign: true });
  assert.equal((await h({ payload: payload(), dir: repo })).ok, true);
  assert.equal(asked.length, 1);
  assert.equal(asked[0].commit.subject, 'subject');
  assert.equal(asked[0].dir, repo);

  answer = false;
  const r = await h({ payload: payload(), dir: repo });
  assert.equal(r.reason, 'not-approved');
  assert.equal(signed.length, 1, 'a rejected commit never reaches gpg');

  // A commit the checks refuse never reaches the banner.
  assert.equal((await h({ payload: payload({ email: 'x@y.z', nameReal: 'Linus' }), dir: repo })).reason, 'identity-mismatch');
  assert.equal(asked.length, 2);
});

test('requestSignApproval: kind, summary and payload', async () => {
  for (const [status, ok] of [['approved', true], ['rejected', false], ['expired', false]]) {
    const r = await requestSignApproval({
      cwd: repo, app: 'claude', dir: repo, key: KEY, grantId: 'g1',
      commit: { subject: 'fix bug', tree: TREE, parents: [] },
    }, {
      request: async (input) => {
        assert.equal(input.kind, 'commit_signing_sign');
        assert.match(input.summary, /fix bug/);
        assert.equal(input.payload.grantId, 'g1');
        assert.equal(input.payload.tree, TREE);
        return { status };
      },
    });
    assert.equal(r, ok);
  }
});

test('grantSessionSigning: approves the launch\'s pending commits and stops asking; dispose forgets it', async () => {
  const a = createSignHandler({ cwd: repo, app: 'claude', key: KEY, approveEachSign: true }, {
    now: () => NOW,
    signPayload: async () => ({ signature: Buffer.from('S'), status: [] }),
    recordSignature: () => {},
    checkObjects: async () => null,
  });
  const other = createSignHandler({ cwd: repo, app: 'claude', key: KEY, approveEachSign: true }, {
    now: () => NOW,
    signPayload: async () => ({ signature: Buffer.from('S'), status: [] }),
    recordSignature: () => {},
    checkObjects: async () => null,
  });
  const p1 = a({ payload: payload(), dir: repo });
  const p2 = a({ payload: payload(), dir: repo });
  const p3 = other({ payload: payload(), dir: repo });
  await new Promise((r) => setTimeout(r, 50));
  const pending = listApprovals().pending.filter((x) => x.kind === 'commit_signing_sign');
  assert.equal(pending.length, 3);
  // a's two requests share a grantId; other's one does not.
  const count = (g) => pending.filter((x) => x.payload.grantId === g).length;
  const mine = pending.filter((x) => count(x.payload.grantId) === 2);
  const theirs = pending.find((x) => count(x.payload.grantId) === 1);
  assert.equal(mine.length, 2);

  assert.equal(grantSessionSigning(mine[0].id).ok, true);
  assert.equal(grantSessionSigning(mine[0].id).code, 'already-resolved');
  assert.equal((await p1).ok, true);
  assert.equal((await p2).ok, true);
  // Later commits of the same launch go through without asking.
  assert.equal((await a({ payload: payload(), dir: repo })).ok, true);
  assert.equal(listApprovals().pending.filter((x) => x.kind === 'commit_signing_sign').length, 1, 'only the other launch is still waiting');

  other.dispose();
  assert.equal(grantSessionSigning(theirs.id).code, 'not-found', 'a disposed launch cannot be granted');
  decideApproval(theirs.id, 'rejected');
  assert.equal((await p3).reason, 'not-approved');
  assert.equal(grantSessionSigning('nope').code, 'not-found');
  a.dispose();
});
