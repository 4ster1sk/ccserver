// Unix-socket MCP brokers for process-wide notification, usage and reviewer
// servers. They share a transport and bind a fresh MCP server per connection.

import { createServer } from 'node:net';
import { rmSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { SocketTransport, buildNotifyMcpServer, buildUsageMcpServer, buildReviewerMcpServer, MAX_TRANSPORT_BUFFER_CHARS } from './mcpServer.js';
import { ensureHostRuntimeDir } from './git-broker.js';

// How long to wait (non-blocking) for the socket file after listen() reports
// success, before giving up.
const SOCKET_FILE_WAIT_MS = 2000;
const SOCKET_FILE_POLL_MS = 20;

// How long to wait for the per-connection identity frame (the notify bridge's
// first line) before giving up on it. Bounded so a client that connects and
// sends nothing is handed to the transport within a short grace window, never
// held hostage on the frame.
const IDENTITY_FRAME_GRACE_MS = 1000;

// bwrap's --bind-try snapshots the socket file at mount time, so the file
// must exist before createSession()/buildSandboxSpawn() run. listen()'s
// callback fires once the socket is bound (the file exists by then), but
// poll non-blockingly for a short window anyway so a caller can never race
// the bind with a sandbox launch.
function waitForSocketFile(sockPath, timeoutMs) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const poll = () => {
      if (existsSync(sockPath)) return resolve();
      if (Date.now() >= deadline) {
        return reject(new Error(`socket file ${sockPath} never appeared`));
      }
      setTimeout(poll, SOCKET_FILE_POLL_MS);
    };
    poll();
  });
}

// Async: resolves { server, sockPath, dir } once the socket is actually
// listening, or rejects with the listen error (or a timeout waiting for the
// socket file). Callers must propagate the rejection -- a silent failure
// here would leave sessions sandboxed with a bind to a socket nobody is
// listening on. Callers pass the process-wide socket path explicitly.
async function listenMcp({ tag, buildServer, sockPath }) {
  const target = sockPath;
  // Issue #143 problem 1: the directory this socket lives alone in must exist
  // before bwrap can bind it into a sandbox (buildSandboxSpawn/createSession
  // run after this resolves, same ordering constraint as the socket file
  // itself below). Idempotent -- a second listenMcp() for the same target
  // (e.g. a restart) finds it already there.
  // darwin's hostRuntimeDir() base is not pre-created by anything else
  // (unlike Linux's logind-made /run/user/<uid>); ensureHostRuntimeDir()
  // additionally fails closed if a hostile other-UID dir squatted on it.
  // Propagate its throw (fail closed) -- only the mkdir stays best-effort.
  ensureHostRuntimeDir();
  try {
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  } catch {
    // best effort -- listen() below reports real problems
  }
  // A socket file left over from a crash (teardown never ran) would make
  // listen() fail with EADDRINUSE. Each path is process-scoped, so a stale
  // file can never belong to a live listener -- safe to drop. The
  // notify socket is single-instance per server process, so its stale file
  // is equally safe to drop.
  try {
    rmSync(target, { force: true });
  } catch {
    // best effort
  }
  const connections = new Set(); // accepted sockets, destroyed on stopBroker
  const server = createServer((socket) => {
    connections.add(socket);
    socket.on('close', () => connections.delete(socket));
    socket.on('error', () => {});

    // Per-connection identity handoff (see notify.js / mcpConfig.js): the
    // notify bridge wrapper writes one JSON line `{"ccserver": {...}}\n` as
    // the very first frame, before piping the agent's MCP bytes. Read up to
    // the first newline (bounded, with a short grace window so a client that
    // never sends is not held forever) and decide:
    //   - the first line parses as {"ccserver": <object>} -> that object is
    //     this connection's identity; the bytes after the newline are the
    //     MCP data.
    //   - anything else (legacy wrapper, direct MCP client) -> replay the
    //     whole buffer as MCP data and carry no identity.
    let buf = '';
    let settled = false;
    let graceTimer = null;

    const settleConnection = (seed, identity) => {
      if (settled) return;
      settled = true;
      if (graceTimer) clearTimeout(graceTimer);
      socket.removeListener('data', onFrameData);
      if (socket.destroyed) return;
      // Stop the flow while the transport takes over: data that arrived
      // after the frame read is buffered by the paused socket and replayed
      // to the transport's own handler once it starts.
      socket.pause();
      const transport = new SocketTransport(socket, seed);
        const mcp = buildServer(identity);
      // mcp.connect() is async (transport.start() + the MCP initialize
      // handshake). A rejected promise here must NOT become an unhandled
      // rejection (Node's default --unhandled-rejections=throw would crash the
      // whole server, every unrelated pty included) -- e.g. a sandbox torn
      // down right after accept leaves a socket that dies mid-handshake. Log
      // and close the connection; the broker itself stays up.
      mcp.connect(transport).catch((err) => {
        console.error(`[mcp-broker] ${tag} connection handshake failed: ${err.message}`);
        try { socket.destroy(); } catch { /* already gone */ }
      });
    };

    const onFrameData = (chunk) => {
      buf += chunk;
      const nl = buf.indexOf('\n');
      if (nl !== -1) {
        const line = buf.slice(0, nl);
        const rest = buf.slice(nl + 1);
        let identity = null;
        let seed = buf;
        try {
          const parsed = JSON.parse(line);
          if (parsed && typeof parsed === 'object' && parsed.ccserver && typeof parsed.ccserver === 'object') {
            identity = parsed.ccserver;
            seed = rest;
          }
        } catch {
          // not JSON / not an identity frame -- replay the whole buffer
        }
        settleConnection(seed, identity);
      } else if (buf.length > MAX_TRANSPORT_BUFFER_CHARS) {
        // No newline by the cap: let the transport's overflow handling drop it.
        settleConnection(buf, null);
      }
    };

    socket.setEncoding('utf-8');
    socket.pause();
    socket.on('data', onFrameData);
    socket.resume();

    // A client that connects but sends nothing must not hang the broker:
    // after a short grace the (possibly empty) buffer is replayed with no
    // identity.
    graceTimer = setTimeout(() => settleConnection(buf, null), IDENTITY_FRAME_GRACE_MS);
  });
  // Permanent error handler: an EventEmitter 'error' with zero listeners
  // throws and crashes the whole process, so this must NEVER be removed once
  // the server exists. Startup failure detection uses a separate once-listener
  // that is explicitly removed on success (see below).
  server.on('error', (err) => {
    console.error(`[mcp-broker] ${tag} socket error: ${err.message}`);
  });
  await new Promise((resolve, reject) => {
    const onStartupError = (err) => {
      reject(new Error(`[mcp-broker] ${tag} listen failed: ${err.message}`));
    };
    server.once('error', onStartupError);
    server.listen(target, () => {
      // Listening succeeded -- detach the startup-only rejecter so it can't
      // linger and fire on a later, unrelated error.
      server.off('error', onStartupError);
      resolve();
    });
  });
  try {
    await waitForSocketFile(target, SOCKET_FILE_WAIT_MS);
  } catch (err) {
    for (const socket of connections) {
      try { socket.destroy(); } catch { /* already gone */ }
    }
    try { server.close(); } catch { /* not listening */ }
    throw err;
  }
  return { server, sockPath: target, dir: null, connections };
}

// The process-global notification broker (ccserver-notify, see notify.js).
// One per server process at the caller-provided sockPath (getNotifySockPath).
// The notify tools are process-wide, so the socket is bound
// into every notify-enabled session's sandbox.
export async function startNotifyBroker({ notifyApi, sockPath }) {
  return listenMcp({
    sockPath,
    tag: 'notify',
    buildServer: (identity) => buildNotifyMcpServer({ notifyApi, identity }),
  });
}

// The process-global usage broker (ccserver-usage, see usageMcp.js). One per
// server process. NOT session-attributed (unlike
// notify) -- get_usage always returns the same server-wide snapshot
// regardless of which session asks.
export async function startUsageBroker({ usageApi, sockPath }) {
  return listenMcp({
    sockPath,
    tag: 'usage',
    buildServer: () => buildUsageMcpServer({ usageApi }),
  });
}

// The process-global reviewer broker (ccserver-reviewer, see reviewer.js).
// One per server process. It carries a per-connection
// identity frame (CCSERVER_REVIEWER_IDENTITY, same mechanism as notify)
// -- unlike run_review/list_reviews/get_review (whose attribution, if any,
// rides in run_review's own `requestedBy` argument), finish_review needs to
// verify the CALLER is the very session the job launched, and the identity
// frame's sessionId is what it checks against.
export async function startReviewerBroker({ reviewerApi, sockPath }) {
  return listenMcp({
    sockPath,
    tag: 'reviewer',
    buildServer: (identity) => buildReviewerMcpServer({ reviewerApi, identity }),
  });
}

export function stopBroker({ server, sockPath, connections }) {
  // Drop established connections too: server.close() only stops accepting
  // new ones, and a lingering connected socket would keep its McpServer
  // (and its queued handoffs/waits) alive for as long as the client holds
  // the connection open.
  if (connections) {
    for (const socket of connections) {
      try {
        socket.destroy();
      } catch {
        // already gone
      }
    }
  }
  if (server) {
    try {
      server.close();
    } catch {
      // already closed / never started
    }
  }
  if (sockPath) {
    try {
      rmSync(sockPath, { force: true });
    } catch {
      // best effort
    }
  }
}
