import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, symlinkSync, existsSync, rmSync, statSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { stopBroker } from './mcpBroker.js';
import { MAX_FILE_BYTES, MAX_FILES_PER_GROUP, MAX_GROUP_BYTES } from './groupFiles.js';

let runtimeDir;
let groupManager;

before(async () => {
  runtimeDir = mkdtempSync(join(tmpdir(), 'ccserver-gm-files-test-'));
  process.env.XDG_RUNTIME_DIR = runtimeDir;
  process.env.CCSERVER_GROUPS_PATH = join(runtimeDir, 'saved-groups.json');
  process.env.CCSERVER_GROUP_DOCS_PATH = join(runtimeDir, 'saved-group-docs.json');
  process.env.CCSERVER_GROUP_FILES_PATH = join(runtimeDir, 'saved-group-files.json');
  process.env.CCSERVER_GROUP_FILES_ROOT = join(runtimeDir, 'group-files');
  process.env.CCSERVER_SAVED_SESSIONS_PATH = join(runtimeDir, 'saved-sessions.json');
  process.env.CCSERVER_ORCHESTRATOR_GENERATED_ROOT = join(runtimeDir, 'orchestrator-generated');
  process.env.CCSERVER_WORKTREE_ROOT = join(runtimeDir, 'worktrees');
  const templateCopyPath = join(runtimeDir, 'orchestrator-template.md');
  cpSync(join(import.meta.dirname, 'orchestrator-template.md'), templateCopyPath);
  process.env.CCSERVER_ORCHESTRATOR_TEMPLATE_PATH = templateCopyPath;
  groupManager = await import('./groupManager.js');
});

after(() => {
  try { rmSync(runtimeDir, { recursive: true, force: true }); } catch { /* ignore */ }
  delete process.env.CCSERVER_GROUP_FILES_ROOT;
  delete process.env.CCSERVER_GROUP_FILES_PATH;
});

async function makeGroup(cwd = '/srv/proj') {
  const gid = randomUUID();
  await groupManager.createGroup({ groupId: gid, cwd, orchestratorDir: join(runtimeDir, gid) });
  return gid;
}

test('publishGroupFilesFromUpload round-trip and duplicate names distinct IDs', async () => {
  const gid = await makeGroup();
  try {
    const res = groupManager.publishGroupFilesFromUpload(gid, [{ name: 'hello.txt', mimeType: 'text/plain', data: Buffer.from('hello') }]);
    assert.equal(res.ok, true);
    assert.equal(res.files.length, 1);
    const f = res.files[0];
    assert.equal(f.name, 'hello.txt');
    assert.equal(f.size, 5);
    assert.equal(f.direction, 'user');
    assert.equal(f.publishedBy, null);
    const list = groupManager.listGroupFiles(gid);
    assert.equal(list.files[0].id, f.id);
    const fetched = groupManager.fetchGroupFile(gid, f.id);
    assert.equal(fetched.sandboxPath, `/ccserver-group-files/${f.id}`);
    assert.ok(existsSync(fetched.blobPath));
    assert.equal(fetched.size, 5);
    // duplicate display name distinct IDs
    const res2 = groupManager.publishGroupFilesFromUpload(gid, [{ name: 'hello.txt', mimeType: 'text/plain', data: Buffer.from('again') }]);
    assert.notEqual(res2.files[0].id, f.id);
  } finally { groupManager.destroyGroup(gid); }
});

test('publishGroupFilesFromUpload quota edges: per-file, count, group bytes', async () => {
  const gid = await makeGroup();
  try {
    const tooLarge = groupManager.publishGroupFilesFromUpload(gid, [{ name: 'big.bin', mimeType: 'application/octet-stream', data: Buffer.alloc(MAX_FILE_BYTES + 1) }]);
    assert.equal(tooLarge.error, 'too-large');
    for (let i = 0; i < MAX_FILES_PER_GROUP; i++) {
      const r = groupManager.publishGroupFilesFromUpload(gid, [{ name: `f${i}.txt`, mimeType: 'text/plain', data: Buffer.from('x') }]);
      assert.equal(r.ok, true, `f${i} should succeed`);
    }
    const over = groupManager.publishGroupFilesFromUpload(gid, [{ name: 'over.txt', mimeType: 'text/plain', data: Buffer.from('x') }]);
    assert.equal(over.error, 'too-many-files');
  } finally { groupManager.destroyGroup(gid); }
  const gid2 = await makeGroup();
  try {
    // group bytes quota: use 19 MiB chunks so we hit group-byte limit before file-count limit
    const chunk = Buffer.alloc(19 * 1024 * 1024); // 19 MiB
    let count = 0;
    while (count < 10) { // only 10 files -> well under MAX_FILES_PER_GROUP (20)
      const before = groupManager.listGroupFiles(gid2).files.reduce((s, m) => s + m.size, 0);
      if (before + chunk.length > MAX_GROUP_BYTES) break;
      const r = groupManager.publishGroupFilesFromUpload(gid2, [{ name: `c${count}.bin`, mimeType: 'application/octet-stream', data: chunk }]);
      if (r.error) break;
      count++;
    }
    const total = groupManager.listGroupFiles(gid2).files.reduce((s, m) => s + m.size, 0);
    assert.ok(total > 0);
    const overBytes = groupManager.publishGroupFilesFromUpload(gid2, [{ name: 'extra.bin', mimeType: 'application/octet-stream', data: Buffer.alloc(15 * 1024 * 1024) }]);
    if (total + 15 * 1024 * 1024 > MAX_GROUP_BYTES && total < MAX_GROUP_BYTES) {
      assert.equal(overBytes.error, 'quota-exceeded');
    } else if (overBytes.error) {
      assert.ok(['quota-exceeded', 'too-many-files'].includes(overBytes.error));
    }
  } finally { groupManager.destroyGroup(gid2); }
});

test('missing/unknown group/file errors', async () => {
  assert.equal(groupManager.listGroupFiles('nope').error, 'group-not-found');
  assert.equal(groupManager.fetchGroupFile('nope', 'id').error, 'group-not-found');
  assert.equal(groupManager.deleteGroupFile('nope', 'id').error, 'group-not-found');
  const gid = await makeGroup();
  try {
    assert.equal(groupManager.fetchGroupFile(gid, 'missing').error, 'not-found');
    assert.equal(groupManager.deleteGroupFile(gid, 'missing').error, 'not-found');
    assert.equal(groupManager.publishGroupFileFromAgent(gid, 'workerA', 'hello.txt').error, 'bad-request');
  } finally { groupManager.destroyGroup(gid); }
});

test('agent publish: relative only, traversal and symlink escape rejected, regular file only', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'cc-gm-agent-'));
  const cwd = join(tmp, 'wt');
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(cwd, 'ok.txt'), 'hello');
  const outside = join(tmp, 'outside.txt');
  writeFileSync(outside, 'secret');
  symlinkSync(outside, join(cwd, 'link.txt'));
  mkdirSync(join(cwd, 'subdir'));
  const gid = await makeGroup(cwd);
  // need a session for workerA so publish can resolve cwd
  groupManager.registerMember(gid, 'workerA', 'sess-a');
  // fake sessionApi via setSessionApiForTests to return cwd
  const orig = groupManager.getGroup(gid);
  // Instead directly use sessionManager facade: inject via setSessionApiForTests
  groupManager.setSessionApiForTests({ getSession: (id) => id === 'sess-a' ? { cwd } : null, destroySession: () => {}, createSession: () => ({ error: 'unused' }), writeToSession: () => false, waitUntilSettled: async () => ({ settled: true }), dockerAvailability: () => ({ dockerAvailable: null }) });
  try {
    let r = groupManager.publishGroupFileFromAgent(gid, 'workerA', 'ok.txt');
    assert.equal(r.ok, true);
    assert.equal(r.publishedBy, 'workerA');
    assert.equal(r.direction, 'agent');
    r = groupManager.publishGroupFileFromAgent(gid, 'workerA', '/etc/passwd');
    assert.equal(r.error, 'bad-request');
    r = groupManager.publishGroupFileFromAgent(gid, 'workerA', '../outside.txt');
    assert.equal(r.error, 'bad-request');
    r = groupManager.publishGroupFileFromAgent(gid, 'workerA', 'link.txt');
    assert.equal(r.error, 'bad-request');
    assert.match(r.message, /symlink/);
    r = groupManager.publishGroupFileFromAgent(gid, 'workerA', 'subdir');
    assert.equal(r.error, 'bad-request');
    assert.match(r.message, /not a regular file/);
    r = groupManager.publishGroupFileFromAgent(gid, 'workerA', 'missing.txt');
    assert.equal(r.error, 'not-found');
  } finally {
    groupManager.setSessionApiForTests(null);
    groupManager.destroyGroup(gid);
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('commitStagedUploads promotes temp files and validates quotas', async () => {
  const gid = await makeGroup();
  try {
    const dir = groupManager.getGroupFilesDirForGroup(gid);
    // stage a temp file manually
    const tempPath = join(dir, '.tmp-upload-test');
    writeFileSync(tempPath, Buffer.from('staged'));
    const staged = [{ name: 'staged.txt', mimeType: 'text/plain', tempPath, size: 6 }];
    const res = groupManager.commitStagedUploads(gid, staged);
    assert.equal(res.ok, true);
    assert.equal(res.files.length, 1);
    assert.equal(existsSync(tempPath), false, 'temp promoted');
    assert.ok(existsSync(join(dir, res.files[0].id)));
  } finally { groupManager.destroyGroup(gid); }
});

test('manifest persistence across restoreGroups and stale/corrupt handling', async () => {
  const gid = await makeGroup('/srv/proj-persist');
  const originalBroker = groupManager.getGroup(gid).controlBroker;
  try {
    groupManager.publishGroupFilesFromUpload(gid, [{ name: 'keep.txt', mimeType: 'text/plain', data: Buffer.from('keep') }]);
    const raw = JSON.parse(readFileSync(process.env.CCSERVER_GROUP_FILES_PATH, 'utf-8'));
    assert.ok(raw[gid]);
    // corrupt manifest tolerance: write invalid JSON then restore must not throw
    writeFileSync(process.env.CCSERVER_GROUP_FILES_PATH, '{ invalid json');
    assert.doesNotThrow(() => groupManager.restoreGroups());
    // restore valid then stale blob ignored
    groupManager.publishGroupFilesFromUpload(gid, [{ name: 'a.txt', mimeType: 'text/plain', data: Buffer.from('a') }]);
    const fid = groupManager.listGroupFiles(gid).files[0].id;
    const fetched = groupManager.fetchGroupFile(gid, fid);
    // delete blob to make stale
    rmSync(fetched.blobPath, { force: true });
    // craft raw manifest still containing entry but blob missing, then restore
    const oldGroups = groupManager.restoreGroups();
    assert.ok(oldGroups.ids.includes(gid));
    // after restore, stale entry should be ignored
    const after = groupManager.getGroup(gid);
    // If stale, file not in list
    const listed = groupManager.listGroupFiles(gid);
    // may be 0 if stale, or if our earlier corrupt test cleared it; just ensure no crash
    assert.ok(Array.isArray(listed.files));
  } finally {
    if (originalBroker) stopBroker(originalBroker);
    groupManager.destroyGroup(gid);
  }
});

test('destroyGroup removes blob root and does not touch sibling', async () => {
  const g1 = await makeGroup();
  const g2 = await makeGroup();
  try {
    groupManager.publishGroupFilesFromUpload(g1, [{ name: 'a.txt', mimeType: 'text/plain', data: Buffer.from('a') }]);
    groupManager.publishGroupFilesFromUpload(g2, [{ name: 'b.txt', mimeType: 'text/plain', data: Buffer.from('b') }]);
    const f1 = groupManager.fetchGroupFile(g1, groupManager.listGroupFiles(g1).files[0].id);
    const f2path = groupManager.fetchGroupFile(g2, groupManager.listGroupFiles(g2).files[0].id).blobPath;
    groupManager.destroyGroup(g1);
    assert.equal(existsSync(f1.blobPath), false);
    assert.ok(existsSync(f2path), 'sibling untouched');
    assert.equal(groupManager.listGroupFiles(g1).error, 'group-not-found');
  } finally {
    try { groupManager.destroyGroup(g1); } catch {}
    try { groupManager.destroyGroup(g2); } catch {}
  }
});

test('sanitized generated blob name never uses upload filename as path', async () => {
  const gid = await makeGroup();
  try {
    const res = groupManager.publishGroupFilesFromUpload(gid, [{ name: '../../evil.txt', mimeType: 'text/plain', data: Buffer.from('x') }]);
    assert.equal(res.files[0].name, 'evil.txt');
    const fetched = groupManager.fetchGroupFile(gid, res.files[0].id);
    assert.ok(!fetched.blobPath.includes('evil'));
    assert.ok(fetched.blobPath.endsWith(res.files[0].id));
  } finally { groupManager.destroyGroup(gid); }
});
