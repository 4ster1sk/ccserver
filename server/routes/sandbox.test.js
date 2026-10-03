// GET /api/sandbox/status: answers the client's reuse dialog -- whether
// persistent per-project HOMEs are enabled, whether a previous sandbox left
// state for the given cwd, and whether that HOME is in use by a live
// sandboxed session (inUse disables the destructive "新規作成" option).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sandboxRoute } from './sandbox.js';
import { persistentHomeDir } from '../ws/sandbox.js';

let tmpRoot;
let cfgPath;
let homeRoot;
let app;
let poolVms = [];
let poolKeys = new Set();
let launchKey = null;
const launchKeyCalls = [];
const fakePool = { list: () => poolVms, has: (key) => poolKeys.has(key) };
const fakeLaunchPoolKey = (sandboxOpts) => {
  launchKeyCalls.push(sandboxOpts);
  return launchKey;
};

function setEnv() {
  process.env.CCSERVER_SANDBOX_CONFIG = cfgPath;
  process.env.CCSERVER_SANDBOX_HOME_ROOT = homeRoot;
}

function clearEnv() {
  delete process.env.CCSERVER_SANDBOX_CONFIG;
  delete process.env.CCSERVER_SANDBOX_HOME_ROOT;
}

async function status(cwd, backend = null, vmTemplateId = null) {
  const q = (backend ? `&backend=${backend}` : '') + (vmTemplateId ? `&vmTemplateId=${vmTemplateId}` : '');
  const res = await app.inject({ method: 'GET', url: `/api/sandbox/status?cwd=${encodeURIComponent(cwd)}${q}` });
  return res;
}

before(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'ccserver-sandbox-route-'));
  cfgPath = join(tmpRoot, 'sandbox.config.json');
  homeRoot = join(tmpRoot, 'home');
  writeFileSync(cfgPath, JSON.stringify({ docker: false, gitBroker: false }));
  setEnv();
  app = Fastify();
  await app.register(sandboxRoute, { prefix: '/api', qemuVmPool: fakePool, qemuLaunchPoolKey: fakeLaunchPoolKey });
});

after(async () => {
  clearEnv();
  try { await app.close(); } catch { /* ignore */ }
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

test('status requires a cwd', async () => {
  const res = await status('');
  assert.equal(res.statusCode, 400);
});

test('status reports enabled + exists=false for a project without a previous sandbox', async () => {
  const res = await status('/srv/never-opened');
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.enabled, true, 'persistentHome defaults on');
  assert.equal(body.exists, false);
  assert.equal(body.inUse, 0);
  assert.ok(body.path.startsWith(homeRoot), 'path lives under the home root');
});

test('status reports exists=true once a previous sandbox left a HOME, and inUse=0 with no live sessions', async () => {
  // Simulate a previous sandbox by creating its HOME dir.
  const cwd = '/srv/opened-before';
  mkdirSync(persistentHomeDir(cwd), { recursive: true });
  const res = await status(cwd);
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.enabled, true);
  assert.equal(body.exists, true);
  assert.equal(body.inUse, 0, 'no live sandboxed sessions share this HOME');
});

test('status honors persistentHome=false in the config', async () => {
  writeFileSync(cfgPath, JSON.stringify({ docker: false, gitBroker: false, persistentHome: false }));
  try {
    const res = await status('/srv/any');
    const body = res.json();
    assert.equal(body.enabled, false);
    assert.equal(body.inUse, 0);
  } finally {
    writeFileSync(cfgPath, JSON.stringify({ docker: false, gitBroker: false }));
  }
});

test('status echoes the resolved backend and lists no VMs for bwrap', async () => {
  const res = await status('/srv/any', 'bwrap');
  const body = res.json();
  assert.equal(body.backend, 'bwrap');
  assert.equal(body.runningVms, undefined);
});

test('status lists running persistent VMs (idle included) for qemu', async () => {
  poolVms = [
    { id: 'vm-a', sessions: 2, info: { templateName: 'dev' } },
    { id: 'vm-b', sessions: 0, info: { templateName: null } },
  ];
  try {
    const body = (await status('/srv/any', 'qemu')).json();
    assert.equal(body.backend, 'qemu');
    assert.deepEqual(body.runningVms, [
      { kind: 'pool', id: 'vm-a', templateName: 'dev', sessionCount: 2, idle: false },
      { kind: 'pool', id: 'vm-b', templateName: null, sessionCount: 0, idle: true },
    ]);
  } finally {
    poolVms = [];
  }
});

test('status reports an empty runningVms for qemu with nothing running', async () => {
  const body = (await status('/srv/any', 'qemu')).json();
  assert.deepEqual(body.runningVms, []);
});

test('status resolves an absent backend to the configured default', async () => {
  writeFileSync(cfgPath, JSON.stringify({ docker: false, gitBroker: false, backend: 'qemu' }));
  try {
    const body = (await status('/srv/any')).json();
    assert.equal(body.backend, 'qemu');
    assert.deepEqual(body.runningVms, []);
  } finally {
    writeFileSync(cfgPath, JSON.stringify({ docker: false, gitBroker: false }));
  }
});

test('joinsRunningVm: true only when the launch key is a VM the pool already has', async () => {
  poolVms = [{ id: 'vm-a', sessions: 1, info: { templateName: 'test' } }];
  poolKeys = new Set(['key-test']);
  try {
    launchKey = 'key-test';
    let body = (await status('/srv/any', 'qemu', 't-test')).json();
    assert.equal(body.joinsRunningVm, true);
    assert.deepEqual(launchKeyCalls.at(-1), { vmTemplateId: 't-test' });

    launchKey = 'key-other';
    body = (await status('/srv/any', 'qemu', 't-other')).json();
    assert.equal(body.joinsRunningVm, false, 'another template boots its own VM');
    assert.equal(body.runningVms.length, 1);

    launchKey = null;
    body = (await status('/srv/any', 'qemu')).json();
    assert.equal(body.joinsRunningVm, false, 'a throwaway VM never joins');
    assert.deepEqual(launchKeyCalls.at(-1), { vmTemplateId: null });
  } finally {
    poolVms = [];
    poolKeys = new Set();
    launchKey = null;
  }
});
