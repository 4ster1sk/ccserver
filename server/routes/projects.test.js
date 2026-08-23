import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectsRoute } from './projects.js';
import { findOrCreateProjectByCwd } from '../ws/projects.js';
import { closeDb } from '../db.js';

let tmpRoot;
let app;

before(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'ccserver-projects-route-'));
  process.env.CCSERVER_DB_PATH = join(tmpRoot, 'projects.sqlite3');
  app = Fastify();
  await app.register(projectsRoute, { prefix: '/api' });
});

after(async () => {
  closeDb();
  delete process.env.CCSERVER_DB_PATH;
  rmSync(tmpRoot, { recursive: true, force: true });
});

test('GET /projects lists store rows; GET /projects/:id resolves one', async () => {
  const p = findOrCreateProjectByCwd('/srv/route-proj').project;
  const list = await app.inject({ method: 'GET', url: '/api/projects' });
  assert.equal(list.statusCode, 200);
  assert.ok(list.json().projects.some((x) => x.id === p.id));

  const one = await app.inject({ method: 'GET', url: `/api/projects/${p.id}` });
  assert.equal(one.statusCode, 200);
  assert.equal(one.json().project.cwd, '/srv/route-proj');

  const missing = await app.inject({ method: 'GET', url: '/api/projects/no-such-id' });
  assert.equal(missing.statusCode, 404);
});

test('PUT /projects/:id/label updates and validates', async () => {
  const p = findOrCreateProjectByCwd('/srv/route-label').project;
  const ok = await app.inject({
    method: 'PUT', url: `/api/projects/${p.id}/label`,
    payload: { label: 'ラベル付き' },
  });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().project.label, 'ラベル付き');

  const clear = await app.inject({
    method: 'PUT', url: `/api/projects/${p.id}/label`,
    payload: {},
  });
  assert.equal(clear.statusCode, 200);
  assert.equal(clear.json().project.label, null);

  const bad = await app.inject({
    method: 'PUT', url: `/api/projects/${p.id}/label`,
    payload: { label: 'x'.repeat(201) },
  });
  assert.equal(bad.statusCode, 400);
});
