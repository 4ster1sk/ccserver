#!/usr/bin/env node
'use strict';
// A stand-in for `opencode` (v2) for tests and local UI work on hosts
// without a real install. It implements just enough of `opencode serve
// --stdio` -- the startup handshake, Basic auth, and the slice of the v2
// HTTP API the chat view uses -- with a scripted "model":
//
//   - every prompt is answered with streamed text echoing it
//   - a prompt containing "tool" first runs a fake `read` tool
//   - a prompt containing "perm" first asks for a bash permission and waits
//     for the reply
//   - a prompt containing "slow" streams slowly (to test interrupt)
//
// `fake-opencode --version` prints a 2.x version so ccserver treats it as
// chat-capable. Message/event shapes follow opencode/packages/schema.

const http = require('node:http');
const { randomBytes } = require('node:crypto');

if (process.argv.includes('--version')) {
  process.stdout.write('2.0.22\n');
  process.exit(0);
}
if (process.argv[2] !== 'serve' || !process.argv.includes('--stdio')) {
  process.stderr.write('fake-opencode: only `serve --stdio` and `--version` are supported\n');
  process.exit(2);
}

const password = process.env.OPENCODE_SERVER_PASSWORD || '';
delete process.env.OPENCODE_SERVER_PASSWORD;
if (!password) { process.stderr.write('fake-opencode: Missing server password\n'); process.exit(1); }
const expectedAuth = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`;

const id = (prefix) => `${prefix}_${Date.now().toString(36)}${randomBytes(6).toString('hex')}`;
const now = () => Date.now();

const sessions = new Map(); // id -> { info, messages: [], permissions: Map, running }
const subscribers = new Set();

function emit(type, data) {
  const event = { id: id('evt'), type, created: now(), data };
  const frame = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of subscribers) res.write(frame);
}

function sendJson(res, status, body) {
  const text = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({}); }
    });
  });
}

const MODEL = { id: 'fake-model', providerID: 'fake' };
const location = { directory: process.cwd() };

function createSession(body = {}) {
  const info = {
    id: id('ses'),
    projectID: 'prj_fake',
    agent: body.agent || 'build',
    model: body.model || MODEL,
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: now(), updated: now() },
    title: body.title || 'New session',
    location,
  };
  sessions.set(info.id, { info, messages: [], permissions: new Map(), run: null });
  emit('session.created', { sessionID: info.id });
  return info;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function streamText(s, msg, ordinal, text, delay) {
  emit('session.text.started', { sessionID: s.info.id, assistantMessageID: msg.id, ordinal });
  const part = { type: 'text', text: '' };
  msg.content.push(part);
  for (const word of text.split(/(?<=\s)/)) {
    if (s.run?.cancelled) break;
    await sleep(delay);
    part.text += word;
    emit('session.text.delta', { sessionID: s.info.id, assistantMessageID: msg.id, ordinal, delta: word });
  }
  emit('session.text.ended', { sessionID: s.info.id, assistantMessageID: msg.id, ordinal, text: part.text });
}

async function runPrompt(s, text) {
  const sid = s.info.id;
  const run = { cancelled: false };
  s.run = run;
  emit('session.execution.started', { sessionID: sid });
  const msg = { id: id('msg'), type: 'assistant', time: { created: now() }, agent: s.info.agent, model: s.info.model, content: [] };
  s.messages.push(msg);
  emit('session.step.started', { sessionID: sid, assistantMessageID: msg.id, agent: msg.agent, model: msg.model, started: now() });
  const delay = /slow/i.test(text) ? 400 : 25;
  let ordinal = 0;

  // reasoning
  const reasoning = { type: 'reasoning', text: '', time: { created: now() } };
  msg.content.push(reasoning);
  emit('session.reasoning.started', { sessionID: sid, assistantMessageID: msg.id, ordinal });
  for (const w of ['Thinking ', 'about ', 'the ', 'request…']) {
    await sleep(delay);
    reasoning.text += w;
    emit('session.reasoning.delta', { sessionID: sid, assistantMessageID: msg.id, ordinal, delta: w });
  }
  reasoning.time.completed = now();
  emit('session.reasoning.ended', { sessionID: sid, assistantMessageID: msg.id, ordinal, text: reasoning.text });
  ordinal++;

  // One tool call through its whole event sequence. `gate` (optional) runs
  // while the tool is "running", e.g. a permission prompt; it returns an
  // error to fail the call instead of completing it.
  const runTool = async (name, input, output, gate) => {
    const tool = { type: 'tool', id: id('call'), name, executed: false, time: { created: now() }, state: { status: 'streaming', input: '' } };
    msg.content.push(tool);
    const base = { sessionID: sid, assistantMessageID: msg.id, id: tool.id };
    emit('session.tool.input.started', { ...base, name });
    await sleep(delay * 3);
    tool.state = { status: 'running', input, metadata: {} };
    tool.time.ran = now();
    tool.executed = true;
    emit('session.tool.called', { ...base, input, executed: true });
    const failure = gate ? await gate() : null;
    await sleep(delay * 4);
    tool.time.completed = now();
    if (failure) {
      tool.state = { status: 'error', input, error: failure, metadata: {} };
      emit('session.tool.failed', { ...base, error: failure });
      return;
    }
    tool.state = { status: 'completed', input, content: [{ type: 'text', text: output }], metadata: {} };
    emit('session.tool.success', { ...base, content: tool.state.content, executed: true });
  };

  if (/perm/i.test(text) && !run.cancelled) {
    await runTool('shell', { command: 'npm test' }, 'All 12 tests passed', async () => {
      const request = { id: id('per'), sessionID: sid, action: 'shell', resources: ['npm test'], save: ['npm *'], message: 'Run npm test' };
      const decision = await new Promise((resolve) => {
        s.permissions.set(request.id, { request, resolve });
        run.cancelPermission = () => resolve('reject');
        emit('permission.asked', request);
      });
      s.permissions.delete(request.id);
      emit('permission.replied', { sessionID: sid, requestID: request.id, reply: decision });
      return decision === 'reject' ? { type: 'PermissionRejected', message: 'The user rejected this command' } : null;
    });
  }

  if (/tool/i.test(text) && !run.cancelled) {
    await runTool('read', { path: 'src/index.js' }, '1: console.log("hello")\n2: main()\n');
    await runTool('edit', { path: 'src/index.js', oldString: 'console.log("hello")\nmain()', newString: 'console.log("hello, world")\nmain()' }, 'Edit applied successfully.');
  }

  if (!run.cancelled) {
    await streamText(s, msg, ordinal, `Echo: **${text}**\n\n\`\`\`js\nconsole.log(${JSON.stringify(text)})\n\`\`\`\n`, delay);
  }
  msg.time.completed = now();
  msg.finish = run.cancelled ? 'unknown' : 'stop';
  emit('session.step.ended', { sessionID: sid, assistantMessageID: msg.id, finish: msg.finish, cost: 0, tokens: s.info.tokens });
  s.info.time.updated = now();
  s.run = null;
  emit(run.cancelled ? 'session.execution.interrupted' : 'session.execution.succeeded', { sessionID: sid });
}

const server = http.createServer(async (req, res) => {
  if (req.headers.authorization !== expectedAuth) { sendJson(res, 401, { _tag: 'UnauthorizedError' }); return; }
  const url = new URL(req.url, 'http://x');
  const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]
  const method = req.method;
  if (parts[0] !== 'api') { sendJson(res, 404, {}); return; }
  const [, a, b, c, d, e] = parts;

  if (method === 'GET' && a === 'info') return sendJson(res, 200, { data: { version: '2.0.22', pid: process.pid, urls: [] } });
  if (method === 'GET' && a === 'event') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    res.write(`data: ${JSON.stringify({ id: id('evt'), type: 'server.connected', created: now(), data: {} })}\n\n`);
    subscribers.add(res);
    const keepalive = setInterval(() => res.write(': keepalive\n\n'), 15000);
    req.on('close', () => { clearInterval(keepalive); subscribers.delete(res); });
    return;
  }
  if (method === 'GET' && a === 'model' && !b) {
    return sendJson(res, 200, { location, data: [
      { id: 'fake/fake-model', modelID: 'fake-model', providerID: 'fake', name: 'Fake Model' },
      { id: 'fake/fake-model-large', modelID: 'fake-model-large', providerID: 'fake', name: 'Fake Model Large' },
    ] });
  }
  if (method === 'GET' && a === 'model' && b === 'default') return sendJson(res, 200, { location, data: MODEL });
  if (method === 'GET' && a === 'agent') {
    return sendJson(res, 200, { location, data: [
      { id: 'build', name: 'build', mode: 'primary', hidden: false, request: {}, permissions: [] },
      { id: 'plan', name: 'plan', mode: 'primary', hidden: false, request: {}, permissions: [] },
    ] });
  }
  if (method === 'GET' && a === 'command') return sendJson(res, 200, { location, data: [{ name: 'init', description: 'Create AGENTS.md' }] });

  if (a !== 'session') { sendJson(res, 404, { _tag: 'NotFound' }); return; }
  if (!b) {
    if (method === 'GET') return sendJson(res, 200, { data: [...sessions.values()].map((s) => s.info).reverse() });
    if (method === 'POST') return sendJson(res, 200, { data: createSession(await readBody(req)) });
  }
  const s = sessions.get(b);
  if (!s) { sendJson(res, 404, { _tag: 'SessionNotFoundError' }); return; }
  if (method === 'GET' && !c) return sendJson(res, 200, { data: s.info });
  if (method === 'GET' && c === 'message' && !d) {
    const desc = url.searchParams.get('order') === 'desc';
    const list = desc ? [...s.messages].reverse() : s.messages;
    return sendJson(res, 200, { data: list, cursor: { previous: null, next: null } });
  }
  if (method === 'GET' && c === 'message' && d) {
    const m = s.messages.find((x) => x.id === d);
    return m ? sendJson(res, 200, { data: m }) : sendJson(res, 404, { _tag: 'MessageNotFoundError' });
  }
  if (method === 'POST' && c === 'prompt') {
    const body = await readBody(req);
    const user = { id: body.id || id('msg'), type: 'user', time: { created: now() }, text: String(body.text || '') };
    s.messages.push(user);
    setTimeout(() => emit('session.inbox.delivered', { sessionID: s.info.id, inboxID: user.id }), 10);
    if (s.info.title === 'New session') {
      s.info.title = user.text.slice(0, 40) || 'New session';
      emit('session.renamed', { sessionID: s.info.id, title: s.info.title });
    }
    sendJson(res, 200, { data: { id: user.id, sessionID: s.info.id, type: 'user', time: { created: user.time.created }, payload: { text: user.text }, delivery: body.delivery || 'steer' } });
    if (!s.run) runPrompt(s, user.text).catch((err) => process.stderr.write(`${err.stack}\n`));
    return;
  }
  if (method === 'POST' && c === 'interrupt') {
    const active = !!s.run;
    if (s.run) { s.run.cancelled = true; s.run.cancelPermission?.(); }
    return sendJson(res, 200, { interrupted: active });
  }
  if (method === 'POST' && c === 'model') {
    const body = await readBody(req);
    s.info.model = body.model || body;
    emit('session.model.selected', { sessionID: s.info.id, model: s.info.model });
    res.writeHead(204); res.end(); return;
  }
  if (method === 'POST' && c === 'agent') {
    const body = await readBody(req);
    s.info.agent = body.agent || s.info.agent;
    emit('session.agent.selected', { sessionID: s.info.id, agent: s.info.agent });
    res.writeHead(204); res.end(); return;
  }
  if (method === 'GET' && c === 'permission' && !d) {
    return sendJson(res, 200, { data: [...s.permissions.values()].map((p) => p.request) });
  }
  if (method === 'POST' && c === 'permission' && d && e === 'reply') {
    const body = await readBody(req);
    const p = s.permissions.get(d);
    if (!p) return sendJson(res, 404, { _tag: 'PermissionNotFoundError' });
    p.resolve(body.decision);
    res.writeHead(204); res.end(); return;
  }
  if (method === 'GET' && c === 'form' && !d) return sendJson(res, 200, { data: [] });
  sendJson(res, 404, { _tag: 'NotFound' });
});

// FAKE_OPENCODE_STARTUP_MS: pretend startup takes this long (to look at
// the chat view's startup screen).
setTimeout(() => server.listen(0, '127.0.0.1', () => {
  const { port } = server.address();
  process.stdout.write(`${JSON.stringify({ url: `http://127.0.0.1:${port}` })}\n`);
}), Number(process.env.FAKE_OPENCODE_STARTUP_MS) || 0);

process.stdin.on('end', () => process.exit(0));
process.stdin.on('close', () => process.exit(0));
process.stdin.resume();
