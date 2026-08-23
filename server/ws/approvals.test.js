import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  requestApproval,
  decideApproval,
  listApprovals,
  normalizeApprovalInput,
  expireStalePendingApprovals,
  APPROVAL_TIMEOUT_MS,
  _resetWaitersForTests,
} from './approvals.js';
import { closeDb } from '../db.js';

let tmpRoot;

const validInput = () => ({
  kind: 'close_session',
  summary: 'workerB (claude, /srv/proj) を強制終了します',
  payload: { sessionId: 'sess-1' },
  requestedBy: 'meta-agent-sess',
});

before(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'ccserver-approvals-'));
  process.env.CCSERVER_DB_PATH = join(tmpRoot, 'approvals.sqlite3');
});

after(() => {
  closeDb();
  delete process.env.CCSERVER_DB_PATH;
  rmSync(tmpRoot, { recursive: true, force: true });
});

test('normalizeApprovalInput validates kind/summary/payload', () => {
  assert.equal(normalizeApprovalInput(validInput()).ok, true);
  for (const bad of [
    { ...validInput(), kind: 'format_disk' },
    { ...validInput(), summary: '' },
    { ...validInput(), summary: 42 },
    { ...validInput(), payload: null },
    { ...validInput(), payload: [1] },
    { ...validInput(), requestedBy: 7 },
    {},
  ]) {
    assert.equal(normalizeApprovalInput(bad).ok, false, JSON.stringify(bad));
  }
  const trimmed = normalizeApprovalInput({ ...validInput(), summary: '  x  ' });
  assert.equal(trimmed.value.summary, 'x', 'summary is trimmed');
});

test('requestApproval blocks until decideApproval resolves it as approved', async () => {
  const p = requestApproval(validInput());
  let settled = false;
  p.then(() => { settled = true; });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(settled, false, 'the tool call stays blocked while pending');

  const list = listApprovals();
  assert.equal(list.pending.length, 1);
  const approvalId = list.pending[0].id;
  assert.equal(list.pending[0].kind, 'close_session');
  assert.deepEqual(list.pending[0].payload, { sessionId: 'sess-1' });
  assert.equal(list.pending[0].requestedBy, 'meta-agent-sess');

  const decision = decideApproval(approvalId, 'approved');
  assert.equal(decision.ok, true);
  assert.equal(decision.approval.status, 'approved');
  assert.equal(decision.approval.resolvedBy, 'browser');

  const result = await p;
  assert.equal(result.status, 'approved');
  assert.ok(settled, 'the waiter resolved');
  assert.equal(result.approval.id, approvalId);
});

test('a rejected decision resolves the waiter with rejected and nothing runs', async () => {
  const p = requestApproval({ ...validInput(), kind: 'destroy_group', payload: { groupId: 'g1' } });
  const id = listApprovals().pending.find((x) => x.kind === 'destroy_group').id;
  assert.equal(decideApproval(id, 'rejected').ok, true);
  const result = await p;
  assert.equal(result.status, 'rejected');
});

test('an expired timeout resolves like a rejection (fail-safe)', async () => {
  const p = requestApproval(validInput(), { timeoutMs: 25 });
  const result = await p;
  assert.equal(result.status, 'expired');
  const row = listApprovals().history[0];
  assert.equal(row.status, 'expired');
  assert.equal(row.resolvedBy, 'timeout');
  // A late decision on the now-expired row must not resurrect it.
  const late = decideApproval(row.id, 'approved');
  assert.equal(late.ok, false);
  assert.equal(late.code, 'already-resolved');
});

test('double decisions are refused with already-resolved; unknown ids are 404-shaped', async () => {
  const p = requestApproval(validInput());
  const id = listApprovals().pending[listApprovals().pending.length - 1].id;
  assert.equal(decideApproval(id, 'approved').ok, true);
  const second = decideApproval(id, 'rejected');
  assert.equal(second.ok, false);
  assert.equal(second.code, 'already-resolved');
  await p;

  assert.equal(decideApproval('no-such-id', 'approved').code, 'not-found');
  const badDecision = decideApproval('no-such-id', 'maybe');
  assert.equal(badDecision.code, 'validation');
});

test('listApprovals returns pending oldest-first and history newest-first', async () => {
  const a = requestApproval({ ...validInput(), summary: 'one' }, { timeoutMs: 60_000 });
  await new Promise((r) => setTimeout(r, 3));
  const b = requestApproval({ ...validInput(), summary: 'two' }, { timeoutMs: 60_000 });
  await new Promise((r) => setTimeout(r, 3));
  const c = requestApproval({ ...validInput(), summary: 'three' }, { timeoutMs: 60_000 });

  const ids = ['one', 'two', 'three'].map((s) =>
    listApprovals().pending.find((x) => x.summary === s).id);
  const first = listApprovals();
  assert.ok(first.pending.length >= 3);
  const summaries = first.pending.filter((x) => ['one', 'two', 'three'].includes(x.summary)).map((x) => x.summary);
  assert.deepEqual(summaries, ['one', 'two', 'three'], 'pending ordered by created_at ASC');

  decideApproval(ids[2], 'rejected'); // three -> rejected
  const afterOne = await c;
  assert.equal(afterOne.status, 'rejected');
  assert.equal(afterOne.approval.id, ids[2]);

  // resolved_at has ms resolution: without a real gap between the two
  // decisions the history's ORDER BY resolved_at DESC tiebreaks on
  // created_at and the expected order becomes machine-speed-dependent.
  await new Promise((r) => setTimeout(r, 10));
  decideApproval(ids[0], 'approved'); // one -> approved (now strictly newer)
  await a;
  const history = listApprovals().history;
  const histIds = history.map((x) => x.id).filter((x) => [ids[0], ids[2]].includes(x));
  assert.deepEqual(histIds, [ids[0], ids[2]], 'history ordered by resolved_at DESC');

  // 'two' stays pending on purpose; dropping its waiter keeps the run exitable
  // without waiting out its 60s timeout (the row itself is swept by the next
  // test's expireStalePendingApprovals).
  _resetWaitersForTests();
});

test('expireStalePendingApprovals sweeps rows left pending by a restart', async () => {
  requestApproval(validInput()); // no live waiter will ever resolve this
  const before = listApprovals().pending.length;
  assert.ok(before >= 1);
  const swept = expireStalePendingApprovals();
  assert.ok(swept >= before);
  assert.equal(listApprovals().pending.length, 0);
  const expired = listApprovals().history[0];
  assert.equal(expired.status, 'expired');
  assert.equal(expired.resolvedBy, 'server-restart');
});

test('approvals survive closeDb + reopen (restart simulation); waiters do not', async () => {
  const p = requestApproval(validInput());
  closeDb(); // simulate crash: waiters die, committed rows survive
  _resetWaitersForTests();

  const res = listApprovals();
  assert.equal(res.ok, true);
  const pendingRow = res.pending[res.pending.length - 1];
  assert.equal(pendingRow.kind, 'close_session');

  // The old promise can never resolve now -- decide the fresh row instead.
  const swept = expireStalePendingApprovals();
  assert.ok(swept >= 1);
  assert.equal(listApprovals().pending.length, 0);
  void p; // intentionally abandoned
});

test('APPROVAL_TIMEOUT_MS is the fixed five minutes', () => {
  assert.equal(APPROVAL_TIMEOUT_MS, 5 * 60 * 1000);
});
