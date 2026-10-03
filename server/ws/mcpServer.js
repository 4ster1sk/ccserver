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

// Process-global reviewer server (ccserver-reviewer, see reviewer.js): one
// socket for the whole server, with a per-connection identity (CCSERVER_REVIEWER_
// IDENTITY, `{ sessionId }`), because finish_review needs to verify its
// caller really is the session the job launched. run_review/list_reviews/
// get_review ignore it; their attribution (if any) still rides in
// run_review's own `requestedBy` argument.
//
// reviewerApi: { runReview, listReviews, getReview, finishReview }
export function buildReviewerMcpServer({ reviewerApi, identity }) {
  const server = new McpServer({ name: 'ccserver-reviewer', version: '1.0.0' });
  const text = (result) => ({ content: [{ type: 'text', text: JSON.stringify(result) }] });

  server.tool(
    'run_review',
    'Launch a disposable headless review session against a local git ref/branch/PR/uncommitted diff and run /code-review on it. Does NOT require a GitHub PR to exist -- unlike PR-only reviewers, this uses a real local git worktree, so it can review an unpushed local branch, a pushed-but-PR-less branch, or even uncommitted (dirty) changes. If number is given, the target is checked out via `gh pr checkout` and results are posted as a PR comment; otherwise results are only recorded in ccserver (see list_reviews/get_review) and delivered via notify when configured. Returns immediately with the job id and status "running" -- poll get_review (or list_reviews) for completion, this tool never blocks until the review finishes. focus is an optional free-form note on what to pay extra attention to (e.g. "focus on security"), appended to the /code-review prompt as-is.',
    {
      cwd: z.string(),
      headRef: z.string().optional(),
      baseRef: z.string().optional(),
      number: z.number().int().positive().optional(),
      includeUncommitted: z.boolean().optional(),
      app: z.enum(['claude', 'opencode', 'codex']).optional(),
      model: z.string().nullable().optional(),
      requestedBy: z.string().optional(),
      focus: z.string().optional(),
    },
    async (args) => text(await reviewerApi.runReview(args)),
  );

  server.tool(
    'list_reviews',
    'List past and in-progress review jobs for a project (id, mode, status, headRef/prNumber, createdAt, finishedAt) without full result text -- get_review for details.',
    { cwd: z.string().optional(), limit: z.number().int().positive().max(100).optional() },
    async (args) => text(reviewerApi.listReviews(args)),
  );

  server.tool(
    'get_review',
    'Fetch one review job by id, including its result_summary and whether it was posted to the PR.',
    { id: z.string() },
    async (args) => text(reviewerApi.getReview(args)),
  );

  server.tool(
    'finish_review',
    'Called by the review session ITSELF, once it is done, to report the outcome and trigger cleanup (worktree/sandbox teardown, DB record) -- this is the authoritative way a run_review job completes; ccserver only falls back to an idle/absolute-timeout guess if this is never called (e.g. the session crashes). Only the session that IS the job (its own connection identity must match the job\'s sessionId) may call it, and jobId must still be "running" -- calling it twice, from the wrong session, or for an unknown/already-finished job is refused. status is "done" (review completed normally) or "failed" (could not complete the review); summary is an optional free-form note on what was found -- omit it to fall back to the session\'s own recent output.',
    {
      jobId: z.string(),
      status: z.enum(['done', 'failed']),
      summary: z.string().optional(),
    },
    async (args) => text(await reviewerApi.finishReview({ ...args, callerSessionId: identity?.sessionId ?? null })),
  );

  return server;
}

