// Route-level tests for POST /api/dirs folder creation, focused on the
// opt-in gitInit flag: fixed `git init` argv run inside the freshly created
// directory, backward-compatible when omitted/false, and the directory is
// kept (with {error, path}) when git init itself fails.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dirsRoute } from './dirs.js';

let runtimeDir;
let app;
let realPath;

before(async () => {
  runtimeDir = mkdtempSync(join(tmpdir(), 'ccserver-dirs-route-'));
  app = Fastify();
  await app.register(dirsRoute, { prefix: '/api' });
  realPath = process.env.PATH;
});

after(async () => {
  try { await app.close(); } catch {}
  if (realPath !== undefined) process.env.PATH = realPath;
  try { rmSync(runtimeDir, { recursive: true, force: true }); } catch {}
});

test('POST /dirs creates the directory and git-inits it when gitInit is true', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/dirs',
    payload: { parent: runtimeDir, name: 'proj-git', gitInit: true },
  });
  assert.equal(res.statusCode, 200);
  const newPath = res.json().path;
  assert.equal(newPath, join(runtimeDir, 'proj-git'));
  assert.ok(existsSync(newPath), 'directory exists');
  assert.ok(existsSync(join(newPath, '.git')), '.git was created by git init');
});

test('POST /dirs stays mkdir-only when gitInit is omitted or false', async () => {
  for (const extra of [{}, { gitInit: false }]) {
    const name = `plain-${Object.keys(extra).length}-${extra.gitInit === false ? 'f' : 'u'}`;
    const res = await app.inject({
      method: 'POST',
      url: '/api/dirs',
      payload: { parent: runtimeDir, name, ...extra },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().path, join(runtimeDir, name));
    assert.ok(!existsSync(join(runtimeDir, name, '.git')), `no .git for ${name}`);
  }
});

test('POST /dirs rejects an existing directory with 409', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/dirs',
    payload: { parent: runtimeDir, name: 'proj-git', gitInit: true },
  });
  assert.equal(res.statusCode, 409);
  assert.match(res.json().error, /already exists/);
});

test('POST /dirs keeps rejecting traversal-ish names', async () => {
  for (const name of ['../escape', 'a/b', '.', '..']) {
    const res = await app.inject({ method: 'POST', url: '/api/dirs', payload: { parent: runtimeDir, name } });
    assert.equal(res.statusCode, 400, `${name} must be rejected`);
  }
});

test('POST /dirs keeps the directory but reports failure when git init cannot run', async () => {
  // Empty PATH -> execFile('git') fails with ENOENT inside the route. node
  // --test runs each file in its own process, so this stays scoped here.
  process.env.PATH = runtimeDir;
  try {
    const res = await app.inject({
      method: 'POST',
      url: '/api/dirs',
      payload: { parent: runtimeDir, name: 'proj-init-fail', gitInit: true },
    });
    assert.equal(res.statusCode, 500);
    const body = res.json();
    assert.match(body.error, /^Directory created but git init failed:/);
    assert.equal(body.path, join(runtimeDir, 'proj-init-fail'));
    assert.ok(existsSync(body.path), 'the created directory is kept for manual retry');
  } finally {
    if (realPath !== undefined) process.env.PATH = realPath;
  }
});
