// macOS Seatbelt backend (sandbox-exec): REAL execution tests.
//
// Unlike sandbox-seatbelt.test.js (pure profile-string assembly, runs on Linux
// CI too), every test here spawns the real `/usr/bin/sandbox-exec -f <profile>
// /usr/bin/env ... <cmd>` and is therefore darwin-only. On any other platform
// -- or when sandbox-exec is missing -- all exec cases skip (the single
// cwd=/ fail-closed case at the bottom runs everywhere, it never spawns).
//
// Isolated via CCSERVER_SANDBOX_SEATBELT_TMP: every launch dir lands under a
// temp root removed in after(). Each case builds its own project cwd (+ fake
// HOME where needed) so parallel CI runs never share state.
//
// Debugging failures on CI: the failure messages include the profile path,
// exit status/signal, stdout and stderr. Failing profiles are copied to
// <tmpRoot>/failures/ and the temp root is preserved (see after()), and the
// workflow uploads it as an artifact, so the exact SBPL text is available
// post-run.
//
// NOTE: nested sandbox-exec is not permitted by Seatbelt: when this file runs
// from inside an already-sandboxed shell (e.g. a ccserver sandbox session --
// even `(allow default)` then fails with `sandbox_apply: Operation not
// permitted`), every exec case skips with an explanation instead of failing.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { buildSeatbeltLaunch, seatbeltEnvArgs } from './sandbox-seatbelt.js';
import { SANDBOX_PATH, buildSandboxSpawn } from './sandbox.js';

const HOME = homedir();
const SANDBOX_EXEC = '/usr/bin/sandbox-exec';
const SHOULD_SKIP = process.platform !== 'darwin' || !existsSync(SANDBOX_EXEC);
const SKIP_OPTS = SHOULD_SKIP
  ? { skip: 'requires macOS with /usr/bin/sandbox-exec' }
  : {};

let tmpRoot;
let prevSeatbeltTmp;
// Set in before() when even `(allow default)` cannot be applied (nested
// sandbox): every exec case then skips via checkRunnable(t).
let nestedReason = null;
// Set by the assert helpers on any failure: after() then preserves tmpRoot
// (with failing profiles under failures/) for the CI artifact upload.
let hadFailure = false;

function baselineApplies() {
  try {
    const probe = join(tmpRoot, 'baseline.sb');
    writeFileSync(probe, '(version 1)\n(allow default)\n');
    const res = spawnSync(SANDBOX_EXEC, ['-f', probe, '/bin/echo', 'ok'], { encoding: 'utf-8', timeout: 15000 });
    return res.status === 0 && (res.signal ?? null) === null;
  } catch {
    return false;
  }
}

before(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'ccserver-sbexec-test-'));
  prevSeatbeltTmp = process.env.CCSERVER_SANDBOX_SEATBELT_TMP;
  process.env.CCSERVER_SANDBOX_SEATBELT_TMP = join(tmpRoot, 'seatbelt');
  if (!SHOULD_SKIP && !baselineApplies()) {
    nestedReason = 'sandbox-exec cannot apply profiles in this shell (nested sandbox? sandbox_apply EPERM) -- skipping exec cases';
  }
});

const DIRS = [];
function trackDir(d) {
  DIRS.push(d);
  return d;
}

after(() => {
  for (const d of DIRS) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  if (prevSeatbeltTmp === undefined) delete process.env.CCSERVER_SANDBOX_SEATBELT_TMP;
  else process.env.CCSERVER_SANDBOX_SEATBELT_TMP = prevSeatbeltTmp;
  if (hadFailure) {
    console.log(`[sbexec] failures preserved under ${tmpRoot} (failing profiles in failures/)`);
    return;
  }
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

function checkRunnable(t) {
  if (nestedReason) {
    t.skip(nestedReason);
    return false;
  }
  return true;
}

function baseOpts(over = {}) {
  const cwd = trackDir(mkdtempSync(join(tmpdir(), 'ccserver-sbexec-cwd-')));
  return {
    cwd,
    hostHome: HOME,
    homeDir: null,
    sandboxPathBase: SANDBOX_PATH,
    nodeBin: realpathSync(process.execPath),
    scripts: {
      ghWrapper: join(import.meta.dirname, 'sandbox-gh-wrapper.cjs'),
      credHelper: join(import.meta.dirname, 'sandbox-git-credential-helper.cjs'),
      sshWrapper: join(import.meta.dirname, 'sandbox-ssh-wrapper.cjs'),
      commitHook: join(import.meta.dirname, 'sandbox-commit-msg-hook.cjs'),
      entrypoint: join(import.meta.dirname, 'sandbox-entrypoint.sh'),
      mcpBridge: join(import.meta.dirname, 'sandbox-mcp-wrapper.cjs'),
    },
    ssh: { realSsh: null, configFile: '/nonexistent-ssh-config', knownHostsDefault: '/nonexistent-known-hosts', userKnownHosts: null },
    gitBroker: null,
    commitGuard: null,
    sockets: {},
    extraBinds: [],
    extraEnv: {},
    authSock: null,
    claudeDir: null,
    orchestratorClaudeMdSrc: null,
    gitCommonDir: null,
    groupFilesDir: null,
    tools: null,
    ...over,
  };
}

// Spawn argv inside the seatbelt profile. Mirrors sandbox.js's darwin branch:
// sandbox-exec -f <profile> /usr/bin/env K=V ... <cmd>. Array-form spawn, so
// values with spaces are passed literally (no shell).
function runInSeatbelt(sb, argv, { cwd = null, timeout = 15000 } = {}) {
  return spawnSync(
    SANDBOX_EXEC,
    ['-f', sb.profilePath, '/usr/bin/env', ...seatbeltEnvArgs(sb.env), ...argv],
    { cwd: cwd || sb.cwd || undefined, encoding: 'utf-8', timeout },
  );
}

function fmtResult(res) {
  return JSON.stringify({
    status: res.status,
    signal: res.signal ?? null,
    error: res.error ? String(res.error) : null,
    stdout: (res.stdout || '').slice(0, 2000),
    stderr: (res.stderr || '').slice(0, 2000),
  });
}

// Allow-path assertion: must exit 0 with no signal. An abort (exit 134 /
// SIGABRT -- the "startup kill" shape from
// docs/seatbelt-root-read-abort-diagnosis.md) fails here with the profile path
// attached so CI artifacts can be correlated.
function preserveProfile(sb, label) {
  hadFailure = true;
  try {
    const dir = join(tmpRoot, 'failures');
    mkdirSync(dir, { recursive: true });
    copyFileSync(sb.profilePath, join(dir, `${String(label).replace(/[^A-Za-z0-9]+/g, '_').slice(0, 80)}.sb`));
  } catch { /* best effort */ }
}

function assertAllowed(res, sb, label) {
  try {
    assert.equal(res.error ?? null, null, `${label}: spawn error: ${res.error} [profile ${sb.profilePath}]`);
    assert.equal(res.signal ?? null, null, `${label}: killed by signal (abort shape?) ${fmtResult(res)} [profile ${sb.profilePath}]`);
    assert.equal(res.status, 0, `${label}: expected exit 0, got ${fmtResult(res)} [profile ${sb.profilePath}]`);
  } catch (err) {
    preserveProfile(sb, label);
    throw err;
  }
}

// Deny-path assertion: anything but a clean exit 0. Covers EPERM exits (1),
// exec denies (71) and aborts (134) -- all are "not allowed".
function assertDenied(res, sb, label) {
  try {
    if (res.error && String(res.error).includes('ETIMEDOUT')) {
      assert.fail(`${label}: timed out (neither allowed nor denied?) ${fmtResult(res)} [profile ${sb.profilePath}]`);
    }
    const denied = (res.signal ?? null) !== null || res.status !== 0;
    assert.ok(denied, `${label}: expected non-zero exit/signal, got ${fmtResult(res)} [profile ${sb.profilePath}]`);
  } catch (err) {
    preserveProfile(sb, label);
    throw err;
  }
}

test('smoke: profile compiles and /bin/echo runs', SKIP_OPTS, (t) => {
  if (!checkRunnable(t)) return;
  const opts = baseOpts();
  const sb = buildSeatbeltLaunch(opts);
  trackDir(sb.dir);
  sb.cwd = opts.cwd;
  const res = runInSeatbelt(sb, ['/bin/echo', 'hello-seatbelt'], { cwd: opts.cwd });
  assertAllowed(res, sb, 'echo');
  assert.match(res.stdout.trim(), /^hello-seatbelt$/);
});

test('smoke via entrypoint: bash + entrypoint + echo', SKIP_OPTS, (t) => {
  if (!checkRunnable(t)) return;
  // Closest shape to the real launch (sandbox.js darwin branch) short of a
  // pty: MACOS_BASH ENTRYPOINT <cmd>. Exercises the entrypoint's
  // XDG_RUNTIME_DIR mkdir -p plus the entrypoint's own read allow.
  const opts = baseOpts();
  const sb = buildSeatbeltLaunch(opts);
  trackDir(sb.dir);
  sb.cwd = opts.cwd;
  const res = runInSeatbelt(
    sb,
    ['/bin/bash', opts.scripts?.entrypoint ?? join(import.meta.dirname, 'sandbox-entrypoint.sh'), '/bin/echo', 'via-entrypoint'],
    { cwd: opts.cwd },
  );
  assertAllowed(res, sb, 'entrypoint echo');
  assert.ok(res.stdout.includes('via-entrypoint'), `unexpected output: ${fmtResult(res)}`);
});

test('root literal: /bin/ls / starts (no startup abort)', SKIP_OPTS, (t) => {
  if (!checkRunnable(t)) return;
  // Regression for docs/seatbelt-root-read-abort-diagnosis.md: without
  // `(allow file-read* (literal "/"))` every child dies at startup (abort).
  const opts = baseOpts();
  const sb = buildSeatbeltLaunch(opts);
  trackDir(sb.dir);
  sb.cwd = opts.cwd;
  const res = runInSeatbelt(sb, ['/bin/ls', '/'], { cwd: opts.cwd });
  assertAllowed(res, sb, 'ls /');
});

test('project file is readable', SKIP_OPTS, (t) => {
  if (!checkRunnable(t)) return;
  const opts = baseOpts();
  const probe = join(opts.cwd, 'hello.txt');
  writeFileSync(probe, 'seatbelt-read-ok\n');
  const sb = buildSeatbeltLaunch(opts);
  trackDir(sb.dir);
  sb.cwd = opts.cwd;
  const res = runInSeatbelt(sb, ['/bin/cat', probe], { cwd: opts.cwd });
  assertAllowed(res, sb, 'cat project file');
  assert.ok(res.stdout.includes('seatbelt-read-ok'), `unexpected output: ${fmtResult(res)}`);
});

test('node realpathSync works (ancestor lstat regression)', SKIP_OPTS, (t) => {
  if (!checkRunnable(t)) return;
  // Without ancestorExactRegexes, userspace realpath dies with EPERM lstat
  // '/Volumes' / '/Users' / '/private' (verified on hardware).
  const opts = baseOpts();
  writeFileSync(join(opts.cwd, 'package.json'), '{"name":"x"}\n');
  const sb = buildSeatbeltLaunch(opts);
  trackDir(sb.dir);
  sb.cwd = opts.cwd;
  const res = runInSeatbelt(
    sb,
    [sb.nodeBin, '-e', "const fs=require('fs');console.log(fs.realpathSync('package.json'))"],
    { cwd: opts.cwd },
  );
  assertAllowed(res, sb, 'node realpathSync');
  assert.ok(res.stdout.includes('package.json'), `unexpected output: ${fmtResult(res)}`);
});

test('project dir is writable', SKIP_OPTS, (t) => {
  if (!checkRunnable(t)) return;
  const opts = baseOpts();
  const sb = buildSeatbeltLaunch(opts);
  trackDir(sb.dir);
  sb.cwd = opts.cwd;
  const target = join(opts.cwd, 'from-sandbox.txt');
  const res = runInSeatbelt(sb, ['/bin/sh', '-c', 'echo written-by-sandbox > "$1"', 'sh', target], { cwd: opts.cwd });
  assertAllowed(res, sb, 'write project file');
  assert.equal(readFileSync(target, 'utf-8'), 'written-by-sandbox\n');
});

test('throwaway HOME and /tmp are writable', SKIP_OPTS, (t) => {
  if (!checkRunnable(t)) return;
  const opts = baseOpts();
  const sb = buildSeatbeltLaunch(opts);
  trackDir(sb.dir);
  sb.cwd = opts.cwd;
  assert.ok(sb.homeDir.startsWith(`${sb.dir}/`), 'throwaway HOME expected for this case');
  for (const target of [join(sb.homeDir, 'home-write.txt'), join(tmpdir(), `ccserver-sbexec-tmp-${Date.now()}.txt`)]) {
    const res = runInSeatbelt(sb, ['/bin/sh', '-c', 'echo ok > "$1"', 'sh', target], { cwd: opts.cwd });
    try {
      assertAllowed(res, sb, `write ${target}`);
      assert.ok(existsSync(target), `${target} was not created`);
    } finally {
      try { rmSync(target, { force: true }); } catch { /* ignore */ }
    }
  }
});

test('raw keys stay denied: ~/.ssh and ~/.config/gh unreadable', SKIP_OPTS, (t) => {
  if (!checkRunnable(t)) return;
  // Fake HOME so the test never touches the runner's real keys: the deny pins
  // are built from hostHome, so secrets placed there must still be refused.
  const fakeHome = trackDir(mkdtempSync(join(tmpdir(), 'ccserver-sbexec-fakehome-')));
  mkdirSync(join(fakeHome, '.ssh'), { recursive: true });
  writeFileSync(join(fakeHome, '.ssh', 'secret.txt'), 'top-secret\n');
  mkdirSync(join(fakeHome, '.config', 'gh'), { recursive: true });
  writeFileSync(join(fakeHome, '.config', 'gh', 'hosts.yml'), 'github.com: {token: x}\n');
  const opts = baseOpts({ hostHome: fakeHome });
  const sb = buildSeatbeltLaunch(opts);
  trackDir(sb.dir);
  sb.cwd = opts.cwd;
  for (const f of [join(fakeHome, '.ssh', 'secret.txt'), join(fakeHome, '.config', 'gh', 'hosts.yml')]) {
    const res = runInSeatbelt(sb, ['/bin/cat', f], { cwd: opts.cwd });
    assertDenied(res, sb, `cat ${f}`);
  }
});

test('sibling launch dirs denied, own runtime dir allowed', SKIP_OPTS, (t) => {
  if (!checkRunnable(t)) return;
  const opts = baseOpts();
  const sb = buildSeatbeltLaunch(opts);
  trackDir(sb.dir);
  sb.cwd = opts.cwd;
  // Sibling under the same base dir: covered by the broad tmp allows, so only
  // the sibling deny pin keeps it closed (POSIX ERE has no lookahead: deny all
  // launch dirs, re-allow our own afterwards).
  const base = process.env.CCSERVER_SANDBOX_SEATBELT_TMP;
  const sibling = trackDir(mkdtempSync(join(base, 'ccserver-seatbelt-sibling-')));
  const siblingFile = join(sibling, 'secret.txt');
  writeFileSync(siblingFile, 'sibling-secret\n');
  const denied = runInSeatbelt(sb, ['/bin/cat', siblingFile], { cwd: opts.cwd });
  assertDenied(denied, sb, 'sibling read');
  // Contrast: our own runtime file stays readable/writable.
  const ownFile = join(sb.dir, 'runtime', 'own.txt');
  writeFileSync(ownFile, 'own\n');
  const allowed = runInSeatbelt(sb, ['/bin/cat', ownFile], { cwd: opts.cwd });
  assertAllowed(allowed, sb, 'own runtime read');
});

test('bin/hooks/profile are immutable despite TMPDIR write rules', SKIP_OPTS, (t) => {
  if (!checkRunnable(t)) return;
  const opts = baseOpts();
  const sb = buildSeatbeltLaunch(opts);
  trackDir(sb.dir);
  sb.cwd = opts.cwd;
  const before = readFileSync(sb.profilePath, 'utf-8');
  for (const target of [join(sb.binDir, 'gh'), sb.profilePath]) {
    const res = runInSeatbelt(sb, ['/bin/sh', '-c', 'echo pwned > "$1"', 'sh', target], { cwd: opts.cwd });
    assertDenied(res, sb, `write ${target}`);
  }
  const hookTargets = (() => {
    try {
      return readdirSync(sb.hooksDir).map((n) => join(sb.hooksDir, n));
    } catch {
      return [];
    }
  })();
  for (const target of hookTargets) {
    const res = runInSeatbelt(sb, ['/bin/sh', '-c', 'echo pwned > "$1"', 'sh', target], { cwd: opts.cwd });
    assertDenied(res, sb, `write ${target}`);
  }
  assert.equal(readFileSync(sb.profilePath, 'utf-8'), before, 'profile must be unchanged');
});

test('sandbox HOME gitconfig pinned while the broker is on', SKIP_OPTS, (t) => {
  if (!checkRunnable(t)) return;
  const homeDir = trackDir(mkdtempSync(join(tmpdir(), 'ccserver-sbexec-home-')));
  const brokerDir = trackDir(mkdtempSync(join(tmpdir(), 'ccserver-sbexec-broker-')));
  writeFileSync(join(brokerDir, 'allow.json'), '{}');
  const gitBroker = { sockPath: join(brokerDir, 'broker.sock'), allowlistPath: join(brokerDir, 'allow.json'), dir: brokerDir };
  const sb = buildSeatbeltLaunch(baseOpts({ homeDir, gitBroker }));
  trackDir(sb.dir);
  sb.cwd = sb.cwd || homeDir;
  const target = join(homeDir, '.gitconfig');
  const res = runInSeatbelt(sb, ['/bin/sh', '-c', 'echo pwned > "$1"', 'sh', target], { cwd: homeDir });
  assertDenied(res, sb, 'write HOME .gitconfig with broker');
});

test('sandbox HOME gitconfig writable without a broker (git config --global keeps working)', SKIP_OPTS, (t) => {
  if (!checkRunnable(t)) return;
  const homeDir = trackDir(mkdtempSync(join(tmpdir(), 'ccserver-sbexec-home-')));
  const opts = baseOpts({ homeDir, gitBroker: null });
  const sb = buildSeatbeltLaunch(opts);
  trackDir(sb.dir);
  sb.cwd = opts.cwd;
  const target = join(homeDir, '.gitconfig');
  const res = runInSeatbelt(sb, ['/bin/sh', '-c', 'echo ok > "$1"', 'sh', target], { cwd: opts.cwd });
  assertAllowed(res, sb, 'write HOME .gitconfig without broker');
  assert.ok(existsSync(target), '.gitconfig was not created');
});

test('macOS GUI/IPC exec pins are denied', SKIP_OPTS, (t) => {
  if (!checkRunnable(t)) return;
  const opts = baseOpts();
  const sb = buildSeatbeltLaunch(opts);
  trackDir(sb.dir);
  sb.cwd = opts.cwd;
  const candidates = [
    ['/usr/bin/osascript', ['-e', 'return 1']],
    ['/usr/bin/pbcopy', []],
    ['/usr/bin/pbpaste', []],
    ['/usr/bin/open', ['-h']],
    ['/usr/sbin/screencapture', ['-h']],
  ].filter(([bin]) => existsSync(bin));
  assert.ok(candidates.length > 0, 'expected at least one GUI/IPC binary on macOS');
  for (const [bin, args] of candidates) {
    const res = runInSeatbelt(sb, [bin, ...args], { cwd: opts.cwd });
    assertDenied(res, sb, `exec ${bin}`);
  }
});

test('env arrives via /usr/bin/env (HOME/PATH/CCSANDBOX_DOCKER)', SKIP_OPTS, (t) => {
  if (!checkRunnable(t)) return;
  const opts = baseOpts();
  const sb = buildSeatbeltLaunch(opts);
  trackDir(sb.dir);
  sb.cwd = opts.cwd;
  const res = runInSeatbelt(sb, ['/usr/bin/env'], { cwd: opts.cwd });
  assertAllowed(res, sb, 'env');
  const lines = new Set(res.stdout.split('\n'));
  assert.ok(lines.has(`HOME=${sb.homeDir}`), `HOME missing: ${fmtResult(res)}`);
  assert.ok(lines.has('CCSANDBOX_DOCKER=0'), `CCSANDBOX_DOCKER missing: ${fmtResult(res)}`);
  const pathLine = res.stdout.split('\n').find((l) => l.startsWith('PATH='));
  assert.ok(pathLine && pathLine.slice('PATH='.length).split(':')[0] === sb.binDir, `shim dir not first on PATH: ${fmtResult(res)}`);
});

test('cwd=/ is refused fail-closed (no sandbox-exec spawn)', () => {
  // Platform-independent: buildSandboxSpawn rejects the filesystem root
  // before any backend branch (subtrees('/') would grant everything).
  assert.throws(
    () => buildSandboxSpawn({ cwd: '/', targetCommand: ['/bin/echo', 'hi'] }),
    /filesystem root/,
  );
});
