#!/ccserver-sandbox-node
// Runs INSIDE the sandbox (bound at /ccserver-sandbox-mcp-bridge, see
// sandbox.js). Relays the agent CLI's MCP stdio transport to the host-side
// MCP broker over a Unix socket: stdin -> socket, socket -> stdout. Both
// sides use newline-delimited JSON (MCP's stdio framing), so this is a plain
// byte pipe with no protocol logic.
//
// Which broker this reaches is decided by argv + which host socket was bound
// in (see mcpBroker.js / notify.js):
//   plain    -> CCSANDBOX_MCP_SOCK  (the group's control / handoff socket)
//   'notify' -> CCSANDBOX_NOTIFY_MCP_SOCK (the process-global notify socket)
// The wrapper itself is role-agnostic.
//
// In notify mode the wrapper additionally writes a single JSON line
// `{"ccserver": <identity>}\n` as the FIRST frame on connect -- before any
// MCP bytes -- so the server can attribute this connection's notifications
// (see mcpBroker.js). The identity comes from the CCSERVER_NOTIFY_IDENTITY
// env set by mcpConfig.js; absent or unparseable it sends an empty object
// (host-only attribution).
'use strict';
const net = require('net');
const isNotify = process.argv[2] === 'notify';
const sockPath = process.env[isNotify ? 'CCSANDBOX_NOTIFY_MCP_SOCK' : 'CCSANDBOX_MCP_SOCK'];
if (!sockPath) {
  process.stderr.write('sandbox: MCP bridge not configured\n');
  process.exit(1);
}

function parseIdentity(envValue) {
  if (!envValue) return {};
  try {
    const parsed = JSON.parse(envValue);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function connect(attempt = 0) {
  // A failed connect() fires 'error' and then immediately 'close'. The
  // close handler must NOT exit while a retry is scheduled, or the reconnect
  // logic would be dead on arrival (the very race this wrapper exists to
  // survive: the broker socket may not be in place yet at bind-try snapshot
  // time). `retrying` is how 'close' knows 'error' already scheduled one.
  let retrying = false;
  let established = false;
  const sock = net.createConnection(sockPath);
  sock.on('connect', () => {
    established = true;
    if (isNotify) {
      sock.write(`${JSON.stringify({ ccserver: parseIdentity(process.env.CCSERVER_NOTIFY_IDENTITY) })}\n`);
    }
    process.stdin.pipe(sock);
    sock.pipe(process.stdout);
  });
  sock.on('error', () => {
    if (attempt < 5) {
      retrying = true;
      setTimeout(() => connect(attempt + 1), 200);
    } else {
      process.stderr.write('sandbox: MCP broker unreachable\n');
      process.exit(1);
    }
  });
  sock.on('close', () => {
    if (retrying) return; // 'error' already scheduled the next attempt
    if (established) process.exit(0); // broker teardown: relay over
    if (attempt < 5) setTimeout(() => connect(attempt + 1), 200);
    else process.exit(1);
  });
}
connect();
