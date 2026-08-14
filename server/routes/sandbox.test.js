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

function setEnv() {
  process.env.CCSERVER_SANDBOX_CONFIG = cfgPath;
  process.env.CCSERVER_SANDBOX_HOME_ROOT = homeRoot;
}

function clearEnv() {
  delete process.env.CCSERVER_SANDBOX_CONFIG;
  delete process.env.CCSERVER_SANDBOX_HOME_ROOT;
}

async function status(cwd) {
  const res = await app.inject({ method: 'GET', url: `/api/sandbox/status?cwd=${encodeURIComponent(cwd)}` });
  return res;
}

before(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'ccserver-sandbox-route-'));
  cfgPath = join(tmpRoot, 'sandbox.config.json');
  homeRoot = join(tmpRoot, 'home');
  writeFileSync(cfgPath, JSON.stringify({ docker: false, gitBroker: false }));
  setEnv();
  app = Fastify();
  await app.register(sandboxRoute, { prefix: '/api' });
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
