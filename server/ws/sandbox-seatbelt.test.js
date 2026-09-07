// macOS Seatbelt backend (sandbox-exec): profile generation, per-launch shim
// layout, and env assembly. All pure assembly -- no sandbox-exec/pty runs --
// and platform-independent, so this runs on Linux CI too (buildSeatbeltLaunch
// itself never checks process.platform; only buildSandboxSpawn branches on
// it). The one exception is the final Linux-only backend-text test, which
// carries an explicit skip guard (it would fail on macOS by design).
//
// Isolated via CCSERVER_SANDBOX_SEATBELT_TMP: every launch dir lands under a
// temp root removed in after().

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import {
  buildSeatbeltLaunch,
  buildSeatbeltProfileText,
  escapeSeatbeltLiteral,
  escapeSeatbeltRegex,
  pathVariants,
  seatbeltEnvArgs,
  subtreeRegex,
  subtrees,
} from './sandbox-seatbelt.js';
import { forceSandboxUnavailableReason, sandboxBackend, sandboxUnavailableReason } from './sandbox.js';

const HOME = homedir();

let tmpRoot;
let prevSeatbeltTmp;

before(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'ccserver-seatbelt-test-'));
  prevSeatbeltTmp = process.env.CCSERVER_SANDBOX_SEATBELT_TMP;
  process.env.CCSERVER_SANDBOX_SEATBELT_TMP = join(tmpRoot, 'seatbelt');
});

after(() => {
  if (prevSeatbeltTmp === undefined) delete process.env.CCSERVER_SANDBOX_SEATBELT_TMP;
  else process.env.CCSERVER_SANDBOX_SEATBELT_TMP = prevSeatbeltTmp;
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
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
});

function baseOpts(over = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'ccserver-seatbelt-cwd-'));
  DIRS.push(cwd);
  return {
    cwd,
    hostHome: HOME,
    homeDir: null,
    sandboxPathBase: `${HOME}/.local/bin:/usr/local/bin:/usr/bin:/bin`,
    nodeBin: process.execPath,
    serverDir: import.meta.dirname,
    scripts: {
      ghWrapper: join(import.meta.dirname, 'sandbox-gh-wrapper.cjs'),
      credHelper: join(import.meta.dirname, 'sandbox-git-credential-helper.cjs'),
      sshWrapper: join(import.meta.dirname, 'sandbox-ssh-wrapper.cjs'),
      commitHook: join(import.meta.dirname, 'sandbox-commit-msg-hook.cjs'),
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

test('escapeSeatbeltRegex quotes regex metacharacters but keeps slashes', () => {
  assert.equal(escapeSeatbeltRegex('/Users/oli/a+b (x)/y.md'), '/Users/oli/a\\+b\\ \\(x\\)/y\\.md');
});

test('escapeSeatbeltLiteral escapes only SBPL string metacharacters', () => {
  assert.equal(escapeSeatbeltLiteral('/tmp/a"b\\c'), '/tmp/a\\"b\\\\c');
  assert.equal(escapeSeatbeltLiteral('/tmp/plain.sock'), '/tmp/plain.sock');
});

test('buildSeatbeltProfileText escapes literals pasted into the profile', () => {
  const text = buildSeatbeltProfileText({ readLiterals: ['/tmp/we"ird.sock'] });
  assert.ok(text.includes('(literal "/tmp/we\\"ird.sock")'));
});

test('subtreeRegex matches the dir itself and everything below', () => {
  assert.equal(subtreeRegex('/srv/proj'), '^/srv/proj(/.*)?$');
});

test('buildSeatbeltProfileText is deny-by-default with open egress', () => {
  const text = buildSeatbeltProfileText({
    readRegexes: ['^/usr(/.*)?$'],
    writeRegexes: ['^/srv/proj(/.*)?$'],
    denyWriteRegexes: ['^/home/u/.ssh(/.*)?$'],
  });
  assert.ok(text.includes('(version 1)'));
  assert.ok(text.includes('(deny default)'));
  assert.ok(text.includes('(allow network*)'));
  assert.ok(text.includes('(allow process-exec process-fork)'));
  assert.ok(text.includes('(allow file-read* (regex #"^/usr(/.*)?$")'));
  assert.ok(text.includes('(allow file-write* (regex #"^/srv/proj(/.*)?$")'));
  assert.ok(text.includes('(deny file-write* (regex #"^/home/u/.ssh(/.*)?$")'));
});

test('buildSeatbeltLaunch creates profile+bin+hooks and a throwaway HOME', () => {
  const sb = buildSeatbeltLaunch(baseOpts());
  trackDir(sb.dir);
  assert.ok(existsSync(sb.profilePath), 'profile file exists');
  assert.ok(existsSync(sb.binDir), 'shim bin dir exists');
  assert.ok(existsSync(sb.hooksDir), 'hooks dir exists');
  assert.ok(sb.homeDir.startsWith(`${sb.dir}/`), 'throwaway HOME lives inside the teardown dir');
  assert.equal(sb.env.HOME, sb.homeDir);
  assert.equal(sb.env.CCSANDBOX_DOCKER, '0');
  assert.ok(sb.env.PATH.startsWith(`${sb.binDir}:`), 'shim dir is first on PATH');

  const text = readFileSync(sb.profilePath, 'utf-8');
  assert.ok(text.includes(subtreeRegex(sb.homeDir)), 'HOME is writable');
  assert.ok(text.includes(subtreeRegex(join(HOME, '.ssh'))), 'raw ssh keys are denied');
  assert.ok(text.includes(subtreeRegex(join(HOME, '.config', 'gh'))), 'gh config is denied');
  // opencode state dirs stay writable so launches don't error (see plan notes).
  assert.ok(text.includes(subtreeRegex(join(HOME, '.local', 'share', 'opencode'))));
  assert.ok(text.includes(subtreeRegex(join(HOME, '.codex'))));
});

test('agent config dirs and Caches are readable as well as writable (file-write* does not imply file-read*)', () => {
  // Seatbelt file-write* does not imply file-read*: a write-only entry would
  // leave CLIs unable to read back the auth/state they just wrote.
  const sb = buildSeatbeltLaunch(baseOpts());
  trackDir(sb.dir);
  const text = readFileSync(sb.profilePath, 'utf-8');
  const readLine = text.split('\n').find((l) => l.startsWith('  (allow file-read*'));
  assert.ok(readLine, 'profile has a file-read rule');
  for (const p of [
    join(HOME, '.claude'), join(HOME, '.config', 'opencode'),
    join(HOME, '.local', 'state', 'opencode'), join(HOME, '.codex'),
    join(HOME, '.commandcode'), join(HOME, 'Library', 'Caches'),
  ]) {
    assert.ok(readLine.includes(subtreeRegex(p)), `${p} is readable`);
  }
});

test('buildSeatbeltLaunch honors an explicit persistent homeDir', () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'ccserver-seatbelt-home-'));
  DIRS.push(homeDir);
  const sb = buildSeatbeltLaunch(baseOpts({ homeDir }));
  trackDir(sb.dir);
  assert.equal(sb.homeDir, homeDir);
  assert.equal(sb.env.HOME, homeDir);
});

test('buildSeatbeltLaunch wires gitBroker shims and merges GIT_CONFIG_COUNT', () => {
  const brokerDir = mkdtempSync(join(tmpdir(), 'ccserver-seatbelt-broker-'));
  DIRS.push(brokerDir);
  const sb = buildSeatbeltLaunch(baseOpts({
    gitBroker: { sockPath: join(brokerDir, 'broker.sock'), allowlistPath: join(brokerDir, 'allow.json'), dir: brokerDir },
    commitGuard: { configPath: join(brokerDir, 'guard.json') },
    ssh: { realSsh: '/usr/bin/ssh', configFile: '/nonexistent-ssh-config', knownHostsDefault: '/nonexistent-known-hosts', userKnownHosts: null },
    sockets: { notify: join(brokerDir, 'notify.sock') },
  }));
  trackDir(sb.dir);
  for (const name of ['gh', 'ccserver-git-ssh', 'ccserver-git-credential-helper']) {
    const p = join(sb.binDir, name);
    assert.ok(existsSync(p), `${name} shim exists`);
    assert.ok(statSync(p).mode & 0o111, `${name} shim is executable`);
    assert.ok(readFileSync(p, 'utf-8').includes(process.execPath), `${name} shim execs the host node`);
  }
  const hook = join(sb.hooksDir, 'commit-msg');
  assert.ok(existsSync(hook), 'commit-msg hook shim exists');
  assert.equal(sb.env.GIT_CONFIG_COUNT, '2');
  assert.equal(sb.env.GIT_CONFIG_KEY_0, 'credential.helper');
  assert.equal(sb.env.GIT_CONFIG_KEY_1, 'core.hooksPath');
  assert.equal(sb.env.GIT_CONFIG_VALUE_1, sb.hooksDir);
  assert.equal(sb.env.GIT_SSH_COMMAND, join(sb.binDir, 'ccserver-git-ssh'));
  assert.equal(sb.env.CCSANDBOX_MCP_SOCK, undefined);
  assert.ok(sb.env.PATH.includes(sb.binDir));

  const text = readFileSync(sb.profilePath, 'utf-8');
  assert.ok(text.includes(`(literal "${join(brokerDir, 'broker.sock')}")`), 'broker socket is reachable');
  assert.ok(text.includes(`(literal "${join(brokerDir, 'notify.sock')}")`), 'notify socket is reachable');
});

test('buildSeatbeltLaunch sets CCSANDBOX_MCP_SOCK for group sessions', () => {
  const sb = buildSeatbeltLaunch(baseOpts({ sockets: { mcp: '/tmp/ccserver-mcp.sock' } }));
  trackDir(sb.dir);
  assert.equal(sb.env.CCSANDBOX_MCP_SOCK, '/tmp/ccserver-mcp.sock');
});

test('buildSeatbeltLaunch denies CLAUDE.md/AGENTS.md writes for orchestrators', () => {
  const opts = baseOpts();
  const sb = buildSeatbeltLaunch(baseOpts({
    cwd: opts.cwd,
    orchestratorClaudeMdSrc: join(tmpRoot, 'orchestrator.md'),
  }));
  trackDir(sb.dir);
  const text = readFileSync(sb.profilePath, 'utf-8');
  assert.ok(text.includes(`^${escapeSeatbeltRegex(join(opts.cwd, 'CLAUDE.md'))}$`));
  assert.ok(text.includes(`^${escapeSeatbeltRegex(join(opts.cwd, 'AGENTS.md'))}$`));
});

test('buildSeatbeltLaunch skips blocked extra binds like bwrap does', () => {
  const sb = buildSeatbeltLaunch(baseOpts({
    extraBinds: [{ src: '~/.ssh', mode: 'ro' }, { src: '/srv/shared', mode: 'rw' }],
  }));
  trackDir(sb.dir);
  const text = readFileSync(sb.profilePath, 'utf-8');
  assert.ok(text.includes(subtreeRegex('/srv/shared')), 'legit extra bind is allowed');
});

test('profile allows pty ioctls and nested pty allocation', () => {
  // isatty()/tcgetattr() on the inherited pty are file-ioctl operations;
  // without these rules interactive CLIs cannot detect their TTY.
  const text = buildSeatbeltProfileText({});
  assert.ok(text.includes('(allow pseudo-tty)'));
  assert.ok(text.includes('(allow file-ioctl (regex #"^/dev(/.*)?$"))'));
});

test('pathVariants registers both raw and realpath spellings', () => {
  assert.deepEqual(pathVariants('/definitely-absent-path-xyz'), ['/definitely-absent-path-xyz']);
  assert.ok(subtrees(tmpRoot).length >= 1);
  assert.ok(subtrees(tmpRoot).every((r) => r.startsWith('^') && r.endsWith('(/.*)?$')));
});

test('gnupg opt-in exposes the keyring and sets GNUPGHOME', () => {
  const sb = buildSeatbeltLaunch(baseOpts({ gnupg: true }));
  trackDir(sb.dir);
  assert.equal(sb.env.GNUPGHOME, join(HOME, '.gnupg'));
  const text = readFileSync(sb.profilePath, 'utf-8');
  assert.ok(text.includes(subtreeRegex(join(HOME, '.gnupg'))));
});

test('gnupg off by default: no keyring rule, no GNUPGHOME', () => {
  const sb = buildSeatbeltLaunch(baseOpts());
  trackDir(sb.dir);
  assert.equal(sb.env.GNUPGHOME, undefined);
  const text = readFileSync(sb.profilePath, 'utf-8');
  assert.ok(!text.includes(subtreeRegex(join(HOME, '.gnupg'))));
});

test('forwarded ssh-agent socket gets an explicit allow rule', () => {
  const sb = buildSeatbeltLaunch(baseOpts({ authSock: '/tmp/custom-agent.sock' }));
  trackDir(sb.dir);
  assert.equal(sb.env.SSH_AUTH_SOCK, '/tmp/custom-agent.sock');
  const text = readFileSync(sb.profilePath, 'utf-8');
  assert.ok(text.includes('(literal "/tmp/custom-agent.sock")'));
});

test('seatbeltEnvArgs serializes K=V pairs for /usr/bin/env', () => {
  assert.deepEqual(
    seatbeltEnvArgs({ HOME: '/tmp/h', PATH: '/a:/b c' }),
    ['HOME=/tmp/h', 'PATH=/a:/b c'],
  );
});

test('sandboxBackend/sandboxUnavailableReason stay bwrap-flavored on Linux', { skip: process.platform !== 'linux' }, () => {
  // This host is Linux: backend is bwrap when installed, else none -- never
  // seatbelt -- and the refusal text keeps its historical wording (asserted
  // byte-identically by routes/groups.test.js).
  assert.ok(['bwrap', 'none'].includes(sandboxBackend()));
  const { reason, hint } = sandboxUnavailableReason();
  assert.equal(reason, 'bwrap is not available on this host');
  assert.equal(hint, 'Install bwrap (bubblewrap) or launch without the sandbox.');
  const forced = forceSandboxUnavailableReason();
  assert.equal(forced.reason, 'bwrap is not available on this host');
  assert.equal(forced.hint, 'Install bwrap (bubblewrap) or disable forceSandbox.');
});
