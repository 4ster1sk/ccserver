// ccserver-usage: the server-global "get_usage" MCP tool. Lets a claude
// session read the server's own Claude usage snapshot (session/weekly
// percentage used, reset times, plan) without shelling out to `/usage`
// itself.
//
// Process-wide concept (NOT group-scoped like the control/handoff brokers,
// and unlike ccserver-notify carries no per-connection identity): one Unix
// socket hosts it for the whole server process
// (${XDG_RUNTIME_DIR}/ccserver-usage.sock, see getUsageSockPath). Each
// usage-enabled session's sandbox binds that one socket in; the MCP config
// tells the agent to reach it through the same bridge wrapper as the notify
// server (see mcpConfig.js / sandbox-mcp-wrapper.cjs), just with a different
// argv mode.
//
// get_usage always returns the same server-wide snapshot regardless of which
// session asks -- there is nothing to attribute, so (unlike notify) no
// identity frame is ever written or read for this socket.
//
// This module imports mcpBroker.js lazily (dynamic import) so the static
// import graph stays acyclic, mirroring notify.js: sessionManager -> usageMcp
// -> sandbox, and the broker/server modules are only touched at runtime.

import { join } from 'node:path';
import { getUsage } from '../usage.js';
import { loadSandboxConfig, resolveClaude } from './sandbox.js';

const USAGE_SOCKET_NAME = 'ccserver-usage.sock';

let usageBroker = null; // { server, sockPath, dir, connections } | null

export function getUsageSockPath() {
  const base = process.env.XDG_RUNTIME_DIR
    || (typeof process.getuid === 'function' ? `/run/user/${process.getuid()}` : '/tmp');
  return join(base, USAGE_SOCKET_NAME);
}

// Whether the get_usage MCP tool should exist on this server at all: claude
// itself must be installed (the capture would never succeed otherwise -- see
// usage.js's resolveClaude() === false path), and the config must not
// explicitly disable it via showUsage:false (which already hides the
// client's Usage button, and now also gates the MCP tool the same way).
export function usageEnabled() {
  return resolveClaude().found !== false && loadSandboxConfig().showUsage !== false;
}

// Pure injection decision for createSession: claude sessions only (opencode
// has no equivalent capture, copilot has no CLI-arg/env MCP injection at
// all -- both are excluded by the `app === 'claude'` equality, no explicit
// exclusion needed). Shells never get it. Unlike notify, worker/orchestrator/
// standalone are not distinguished -- every claude session in a group gets
// it, same as a standalone one.
export function shouldInjectUsage({ shell, app, usageEnabled }) {
  return !shell && app === 'claude' && !!usageEnabled;
}

// The usageApi facade handed to buildUsageMcpServer (see mcpServer.js).
export const usageApi = {
  getUsage,
};

// Start (once) the global Unix-socket broker hosting ccserver-usage. Callers
// must await it before launching sessions: bwrap's --bind-try snapshots the
// socket file at mount time, so the file must exist first. Safe to call
// repeatedly -- the second call is a no-op returning the existing socket path.
export async function ensureUsageBroker() {
  if (usageBroker) return usageBroker.sockPath;
  const broker = await import('./mcpBroker.js');
  stopBrokerFn = broker.stopBroker;
  usageBroker = await broker.startUsageBroker({
    usageApi,
    sockPath: getUsageSockPath(),
  });
  return usageBroker.sockPath;
}

// Whether the global broker is actually listening right now (see
// notifyBrokerRunning's rationale in notify.js -- same reasoning applies).
export function usageBrokerRunning() {
  return !!usageBroker;
}

// Teardown for graceful shutdown. Synchronous (the stopBroker reference is
// cached on the first ensureUsageBroker call). Best effort; a stale socket
// file is removed by the next boot's listenMcp anyway.
let stopBrokerFn = null;
export function stopUsageBroker() {
  if (!usageBroker) return;
  try {
    if (stopBrokerFn) stopBrokerFn(usageBroker);
  } catch {
    // best effort
  }
  usageBroker = null;
}
