#!/ccserver-sandbox-node
// Runs INSIDE the sandbox as git's gpg.program (plan: sandbox-no-secrets).
// The sandbox holds no signing key and no agent socket: to sign a commit,
// this script sends the commit object git hands it to the host over the
// git-broker socket ({op:'sign-commit'}), and the host decides whether to
// sign it (see ws/commitSignService.js for what it checks). Everything else
// -- signature verification for `git log --show-signature`, `verify-commit`
// -- runs the sandbox's own gpg against the host key's PUBLIC part
// ($CCSANDBOX_SIGNING_PUBKEY), in a throwaway GNUPGHOME.
//
// git's contract (gpg-interface.c): for signing it runs
//   <program> --status-fd=2 -bsau <key>
// with the payload on stdin, and expects the armored signature on stdout
// and "[GNUPG:] SIG_CREATED" among the status lines on stderr.
//
// Fails closed: a missing/unreachable broker or any refusal prints why and
// exits 1, so the commit is not created rather than created unsigned.
'use strict';

const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

// Longer than the host's approval timeout: a commit may wait for a human
// to unlock the signing key.
const SIGN_TIMEOUT_MS = 6 * 60 * 1000 + 10_000;

// Same token source as the other broker clients (sandbox-gh-wrapper.cjs).
function brokerToken() {
  const file = process.env.CCSANDBOX_GIT_BROKER_TOKEN_FILE;
  if (file) {
    try { return fs.readFileSync(file, 'utf-8').trim(); } catch { return ''; }
  }
  return process.env.CCSANDBOX_GIT_BROKER_TOKEN || '';
}

// Is this a signing invocation? git uses "-bsau <key>"; accept the long
// spellings too, so the decision does not hinge on one flag style.
function isSignRequest(argv) {
  let detach = false;
  let sign = false;
  for (const a of argv) {
    if (a === '--detach-sign' || a === '--sign') { detach = detach || a === '--detach-sign'; sign = true; continue; }
    if (/^-[a-zA-Z]+$/.test(a)) {
      if (a.includes('b')) detach = true;
      if (a.includes('s')) sign = true;
    }
  }
  return sign && detach && !argv.includes('--verify');
}

// --status-fd=N / --status-fd N (git passes 2).
function statusFd(argv) {
  for (let i = 0; i < argv.length; i++) {
    const m = /^--status-fd=(\d+)$/.exec(argv[i]);
    if (m) return Number(m[1]);
    if (argv[i] === '--status-fd' && /^\d+$/.test(argv[i + 1] || '')) return Number(argv[i + 1]);
  }
  return null;
}

function readStdin() {
  return new Promise((resolve) => {
    const chunks = [];
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks)));
    process.stdin.on('error', () => resolve(Buffer.concat(chunks)));
  });
}

function request(sockPath, req) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v) => { if (!settled) { settled = true; resolve(v); } };
    let sock;
    try {
      sock = net.createConnection(sockPath);
    } catch {
      finish(null);
      return;
    }
    const timer = setTimeout(() => { sock.destroy(); finish(null); }, SIGN_TIMEOUT_MS);
    let buf = '';
    // write, not end: the qemu backend's in-guest relay tears down both
    // directions on a half-close (see sandbox-git-credential-helper.cjs).
    sock.on('connect', () => sock.write(`${JSON.stringify(req)}\n`));
    sock.setEncoding('utf-8');
    sock.on('data', (c) => {
      buf += c;
      const nl = buf.indexOf('\n');
      if (nl !== -1) { clearTimeout(timer); sock.destroy(); try { finish(JSON.parse(buf.slice(0, nl))); } catch { finish(null); } }
    });
    sock.on('end', () => { clearTimeout(timer); try { finish(JSON.parse(buf)); } catch { finish(null); } });
    sock.on('error', () => { clearTimeout(timer); finish(null); });
  });
}

async function sign(argv) {
  const sockPath = process.env.CCSANDBOX_GIT_BROKER_SOCK;
  const payload = await readStdin();
  if (!sockPath) {
    process.stderr.write('ccserver: commit signing is not available in this session (no git broker)\n');
    return 1;
  }
  process.stderr.write('ccserver: asking the host to sign this commit...\n');
  const res = await request(sockPath, {
    op: 'sign-commit',
    token: brokerToken(),
    payload: payload.toString('base64'),
    dir: process.cwd(),
  });
  if (!res || !res.ok) {
    const why = !res ? 'the host signing service did not answer' : `${res.reason}${res.message ? `: ${res.message}` : ''}`;
    process.stderr.write(`ccserver: the host refused to sign this commit (${why})\n`);
    return 1;
  }
  const fd = statusFd(argv) ?? 2;
  const status = Array.isArray(res.status) ? res.status.filter((l) => typeof l === 'string' && l.startsWith('[GNUPG:] ')) : [];
  try { fs.writeSync(fd, status.map((l) => `${l}\n`).join('')); } catch { /* git reads what it can */ }
  process.stdout.write(Buffer.from(res.signature, 'base64'));
  return 0;
}

// Verification etc.: real gpg, against a throwaway keyring holding only the
// host key's public part.
function passthrough(argv) {
  const gpg = ['/usr/bin/gpg', '/bin/gpg'].find((p) => fs.existsSync(p));
  if (!gpg) {
    process.stderr.write('ccserver: gpg is not installed in this sandbox, cannot verify signatures\n');
    return 2;
  }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccs-gpgv-'));
  try {
    const pub = process.env.CCSANDBOX_SIGNING_PUBKEY;
    if (pub && fs.existsSync(pub)) {
      spawnSync(gpg, ['--homedir', home, '--batch', '--quiet', '--import', pub], { stdio: 'ignore' });
    }
    const r = spawnSync(gpg, ['--homedir', home, '--trust-model', 'always', ...argv], { stdio: 'inherit' });
    return r.status ?? 2;
  } finally {
    spawnSync('gpgconf', ['--homedir', home, '--kill', 'all'], { stdio: 'ignore' });
    fs.rmSync(home, { recursive: true, force: true });
  }
}

async function main() {
  const argv = process.argv.slice(2);
  process.exitCode = isSignRequest(argv) ? await sign(argv) : passthrough(argv);
}

if (require.main === module) main();

module.exports = { isSignRequest, statusFd };
