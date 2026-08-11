// buildMcpConfigArgsAndEnv -- the per-CLI MCP registration injection for
// combo-launched sessions. claude gets an inline `--mcp-config <JSON>` CLI
// arg (process-scoped, no ~/.claude.json mutation); opencode gets an
// OPENCODE_CONFIG_CONTENT env var (deep-merged, no file written). Both point
// at the fixed in-sandbox bridge command. Pure function -- no deps, no I/O.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMcpConfigArgsAndEnv } from './mcpConfig.js';

test('claude gets an inline --mcp-config JSON pointing at the sandbox bridge', () => {
  const { args, env } = buildMcpConfigArgsAndEnv('claude');
  assert.equal(args[0], '--mcp-config');
  assert.equal(args.length, 2, 'exactly one flag + one inline JSON argument');
  const cfg = JSON.parse(args[1]);
  assert.deepEqual(cfg.mcpServers.ccserver, {
    type: 'stdio',
    command: '/ccserver-sandbox-mcp-bridge',
    args: [],
  });
  assert.deepEqual(env, {}, 'claude needs no env injection');
});

test('opencode gets OPENCODE_CONFIG_CONTENT env (local command bridge), no CLI args', () => {
  const { args, env } = buildMcpConfigArgsAndEnv('opencode');
  assert.deepEqual(args, []);
  const cfg = JSON.parse(env.OPENCODE_CONFIG_CONTENT);
  assert.equal(cfg.mcp.ccserver.type, 'local');
  assert.deepEqual(cfg.mcp.ccserver.command, ['/ccserver-sandbox-mcp-bridge']);
});

test('unknown app falls back to the claude-style CLI arg (default branch)', () => {
  const { args } = buildMcpConfigArgsAndEnv('shell');
  assert.equal(args[0], '--mcp-config');
  assert.ok(JSON.parse(args[1]).mcpServers.ccserver);
});

// ccserver-notify injection (see notify.js): the optional `{ notify }`
// descriptor adds the notify server to the same registration, with the bridge
// command switching on the session's sandbox mode.

test('claude + notify(sandbox): ccserver and ccserver-notify both registered via the in-sandbox bridge', () => {
  const { args, env } = buildMcpConfigArgsAndEnv('claude', {
    notify: { mode: 'sandbox', sockPath: '/run/user/1000/ccserver-notify.sock' },
  });
  assert.equal(args[0], '--mcp-config');
  const cfg = JSON.parse(args[1]);
  assert.ok(cfg.mcpServers.ccserver, 'ccserver stays registered alongside notify');
  assert.deepEqual(cfg.mcpServers['ccserver-notify'], {
    type: 'stdio',
    command: '/ccserver-sandbox-mcp-bridge',
    args: ['notify'],
  });
  assert.deepEqual(env, { CCSANDBOX_NOTIFY_MCP_SOCK: '/run/user/1000/ccserver-notify.sock' });
});

test('opencode + notify(sandbox): ccserver-notify is a local bridge command with the notify argv', () => {
  const { args, env } = buildMcpConfigArgsAndEnv('opencode', {
    notify: { mode: 'sandbox', sockPath: '/run/user/1000/ccserver-notify.sock' },
  });
  assert.deepEqual(args, []);
  const cfg = JSON.parse(env.OPENCODE_CONFIG_CONTENT);
  assert.deepEqual(cfg.mcp['ccserver-notify'].command, ['/ccserver-sandbox-mcp-bridge', 'notify']);
  assert.equal(env.CCSANDBOX_NOTIFY_MCP_SOCK, '/run/user/1000/ccserver-notify.sock');
});

test('notify(host): the notify server runs as node <bridge script> notify on the host', () => {
  const { args, env } = buildMcpConfigArgsAndEnv('claude', {
    notify: { mode: 'host', sockPath: '/run/user/1000/ccserver-notify.sock' },
  });
  const cfg = JSON.parse(args[1]);
  const n = cfg.mcpServers['ccserver-notify'];
  assert.equal(n.command, process.execPath, 'host mode invokes the node binary directly');
  assert.ok(n.args[0].endsWith('sandbox-mcp-wrapper.cjs'), `bridge script path (got ${n.args[0]})`);
  assert.equal(n.args[1], 'notify');
  assert.equal(env.CCSANDBOX_NOTIFY_MCP_SOCK, '/run/user/1000/ccserver-notify.sock');
});

test('no notify descriptor -> unchanged (ccserver only)', () => {
  const { args } = buildMcpConfigArgsAndEnv('claude');
  const cfg = JSON.parse(args[1]);
  assert.deepEqual(Object.keys(cfg.mcpServers), ['ccserver']);
});
