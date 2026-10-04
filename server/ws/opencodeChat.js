// Chat mode, server side (see opencode-chat-bridge.cjs / claude-chat-bridge.cjs
// for the sandbox side and routes/opencodeChat.js for the browser-facing
// proxy). Both bridges serve opencode's v2 API -- `opencode serve` itself,
// or Claude Code through the claude-chat-adapter package -- so everything
// here is the same for either app.
//
// A chat session's record carries `chat`:
//
//   { dir, sock, password, bridgeScript, bridgeArgs, stages, ocSessionId, ready, error, resumeLast, model, defaultModel }
//
//   dir/sock:  the per-session host dir and the relay socket in it (bound
//              into bwrap, or the host end of the VM ssh's -L forward)
//   password:  the bridge's Basic-auth password, minted per session.
//              Only ccserver's proxy ever sends it; the browser never sees it
//   bridgeScript/bridgeArgs: the app's bridge (host path) and its own flags
//   stages:    the startup list (chatStages.js)
//   ready:     the opencode session exists and the proxy may forward
//   model:     the launch's explicit `provider/model`, if any
//   defaultModel: the app's recorded default model ref (chatDefaults.js),
//              read at launch; used when there is no explicit model
//
// Everything here talks to serve over that socket.

import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyStage, chatStageIds, failCurrentStage, initialChatStages, parseStageMarkers } from './chatStages.js';
import { CHAT_BRIDGE_SCRIPT, CHAT_PASSWORD_NAME, CHAT_SOCK_NAME } from './sandbox.js';
import { ensureHostRuntimeDir } from './git-broker.js';
import { claudeChatBridgeSource } from './claudeChat.js';

const REQUEST_TIMEOUT_MS = 30_000;
// How much of the previous pty chunk is kept so a stage marker split across
// two chunks is still seen whole (a marker is well under this).
const MARKER_CARRY_CHARS = 512;

// Creates the per-session dir with the password file in it. The caller owns
// removal (removeChatDir) on every failure path and at teardown.
// A unix socket path must fit sockaddr_un's sun_path (108 bytes on Linux,
// 104 on macOS, NUL included). libuv truncates a longer one instead of
// failing, so two sessions could end up binding the same truncated name.
const MAX_SOCK_PATH_BYTES = 103;

// The bridge file a Claude Code chat session runs, inside its chat dir.
export const CLAUDE_BRIDGE_NAME = 'bridge.cjs';

// opts: { app, resumeLast, resumeId } -- resuming is the bridge's job for
// Claude Code (it picks the transcript and shows its history); opencode's
// bridge takes none of it (initChatSession reopens the session over the API).
export function prepareChatDir(sessionId, { app = 'opencode', resumeLast = false, resumeId = null } = {}) {
  const base = ensureHostRuntimeDir();
  // Short on purpose (see MAX_SOCK_PATH_BYTES): the uuid's first 16 hex
  // digits are plenty to tell live sessions apart.
  const dir = join(base, `ccs-chat-${sessionId.replace(/-/g, '').slice(0, 16)}`);
  const sock = join(dir, CHAT_SOCK_NAME);
  if (Buffer.byteLength(sock) > MAX_SOCK_PATH_BYTES) {
    throw new Error(`the runtime dir path is too long for a unix socket (${sock}); set XDG_RUNTIME_DIR to a shorter directory`);
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const password = randomBytes(32).toString('base64url');
  writeFileSync(join(dir, CHAT_PASSWORD_NAME), `${password}\n`, { mode: 0o600 });
  if (app !== 'claude') return { dir, sock, password, bridgeScript: CHAT_BRIDGE_SCRIPT, bridgeArgs: [] };
  const bridgeScript = join(dir, CLAUDE_BRIDGE_NAME);
  writeFileSync(bridgeScript, claudeChatBridgeSource(), { mode: 0o644 });
  const bridgeArgs = resumeId ? ['--resume', resumeId] : resumeLast ? ['--resume-last'] : [];
  return { dir, sock, password, bridgeScript, bridgeArgs };
}

export function removeChatDir(dir) {
  if (!dir) return;
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

export function createChatState({ dir, sock, password, bridgeScript = null, bridgeArgs = [], app = 'opencode', sandboxed, backend, pooled, resumeLast, model, defaultModel }) {
  const stages = initialChatStages(chatStageIds({ sandboxed, backend, pooled }));
  // The sandbox (if any) is built by the time the record exists.
  if (sandboxed) applyStage(stages, 'sandbox', 'done');
  return {
    dir, sock, password, bridgeScript, bridgeArgs, app, stages,
    ocSessionId: null, ready: false, error: null,
    resumeLast: !!resumeLast, model: model || null, defaultModel: defaultModel || null,
    markerCarry: '', initStarted: false,
  };
}

// What the browser may see: never the password or host paths.
export function publicChatState(chat) {
  if (!chat) return null;
  return {
    app: chat.app,
    stages: chat.stages.map((s) => ({ ...s })),
    ocSessionId: chat.ocSessionId,
    ready: chat.ready,
    error: chat.error,
  };
}

// Feeds one pty chunk. Returns { changed, agentUp } so the caller can
// broadcast and start the session init.
export function feedChatOutput(chat, data) {
  const text = chat.markerCarry + data;
  const markers = parseStageMarkers(text);
  let changed = false;
  let agentUp = false;
  let consumed = 0;
  for (const m of markers) {
    consumed = m.end;
    if (applyStage(chat.stages, m.id, m.state, m.message)) changed = true;
    if (m.state === 'error') {
      chat.error = m.message || `${m.id} failed`;
      changed = true;
    }
    if (m.id === 'agent' && m.state === 'done') agentUp = true;
  }
  // Everything up to the last marker is spent; only a possible partial
  // marker at the tail is carried into the next chunk.
  chat.markerCarry = text.slice(Math.max(consumed, text.length - MARKER_CARRY_CHARS));
  return { changed, agentUp };
}

export function failChat(chat, message) {
  if (chat.ready) return false;
  chat.error = chat.error || message;
  // A stage that already failed is the cause; the exit is its consequence.
  if (chat.stages.some((s) => s.state === 'error')) return true;
  return failCurrentStage(chat.stages, message);
}

// One request to serve over the relay socket. Resolves { status, body }
// with body parsed as JSON when it is JSON.
export function chatRequest(chat, method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({
      socketPath: chat.sock,
      method,
      path,
      headers: {
        host: 'opencode',
        authorization: basicAuth(chat.password),
        accept: 'application/json',
        ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
      },
      timeout: REQUEST_TIMEOUT_MS,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf-8');
        let parsed = raw;
        try { parsed = raw ? JSON.parse(raw) : null; } catch { /* not JSON */ }
        resolve({ status: res.statusCode, body: parsed });
      });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error(`opencode request timed out: ${method} ${path}`)));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

export function basicAuth(password) {
  return `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`;
}

// ccserver's model strings are opencode's `provider/model` (the --model
// form); the API wants a Model.Ref.
export function modelRefFromString(model) {
  if (typeof model !== 'string') return null;
  const i = model.indexOf('/');
  if (i <= 0 || i === model.length - 1) return null;
  return { providerID: model.slice(0, i), id: model.slice(i + 1) };
}

// The model a session opened by initChatSession should use: the launch's
// explicit one, else the app's recorded default. `fromDefault` tells the
// caller a failure to apply it is no reason to fail the launch.
function initialModel(chat) {
  const explicit = modelRefFromString(chat.model);
  if (explicit) return { model: explicit, fromDefault: false };
  if (chat.defaultModel) return { model: chat.defaultModel, fromDefault: true };
  return { model: null, fromDefault: false };
}

// Creates the conversation with `model`. A recorded default the agent
// refuses (a model gone from its catalog) falls back to the agent's own.
async function createSession(chat) {
  const { model, fromDefault } = initialModel(chat);
  let created = await chatRequest(chat, 'POST', '/api/session', model ? { model } : {});
  if (fromDefault && created.status !== 200) {
    created = await chatRequest(chat, 'POST', '/api/session', {});
  }
  if (created.status !== 200 || !created.body?.data?.id) {
    throw new Error(`could not create the opencode session (HTTP ${created.status})`);
  }
  return created.body.data.id;
}

// A resumed conversation keeps its own model; only one the agent did not
// remember (Claude Code's adapter starts every process on "default") gets
// the recorded default. Best effort: the session works either way.
async function applyModelOnResume(chat, id) {
  if (!chat.defaultModel || modelRefFromString(chat.model)) return;
  try {
    const path = `/api/session/${encodeURIComponent(id)}`;
    const info = await chatRequest(chat, 'GET', path);
    const current = info.status === 200 ? info.body?.data?.model : null;
    if (info.status === 200 && (!current?.id || current.id === 'default')) {
      await chatRequest(chat, 'POST', `${path}/model`, { model: chat.defaultModel });
    }
  } catch { /* keep the agent's model */ }
}

// Opens the conversation once serve is up: the most recent session of the
// directory for a resume, else a new one. Retries briefly -- on the qemu
// backend the ssh -L forward may lag the bridge's "listening" a moment.
export async function initChatSession(chat, { onChange, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  if (chat.initStarted) return;
  chat.initStarted = true;
  applyStage(chat.stages, 'session', 'running');
  onChange?.();
  let lastError = null;
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      let id = null;
      if (chat.resumeLast) {
        const list = await chatRequest(chat, 'GET', '/api/session');
        if (list.status === 200 && Array.isArray(list.body?.data) && list.body.data.length > 0) {
          const latest = [...list.body.data].sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0))[0];
          id = latest.id;
        }
      }
      if (id) await applyModelOnResume(chat, id);
      else id = await createSession(chat);
      chat.ocSessionId = id;
      chat.ready = true;
      applyStage(chat.stages, 'session', 'done');
      onChange?.();
      return;
    } catch (err) {
      lastError = err;
      // A refused/missing socket is the forward catching up; anything that
      // got an HTTP answer will not fix itself.
      if (!/ECONNREFUSED|ENOENT|ECONNRESET|socket hang up/.test(err.message)) break;
      await sleep(300 * (attempt + 1));
    }
  }
  chat.error = lastError?.message || 'could not open the opencode session';
  applyStage(chat.stages, 'session', 'error', chat.error);
  onChange?.();
}

// Sends `text` as a user prompt (scheduled prompts, MCP send_input -- the
// paths that type into a terminal session's TUI). Queued behind a running
// turn rather than steering it, like typing into a busy TUI.
export async function sendChatPrompt(chat, text) {
  if (!chat?.ready || !chat.ocSessionId) return false;
  const res = await chatRequest(chat, 'POST', `/api/session/${encodeURIComponent(chat.ocSessionId)}/prompt`, { text, delivery: 'queue' });
  return res.status === 200;
}

// ---- auto-approval (Auto-Y) ----------------------------------------------
//
// A chat session has no TUI prompt for the pty detector to answer: Auto-Y
// replies to the permission request over the API instead. Only tool
// permissions -- a plan approval (Claude Code's ExitPlanMode, `plan` set by
// the adapter) and a question form stay with the user.

export function isAutoApprovable(request) {
  return !!request?.id && typeof request.plan !== 'string';
}

// The auto-yes log line for a permission request.
export function chatPermissionLabel(request) {
  const resources = Array.isArray(request?.resources) ? request.resources : [];
  return [request?.action, ...resources].filter(Boolean).join(' ').slice(0, 80) || 'permission';
}

export async function replyChatPermission(chat, requestId, decision) {
  if (!chat?.ready || !chat.ocSessionId) return false;
  const ses = encodeURIComponent(chat.ocSessionId);
  const res = await chatRequest(chat, 'POST', `/api/session/${ses}/permission/${encodeURIComponent(requestId)}/reply`, { decision });
  return res.status === 200;
}

// The requests of the current conversation still waiting for an answer.
export async function pendingChatPermissions(chat) {
  if (!chat?.ready || !chat.ocSessionId) return [];
  const res = await chatRequest(chat, 'GET', `/api/session/${encodeURIComponent(chat.ocSessionId)}/permission`);
  return res.status === 200 && Array.isArray(res.body?.data) ? res.body.data : [];
}

// Points the chat at another conversation of the same serve (the chat
// view's history). Resolves false for an id serve does not know.
export async function switchChatSession(chat, ocSessionId) {
  if (!chat?.ready || typeof ocSessionId !== 'string' || !ocSessionId) return false;
  const res = await chatRequest(chat, 'GET', `/api/session/${encodeURIComponent(ocSessionId)}`);
  if (res.status !== 200) return false;
  chat.ocSessionId = ocSessionId;
  // busy / waiting belonged to the previous conversation.
  chat.busy = false;
  chat.waiting = 0;
  chat.monitor?.reset?.();
  return true;
}

// ---- server-side monitor --------------------------------------------------
//
// ccserver follows each chat session's event stream itself, independent of
// any browser: it is what the session list's activity dot and the agent
// notification bridge (notifyBridge.js) see, since a chat session has no TUI
// screen for activity.js / the OSC detector to read.
//
//   chat.busy     a turn is running (execution.started .. succeeded/failed/interrupted)
//   chat.waiting  permission requests / forms waiting on the user
//
// onNotify(event) gets { title, body } for a finished turn and for anything
// that starts waiting on the user. onModelSelected(model) gets the model ref
// whenever the conversation switches model / effort, from any browser.
// onPermissionAsked(request) returns true when it answers the request by
// itself (Auto-Y): no "許可が必要です" notification then.

const MONITOR_RETRY_MS = [500, 1000, 2000, 5000, 10000];

export function startChatMonitor(chat, { onChange, onNotify, onModelSelected, onPermissionAsked, isAlive }) {
  if (chat.monitor) return chat.monitor;
  const waiting = new Set();
  let req = null;
  let stopped = false;
  let attempt = 0;

  const setBusy = (busy) => {
    if (chat.busy === busy) return;
    chat.busy = busy;
    onChange?.();
  };
  const setWaiting = () => {
    if (chat.waiting === waiting.size) return;
    chat.waiting = waiting.size;
    onChange?.();
  };

  const handle = (event) => {
    const d = event?.data || {};
    const sid = d.sessionID ?? d.form?.sessionID;
    if (sid !== chat.ocSessionId) return;
    switch (event.type) {
      case 'session.execution.started':
        setBusy(true);
        break;
      case 'session.execution.succeeded':
        setBusy(false);
        onNotify?.({ title: '応答が完了しました', body: '' });
        break;
      case 'session.execution.failed':
        setBusy(false);
        onNotify?.({ title: 'エラーで停止しました', body: '' });
        break;
      case 'session.execution.interrupted':
        setBusy(false);
        break;
      case 'permission.asked':
        waiting.add(`per:${d.id}`);
        setWaiting();
        if (onPermissionAsked?.(d)) break;
        onNotify?.({ title: '許可が必要です', body: [d.action, ...(Array.isArray(d.resources) ? d.resources : [])].filter(Boolean).join(' ').slice(0, 200) });
        break;
      case 'permission.replied':
        waiting.delete(`per:${d.requestID}`);
        setWaiting();
        break;
      case 'form.created':
        waiting.add(`frm:${d.form?.id}`);
        setWaiting();
        onNotify?.({ title: '質問があります', body: String(d.form?.title || '').slice(0, 200) });
        break;
      case 'form.replied':
      case 'form.cancelled':
        waiting.delete(`frm:${d.id}`);
        setWaiting();
        break;
      case 'session.model.selected':
        if (d.model) onModelSelected?.(d.model);
        break;
      default:
        break;
    }
  };

  const connect = () => {
    if (stopped || !isAlive()) return;
    let buf = '';
    req = http.request({
      socketPath: chat.sock,
      method: 'GET',
      path: '/api/event',
      headers: { host: 'opencode', authorization: basicAuth(chat.password), accept: 'text/event-stream' },
    }, (res) => {
      if (res.statusCode !== 200) { res.resume(); res.on('end', retry); return; }
      attempt = 0;
      res.setEncoding('utf-8');
      res.on('data', (chunk) => {
        buf += chunk;
        let m;
        while ((m = /\r?\n\r?\n/.exec(buf)) !== null) {
          const frame = buf.slice(0, m.index);
          buf = buf.slice(m.index + m[0].length);
          const data = frame.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ /, '')).join('\n');
          if (!data) continue;
          try { handle(JSON.parse(data)); } catch { /* not an event */ }
        }
        // A stream that never frames is not opencode's; do not grow forever.
        if (buf.length > 1_000_000) buf = '';
      });
      res.on('end', retry);
      res.on('error', retry);
    });
    req.on('error', retry);
    req.end();
  };

  let retryTimer = null;
  function retry() {
    if (stopped || !isAlive() || retryTimer) return;
    // Events missed while disconnected are gone: do not trust an old "busy".
    setBusy(false);
    const delay = MONITOR_RETRY_MS[Math.min(attempt++, MONITOR_RETRY_MS.length - 1)];
    retryTimer = setTimeout(() => { retryTimer = null; connect(); }, delay);
    retryTimer.unref?.();
  }

  chat.busy = false;
  chat.waiting = 0;
  connect();
  chat.monitor = {
    // After switchChatSession: forget the old conversation's requests.
    reset() {
      waiting.clear();
      chat.waiting = 0;
    },
    stop() {
      stopped = true;
      if (retryTimer) clearTimeout(retryTimer);
      try { req?.destroy(); } catch { /* gone */ }
    },
  };
  return chat.monitor;
}

export function stopChatMonitor(chat) {
  chat?.monitor?.stop();
}
