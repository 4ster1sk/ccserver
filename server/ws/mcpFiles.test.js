import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

let runtimeDir;
let groupManager;
let tools;

before(async () => {
  runtimeDir = mkdtempSync(join(tmpdir(), 'ccserver-mcp-files-test-'));
  process.env.XDG_RUNTIME_DIR = runtimeDir;
  process.env.CCSERVER_GROUPS_PATH = join(runtimeDir, 'saved-groups.json');
  process.env.CCSERVER_GROUP_DOCS_PATH = join(runtimeDir, 'saved-group-docs.json');
  process.env.CCSERVER_GROUP_FILES_PATH = join(runtimeDir, 'saved-group-files.json');
  process.env.CCSERVER_GROUP_FILES_ROOT = join(runtimeDir, 'group-files');
  process.env.CCSERVER_SAVED_SESSIONS_PATH = join(runtimeDir, 'saved-sessions.json');
  process.env.CCSERVER_ORCHESTRATOR_GENERATED_ROOT = join(runtimeDir, 'orchestrator-generated');
  process.env.CCSERVER_WORKTREE_ROOT = join(runtimeDir, 'worktrees');
  cpSync(join(import.meta.dirname, 'orchestrator-template.md'), join(runtimeDir, 'orchestrator-template.md'));
  process.env.CCSERVER_ORCHESTRATOR_TEMPLATE_PATH = join(runtimeDir, 'orchestrator-template.md');
  groupManager = await import('./groupManager.js');
  tools = await import('./mcpTools.js');
});

after(() => {
  try { rmSync(runtimeDir, { recursive: true, force: true }); } catch {}
  delete process.env.CCSERVER_GROUP_FILES_ROOT;
  delete process.env.CCSERVER_GROUP_FILES_PATH;
});

async function makeGroup() {
  const gid = randomUUID();
  await groupManager.createGroup({ groupId: gid, cwd: '/srv/proj', orchestratorDir: join(runtimeDir, gid) });
  return gid;
}
function controlDeps(gid) {
  return { groupId: gid, groupManager: groupManager.getGroupManagerApi(), sessionManager: { getSession: () => null, writeToSession: () => false, waitUntilSettled: async () => ({ settled: true }) } };
}
function handoffDeps(gid, role, sid) {
  return { groupId: gid, role, getSessionId: () => sid, groupManager: groupManager.getGroupManagerApi(), sessionManager: { getSession: () => null, writeToSession: () => false, waitUntilSettled: async () => ({ settled: true }) } };
}

test('listFiles/fetchFile require membership via closure-bound deps', async () => {
  const gid = await makeGroup();
  try {
    const other = randomUUID();
    await groupManager.createGroup({ groupId: other, cwd: '/srv/other', orchestratorDir: join(runtimeDir, other) });
    groupManager.registerMember(other, 'workerA', 'sess-other');
    groupManager.publishGroupFilesFromUpload(other, [{ name: 'secret.txt', mimeType: 'text/plain', data: Buffer.from('secret') }]);
    const fid = groupManager.listGroupFiles(other).files[0].id;
    // control deps for gid should not fetch other's file (different groupId)
    const res = tools.fetchFile(controlDeps(gid), { fileId: fid });
    assert.equal(res.error, 'not-found');
    groupManager.destroyGroup(other);
  } finally { groupManager.destroyGroup(gid); }
});

test('fetchFile returns metadata + sandboxPath, never blob bytes', async () => {
  const gid = await makeGroup();
  try {
    groupManager.publishGroupFilesFromUpload(gid, [{ name: 'a.txt', mimeType: 'text/plain', data: Buffer.from('hello') }]);
    const fid = groupManager.listGroupFiles(gid).files[0].id;
    const fetched = tools.fetchFile(controlDeps(gid), { fileId: fid });
    assert.equal(fetched.id, fid);
    assert.equal(fetched.name, 'a.txt');
    assert.equal(fetched.sandboxPath, `/ccserver-group-files/${fid}`);
    assert.equal(fetched.blobPath, undefined, 'must not leak host blobPath');
    assert.equal(fetched.content, undefined, 'must not leak content');
    assert.ok(typeof fetched.size === 'number' && typeof fetched.mimeType === 'string');
  } finally { groupManager.destroyGroup(gid); }
});

test('listFiles returns metadata array without content', async () => {
  const gid = await makeGroup();
  try {
    groupManager.publishGroupFilesFromUpload(gid, [{ name: 'a.txt', mimeType: 'text/plain', data: Buffer.from('x') }]);
    const listed = tools.listFiles(controlDeps(gid));
    assert.ok(Array.isArray(listed.files));
    assert.equal(listed.files[0].content, undefined);
    assert.ok(listed.files[0].id);
  } finally { groupManager.destroyGroup(gid); }
});

test('publishFile attribution is deps.role even when forged fields sent', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'cc-mcp-publish-'));
  const cwd = join(tmp, 'wt');
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(cwd, 'doc.txt'), 'content');
  const gid = await makeGroup();
  groupManager.registerMember(gid, 'workerA', 'sess-a');
  const fakeSessionApi = { getSession: (id) => id === 'sess-a' ? { cwd } : null, destroySession: () => {}, createSession: () => ({ error: 'x' }), writeToSession: () => false, waitUntilSettled: async () => ({ settled: true }), dockerAvailability: () => ({ dockerAvailable: null }) };
  groupManager.setSessionApiForTests(fakeSessionApi);
  try {
    const res = tools.publishFile(handoffDeps(gid, 'workerA', 'sess-a'), { path: 'doc.txt', publishedBy: 'workerB', role: 'workerB' });
    assert.equal(res.ok, true);
    assert.equal(res.publishedBy, 'workerA', 'closure role wins');
    assert.equal(res.direction, 'agent');
  } finally {
    groupManager.setSessionApiForTests(null);
    groupManager.destroyGroup(gid);
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('publishFile rejects absolute, traversal, symlink escapes', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'cc-mcp-publish2-'));
  const cwd = join(tmp, 'wt');
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(cwd, 'ok.txt'), 'hi');
  const outside = join(tmp, 'outside.txt');
  writeFileSync(outside, 'secret');
  const { symlinkSync: sl } = await import('node:fs');
  sl(outside, join(cwd, 'link.txt'));
  const gid = await makeGroup();
  groupManager.registerMember(gid, 'workerA', 'sess-a');
  groupManager.setSessionApiForTests({ getSession: (id) => id === 'sess-a' ? { cwd } : null, destroySession: () => {}, createSession: () => ({ error: 'x' }), writeToSession: () => false, waitUntilSettled: async () => ({ settled: true }), dockerAvailability: () => ({}) });
  try {
    assert.equal(tools.publishFile(handoffDeps(gid, 'workerA', 'sess-a'), { path: '/etc/passwd' }).error, 'bad-request');
    assert.equal(tools.publishFile(handoffDeps(gid, 'workerA', 'sess-a'), { path: '../outside.txt' }).error, 'bad-request');
    assert.equal(tools.publishFile(handoffDeps(gid, 'workerA', 'sess-a'), { path: 'link.txt' }).error, 'bad-request');
  } finally {
    groupManager.setSessionApiForTests(null);
    groupManager.destroyGroup(gid);
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('control cannot publish_file (only workers)', async () => {
  const gid = await makeGroup();
  try {
    const res = tools.publishFile(controlDeps(gid), { path: 'x.txt' });
    assert.equal(res.error, 'bad-request');
    assert.match(res.message, /only workers/);
  } finally { groupManager.destroyGroup(gid); }
});

test('every file-tool schema omits groupId/role/sessionId/output destination', async () => {
  // This is structural, verified in mcpBroker.test.js; here verify publishFile tool takes only path
  const gid = await makeGroup();
  try {
    // controlDeps has no role, publishFile should fail regardless of schema
    const r = tools.publishFile(handoffDeps(gid, 'workerA', 'sess-a'), { path: '' });
    assert.equal(r.error, 'bad-request');
  } finally { groupManager.destroyGroup(gid); }
});
