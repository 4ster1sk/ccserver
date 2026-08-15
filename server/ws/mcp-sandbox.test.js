// Sandbox argument building for combo sessions: when an mcpSocketPath is
// passed, buildSandboxSpawn must bind the host socket at the fixed in-sandbox
// path, ro-bind the bridge wrapper, set CCSANDBOX_MCP_SOCK, and share the
// node-binary bind with the git-broker machinery (the wrapper's shebang).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSandboxSpawn, SANDBOX_PATH } from './sandbox.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const SANDBOX_MCP_SOCK_PATH = '/ccserver-sandbox-mcp.sock';
const SANDBOX_NOTIFY_SOCK_PATH = '/ccserver-sandbox-notify.sock';
const SANDBOX_MCP_BRIDGE_PATH = '/ccserver-sandbox-mcp-bridge';
const SANDBOX_NODE_PATH = '/ccserver-sandbox-node';

let cfgPath;
let tmpRoot;

before(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'ccserver-mcp-sandbox-'));
  cfgPath = join(tmpRoot, 'sandbox.config.json');
  // persistentHome off: the "no ro mounts" assertions must stay about the MCP
  // machinery, not the persistent-home bin-host bind. rtk off too: those
  // assertions must not depend on whether the test host happens to have rtk
  // installed (its wiring is exercised explicitly below).
  writeFileSync(cfgPath, JSON.stringify({ docker: false, gitBroker: false, persistentHome: false, rtk: false }));
});

after(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

test('buildSandboxSpawn binds the MCP socket, wrapper and node binary when mcpSocketPath is set', () => {
  const prev = process.env.CCSERVER_SANDBOX_CONFIG;
  process.env.CCSERVER_SANDBOX_CONFIG = cfgPath;
  try {
    const sockPath = join(tmpRoot, 'fake-mcp.sock');
    const spawn = buildSandboxSpawn({
      cwd: tmpRoot,
      targetCommand: ['claude'],
      app: 'claude',
      sandboxOpts: null,
      mcpSocketPath: sockPath,
    });
    const args = spawn.args;
    const idxBind = args.indexOf(SANDBOX_MCP_SOCK_PATH);
    const idxBridge = args.indexOf(SANDBOX_MCP_BRIDGE_PATH);
    const idxNode = args.indexOf(SANDBOX_NODE_PATH);
    assert.ok(idxBind > 0, 'in-sandbox MCP socket path present');
    assert.equal(args[idxBind - 2], '--bind-try');
    assert.equal(args[idxBind - 1], sockPath);
    assert.ok(idxBridge > 0, 'bridge wrapper path present');
    assert.equal(args[idxBridge - 2], '--ro-bind');
    assert.equal(args[idxBridge - 1], join(__dirname, 'sandbox-mcp-wrapper.cjs'));
    const sockEnv = args.indexOf('CCSANDBOX_MCP_SOCK');
    assert.ok(sockEnv > 0, 'CCSANDBOX_MCP_SOCK set');
    assert.equal(args[sockEnv + 1], SANDBOX_MCP_SOCK_PATH);
    assert.ok(idxNode > 0, 'node binary bind present (wrapper shebang)');
  } finally {
    if (prev === undefined) delete process.env.CCSERVER_SANDBOX_CONFIG;
    else process.env.CCSERVER_SANDBOX_CONFIG = prev;
  }
});

test('buildSandboxSpawn without mcpSocketPath adds no MCP bindings', () => {
  const prev = process.env.CCSERVER_SANDBOX_CONFIG;
  process.env.CCSERVER_SANDBOX_CONFIG = cfgPath;
  try {
    const spawn = buildSandboxSpawn({
      cwd: tmpRoot,
      targetCommand: ['claude'],
      app: 'claude',
      sandboxOpts: null,
    });
    assert.ok(!spawn.args.includes('--bind-try') || !spawn.args.includes(SANDBOX_MCP_SOCK_PATH));
    assert.ok(!spawn.args.includes('CCSANDBOX_MCP_SOCK'));
  } finally {
    if (prev === undefined) delete process.env.CCSERVER_SANDBOX_CONFIG;
    else process.env.CCSERVER_SANDBOX_CONFIG = prev;
  }
});

test('buildSandboxSpawn adds no /workers mounts (worker-dir roBinds removed)', () => {
  const prev = process.env.CCSERVER_SANDBOX_CONFIG;
  process.env.CCSERVER_SANDBOX_CONFIG = cfgPath;
  try {
    const spawn = buildSandboxSpawn({
      cwd: tmpRoot,
      targetCommand: ['claude'],
      app: 'claude',
      sandboxOpts: null,
    });
    assert.ok(!spawn.args.includes('--ro-bind-try'), 'no ro mounts at all without an MCP socket');
    assert.ok(!spawn.args.some((a) => typeof a === 'string' && a.startsWith('/workers/')), 'no /workers/* destination');
  } finally {
    if (prev === undefined) delete process.env.CCSERVER_SANDBOX_CONFIG;
    else process.env.CCSERVER_SANDBOX_CONFIG = prev;
  }
});

// ccserver-notify in a STANDALONE sandbox: notifySocketPath set but no group
// mcpSocketPath (standalone sessions carry no group broker). The notify socket
// must be bound, the wrapper ro-bound, CCSANDBOX_NOTIFY_MCP_SOCK set, and the
// node binary bound for the wrapper's shebang -- without any group-socket
// bindings leaking in.
test('buildSandboxSpawn binds the notify socket + wrapper when notifySocketPath is set (no group socket)', () => {
  const prev = process.env.CCSERVER_SANDBOX_CONFIG;
  process.env.CCSERVER_SANDBOX_CONFIG = cfgPath;
  try {
    const notifySock = join(tmpRoot, 'fake-notify.sock');
    const spawn = buildSandboxSpawn({
      cwd: tmpRoot,
      targetCommand: ['claude'],
      app: 'claude',
      sandboxOpts: null,
      notifySocketPath: notifySock,
    });
    const args = spawn.args;
    const idxBind = args.indexOf(SANDBOX_NOTIFY_SOCK_PATH);
    assert.ok(idxBind > 0, 'in-sandbox notify socket path present');
    assert.equal(args[idxBind - 2], '--bind-try');
    assert.equal(args[idxBind - 1], notifySock);
    const sockEnv = args.indexOf('CCSANDBOX_NOTIFY_MCP_SOCK');
    assert.ok(sockEnv > 0, 'CCSANDBOX_NOTIFY_MCP_SOCK set');
    assert.equal(args[sockEnv + 1], SANDBOX_NOTIFY_SOCK_PATH);
    const idxBridge = args.indexOf(SANDBOX_MCP_BRIDGE_PATH);
    assert.ok(idxBridge > 0, 'bridge wrapper ro-bound for notify');
    assert.equal(args[idxBridge - 2], '--ro-bind');
    assert.equal(args[idxBridge - 1], join(__dirname, 'sandbox-mcp-wrapper.cjs'));
    const idxNode = args.indexOf(SANDBOX_NODE_PATH);
    assert.ok(idxNode > 0, 'node binary bind present (wrapper shebang)');
    assert.ok(!args.includes(SANDBOX_MCP_SOCK_PATH), 'no group MCP socket bind (standalone)');
    assert.ok(!args.includes('CCSANDBOX_MCP_SOCK'), 'no group socket env (standalone)');
  } finally {
    if (prev === undefined) delete process.env.CCSERVER_SANDBOX_CONFIG;
    else process.env.CCSERVER_SANDBOX_CONFIG = prev;
  }
});

test('buildSandboxSpawn without notifySocketPath adds no notify bindings', () => {
  const prev = process.env.CCSERVER_SANDBOX_CONFIG;
  process.env.CCSERVER_SANDBOX_CONFIG = cfgPath;
  try {
    const spawn = buildSandboxSpawn({
      cwd: tmpRoot,
      targetCommand: ['claude'],
      app: 'claude',
      sandboxOpts: null,
    });
    assert.ok(!spawn.args.includes(SANDBOX_NOTIFY_SOCK_PATH), 'no notify socket path');
    assert.ok(!spawn.args.includes('CCSANDBOX_NOTIFY_MCP_SOCK'), 'no notify socket env');
  } finally {
    if (prev === undefined) delete process.env.CCSERVER_SANDBOX_CONFIG;
    else process.env.CCSERVER_SANDBOX_CONFIG = prev;
  }
});

// RTK (Rust Token Killer) wiring in the sandbox argv: the caller (sessionManager)
// resolves rtk once and passes the descriptor in, so these are deterministic
// regardless of whether the test host has rtk installed.
const SANDBOX_RTK_PLUGIN_PATH = '/ccserver-sandbox-rtk.ts';

test('buildSandboxSpawn wires rtk when the descriptor reports found', () => {
  const prev = process.env.CCSERVER_SANDBOX_CONFIG;
  process.env.CCSERVER_SANDBOX_CONFIG = cfgPath;
  try {
    const spawn = buildSandboxSpawn({
      cwd: tmpRoot,
      targetCommand: ['claude'],
      app: 'claude',
      sandboxOpts: null,
      rtk: { found: true, binDir: tmpRoot },
    });
    assert.equal(spawn.rtk, true, 'the spawn reports rtk enabled');
    const args = spawn.args;
    const pluginIdx = args.indexOf(SANDBOX_RTK_PLUGIN_PATH);
    assert.ok(pluginIdx > 0, 'vendored plugin ro-bound at the fixed path');
    assert.equal(args[pluginIdx - 2], '--ro-bind');
    assert.equal(args[pluginIdx - 1], join(__dirname, 'sandbox-rtk-plugin.ts'));
    const envIdx = args.indexOf('CCSANDBOX_RTK');
    assert.ok(envIdx > 0, 'CCSANDBOX_RTK set');
    assert.equal(args[envIdx + 1], '1');
    // The rtk bin dir is bound at its real path and prepended to PATH so the
    // hook/plugin always resolve `rtk`, wherever it lives on the host.
    const bindIdx = args.indexOf('--ro-bind', pluginIdx);
    assert.ok(bindIdx > 0);
    assert.equal(args[bindIdx + 1], tmpRoot);
    assert.equal(args[bindIdx + 2], tmpRoot);
    const pathIdx = args.indexOf('PATH');
    assert.ok(pathIdx > 0);
    assert.ok(String(args[pathIdx + 1]).startsWith(`${tmpRoot}:`), 'rtk bin dir prepended to PATH');
  } finally {
    if (prev === undefined) delete process.env.CCSERVER_SANDBOX_CONFIG;
    else process.env.CCSERVER_SANDBOX_CONFIG = prev;
  }
});

test('buildSandboxSpawn adds no rtk wiring when the descriptor is false', () => {
  const prev = process.env.CCSERVER_SANDBOX_CONFIG;
  process.env.CCSERVER_SANDBOX_CONFIG = cfgPath;
  try {
    const spawn = buildSandboxSpawn({
      cwd: tmpRoot,
      targetCommand: ['claude'],
      app: 'claude',
      sandboxOpts: null,
      rtk: false,
    });
    assert.equal(spawn.rtk, false);
    assert.ok(!spawn.args.includes(SANDBOX_RTK_PLUGIN_PATH), 'no plugin bind');
    assert.ok(!spawn.args.includes('CCSANDBOX_RTK'), 'no rtk env');
    assert.ok(!spawn.args.includes(tmpRoot + ':'), 'no PATH prepend');
  } finally {
    if (prev === undefined) delete process.env.CCSERVER_SANDBOX_CONFIG;
    else process.env.CCSERVER_SANDBOX_CONFIG = prev;
  }
});

test('buildSandboxSpawn with a found-but-null binDir wires rtk without an extra bind', () => {
  const prev = process.env.CCSERVER_SANDBOX_CONFIG;
  process.env.CCSERVER_SANDBOX_CONFIG = cfgPath;
  try {
    // rtk already under an exposed tree (~/.local/bin): found, no dir to bind.
    const spawn = buildSandboxSpawn({
      cwd: tmpRoot,
      targetCommand: ['claude'],
      app: 'claude',
      sandboxOpts: null,
      rtk: { found: true, binDir: null },
    });
    assert.equal(spawn.rtk, true);
    assert.ok(spawn.args.includes(SANDBOX_RTK_PLUGIN_PATH), 'plugin still bound');
    assert.ok(spawn.args.includes('CCSANDBOX_RTK'), 'env still set');
    const pathIdx = spawn.args.indexOf('PATH');
    assert.equal(spawn.args[pathIdx + 1], SANDBOX_PATH, 'PATH unchanged (no rtk dir to prepend)');
  } finally {
    if (prev === undefined) delete process.env.CCSERVER_SANDBOX_CONFIG;
    else process.env.CCSERVER_SANDBOX_CONFIG = prev;
  }
});
