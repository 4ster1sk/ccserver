import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchPresetsRoute } from './launchPresets.js';
import { closeDb } from '../db.js';

let tmpRoot;
let app;
let counter = 0;
const savedHomeRoot = process.env.CCSERVER_SANDBOX_HOME_ROOT;

const validBody = () => ({
  name: `combo ${Date.now().toString(36)}${counter++}`,
  workers: [
    { role: `workerA${Date.now().toString(36)}${counter++}`, app: 'claude' },
    { role: `workerB${Date.now().toString(36)}${counter++}`, app: 'codex' },
  ],
});

before(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'ccserver-launch-presets-route-'));
  process.env.CCSERVER_DB_PATH = join(tmpRoot, 'presets.sqlite3');
  // Keep the v2 migration's importLegacy away from the host's real
  // .index.json (a fresh test DB would otherwise import -- and postApply
  // RENAME -- it as a side effect).
  process.env.CCSERVER_SANDBOX_HOME_ROOT = join(tmpRoot, 'home');
  app = Fastify();
  await app.register(launchPresetsRoute, { prefix: '/api' });
});

after(async () => {
  closeDb();
  delete process.env.CCSERVER_DB_PATH;
  if (savedHomeRoot === undefined) delete process.env.CCSERVER_SANDBOX_HOME_ROOT;
  else process.env.CCSERVER_SANDBOX_HOME_ROOT = savedHomeRoot;
  rmSync(tmpRoot, { recursive: true, force: true });
});

test('POST creates and GET lists nested presets', async () => {
  const created = await app.inject({ method: 'POST', url: '/api/launch-presets', payload: validBody() });
  assert.equal(created.statusCode, 200);
  const preset = created.json().preset;
  assert.equal(preset.workers.length, 2);

  const list = await app.inject({ method: 'GET', url: '/api/launch-presets' });
  assert.equal(list.statusCode, 200);
  assert.ok(list.json().presets.some((p) => p.id === preset.id));
});

test('validation errors map to 400; duplicate names to 409', async () => {
  const bad = await app.inject({ method: 'POST', url: '/api/launch-presets', payload: { name: 'x' } });
  assert.equal(bad.statusCode, 400);

  const body = validBody();
  assert.equal((await app.inject({ method: 'POST', url: '/api/launch-presets', payload: body })).statusCode, 200);
  const dup = await app.inject({
    method: 'POST', url: '/api/launch-presets',
    payload: { ...validBody(), name: body.name },
  });
  assert.equal(dup.statusCode, 409);
});

test('PUT updates; DELETE returns success once then 404', async () => {
  const a = (await app.inject({ method: 'POST', url: '/api/launch-presets', payload: validBody() })).json().preset;
  const upd = await app.inject({
    method: 'PUT', url: `/api/launch-presets/${a.id}`,
    payload: { ...a, name: `${a.name} v2`, instructions: 'updated' },
  });
  assert.equal(upd.statusCode, 200);
  assert.equal(upd.json().preset.instructions, 'updated');
  assert.equal(upd.json().preset.workers.length, a.workers.length, 'workers snapshot preserved through re-PUT');

  const ok = await app.inject({ method: 'DELETE', url: `/api/launch-presets/${a.id}` });
  assert.equal(ok.statusCode, 200);
  const again = await app.inject({ method: 'DELETE', url: `/api/launch-presets/${a.id}` });
  assert.equal(again.statusCode, 404);

  const missing = await app.inject({ method: 'PUT', url: '/api/launch-presets/nope', payload: validBody() });
  assert.equal(missing.statusCode, 404);
});
