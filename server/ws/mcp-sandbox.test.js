// Sandbox argument building for process-wide notification, usage, and
// reviewer MCP bridges.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSandboxSpawn } from './sandbox.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const SANDBOX_NOTIFY_SOCK_PATH = '/ccserver-sandbox-notify.d/sock';
const SANDBOX_USAGE_SOCK_PATH = '/ccserver-sandbox-usage.d/sock';
const SANDBOX_MCP_BRIDGE_PATH = '/ccserver-sandbox-mcp-bridge';
const SANDBOX_NODE_PATH = '/ccserver-sandbox-node';

let cfgPath;
let tmpRoot;

before(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'ccserver-mcp-sandbox-'));
  cfgPath = join(tmpRoot, 'sandbox.config.json');
  // persistentHome off: the "no ro mounts" assertions must stay about the MCP
  // machinery, not the persistent-home bin-host bind.
  writeFileSync(cfgPath, JSON.stringify({ docker: false, gitBroker: false, persistentHome: false }));
});

after(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ccserver-notify is process-wide. The sandbox binds its socket and bridge
// wrapper, plus the node binary needed by the wrapper shebang.
test('buildSandboxSpawn binds the notify socket + wrapper when notifySocketPath is set', async () => {
  const prev = process.env.CCSERVER_SANDBOX_CONFIG;
  process.env.CCSERVER_SANDBOX_CONFIG = cfgPath;
  try {
    const notifySock = join(tmpRoot, 'fake-notify.sock');
    const spawn = await buildSandboxSpawn({
      cwd: tmpRoot,
      targetCommand: ['claude'],
      app: 'claude',
      sandboxOpts: null,
      notifySocketPath: notifySock,
    });
    const args = spawn.args;
    const idxBind = args.indexOf(dirname(SANDBOX_NOTIFY_SOCK_PATH));
    assert.ok(idxBind > 0, 'in-sandbox notify socket directory present');
    assert.equal(args[idxBind - 2], '--bind-try');
    assert.equal(args[idxBind - 1], dirname(notifySock));
    const sockEnv = args.indexOf('CCSANDBOX_NOTIFY_MCP_SOCK');
    assert.ok(sockEnv > 0, 'CCSANDBOX_NOTIFY_MCP_SOCK set');
    assert.equal(args[sockEnv + 1], SANDBOX_NOTIFY_SOCK_PATH);
    const idxBridge = args.indexOf(SANDBOX_MCP_BRIDGE_PATH);
    assert.ok(idxBridge > 0, 'bridge wrapper ro-bound for notify');
    assert.equal(args[idxBridge - 2], '--ro-bind');
    assert.equal(args[idxBridge - 1], join(__dirname, 'sandbox-mcp-wrapper.cjs'));
    const idxNode = args.indexOf(SANDBOX_NODE_PATH);
    assert.ok(idxNode > 0, 'node binary bind present (wrapper shebang)');
    assert.ok(!args.includes('/ccserver-sandbox-mcp.d/sock'), 'no removed group MCP socket bind');
    assert.ok(!args.includes('CCSANDBOX_MCP_SOCK'), 'no removed group socket env');
  } finally {
    if (prev === undefined) delete process.env.CCSERVER_SANDBOX_CONFIG;
    else process.env.CCSERVER_SANDBOX_CONFIG = prev;
  }
});

test('buildSandboxSpawn without notifySocketPath adds no notify bindings', async () => {
  const prev = process.env.CCSERVER_SANDBOX_CONFIG;
  process.env.CCSERVER_SANDBOX_CONFIG = cfgPath;
  try {
    const spawn = await buildSandboxSpawn({
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

// ccserver-usage (see usageMcp.js): same shape as the notify socket bindings
// above, independent of the notify socket -- a
// claude session may carry any combination of the three.
test('buildSandboxSpawn binds the usage socket + wrapper when usageSocketPath is set (no notify socket)', async () => {
  const prev = process.env.CCSERVER_SANDBOX_CONFIG;
  process.env.CCSERVER_SANDBOX_CONFIG = cfgPath;
  try {
    const usageSock = join(tmpRoot, 'fake-usage.sock');
    const spawn = await buildSandboxSpawn({
      cwd: tmpRoot,
      targetCommand: ['claude'],
      app: 'claude',
      sandboxOpts: null,
      usageSocketPath: usageSock,
    });
    const args = spawn.args;
    const idxBind = args.indexOf(dirname(SANDBOX_USAGE_SOCK_PATH));
    assert.ok(idxBind > 0, 'in-sandbox usage socket directory present');
    assert.equal(args[idxBind - 2], '--bind-try');
    assert.equal(args[idxBind - 1], dirname(usageSock));
    const sockEnv = args.indexOf('CCSANDBOX_USAGE_MCP_SOCK');
    assert.ok(sockEnv > 0, 'CCSANDBOX_USAGE_MCP_SOCK set');
    assert.equal(args[sockEnv + 1], SANDBOX_USAGE_SOCK_PATH);
    const idxBridge = args.indexOf(SANDBOX_MCP_BRIDGE_PATH);
    assert.ok(idxBridge > 0, 'bridge wrapper ro-bound for usage');
    const idxNode = args.indexOf(SANDBOX_NODE_PATH);
    assert.ok(idxNode > 0, 'node binary bind present (wrapper shebang)');
    assert.ok(!args.includes('/ccserver-sandbox-mcp.d/sock'), 'no removed group MCP socket bind');
    assert.ok(!args.includes(SANDBOX_NOTIFY_SOCK_PATH), 'no notify socket bind');
  } finally {
    if (prev === undefined) delete process.env.CCSERVER_SANDBOX_CONFIG;
    else process.env.CCSERVER_SANDBOX_CONFIG = prev;
  }
});

test('buildSandboxSpawn without usageSocketPath adds no usage bindings', async () => {
  const prev = process.env.CCSERVER_SANDBOX_CONFIG;
  process.env.CCSERVER_SANDBOX_CONFIG = cfgPath;
  try {
    const spawn = await buildSandboxSpawn({
      cwd: tmpRoot,
      targetCommand: ['claude'],
      app: 'claude',
      sandboxOpts: null,
    });
    assert.ok(!spawn.args.includes(SANDBOX_USAGE_SOCK_PATH), 'no usage socket path');
    assert.ok(!spawn.args.includes('CCSANDBOX_USAGE_MCP_SOCK'), 'no usage socket env');
  } finally {
    if (prev === undefined) delete process.env.CCSERVER_SANDBOX_CONFIG;
    else process.env.CCSERVER_SANDBOX_CONFIG = prev;
  }
});
