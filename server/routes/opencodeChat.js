// The chat view's way into a chat-mode session's `opencode serve`
// (see ws/opencodeChat.js):
//
//   GET  /api/oc/:sessionId/_meta     startup stages, readiness, opencode session id
//   ANY  /api/oc/:sessionId/api/...   forwarded to serve's /api/... (allow-listed)
//
// Under /api, so the global auth hook (token / passkey) already ran. The
// browser never holds serve's password: this route adds it. Only the
// endpoints the chat view needs are forwarded -- not serve's PTY / shell /
// credential / config surface, which a browser has no business reaching
// through ccserver.

import http from 'node:http';
import { getSession } from '../ws/sessionManager.js';
import { basicAuth, publicChatState } from '../ws/opencodeChat.js';

const BODY_LIMIT = 16 * 1024 * 1024;

const SEG = '[^/]+';
// [method, pattern] over the path after /api/. `ses` is any session id: a
// chat view may start a new conversation or reopen an older one of the
// same serve.
const ALLOWED = [
  ['GET', 'info'],
  ['GET', 'event'],
  ['GET', 'agent'],
  ['GET', 'model'],
  ['GET', 'model/default'],
  ['GET', 'command'],
  ['GET', 'skill'],
  ['GET', 'permission/request'],
  ['GET', 'form'],
  ['GET', 'fs/find'],
  ['GET', 'fs/list'],
  ['GET', 'vcs'],
  ['GET', 'vcs/status'],
  ['GET', 'vcs/diff'],
  ['GET', 'session'],
  ['POST', 'session'],
  ['GET', `session/${SEG}`],
  ['PATCH', `session/${SEG}`],
  ['GET', `session/${SEG}/message`],
  ['GET', `session/${SEG}/message/${SEG}`],
  ['GET', `session/${SEG}/permission`],
  ['GET', `session/${SEG}/form`],
  ['GET', `session/${SEG}/inbox`],
  ['GET', `session/${SEG}/diff`],
  ['GET', `session/${SEG}/context`],
  ['POST', `session/${SEG}/prompt`],
  ['POST', `session/${SEG}/command`],
  ['POST', `session/${SEG}/shell`],
  ['POST', `session/${SEG}/interrupt`],
  ['POST', `session/${SEG}/compact`],
  ['POST', `session/${SEG}/model`],
  ['POST', `session/${SEG}/agent`],
  ['POST', `session/${SEG}/fork`],
  ['POST', `session/${SEG}/permission/${SEG}/reply`],
  ['POST', `session/${SEG}/form/${SEG}/reply`],
  ['DELETE', `session/${SEG}/form/${SEG}`],
  ['DELETE', `session/${SEG}/inbox/${SEG}`],
  ['PATCH', `session/${SEG}/inbox/${SEG}`],
].map(([method, pattern]) => [method, new RegExp(`^${pattern}$`)]);

export function isAllowedChatRequest(method, apiPath) {
  if (apiPath.split('/').some((seg) => seg === '..' || seg === '.')) return false;
  return ALLOWED.some(([m, re]) => m === method && re.test(apiPath));
}

// Request headers worth forwarding. Never the browser's cookie or
// authorization (ccserver's own credentials).
const FORWARD_REQUEST_HEADERS = ['content-type', 'accept', 'last-event-id', 'accept-language'];
// Response headers dropped on the way back.
const DROP_RESPONSE_HEADERS = new Set(['connection', 'keep-alive', 'transfer-encoding', 'set-cookie', 'www-authenticate']);

function chatSessionOr404(request, reply) {
  const session = getSession(request.params.sessionId);
  if (!session || session.exited || !session.chat) {
    reply.code(404).send({ error: 'Chat session not found', code: 'SESSION_NOT_FOUND' });
    return null;
  }
  return session;
}

export async function opencodeChatRoute(fastify) {
  // Bodies are forwarded byte-for-byte, so this plugin keeps them raw.
  fastify.removeAllContentTypeParsers();
  fastify.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: BODY_LIMIT }, (_req, body, done) => done(null, body));

  fastify.get('/oc/:sessionId/_meta', async (request, reply) => {
    const session = chatSessionOr404(request, reply);
    if (!session) return reply;
    return { ...publicChatState(session.chat), cwd: session.cwd, model: session.model || null };
  });

  fastify.route({
    method: ['GET', 'POST', 'PATCH', 'DELETE'],
    url: '/oc/:sessionId/api/*',
    handler: async (request, reply) => {
      const session = chatSessionOr404(request, reply);
      if (!session) return reply;
      const apiPath = request.params['*'] || '';
      if (!isAllowedChatRequest(request.method, apiPath)) {
        return reply.code(403).send({ error: `${request.method} /api/${apiPath} is not available through the chat proxy` });
      }
      const { chat } = session;
      if (!chat.ready) {
        return reply.code(503).send({ error: 'The chat session is still starting', code: 'CHAT_STARTING' });
      }

      // The query minus ccserver's own ?token= (token auth mode).
      const query = new URLSearchParams(request.raw.url.split('?')[1] || '');
      query.delete('token');
      const qs = query.toString();
      const headers = { host: 'opencode', authorization: basicAuth(chat.password) };
      for (const name of FORWARD_REQUEST_HEADERS) {
        if (request.headers[name]) headers[name] = request.headers[name];
      }
      const body = Buffer.isBuffer(request.body) ? request.body : null;
      if (body) headers['content-length'] = body.length;

      reply.hijack();
      const res = reply.raw;
      const upstream = http.request({
        socketPath: chat.sock,
        method: request.method,
        path: `/api/${apiPath}${qs ? `?${qs}` : ''}`,
        headers,
      }, (up) => {
        const outHeaders = {};
        for (const [k, v] of Object.entries(up.headers)) {
          if (!DROP_RESPONSE_HEADERS.has(k)) outHeaders[k] = v;
        }
        const isStream = String(up.headers['content-type'] || '').startsWith('text/event-stream');
        if (isStream) {
          outHeaders['cache-control'] = 'no-cache, no-transform';
          outHeaders['x-accel-buffering'] = 'no';
          res.socket?.setNoDelay?.(true);
        }
        res.writeHead(up.statusCode || 502, outHeaders);
        if (isStream) res.flushHeaders?.();
        up.pipe(res);
        up.on('error', () => res.destroy());
      });
      upstream.on('error', (err) => {
        if (!res.headersSent) {
          res.writeHead(502, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: `opencode is unreachable: ${err.message}`, code: 'CHAT_UPSTREAM' }));
        } else {
          res.destroy();
        }
      });
      // An event stream lives as long as the browser keeps it open.
      res.on('close', () => upstream.destroy());
      if (body) upstream.write(body);
      upstream.end();
    },
  });
}
