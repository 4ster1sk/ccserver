import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { workerPresetsRoute } from './workerPresets.js';
import { closeDb } from '../db.js';

let tmpRoot;
let app;
let savedToken;

before(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'ccserver-worker-presets-route-'));
  process.env.CCSERVER_DB_PATH = join(tmpRoot, 'presets.sqlite3');
  app = Fastify();
  await app.register(workerPresetsRoute, { prefix: '/api' });
});

after(async () => {
  closeDb();
  delete process.env.CCSERVER_DB_PATH;
  if (savedToken === undefined) delete process.env.CCSERVER_TOKEN;
  else process.env.CCSERVER_TOKEN = savedToken;
  rmSync(tmpRoot, { recursive: true, force: true });
});

const validBody = () => ({ name: '実装担当', role: `workerImpl${Date.now()}${Math.floor(Math.random() * 1e6)}`, app: 'codex', model: 'gpt-5.4' });

async function create(body = validBody()) {
  return app.inject({ method: 'POST', url: '/api/worker-presets', payload: body });
}

test('POST creates and GET lists', async () => {
  const created = await create();
  assert.equal(created.statusCode, 200);
  const preset = created.json().preset;
  assert.match(preset.id, /^[0-9a-f-]{36}$/);
  assert.equal(preset.model, 'gpt-5.4');

  const list = await app.inject({ method: 'GET', url: '/api/worker-presets' });
  assert.equal(list.statusCode, 200);
  assert.ok(list.json().presets.some((p) => p.id === preset.id));
});

test('POST validation errors map to 400', async () => {
  for (const body of [
    { role: 'workerX', app: 'claude' },                    // missing name
    { name: 'x', role: 'orchestrator', app: 'claude' },    // bad role
    { name: 'x', role: 'workerX', app: 'copilot' },        // copilot
    { name: 'x', role: 'workerX', app: 'claude', model: 7 }, // bad model type
  ]) {
    const res = await create(body);
    assert.equal(res.statusCode, 400, JSON.stringify(body));
    assert.ok(res.json().error);
  }
});

test('duplicate role maps to 409', async () => {
  const body = validBody();
  assert.equal((await create(body)).statusCode, 200);
  const dup = await create({ ...validBody(), role: body.role });
  assert.equal(dup.statusCode, 409);
});

test('PUT updates; unknown id is 404; foreign duplicate role is 409', async () => {
  const a = (await create()).json().preset;
  const b = (await create()).json().preset;

  const upd = await app.inject({
    method: 'PUT', url: `/api/worker-presets/${a.id}`,
    payload: { name: '更新済み', role: a.role, app: 'opencode', model: null },
  });
  assert.equal(upd.statusCode, 200);
  assert.equal(upd.json().preset.name, '更新済み');
  assert.equal(upd.json().preset.app, 'opencode');
  assert.equal(upd.json().preset.model, null);

  const clash = await app.inject({
    method: 'PUT', url: `/api/worker-presets/${a.id}`,
    payload: { name: 'x', role: b.role, app: 'claude' },
  });
  assert.equal(clash.statusCode, 409);

  const missing = await app.inject({
    method: 'PUT', url: '/api/worker-presets/no-such-id',
    payload: { name: 'x', role: 'workerX', app: 'claude' },
  });
  assert.equal(missing.statusCode, 404);
});

test('DELETE returns success once then 404', async () => {
  const p = (await create()).json().preset;
  const ok = await app.inject({ method: 'DELETE', url: `/api/worker-presets/${p.id}` });
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(ok.json(), { success: true });
  const again = await app.inject({ method: 'DELETE', url: `/api/worker-presets/${p.id}` });
  assert.equal(again.statusCode, 404);
});

test('routes live under /api so the token hook protects them', async () => {
  savedToken = process.env.CCSERVER_TOKEN;
  process.env.CCSERVER_TOKEN = 'secret-token';
  try {
    const authed = Fastify();
    authed.addHook('onRequest', async (request, reply) => {
      if (!request.url.startsWith('/api') && !request.url.startsWith('/ws')) return;
      const token = request.query.token || request.headers.authorization?.replace(/^Bearer\s+/i, '');
      if (token !== 'secret-token') reply.code(401).send({ error: 'Invalid or missing token' });
    });
    await authed.register(workerPresetsRoute, { prefix: '/api' });

    const denied = await authed.inject({ method: 'GET', url: '/api/worker-presets' });
    assert.equal(denied.statusCode, 401, 'missing token rejected exactly like every other /api route');
    const allowed = await authed.inject({
      method: 'GET',
      url: '/api/worker-presets?token=secret-token',
    });
    assert.equal(allowed.statusCode, 200);
  } finally {
    process.env.CCSERVER_TOKEN = savedToken === undefined ? undefined : savedToken;
  }
});
