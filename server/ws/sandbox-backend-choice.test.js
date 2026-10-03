// Per-launch backend choice: sandboxOpts.backend picks bwrap or the qemu VM,
// anything else falls back to sandbox.config.json's backend (the default).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveSandboxBackend, sandboxAvailable, backendStatus, sandboxUnavailableReason } from './sandbox.js';
import { qemuStatus } from './sandbox-qemu.js';

let dir;
let prevConfig;
let prevBackendEnv;
const writeConfig = (cfg) => writeFileSync(process.env.CCSERVER_SANDBOX_CONFIG, JSON.stringify(cfg));

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'ccs-backend-'));
  prevConfig = process.env.CCSERVER_SANDBOX_CONFIG;
  prevBackendEnv = process.env.CCSERVER_SANDBOX_BACKEND;
  delete process.env.CCSERVER_SANDBOX_BACKEND;
  process.env.CCSERVER_SANDBOX_CONFIG = join(dir, 'sandbox.config.json');
});
after(() => {
  if (prevConfig === undefined) delete process.env.CCSERVER_SANDBOX_CONFIG;
  else process.env.CCSERVER_SANDBOX_CONFIG = prevConfig;
  if (prevBackendEnv !== undefined) process.env.CCSERVER_SANDBOX_BACKEND = prevBackendEnv;
  rmSync(dir, { recursive: true, force: true });
});

test('resolveSandboxBackend: a pick wins, anything else is the configured default', () => {
  writeConfig({ backend: 'bwrap' });
  assert.equal(resolveSandboxBackend(null), 'bwrap');
  assert.equal(resolveSandboxBackend({}), 'bwrap');
  assert.equal(resolveSandboxBackend({ backend: 'qemu' }), 'qemu');
  assert.equal(resolveSandboxBackend({ backend: 'docker' }), 'bwrap', 'unknown values never pick anything');
  writeConfig({ backend: 'qemu' });
  assert.equal(resolveSandboxBackend(null), 'qemu');
  assert.equal(resolveSandboxBackend({ backend: 'bwrap' }), 'bwrap');
});

test('availability and refusal text follow the backend asked about', { skip: process.platform !== 'linux' }, () => {
  writeConfig({ backend: 'bwrap' });
  assert.equal(sandboxAvailable('qemu'), qemuStatus().ok);
  const st = backendStatus();
  assert.equal(st.default, 'bwrap');
  assert.equal(st.qemu.ok, qemuStatus().ok);
  assert.equal(st.bwrap.ok, sandboxAvailable('bwrap'));
  assert.match(sandboxUnavailableReason('qemu').reason, /qemu sandbox is unavailable/);
  assert.match(sandboxUnavailableReason('bwrap').reason, /bwrap/);
});
