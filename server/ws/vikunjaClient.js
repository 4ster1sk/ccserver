// Vikunja task tracking for ccserver-notify (see notify.js). A `notify` call
// also creates/updates a Vikunja task per tracking key (identity.groupId ??
// identity.sessionId), so a human who misses the Discord ping still finds an
// actionable item in Vikunja. See tmp/notify-vikunja-integration-plan.md
// sections 2-3 for the full design rationale.
//
// The REST calls below were verified against the official Vikunja OpenAPI
// spec (<instance>/api/v1/docs.json, a Swagger 2.0 doc; checked against
// https://try.vikunja.io on 2026-08-21) -- the vikunja-agent-tools README this
// plan was scoped from does not document exact paths:
//   PUT    /projects/{id}/tasks        create task    { title, description }
//   PUT    /tasks/{id}/comments        add a comment  { comment }
//   GET    /labels?s=<title>           find a label by title (labels are
//                                      global per Vikunja account, not
//                                      per-project)
//   PUT    /labels                     create a label { title, hex_color }
//   PUT    /tasks/{id}/labels          attach a label { label_id }
//   DELETE /tasks/{id}/labels/{label}  detach a label
//
// Deliberately not implemented (see plan 2.3 / section 5): marking a task
// done, deleting it, or re-checking its live labels before updating it --
// tracking state lives purely in .saved-vikunja-tasks.json, so a task a human
// completed by hand in Vikunja can still get a stray comment on the next
// notify (an accepted tradeoff, not a bug).

import { readFileSync, writeFileSync } from 'node:fs';
import { hostname as osHostname } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Agent } from 'undici';
import { loadSandboxConfig } from './sandbox.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function tasksPath() {
  return process.env.CCSERVER_VIKUNJA_TASKS_PATH || join(__dirname, '..', '..', '.saved-vikunja-tasks.json');
}

const MAX_ATTEMPTS = 3;
const RETRY_BASE_MS = 50;
const LEVEL_EMOJI = { info: 'ℹ️', success: '✅', warning: '⚠️', error: '🚨' };

// notify level -> Vikunja status label suffix + label color (plan 2.3).
// `success` is the only terminal level -- error/warning stay tracked so a
// human working the Vikunja backlog keeps seeing updates until they resolve
// it out-of-band (Discord is easy to miss; Vikunja is meant to be the TODO
// list that isn't).
const LEVEL_STATUS = {
  info: { suffix: 'running', color: '3498db' },
  success: { suffix: 'completed', color: '2ecc71' },
  warning: { suffix: 'blocked', color: 'f39c12' },
  error: { suffix: 'needs-input', color: 'e74c3c' },
};
const TERMINAL_LEVELS = new Set(['success']);

// baseUrl/apiToken/projectId/etc are already resolved (env > config file >
// default) by loadSandboxConfig -- see sandbox.js's rawVikunja parsing.
export function vikunjaConfig() {
  return loadSandboxConfig().notify?.vikunja || {};
}

export function vikunjaEnabled() {
  const cfg = vikunjaConfig();
  return !!(cfg.baseUrl && cfg.apiToken);
}

function readTasks() {
  try {
    const raw = JSON.parse(readFileSync(tasksPath(), 'utf-8'));
    return (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  } catch {
    return {};
  }
}

function writeTasks(map) {
  try {
    writeFileSync(tasksPath(), JSON.stringify(map));
  } catch {
    // best effort -- mirrors notify.js's persistNotify
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Duplicated (not imported) from notify.js's resolvedHostname/buildAttribution:
// notify.js imports this module, so importing back would create a cycle.
// Kept deliberately small.
function resolvedHost() {
  const notify = loadSandboxConfig().notify || {};
  return process.env.CCSERVER_HOSTNAME || notify.hostname || osHostname();
}

function shortId(id) {
  return String(id).slice(0, 8);
}

function projectLabel(identity) {
  if (identity?.projectName) return String(identity.projectName);
  const cwd = identity?.cwd;
  if (!cwd || cwd === '/') return null;
  return basename(cwd);
}

function footer(identity) {
  const parts = [resolvedHost()];
  const project = projectLabel(identity);
  if (project) parts.push(project);
  if (identity?.groupId) parts.push(`group ${shortId(identity.groupId)}`);
  if (identity?.sessionId) parts.push(`session ${shortId(identity.sessionId)}`);
  return `\n\n_from: ${parts.join(' · ')}`;
}

// A dispatcher that skips TLS verification, for notify.vikunja.verifyTls:
// false (self-signed instances). Built with the `undici` package pinned to
// the major version Node's own built-in fetch bundles internally -- a
// mismatched version makes fetch reject the dispatcher outright (see the
// npm undici@8 vs Node 22's bundled v6 incompatibility found while
// implementing this). Lazily created and cached: most setups never need it.
let insecureDispatcher = null;
function dispatcherFor(config) {
  if (config.verifyTls !== false) return undefined;
  if (!insecureDispatcher) insecureDispatcher = new Agent({ connect: { rejectUnauthorized: false } });
  return insecureDispatcher;
}

const BODY_LOG_MAX_CHARS = 500;

// Best-effort: read the response body for a failure log line only. Never
// throws -- a read failure just means the log line omits the body, it must
// not affect the { ok: false, ... } result the caller already gets. Safe to
// log (unlike the URL/token, see below): it's Vikunja's response, not the
// request's secrets.
async function readBodyForLog(res) {
  try {
    const text = await res.text();
    if (!text) return null;
    return text.length > BODY_LOG_MAX_CHARS ? `${text.slice(0, BODY_LOG_MAX_CHARS)}…` : text;
  } catch {
    return null;
  }
}

// Low-level request: 4xx fails immediately (no retry), 5xx and network/
// timeout errors retry up to MAX_ATTEMPTS with exponential backoff (plan 3).
// `label` is a short static tag for logging -- never the URL or headers,
// since the base URL plus the bearer token must never reach the log (plan
// 2.5).
async function vikunjaFetch(config, method, path, body, label) {
  const url = `${config.baseUrl}/api/v1${path}`;
  const headers = { Authorization: `Bearer ${config.apiToken}`, 'Content-Type': 'application/json' };
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), (config.timeoutSeconds || 15) * 1000);
    try {
      const res = await fetch(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
        dispatcher: dispatcherFor(config),
      });
      clearTimeout(timer);
      if (res.ok) {
        // The HTTP request itself already succeeded -- never fall through to
        // the retry path below over a body we failed to read/parse, since
        // that would resend a non-idempotent PUT/DELETE (e.g. a duplicate
        // task or comment) for a request Vikunja already applied.
        let responseBody = null;
        try {
          const text = await res.text();
          responseBody = text ? JSON.parse(text) : null;
        } catch { /* treat as no body -- still a success */ }
        return { ok: true, status: res.status, body: responseBody };
      }
      if (res.status < 500) {
        const bodyText = await readBodyForLog(res);
        console.warn(`[vikunja] ${label} failed: HTTP ${res.status}${bodyText ? ` -- ${bodyText}` : ''}`);
        return { ok: false, status: res.status, body: null };
      }
      if (attempt === MAX_ATTEMPTS) {
        const bodyText = await readBodyForLog(res);
        console.warn(`[vikunja] ${label} failed after ${MAX_ATTEMPTS} attempts: HTTP ${res.status}${bodyText ? ` -- ${bodyText}` : ''}`);
        return { ok: false, status: res.status, body: null };
      }
    } catch (err) {
      clearTimeout(timer);
      if (attempt === MAX_ATTEMPTS) {
        console.warn(`[vikunja] ${label} failed after ${MAX_ATTEMPTS} attempts: ${err.name === 'AbortError' ? 'timeout' : err.message}`);
        return { ok: false, status: null, body: null };
      }
    }
    await sleep(RETRY_BASE_MS * 2 ** (attempt - 1));
  }
  return { ok: false, status: null, body: null };
}

async function findLabelId(config, title) {
  const res = await vikunjaFetch(config, 'GET', `/labels?s=${encodeURIComponent(title)}`, undefined, 'find-label');
  if (!res.ok || !Array.isArray(res.body)) return null;
  const exact = res.body.find((l) => l && l.title === title);
  return exact ? exact.id : null;
}

async function findOrCreateLabelId(config, title, color) {
  const existing = await findLabelId(config, title);
  if (existing != null) return existing;
  const created = await vikunjaFetch(config, 'PUT', '/labels', { title, hex_color: color }, 'create-label');
  return created.ok && created.body ? created.body.id : null;
}

// Detach the previous status label (if resolvable -- best effort, never
// blocks the swap) and attach the next one, auto-creating it if this is the
// project's first task at that status (plan 5.4).
async function swapStatusLabel(config, taskId, prevLevel, nextLevel) {
  const prefix = config.statusLabelPrefix || 'status-';
  const next = LEVEL_STATUS[nextLevel] || LEVEL_STATUS.info;
  if (prevLevel) {
    const prev = LEVEL_STATUS[prevLevel] || LEVEL_STATUS.info;
    if (prev.suffix !== next.suffix) {
      const prevId = await findLabelId(config, `${prefix}${prev.suffix}`);
      if (prevId != null) {
        await vikunjaFetch(config, 'DELETE', `/tasks/${taskId}/labels/${prevId}`, undefined, 'detach-label');
      }
    }
  }
  const nextId = await findOrCreateLabelId(config, `${prefix}${next.suffix}`, next.color);
  if (nextId != null) {
    await vikunjaFetch(config, 'PUT', `/tasks/${taskId}/labels`, { label_id: nextId }, 'attach-label');
  }
}

function commentText(title, body, level) {
  const emoji = level && LEVEL_EMOJI[level] ? `${LEVEL_EMOJI[level]} ` : '';
  const t = typeof title === 'string' ? title : '';
  const b = typeof body === 'string' ? body : '';
  return `${emoji}${t}${b ? `\n${b}` : ''}`.trim();
}

// Create or update the Vikunja task tracked for `key` (plan 2.1/2.2). Never
// throws; a failure at any step is logged and returned as { ok: false } so
// sendNotification's non-blocking contract (notify.js) holds.
export async function createOrUpdateTask({ key, title, body, level, identity }) {
  if (key == null) return { ok: false, action: 'skipped', taskId: null };
  const config = vikunjaConfig();
  if (!(config.baseUrl && config.apiToken)) return { ok: false, action: 'skipped', taskId: null };
  const lvl = LEVEL_STATUS[level] ? level : 'info';

  const tasks = readTasks();
  const existing = tasks[key];

  if (!existing) {
    if (!config.projectId) {
      console.warn('[vikunja] create-task skipped: no projectId configured');
      return { ok: false, action: 'error', taskId: null };
    }
    const description = `${typeof body === 'string' ? body : ''}${footer(identity)}`;
    const created = await vikunjaFetch(
      config, 'PUT', `/projects/${config.projectId}/tasks`,
      { title: typeof title === 'string' ? title : '', description },
      'create-task',
    );
    if (!created.ok || !created.body?.id) return { ok: false, action: 'error', taskId: null };
    const taskId = created.body.id;
    await swapStatusLabel(config, taskId, null, lvl);
    tasks[key] = { taskId, lastLevel: lvl, createdAt: Date.now() };
    writeTasks(tasks);
    return { ok: true, action: 'created', taskId };
  }

  const taskId = existing.taskId;
  const comment = await vikunjaFetch(
    config, 'PUT', `/tasks/${taskId}/comments`,
    { comment: commentText(title, body, level) },
    'add-comment',
  );
  await swapStatusLabel(config, taskId, existing.lastLevel, lvl);
  if (TERMINAL_LEVELS.has(lvl)) {
    delete tasks[key];
  } else {
    tasks[key] = { ...existing, lastLevel: lvl };
  }
  writeTasks(tasks);
  return { ok: comment.ok, action: 'updated', taskId };
}
