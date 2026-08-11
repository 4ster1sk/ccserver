// Pure MCP tool implementations for combo-launched groups. No MCP SDK
// dependency and no imports of the app's mutable modules -- every function
// receives its dependencies (`deps`) explicitly, so these can be unit-tested
// directly with node --test (see mcpTools.test.js). Node builtins only.
//
// SECURITY: no function here ever accepts `groupId`, `sessionId` or `role`
// from the wire as an identity. The control server's deps carry the groupId
// (closure-bound at connection time); the handoff server's deps carry the
// role and resolve the sessionId from the group's own member registry. A
// client-supplied sessionId is only ever a *target* of a request, and every
// tool that takes one first checks groupManager.isSessionInGroup() -- the
// single authorization chokepoint. Breaking this shape (e.g. accepting a
// groupId argument) nullifies the whole isolation boundary.

import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const ANSI_RE = /\x1b(?:\[[0-9;?]*[a-zA-Z]|\][^\x07\x1b]*(?:\x07|\x1b\\)?|[()][A-Z0-9]|[>=<]|#[0-9])/g;

// Handoff summaries are orchestrator input (context) -- cap their size so a
// noisy worker can't balloon the queue's memory beyond the count cap.
const MAX_HANDOFF_SUMMARY_CHARS = 32 * 1024;

export function stripAnsi(text) {
  return text.replace(ANSI_RE, '');
}

// deps: { groupId, groupManager, sessionManager }
export function listGroupSessions(deps) {
  return { members: deps.groupManager.listGroupMembers(deps.groupId) };
}

// Read recent terminal output of a group member. The raw bytes and an
// ANSI-stripped text view are both returned; prefer `text` for feeding the
// orchestrator's context. This is a fallback for stuck-member inspection --
// the recommended flow is wait_for_handoff.
//
// The raw byte stream cannot show what the member's screen currently looks
// like (TUI spinners redraw in place via cursor moves/line erases), so the
// server also keeps a lightweight virtual screen per session: `screen` is
// the current visible screen (tail of the screen model's rows),
// `screenAlt` whether an alternate screen is active, and `screenIdleMs`
// the time since the screen last visibly changed (bytes can keep flowing
// while the screen is static -- a spinner keeps writing frames; a screen
// that stopped changing means the member is idle). Prefer `screen` +
// `screenIdleMs` for stuck/busy judgments over `text`/`raw`.
//
// Cost control: this feature exists to keep the orchestrator's context
// small, so a default call must not balloon it. `tail` counts output chunks
// (default 200 -- the server buffers up to ~512KB in chunks), and the
// returned text is hard-capped at MAX_READOUTPUT_CHARS; when the cap bites,
// the tail of the buffer is returned and `truncated: true` is set so the
// caller knows the head of the output was dropped. The text cap cuts at a
// boundary that never splits an escape sequence (a split one would leak
// bare control bytes through stripAnsi). The `screen` view gets its own cap
// (a row count well under the char cap by construction).
const DEFAULT_OUTPUT_TAIL_CHUNKS = 200;
const MAX_OUTPUT_TAIL_CHUNKS = 100000;
const MAX_READOUTPUT_CHARS = 16 * 1024;
// The screen view is capped independently of the text cap: at most this many
// of the newest rows, each of which is at most SCREEN_COLS chars, so the
// returned screen stays well under MAX_READOUTPUT_CHARS.
const MAX_SCREEN_ROWS = 40;

// Cut `text` to at most `maxChars` chars at a boundary that does not split
// an escape sequence, keeping the tail. stripAnsi() only removes *complete*
// sequences, so a plain `.slice(-maxChars)` can land mid-sequence and leak
// bare control bytes into the text view. Walk the stream from the front,
// skip complete sequences, and cut at the last clean position at or before
// the cap -- when the cap splits a sequence, cut right after that sequence
// (the tail then starts clean and stays at or under the cap).
function cleanTextCut(text, maxChars) {
  if (text.length > maxChars) {
    const limit = text.length - maxChars;
    let cut = limit;
    let i = 0;
    while (i <= limit && i < text.length) {
      if (text[i] === '\x1b') {
        const end = ansiSequenceEnd(text, i);
        if (end === -1) break; // dangling sequence to the end -- cut at the limit
        if (end > limit) { // the cap splits this sequence
          cut = end;
          break;
        }
        i = end;
      } else {
        i++;
      }
    }
    text = text.slice(cut);
  }
  // The stream itself may end mid-sequence (a pty chunk boundary split it),
  // even when the cap did not: trim a dangling escape from the tail so bare
  // control bytes never leak through stripAnsi. Only the last sequence can
  // dangle (a dangling sequence runs to the end of the input).
  for (let k = 0; k < text.length; k++) {
    if (text[k] === '\x1b' && ansiSequenceEnd(text, k) === -1) {
      return text.slice(0, k);
    }
  }
  return text;
}

// End index (exclusive) of the escape sequence starting at `start` (which
// must be an ESC byte), or -1 when the sequence is incomplete at the end of
// the input. Mirrors the ANSI_RE grammar (CSI/OSC/charset/single-char).
function ansiSequenceEnd(text, start) {
  const next = text[start + 1];
  if (next === '[') {
    let j = start + 2;
    while (j < text.length && /[0-9;?]/.test(text[j])) j++;
    if (j >= text.length) return -1;
    return j + 1; // final byte 0x40-0x7E (anything else still terminates it)
  }
  if (next === ']') {
    let j = start + 2;
    while (j < text.length && text[j] !== '\x07' && !(text[j] === '\x1b' && text[j + 1] === '\\')) j++;
    if (j >= text.length) return -1;
    return text[j] === '\x07' ? j + 1 : j + 2;
  }
  if (next === '(' || next === ')' || next === '=' || next === '>' || next === '#') {
    if (text.length < start + 3) return -1;
    return start + 3;
  }
  if (next === undefined) return -1;
  return start + 2;
}

export function readOutput(deps, { sessionId, tail }) {
  const t = Number.isFinite(tail) ? tail : DEFAULT_OUTPUT_TAIL_CHUNKS;
  const n = Math.min(Math.max(t, 1), MAX_OUTPUT_TAIL_CHUNKS);
  if (!deps.groupManager.isSessionInGroup(deps.groupId, sessionId)) {
    return { error: 'unauthorized', message: 'session is not a member of this group' };
  }
  const session = deps.sessionManager.getSession(sessionId);
  if (!session) {
    return { error: 'not-found', message: 'session not found' };
  }
  const joined = session.outputBuffer.slice(-n).join('');
  let raw = joined;
  let truncated = false;
  if (joined.length > MAX_READOUTPUT_CHARS) {
    raw = joined.slice(-MAX_READOUTPUT_CHARS);
    truncated = true;
  }
  return {
    sessionId,
    cwd: session.cwd,
    app: session.app,
    exited: !!session.exited,
    raw,
    // The text view cuts the FULL stream at a sequence-safe boundary (raw
    // stays backward-compatible byte tail); see cleanTextCut.
    text: stripAnsi(cleanTextCut(joined, MAX_READOUTPUT_CHARS)),
    truncated,
    ...screenView(session),
  };
}

// The screen-model view of a session (see readOutput's doc comment). Null
// fields when the session has no screen model (e.g. a fake session in
// tests).
function screenView(session) {
  const screen = session.screen;
  if (!screen) {
    return { screen: null, screenAlt: null, screenTruncated: null, screenIdleMs: null };
  }
  let rows = screen.screenRows();
  let screenTruncated = false;
  if (rows.length > MAX_SCREEN_ROWS) {
    rows = rows.slice(-MAX_SCREEN_ROWS);
    screenTruncated = true;
  }
  return {
    screen: rows.join('\n'),
    screenAlt: screen.altScreenActive(),
    screenTruncated,
    screenIdleMs: session.screenLastChangeAt != null ? Date.now() - session.screenLastChangeAt : null,
  };
}

// Type text into a group member's terminal (optionally submitting with
// Enter). Not a shell command execution primitive -- just keystrokes. If the
// target's TUI was just launched (open_tab) it may still be initializing, so
// wait for the session to settle (first idle gap) before typing, otherwise
// the keystrokes can be dropped. Best-effort: the write happens regardless of
// the settle outcome; `settled: false` in the result means the input may not
// have been received.
export async function sendInput(deps, { sessionId, text, submit = true }) {
  if (!deps.groupManager.isSessionInGroup(deps.groupId, sessionId)) {
    return { error: 'unauthorized', message: 'session is not a member of this group' };
  }
  const { settled } = await deps.sessionManager.waitUntilSettled(sessionId);
  const ok = deps.sessionManager.writeToSession(sessionId, String(text), { submit: !!submit });
  if (ok) {
    // Orchestrator instructed this member: the turn moves to it.
    const role = deps.groupManager.getRoleForSession(deps.groupId, sessionId);
    if (role) deps.groupManager.setCurrentTurn(deps.groupId, role);
  }
  return ok
    ? { ok: true, settled }
    : { error: 'not-found', message: 'session not found or exited' };
}

// Open a new member session (worker role) inside the group, with its own
// handoff channel. cwd is restricted to the group's allowedCwds (initialized
// to the shared project directory -- see groupManager). app/model/sandboxOpts
// are optional at the wire layer: omitted values fall back to the role's
// persisted preference, then to the group/app defaults. sandboxOpts (gpg /
// ssh-agent forwarding) defaults to the group's launch flags; an explicit
// override is honored. The result carries the effective app/model/sandbox
// settings so the caller can record what actually launched.
export async function openTab(deps, { role, app, model, cwd, sandboxOpts }) {
  const options = { cwd };
  if (app !== undefined) options.app = app;
  if (model !== undefined) options.model = model;
  if (sandboxOpts !== undefined) options.sandboxOpts = sandboxOpts;
  const res = await deps.groupManager.addMember(deps.groupId, role, options);
  if (res.error) return { error: res.error, message: res.message };
  return {
    sessionId: res.sessionId,
    role,
    cwd,
    app: res.app,
    model: res.model,
    sandboxOpts: res.sandboxOpts || null,
  };
}

export function closeTab(deps, { sessionId }) {
  if (!deps.groupManager.isSessionInGroup(deps.groupId, sessionId)) {
    return { error: 'unauthorized', message: 'session is not a member of this group' };
  }
  deps.groupManager.removeMember(deps.groupId, sessionId);
  return { ok: true };
}

export function getTabStatus(deps, { sessionId }) {
  if (!deps.groupManager.isSessionInGroup(deps.groupId, sessionId)) {
    return { error: 'unauthorized', message: 'session is not a member of this group' };
  }
  const session = deps.sessionManager.getSession(sessionId);
  if (!session) {
    return { error: 'not-found', message: 'session not found' };
  }
  return {
    sessionId,
    cwd: session.cwd,
    app: session.app,
    exited: !!session.exited,
    exitCode: session.exitCode ?? null,
    connected: !!session.socket,
    autoYes: !!session.autoYes,
    lastOutputAt: session.lastOutputAt,
    idleForMs: session.lastOutputAt != null ? Date.now() - session.lastOutputAt : null,
    // Screen-change-based idle time (ms since the visible screen last
    // changed; null when the session has no screen model). Unlike idleForMs
    // (bytes-based), a spinner that keeps redrawing keeps this small -- a
    // large value means the screen is genuinely static.
    screenIdleMs: session.screenLastChangeAt != null ? Date.now() - session.screenLastChangeAt : null,
  };
}

// Block until a worker hands off, or the timeout elapses. Returns the FIFO
// handoff event (or a tiny { timedOut: true } on timeout -- NOT an error, so
// the orchestrator can simply call wait_for_handoff again). This is the
// recommended wait primitive: one structured call instead of polling
// read_output.
//
// deps.connectionIsAlive (a per-connection function, when provided) is
// forwarded to takeHandoff: an event is never dequeued for a connection
// whose socket is dead, so a handoff is never lost to a disconnected wait --
// it stays queued and the next wait_for_handoff receives it.
export function waitForHandoff(deps, { timeoutMs = 900000 }) {
  const opts = {};
  if (typeof deps.connectionIsAlive === 'function') opts.isAlive = deps.connectionIsAlive;
  return deps.groupManager.takeHandoff(deps.groupId, Math.max(Number(timeoutMs) || 0, 0), opts);
}

// Handoff (worker-only): notify the orchestrator that the worker's task is
// done / blocked / needs input. sessionId/role come from the handoff server's
// closure, never from the wire -- only summary/status are worker input.
export function handoffToOrchestrator(deps, { summary, status = 'done', nextRole = null }) {
  const sessionId = typeof deps.getSessionId === 'function'
    ? deps.getSessionId()
    : (deps.sessionId || null);
  const statuses = ['done', 'blocked', 'needs_input', 'error'];
  if (!statuses.includes(status)) {
    return { error: 'bad-request', message: `status must be one of: ${statuses.join(', ')}` };
  }
  const ok = deps.groupManager.pushHandoff(deps.groupId, {
    fromSessionId: sessionId,
    fromRole: deps.role || null,
    summary: String(summary || '').slice(0, MAX_HANDOFF_SUMMARY_CHARS),
    status,
    nextRole: nextRole || null,
    at: Date.now(),
  });
  return ok ? { ok: true } : { error: 'group-not-found' };
}

// --- repo_info -------------------------------------------------------------
// Shallow repository facts for the orchestrator (control server only).
// Security/cost posture, mirroring read_output:
//   - cwd is the group's project directory (group.cwd) -- never taken from
//     the wire, so there is no path argument to traverse with.
//   - read-only: no writes; the only command execution is the fixed git
//     invocations below (`git -C <cwd>` with a whitelisted argument list,
//     never caller input).
//   - every section is capped (root entries, package.json keys, README
//     bytes) so a large repo cannot balloon the orchestrator's context;
//     deeper inspection and all changes belong to the workers (send_input).
const MAX_ROOT_ENTRIES = 100;
const MAX_PACKAGE_KEYS = 50;
const MAX_README_CHARS = 8 * 1024;

// Top-level (depth 1) names only -- never file contents.
async function rootListing(cwd) {
  try {
    const entries = await readdir(cwd, { withFileTypes: true });
    const dirs = [];
    const files = [];
    for (const e of entries) {
      if (e.isDirectory()) dirs.push(e.name);
      else if (e.isFile()) files.push(e.name);
    }
    dirs.sort();
    files.sort();
    const truncated = dirs.length + files.length > MAX_ROOT_ENTRIES;
    return {
      dirs: dirs.slice(0, MAX_ROOT_ENTRIES),
      files: files.slice(0, Math.max(MAX_ROOT_ENTRIES - dirs.length, 0)),
      truncated,
    };
  } catch {
    return null;
  }
}

const README_VARIANTS = ['README.md', 'README', 'README.txt', 'README.rst', 'README.markdown'];

// First found README variant, capped at MAX_README_CHARS (~100 lines).
async function readmePreview(cwd) {
  for (const name of README_VARIANTS) {
    try {
      if (!(await stat(join(cwd, name))).isFile()) continue;
      const text = await readFile(join(cwd, name), 'utf-8');
      const truncated = text.length > MAX_README_CHARS;
      return {
        file: name,
        text: truncated ? text.slice(0, MAX_README_CHARS) : text,
        truncated,
      };
    } catch {
      // try the next variant
    }
  }
  return null;
}

// Keys only -- never values -- so dependency/script names stay visible
// without hauling versions or command strings into the orchestrator context.
async function packageJsonSummary(cwd) {
  try {
    const pkg = JSON.parse(await readFile(join(cwd, 'package.json'), 'utf-8'));
    const keyList = (obj) => (
      obj && typeof obj === 'object' && !Array.isArray(obj)
        ? Object.keys(obj).slice(0, MAX_PACKAGE_KEYS)
        : []
    );
    return {
      name: typeof pkg.name === 'string' ? pkg.name : null,
      version: typeof pkg.version === 'string' ? pkg.version : null,
      description: typeof pkg.description === 'string' ? pkg.description : null,
      scripts: keyList(pkg.scripts),
      dependencies: keyList(pkg.dependencies),
      devDependencies: keyList(pkg.devDependencies),
    };
  } catch {
    return null;
  }
}

const gitExec = promisify(execFile);

async function gitRun(cwd, args) {
  try {
    const { stdout } = await gitExec('git', ['-C', cwd, ...args], { encoding: 'utf-8', timeout: 10000 });
    return stdout.trim();
  } catch {
    return null;
  }
}

async function gitState(cwd) {
  const branch = await gitRun(cwd, ['branch', '--show-current']);
  const head = await gitRun(cwd, ['rev-parse', '--short', 'HEAD']);
  if (head == null) return null; // not a repository (or no git at all)
  const log = await gitRun(cwd, ['log', '--oneline', '-5']);
  const status = await gitRun(cwd, ['status', '--porcelain']);
  return {
    branch: branch || null,
    head,
    log: log ? log.split('\n').filter(Boolean) : [],
    changes: status ? status.split('\n').filter(Boolean).length : 0,
  };
}

export async function repoInfo(deps) {
  const group = deps.groupManager.getGroup(deps.groupId);
  if (!group) {
    return { error: 'group-not-found', message: 'group not found' };
  }
  const cwd = group.cwd;
  return {
    cwd,
    root: await rootListing(cwd),
    readme: await readmePreview(cwd),
    packageJson: await packageJsonSummary(cwd),
    git: await gitState(cwd),
  };
}
