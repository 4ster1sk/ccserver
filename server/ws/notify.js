// ccserver-notify: the server-global notification MCP server. Replaces the old
// idle-based "input_needed" heuristic (see the notify-mcp plan / README) with
// an explicit tool the agent can call when it actually needs attention.
//
// Process-wide concepts (NOT group-scoped like the control/handoff brokers):
//   - the subscription registry (webhook URLs registered at runtime via the
//     MCP `subscribe` tool, seeded at boot from sandbox.config.json's
//     `notify.subscriptions`),
//   - the Discord webhook (sandbox.config.json `notify.discordWebhook`, https
//     only, overridable via CCSERVER_DISCORD_WEBHOOK),
//   - delivery to all of the above over global fetch (10s timeout,
//     non-blocking: a failing webhook is logged, never thrown).
//
// One Unix socket hosts it for the whole server process
// (${XDG_RUNTIME_DIR}/ccserver-notify.sock, see getNotifySockPath). Each
// session's sandbox binds that one socket in; the MCP config tells the agent
// to reach it through the same bridge wrapper as the group brokers (see
// mcpConfig.js / sandbox-mcp-wrapper.cjs).
//
// This module imports mcpBroker.js lazily (dynamic import) so the static
// import graph stays acyclic: sessionManager -> notify -> sandbox, and the
// broker/server/tools modules pull in sessionManager (via mcpTools) -- the
// broker wiring is only touched at runtime, never at module evaluation.

import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSandboxConfig } from './sandbox.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Persisted subscription registry (same pattern as .saved-groups.json /
// .saved-sessions.json). Read at each use (like loadSandboxConfig's env
// override) so tests can point it at a temp file without touching the real
// repo-root state file.
function notifyPath() {
  return process.env.CCSERVER_NOTIFY_PATH || join(__dirname, '..', '..', '.saved-notifications.json');
}

const NOTIFY_SOCKET_NAME = 'ccserver-notify.sock';
const DELIVERY_TIMEOUT_MS = 10_000;

const LEVEL_EMOJI = { info: 'ℹ️', success: '✅', warning: '⚠️', error: '🚨' };

// The in-memory registry: { id, url, name, createdAt }.
let subscriptions = [];
let notifyBroker = null; // { server, sockPath, dir, connections } | null

function loadNotifyConfig() {
  return loadSandboxConfig().notify || { discordWebhook: null, subscriptions: [] };
}

function isValidWebhookUrl(url) {
  return typeof url === 'string' && url.startsWith('https://');
}

export function getNotifySockPath() {
  const base = process.env.XDG_RUNTIME_DIR
    || (typeof process.getuid === 'function' ? `/run/user/${process.getuid()}` : '/tmp');
  return join(base, NOTIFY_SOCKET_NAME);
}

// Whether the notify feature is on at all: a Discord webhook configured, or a
// non-empty subscription registry (seed + runtime). When false, no MCP server
// is injected into sessions (see shouldInjectNotify).
export function notifyEnabled() {
  const cfg = loadNotifyConfig();
  return !!(cfg.discordWebhook || subscriptions.length > 0);
}

// Pure injection decision for createSession:
//   - shells (app null) never get it,
//   - workers (groupRole !== 'orchestrator') never get it -- only the
//     orchestrator of a combo and standalone agent sessions do,
//   - nothing is injected when the feature is disabled.
export function shouldInjectNotify({ shell, app, groupId, groupRole, notifyEnabled }) {
  return !shell && app != null && !!notifyEnabled
    && (groupId == null || groupRole === 'orchestrator');
}

export function listSubscriptions() {
  return subscriptions.map((s) => ({ id: s.id, url: s.url, name: s.name, createdAt: s.createdAt }));
}

function persistNotify() {
  try {
    writeFileSync(notifyPath(), JSON.stringify({ subscriptions: listSubscriptions() }));
  } catch {
    // best effort -- persistence must never break subscribe/unsubscribe
  }
}

export function subscribe({ url, name }) {
  if (!isValidWebhookUrl(url)) {
    return { error: 'invalid-url', message: 'webhook url must be an https:// URL' };
  }
  const sub = {
    id: randomUUID(),
    url,
    name: typeof name === 'string' && name.length > 0 ? name : null,
    createdAt: Date.now(),
  };
  subscriptions.push(sub);
  persistNotify();
  return { ok: true, subscription: { id: sub.id, url: sub.url, name: sub.name, createdAt: sub.createdAt } };
}

export function unsubscribe(subscriptionId) {
  const idx = subscriptions.findIndex((s) => s.id === subscriptionId);
  if (idx === -1) return { error: 'not-found' };
  subscriptions.splice(idx, 1);
  persistNotify();
  return { ok: true };
}

// Boot-time restore: seed the registry from sandbox.config.json's
// `notify.subscriptions` (a subscription-less install has no MCP to call
// `subscribe` with, so this is the only way to start from subscriptions
// alone), then overlay the persisted registry (which also holds runtime-only
// additions). Identical URLs are deduped so a seed never double-delivers.
export function restoreNotify() {
  const cfg = loadNotifyConfig();
  const seen = new Set();
  subscriptions = [];
  const add = (url, name, id, createdAt) => {
    if (!isValidWebhookUrl(url) || seen.has(url)) return;
    seen.add(url);
    subscriptions.push({
      id: typeof id === 'string' && id ? id : randomUUID(),
      url,
      name: typeof name === 'string' && name.length > 0 ? name : null,
      createdAt: typeof createdAt === 'number' ? createdAt : Date.now(),
    });
  };
  for (const s of cfg.subscriptions) {
    if (s && typeof s === 'object') add(s.url, s.name);
  }
  try {
    const raw = JSON.parse(readFileSync(notifyPath(), 'utf-8'));
    if (raw && Array.isArray(raw.subscriptions)) {
      for (const s of raw.subscriptions) {
        if (s && typeof s === 'object') add(s.url, s.name, s.id, s.createdAt);
      }
    }
  } catch {
    // no persisted registry yet -- the seed alone is fine
  }
  return { subscriptions: listSubscriptions() };
}

function buildContent({ title, body, level }) {
  const t = typeof title === 'string' ? title : '';
  const b = typeof body === 'string' ? body : '';
  if (!t && !b) return '';
  const prefix = level && LEVEL_EMOJI[level] ? `${LEVEL_EMOJI[level]} ` : '';
  return `${prefix}${t}${b ? `\n${b}` : ''}`.trim();
}

async function deliver(url, content) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, username: 'ccserver' }),
      signal: controller.signal,
    });
    return res.ok;
  } catch (err) {
    console.warn(`[notify] delivery to ${url} failed: ${err.message}`);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// Dispatch to every configured channel (Discord webhook + each subscribed
// webhook), all non-blocking. Returns the delivery tally for the MCP tool's
// result payload; never throws.
export async function sendNotification({ title, body, level } = {}) {
  const content = buildContent({ title, body, level });
  const cfg = loadNotifyConfig();
  if (!content) {
    return { ok: true, delivered: { discord: false, webhooks: 0, failed: 0 } };
  }
  const targets = [];
  if (cfg.discordWebhook) targets.push(cfg.discordWebhook);
  for (const s of subscriptions) targets.push(s.url);
  const results = await Promise.all(targets.map((url) => deliver(url, content)));
  const discord = cfg.discordWebhook ? results[0] : false;
  const webhookResults = cfg.discordWebhook ? results.slice(1) : results;
  return {
    ok: true,
    delivered: {
      discord,
      webhooks: webhookResults.filter(Boolean).length,
      failed: webhookResults.filter((r) => !r).length,
    },
  };
}

// The notifyApi facade handed to buildNotifyMcpServer (see mcpServer.js).
// Deliberately a closed object rather than the module namespace, mirroring
// groupManager's facade pattern.
export const notifyApi = {
  sendNotification,
  subscribe,
  unsubscribe,
  listSubscriptions,
};

// Start (once) the global Unix-socket broker hosting ccserver-notify. Callers
// must await it before launching sessions: bwrap's --bind-try snapshots the
// socket file at mount time, so the file must exist first. Safe to call
// repeatedly -- the second call is a no-op returning the existing socket path.
export async function ensureNotifyBroker() {
  if (notifyBroker) return notifyBroker.sockPath;
  const broker = await import('./mcpBroker.js');
  stopBrokerFn = broker.stopBroker;
  notifyBroker = await broker.startNotifyBroker({
    notifyApi,
    sockPath: getNotifySockPath(),
  });
  return notifyBroker.sockPath;
}

// Whether the global broker is actually listening right now. Injecting the
// notify MCP into a session whose socket was never started (broker startup
// failure, or a config edit that enables notify without a restart) would give
// the agent a bridge to a socket nobody is listening on -- the wrapper would
// exhaust its retries and the MCP server would just fail. createSession gates
// its injection on this in addition to shouldInjectNotify.
export function notifyBrokerRunning() {
  return !!notifyBroker;
}

// Teardown for graceful shutdown. Synchronous (the stopBroker reference is
// cached on the first ensureNotifyBroker call). Best effort; a stale socket
// file is removed by the next boot's listenMcp anyway.
let stopBrokerFn = null;
export function stopNotifyBroker() {
  if (!notifyBroker) return;
  try {
    if (stopBrokerFn) stopBrokerFn(notifyBroker);
  } catch {
    // best effort
  }
  notifyBroker = null;
}
