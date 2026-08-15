// Settings page sandbox management: GET /api/sandboxes lists created
// persistent sandboxes (name/real-path/size/inUse); DELETE /api/sandboxes/:name
// removes the HOME + matching docker data-root and clears the index entry.
// The in-use (409) branch depends on live sessions (covered by the pure
// sandboxHomeConflict tests); here we exercise the filesystem-backed paths.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sandboxesRoute } from './sandboxes.js';
import { sandboxHomeRoot } from '../ws/sandbox.js';

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

before(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'ccserver-sandboxes-'));
  process.env.CCSERVER_SANDBOX_HOME_ROOT = join(tmpRoot, 'home');
  process.env.CCSERVER_SANDBOX_DIND_ROOT = join(tmpRoot, 'dind');
  mkdirSync(join(tmpRoot, 'home'), { recursive: true });
  mkdirSync(join(tmpRoot, 'dind'), { recursive: true });
  app = Fastify();
  await app.register(sandboxesRoute, { prefix: '/api' });
});

after(async () => {
  delete process.env.CCSERVER_SANDBOX_HOME_ROOT;
  delete process.env.CCSERVER_SANDBOX_DIND_ROOT;
  try { await app.close(); } catch { /* ignore */ }
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

test('GET /api/sandboxes: empty when no sandboxes exist', async () => {
  assert.deepEqual(await list(), []);
});

test('GET /api/sandboxes: lists created sandboxes with real path, size and inUse', async () => {
  const cwdA = '/srv/alpha';
  const cwdB = '/srv/beta';
  const slugA = slugFromCwd(cwdA);
  const slugB = slugFromCwd(cwdB);
  // Two sandbox homes with different content sizes, one index entry.
  mkdirSync(join(sandboxHomeRoot(), slugA, '.config'), { recursive: true });
  writeFileSync(join(sandboxHomeRoot(), slugA, '.config', 'tool'), 'x'.repeat(4096));
  mkdirSync(join(sandboxHomeRoot(), slugB), { recursive: true });
  writeFileSync(join(sandboxHomeRoot(), slugB, 'cache'), 'y'.repeat(2048));
  writeFileSync(join(sandboxHomeRoot(), '.index.json'), JSON.stringify({ [slugA]: cwdA }));

  const sandboxes = await list();
  assert.equal(sandboxes.length, 2, 'both sandboxes are listed');
  const a = sandboxes.find((s) => s.name === slugA);
  const b = sandboxes.find((s) => s.name === slugB);
  assert.ok(a, 'sandbox A present');
  assert.equal(a.cwd, cwdA, 'index maps the slug back to the real project path');
  assert.ok(a.size >= 4096, 'size counts nested files');
  assert.equal(a.inUse, 0, 'no live sessions');
  assert.ok(b, 'sandbox B present');
  assert.equal(b.cwd, null, 'a sandbox without an index entry falls back to slug-only');
  assert.ok(b.size >= 2048);
});

test('DELETE /api/sandboxes/:name removes the HOME, matching dind root and index entry', async () => {
  const cwd = '/srv/gamma';
  const slug = slugFromCwd(cwd);
  mkdirSync(join(sandboxHomeRoot(), slug), { recursive: true });
  writeFileSync(join(sandboxHomeRoot(), slug, 'state'), 'z');
  mkdirSync(join(process.env.CCSERVER_SANDBOX_DIND_ROOT, slug), { recursive: true });
  const index = join(sandboxHomeRoot(), '.index.json');
  writeFileSync(index, JSON.stringify({ [slug]: cwd }));

  const res = await del(slug);
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().success, true);
  assert.equal(existsSync(join(sandboxHomeRoot(), slug)), false, 'HOME removed');
  assert.equal(existsSync(join(process.env.CCSERVER_SANDBOX_DIND_ROOT, slug)), false, 'docker data-root removed');
  const afterIndex = JSON.parse(readFileSync(index, 'utf-8'));
  assert.equal(afterIndex[slug], undefined, 'index entry cleared');
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
