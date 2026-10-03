// /api/vm-templates and /api/vms over fastify.inject: status mapping and
// response shapes. The template rules themselves are vmTemplates.test.js's.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vmTemplatesRoute } from './vmTemplates.js';
import { vmsRoute } from './vms.js';
import { closeDb } from '../db.js';

let tmpRoot;
let app;
const savedDbPath = process.env.CCSERVER_DB_PATH;

before(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'ccserver-vmtpl-route-'));
  process.env.CCSERVER_DB_PATH = join(tmpRoot, 'test.sqlite3');
  app = Fastify();
  await app.register(vmTemplatesRoute, { prefix: '/api' });
  await app.register(vmsRoute, { prefix: '/api' });
  await app.ready();
});

after(async () => {
  await app.close();
  closeDb();
  if (savedDbPath === undefined) delete process.env.CCSERVER_DB_PATH;
  else process.env.CCSERVER_DB_PATH = savedDbPath;
  rmSync(tmpRoot, { recursive: true, force: true });
});

const body = { name: 'dev', memoryMiB: 4096, cpus: 2, diskGiB: 32, bootTimeoutSec: 120, cloudConfig: 'packages: [htop]\n' };

test('template CRUD and default over HTTP', async () => {
  let res = await app.inject({ method: 'GET', url: '/api/vm-templates' });
  assert.equal(res.statusCode, 200);
  const init = res.json();
  assert.deepEqual(init.templates, []);
  assert.equal(init.defaultTemplateId, null);
  assert.equal(init.limits.cpus.max, 64);
  assert.ok(init.host.cpus >= 1);
  assert.ok(init.fallback.memoryMiB >= 512);

  res = await app.inject({ method: 'POST', url: '/api/vm-templates', payload: body });
  assert.equal(res.statusCode, 200);
  const { id } = res.json().template;

  res = await app.inject({ method: 'POST', url: '/api/vm-templates', payload: body });
  assert.equal(res.statusCode, 409);
  res = await app.inject({ method: 'POST', url: '/api/vm-templates', payload: { ...body, name: 'x', cloudConfig: 'users: []' } });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error, /not allowed/);

  res = await app.inject({ method: 'PUT', url: `/api/vm-templates/${id}`, payload: { ...body, cpus: 6 } });
  assert.equal(res.json().template.cpus, 6);
  res = await app.inject({ method: 'PUT', url: '/api/vm-templates/nope', payload: body });
  assert.equal(res.statusCode, 404);

  res = await app.inject({ method: 'PUT', url: '/api/vm-templates-default', payload: { id } });
  assert.equal(res.json().defaultTemplateId, id);
  res = await app.inject({ method: 'PUT', url: '/api/vm-templates-default', payload: { id: 'nope' } });
  assert.equal(res.statusCode, 404);

  res = await app.inject({ method: 'DELETE', url: `/api/vm-templates/${id}` });
  assert.equal(res.statusCode, 204);
  res = await app.inject({ method: 'GET', url: '/api/vm-templates' });
  assert.deepEqual(res.json().templates, []);
  assert.equal(res.json().defaultTemplateId, null, 'deleting the default clears it');
});

test('running VM list: empty without qemu sessions; stopping an unknown VM is 404', async () => {
  let res = await app.inject({ method: 'GET', url: '/api/vms' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { vms: [], pools: [] });
  res = await app.inject({ method: 'DELETE', url: '/api/vms/no-such-session' });
  assert.equal(res.statusCode, 404);
  res = await app.inject({ method: 'DELETE', url: '/api/vm-pool/no-such-vm' });
  assert.equal(res.statusCode, 404);
});

test('running VM list: an idle persistent VM is still listed, and can be stopped', async () => {
  const stopped = [];
  let vms = [{
    id: 'vm1', key: 'k', runDir: '/nonexistent', startedAt: 1000, sessions: 0,
    idleSince: 2000, idleStopAt: 2000 + 7200000,
    info: { templateId: 't1', templateName: 'dev', memoryMiB: 4096, cpus: 2, diskGiB: 32 },
    shares: [],
  }];
  const qemuVmPool = { list: () => vms, async stop(id) { stopped.push(id); vms = []; return true; } };
  const app2 = Fastify();
  await app2.register(vmsRoute, { prefix: '/api', qemuVmPool });
  await app2.ready();
  let res = await app2.inject({ method: 'GET', url: '/api/vms' });
  assert.deepEqual(res.json().pools, [{
    vmId: 'vm1', templateId: 't1', templateName: 'dev', memoryMiB: 4096, cpus: 2, diskGiB: 32,
    startedAt: 1000, idleSince: 2000, idleStopAt: 7202000, shareCount: 0, diskUsedBytes: null, sessions: [],
  }]);
  res = await app2.inject({ method: 'DELETE', url: '/api/vm-pool/vm1' });
  assert.equal(res.statusCode, 204);
  assert.deepEqual(stopped, ['vm1']);
  res = await app2.inject({ method: 'GET', url: '/api/vms' });
  assert.deepEqual(res.json().pools, []);
  await app2.close();
});

test('persistent VM idle time: 2 hours by default, validated, saved', async () => {
  let res = await app.inject({ method: 'GET', url: '/api/vm-templates' });
  assert.equal(res.json().pool.idleStopMinutes, 120);
  assert.deepEqual(res.json().pool.limits.idleStopMinutes, { min: 1, max: 10080, def: 120 });
  for (const bad of [0, 10081, 1.5, '30', null]) {
    res = await app.inject({ method: 'PUT', url: '/api/vm-pool-settings', payload: { idleStopMinutes: bad } });
    assert.equal(res.statusCode, 400, String(bad));
  }
  res = await app.inject({ method: 'PUT', url: '/api/vm-pool-settings', payload: { idleStopMinutes: 30 } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().idleStopMinutes, 30);
  res = await app.inject({ method: 'GET', url: '/api/vm-templates' });
  assert.equal(res.json().pool.idleStopMinutes, 30);
});

test('PUT /vm-agent-auth: write-only claude token', async () => {
  const token = 'sk-ant-oat01-abcdefghijklmnopqrstuvwxyz0123';
  let res = await app.inject({ method: 'PUT', url: '/api/vm-agent-auth', payload: { claudeOAuthToken: token } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { agentAuth: { claude: true, opencode: [] } });
  res = await app.inject({ method: 'GET', url: '/api/vm-templates' });
  assert.deepEqual(res.json().agentAuth, { claude: true, opencode: [] });
  assert.ok(!res.body.includes(token), 'the value is never returned');
  res = await app.inject({ method: 'PUT', url: '/api/vm-agent-auth', payload: { claudeOAuthToken: 'nope' } });
  assert.equal(res.statusCode, 400);
  res = await app.inject({ method: 'PUT', url: '/api/vm-agent-auth', payload: {} });
  assert.equal(res.statusCode, 400);
  res = await app.inject({ method: 'PUT', url: '/api/vm-agent-auth', payload: { claudeOAuthToken: null } });
  assert.deepEqual(res.json(), { agentAuth: { claude: false, opencode: [] } });
});

test('PUT /vm-agent-auth: write-only opencode keys per provider', async () => {
  const key = 'sk-sakura-0123456789abcdef';
  let res = await app.inject({ method: 'PUT', url: '/api/vm-agent-auth', payload: { opencodeApiKey: { provider: 'sakura', key } } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { agentAuth: { claude: false, opencode: ['sakura'] } });
  res = await app.inject({ method: 'GET', url: '/api/vm-templates' });
  assert.ok(!res.body.includes(key), 'the value is never returned');
  for (const payload of [{ opencodeApiKey: { provider: 'bad id', key } }, { opencodeApiKey: { provider: 'sakura' } }, { opencodeApiKey: 'x' }, { opencodeApiKey: { provider: 'sakura', key }, claudeOAuthToken: null }]) {
    res = await app.inject({ method: 'PUT', url: '/api/vm-agent-auth', payload });
    assert.equal(res.statusCode, 400, JSON.stringify(payload));
  }
  res = await app.inject({ method: 'PUT', url: '/api/vm-agent-auth', payload: { opencodeApiKey: { provider: 'sakura', key: null } } });
  assert.deepEqual(res.json(), { agentAuth: { claude: false, opencode: [] } });
});
