// Process-global MCP servers share a newline-delimited Unix-socket transport.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

// Newline-delimited JSON frames: a well-behaved MCP client sends a newline
// per message, so a buffer beyond this means the peer is not speaking MCP
// (or is hostile). Bounds the memory a single connection can pin. Exported
// so the broker can size the pre-transport identity-frame read identically
// (see mcpBroker.js).
export const MAX_TRANSPORT_BUFFER_CHARS = 1024 * 1024;

export class SocketTransport {
  // `initialBuffer` seeds the parser with bytes already read before the
  // transport took over (the broker replays a non-identity first line here).
  constructor(socket, initialBuffer = '') {
    this.socket = socket;
    this._buf = initialBuffer;
    this._closed = false;
  }

  start() {
    this.socket.setEncoding('utf-8');
    this.socket.on('data', (chunk) => {
      if (this._closed) return;
      this._buf += chunk;
      this._drain();
    });
    this.socket.on('close', () => {
      this._closed = true;
      this.onclose?.();
    });
    this.socket.on('error', (e) => this.onerror?.(e));
    // The broker pauses the socket while it reads the identity frame; resume
    // it now that this transport owns the connection.
    this.socket.resume();
    // Drain bytes seeded before start (a replayed non-identity first line) --
    // onmessage is wired by the MCP SDK before start() is called.
    this._drain();
  }

  _drain() {
    // The socket path is reachable by anything running as the same user;
    // a peer that never sends a newline
    // must not be able to grow this buffer without bound. Over the cap,
    // drop the connection (the in-flight partial frame is unrecoverable).
    if (this._buf.length > MAX_TRANSPORT_BUFFER_CHARS) {
      try { this.socket.destroy(); } catch { /* already gone */ }
      this._closed = true;
      return;
    }
    let nl;
    while ((nl = this._buf.indexOf('\n')) !== -1) {
      const line = this._buf.slice(0, nl);
      this._buf = this._buf.slice(nl + 1);
      if (line.trim()) {
        try {
          this.onmessage?.(JSON.parse(line));
        } catch {
          // drop malformed frames
        }
      }
    }
  }

  send(message) {
    this.socket.write(`${JSON.stringify(message)}\n`);
    return Promise.resolve();
  }

  close() {
    this.socket.end();
  }
}

// Process-global notification server (ccserver-notify, see notify.js): one
// socket hosts it for the whole server, and its tools reach the shared subscription registry /
// Discord webhook via the closed `notifyApi` facade. Identity is never taken
// from the wire -- it arrives per-connection via the broker's identity frame
// (see mcpBroker.js) and is only an attribution (source display for the
// "_from:" footer), never an authorization input.
//
// notifyApi: { sendNotification, subscribe, unsubscribe, listSubscriptions }
export function buildNotifyMcpServer({ notifyApi, identity }) {
  const server = new McpServer({ name: 'ccserver-notify', version: '1.0.0' });

  server.tool(
    'notify',
    'Deliver a notification to every configured channel (the Discord webhook set in sandbox.config.json, plus every webhook currently subscribed via subscribe). Use this when you need human attention that the terminal alone cannot provide. level is an optional severity (info/success/warning/error) reflected in the payload. channels is optional: omit it to deliver to every configured channel; pass a subset to restrict delivery -- \'discord\' means the Discord webhook + every subscribed webhook together, \'webpush\' means the browsers/phones subscribed to this server\'s PWA notifications.',
    {
      title: z.string(),
      body: z.string(),
      level: z.enum(['info', 'success', 'warning', 'error']).optional(),
      channels: z.array(z.enum(['discord', 'webpush'])).optional(),
    },
    async (args) => ({ content: [{ type: 'text', text: JSON.stringify(await notifyApi.sendNotification(args, identity)) }] }),
  );

  server.tool(
    'subscribe',
    'Register a webhook URL (https only) to receive future notify deliveries. Subscriptions are persisted server-side and survive a restart. Returns the created subscription (with its id) for later unsubscribe.',
    { url: z.string(), name: z.string().optional() },
    async (args) => ({ content: [{ type: 'text', text: JSON.stringify(notifyApi.subscribe(args)) }] }),
  );

  server.tool(
    'unsubscribe',
    'Remove a webhook subscription by its id (see subscribe / list_subscriptions).',
    { subscriptionId: z.string() },
    async (args) => ({ content: [{ type: 'text', text: JSON.stringify(notifyApi.unsubscribe(args)) }] }),
  );

  server.tool(
    'list_subscriptions',
    'List all currently subscribed webhook URLs (id, url, name, createdAt).',
    {},
    async () => ({ content: [{ type: 'text', text: JSON.stringify({ subscriptions: notifyApi.listSubscriptions() }) }] }),
  );

  return server;
}

// Process-global usage server (ccserver-usage, see usageMcp.js). One socket
// hosts it for the whole server. Unlike notify, get_usage carries no identity -- it
// always returns the same server-wide snapshot regardless of who asks -- so
// buildServer's identity argument is simply unused here.
//
// usageApi: { getUsage }
export function buildUsageMcpServer({ usageApi }) {
  const server = new McpServer({ name: 'ccserver-usage', version: '1.0.0' });

  server.tool(
    'get_usage',
    'Get the current Claude usage snapshot (session/weekly percentage used, reset times, plan). Cached ~1 minute server-side; pass force:true to bypass the cache and re-capture immediately (slower, up to ~15s).',
    { force: z.boolean().optional() },
    async (args) => ({ content: [{ type: 'text', text: JSON.stringify(await usageApi.getUsage({ force: !!args?.force })) }] }),
  );

  return server;
}

