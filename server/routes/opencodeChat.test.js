// opencode chat mode end to end, minus the sandbox: a real createSession()
// with ui 'chat' runs the real chat bridge around a fake `opencode`
// (ws/testdata/fake-opencode.cjs, as ~/.opencode/bin/opencode), and the browser side
// goes through the real proxy route.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// sandbox.js fixes its agent search path ($HOME/.opencode/bin among them) at
// import time, so HOME is pointed at a scratch dir holding the fake BEFORE
// the modules under test load (dynamic imports in before()).
let opencodeChatRoute;
let isAllowedChatRequest;
let sessionManager;

const __dirname = dirname(fileURLToPath(import.meta.url));
const FAKE = join(__dirname, '..', 'ws', 'testdata', 'fake-opencode.cjs');

let tmpRoot;
let binDir;
let cfgPath;
let app;
let baseUrl;
const prevEnv = {};
const created = [];

function setEnv(name, value) {
  if (!(name in prevEnv)) prevEnv[name] = process.env[name];
  process.env[name] = value;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(cond, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = cond();
    if (v) return v;
    await sleep(50);
  }
  throw new Error('timed out');
}

before(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'ccserver-chat-route-'));
  const { mkdirSync } = await import('node:fs');
  binDir = join(tmpRoot, 'home', '.opencode', 'bin');
  mkdirSync(binDir, { recursive: true });
  setEnv('HOME', join(tmpRoot, 'home'));
  // An installed claude, so its chat refusal is about chat mode.
  mkdirSync(join(tmpRoot, 'home', '.local', 'bin'), { recursive: true });
  writeFileSync(join(tmpRoot, 'home', '.local', 'bin', 'claude'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const wrapper = join(binDir, 'opencode');
  writeFileSync(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`);
  chmodSync(wrapper, 0o755);
  cfgPath = join(tmpRoot, 'sandbox.config.json');
  writeFileSync(cfgPath, JSON.stringify({ docker: false, gitBroker: false }));
  setEnv('CCSERVER_SANDBOX_CONFIG', cfgPath);
  setEnv('XDG_RUNTIME_DIR', join(tmpRoot, 'run'));
  mkdirSync(join(tmpRoot, 'run'), { mode: 0o700 });

  ({ opencodeChatRoute, isAllowedChatRequest } = await import('./opencodeChat.js'));
  sessionManager = await import('../ws/sessionManager.js');

  app = Fastify();
  await app.register(opencodeChatRoute, { prefix: '/api' });
  baseUrl = await app.listen({ port: 0, host: '127.0.0.1' });
});

after(async () => {
  for (const id of created) sessionManager.destroySession(id, { reason: 'test' });
  try { await app.close(); } catch { /* ignore */ }
  for (const [k, v] of Object.entries(prevEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(tmpRoot, { recursive: true, force: true });
});

async function startChat(extra = {}) {
  const res = await sessionManager.createSession({
    cwd: tmpRoot, cols: 80, rows: 24, shell: false, sandbox: false, app: 'opencode', ui: 'chat', ...extra,
  });
  assert.equal(res.error, undefined, res.error);
  created.push(res.sessionId);
  return res;
}

test('isAllowedChatRequest: the chat surface only', () => {
  assert.equal(isAllowedChatRequest('GET', 'event'), true);
  assert.equal(isAllowedChatRequest('POST', 'session/ses_1/prompt'), true);
  assert.equal(isAllowedChatRequest('POST', 'session/ses_1/permission/per_1/reply'), true);
  assert.equal(isAllowedChatRequest('GET', 'pty'), false);
  assert.equal(isAllowedChatRequest('POST', 'shell'), false);
  assert.equal(isAllowedChatRequest('PATCH', 'experimental/config'), false);
  assert.equal(isAllowedChatRequest('DELETE', 'session/ses_1'), false);
  assert.equal(isAllowedChatRequest('GET', 'session/../pty'), false);
  assert.equal(isAllowedChatRequest('GET', 'session/ses_1/message/../../pty'), false);
});

test('a chat launch is refused for apps without a chat mode', async () => {
  const res = await sessionManager.createSession({
    cwd: tmpRoot, cols: 80, rows: 24, shell: false, sandbox: false, app: 'claude', ui: 'chat',
  });
  assert.equal(res.session, null);
  assert.match(res.error, /chat mode/);
});

test('chat session: stages, ready, proxy, prompt and event stream', async () => {
  const { sessionId, session } = await startChat();
  assert.equal(session.ui, 'chat');
  assert.deepEqual(session.chat.stages.map((s) => s.id), ['opencode', 'session']);

  // Not ready yet (or just became ready): the proxy answers 503 until then.
  await waitFor(() => session.chat.ready || session.chat.error);
  assert.equal(session.chat.error, null);
  assert.match(session.chat.ocSessionId, /^ses_/);
  assert.deepEqual(session.chat.stages.map((s) => s.state), ['done', 'done']);
  assert.equal(session.settled, true, 'ready is the chat session\'s settle point');

  const meta = await (await fetch(`${baseUrl}/api/oc/${sessionId}/_meta`)).json();
  assert.equal(meta.ready, true);
  assert.equal(meta.ocSessionId, session.chat.ocSessionId);
  assert.equal(meta.password, undefined, 'the password never reaches the browser');
  assert.equal(JSON.stringify(meta).includes(session.chat.password), false);

  // Forbidden paths stop at the proxy.
  assert.equal((await fetch(`${baseUrl}/api/oc/${sessionId}/api/pty`)).status, 403);
  // Unknown sessions are 404.
  assert.equal((await fetch(`${baseUrl}/api/oc/nope/api/info`)).status, 404);
  // The browser's own Authorization is replaced, not forwarded.
  const info = await fetch(`${baseUrl}/api/oc/${sessionId}/api/info?token=abc`, { headers: { authorization: 'Bearer ccserver-token' } });
  assert.equal(info.status, 200);
  assert.equal((await info.json()).data.version, '2.0.22');

  // Subscribe to events, then prompt.
  const ac = new AbortController();
  const events = [];
  const stream = await fetch(`${baseUrl}/api/oc/${sessionId}/api/event`, { signal: ac.signal });
  assert.equal(stream.status, 200);
  assert.match(stream.headers.get('content-type'), /text\/event-stream/);
  const reading = (async () => {
    const decoder = new TextDecoder();
    let buf = '';
    try {
      for await (const chunk of stream.body) {
        buf += decoder.decode(chunk, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const data = frame.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n');
          if (data) events.push(JSON.parse(data));
        }
      }
    } catch { /* aborted */ }
  })();

  const ocId = session.chat.ocSessionId;
  const prompt = await fetch(`${baseUrl}/api/oc/${sessionId}/api/session/${ocId}/prompt`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'hello there' }),
  });
  assert.equal(prompt.status, 200);
  await waitFor(() => events.some((e) => e.type === 'session.execution.succeeded'));
  assert.ok(events.some((e) => e.type === 'session.text.delta'));
  const text = events.filter((e) => e.type === 'session.text.delta').map((e) => e.data.delta).join('');
  assert.match(text, /hello there/);

  const messages = await (await fetch(`${baseUrl}/api/oc/${sessionId}/api/session/${ocId}/message`)).json();
  assert.deepEqual(messages.data.map((m) => m.type), ['user', 'assistant']);

  // writeToSession (scheduled prompts / MCP send_input) goes through the API.
  assert.equal(sessionManager.writeToSession(sessionId, 'from the scheduler', { submit: true }), true);
  await waitFor(() => events.filter((e) => e.type === 'session.execution.succeeded').length >= 2);

  ac.abort();
  await reading;
});

test('destroying a chat session removes its socket dir and stops the bridge', async () => {
  const { sessionId, session } = await startChat();
  await waitFor(() => session.chat.ready || session.chat.error);
  const dir = session.chat.dir;
  assert.equal(existsSync(join(dir, 'oc.sock')), true);
  assert.equal(existsSync(join(dir, 'password')), false, 'the bridge removes the password file once read');
  sessionManager.destroySession(sessionId, { reason: 'test' });
  assert.equal(existsSync(dir), false);
  assert.equal((await fetch(`${baseUrl}/api/oc/${sessionId}/_meta`)).status, 404);
});

test('a bridge that cannot start opencode fails the opencode stage', async () => {
  const broken = join(binDir, 'opencode');
  writeFileSync(broken, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 2.0.22; exit 0; fi\necho "boom: no provider" >&2\nexit 3\n`);
  // A different mtime than the cached probe is not needed: the probe result
  // (2.x) stays valid, only `serve` breaks.
  try {
    const { session } = await startChat();
    await waitFor(() => session.chat.error);
    const stage = session.chat.stages.find((s) => s.id === 'opencode');
    assert.equal(stage.state, 'error');
    assert.match(stage.message, /exited \(3\): boom: no provider/);
    await waitFor(() => session.exited);
    assert.equal(session.chat.stages.find((s) => s.id === 'session').state, 'pending', 'only the stage that failed is marked');
  } finally {
    writeFileSync(broken, `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`);
  }
});

test('prepareChatDir refuses a socket path libuv would truncate', async () => {
  const { prepareChatDir } = await import('../ws/opencodeChat.js');
  const long = join(tmpRoot, 'x'.repeat(120));
  const { mkdirSync } = await import('node:fs');
  mkdirSync(long, { recursive: true, mode: 0o700 });
  const prev = process.env.XDG_RUNTIME_DIR;
  process.env.XDG_RUNTIME_DIR = long;
  try {
    assert.throws(() => prepareChatDir('0123456789abcdef-0000-0000-0000-000000000000'), /too long for a unix socket/);
  } finally {
    process.env.XDG_RUNTIME_DIR = prev;
  }
});

test('the chat monitor drives the session list activity: busy, waiting, idle', async () => {
  const { sessionId, session } = await startChat();
  await waitFor(() => session.chat.ready || session.chat.error);
  assert.equal(sessionManager.activitySnapshot(session).level, 'idle');
  const listed = sessionManager.listSessions().find((s) => s.id === sessionId);
  assert.equal(listed.ui, 'chat');

  const ocId = session.chat.ocSessionId;
  const post = (path, body) => fetch(`${baseUrl}/api/oc/${sessionId}/api/session/${ocId}/${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  assert.equal((await post('prompt', { text: 'perm please' })).status, 200);
  await waitFor(() => session.chat.waiting === 1);
  assert.equal(sessionManager.activitySnapshot(session).reason, 'chat-waiting');
  const perms = await (await fetch(`${baseUrl}/api/oc/${sessionId}/api/session/${ocId}/permission`)).json();
  assert.equal(perms.data.length, 1);
  assert.equal((await post(`permission/${perms.data[0].id}/reply`, { decision: 'once' })).status, 204);
  await waitFor(() => session.chat.waiting === 0 && session.chat.busy === true);
  assert.equal(sessionManager.activitySnapshot(session).level, 'busy');
  await waitFor(() => session.chat.busy === false);
  assert.equal(sessionManager.activitySnapshot(session).level, 'idle');
});
