import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSandboxSpawn } from './sandbox.js';
import { getGroupFilesDir } from './groupFiles.js';

test('sandbox: group member gets read-only bind at /ccserver-group-files, standalone does not', () => {
  const cwd = '/tmp';
  const groupId = 'test-group-id';
  const groupFilesDir = getGroupFilesDir(groupId);
  // standalone: groupFilesDir null -> no bind
  const standalone = buildSandboxSpawn({ cwd, targetCommand: ['/bin/true'], app: 'claude', groupFilesDir: null });
  const standaloneArgs = standalone.args.join(' ');
  assert.equal(standaloneArgs.includes('/ccserver-group-files'), false, 'standalone must not bind group files');

  // group member: explicit dir -> ro-bind-try
  const member = buildSandboxSpawn({ cwd, targetCommand: ['/bin/true'], app: 'claude', groupFilesDir });
  const args = member.args.join(' ');
  assert.ok(args.includes('--ro-bind-try'), 'group bind is present');
  assert.ok(args.includes('/ccserver-group-files'), 'fixed sandbox path present');
  assert.ok(args.includes(groupFilesDir), 'host dir present');
  // Ensure it's ro-bind-try, not rw
  const idx = member.args.indexOf('--ro-bind-try');
  assert.notEqual(idx, -1);
  assert.equal(member.args[idx + 2], '/ccserver-group-files');
});

test('sandbox: groupFilesDir is auto-resolved for sandboxed group sessions', async () => {
  const { mkdtempSync, rmSync, existsSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const tmp = mkdtempSync(join(tmpdir(), 'cc-sb-fallback-'));
  process.env.CCSERVER_GROUP_FILES_ROOT = join(tmp, 'group-files');
  // Verify that a group member's host dir is ensured and bound read-only
  const groupId = 'fallback-gid';
  const { getGroupFilesDir, ensureGroupFilesDir } = await import('./groupFiles.js');
  const dir = getGroupFilesDir(groupId);
  ensureGroupFilesDir(groupId);
  assert.ok(existsSync(dir), 'ensureGroupFilesDir creates the host dir');
  const spawn = buildSandboxSpawn({ cwd: '/tmp', targetCommand: ['/bin/true'], app: 'claude', groupFilesDir: dir });
  assert.ok(spawn.args.join(' ').includes('/ccserver-group-files'), 'auto-resolved dir is bound');
  rmSync(tmp, { recursive: true, force: true });
  delete process.env.CCSERVER_GROUP_FILES_ROOT;
});
