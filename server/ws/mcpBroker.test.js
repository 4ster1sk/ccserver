// Wire-level integration test of the MCP broker: exercises the real
// mcpBroker.js UDS listeners + mcpServer.js + SocketTransport against a raw
// socket client speaking the MCP JSON-RPC framing (initialize / tools/list /
// tools/call), exactly as Claude Code / opencode would. No agent CLIs, no
// bwrap, no browser needed.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let runtimeDir;
let broker;

before(async () => {
  // Short base: the broker's socket paths (ccserver-mcp-<32hex>-<tag>.d/sock)
  // plus a /var/folders/... macOS tmpdir() blow sockaddr_un's 104-byte limit,
  // so listen() silently never binds. hostRuntimeDir() picks a short /tmp base
  // on darwin for exactly this reason; mirror it here.
  const base = process.platform === 'darwin' ? '/tmp' : tmpdir();
  runtimeDir = mkdtempSync(join(base, 'ccs-mcp-'));
  process.env.XDG_RUNTIME_DIR = runtimeDir;
  broker = await import('./mcpBroker.js');
});

after(() => {
  try { rmSync(runtimeDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

// Newline-delimited JSON-RPC client over the UDS (MCP stdio framing).
// `target` is a process-wide broker socket path. The first frame, when
// supplied by the notify bridge, carries attribution rather than identity.
function mcpClient(target) {
  const sockPath = typeof target === 'string' ? target : target.sockPath;
  const token = typeof target === 'string' ? null : (target.token || null);
  let id = 0;
  const pending = new Map();
  const sock = net.createConnection(sockPath);
  let buf = '';
  sock.setEncoding('utf-8');
  sock.on('connect', () => {
    if (token) sock.write(`${JSON.stringify({ ccserver: { token } })}\n`);
  });
  sock.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id != null && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) reject(new Error(`RPC error ${msg.error.code}: ${msg.error.message}`));
        else resolve(msg.result);
      }
    }
  });
  // Never let a test hang if the broker drops the connection (e.g. a token
  // gate refusal) with a call still outstanding.
  sock.on('close', () => {
    for (const { reject } of pending.values()) reject(new Error('broker connection closed with the request outstanding'));
    pending.clear();
  });
  return {
    raw: sock,
    connected: new Promise((resolve, reject) => {
      sock.on('connect', resolve);
      sock.on('error', reject);
    }),
    call(method, params = {}) {
      return this.callTracked(method, params).promise;
    },
    // Same as call(), but hands back the JSON-RPC id so a test can cancel
    // this exact request (notifications/cancelled takes a requestId).
    callTracked(method, params = {}) {
      const reqId = ++id;
      const promise = new Promise((resolve, reject) => {
        pending.set(reqId, { resolve, reject });
        sock.write(`${JSON.stringify({ jsonrpc: '2.0', id: reqId, method, params })}\n`);
      });
      return { id: reqId, promise };
    },
    // A JSON-RPC notification (no id, no response) -- how a real client tells
    // the server it has given up on an in-flight request.
    notify(method, params = {}) {
      sock.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
    },
    close() { sock.end(); },
  };
}

async function callTool(client, name, args) {
  const result = await client.call('tools/call', { name, arguments: args });
  return JSON.parse(result.content[0].text);
}

// Raw variant: returns the full tools/call result so tests can inspect
// isError / non-JSON error payloads (e.g. a handler exception surfacing as
// { content: [...], isError: true }).
async function callToolRaw(client, name, args) {
  return client.call('tools/call', { name, arguments: args });
}

test('notify broker: startNotifyBroker + stopBroker lifecycle on a supplied socket path', async () => {
  const notifyApi = {
    sendNotification: async () => ({ ok: true, delivered: { discord: false, webhooks: 1, failed: 0 } }),
    subscribe: () => ({ ok: true, subscription: { id: 'sub-1' } }),
    unsubscribe: () => ({ ok: true }),
    listSubscriptions: () => [{ id: 'sub-1', url: 'https://example.com/hook' }],
  };
  const notify = await broker.startNotifyBroker({
    notifyApi,
    sockPath: join(runtimeDir, 'ccserver-notify.sock'),
  });
  try {
    const c = mcpClient(notify.sockPath);
    await c.connected;
    const init = await c.call('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'wire-test', version: '1' },
    });
    assert.equal(init.serverInfo.name, 'ccserver-notify');
    const { tools } = await c.call('tools/list');
    assert.deepEqual(
      tools.map((t) => t.name).sort(),
      ['list_subscriptions', 'notify', 'subscribe', 'unsubscribe'],
    );
    const out = await callTool(c, 'list_subscriptions', {});
    assert.deepEqual(out, { subscriptions: [{ id: 'sub-1', url: 'https://example.com/hook' }] });
    c.close();
  } finally {
    broker.stopBroker(notify);
    assert.equal(existsSync(notify.sockPath), false, 'stopBroker removes the socket file');
  }
});

// The notify bridge wrapper writes a single `{"ccserver": <identity>}\n`
// frame as the first bytes of a connection, before any MCP traffic. The
// broker must attribute that connection's notifications with it -- the notify
// tool's notifyApi.sendNotification receives it as its second argument. The
// tool's own schema stays { title, body, level? }; the identity rides the
// connection, never the wire.
test('notify broker: an identity frame on connect reaches the notify tool as connection identity', async () => {
  const seenIdentities = [];
  const identity = {
    sessionId: '0123456789abcdef',
    cwd: '/srv/proj',
    projectName: 'proj',
    app: 'claude',
  };
  const notifyApi = {
    sendNotification: async (args, connIdentity) => {
      seenIdentities.push(connIdentity);
      return { ok: true, delivered: { discord: false, webhooks: 0, failed: 0 } };
    },
    subscribe: () => ({ ok: true, subscription: { id: 'sub-1' } }),
    unsubscribe: () => ({ ok: true }),
    listSubscriptions: () => [],
  };
  const notify = await broker.startNotifyBroker({
    notifyApi,
    sockPath: join(runtimeDir, 'ccserver-notify-identity.sock'),
  });
  try {
    const c = mcpClient(notify.sockPath);
    await c.connected;
    // The identity frame must be written BEFORE the MCP initialize -- exactly
    // what the sandbox bridge does on connect.
    c.raw.write(`${JSON.stringify({ ccserver: identity })}\n`);
    await c.call('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'wire-test', version: '1' },
    });
    await callTool(c, 'notify', { title: 'Build failed', body: 'details here', level: 'error' });
    assert.equal(seenIdentities.length, 1);
    assert.deepEqual(seenIdentities[0], identity, 'the frame identity is passed to sendNotification');
    c.close();
  } finally {
    broker.stopBroker(notify);
  }
});

// A client that skips the identity frame entirely (legacy wrapper without
// CCSERVER_NOTIFY_IDENTITY, or a direct MCP client) must still work: the first
// line is not an identity frame, so it is replayed as MCP data and the
// connection carries no identity (host-only attribution).
test('notify broker: frameless clients are replayed and carry no identity', async () => {
  const seenIdentities = [];
  const notifyApi = {
    sendNotification: async (args, connIdentity) => {
      seenIdentities.push(connIdentity);
      return { ok: true, delivered: { discord: false, webhooks: 0, failed: 0 } };
    },
    subscribe: () => ({ ok: true, subscription: { id: 'sub-1' } }),
    unsubscribe: () => ({ ok: true }),
    listSubscriptions: () => [],
  };
  const notify = await broker.startNotifyBroker({
    notifyApi,
    sockPath: join(runtimeDir, 'ccserver-notify-frameless.sock'),
  });
  try {
    const c = mcpClient(notify.sockPath);
    await c.connected;
    const init = await c.call('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'wire-test', version: '1' },
    });
    assert.equal(init.serverInfo.name, 'ccserver-notify');
    const { tools } = await c.call('tools/list');
    assert.equal(tools.length, 4, 'all four notify tools exposed without a frame');
    await callTool(c, 'notify', { title: 'plain', body: 'message' });
    assert.deepEqual(seenIdentities, [null], 'no frame -> no connection identity');
    c.close();
  } finally {
    broker.stopBroker(notify);
  }
});

// channels (Issue #152): an optional array on the notify tool's own schema
// (title/body/level/channels?), separate from the connection identity frame
// above -- it rides the wire as a normal tool argument and is forwarded to
// sendNotification verbatim, letting sendNotification's own channel-gating
// logic (see notify.js/notify.test.js) do the actual filtering.
test('notify broker: channels is forwarded to sendNotification verbatim', async () => {
  const seenArgs = [];
  const notifyApi = {
    sendNotification: async (args) => {
      seenArgs.push(args);
      return { ok: true, delivered: { discord: false, webhooks: 0, failed: 0 } };
    },
    subscribe: () => ({ ok: true, subscription: { id: 'sub-1' } }),
    unsubscribe: () => ({ ok: true }),
    listSubscriptions: () => [],
  };
  const notify = await broker.startNotifyBroker({
    notifyApi,
    sockPath: join(runtimeDir, 'ccserver-notify-channels.sock'),
  });
  try {
    const c = mcpClient(notify.sockPath);
    await c.connected;
    await c.call('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'wire-test', version: '1' },
    });
    await callTool(c, 'notify', { title: 'x', body: 'y', channels: ['discord'] });
    assert.deepEqual(seenArgs[0].channels, ['discord']);
    c.close();
  } finally {
    broker.stopBroker(notify);
  }
});

test('notify broker: a channels value outside discord is rejected on the wire', async () => {
  const notifyApi = {
    sendNotification: async () => ({ ok: true, delivered: { discord: false, webhooks: 0, failed: 0 } }),
    subscribe: () => ({ ok: true, subscription: { id: 'sub-1' } }),
    unsubscribe: () => ({ ok: true }),
    listSubscriptions: () => [],
  };
  const notify = await broker.startNotifyBroker({
    notifyApi,
    sockPath: join(runtimeDir, 'ccserver-notify-channels-invalid.sock'),
  });
  try {
    const c = mcpClient(notify.sockPath);
    await c.connected;
    await c.call('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'wire-test', version: '1' },
    });
    const result = await callToolRaw(c, 'notify', { title: 'x', body: 'y', channels: ['bogus'] });
    assert.equal(result.isError, true, 'an enum value outside discord must be rejected by the schema');
    c.close();
  } finally {
    broker.stopBroker(notify);
  }
});

// A hostile identity frame must never crash the broker or leak into another
// connection: a frame that is not the {"ccserver": ...} shape is replayed as
// ordinary MCP bytes (dropped by the transport as malformed), and the
// connection serves a clean notify server.
test('notify broker: a non-ccserver first line is replayed, never treated as identity', async () => {
  const notifyApi = {
    sendNotification: async () => ({ ok: true, delivered: { discord: false, webhooks: 0, failed: 0 } }),
    subscribe: () => ({ ok: true, subscription: { id: 'sub-1' } }),
    unsubscribe: () => ({ ok: true }),
    listSubscriptions: () => [],
  };
  const notify = await broker.startNotifyBroker({
    notifyApi,
    sockPath: join(runtimeDir, 'ccserver-notify-junk.sock'),
  });
  try {
    const c = mcpClient(notify.sockPath);
    await c.connected;
    // {"ccserver": "not-an-object"} is not a valid identity frame.
    c.raw.write(`${JSON.stringify({ ccserver: 'junk' })}\n`);
    const init = await c.call('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'wire-test', version: '1' },
    });
    assert.equal(init.serverInfo.name, 'ccserver-notify');
    const { tools } = await c.call('tools/list');
    assert.equal(tools.length, 4);
    c.close();
  } finally {
    broker.stopBroker(notify);
  }
});

// The process-global usage broker (ccserver-usage, see usageMcp.js /
// mcpServer.js's buildUsageMcpServer): startUsageBroker hosts it at the
// caller-supplied socket, exposes exactly the one get_usage tool, and carries
// no identity frame (unlike notify -- get_usage answers the same regardless
// of caller, so a plain MCP client with no frame at all works identically).
test('usage broker: startUsageBroker + stopBroker lifecycle on a supplied socket path', async () => {
  const calls = [];
  const usageApi = {
    getUsage: async (args) => {
      calls.push(args);
      return { usage: { limits: [{ label: 'Current session', pct: 42 }] }, updatedAt: 123, cached: true };
    },
  };
  const usage = await broker.startUsageBroker({
    usageApi,
    sockPath: join(runtimeDir, 'ccserver-usage.sock'),
  });
  try {
    const c = mcpClient(usage.sockPath);
    await c.connected;
    const init = await c.call('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'wire-test', version: '1' },
    });
    assert.equal(init.serverInfo.name, 'ccserver-usage');
    const { tools } = await c.call('tools/list');
    assert.deepEqual(tools.map((t) => t.name), ['get_usage']);
    const out = await callTool(c, 'get_usage', {});
    assert.deepEqual(out, { usage: { limits: [{ label: 'Current session', pct: 42 }] }, updatedAt: 123, cached: true });
    assert.deepEqual(calls, [{ force: false }], 'no args -> force defaults to false');

    await callTool(c, 'get_usage', { force: true });
    assert.deepEqual(calls[1], { force: true });
    c.close();
  } finally {
    broker.stopBroker(usage);
    assert.equal(existsSync(usage.sockPath), false, 'stopBroker removes the socket file');
  }
});

// --- handoff reliability: events survive a dead wait (Issue: handoff loss)
// ---------------------------------------------------------------------------

// The root-cause regression test: production brokers inject the groupManager
// FACADE (not the full module), and repo_info calls deps.groupManager.getGroup.
// A facade missing getGroup made repo_info fail with a TypeError on every
// production call while the (full-module) unit tests stayed green. Over the
// wire this surfaces as an isError tools/call result -- assert it does not.
