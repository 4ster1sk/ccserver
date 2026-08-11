// Unit tests for the MCP tool layer (mcpTools.js + groupManager.js), with
// special focus on the authorization boundary: a group's orchestrator must
// never be able to reach a session belonging to another group (or any session
// that is not a registered member). These tests use the real in-memory group
// registry but never spawn real agent sessions -- the member ids are fake
// registrations, which is exactly what the boundary checks operate on.
//
// MCP SDK / bwrap / browser / agent CLIs are NOT required.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

let runtimeDir;
let groupManager;
let tools;
let groupsToDestroy = [];

// The real brokers listen under XDG_RUNTIME_DIR (read at mcpBroker module
// evaluation), so point it at a fresh dir before importing.
before(async () => {
  runtimeDir = mkdtempSync(join(tmpdir(), 'ccserver-mcp-test-'));
  process.env.XDG_RUNTIME_DIR = runtimeDir;
  // Group persistence must never touch the repo-root state file during tests.
  process.env.CCSERVER_GROUPS_PATH = join(runtimeDir, 'saved-groups.json');
  groupManager = await import('./groupManager.js');
  tools = await import('./mcpTools.js');
});

after(() => {
  for (const id of groupsToDestroy) groupManager.destroyGroup(id);
  for (const dir of tmpRepos) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } }
  try { rmSync(runtimeDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

// Real on-disk repo fixtures for repo_info (see the repoInfo tests below).
let tmpRepos = [];
function makeTmpRepo(tag) {
  const dir = mkdtempSync(join(tmpdir(), `ccserver-repo-${tag}-`));
  tmpRepos.push(dir);
  return dir;
}

async function makeGroupAsync() {
  const id = randomUUID();
  await groupManager.createGroup({ groupId: id, cwd: `/srv/project-${id}`, orchestratorDir: `/srv/orch-${id}` });
  groupsToDestroy.push(id);
  return id;
}

// deps the way mcpServer would build them for the control socket
function controlDeps(groupId) {
  return {
    groupId,
    groupManager,
    sessionManager: { getSession: () => null, writeToSession: () => false, waitUntilSettled: async () => ({ settled: true }) },
  };
}

// deps the way mcpServer would build them for a worker's handoff socket:
// sessionId comes from the closure (here a fake registered id), never from args
function handoffDeps(groupId, role, sessionId) {
  return {
    groupId,
    role,
    getSessionId: () => sessionId,
    groupManager,
    sessionManager: { getSession: () => null, writeToSession: () => false, waitUntilSettled: async () => ({ settled: true }) },
  };
}

test('listGroupSessions reports registered members with roles', async () => {
  const g = await makeGroupAsync();
  groupManager.registerMember(g, 'workerA', 'sess-a');
  groupManager.registerMember(g, 'workerB', 'sess-b');
  groupManager.registerMember(g, 'orchestrator', 'sess-o');

  const { members } = tools.listGroupSessions(controlDeps(g));
  const byRole = Object.fromEntries(members.map((m) => [m.role, m]));
  assert.equal(byRole.workerA.sessionId, 'sess-a');
  assert.equal(byRole.workerB.sessionId, 'sess-b');
  assert.equal(byRole.orchestrator.sessionId, 'sess-o');
  assert.equal(members.length, 3);
  // No live sessions behind these member ids (getSession returns null) ->
  // autoYes is null, like connected/lastOutputAt.
  assert.equal(byRole.workerA.autoYes, null);
  assert.equal(byRole.orchestrator.autoYes, null);
});

test('isSessionInGroup: only registered members pass', async () => {
  const g = await makeGroupAsync();
  groupManager.registerMember(g, 'workerA', 'sess-a');
  assert.equal(groupManager.isSessionInGroup(g, 'sess-a'), true);
  assert.equal(groupManager.isSessionInGroup(g, 'sess-other'), false);
  assert.equal(groupManager.isSessionInGroup('no-such-group', 'sess-a'), false);
});

// The critical boundary: a group's tools must refuse every session id that
// belongs to a different group (or none at all).
test('authorization: cross-group session ids are refused by every tool', async () => {
  const a = await makeGroupAsync();
  const b = await makeGroupAsync();
  groupManager.registerMember(a, 'workerA', 'sess-a1');
  groupManager.registerMember(a, 'orchestrator', 'sess-a2');
  groupManager.registerMember(b, 'workerA', 'sess-b1');

  const depsA = controlDeps(a);

  const r = tools.readOutput(depsA, { sessionId: 'sess-b1' });
  assert.equal(r.error, 'unauthorized');

  const i = await tools.sendInput(depsA, { sessionId: 'sess-b1', text: 'ls' });
  assert.equal(i.error, 'unauthorized');

  const c = tools.closeTab(depsA, { sessionId: 'sess-b1' });
  assert.equal(c.error, 'unauthorized');

  const s = tools.getTabStatus(depsA, { sessionId: 'sess-b1' });
  assert.equal(s.error, 'unauthorized');

  // Unregistered ids (even ones that look plausible) are refused too.
  const u = tools.readOutput(depsA, { sessionId: 'sess-a1-gone' });
  assert.equal(u.error, 'unauthorized');
});

test('readOutput: authorized member with no live session yields not-found (no crash)', async () => {
  const g = await makeGroupAsync();
  groupManager.registerMember(g, 'workerA', 'sess-a1');
  const r = tools.readOutput(controlDeps(g), { sessionId: 'sess-a1' });
  assert.equal(r.error, 'not-found');
});

test('readOutput: rejects the session from a destroyed group', async () => {
  const g = await makeGroupAsync();
  groupManager.registerMember(g, 'workerA', 'sess-a1');
  groupManager.destroyGroup(g);
  const r = tools.readOutput(controlDeps(g), { sessionId: 'sess-a1' });
  assert.equal(r.error, 'unauthorized');
});

test('handoff: worker pushes and orchestrator receives the structured event', async () => {
  const g = await makeGroupAsync();
  groupManager.registerMember(g, 'workerA', 'sess-a1');

  const wd = handoffDeps(g, 'workerA', 'sess-a1');
  const res = tools.handoffToOrchestrator(wd, { summary: 'commit done', status: 'done' });
  assert.equal(res.ok, true);

  const ev = await tools.waitForHandoff(controlDeps(g), { timeoutMs: 500 });
  assert.equal(ev.error, undefined);
  assert.equal(ev.fromSessionId, 'sess-a1');
  assert.equal(ev.fromRole, 'workerA');
  assert.equal(ev.summary, 'commit done');
  assert.equal(ev.status, 'done');
  assert.equal(typeof ev.at, 'number');
});

test('handoff: FIFO order across two workers', async () => {
  const g = await makeGroupAsync();
  groupManager.registerMember(g, 'workerA', 'sess-a1');
  groupManager.registerMember(g, 'workerB', 'sess-b1');

  tools.handoffToOrchestrator(handoffDeps(g, 'workerA', 'sess-a1'), { summary: 'first', status: 'done' });
  tools.handoffToOrchestrator(handoffDeps(g, 'workerB', 'sess-b1'), { summary: 'second', status: 'blocked' });

  const e1 = await tools.waitForHandoff(controlDeps(g), { timeoutMs: 500 });
  const e2 = await tools.waitForHandoff(controlDeps(g), { timeoutMs: 500 });
  assert.equal(e1.summary, 'first');
  assert.equal(e1.fromRole, 'workerA');
  assert.equal(e2.summary, 'second');
  assert.equal(e2.fromRole, 'workerB');
  assert.equal(e2.status, 'blocked');
});

test('handoff: invalid status is rejected before reaching the queue', async () => {
  const g = await makeGroupAsync();
  const res = tools.handoffToOrchestrator(handoffDeps(g, 'workerA', 'sess-a1'), { summary: 'x', status: 'sideways' });
  assert.equal(res.error, 'bad-request');
});

// The unit-level half of the "identity is closure-bound" invariant: even a
// caller that passes identity-looking fields in the tool arguments gets the
// closure's values (mcpTools only reads summary/status/nextRole).
test('handoff: identity fields in the arguments are ignored (closure wins)', async () => {
  const g = await makeGroupAsync();
  groupManager.registerMember(g, 'workerA', 'sess-a1');

  const res = tools.handoffToOrchestrator(handoffDeps(g, 'workerA', 'sess-a1'), {
    summary: 'tampered',
    status: 'done',
    sessionId: 'evil-session',
    groupId: 'evil-group',
    role: 'orchestrator',
  });
  assert.equal(res.ok, true);

  const ev = await tools.waitForHandoff(controlDeps(g), { timeoutMs: 500 });
  assert.equal(ev.fromSessionId, 'sess-a1', 'identity must come from the deps closure, not the arguments');
  assert.equal(ev.fromRole, 'workerA');
  assert.equal(ev.groupId, undefined);
});

// Every control tool must be callable without any identity input -- the
// schemas forbid it at the wire layer (mcpBroker.test.js walks the schemas);
// this is the implementation half: no tool may even READ a wire-supplied
// identity, which the deps-shape (groupId only in deps) enforces at compile
// time. Sanity-check the read path against a session id that is NOT a member.
test('sendInput: authorized member whose session is gone yields not-found (no crash)', async () => {
  const g = await makeGroupAsync();
  groupManager.registerMember(g, 'workerA', 'sess-a1');
  const r = await tools.sendInput(controlDeps(g), { sessionId: 'sess-a1', text: 'ls' });
  assert.equal(r.error, 'not-found');
});

test('sendInput moves the current turn to the targeted member', async () => {
  const g = await makeGroupAsync();
  groupManager.registerMember(g, 'workerA', 'sess-a1');
  groupManager.registerMember(g, 'orchestrator', 'sess-o');

  // A working writeToSession (the default controlDeps always returns false).
  const deps = {
    groupId: g,
    groupManager,
    sessionManager: { getSession: () => ({}), writeToSession: () => true, waitUntilSettled: async () => ({ settled: true }) },
  };

  const r = await tools.sendInput(deps, { sessionId: 'sess-a1', text: 'go' });
  assert.deepEqual(r, { ok: true, settled: true });
  assert.equal(groupManager.getGroup(g).currentTurn, 'workerA');
});

// Issue #15: open_tab returns as soon as the pty is up, but the TUI is still
// initializing -- keystrokes written into it are dropped. sendInput must hold
// the write until the settle gate (first idle gap) opens.
test('sendInput: holds the write until the settle gate opens (fresh session)', async () => {
  const g = await makeGroupAsync();
  groupManager.registerMember(g, 'workerA', 'sess-a1');

  let writeCalls = 0;
  let releaseGate;
  const gate = new Promise((r) => { releaseGate = r; });
  const deps = {
    groupId: g,
    groupManager,
    sessionManager: {
      waitUntilSettled: async () => {
        await gate;
        return { settled: true };
      },
      writeToSession: () => { writeCalls++; return true; },
    },
  };

  const pending = tools.sendInput(deps, { sessionId: 'sess-a1', text: 'go', submit: false });
  await new Promise((r) => setImmediate(r));
  assert.equal(writeCalls, 0, 'must not write before the TUI has settled');
  releaseGate();
  const r = await pending;
  assert.deepEqual(r, { ok: true, settled: true });
  assert.equal(writeCalls, 1);
});

test('sendInput: still writes when the settle gate times out, reporting settled:false', async () => {
  const g = await makeGroupAsync();
  groupManager.registerMember(g, 'workerA', 'sess-a1');

  let writeCalls = 0;
  const deps = {
    groupId: g,
    groupManager,
    sessionManager: {
      waitUntilSettled: async () => ({ settled: false, timedOut: true }),
      writeToSession: () => { writeCalls++; return true; },
    },
  };

  const r = await tools.sendInput(deps, { sessionId: 'sess-a1', text: 'go' });
  assert.equal(writeCalls, 1, 'the write is best-effort: it happens even on a settle timeout');
  assert.deepEqual(r, { ok: true, settled: false });
});

test('sendInput: an already-settled session writes without waiting (no latency regression)', async () => {
  const g = await makeGroupAsync();
  groupManager.registerMember(g, 'workerA', 'sess-a1');

  let gateWaited = false;
  const deps = {
    groupId: g,
    groupManager,
    sessionManager: {
      waitUntilSettled: async () => { gateWaited = true; return { settled: true }; },
      writeToSession: () => true,
    },
  };

  const r = await tools.sendInput(deps, { sessionId: 'sess-a1', text: 'go' });
  assert.deepEqual(r, { ok: true, settled: true });
  // The settle gate must still be consulted (the wait itself is what the
  // real sessionManager short-circuits for already-settled sessions) -- the
  // no-wait property is covered against the real sessionManager below.
  assert.equal(gateWaited, true);
});

// Full wiring test: the real sessionManager's idle timer (3s of quiet output)
// opens the settle gate, and sendInput holds the write until then. A real
// bash session stands in for a freshly-launched agent TUI (shell flag flipped
// after spawn to activate the agent-only idle path).
test('sendInput (real session): holds the write until the idle gap opens the settle gate', async () => {
  const sm = await import('./sessionManager.js');
  const res = sm.createSession({ cwd: '/tmp', cols: 80, rows: 24, shell: true, sandbox: false });
  const s = res.session;
  assert.ok(s, 'shell session should spawn');
  const g = await makeGroupAsync();
  groupManager.registerMember(g, 'workerA', res.sessionId);
  try {
    s.shell = false;
    s.settled = false;
    s.settleWaiters = [];
    const writes = [];
    const deps = {
      groupId: g,
      groupManager,
      sessionManager: {
        getSession: (id) => sm.getSession(id),
        writeToSession: (id, text, opts) => { writes.push(text); return sm.writeToSession(id, text, opts); },
        waitUntilSettled: (id, opts) => sm.waitUntilSettled(id, opts),
      },
    };

    // TUI startup burst: bash echoes a line, then goes quiet.
    s.ptyProcess.write('echo TUI_BOOT_MARKER\r');
    const pending = tools.sendInput(deps, { sessionId: res.sessionId, text: 'go', submit: false });
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(writes.length, 0, 'must not write while the TUI is still initializing');
    const r = await pending;
    assert.deepEqual(r, { ok: true, settled: true });
    assert.deepEqual(writes, ['go']);
    assert.equal(s.settled, true, 'the session must have settled via its idle timer');
  } finally {
    sm.destroySession(res.sessionId, { keepSchedule: false });
  }
});

// Issue #16: get_tab_status must expose the session's activity timestamp so
// the orchestrator can tell "slow but working" from "stuck". idleForMs is the
// elapsed time since the last output at call time.
test('getTabStatus: reports lastOutputAt and the derived idleForMs', async () => {
  const g = await makeGroupAsync();
  groupManager.registerMember(g, 'workerA', 'sess-a1');
  const lastOutputAt = Date.now() - 5000;
  const fakeSession = { cwd: '/srv/proj', app: 'claude', exited: false, socket: {}, lastOutputAt, autoYes: true };
  const deps = {
    groupId: g,
    groupManager,
    sessionManager: { getSession: (id) => (id === 'sess-a1' ? fakeSession : null), writeToSession: () => false },
  };
  const r = tools.getTabStatus(deps, { sessionId: 'sess-a1' });
  assert.equal(r.error, undefined);
  assert.equal(r.lastOutputAt, lastOutputAt);
  assert.equal(r.autoYes, true, 'autoYes reflects the live session state');
  assert.ok(r.idleForMs >= 5000 && r.idleForMs <= 6000, `idleForMs must be the time since the last output (got ${r.idleForMs})`);
});

test('getTabStatus: no output yet (lastOutputAt null) yields idleForMs null', async () => {
  const g = await makeGroupAsync();
  groupManager.registerMember(g, 'workerA', 'sess-a1');
  const fakeSession = { cwd: '/srv/proj', app: 'claude', exited: false, lastOutputAt: null, autoYes: false };
  const deps = {
    groupId: g,
    groupManager,
    sessionManager: { getSession: (id) => (id === 'sess-a1' ? fakeSession : null), writeToSession: () => false },
  };
  const r = tools.getTabStatus(deps, { sessionId: 'sess-a1' });
  assert.equal(r.lastOutputAt, null);
  assert.equal(r.idleForMs, null);
  assert.equal(r.autoYes, false);
});

test('listGroupSessions: autoYes reflects each live session state', async () => {
  const g = await makeGroupAsync();
  groupManager.registerMember(g, 'workerA', 'sess-a1');
  groupManager.registerMember(g, 'workerB', 'sess-b1');
  const fake = {
    getSession: (id) => (id === 'sess-a1'
      ? { app: 'claude', cwd: '/srv/proj', exited: false, autoYes: true }
      : id === 'sess-b1'
        ? { app: 'opencode', cwd: '/srv/proj', exited: false, autoYes: false }
        : null),
    createSession: () => { throw new Error('unused'); },
    destroySession: () => {},
    writeToSession: () => false,
  };
  groupManager.setSessionApiForTests(fake);
  try {
    const { members } = tools.listGroupSessions(controlDeps(g));
    const byRole = Object.fromEntries(members.map((m) => [m.role, m]));
    assert.equal(byRole.workerA.autoYes, true);
    assert.equal(byRole.workerB.autoYes, false);
  } finally {
    groupManager.setSessionApiForTests(null);
  }
});

test('waitForHandoff: empty queue times out with a tiny timedOut result (not an error)', async () => {
  const g = await makeGroupAsync();
  const started = Date.now();
  const ev = await tools.waitForHandoff(controlDeps(g), { timeoutMs: 60 });
  assert.equal(ev.timedOut, true);
  assert.ok(Date.now() - started >= 50);
});

test('waitForHandoff: a handoff that arrives while waiting resolves immediately', async () => {
  const g = await makeGroupAsync();
  groupManager.registerMember(g, 'workerA', 'sess-a1');
  const wait = tools.waitForHandoff(controlDeps(g), { timeoutMs: 500 });
  setTimeout(() => {
    tools.handoffToOrchestrator(handoffDeps(g, 'workerA', 'sess-a1'), { summary: 'late arrival', status: 'done' });
  }, 30);
  const ev = await wait;
  assert.equal(ev.summary, 'late arrival');
});

test('openTab: cwd outside the group project dir is refused before any spawn', async () => {
  const g = await makeGroupAsync();
  groupManager.registerMember(g, 'workerA', 'sess-a1');
  const res = await tools.openTab(controlDeps(g), { role: 'workerC', app: 'claude', cwd: '/somewhere/else' });
  assert.equal(res.error, 'cwd-not-allowed');
});

test('openTab: invalid app is refused', async () => {
  const g = await makeGroupAsync();
  const res = await tools.openTab(controlDeps(g), { role: 'workerC', app: 'shell', cwd: `/srv/project-${g}` });
  assert.equal(res.error, 'bad-request');
});

test('openTab: unknown group errors cleanly', async () => {
  const res = await tools.openTab(controlDeps('no-such-group'), { role: 'workerC', app: 'claude', cwd: '/x' });
  assert.equal(res.error, 'group-not-found');
});

// Issue: open_tab's app/model/sandboxOpts are optional at the wire layer.
// An omitted model must resolve through the role's persisted preference, then
// the app default; an explicit null model means "app default" and must
// override any persisted preference.
test('openTab: omitted model falls back to the persisted role preference', async () => {
  const g = await makeGroupAsync();
  // A fake session facade: addMember spawns via it and records the options.
  let seenOpts = null;
  const fake = {
    getSession: () => null,
    createSession: (opts) => { seenOpts = opts; return { sessionId: 'sess-m', session: {} }; },
    destroySession: () => {},
    writeToSession: () => false,
  };
  groupManager.setSessionApiForTests(fake);
  try {
    groupManager.setMemberPrefs(g, 'workerA', { app: 'opencode', model: 'gpt-5', sandboxOpts: { gpg: true, sshAgent: false } });

    // model omitted -> persisted preference (gpt-5) is used.
    const r1 = await tools.openTab(controlDeps(g), { role: 'workerA', cwd: `/srv/project-${g}` });
    assert.equal(r1.error, undefined, r1.message || '');
    assert.equal(r1.model, 'gpt-5', 'effective model returned in the tool result');
    assert.equal(seenOpts.model, 'gpt-5');
    assert.deepEqual(seenOpts.sandboxOpts, { gpg: true, sshAgent: false }, 'persisted per-role sandbox flags survive open_tab');

    // Explicit model null -> app default (overrides the persisted preference).
    const r2 = await tools.openTab(controlDeps(g), { role: 'workerA', model: null, cwd: `/srv/project-${g}` });
    assert.equal(r2.model, null);
    assert.equal(seenOpts.model, null);

    // Explicit model string -> used directly.
    const r3 = await tools.openTab(controlDeps(g), { role: 'workerA', model: 'claude-sonnet-4', cwd: `/srv/project-${g}` });
    assert.equal(r3.model, 'claude-sonnet-4');
    assert.equal(seenOpts.model, 'claude-sonnet-4');

    // Explicit sandboxOpts override the preference.
    const r4 = await tools.openTab(controlDeps(g), { role: 'workerA', sandboxOpts: { gpg: false, sshAgent: true }, cwd: `/srv/project-${g}` });
    assert.deepEqual(r4.sandboxOpts, { gpg: false, sshAgent: true });
    assert.deepEqual(seenOpts.sandboxOpts, { gpg: false, sshAgent: true });
  } finally {
    groupManager.setSessionApiForTests(null);
    groupManager.destroyGroup(g);
  }
});

test('openTab: omitted app falls back to the persisted role preference', async () => {
  const g = await makeGroupAsync();
  let seenApp = null;
  const fake = {
    getSession: () => null,
    createSession: (opts) => { seenApp = opts.app; return { sessionId: 'sess-a', session: {} }; },
    destroySession: () => {},
    writeToSession: () => false,
  };
  groupManager.setSessionApiForTests(fake);
  try {
    groupManager.setMemberPrefs(g, 'workerB', { app: 'opencode', model: null, sandboxOpts: null });
    const r = await tools.openTab(controlDeps(g), { role: 'workerB', cwd: `/srv/project-${g}` });
    assert.equal(r.error, undefined, r.message || '');
    assert.equal(r.app, 'opencode', 'omitted app resolves through the persisted preference');
    assert.equal(seenApp, 'opencode');
  } finally {
    groupManager.setSessionApiForTests(null);
    groupManager.destroyGroup(g);
  }
});

// The orchestrator must never be able to spawn/replace "itself".
test('openTab: role orchestrator is refused (self-destruction guard)', async () => {
  const g = await makeGroupAsync();
  groupManager.registerMember(g, 'orchestrator', 'sess-o');
  groupManager.registerMember(g, 'workerA', 'sess-a1');

  const res = await tools.openTab(controlDeps(g), { role: 'orchestrator', app: 'claude', cwd: `/srv/project-${g}` });
  assert.equal(res.error, 'invalid-role');
  // The existing orchestrator member is untouched (same sessionId still bound).
  assert.equal(groupManager.isSessionInGroup(g, 'sess-o'), true);
  const { members } = tools.listGroupSessions(controlDeps(g));
  const orch = members.find((m) => m.role === 'orchestrator');
  assert.equal(orch.sessionId, 'sess-o');
});

test('openTab: non-worker role formats are refused', async () => {
  const g = await makeGroupAsync();
  for (const bad of ['boss', 'Orchestrator', 'worker', 'orchestrator', ''] ) {
    const res = await tools.openTab(controlDeps(g), { role: bad, app: 'claude', cwd: `/srv/project-${g}` });
    assert.equal(res.error, 'invalid-role', `role ${JSON.stringify(bad)} should be refused`);
  }
});

test('readOutput: authorized live member returns raw + stripped text (tail 0 clamps to 1 chunk, not 4000)', async () => {
  const g = await makeGroupAsync();
  groupManager.registerMember(g, 'workerA', 'sess-a1');
  const fakeSession = {
    cwd: '/srv/project-x',
    app: 'claude',
    exited: false,
    outputBuffer: ['\x1b[31mred\x1b[0m text ', 'more\n'],
  };
  const deps = {
    groupId: g,
    groupManager,
    sessionManager: { getSession: (id) => (id === 'sess-a1' ? fakeSession : null), writeToSession: () => false },
  };
  // tail: 0 must NOT silently fall back to the 4000 default -- it clamps to
  // the 1-chunk minimum instead.
  const out = tools.readOutput(deps, { sessionId: 'sess-a1', tail: 0 });
  assert.equal(out.error, undefined);
  assert.equal(out.text, 'more\n');
  assert.equal(out.raw, 'more\n');
  // A larger tail includes everything.
  const full = tools.readOutput(deps, { sessionId: 'sess-a1', tail: 100 });
  assert.equal(full.text, 'red text more\n');
});

// Cost control: read_output exists to keep the orchestrator's context small,
// so a default call must not return the whole ~512KB buffer.
test('readOutput: default tail stays small and output is hard-capped with truncated:true', async () => {
  const g = await makeGroupAsync();
  groupManager.registerMember(g, 'workerA', 'sess-a1');
  // 800 chunks x 200 chars = 160KB of output -- far past the 16KB cap.
  const fakeSession = {
    cwd: '/srv/project-x',
    app: 'claude',
    exited: false,
    outputBuffer: Array.from({ length: 800 }, (_, i) => `chunk ${i} ` + 'x'.repeat(190)),
  };
  const deps = {
    groupId: g,
    groupManager,
    sessionManager: { getSession: (id) => (id === 'sess-a1' ? fakeSession : null), writeToSession: () => false },
  };
  const out = tools.readOutput(deps, { sessionId: 'sess-a1' });
  assert.equal(out.error, undefined);
  assert.ok(out.raw.length <= 16 * 1024, `raw must be capped (got ${out.raw.length})`);
  assert.ok(out.text.length <= 16 * 1024, `text must be capped (got ${out.text.length})`);
  assert.equal(out.truncated, true);
  // The tail of the output survives the cap.
  assert.ok(out.raw.endsWith('x'.repeat(190)), 'the newest chunk must be included');

  // An explicit huge tail is still capped by the char limit, not by chunks.
  const huge = tools.readOutput(deps, { sessionId: 'sess-a1', tail: 100000 });
  assert.ok(huge.raw.length <= 16 * 1024);
  assert.equal(huge.truncated, true);

  // Small output: no truncation flag, everything returned.
  const small = tools.readOutput(deps, { sessionId: 'sess-a1', tail: 1 });
  assert.equal(small.truncated, false);
  assert.ok(small.raw.endsWith('x'.repeat(190)));
});

test('handoff queue is capped: overflow drops the oldest entries', async () => {
  const g = await makeGroupAsync();
  groupManager.registerMember(g, 'workerA', 'sess-a1');
  for (let i = 0; i < 120; i++) {
    tools.handoffToOrchestrator(handoffDeps(g, 'workerA', 'sess-a1'), { summary: `s${i}`, status: 'done' });
  }
  const ev = await tools.waitForHandoff(controlDeps(g), { timeoutMs: 200 });
  assert.equal(ev.summary, 's20'); // the 20 oldest were dropped (cap 100)
});

// The scheduled-prompt auto-resume path creates a session carrying the
// original groupId/groupRole; the session-create listener must re-bind the
// role to the new sessionId (a real shell session stands in for an agent --
// no sandbox or agent CLI needed).
test('session created with groupId/groupRole is auto-registered to its role', async () => {
  const g = await makeGroupAsync();
  groupManager.registerMember(g, 'workerA', 'dead-old-session');

  const sm = await import('./sessionManager.js');
  const res = sm.createSession({
    cwd: '/tmp', cols: 80, rows: 24,
    shell: true, sandbox: false,
    groupId: g, groupRole: 'workerA',
  });
  assert.ok(res.session, 'shell session should spawn');
  try {
    assert.equal(groupManager.isSessionInGroup(g, res.sessionId), true);
    assert.equal(groupManager.isSessionInGroup(g, 'dead-old-session'), false);
    const { members } = tools.listGroupSessions(controlDeps(g));
    assert.equal(members.find((m) => m.role === 'workerA').sessionId, res.sessionId);
  } finally {
    sm.destroySession(res.sessionId, { keepSchedule: false });
  }
});

test('closeTab: destroying a member removes it from the group', async () => {
  const g = await makeGroupAsync();
  groupManager.registerMember(g, 'workerA', 'sess-a1');
  groupManager.registerMember(g, 'orchestrator', 'sess-o');
  const res = tools.closeTab(controlDeps(g), { sessionId: 'sess-a1' });
  assert.equal(res.ok, true);
  assert.equal(groupManager.isSessionInGroup(g, 'sess-a1'), false);
  assert.equal(groupManager.isSessionInGroup(g, 'sess-o'), true);
});

test('stripAnsi: removes common escape sequences', () => {
  assert.equal(tools.stripAnsi('\x1b[31mred\x1b[0m text'), 'red text');
  assert.equal(tools.stripAnsi('\x1b]0;title\x07hi'), 'hi');
  assert.equal(tools.stripAnsi('plain'), 'plain');
});

// --- repo_info (Issue: orchestrator repo-facts tool) -----------------------

test('repoInfo returns shallow repo facts (root/readme/packageJson/git)', async () => {
  const dir = makeTmpRepo('full');
  mkdirSync(join(dir, 'src'));
  mkdirSync(join(dir, 'docs'));
  writeFileSync(join(dir, 'README.md'), '# My Project\n\nRead me.');
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: 'my-project',
    version: '1.2.3',
    description: 'A test project',
    scripts: { build: 'tsc', test: 'vitest' },
    dependencies: { zod: '^3.0.0' },
    devDependencies: { typescript: '^5.0.0' },
  }));
  execFileSync('git', ['init', '-q', dir]);
  execFileSync('git', ['-C', dir, 'add', '.']);
  execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'initial commit']);

  const gid = randomUUID();
  await groupManager.createGroup({ groupId: gid, cwd: dir, orchestratorDir: join(dir, '..', 'orch') });
  groupsToDestroy.push(gid);

  const out = await tools.repoInfo(controlDeps(gid));
  assert.equal(out.error, undefined);
  assert.equal(out.cwd, dir);
  assert.ok(out.root.dirs.includes('src'), 'src dir listed');
  assert.ok(out.root.dirs.includes('docs'), 'docs dir listed');
  assert.ok(out.root.files.includes('package.json'), 'package.json listed');
  assert.ok(out.root.files.includes('README.md'), 'README.md listed');
  assert.equal(out.root.truncated, false);
  assert.equal(out.readme.file, 'README.md');
  assert.ok(out.readme.text.includes('My Project'));
  assert.equal(out.readme.truncated, false);
  assert.equal(out.packageJson.name, 'my-project');
  assert.equal(out.packageJson.version, '1.2.3');
  assert.equal(out.packageJson.description, 'A test project');
  assert.deepEqual(out.packageJson.scripts, ['build', 'test']);
  assert.deepEqual(out.packageJson.dependencies, ['zod']);
  assert.deepEqual(out.packageJson.devDependencies, ['typescript']);
  assert.ok(out.git.branch.length > 0, 'current branch reported');
  assert.ok(out.git.head.length > 0, 'short HEAD reported');
  assert.equal(out.git.log.length, 1);
  assert.ok(out.git.log[0].endsWith('initial commit'), `log line is '<hash> initial commit' (got ${out.git.log[0]})`);
  assert.equal(out.git.changes, 0, 'clean tree');
});

test('repoInfo: missing README/package.json/git fall back to null per section', async () => {
  const dir = makeTmpRepo('bare');
  const gid = randomUUID();
  await groupManager.createGroup({ groupId: gid, cwd: dir, orchestratorDir: join(dir, '..', 'orch') });
  groupsToDestroy.push(gid);

  const out = await tools.repoInfo(controlDeps(gid));
  assert.equal(out.readme, null, 'no README variant -> null');
  assert.equal(out.packageJson, null, 'no package.json -> null');
  assert.equal(out.git, null, 'not a git repository -> null');
  assert.deepEqual(out.root.dirs, []);
  assert.deepEqual(out.root.files, []);
});

test('repoInfo: unknown group yields group-not-found', async () => {
  const out = await tools.repoInfo(controlDeps('no-such-group'));
  assert.equal(out.error, 'group-not-found');
});

test('repoInfo: caps bite (root 100 entries, README 8KB, package keys 50)', async () => {
  const dir = makeTmpRepo('caps');
  for (let i = 0; i < 120; i++) writeFileSync(join(dir, `file-${String(i).padStart(3, '0')}.txt`), 'x');
  writeFileSync(join(dir, 'README.md'), 'x'.repeat(9000));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: 'caps',
    scripts: Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`s${i}`, 'echo'])),
    dependencies: Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`dep${i}`, '^1.0.0'])),
  }));
  const gid = randomUUID();
  await groupManager.createGroup({ groupId: gid, cwd: dir, orchestratorDir: join(dir, '..', 'orch') });
  groupsToDestroy.push(gid);

  const out = await tools.repoInfo(controlDeps(gid));
  assert.equal(out.root.files.length, 100, 'root listing capped at 100');
  assert.equal(out.root.truncated, true);
  assert.equal(out.readme.text.length, 8 * 1024, 'README capped at 8KB');
  assert.equal(out.readme.truncated, true);
  assert.equal(out.packageJson.scripts.length, 50, 'scripts keys capped at 50');
  assert.equal(out.packageJson.dependencies.length, 50, 'dependencies keys capped at 50');
});
