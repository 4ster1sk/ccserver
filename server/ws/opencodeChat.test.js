import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createChatState, initChatSession, startChatMonitor, stopChatMonitor, isAutoApprovable, chatPermissionLabel, switchChatSession } from './opencodeChat.js';

const cleanups = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()();
});

// A stand-in for serve / the adapter on a unix socket. `routes` maps
// "METHOD /path" to (body) => [status, json]; every request is recorded.
async function fakeServe(routes) {
  const dir = mkdtempSync(join(tmpdir(), 'ccs-oc-'));
  const sock = join(dir, 's.sock');
  const requests = [];
  const streams = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : undefined;
      const key = `${req.method} ${req.url}`;
      requests.push({ key, body });
      if (key === 'GET /api/event') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        streams.push(res);
        return;
      }
      const handler = routes[key];
      const [status, json] = handler ? handler(body) : [404, { error: 'nope' }];
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(json));
    });
  });
  await new Promise((r) => server.listen(sock, r));
  cleanups.push(async () => {
    for (const s of streams) s.destroy();
    await new Promise((r) => server.close(r));
    rmSync(dir, { recursive: true, force: true });
  });
  const emit = (event) => { for (const s of streams) s.write(`data: ${JSON.stringify(event)}\n\n`); };
  return { sock, requests, emit, streams };
}

function chatFor(sock, opts = {}) {
  return createChatState({ dir: null, sock, password: 'pw', ...opts });
}

const noSleep = () => Promise.resolve();
const DEFAULT = { providerID: 'anthropic', id: 'opus', variant: 'high' };

test('a new session starts with the recorded default model', async () => {
  const serve = await fakeServe({ 'POST /api/session': () => [200, { data: { id: 'ses1' } }] });
  const chat = chatFor(serve.sock, { defaultModel: DEFAULT });
  await initChatSession(chat, { sleep: noSleep });
  assert.equal(chat.ready, true);
  assert.equal(chat.ocSessionId, 'ses1');
  assert.deepEqual(serve.requests, [{ key: 'POST /api/session', body: { model: DEFAULT } }]);
});

test('an explicit launch model wins over the default', async () => {
  const serve = await fakeServe({ 'POST /api/session': () => [200, { data: { id: 'ses1' } }] });
  const chat = chatFor(serve.sock, { model: 'openai/gpt', defaultModel: DEFAULT });
  await initChatSession(chat, { sleep: noSleep });
  assert.deepEqual(serve.requests[0].body, { model: { providerID: 'openai', id: 'gpt' } });
});

test('no default: the session is created without a model', async () => {
  const serve = await fakeServe({ 'POST /api/session': () => [200, { data: { id: 'ses1' } }] });
  const chat = chatFor(serve.sock);
  await initChatSession(chat, { sleep: noSleep });
  assert.deepEqual(serve.requests[0].body, {});
});

test('a default the agent refuses falls back to the agent\'s own model', async () => {
  const serve = await fakeServe({
    'POST /api/session': (body) => (body.model ? [400, { error: 'unknown model' }] : [200, { data: { id: 'ses1' } }]),
  });
  const chat = chatFor(serve.sock, { defaultModel: DEFAULT });
  await initChatSession(chat, { sleep: noSleep });
  assert.equal(chat.ready, true);
  assert.deepEqual(serve.requests.map((r) => r.body), [{ model: DEFAULT }, {}]);
});

test('resume applies the default only when the agent kept no model', async () => {
  const serve = await fakeServe({
    'GET /api/session': () => [200, { data: [{ id: 'old', time: { updated: 1 } }] }],
    'GET /api/session/old': () => [200, { data: { id: 'old', model: { providerID: 'anthropic', id: 'default', variant: 'default' } } }],
    'POST /api/session/old/model': () => [200, { data: {} }],
  });
  const chat = chatFor(serve.sock, { resumeLast: true, defaultModel: DEFAULT });
  await initChatSession(chat, { sleep: noSleep });
  assert.equal(chat.ocSessionId, 'old');
  assert.deepEqual(serve.requests.at(-1), { key: 'POST /api/session/old/model', body: { model: DEFAULT } });
});

test('resume keeps a model the conversation already has', async () => {
  const serve = await fakeServe({
    'GET /api/session': () => [200, { data: [{ id: 'old', time: { updated: 1 } }] }],
    'GET /api/session/old': () => [200, { data: { id: 'old', model: { providerID: 'openai', id: 'gpt' } } }],
  });
  const chat = chatFor(serve.sock, { resumeLast: true, defaultModel: DEFAULT });
  await initChatSession(chat, { sleep: noSleep });
  assert.equal(chat.ready, true);
  assert.ok(!serve.requests.some((r) => r.key.endsWith('/model')));
});

test('the monitor reports model switches of its own conversation', async () => {
  const serve = await fakeServe({});
  const chat = chatFor(serve.sock);
  chat.ocSessionId = 'ses1';
  const picked = [];
  startChatMonitor(chat, { isAlive: () => true, onModelSelected: (m) => picked.push(m) });
  cleanups.push(async () => stopChatMonitor(chat));
  while (serve.streams.length === 0) await new Promise((r) => setTimeout(r, 10));
  serve.emit({ type: 'session.model.selected', data: { sessionID: 'other', model: { providerID: 'a', id: 'x' } } });
  serve.emit({ type: 'session.model.selected', data: { sessionID: 'ses1', model: DEFAULT } });
  while (picked.length === 0) await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(picked, [DEFAULT]);
});

test('the monitor lets onPermissionAsked answer a request and skips its notification', async () => {
  const serve = await fakeServe({});
  const chat = chatFor(serve.sock);
  chat.ocSessionId = 'ses1';
  const asked = [];
  const notified = [];
  startChatMonitor(chat, {
    isAlive: () => true,
    onNotify: (n) => notified.push(n.title),
    onPermissionAsked: (d) => { asked.push(d.id); return d.id === 'auto'; },
  });
  cleanups.push(async () => stopChatMonitor(chat));
  while (serve.streams.length === 0) await new Promise((r) => setTimeout(r, 10));
  serve.emit({ type: 'permission.asked', data: { sessionID: 'ses1', id: 'auto', action: 'bash' } });
  serve.emit({ type: 'permission.asked', data: { sessionID: 'ses1', id: 'manual', action: 'edit' } });
  while (asked.length < 2) await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(asked, ['auto', 'manual']);
  assert.deepEqual(notified, ['許可が必要です']);
});

test('plan approvals are not auto-approvable', () => {
  assert.equal(isAutoApprovable({ id: 'p1', action: 'bash' }), true);
  assert.equal(isAutoApprovable({ id: 'p2', plan: '# plan' }), false);
  assert.equal(isAutoApprovable({}), false);
});

test('the auto-yes log label is the action and its resources', () => {
  assert.equal(chatPermissionLabel({ action: 'bash', resources: ['npm test'] }), 'bash npm test');
  assert.equal(chatPermissionLabel({}), 'permission');
});

test('switchChatSession moves to a conversation serve knows, and only that', async () => {
  const serve = await fakeServe({ 'GET /api/session/ses2': () => [200, { data: { id: 'ses2' } }] });
  const chat = chatFor(serve.sock);
  chat.ready = true;
  chat.ocSessionId = 'ses1';
  chat.busy = true;
  assert.equal(await switchChatSession(chat, 'missing'), false);
  assert.equal(chat.ocSessionId, 'ses1');
  assert.equal(await switchChatSession(chat, 'ses2'), true);
  assert.equal(chat.ocSessionId, 'ses2');
  assert.equal(chat.busy, false);
});
