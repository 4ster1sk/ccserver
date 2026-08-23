// Tests for groupManager's per-role git worktree integration (plan sections
// 1-3): addMember resolves each role's own worktree instead of trusting a
// caller-supplied cwd, removeMember/destroyGroup clean worktrees up, a
// non-git project cwd falls back to sharing it exactly like before this
// feature existed, and the orchestrator role is never given a worktree.
//
// Uses a REAL throwaway git repo as the group's cwd (worktree operations are
// cheap/local, mirrors worktree.test.js) but a FAKE sessionApi (like
// groupManager.test.js's addMember tests) so no real pty/sandbox is ever
// spawned.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

let runtimeDir;
let groupManager;
let repo;
let notGitDir;

function git(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf-8' });
}

before(async () => {
  runtimeDir = mkdtempSync(join(tmpdir(), 'ccserver-gm-worktree-test-'));
  process.env.XDG_RUNTIME_DIR = runtimeDir;
  process.env.CCSERVER_GROUPS_PATH = join(runtimeDir, 'saved-groups.json');
  process.env.CCSERVER_SAVED_SESSIONS_PATH = join(runtimeDir, 'saved-sessions.json');
  process.env.CCSERVER_ORCHESTRATOR_GENERATED_ROOT = join(runtimeDir, 'orchestrator-generated');
  process.env.CCSERVER_WORKTREE_ROOT = join(runtimeDir, 'worktrees');
  const templateCopyPath = join(runtimeDir, 'orchestrator-template.md');
  cpSync(join(import.meta.dirname, 'orchestrator-template.md'), templateCopyPath);
  process.env.CCSERVER_ORCHESTRATOR_TEMPLATE_PATH = templateCopyPath;
  groupManager = await import('./groupManager.js');

  repo = join(runtimeDir, 'repo');
  mkdirSync(repo, { recursive: true });
  git(repo, ['init', '-q']);
  git(repo, ['-c', 'user.name=t', '-c', 'user.email=t@t.com', 'commit', '-q', '--allow-empty', '-m', 'init']);

  notGitDir = join(runtimeDir, 'not-a-repo');
  mkdirSync(notGitDir, { recursive: true });
});

after(() => {
  try { rmSync(runtimeDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

function fakeSessionApi() {
  const created = [];
  return {
    api: {
      getSession: () => null,
      createSession: (opts) => { created.push(opts); return { sessionId: `sess-${created.length}`, session: {} }; },
      destroySession: () => {},
      writeToSession: () => false,
    },
    created,
  };
}

test('addMember resolves a worker role to its own git worktree, ignoring the wire cwd', async () => {
  const gid = randomUUID();
  await groupManager.createGroup({ groupId: gid, cwd: repo, orchestratorDir: join(runtimeDir, gid) });
  const { api, created } = fakeSessionApi();
  groupManager.setSessionApiForTests(api);
  try {
    const res = await groupManager.addMember(gid, 'workerA', { app: 'claude', cwd: '/completely/unrelated/path' });
    assert.equal(res.error, undefined, res.message || '');
    assert.notEqual(created[0].cwd, '/completely/unrelated/path');
    assert.equal(created[0].cwd, res.cwd);
    assert.ok(created[0].cwd.startsWith(process.env.CCSERVER_WORKTREE_ROOT), 'resolved cwd lives under the worktree root');
    assert.ok(created[0].gitCommonDir, 'gitCommonDir is threaded into session creation');
    assert.ok(existsSync(created[0].cwd));

    const group = groupManager.getGroup(gid);
    const wt = group.memberWorktrees.get('workerA');
    assert.ok(wt, 'the resolved worktree is tracked on the group record');
    assert.equal(wt.path, res.cwd);
  } finally {
    groupManager.setSessionApiForTests(null);
    groupManager.destroyGroup(gid);
  }
});

test('addMember falls back to sharing cwd for a non-git project (plan section 2.8)', async () => {
  const gid = randomUUID();
  await groupManager.createGroup({ groupId: gid, cwd: notGitDir, orchestratorDir: join(runtimeDir, gid) });
  const { api, created } = fakeSessionApi();
  groupManager.setSessionApiForTests(api);
  try {
    const res = await groupManager.addMember(gid, 'workerA', { app: 'claude' });
    assert.equal(res.error, undefined, res.message || '');
    assert.equal(res.cwd, notGitDir, 'non-git project: workers share the project cwd, same as before this feature');
    assert.equal(created[0].gitCommonDir, null);
    assert.equal(groupManager.getGroup(gid).memberWorktrees.size, 0, 'no worktree is tracked for a non-git project');
  } finally {
    groupManager.setSessionApiForTests(null);
    groupManager.destroyGroup(gid);
  }
});

test('resolveMemberLaunchCwd: the orchestrator role always gets orchestratorDir, never a worktree', async () => {
  const gid = randomUUID();
  const orchestratorDir = join(runtimeDir, `orch-${gid}`);
  await groupManager.createGroup({ groupId: gid, cwd: repo, orchestratorDir });
  try {
    const res = groupManager.resolveMemberLaunchCwd(gid, 'orchestrator');
    assert.deepEqual(res, { cwd: orchestratorDir, gitCommonDir: null });
  } finally {
    groupManager.destroyGroup(gid);
  }
});

test('removeMember deletes the role worktree from disk and from the group record', async () => {
  const gid = randomUUID();
  await groupManager.createGroup({ groupId: gid, cwd: repo, orchestratorDir: join(runtimeDir, gid) });
  const { api } = fakeSessionApi();
  groupManager.setSessionApiForTests(api);
  try {
    const res = await groupManager.addMember(gid, 'workerA', { app: 'claude' });
    const worktreePath = res.cwd;
    assert.ok(existsSync(worktreePath));

    groupManager.removeMember(gid, res.sessionId);
    assert.ok(!existsSync(worktreePath), 'worktree directory removed from disk');
    assert.equal(groupManager.getGroup(gid).memberWorktrees.has('workerA'), false, 'no longer tracked on the group record');
  } finally {
    groupManager.setSessionApiForTests(null);
    groupManager.destroyGroup(gid);
  }
});

test('destroyGroup removes every member worktree', async () => {
  const gid = randomUUID();
  await groupManager.createGroup({ groupId: gid, cwd: repo, orchestratorDir: join(runtimeDir, gid) });
  const { api } = fakeSessionApi();
  groupManager.setSessionApiForTests(api);
  let pathA;
  let pathB;
  try {
    pathA = (await groupManager.addMember(gid, 'workerA', { app: 'claude' })).cwd;
    pathB = (await groupManager.addMember(gid, 'workerB', { app: 'claude' })).cwd;
  } finally {
    groupManager.setSessionApiForTests(null);
  }
  assert.ok(existsSync(pathA) && existsSync(pathB));
  groupManager.destroyGroup(gid);
  assert.ok(!existsSync(pathA) && !existsSync(pathB), 'both worktrees removed on group destruction');
});

test('detectOrphanWorktrees flags a directory that belongs to no known group, without deleting it', async () => {
  // A leftover directory nothing currently tracks (simulates a removal that
  // failed, or a crash before persistence -- plan section 3.7-3).
  const orphanDir = join(process.env.CCSERVER_WORKTREE_ROOT, 'stale-hash', 'workerX');
  mkdirSync(orphanDir, { recursive: true });
  try {
    const orphans = groupManager.detectOrphanWorktrees();
    assert.ok(orphans.includes(orphanDir));
    assert.ok(existsSync(orphanDir), 'never deleted automatically -- diagnostic only');
  } finally {
    rmSync(join(process.env.CCSERVER_WORKTREE_ROOT, 'stale-hash'), { recursive: true, force: true });
  }
});

test('detectOrphanWorktrees does not flag a worktree that belongs to a live group', async () => {
  const gid = randomUUID();
  await groupManager.createGroup({ groupId: gid, cwd: repo, orchestratorDir: join(runtimeDir, gid) });
  const { api } = fakeSessionApi();
  groupManager.setSessionApiForTests(api);
  try {
    const res = await groupManager.addMember(gid, 'workerA', { app: 'claude' });
    const orphans = groupManager.detectOrphanWorktrees();
    assert.ok(!orphans.includes(res.cwd));
  } finally {
    groupManager.setSessionApiForTests(null);
    groupManager.destroyGroup(gid);
  }
});
