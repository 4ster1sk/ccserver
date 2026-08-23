import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalsRoute } from './approvals.js';
import { requestApproval, _resetWaitersForTests } from '../ws/approvals.js';
import { closeDb } from '../db.js';

let tmpRoot;
let app;
const savedHomeRoot = process.env.CCSERVER_SANDBOX_HOME_ROOT;

before(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'ccserver-approvals-route-'));
  process.env.CCSERVER_DB_PATH = join(tmpRoot, 'approvals.sqlite3');
  // Keep the v2 migration's importLegacy away from the host's real
  // .index.json (a fresh test DB would otherwise import -- and postApply
  // RENAME -- it as a side effect).
  process.env.CCSERVER_SANDBOX_HOME_ROOT = join(tmpRoot, 'home');
  app = Fastify();
  await app.register(approvalsRoute, { prefix: '/api' });
});

after(async () => {
  closeDb();
  delete process.env.CCSERVER_DB_PATH;
  if (savedHomeRoot === undefined) delete process.env.CCSERVER_SANDBOX_HOME_ROOT;
  else process.env.CCSERVER_SANDBOX_HOME_ROOT = savedHomeRoot;
  rmSync(tmpRoot, { recursive: true, force: true });
});

test('GET /approvals lists pending rows created by the store', async () => {
  const p = requestApproval({
    kind: 'delete_sandbox',
    summary: 'sandbox srv-proj を削除します',
    payload: { slug: 'srv_proj' },
    requestedBy: 'meta-1',
  }, { timeoutMs: 60_000 });

  const list = await app.inject({ method: 'GET', url: '/api/approvals' });
  assert.equal(list.statusCode, 200);
  const { pending } = list.json();
  const row = pending.find((x) => x.kind === 'delete_sandbox');
  assert.ok(row);
  assert.deepEqual(row.payload, { slug: 'srv_proj' });

  const decision = await app.inject({
    method: 'POST', url: `/api/approvals/${row.id}/decision`,
    payload: { decision: 'approved' },
  });
  assert.equal(decision.statusCode, 200);
  assert.equal(decision.json().success, true);
  assert.equal((await p).status, 'approved');

  // Decided rows move to the history tail.
  const after = (await app.inject({ method: 'GET', url: '/api/approvals' })).json();
  assert.equal(after.pending.some((x) => x.id === row.id), false);
  assert.equal(after.history[0].id, row.id);
});

test('decision errors map to 400/404/409', async () => {
  const bad = await app.inject({
    method: 'POST', url: '/api/approvals/x/decision',
    payload: { decision: 'maybe' },
  });
  assert.equal(bad.statusCode, 400);

  const missing = await app.inject({
    method: 'POST', url: '/api/approvals/no-such-id/decision',
    payload: { decision: 'approved' },
  });
  assert.equal(missing.statusCode, 404);

  const p = requestApproval({
    kind: 'close_session', summary: 's', payload: {}, timeoutHint: undefined,
  }, { timeoutMs: 30_000 }).catch(() => {});
  void p;
  const id = (await app.inject({ method: 'GET', url: '/api/approvals' })).json().pending[0].id;
  assert.equal((await app.inject({ method: 'POST', url: `/api/approvals/${id}/decision`, payload: { decision: 'rejected' } })).statusCode, 200);
  const again = await app.inject({ method: 'POST', url: `/api/approvals/${id}/decision`, payload: { decision: 'rejected' } });
  assert.equal(again.statusCode, 409);
  _resetWaitersForTests();
});
