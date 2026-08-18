// Builds the MCP server registration injected into a session -- never written
// to a file on the host or in the repo. Which servers are registered:
//   ccserver        - the group's control/handoff broker (combo sessions only,
//                     i.e. when `groupMcp` is true and mcpSocketPath was set).
//                     The CLI runs the bridge script at the fixed in-sandbox
//                     path; which broker it reaches is decided solely by which
//                     host socket got bound to /ccserver-sandbox-mcp.sock in
//                     the sandbox (see sandbox.js / mcpBroker.js). Absent for
//                     standalone sessions -- they have no group socket, so
//                     registering it would hand the agent a broken server.
//   ccserver-notify - the process-global notification server (see notify.js),
//                     registered when the `{ notify }` descriptor is passed.
//   ccserver-usage  - the process-global usage server (see usageMcp.js),
//                     registered when the `{ usage }` descriptor is passed.
//                     claude sessions only (sessionManager never passes it
//                     for opencode/copilot -- see usageMcp.js's
//                     shouldInjectUsage).
//
//   claude   -> CLI arg `--mcp-config '<inline JSON>'` (process-scoped, does
//               not touch ~/.claude.json's shared projects key, so parallel
//               sessions in the same cwd cannot collide).
//   opencode -> OPENCODE_CONFIG_CONTENT env var (deep-merged with project
//               config, no file written).
//   copilot  -> nothing. copilot has no CLI-arg/env MCP injection (its config
//               is file-based only), so `buildMcpConfigArgsAndEnv` never
//               assembles an injection for it -- passing `--mcp-config` would
//               make the binary error out with "unknown option".
//
// The optional `{ notify }` descriptor adds the ccserver-notify MCP server:
//   { mode, sockPath, identity? }
//     mode     - 'sandbox' (run the in-sandbox bridge, args ['notify']) or
//                'host' (run <node> <bridge script> notify on the host --
//                used by non-sandboxed sessions, where the fixed in-sandbox
//                path and shebang don't exist).
//     sockPath - host path of the process-global notify socket, injected as
//                CCSANDBOX_NOTIFY_MCP_SOCK so the wrapper can reach it (bwrap
//                --setenv overrides it with the in-sandbox path when sandboxed).
//     identity - optional per-connection attribution
//                ({ sessionId, groupId, groupRole, cwd, projectName, app },
//                see sessionManager / mcpBroker). Injected as the JSON
//                CCSERVER_NOTIFY_IDENTITY env the bridge wrapper attaches to
//                its first socket frame; absent -> no env key, the wrapper
//                sends an empty frame and the notification carries host-only
//                attribution.
//
// The optional `{ usage }` descriptor adds the ccserver-usage MCP server
// (get_usage, see usageMcp.js): `{ mode, sockPath }`, same mode/sockPath
// shape as notify but with no identity (get_usage carries no per-connection
// attribution). Only ever passed for claude sessions (sessionManager gates
// it on shouldInjectUsage), but the assembly here doesn't need to know that.
//
// Returns { args, env } for sessionManager to splice into the pty spawn.

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const MCP_BRIDGE_COMMAND = '/ccserver-sandbox-mcp-bridge';
const NOTIFY_BRIDGE_SCRIPT = join(__dirname, 'sandbox-mcp-wrapper.cjs');
const USAGE_BRIDGE_ARG = ['usage'];

// The { base, args } invocation for the notify server: the in-sandbox bridge
// when the session is sandboxed, else the host node binary running the bridge
// script directly (the script's shebang only exists inside the sandbox).
function notifyInvocation(notify) {
  if (notify.mode === 'host') {
    return { command: process.execPath, args: [NOTIFY_BRIDGE_SCRIPT, 'notify'] };
  }
  return { command: MCP_BRIDGE_COMMAND, args: ['notify'] };
}

// Same shape as notifyInvocation, for the ccserver-usage bridge (the wrapper
// script is shared -- it picks its socket env by argv, see
// sandbox-mcp-wrapper.cjs).
function usageInvocation(usage) {
  if (usage.mode === 'host') {
    return { command: process.execPath, args: [NOTIFY_BRIDGE_SCRIPT, ...USAGE_BRIDGE_ARG] };
  }
  return { command: MCP_BRIDGE_COMMAND, args: USAGE_BRIDGE_ARG };
}

export function buildMcpConfigArgsAndEnv(app, { groupMcp = true, notify, usage } = {}) {
  const notifySockEnv = notify ? { CCSANDBOX_NOTIFY_MCP_SOCK: notify.sockPath } : {};
  const notifyIdentityEnv = notify?.identity ? { CCSERVER_NOTIFY_IDENTITY: JSON.stringify(notify.identity) } : {};
  const usageSockEnv = usage ? { CCSANDBOX_USAGE_MCP_SOCK: usage.sockPath } : {};

  if (app === 'copilot' || app === 'codex') {
    // No CLI-arg/env MCP injection exists for copilot: assembling one would
    // reach the binary as `--mcp-config` and die with "unknown option". The
    // function is the single assembly point, so refusing here guarantees no
    // copilot launch path ever injects (group launches already refuse copilot
    // at open_tab / addMember).
    return { args: [], env: {} };
  }

  if (app === 'opencode') {
    const mcp = {};
    if (groupMcp) mcp.ccserver = { type: 'local', command: [MCP_BRIDGE_COMMAND] };
    if (notify) {
      const inv = notifyInvocation(notify);
      mcp['ccserver-notify'] = { type: 'local', command: [inv.command, ...inv.args] };
    }
    return {
      args: [],
      env: {
        OPENCODE_CONFIG_CONTENT: JSON.stringify({
          $schema: 'https://opencode.ai/config.json',
          mcp,
        }),
        ...notifySockEnv,
        ...notifyIdentityEnv,
      },
    };
  }

  const mcpServers = {};
  if (groupMcp) mcpServers.ccserver = { type: 'stdio', command: MCP_BRIDGE_COMMAND, args: [] };
  if (notify) {
    const inv = notifyInvocation(notify);
    mcpServers['ccserver-notify'] = { type: 'stdio', command: inv.command, args: inv.args };
  }
  if (usage) {
    const inv = usageInvocation(usage);
    mcpServers['ccserver-usage'] = { type: 'stdio', command: inv.command, args: inv.args };
  }
  return {
    args: [
      '--mcp-config',
      JSON.stringify({ mcpServers }),
    ],
    env: {
      ...notifySockEnv,
      ...notifyIdentityEnv,
      ...usageSockEnv,
    },
  };
}
