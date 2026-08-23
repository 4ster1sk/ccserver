// Settings page sandbox management: GET /api/sandboxes lists created
// persistent sandboxes (name/real-path/label/gitRemote/size/inUse, plus
// `deleting` / `deleteError` while a removal is in flight or just failed);
// DELETE /api/sandboxes/:name answers 204 immediately and removes the HOME +
// matching docker data-root in the background. The in-use (409), dockerd-lock
// (409) and already-in-flight (409) branches are checked synchronously; here
// we exercise the filesystem-backed paths with the SQLite bookkeeping rows.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sandboxesRoute } from './sandboxes.js';
import { sandboxHomeRoot, clearSandboxSizeCache, beginSandboxDelete, endSandboxDelete } from '../ws/sandbox.js';
import { recordSandboxHome, listSandboxRowsBySlug } from '../ws/projects.js';
import { closeDb } from '../db.js';

let tmpRoot;
let app;

function slugFromCwd(cwd) {
  return cwd.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'root';
}

async function list() {
  const res = await app.inject({ method: 'GET', url: '/api/sandboxes' });
  assert.equal(res.statusCode, 200);
  return res.json().sandboxes;
}

async function del(name) {
  return app.inject({ method: 'DELETE', url: `/api/sandboxes/${name}` });
}

async function waitFor(fn, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('waitFor: timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
}

before(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'ccserver-sandboxes-'));
  process.env.CCSERVER_SANDBOX_HOME_ROOT = join(tmpRoot, 'home');
  process.env.CCSERVER_SANDBOX_DIND_ROOT = join(tmpRoot, 'dind');
  // The bookkeeping rows live in SQLite now; point the store at a temp DB.
  process.env.CCSERVER_DB_PATH = join(tmpRoot, 'test.sqlite3');
  mkdirSync(join(tmpRoot, 'home'), { recursive: true });
  mkdirSync(join(tmpRoot, 'dind'), { recursive: true });
  clearSandboxSizeCache();
  app = Fastify();
  await app.register(sandboxesRoute, { prefix: '/api' });
});

after(async () => {
  closeDb();
  delete process.env.CCSERVER_SANDBOX_HOME_ROOT;
  delete process.env.CCSERVER_SANDBOX_DIND_ROOT;
  delete process.env.CCSERVER_DB_PATH;
  clearSandboxSizeCache();
  try { await app.close(); } catch { /* ignore */ }
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

test('GET /api/sandboxes: empty when no sandboxes exist', async () => {
  assert.deepEqual(await list(), []);
});

test('GET /api/sandboxes serves sizes from a short-TTL cache', async () => {
  const cwd = '/srv/cached';
  const slug = slugFromCwd(cwd);
  clearSandboxSizeCache();
  const dir = join(sandboxHomeRoot(), slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'blob'), 'c'.repeat(1024));
  try {
    const first = (await list()).find((s) => s.name === slug);
    assert.ok(first.size >= 1024, 'first read measures the directory');
    // Grow the tree: within the TTL the next read still reports the memoized
    // size instead of re-running du (which would report the larger value).
    writeFileSync(join(dir, 'blob2'), 'd'.repeat(4096));
    const second = (await list()).find((s) => s.name === slug);
    assert.equal(second.size, first.size, 'second read within the TTL is served from the cache');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    clearSandboxSizeCache();
  }
});

test('GET /api/sandboxes: lists created sandboxes with real path, size and inUse', async () => {
  const cwdA = '/srv/alpha';
  const cwdB = '/srv/beta';
  const slugA = slugFromCwd(cwdA);
  const slugB = slugFromCwd(cwdB);
  // Two sandbox homes with different content sizes, one bookkeeping row.
  mkdirSync(join(sandboxHomeRoot(), slugA, '.config'), { recursive: true });
  writeFileSync(join(sandboxHomeRoot(), slugA, '.config', 'tool'), 'x'.repeat(4096));
  mkdirSync(join(sandboxHomeRoot(), slugB), { recursive: true });
  writeFileSync(join(sandboxHomeRoot(), slugB, 'cache'), 'y'.repeat(2048));
  assert.equal(recordSandboxHome(cwdA), true, 'bookkeeping row recorded for sandbox A');

  const sandboxes = await list();
  assert.equal(sandboxes.length, 2, 'both sandboxes are listed');
  const a = sandboxes.find((s) => s.name === slugA);
  const b = sandboxes.find((s) => s.name === slugB);
  assert.ok(a, 'sandbox A present');
  assert.equal(a.cwd, cwdA, 'the store maps the slug back to the real project path');
  assert.ok(a.size >= 4096, 'size counts nested files');
  assert.equal(a.inUse, 0, 'no live sessions');
  assert.ok(b, 'sandbox B present');
  assert.equal(b.cwd, null, 'a sandbox without a bookkeeping row falls back to slug-only');
  assert.ok(b.size >= 2048);
});

test('DELETE /api/sandboxes/:name removes the HOME, matching dind root and store row', async () => {
  const cwd = '/srv/gamma';
  const slug = slugFromCwd(cwd);
  mkdirSync(join(sandboxHomeRoot(), slug), { recursive: true });
  writeFileSync(join(sandboxHomeRoot(), slug, 'state'), 'z');
  mkdirSync(join(process.env.CCSERVER_SANDBOX_DIND_ROOT, slug), { recursive: true });
  recordSandboxHome(cwd);

  const res = await del(slug);
  assert.equal(res.statusCode, 204, 'the request returns immediately');
  await waitFor(() => !existsSync(join(sandboxHomeRoot(), slug))
    && !existsSync(join(process.env.CCSERVER_SANDBOX_DIND_ROOT, slug)));
  assert.equal(listSandboxRowsBySlug().has(slug), false, 'store row cleared');
});

test('DELETE /api/sandboxes/:name refuses while a dockerd holds the data-root lock', async () => {
  const cwd = '/srv/locked';
  const slug = slugFromCwd(cwd);
  const dind = join(process.env.CCSERVER_SANDBOX_DIND_ROOT, slug);
  mkdirSync(dind, { recursive: true });
  writeFileSync(join(dind, 'state'), 'z');
  const lock = join(dind, '.ccserver-dockerd.lock');
  const proc = spawn('flock', [lock, 'sleep', '30'], { stdio: 'ignore' });
  try {
    // Wait until the child actually holds the lock.
    const deadline = Date.now() + 3000;
    let held = false;
    while (Date.now() < deadline) {
      if (spawnSync('flock', ['-n', lock, 'true'], { stdio: 'ignore' }).status !== 0) {
        held = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(held, 'the flock holder should be observable');
    const res = await del(slug);
    assert.equal(res.statusCode, 409, 'a held lock must refuse deletion');
    assert.equal(existsSync(dind), true, 'data-root must be left untouched');
  } finally {
    proc.kill();
    await new Promise((r) => proc.once('exit', r));
  }
});

test('DELETE /api/sandboxes/:name surfaces a clean error through the list when the dind root cannot be removed', async (t) => {
  const cwd = '/srv/stuck';
  const slug = slugFromCwd(cwd);
  const dind = join(process.env.CCSERVER_SANDBOX_DIND_ROOT, slug);
  const snap = join(dind, 'snap');
  mkdirSync(snap, { recursive: true });
  writeFileSync(join(snap, 'layer'), 'x');
  // A bind mount on an entry makes the removal fail with EBUSY, like a live
  // container's overlayfs mountpoint -- every removal strategy must give up
  // and surface a clean message via GET's deleteError instead of an opaque
  // Fastify 500 (the DELETE itself answers 204 immediately).
  let mounted = false;
  try {
    execFileSync('mount', ['--bind', snap, snap], { stdio: 'ignore' });
    mounted = true;
  } catch {
    // mount not permitted in this environment (nested sandbox): skip.
  }
  try {
    if (!mounted) {
      t.skip('mount --bind unavailable');
      return;
    }
    const res = await del(slug);
    assert.equal(res.statusCode, 204, 'the request returns immediately even though removal will fail');
    const entry = await waitFor(async () => {
      const found = (await list()).find((s) => s.name === slug);
      return found && !found.deleting && found.deleteError ? found : null;
    });
    assert.ok(typeof entry.deleteError === 'string' && entry.deleteError.length > 0,
      'a clean error message is exposed on the list');
    assert.notEqual(entry.deleteError, 'Internal Server Error', 'must not be the opaque Fastify 500');
    assert.equal(existsSync(dind), true, 'the stuck data-root is left in place for a retry');
  } finally {
    if (mounted) {
      try { execFileSync('umount', [snap], { stdio: 'ignore' }); } catch { /* ignore */ }
    }
  }
});

test('DELETE /api/sandboxes/:name refuses path-like names', async () => {
  // Whatever the exact status (Fastify normalizes traversal-like segments to
  // 404 before the handler; the handler 400s anything it does see), a path-like
  // name must never delete anything.
  for (const bad of ['..', '../home', 'a/b', 'a\\b', '', 'a b', '-x']) {
    const res = await del(bad);
    assert.ok(res.statusCode >= 400 && res.statusCode !== 200,
      `name ${JSON.stringify(bad)} must be rejected (got ${res.statusCode})`);
  }
});

test('GET /api/sandboxes retires a synthesized error row once the leftovers are cleaned up manually', async (t) => {
  const cwd = '/srv/manual-cleanup';
  const slug = slugFromCwd(cwd);
  const dind = join(process.env.CCSERVER_SANDBOX_DIND_ROOT, slug);
  const snap = join(dind, 'snap');
  mkdirSync(snap, { recursive: true });
  writeFileSync(join(snap, 'layer'), 'x');
  let mounted = false;
  try {
    try {
      execFileSync('mount', ['--bind', snap, snap], { stdio: 'ignore' });
      mounted = true;
    } catch {
      console.log('skipping: bind mounts unavailable');
      return;
    }
    const res = await del(slug);
    assert.equal(res.statusCode, 204);
    await waitFor(async () => {
      const found = (await list()).find((s) => s.name === slug);
      return found && !found.deleting && found.deleteError ? found : null;
    });
    // Follow the error message's own instruction and remove the leftovers by
    // hand: the phantom row must disappear from the list instead of lingering
    // until restart.
    execFileSync('umount', [snap], { stdio: 'ignore' });
    mounted = false;
    rmSync(dind, { recursive: true, force: true });
    await waitFor(async () => !(await list()).some((s) => s.name === slug));
  } finally {
    if (mounted) {
      try { execFileSync('umount', [snap], { stdio: 'ignore' }); } catch { /* ignore */ }
    }
    rmSync(dind, { recursive: true, force: true });
  }
});

test('DELETE /api/sandboxes/:name refuses while a deletion of the same slug is already in flight', async () => {
  const cwd = '/srv/inflight';
  const slug = slugFromCwd(cwd);
  const home = join(sandboxHomeRoot(), slug);
  mkdirSync(join(home, 'data'), { recursive: true });
  writeFileSync(join(home, 'data', 'keepme'), 'x');
  beginSandboxDelete(slug); // simulate a background removal currently running
  try {
    const res = await del(slug);
    assert.equal(res.statusCode, 409, 'a second kick must not race the running one');
    assert.equal(existsSync(join(home, 'data', 'keepme')), true,
      'the refused request must not have removed anything');
  } finally {
    endSandboxDelete(slug);
  }
});

test('GET /api/sandboxes synthesizes a deleting row for an in-flight slug with no HOME left', async () => {
  // Mid-deletion the HOME may already be gone (it is removed first): without
  // synthesis the row would vanish and the client would stop polling.
  const slug = slugFromCwd('/srv/ghost');
  mkdirSync(join(sandboxHomeRoot(), slug), { recursive: true });
  rmSync(join(sandboxHomeRoot(), slug), { recursive: true, force: true }); // ensure truly absent
  beginSandboxDelete(slug);
  try {
    const entry = (await list()).find((s) => s.name === slug);
    assert.ok(entry, 'the row stays visible while the deletion runs');
    assert.equal(entry.deleting, true);
    assert.equal(entry.deleteError, null);
  } finally {
    endSandboxDelete(slug);
  }
});
