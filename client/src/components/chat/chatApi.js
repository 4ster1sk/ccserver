// The chat view's transport to a chat-mode session's `opencode serve`, all
// through ccserver's proxy (server/routes/opencodeChat.js):
//
//   /api/oc/<ccserver session id>/_meta     startup stages / readiness
//   /api/oc/<ccserver session id>/api/...   opencode's v2 HTTP API
//
// authFetch carries ccserver's own credentials; the proxy adds opencode's.

import { authFetch } from '../../auth.js';

export function chatBase(sessionId) {
  return `/api/oc/${encodeURIComponent(sessionId)}`;
}

export class ChatApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

// One JSON call to opencode. Resolves the parsed body (null for 204).
export async function ocRequest(sessionId, method, path, body) {
  const res = await authFetch(`${chatBase(sessionId)}/api/${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 204) return null;
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  if (!res.ok) {
    const message = (parsed && typeof parsed === 'object' && (parsed.error || parsed.message || parsed._tag)) || `HTTP ${res.status}`;
    throw new ChatApiError(typeof message === 'string' ? message : `HTTP ${res.status}`, res.status, parsed);
  }
  return parsed;
}

export async function fetchChatMeta(sessionId) {
  const res = await authFetch(`${chatBase(sessionId)}/_meta`);
  if (!res.ok) throw new ChatApiError(`HTTP ${res.status}`, res.status, null);
  return res.json();
}

// Splits an SSE byte stream into event payloads (the `data:` lines of each
// frame, joined). Comments (`: keepalive`) and other fields are skipped.
export function createSseParser(onData) {
  let buf = '';
  return (chunk) => {
    buf += chunk;
    let m;
    while ((m = /\r?\n\r?\n/.exec(buf)) !== null) {
      const frame = buf.slice(0, m.index);
      buf = buf.slice(m.index + m[0].length);
      const data = frame
        .split(/\r?\n/)
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).replace(/^ /, ''))
        .join('\n');
      if (data) onData(data);
    }
  };
}

// Follows opencode's event stream until `signal` aborts, reconnecting with
// backoff. onOpen fires on every (re)connect -- the caller resyncs there,
// since events missed while disconnected are not replayed.
export function subscribeChatEvents(sessionId, { onEvent, onOpen, onDisconnect, signal }) {
  let attempt = 0;
  const run = async () => {
    while (!signal.aborted) {
      try {
        const res = await authFetch(`${chatBase(sessionId)}/api/event`, { signal, headers: { accept: 'text/event-stream' } });
        if (!res.ok || !res.body) throw new ChatApiError(`HTTP ${res.status}`, res.status, null);
        attempt = 0;
        onOpen?.();
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        const feed = createSseParser((data) => {
          let event;
          try { event = JSON.parse(data); } catch { return; }
          onEvent(event);
        });
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          feed(decoder.decode(value, { stream: true }));
        }
      } catch (err) {
        if (signal.aborted) return;
        // A session that is gone will not come back: stop.
        if (err instanceof ChatApiError && err.status === 404) {
          onDisconnect?.(err);
          return;
        }
      }
      if (signal.aborted) return;
      onDisconnect?.();
      attempt++;
      await new Promise((r) => setTimeout(r, Math.min(500 * 2 ** attempt, 10000)));
    }
  };
  run();
}
