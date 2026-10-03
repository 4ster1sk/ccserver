// Single-client session takeover: one session has at most one attached
// client. Attaching a second client evicts the incumbent (code 4001, a
// 'detached' notice) instead of joining it, and the pty simply follows the
// attached client's viewport.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let sessionManager;
let terminal;
let runtimeDir;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function fakeSocket() {
  return {
    readyState: 1,
    sent: [],
    closedWith: null,
    send(m) { this.sent.push(m); },
    close(code, reason) { this.closedWith = { code, reason }; this.readyState = 3; },
    messages(type) {
      return this.sent
        .map((m) => { try { return JSON.parse(m); } catch { return null; } })
        .filter((m) => m && (!type || m.type === type));
    },
    text() {
      return this.messages('output').map((m) => m.data).join('');
    },
  };
}

async function newShell() {
  const res = await sessionManager.createSession({
    cwd: '/tmp', cols: 80, rows: 24, shell: true, sandbox: false,
  });
  assert.ok(res.session, 'shell session should spawn');
  return res;
}

// Asks the shell for the pty's real dimensions and waits for the answer.
// Returns { rows, cols } as stty prints "rows cols".
async function ptySize(sessionId, socket) {
  const marker = `SZ${Math.random().toString(36).slice(2, 8)}`;
  const before = socket.sent.length;
  sessionManager.writeToSession(sessionId, `echo ${marker}-$(stty size | tr ' ' 'x')`, { submit: true });
  for (let i = 0; i < 60; i++) {
    await sleep(100);
    const out = socket.sent.slice(before)
      .map((m) => { try { return JSON.parse(m); } catch { return null; } })
      .filter((m) => m?.type === 'output')
      .map((m) => m.data)
      .join('');
    const hit = out.match(new RegExp(`${marker}-(\\d+)x(\\d+)`));
    if (hit) return { rows: Number(hit[1]), cols: Number(hit[2]) };
  }
  throw new Error(`pty size never reported for ${sessionId}`);
}

before(async () => {
  runtimeDir = mkdtempSync(join(tmpdir(), 'ccserver-takeover-test-'));
  process.env.XDG_RUNTIME_DIR = runtimeDir;
  process.env.CCSERVER_GROUPS_PATH = join(runtimeDir, 'saved-groups.json');
  process.env.CCSERVER_ORCHESTRATOR_GENERATED_ROOT = join(runtimeDir, 'orchestrator-generated');
  // This file drives the real /ws/terminal dispatcher, whose `init` is
  // refused while the #201 setup gate is up. Declaring the migrated layout
  // keeps this file about takeover; the gate itself is covered by
  // startup-setup-gate.test.js.
  process.env.CCSERVER_LAYOUT = 'xdg';
  sessionManager = await import('./sessionManager.js');
  terminal = await import('./terminal.js');
});

after(() => {
  sessionManager.destroyAllSessions();
  delete process.env.CCSERVER_LAYOUT;
  try { rmSync(runtimeDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

test('a second client evicts the incumbent', async () => {
  const { sessionId, session } = await newShell();
  const desktop = fakeSocket();
  const phone = fakeSocket();
  try {
    sessionManager.attachSocket(sessionId, desktop);
    sessionManager.attachSocket(sessionId, phone);

    assert.equal(session.socket, phone, 'the newcomer took over');
    assert.deepEqual(desktop.closedWith, { code: 4001, reason: 'Replaced by new client' },
      'the incumbent is closed');
    assert.deepEqual(desktop.messages('detached'), [{ type: 'detached', reason: 'replaced' }],
      'the incumbent is told why');
  } finally {
    sessionManager.destroySession(sessionId, { reason: 'test' });
  }
});

test('a lone client is never evicted by its own attach', async () => {
  const { sessionId, session } = await newShell();
  const solo = fakeSocket();
  try {
    sessionManager.attachSocket(sessionId, solo, { cols: 100, rows: 30 });
    assert.equal(session.socket, solo);
    assert.equal(solo.closedWith, null);
  } finally {
    sessionManager.destroySession(sessionId, { reason: 'test' });
  }
});

test('the pty follows the attached client', async () => {
  const { sessionId, session } = await newShell();
  const desktop = fakeSocket();
  const phone = fakeSocket();
  try {
    sessionManager.attachSocket(sessionId, desktop, { cols: 120, rows: 40 });
    assert.deepEqual(await ptySize(sessionId, desktop), { rows: 40, cols: 120 });

    // The newcomer replaces the incumbent outright: its own size wins, there
    // is no minimum to negotiate against.
    sessionManager.attachSocket(sessionId, phone, { cols: 80, rows: 24 });
    assert.equal(session.socket, phone, 'still only one client');
    assert.deepEqual(await ptySize(sessionId, phone), { rows: 24, cols: 80 });
  } finally {
    sessionManager.destroySession(sessionId, { reason: 'test' });
  }
});

test('resizeSession resizes the pty for the attached client only', async () => {
  const { sessionId } = await newShell();
  const solo = fakeSocket();
  const stranger = fakeSocket();
  try {
    sessionManager.attachSocket(sessionId, solo, { cols: 80, rows: 24 });
    assert.equal(sessionManager.resizeSession(sessionId, solo, 100, 30), true);
    assert.deepEqual(await ptySize(sessionId, solo), { rows: 30, cols: 100 });
    assert.equal(sessionManager.resizeSession(sessionId, stranger, 40, 10), false,
      'an unattached socket cannot steer the pty size');
    assert.equal(sessionManager.resizeSession('no-such-session', solo, 80, 24), false);
  } finally {
    sessionManager.destroySession(sessionId, { reason: 'test' });
  }
});

test('detaching the attached client arms the destroy timer; anyone else is a no-op', async () => {
  const { sessionId, session } = await newShell();
  const attached = fakeSocket();
  const stranger = fakeSocket();
  try {
    sessionManager.attachSocket(sessionId, attached);
    sessionManager.detachSocket(sessionId, stranger);
    assert.equal(session.socket, attached, 'a stranger detach changes nothing');
    assert.equal(session.timeoutTimer, null, 'no destroy timer while someone is attached');

    sessionManager.detachSocket(sessionId, attached);
    assert.equal(session.socket, null, 'nobody remains');
    assert.notEqual(session.timeoutTimer, null, 'destroy timer armed once nobody is watching');
  } finally {
    sessionManager.destroySession(sessionId, { reason: 'test' });
  }
});

test('listSessions reports connected from the attached client', async () => {
  const { sessionId } = await newShell();
  const solo = fakeSocket();
  const row = () => sessionManager.listSessions().find((s) => s.id === sessionId);
  try {
    assert.equal(row().connected, false);

    sessionManager.attachSocket(sessionId, solo);
    assert.equal(row().connected, true);

    sessionManager.detachSocket(sessionId, solo);
    assert.equal(row().connected, false);
  } finally {
    sessionManager.destroySession(sessionId, { reason: 'test' });
  }
});

// End-to-end through the /ws/terminal dispatcher: the second client takes
// over the first.
test('two /ws/terminal clients, one session: the second takes over', async () => {
  const desktop = fakeSocket();
  const phone = fakeSocket();
  const desktopHandler = terminal.attachTerminalHandler(desktop);
  const phoneHandler = terminal.attachTerminalHandler(phone);
  let sessionId = null;
  try {
    await desktopHandler.handleMessage({
      type: 'init', cwd: '/tmp', cols: 120, rows: 40, shell: true,
    });
    const opened = desktop.messages('session').at(-1);
    assert.ok(opened?.sessionId, 'init opened a session');
    sessionId = opened.sessionId;

    await phoneHandler.handleMessage({
      type: 'attach', sessionId, cols: 80, rows: 24,
    });
    const joined = phone.messages('session').at(-1);
    assert.equal(joined.isReconnect, true);
    assert.deepEqual(desktop.messages('detached'), [{ type: 'detached', reason: 'replaced' }],
      'the incumbent is told it was replaced');
    assert.deepEqual(desktop.closedWith, { code: 4001, reason: 'Replaced by new client' });
    assert.deepEqual(await ptySize(sessionId, phone), { rows: 24, cols: 80 },
      'the pty follows the client that took over');

    // A resize from the evicted client no longer steers the pty.
    await desktopHandler.handleMessage({ type: 'resize', cols: 200, rows: 60 });
    assert.deepEqual(await ptySize(sessionId, phone), { rows: 24, cols: 80 });
  } finally {
    if (sessionId) sessionManager.destroySession(sessionId, { reason: 'test' });
  }
});
