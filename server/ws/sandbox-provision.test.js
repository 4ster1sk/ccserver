// Opt-in tool provisioning (rtk / code-review-graph) for sandboxed sessions:
//   - resolveTools merges sandbox.config.json's `tools` (server default, off
//     unless enabled) with the client's per-session sandboxOpts.tools, like the
//     gpg/sshAgent opt-in flow. True enables a pinned default spec; the object
//     form can override version/url/sha256.
//   - buildSandboxSpawn, when any tool is enabled, ro-binds the provisioner at
//     /ccserver-sandbox-provision.sh and passes the tool specs via env. With no
//     tool enabled nothing is added.
//
// Isolated via CCSERVER_SANDBOX_CONFIG and CCSERVER_SANDBOX_HOME_ROOT (no real
// bwrap/pty involved -- buildSandboxSpawn only assembles the argv).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSandboxSpawn, buildMinimalSandboxSpawn, resolveTools } from './sandbox.js';

const PROVISION_PATH = '/ccserver-sandbox-provision.sh';

let cfgPath;
let tmpRoot;

function writeConfig(json) {
  writeFileSync(cfgPath, JSON.stringify(json));
}

before(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'ccserver-provision-'));
  cfgPath = join(tmpRoot, 'sandbox.config.json');
  process.env.CCSERVER_SANDBOX_CONFIG = cfgPath;
  process.env.CCSERVER_SANDBOX_HOME_ROOT = join(tmpRoot, 'home');
});

after(() => {
  delete process.env.CCSERVER_SANDBOX_CONFIG;
  delete process.env.CCSERVER_SANDBOX_HOME_ROOT;
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

// Pull the provision-related env out of a buildSandboxSpawn argv.
function provisionEnv(args) {
  const out = {};
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === '--setenv' && args[i + 1].startsWith('CCSANDBOX_')) {
      out[args[i + 1]] = args[i + 2];
    }
  }
  return out;
}

test('resolveTools defaults to off when the config has no tools', () => {
  writeConfig({ docker: false, gitBroker: false });
  const tools = resolveTools();
  assert.equal(tools.rtk, false);
  assert.equal(tools.codeReviewGraph, false);
  assert.equal(tools.rtkSpec, null);
  assert.equal(tools.crgSpec, null);
});

test('resolveTools: config "rtk": true enables rtk with the pinned default spec', () => {
  writeConfig({ docker: false, gitBroker: false, tools: { rtk: true } });
  const tools = resolveTools();
  assert.equal(tools.rtk, true);
  assert.equal(tools.codeReviewGraph, false);
  assert.ok(tools.rtkSpec.version.length > 0, 'pinned version present');
  assert.ok(tools.rtkSpec.url.startsWith('https://github.com/rtk-ai/rtk/releases/'), 'release URL');
  assert.equal(tools.rtkSpec.sha256.length, 64, 'pinned sha256 present');
});

test('resolveTools: object form overrides version/url/sha256', () => {
  writeConfig({ docker: false, gitBroker: false, tools: { 'code-review-graph': { enabled: true, version: '9.9.9' } } });
  const tools = resolveTools();
  assert.equal(tools.codeReviewGraph, true);
  assert.equal(tools.crgSpec.version, '9.9.9');
});

test('resolveTools: per-session sandboxOpts.tools overrides the config default', () => {
  writeConfig({ docker: false, gitBroker: false, tools: { rtk: false } });
  const tools = resolveTools({ tools: { rtk: true, codeReviewGraph: false } });
  assert.equal(tools.rtk, true, 'session opts turn a config-disabled tool on');
  const off = resolveTools({ tools: { rtk: false } });
  writeConfig({ docker: false, gitBroker: false, tools: { rtk: true } });
  assert.equal(resolveTools({ tools: { rtk: false } }).rtk, false, 'session opts turn a config-enabled tool off');
  assert.equal(off.codeReviewGraph, false);
});

test('buildSandboxSpawn binds the provisioner + sets env when a tool is enabled', () => {
  writeConfig({ docker: false, gitBroker: false, tools: { rtk: true, 'code-review-graph': true } });
  const spawn = buildSandboxSpawn({ cwd: join(tmpRoot, 'proj'), targetCommand: ['claude'], app: 'claude', sandboxOpts: null });
  const args = spawn.args;
  const provisionBind = args.findIndex((v, i) => v === '--ro-bind' && args[i + 1].endsWith('sandbox-provision.sh') && args[i + 2] === PROVISION_PATH);
  assert.ok(provisionBind > 0, 'provisioner ro-bound at the fixed path');
  const env = provisionEnv(args);
  assert.equal(env.CCSANDBOX_PROVISION_RTK, '1');
  assert.equal(env.CCSANDBOX_PROVISION_CRG, '1');
  assert.ok(env.CCSANDBOX_RTK_VERSION.length > 0);
  assert.ok(env.CCSANDBOX_RTK_URL.startsWith('https://'));
  assert.equal(env.CCSANDBOX_CRG_VERSION, '2.3.7');
});

test('buildSandboxSpawn adds no provision bind/env when tools are off', () => {
  writeConfig({ docker: false, gitBroker: false });
  const spawn = buildSandboxSpawn({ cwd: join(tmpRoot, 'proj2'), targetCommand: ['claude'], app: 'claude', sandboxOpts: null });
  assert.ok(!spawn.args.includes(PROVISION_PATH), 'no provisioner bind');
  assert.equal(provisionEnv(spawn.args).CCSANDBOX_PROVISION_RTK, undefined);
});

test('buildSandboxSpawn respects per-session sandboxOpts.tools over the config', () => {
  writeConfig({ docker: false, gitBroker: false });
  const spawn = buildSandboxSpawn({
    cwd: join(tmpRoot, 'proj3'), targetCommand: ['claude'], app: 'claude',
    sandboxOpts: { tools: { rtk: true, codeReviewGraph: false } },
  });
  const env = provisionEnv(spawn.args);
  assert.equal(env.CCSANDBOX_PROVISION_RTK, '1');
  assert.equal(env.CCSANDBOX_PROVISION_CRG, '0');
});

test('buildMinimalSandboxSpawn (usage capture) never provisions tools', () => {
  writeConfig({ docker: false, gitBroker: false, tools: { rtk: true } });
  const spawn = buildMinimalSandboxSpawn({ cwd: join(tmpRoot, 'proj4'), targetCommand: ['claude'] });
  assert.ok(!spawn.args.includes(PROVISION_PATH), 'throwaway sandbox stays lean');
  assert.equal(provisionEnv(spawn.args).CCSANDBOX_PROVISION_RTK, undefined);
});
