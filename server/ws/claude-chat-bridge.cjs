'use strict';
// The Claude Code chat bridge: runs INSIDE the session's sandbox (or on the
// host for an unsandboxed launch) as the pty's child, in place of the
// Claude Code TUI. The counterpart of opencode-chat-bridge.cjs, with the
// same contract towards ccserver:
//
//   node claude-chat-bridge.cjs --sock <path> --password-file <path>
//        [--resume-last | --resume <id>] -- <claude> [args...]
//
// Claude Code has no server of its own: the claude-chat-adapter package
// (git.tomadoi.com/4sterisk/claude-chat-adapter) runs it in stream-json mode and serves the
// conversation as an opencode v2 session. This file only does ccserver's
// part around it: the password (read from a file, then deleted -- on the
// qemu backend argv/env are part of the host-side ssh command line), the
// unix socket ccserver reaches through a bind mount or an ssh -L forward,
// and the startup stage markers (chatStages.js, stage "agent").
//
// It is never run from here: sandbox code bundles it with the adapter into
// one file (claudeChat.js), since a sandbox or VM gets a single file.

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { startClaudeChat, createRequestHandler } = require('claude-chat-adapter');

function stageMarker(id, state, message) {
  const msg = message ? `;${String(message).replace(/[\x00-\x1f\x7f;]/g, ' ').slice(0, 300)}` : '';
  return `\x1b]777;ccserver-stage;${id};${state}${msg}\x07`;
}

function log(line) {
  process.stdout.write(`[chat-bridge] ${line}\r\n`);
}

function parseArgs(argv) {
  const opts = { sock: null, passwordFile: null, resumeLast: false, resumeId: null, command: null };
  let i = 0;
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { i++; break; }
    if (a === '--sock') opts.sock = argv[++i];
    else if (a === '--password-file') opts.passwordFile = argv[++i];
    else if (a === '--resume-last') opts.resumeLast = true;
    else if (a === '--resume') opts.resumeId = argv[++i];
    else throw new Error(`unknown option ${a}`);
  }
  opts.command = argv.slice(i);
  if (!opts.sock || !opts.passwordFile || opts.command.length === 0) {
    throw new Error('usage: claude-chat-bridge.cjs --sock <path> --password-file <path> [--resume-last | --resume <id>] -- <command...>');
  }
  return opts;
}

let chat = null;
let server = null;
let sockPath = null;
let exiting = false;

function shutdown(code) {
  if (exiting) return;
  exiting = true;
  if (server) { try { server.close(); } catch { /* already closed */ } }
  if (sockPath) { try { fs.unlinkSync(sockPath); } catch { /* gone */ } }
  const child = chat?.child;
  if (child && child.exitCode === null && child.signalCode === null) {
    // stream-json mode ends on stdin EOF; give it a moment, then make sure.
    try { child.stdin.end(); } catch { /* closed */ }
    setTimeout(() => { try { child.kill('SIGTERM'); } catch { /* gone */ } }, 3000).unref();
    child.once('exit', () => process.exit(code));
    setTimeout(() => process.exit(code), 6000).unref();
    return;
  }
  process.exit(code);
}

function fail(message) {
  process.stdout.write(stageMarker('agent', 'error', message));
  log(message);
  shutdown(1);
}

// ccserver authenticates as opencode's Basic auth (user "opencode").
function authorizer(password) {
  const expected = Buffer.from(`Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`);
  return (req) => {
    const got = Buffer.from(String(req.headers.authorization || ''));
    return got.length === expected.length && crypto.timingSafeEqual(got, expected);
  };
}

function listen(handler) {
  try { fs.unlinkSync(sockPath); } catch { /* not there */ }
  fs.mkdirSync(path.dirname(sockPath), { recursive: true, mode: 0o700 });
  server = http.createServer(handler);
  server.on('error', (e) => fail(`relay socket: ${e.message}`));
  // 0600 from the start: the umask covers the window before chmod.
  const prevMask = process.umask(0o177);
  server.listen(sockPath, () => {
    process.umask(prevMask);
    try { fs.chmodSync(sockPath, 0o600); } catch { /* best effort */ }
    log(`Claude Code is ready (session ${chat.session.sessionID}${chat.session.resumed ? ', resumed' : ''}), served at ${sockPath}`);
    process.stdout.write(stageMarker('agent', 'done'));
  });
}

function main() {
  let opts;
  try { opts = parseArgs(process.argv.slice(2)); } catch (e) { fail(e.message); return; }
  sockPath = opts.sock;
  // sun_path is 108 bytes on Linux; libuv would silently truncate a longer
  // path (and bind someone else's name).
  if (Buffer.byteLength(sockPath) > 103) { fail(`relay socket path is too long: ${sockPath}`); return; }
  let password;
  try {
    password = fs.readFileSync(opts.passwordFile, 'utf-8').trim();
  } catch (e) {
    fail(`cannot read the server password: ${e.message}`);
    return;
  }
  if (!password) { fail('the server password file is empty'); return; }
  try { fs.unlinkSync(opts.passwordFile); } catch { /* read-only */ }

  process.stdout.write(stageMarker('agent', 'running'));
  const [command, ...args] = opts.command;
  log(`starting ${path.basename(command)} ${args.join(' ')} (stream-json)`);
  // The last thing Claude Code said: almost always why it did not come up
  // (not logged in, a broken settings file, ...).
  let lastLine = '';
  try {
    chat = startClaudeChat({
      command,
      args,
      cwd: process.cwd(),
      env: process.env,
      sessionId: opts.resumeId || undefined,
      resumeLatest: opts.resumeLast,
      onLog: (line) => {
        lastLine = line.trim() || lastLine;
        process.stdout.write(`${line}\r\n`);
      },
    });
  } catch (e) {
    fail(`cannot start claude: ${e.message}`);
    return;
  }
  chat.ready.then(
    () => listen(createRequestHandler(chat.session, { authorize: authorizer(password) })),
    (err) => fail(`${err.message}${lastLine ? `: ${lastLine}` : ''}`),
  );
  chat.exited.then(({ code, signal }) => {
    if (exiting) return;
    log(`claude exited (${signal || code})`);
    shutdown(code ?? 1);
  });
}

for (const sig of ['SIGTERM', 'SIGHUP', 'SIGINT']) {
  process.on(sig, () => shutdown(sig === 'SIGINT' ? 130 : 129));
}

main();
