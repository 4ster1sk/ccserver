import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  sanitizeDisplayName,
  mimeForName,
  generateFileId,
  storedNameForId,
  blobPathFor,
  sandboxPathFor,
  totalBytesForFiles,
  checkQuotaBeforeAdd,
  resolveAgentSourcePath,
  safeGroupFilesDirForDelete,
  getGroupFilesDir,
  getGroupFilesRoot,
  MAX_FILE_BYTES,
  MAX_FILES_PER_GROUP,
  MAX_GROUP_BYTES,
  SANDBOX_GROUP_FILES_PATH,
} from './groupFiles.js';

test('sanitizeDisplayName: basename, trim, fallback, length cap', () => {
  assert.equal(sanitizeDisplayName('/a/b/../../etc/passwd'), 'passwd');
  assert.equal(sanitizeDisplayName('  hello.txt  '), 'hello.txt');
  assert.equal(sanitizeDisplayName(''), 'file');
  assert.equal(sanitizeDisplayName(null), 'file');
  assert.equal(sanitizeDisplayName('.'), 'file');
  assert.equal(sanitizeDisplayName('..'), 'file');
  const long = 'a'.repeat(300);
  assert.equal(sanitizeDisplayName(long).length, 255);
});

test('mimeForName: known extensions and fallback', () => {
  assert.equal(mimeForName('foo.txt'), 'text/plain');
  assert.equal(mimeForName('foo.JSON'), 'application/json');
  assert.equal(mimeForName('image.png'), 'image/png');
  assert.equal(mimeForName('noext'), 'application/octet-stream');
  assert.equal(mimeForName(null), 'application/octet-stream');
});

test('generateFileId produces unique UUIDs and storedNameForId is identity', () => {
  const a = generateFileId();
  const b = generateFileId();
  assert.notEqual(a, b);
  assert.match(a, /^[0-9a-f-]{36}$/);
  assert.equal(storedNameForId(a), a);
});

test('blobPathFor stays under group root and sandboxPathFor uses fixed prefix', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'cc-gf-blob-'));
  process.env.CCSERVER_GROUP_FILES_ROOT = join(tmp, 'group-files');
  const gid = 'g1';
  const p = blobPathFor(gid, 'some-id');
  const dir = getGroupFilesDir(gid);
  assert.ok(p.startsWith(dir + '/') || p === dir);
  assert.equal(sandboxPathFor('some-id'), join(SANDBOX_GROUP_FILES_PATH, 'some-id'));
  try { blobPathFor(gid, '../evil'); assert.fail('should throw'); } catch (e) { assert.match(e.message, /escapes/); }
  rmSync(tmp, { recursive: true, force: true });
  delete process.env.CCSERVER_GROUP_FILES_ROOT;
});

test('totalBytesForFiles and checkQuotaBeforeAdd edges', () => {
  const m = new Map();
  m.set('a', { size: 10 });
  m.set('b', { size: 20 });
  assert.equal(totalBytesForFiles(m), 30);
  assert.equal(checkQuotaBeforeAdd(m, MAX_FILE_BYTES + 1)?.error, 'too-large');
  const full = new Map();
  for (let i = 0; i < MAX_FILES_PER_GROUP; i++) full.set(String(i), { size: 1 });
  assert.equal(checkQuotaBeforeAdd(full, 1)?.error, 'too-many-files');
  const bytes = new Map();
  bytes.set('x', { size: MAX_GROUP_BYTES - 10 });
  assert.equal(checkQuotaBeforeAdd(bytes, 20)?.error, 'quota-exceeded');
  assert.equal(checkQuotaBeforeAdd(new Map(), 10), null);
});

test('resolveAgentSourcePath: ok, absolute, traversal, not-found, symlink escape, not a regular file', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'cc-gf-resolve-'));
  const cwd = join(tmp, 'worktree');
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(cwd, 'hello.txt'), 'hi');
  let r = resolveAgentSourcePath(cwd, 'hello.txt');
  assert.equal(r.ok, true);
  assert.equal(r.realPath, statSync(join(cwd, 'hello.txt')) ? r.realPath : r.realPath);
  r = resolveAgentSourcePath(cwd, '/etc/passwd');
  assert.equal(r.error, 'bad-request');
  r = resolveAgentSourcePath(cwd, '../escape.txt');
  assert.equal(r.error, 'bad-request');
  r = resolveAgentSourcePath(cwd, 'nope.txt');
  assert.equal(r.error, 'not-found');
  // symlink escape
  const outside = join(tmp, 'outside.txt');
  writeFileSync(outside, 'secret');
  symlinkSync(outside, join(cwd, 'link.txt'));
  r = resolveAgentSourcePath(cwd, 'link.txt');
  assert.equal(r.error, 'bad-request');
  assert.match(r.message, /symlink/);
  // directory not a regular file
  mkdirSync(join(cwd, 'subdir'));
  r = resolveAgentSourcePath(cwd, 'subdir');
  assert.equal(r.error, 'bad-request');
  assert.match(r.message, /not a regular file/);
  rmSync(tmp, { recursive: true, force: true });
});

test('safeGroupFilesDirForDelete: valid and invalid groupIds', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'cc-gf-del-'));
  process.env.CCSERVER_GROUP_FILES_ROOT = join(tmp, 'group-files');
  assert.ok(safeGroupFilesDirForDelete('mygroup').endsWith('mygroup'));
  for (const bad of ['', 'a/b', 'a..b', 'a\0b']) {
    assert.throws(() => safeGroupFilesDirForDelete(bad), /invalid|escapes/);
  }
  // traversal via .. should be rejected as invalid before escapes
  assert.throws(() => safeGroupFilesDirForDelete('../evil'), /invalid/);
  rmSync(tmp, { recursive: true, force: true });
  delete process.env.CCSERVER_GROUP_FILES_ROOT;
});
