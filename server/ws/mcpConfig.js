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
// The optional boolean `rtk` adds the RTK (Rust Token Killer) auto-rewrite
// for sandboxed sessions (see sandbox.js's resolveRtk / buildSandboxSpawn and
// the vendored sandbox-rtk-plugin.ts): opencode loads the ro-bound plugin via
// its config `plugin` key; claude gets the PreToolUse hook via an inline
// `--settings` JSON. claude's `--settings` *merges* with the user's own
// settings files -- a key set here overrides the same key from local/project/
// user settings and an omitted key keeps its lower-level value -- so the hook
// is additive and never clobbers existing settings/hooks. copilot is not
// touched (RTK cannot transparently rewrite its CLI).
//
// Returns { args, env } for sessionManager to splice into the pty spawn.

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const MCP_BRIDGE_COMMAND = '/ccserver-sandbox-mcp-bridge';
const NOTIFY_BRIDGE_SCRIPT = join(__dirname, 'sandbox-mcp-wrapper.cjs');

// Fixed in-sandbox paths for the RTK injection (bound by buildBwrapArgs /
// sandbox.js): the vendored opencode plugin at SANDBOX_RTK_PLUGIN_PATH, and
// `rtk` on the sandbox PATH (prepended there) for the claude hook command.
const SANDBOX_RTK_PLUGIN_PATH = '/ccserver-sandbox-rtk.ts';
// claude's PreToolUse hook: the native-binary hook (no jq) rewrites Bash tool
// calls via `rtk rewrite` (requires rtk >= 0.37.2; the hook exits cleanly on
// anything older). Merged into the user's settings by claude itself.
const CLAUDE_RTK_SETTINGS = JSON.stringify({
  hooks: {
    PreToolUse: [
      { matcher: 'Bash', hooks: [{ type: 'command', command: 'rtk hook claude' }] },
    ],
  },
});

// The { base, args } invocation for the notify server: the in-sandbox bridge
// when the session is sandboxed, else the host node binary running the bridge
// script directly (the script's shebang only exists inside the sandbox).
function notifyInvocation(notify) {
  if (notify.mode === 'host') {
    return { command: process.execPath, args: [NOTIFY_BRIDGE_SCRIPT, 'notify'] };
  }
  return { command: MCP_BRIDGE_COMMAND, args: ['notify'] };
}

export function buildMcpConfigArgsAndEnv(app, { groupMcp = true, notify, rtk = false } = {}) {
  const notifySockEnv = notify ? { CCSANDBOX_NOTIFY_MCP_SOCK: notify.sockPath } : {};
  const notifyIdentityEnv = notify?.identity ? { CCSERVER_NOTIFY_IDENTITY: JSON.stringify(notify.identity) } : {};

  if (app === 'copilot') {
    // No CLI-arg/env MCP injection exists for copilot: assembling one would
    // reach the binary as `--mcp-config` and die with "unknown option". The
    // function is the single assembly point, so refusing here guarantees no
    // copilot launch path ever injects (group launches already refuse copilot
    // at open_tab / addMember). RTK is equally skipped -- its CLI cannot
    // transparently rewrite copilot anyway.
    return { args: [], env: {} };
  }

  if (app === 'opencode') {
    const mcp = {};
    if (groupMcp) mcp.ccserver = { type: 'local', command: [MCP_BRIDGE_COMMAND] };
    if (notify) {
      const inv = notifyInvocation(notify);
      mcp['ccserver-notify'] = { type: 'local', command: [inv.command, ...inv.args] };
    }
    const cfg = {
      $schema: 'https://opencode.ai/config.json',
      mcp,
    };
    // RTK: register the vendored plugin (ro-bound into the sandbox by
    // buildBwrapArgs) so opencode's Bash tool calls get rewritten through the
    // host rtk binary. `plugin` is a config array -- deep-merged with the
    // user's own global/project plugins by opencode, never replacing them.
    if (rtk) cfg.plugin = [SANDBOX_RTK_PLUGIN_PATH];
    return {
      args: [],
      env: {
        OPENCODE_CONFIG_CONTENT: JSON.stringify(cfg),
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
  const args = [];
  // Emit --mcp-config only when there is actually a server to register. A
  // rtk-only call (no group socket, no notify) must not pass an empty mcp
  // config -- RTK's injection is the --settings flag alone.
  if (groupMcp || notify) {
    args.push('--mcp-config', JSON.stringify({ mcpServers }));
  }
  // RTK: the PreToolUse hook (see CLAUDE_RTK_SETTINGS). Inline JSON -- claude
  // merges `--settings` with its settings files, so the user's own settings
  // and hooks stay intact.
  if (rtk) args.push('--settings', CLAUDE_RTK_SETTINGS);
  return {
    args,
    env: {
      ...notifySockEnv,
      ...notifyIdentityEnv,
    },
  };
}
