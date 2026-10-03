#!/ccserver-sandbox-node
'use strict';
// The opencode chat bridge: runs INSIDE the session's sandbox (or on the
// host for an unsandboxed launch) as the pty's child, in place of the
// opencode TUI.
//
//   node opencode-chat-bridge.cjs --sock <path> --password-file <path> -- <opencode> serve --stdio ...
//
//   1. starts `opencode serve --stdio` with OPENCODE_SERVER_PASSWORD read
//      from --password-file (a file, not our env/argv: on the qemu backend
//      argv/env are part of the host-side ssh command line). serve deletes
//      the variable from its own env in --stdio mode, so tools it runs never
//      see it.
//   2. reads the `{"url": ...}` line serve prints once it listens on
//      127.0.0.1:<random port>
//   3. listens on the unix socket --sock and relays every connection to
//      that port. ccserver reaches the socket through a bind mount (bwrap)
//      or an ssh -L forward (qemu), never through a TCP port of its own: the
//      sandbox's network namespace may not be the host's.
//
// serve exits when its stdin closes, so the bridge keeps that pipe open for
// its own lifetime and closes it on any exit path -- the pty going away
// (SIGHUP) takes serve with it.
//
// Progress for the chat view's startup list goes out as the stage markers
// described in chatStages.js (stage "agent").

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

function stageMarker(id, state, message) {
  const msg = message ? `;${String(message).replace(/[\x00-\x1f\x7f;]/g, ' ').slice(0, 300)}` : '';
  return `\x1b]777;ccserver-stage;${id};${state}${msg}\x07`;
}

function log(line) {
  process.stdout.write(`[chat-bridge] ${line}\r\n`);
}

function parseArgs(argv) {
  const opts = { sock: null, passwordFile: null, command: null };
  let i = 0;
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { i++; break; }
    if (a === '--sock') opts.sock = argv[++i];
    else if (a === '--password-file') opts.passwordFile = argv[++i];
    else throw new Error(`unknown option ${a}`);
  }
  opts.command = argv.slice(i);
  if (!opts.sock || !opts.passwordFile || opts.command.length === 0) {
    throw new Error('usage: opencode-chat-bridge.cjs --sock <path> --password-file <path> -- <command...>');
  }
  return opts;
}

let child = null;
let server = null;
let sockPath = null;
let exiting = false;

function shutdown(code) {
  if (exiting) return;
  exiting = true;
  if (server) { try { server.close(); } catch { /* already closed */ } }
  if (sockPath) { try { fs.unlinkSync(sockPath); } catch { /* gone */ } }
  if (child && child.exitCode === null && child.signalCode === null) {
    try { child.stdin.end(); } catch { /* closed */ }
    // serve stops on stdin EOF; give it a moment, then make sure.
    const t = setTimeout(() => { try { child.kill('SIGTERM'); } catch { /* gone */ } }, 3000);
    t.unref();
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

function listen(port) {
  try { fs.unlinkSync(sockPath); } catch { /* not there */ }
  fs.mkdirSync(path.dirname(sockPath), { recursive: true, mode: 0o700 });
  server = net.createServer((client) => {
    const upstream = net.connect(port, '127.0.0.1');
    client.pipe(upstream);
    upstream.pipe(client);
    const close = () => { client.destroy(); upstream.destroy(); };
    client.on('error', close);
    upstream.on('error', close);
    client.on('close', () => upstream.end());
    upstream.on('close', () => client.end());
  });
  server.on('error', (e) => fail(`relay socket: ${e.message}`));
  // 0600 from the start: the umask covers the window before chmod.
  const prevMask = process.umask(0o177);
  server.listen(sockPath, () => {
    process.umask(prevMask);
    try { fs.chmodSync(sockPath, 0o600); } catch { /* best effort */ }
    log(`opencode serve is up on 127.0.0.1:${port}, relayed at ${sockPath}`);
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
  // Nothing else in the sandbox needs it (a read-only share on the qemu
  // backend just keeps it).
  try { fs.unlinkSync(opts.passwordFile); } catch { /* read-only */ }

  process.stdout.write(stageMarker('agent', 'running'));
  startServe(opts.command, password, 1);
}

// opencode opens its database (~/.local/share/opencode) before it sets a
// busy timeout, so a second serve starting while another one on the same
// HOME holds the lock -- two chat sessions of one project, typically both
// started the moment a persistent VM finishes booting -- exits at once with
// "database is locked". That one is retried; any other early exit fails.
const LOCKED_RETRIES = 5;
const LOCKED_RE = /database is locked/i;

function startServe(command, password, attempt) {
  log(`starting ${path.basename(command[0])} ${command.slice(1).join(' ')}`);
  child = spawn(command[0], command.slice(1), {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, OPENCODE_SERVER_PASSWORD: password },
  });
  const proc = child;
  proc.on('error', (e) => fail(`cannot start opencode: ${e.message}`));

  let buf = '';
  let ready = false;
  proc.stdout.setEncoding('utf-8');
  proc.stdout.on('data', (chunk) => {
    if (ready) { process.stdout.write(chunk.replace(/\r?\n/g, '\r\n')); return; }
    buf += chunk;
    let nl;
    while (!ready && (nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      let url = null;
      try { url = JSON.parse(line).url; } catch { /* not the handshake line */ }
      if (typeof url !== 'string') {
        if (line) process.stdout.write(`${line}\r\n`);
        continue;
      }
      const port = Number(new URL(url).port);
      if (!Number.isInteger(port) || port <= 0) { fail(`unexpected server url ${url}`); return; }
      ready = true;
      listen(port);
    }
    if (ready && buf) { process.stdout.write(buf.replace(/\r?\n/g, '\r\n')); buf = ''; }
  });
  // The last thing serve said on stderr: almost always why it did not come
  // up (no provider configured, a broken config file, ...).
  let lastErrLine = '';
  let locked = false;
  proc.stderr.setEncoding('utf-8');
  proc.stderr.on('data', (chunk) => {
    process.stdout.write(chunk.replace(/\r?\n/g, '\r\n'));
    if (LOCKED_RE.test(chunk)) locked = true;
    const lines = chunk.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (lines.length) lastErrLine = lines[lines.length - 1];
  });
  proc.on('exit', (code, sig) => {
    if (exiting) return;
    if (!ready && locked && attempt < LOCKED_RETRIES) {
      const delay = 1000 * attempt + Math.floor(Math.random() * 1000);
      log(`opencode's database is locked by another session; retrying in ${(delay / 1000).toFixed(1)}s (${attempt}/${LOCKED_RETRIES - 1})`);
      setTimeout(() => { if (!exiting) startServe(command, password, attempt + 1); }, delay);
      return;
    }
    const why = `opencode serve exited (${sig || code})${!ready && lastErrLine ? `: ${lastErrLine}` : ''}`;
    if (!ready) { fail(why); return; }
    log(why);
    shutdown(code ?? 1);
  });
}

for (const sig of ['SIGTERM', 'SIGHUP', 'SIGINT']) {
  process.on(sig, () => shutdown(sig === 'SIGINT' ? 130 : 129));
}

main();
