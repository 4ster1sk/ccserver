// opencode chat mode, server side (see opencode-chat-bridge.cjs for the
// sandbox side and routes/opencodeChat.js for the browser-facing proxy).
//
// A chat session's record carries `chat`:
//
//   { dir, sock, password, stages, ocSessionId, ready, error, resumeLast, model }
//
//   dir/sock:  the per-session host dir and the relay socket in it (bound
//              into bwrap, or the host end of the VM ssh's -L forward)
//   password:  opencode serve's Basic-auth password, minted per session.
//              Only ccserver's proxy ever sends it; the browser never sees it
//   stages:    the startup list (chatStages.js)
//   ready:     the opencode session exists and the proxy may forward
//
// Everything here talks to serve over that socket.

import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyStage, chatStageIds, failCurrentStage, initialChatStages, parseStageMarkers } from './chatStages.js';
import { CHAT_PASSWORD_NAME, CHAT_SOCK_NAME } from './sandbox.js';
import { ensureHostRuntimeDir } from './git-broker.js';

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

export function prepareChatDir(sessionId) {
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
  return { dir, sock, password };
}

export function removeChatDir(dir) {
  if (!dir) return;
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

export function createChatState({ dir, sock, password, sandboxed, backend, pooled, resumeLast, model }) {
  const stages = initialChatStages(chatStageIds({ sandboxed, backend, pooled }));
  // The sandbox (if any) is built by the time the record exists.
  if (sandboxed) applyStage(stages, 'sandbox', 'done');
  return {
    dir, sock, password, stages,
    ocSessionId: null, ready: false, error: null,
    resumeLast: !!resumeLast, model: model || null,
    markerCarry: '', initStarted: false,
  };
}

// What the browser may see: never the password or host paths.
export function publicChatState(chat) {
  if (!chat) return null;
  return {
    stages: chat.stages.map((s) => ({ ...s })),
    ocSessionId: chat.ocSessionId,
    ready: chat.ready,
    error: chat.error,
  };
}

// Feeds one pty chunk. Returns { changed, opencodeUp } so the caller can
// broadcast and start the session init.
export function feedChatOutput(chat, data) {
  const text = chat.markerCarry + data;
  const markers = parseStageMarkers(text);
  let changed = false;
  let opencodeUp = false;
  let consumed = 0;
  for (const m of markers) {
    consumed = m.end;
    if (applyStage(chat.stages, m.id, m.state, m.message)) changed = true;
    if (m.state === 'error') {
      chat.error = m.message || `${m.id} failed`;
      changed = true;
    }
    if (m.id === 'opencode' && m.state === 'done') opencodeUp = true;
  }
  // Everything up to the last marker is spent; only a possible partial
  // marker at the tail is carried into the next chunk.
  chat.markerCarry = text.slice(Math.max(consumed, text.length - MARKER_CARRY_CHARS));
  return { changed, opencodeUp };
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
      if (!id) {
        const model = modelRefFromString(chat.model);
        const created = await chatRequest(chat, 'POST', '/api/session', model ? { model } : {});
        if (created.status !== 200 || !created.body?.data?.id) {
          throw new Error(`could not create the opencode session (HTTP ${created.status})`);
        }
        id = created.body.data.id;
      }
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
// that starts waiting on the user.

const MONITOR_RETRY_MS = [500, 1000, 2000, 5000, 10000];

export function startChatMonitor(chat, { onChange, onNotify, isAlive }) {
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
