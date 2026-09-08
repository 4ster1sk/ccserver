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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
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
import { forceSandboxUnavailableReason, sandboxBackend, sandboxUnavailableReason, seatbeltControlSockPaths } from './sandbox.js';
import { PTY_HOST_SOCK_NAME, META_SOCK_NAME, hostRuntimeDir } from './git-broker.js';
import { getPtyHostSockPath } from '../pty-host/index.js';
import { getMetaSockPath } from './metaAgent.js';

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

test('escapeSeatbeltRegex quotes regex metacharacters but keeps slashes', () => {
  assert.equal(escapeSeatbeltRegex('/Users/oli/a+b (x)/y.md'), '/Users/oli/a\\+b \\(x\\)/y\\.md');
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

test('profile allows reading the root directory itself (macOS startup requirement)', () => {
  // macOS path resolution reads "/" as a directory during process startup:
  // with only subtree regexes (^/usr/... etc.) allowed, every child dies at
  // startup and sandbox-exec surfaces it as an abort (exit 134) -- while the
  // UI reports code 0. See docs/seatbelt-root-read-abort-diagnosis.md. The
  // literal grants only the root directory entry, not any tree below it.
  const text = buildSeatbeltProfileText({ readRegexes: ['^/usr(/.*)?$'] });
  assert.ok(text.includes('(allow file-read* (literal "/"))'), 'the literal root read must survive profile assembly');
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
  const knownHostsDefault = join(brokerDir, 'known-hosts-default');
  writeFileSync(knownHostsDefault, 'example.com ssh-ed25519 AAAA\n');
  const sb = buildSeatbeltLaunch(baseOpts({
    gitBroker: { sockPath: join(brokerDir, 'broker.sock'), allowlistPath: join(brokerDir, 'allow.json'), dir: brokerDir },
    commitGuard: { configPath: join(brokerDir, 'guard.json') },
    ssh: { realSsh: '/usr/bin/ssh', configFile: '/nonexistent-ssh-config', knownHostsDefault, userKnownHosts: null },
    sockets: { notify: join(brokerDir, 'notify.sock') },
  }));
  trackDir(sb.dir);
  for (const name of ['gh', 'ssh', 'ccserver-git-ssh', 'ccserver-git-credential-helper']) {
    const p = join(sb.binDir, name);
    assert.ok(existsSync(p), `${name} shim exists`);
    assert.ok(statSync(p).mode & 0o111, `${name} shim is executable`);
    assert.ok(readFileSync(p, 'utf-8').includes(process.execPath), `${name} shim execs the host node`);
  }
  // The per-launch ssh config points UserKnownHostsFile at host paths (the
  // shared sandbox-ssh-config pins bwrap's fixed in-sandbox paths, which no
  // mount provides here), and CCSANDBOX_SSH_CONFIG follows it. The
  // server-tree known_hosts is copied into the launch dir because
  // UserKnownHostsFile has no quoting (a spaced install dir would split it).
  const sshConfig = join(sb.dir, 'ssh-config');
  assert.ok(existsSync(sshConfig), 'per-launch ssh config exists');
  const knownHostsCopy = join(sb.dir, 'known-hosts');
  assert.ok(existsSync(knownHostsCopy), 'known_hosts copied into the launch dir');
  assert.equal(readFileSync(knownHostsCopy, 'utf-8'), 'example.com ssh-ed25519 AAAA\n');
  const sshConfigText = readFileSync(sshConfig, 'utf-8');
  assert.ok(sshConfigText.includes(`UserKnownHostsFile ${knownHostsCopy}`), 'known_hosts uses the launch-dir copy');
  assert.ok(sshConfigText.includes('StrictHostKeyChecking yes'));
  assert.ok(!sshConfigText.includes('/ccserver-sandbox-known-hosts'), 'no bwrap fixed paths');
  assert.equal(sb.env.CCSANDBOX_SSH_CONFIG, sshConfig);
  const hook = join(sb.hooksDir, 'commit-msg');
  assert.ok(existsSync(hook), 'commit-msg hook shim exists');
  assert.equal(sb.env.GIT_CONFIG_COUNT, '3');
  assert.equal(sb.env.GIT_CONFIG_KEY_0, 'credential.useHttpPath');
  assert.equal(sb.env.GIT_CONFIG_VALUE_0, 'true');
  assert.equal(sb.env.GIT_CONFIG_KEY_1, 'credential.helper');
  // credential.helper is backslash-escaped as a bare word (a leading `"` is
  // parsed by git as a helper NAME, never executed). No metacharacters in
  // binDir here, so the value is the plain path. GIT_SSH_COMMAND above stays
  // sh-quoted: that one IS a shell command string.
  assert.equal(sb.env.GIT_CONFIG_VALUE_1, join(sb.binDir, 'ccserver-git-credential-helper'));
  assert.equal(sb.env.GIT_CONFIG_KEY_2, 'core.hooksPath');
  assert.equal(sb.env.GIT_CONFIG_VALUE_2, sb.hooksDir);
  assert.equal(sb.env.GIT_SSH_COMMAND, `"${join(sb.binDir, 'ccserver-git-ssh')}"`);
  assert.equal(sb.env.CCSANDBOX_MCP_SOCK, undefined);
  assert.ok(sb.env.PATH.includes(sb.binDir));

  const text = readFileSync(sb.profilePath, 'utf-8');
  assert.ok(text.includes(`(literal "${join(brokerDir, 'broker.sock')}")`), 'broker socket is reachable');
  assert.ok(text.includes(`(literal "${join(brokerDir, 'notify.sock')}")`), 'notify socket is reachable');
  assert.ok(text.includes(`(literal "${sshConfig}")`), 'ssh config is readable');
});

test('buildSeatbeltLaunch sets CCSANDBOX_MCP_SOCK for group sessions', () => {
  const sb = buildSeatbeltLaunch(baseOpts({ sockets: { mcp: '/tmp/ccserver-mcp.sock' } }));
  trackDir(sb.dir);
  assert.equal(sb.env.CCSANDBOX_MCP_SOCK, '/tmp/ccserver-mcp.sock');
});

test('buildSeatbeltLaunch denies CLAUDE.md/AGENTS.md writes for orchestrators', () => {
  const opts = baseOpts();
  const src = join(tmpRoot, 'orchestrator.md');
  writeFileSync(src, '# rules\n');
  const sb = buildSeatbeltLaunch(baseOpts({
    cwd: opts.cwd,
    orchestratorClaudeMdSrc: src,
  }));
  trackDir(sb.dir);
  const text = readFileSync(sb.profilePath, 'utf-8');
  assert.ok(text.includes(`^${escapeSeatbeltRegex(join(opts.cwd, 'CLAUDE.md'))}$`));
  assert.ok(text.includes(`^${escapeSeatbeltRegex(join(opts.cwd, 'AGENTS.md'))}$`));
});

test('buildSeatbeltLaunch allows gitCommonDir rw and groupFilesDir ro', () => {
  const sb = buildSeatbeltLaunch(baseOpts({
    gitCommonDir: '/srv/common-git',
    groupFilesDir: '/srv/group-files',
  }));
  trackDir(sb.dir);
  const text = readFileSync(sb.profilePath, 'utf-8');
  assert.ok(text.includes(subtreeRegex('/srv/common-git')), 'git common dir is allowed');
  assert.ok(text.includes(subtreeRegex('/srv/group-files')), 'group files dir is readable');
  // group files stay read-only (bwrap ro-binds them): no write rule.
  const writeLine = text.split('\n').find((l) => l.startsWith('  (allow file-write*'));
  assert.ok(!writeLine.includes(subtreeRegex('/srv/group-files')), 'group files dir is not writable');
  // ...while the git common dir needs writes (index lock, refs).
  assert.ok(writeLine.includes(subtreeRegex('/srv/common-git')), 'git common dir is writable');
  // The host blob dir is exposed for future tooling via env.
  assert.equal(sb.env.CCSANDBOX_GROUP_FILES_DIR, '/srv/group-files');
});

test('buildSeatbeltLaunch materializes the orchestrator overlay and tracks it for teardown', () => {
  const srcDir = mkdtempSync(join(tmpdir(), 'ccserver-seatbelt-orchsrc-'));
  DIRS.push(srcDir);
  const src = join(srcDir, 'rules.md');
  writeFileSync(src, '# rules\n');
  const cwd = mkdtempSync(join(tmpdir(), 'ccserver-seatbelt-orchcwd-'));
  DIRS.push(cwd);
  const sb = buildSeatbeltLaunch(baseOpts({ cwd, orchestratorClaudeMdSrc: src }));
  trackDir(sb.dir);
  for (const name of ['CLAUDE.md', 'AGENTS.md']) {
    assert.equal(readFileSync(join(cwd, name), 'utf-8'), '# rules\n', `${name} materialized`);
  }
  assert.deepEqual(sb.ruleCopies, [join(cwd, 'CLAUDE.md'), join(cwd, 'AGENTS.md')]);
});

test('buildSeatbeltLaunch does not claim ownership of a live overlay', () => {
  // Same deterministic orchestratorDir, predecessor still live: its overlay
  // files pre-exist. The new launch refreshes them but must not list them
  // for teardown -- otherwise its own teardown (or a failed build) would
  // delete the live session's overlay out from under it.
  const srcDir = mkdtempSync(join(tmpdir(), 'ccserver-seatbelt-orchsrc-'));
  DIRS.push(srcDir);
  const src = join(srcDir, 'rules.md');
  writeFileSync(src, '# refreshed rules\n');
  const cwd = mkdtempSync(join(tmpdir(), 'ccserver-seatbelt-orchcwd-'));
  DIRS.push(cwd);
  writeFileSync(join(cwd, 'CLAUDE.md'), '# live rules\n');
  writeFileSync(join(cwd, 'AGENTS.md'), '# live rules\n');
  const sb = buildSeatbeltLaunch(baseOpts({ cwd, orchestratorClaudeMdSrc: src }));
  trackDir(sb.dir);
  for (const name of ['CLAUDE.md', 'AGENTS.md']) {
    assert.equal(readFileSync(join(cwd, name), 'utf-8'), '# refreshed rules\n', `${name} refreshed`);
  }
  assert.equal(sb.ruleCopies, null, 'pre-existing files are not owned');
});

test('buildSeatbeltLaunch failure preserves a pre-existing overlay', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'ccserver-seatbelt-orchcwd-'));
  DIRS.push(cwd);
  writeFileSync(join(cwd, 'CLAUDE.md'), '# live rules\n');
  assert.throws(
    () => buildSeatbeltLaunch(baseOpts({ cwd, orchestratorClaudeMdSrc: join(tmpRoot, 'absent.md') })),
    /cannot copy rules/,
  );
  assert.equal(readFileSync(join(cwd, 'CLAUDE.md'), 'utf-8'), '# live rules\n', 'live overlay untouched');
  assert.ok(!existsSync(join(cwd, 'AGENTS.md')), 'no partial overlay left behind');
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

test('gitBroker env carries credential.useHttpPath (bwrap parity)', () => {
  const brokerDir = mkdtempSync(join(tmpdir(), 'ccserver-seatbelt-httppath-'));
  DIRS.push(brokerDir);
  const sb = buildSeatbeltLaunch(baseOpts({
    gitBroker: { sockPath: join(brokerDir, 'b.sock'), allowlistPath: join(brokerDir, 'a.json'), dir: brokerDir },
  }));
  trackDir(sb.dir);
  const keys = Object.entries(sb.env)
    .filter(([k]) => k.startsWith('GIT_CONFIG_KEY_'))
    .map(([, v]) => v);
  const vals = Object.entries(sb.env)
    .filter(([k]) => k.startsWith('GIT_CONFIG_VALUE_'))
    .map(([, v]) => v);
  const pairs = Object.fromEntries(keys.map((k, i) => [k, vals[i]]));
  assert.equal(pairs['credential.useHttpPath'], 'true', 'broker matching needs the path');
  assert.ok(Object.values(pairs).some((v) => String(v).includes('credential-helper')));
});

test('sandbox HOME gitconfig is deny-pinned (no agent helper injection)', () => {
  // Pins apply while the broker is on (broker-issued tokens must not land in
  // an agent-written helper); without a broker both files stay writable.
  const brokerDir = mkdtempSync(join(tmpdir(), 'ccserver-seatbelt-broker-'));
  DIRS.push(brokerDir);
  const sb = buildSeatbeltLaunch(baseOpts({
    gitBroker: { sockPath: join(brokerDir, 'broker.sock'), allowlistPath: join(brokerDir, 'allow.json'), dir: brokerDir },
  }));
  trackDir(sb.dir);
  const text = readFileSync(sb.profilePath, 'utf-8');
  assert.ok(text.includes(`^${escapeSeatbeltRegex(join(sb.homeDir, '.gitconfig'))}$`));
});

test('bin/hooks/profile are deny-pinned despite the TMPDIR write rules', () => {
  const sb = buildSeatbeltLaunch(baseOpts());
  trackDir(sb.dir);
  const text = readFileSync(sb.profilePath, 'utf-8');
  assert.ok(text.includes(subtreeRegex(join(sb.dir, 'bin'))), 'shim dir pinned');
  assert.ok(text.includes(subtreeRegex(join(sb.dir, 'hooks'))), 'hooks dir pinned');
});

test('agent CLIs resolve the real config via env (HOME is remapped)', () => {
  const fakeHome = mkdtempSync(join(tmpdir(), 'ccserver-seatbelt-realhome-'));
  DIRS.push(fakeHome);
  mkdirSync(join(fakeHome, '.claude'));
  mkdirSync(join(fakeHome, '.codex'));
  const sb = buildSeatbeltLaunch(baseOpts({ hostHome: fakeHome }));
  trackDir(sb.dir);
  assert.equal(sb.env.CLAUDE_CONFIG_DIR, join(fakeHome, '.claude'));
  assert.equal(sb.env.CODEX_HOME, join(fakeHome, '.codex'));
});

test('host node binary dir stays readable (nvm-style installs)', () => {
  const sb = buildSeatbeltLaunch(baseOpts());
  trackDir(sb.dir);
  const text = readFileSync(sb.profilePath, 'utf-8');
  const readLine = text.split('\n').find((l) => l.startsWith('  (allow file-read*'));
  assert.ok(readLine.includes(subtreeRegex(dirname(process.execPath))));
});

test('buildSeatbeltLaunch cleans up its runtime dir when the overlay copy fails', () => {
  const seatbeltTmp = join(tmpRoot, 'seatbelt');
  const before = new Set(existsSync(seatbeltTmp) ? readdirSync(seatbeltTmp) : []);
  assert.throws(
    () => buildSeatbeltLaunch(baseOpts({ orchestratorClaudeMdSrc: join(tmpRoot, 'absent.md') })),
    /cannot copy rules/,
  );
  const after = existsSync(seatbeltTmp) ? readdirSync(seatbeltTmp) : [];
  assert.deepEqual(after.filter((n) => !before.has(n)), [], 'no leaked runtime dir');
});

test('only executed host files are readable, never the server tree', () => {
  const sb = buildSeatbeltLaunch(baseOpts());
  trackDir(sb.dir);
  const text = readFileSync(sb.profilePath, 'utf-8');
  const readLine = text.split('\n').find((l) => l.startsWith('  (allow file-read*'));
  // serverDir itself must not appear as an allowed subtree...
  assert.ok(!readLine.includes('server/ws(/.*)?$'), 'no server tree allow');
  // ...while every executed host file is pinned exactly.
  for (const f of ['sandbox-entrypoint.sh', 'sandbox-mcp-wrapper.cjs', 'sandbox-gh-wrapper.cjs',
    'sandbox-git-credential-helper.cjs', 'sandbox-ssh-wrapper.cjs', 'sandbox-commit-msg-hook.cjs']) {
    assert.ok(readLine.includes(`^${escapeSeatbeltRegex(join(import.meta.dirname, f))}$`), `${f} pinned`);
  }
});

test('sibling launch dirs are deny-pinned for read and write', () => {
  const sb = buildSeatbeltLaunch(baseOpts());
  trackDir(sb.dir);
  const text = readFileSync(sb.profilePath, 'utf-8');
  // POSIX ERE has no lookahead: all launch dirs are denied, then our own is
  // re-allowed after the deny (last-match-wins). Siblings stay unreachable
  // despite the broad tmpdir allow rules (0o700 is per-UID, not per-session).
  assert.ok(!text.includes('(?!'), 'no lookahead: not valid Seatbelt ERE');
  assert.ok(text.includes('ccserver-seatbelt-'), 'sibling launch dirs pinned');
  const denyWrites = text.split('\n').filter((l) => l.includes('(deny file-write*')).join('\n');
  const denyReads = text.split('\n').filter((l) => l.includes('(deny file-read*')).join('\n');
  assert.ok(denyWrites.includes('ccserver-seatbelt-'), 'write pin covers siblings');
  assert.ok(denyReads.includes('ccserver-seatbelt-'), 'read pin covers siblings');
});

// Minimal last-match-wins emulator for file-write* rules: returns the op of
// the last rule whose regex selector matches the path ('deny' when nothing
// matches, mirroring `(deny default)`).
function finalWriteVerdict(text, path) {
  let verdict = 'deny';
  for (const m of text.matchAll(/^\s*\((allow|deny) file-write\*\s*(.*)\)$/gm)) {
    const bodies = [...m[2].matchAll(/\(regex #"(.*?)"\)/g)].map((x) => x[1]);
    if (bodies.some((r) => new RegExp(r).test(path))) verdict = m[1];
  }
  return verdict;
}

test('own launch dir stays writable: pin denies do not override the re-allow', () => {
  const sb = buildSeatbeltLaunch(baseOpts());
  trackDir(sb.dir);
  const text = readFileSync(sb.profilePath, 'utf-8');
  // runtime/ (XDG_RUNTIME_DIR) and the throwaway HOME must end as allow --
  // the sibling prefix deny must not be repeated after the own-dir re-allow.
  assert.equal(finalWriteVerdict(text, join(sb.dir, 'runtime', 'tool.sock')), 'allow');
  assert.equal(finalWriteVerdict(text, join(sb.homeDir, 'some-project-file')), 'allow');
  // ...while the read-only invariants and siblings stay denied.
  assert.equal(finalWriteVerdict(text, join(sb.binDir, 'gh')), 'deny');
  assert.equal(finalWriteVerdict(text, join(sb.profilePath)), 'deny');
  assert.equal(
    finalWriteVerdict(text, join(dirname(sb.dir), 'ccserver-seatbelt-sibling', 'sandbox.sb')),
    'deny',
  );
});

test('per-launch ssh-config is write-pinned when ssh.realSsh is set', () => {
  const brokerDir = mkdtempSync(join(tmpdir(), 'ccserver-seatbelt-broker-'));
  DIRS.push(brokerDir);
  const knownHostsDefault = join(brokerDir, 'known-hosts-default');
  writeFileSync(knownHostsDefault, 'example.com ssh-ed25519 AAAA\n');
  const sb = buildSeatbeltLaunch(baseOpts({
    gitBroker: { sockPath: join(brokerDir, 'broker.sock'), allowlistPath: join(brokerDir, 'allow.json'), dir: brokerDir },
    ssh: { realSsh: '/usr/bin/ssh', configFile: '/nonexistent-ssh-config', knownHostsDefault, userKnownHosts: null },
  }));
  trackDir(sb.dir);
  const text = readFileSync(sb.profilePath, 'utf-8');
  assert.equal(finalWriteVerdict(text, join(sb.dir, 'ssh-config')), 'deny');
  assert.equal(finalWriteVerdict(text, join(sb.dir, 'known-hosts')), 'deny');
});

test('missing server known_hosts falls back to /dev/null (fail-closed)', () => {
  const brokerDir = mkdtempSync(join(tmpdir(), 'ccserver-seatbelt-broker-'));
  DIRS.push(brokerDir);
  const sb = buildSeatbeltLaunch(baseOpts({
    gitBroker: { sockPath: join(brokerDir, 'broker.sock'), allowlistPath: join(brokerDir, 'allow.json'), dir: brokerDir },
    ssh: { realSsh: '/usr/bin/ssh', configFile: '/nonexistent-ssh-config', knownHostsDefault: '/nonexistent-known-hosts', userKnownHosts: null },
  }));
  trackDir(sb.dir);
  assert.ok(!existsSync(join(sb.dir, 'known-hosts')), 'no copy without a source file');
  const sshConfigText = readFileSync(join(sb.dir, 'ssh-config'), 'utf-8');
  assert.ok(sshConfigText.includes('UserKnownHostsFile /dev/null'), 'empty known_hosts, strict checking kept');
});

test('spaced launch dirs: helper is bare-word-escaped, ssh command is quoted', () => {
  // $TMPDIR may contain spaces: credential.helper must stay a bare word
  // (backslash-escaped, leading `/` so git executes it directly -- a `"`
  // would be parsed as a helper NAME), while GIT_SSH_COMMAND is a shell
  // command string and stays double-quoted.
  const spacedBase = join(tmpRoot, 'with space');
  mkdirSync(spacedBase, { recursive: true });
  const brokerDir = mkdtempSync(join(tmpdir(), 'ccserver-seatbelt-broker-'));
  DIRS.push(brokerDir);
  const prev = process.env.CCSERVER_SANDBOX_SEATBELT_TMP;
  process.env.CCSERVER_SANDBOX_SEATBELT_TMP = spacedBase;
  try {
    const sb = buildSeatbeltLaunch(baseOpts({
      gitBroker: { sockPath: join(brokerDir, 'broker.sock'), allowlistPath: join(brokerDir, 'allow.json'), dir: brokerDir },
      ssh: { realSsh: '/usr/bin/ssh', configFile: '/nonexistent-ssh-config', knownHostsDefault: '/nonexistent-known-hosts', userKnownHosts: null },
    }));
    trackDir(sb.dir);
    assert.ok(sb.binDir.includes(' '), 'launch dir really contains a space');
    const helperShim = join(sb.binDir, 'ccserver-git-credential-helper');
    assert.equal(sb.env.GIT_CONFIG_VALUE_1, helperShim.replace(/ /g, '\\ '));
    assert.ok(sb.env.GIT_CONFIG_VALUE_1.startsWith('/'), 'helper keeps its leading slash');
    assert.equal(sb.env.GIT_SSH_COMMAND, `"${join(sb.binDir, 'ccserver-git-ssh')}"`);
  } finally {
    if (prev === undefined) delete process.env.CCSERVER_SANDBOX_SEATBELT_TMP;
    else process.env.CCSERVER_SANDBOX_SEATBELT_TMP = prev;
  }
});

test('no per-launch ssh-config is minted without ssh.realSsh', () => {
  const sb = buildSeatbeltLaunch(baseOpts());
  trackDir(sb.dir);
  assert.ok(!existsSync(join(sb.dir, 'ssh-config')));
  assert.equal(sb.env.CCSANDBOX_SSH_CONFIG, undefined);
});

test('no per-launch ssh-config is minted without a git broker (minimal launches)', () => {
  // buildMinimalSandboxSpawn passes ssh: seatbeltSsh() (realSsh set on real
  // macOS hosts) with gitBroker: null -- nothing consumes the ssh machinery
  // there, so nothing may be minted (bwrap parity: broker-gated).
  const sb = buildSeatbeltLaunch(baseOpts({
    ssh: { realSsh: '/usr/bin/ssh', configFile: '/nonexistent-ssh-config', knownHostsDefault: '/nonexistent-known-hosts', userKnownHosts: null },
  }));
  trackDir(sb.dir);
  assert.ok(!existsSync(join(sb.dir, 'ssh-config')));
  assert.ok(!existsSync(join(sb.dir, 'known-hosts')));
  assert.equal(sb.env.CCSANDBOX_SSH_CONFIG, undefined);
  assert.equal(sb.env.GIT_SSH_COMMAND, undefined);
});

test('deny lines are emitted after the allow lines (last-match-wins)', () => {
  const text = buildSeatbeltProfileText({
    readRegexes: ['^/srv/proj(/.*)?$'],
    writeRegexes: ['^/srv/proj(/.*)?$'],
    denyWriteRegexes: ['^/home/u/.ssh(/.*)?$'],
  });
  const allowWriteIdx = text.indexOf('(allow file-write*');
  const denyWriteIdx = text.indexOf('(deny file-write*');
  assert.ok(allowWriteIdx !== -1 && denyWriteIdx !== -1 && allowWriteIdx < denyWriteIdx, 'pins must land after the allows');
});

test('sibling deny pins cover both raw and realpath spellings of the base', () => {
  // seatbeltBaseDir() under a symlink: deny pins must carry both spellings,
  // or the other spelling walks around the pin via the broad tmp allows.
  const realBase = mkdtempSync(join(tmpdir(), 'ccserver-seatbelt-realbase-'));
  DIRS.push(realBase);
  const linkBase = join(tmpRoot, 'base-link');
  symlinkSync(realBase, linkBase);
  const prev = process.env.CCSERVER_SANDBOX_SEATBELT_TMP;
  process.env.CCSERVER_SANDBOX_SEATBELT_TMP = linkBase;
  try {
    const sb = buildSeatbeltLaunch(baseOpts());
    trackDir(sb.dir);
    const text = readFileSync(sb.profilePath, 'utf-8');
    assert.ok(
      text.includes(`^${escapeSeatbeltRegex(linkBase)}/ccserver-seatbelt-`),
      'raw base spelling pinned',
    );
    assert.ok(
      text.includes(`^${escapeSeatbeltRegex(realBase)}/ccserver-seatbelt-`),
      'realpath base spelling pinned',
    );
  } finally {
    if (prev === undefined) delete process.env.CCSERVER_SANDBOX_SEATBELT_TMP;
    else process.env.CCSERVER_SANDBOX_SEATBELT_TMP = prev;
  }
});

test('gitconfig deny pins cover both spellings of a symlinked HOME', () => {
  const realHome = mkdtempSync(join(tmpdir(), 'ccserver-seatbelt-realhome-'));
  DIRS.push(realHome);
  const linkHome = join(tmpRoot, 'home-link');
  symlinkSync(realHome, linkHome);
  const homeDir = join(linkHome, 'home');
  mkdirSync(homeDir, { recursive: true });
  const brokerDir = mkdtempSync(join(tmpdir(), 'ccserver-seatbelt-broker-'));
  DIRS.push(brokerDir);
  const sb = buildSeatbeltLaunch(baseOpts({
    homeDir,
    gitBroker: { sockPath: join(brokerDir, 'broker.sock'), allowlistPath: join(brokerDir, 'allow.json'), dir: brokerDir },
  }));
  trackDir(sb.dir);
  const text = readFileSync(sb.profilePath, 'utf-8');
  assert.ok(text.includes(`^${escapeSeatbeltRegex(join(homeDir, '.gitconfig'))}$`), 'raw spelling pinned');
  assert.ok(
    text.includes(`^${escapeSeatbeltRegex(join(realHome, 'home', '.gitconfig'))}$`),
    'realpath spelling pinned',
  );
});

test('gitconfig deny pins apply only while the git broker is on', () => {
  // Without a broker there are no broker-issued tokens to steal, and bwrap
  // leaves both files agent-writable -- `git config --global` must keep
  // working in a persistent HOME.
  const homeDir = mkdtempSync(join(tmpdir(), 'ccserver-seatbelt-home-'));
  DIRS.push(homeDir);
  const sb = buildSeatbeltLaunch(baseOpts({ homeDir, gitBroker: null }));
  trackDir(sb.dir);
  const text = readFileSync(sb.profilePath, 'utf-8');
  assert.ok(!text.includes('/\\.gitconfig$")'), 'no .gitconfig pin without a broker');
  assert.ok(!text.includes('git/config'), 'no xdg git config pin without a broker');
});

test('buildSeatbeltProfileText denies real gh binaries for process-exec', () => {
  const text = buildSeatbeltProfileText({ denyExecLiterals: ['/opt/homebrew/bin/gh', '/tmp/we"ird/gh'] });
  assert.ok(text.includes('(deny process-exec (literal "/opt/homebrew/bin/gh") (literal "/tmp/we\\"ird/gh"))'));
});

test('buildSeatbeltProfileText denies control-plane sockets via path-literal', () => {
  // connect() is mediated as network-outbound: the pin must use
  // (remote unix-socket (path-literal ...)) -- Apple's Sandbox Guide allows
  // only path-literal there, not regex/literal/subpath -- and land AFTER
  // (allow network*) per last-match-wins.
  const text = buildSeatbeltProfileText({ denyNetOutboundLiterals: ['/tmp/ccserver-runtime-501/ccserver-pty-host.sock'] });
  assert.ok(text.includes('(deny network-outbound (remote unix-socket (path-literal "/tmp/ccserver-runtime-501/ccserver-pty-host.sock")))'));
  assert.ok(text.indexOf('(allow network*)') < text.indexOf('(deny network-outbound'));
  // Every emitted rule line must be paren-balanced (an unbalanced SBPL rule
  // fails the whole profile compile -- fail-closed for all seatbelt launches).
  for (const l of text.split('\n')) {
    if (!l.trimStart().startsWith('(')) continue;
    const opens = (l.match(/\(/g) || []).length;
    const closes = (l.match(/\)/g) || []).length;
    assert.equal(opens, closes, `balanced parens: ${l}`);
  }
});

test('buildSeatbeltLaunch pins controlSockDenies for network-outbound', () => {
  const sockDir = mkdtempSync(join(tmpdir(), 'ccserver-seatbelt-socks-'));
  DIRS.push(sockDir);
  const ptySock = join(sockDir, 'ccserver-pty-host.sock');
  writeFileSync(ptySock, '');
  const sb = buildSeatbeltLaunch(baseOpts({ controlSockDenies: [ptySock] }));
  trackDir(sb.dir);
  const text = readFileSync(sb.profilePath, 'utf-8');
  assert.ok(text.includes(`(remote unix-socket (path-literal "${ptySock}"))`), 'pty-host socket pinned');
  // The socket FILE itself must also be write-denied (file-write* covers
  // unlink/rename -- otherwise the agent could replace the pinned socket at
  // its fixed path and impersonate the control plane for host-side connects).
  assert.equal(finalWriteVerdict(text, ptySock), 'deny', 'pinned socket file unwritable');
});

test('control-socket pins cover both /tmp spellings even when the dir is absent', () => {
  // The runtime dir may not exist yet (nothing booted a broker); the anchor
  // must fall back to the always-existing parent so the /private/tmp
  // spelling (Seatbelt mediates the resolved path) is pinned too.
  const absentDir = join(tmpdir(), `ccserver-seatbelt-absent-${randomUUID()}`);
  const sock = join(absentDir, 'ccserver-pty-host.sock');
  const prev = process.env.CCSERVER_SANDBOX_SEATBELT_TMP;
  // Keep the launch dir OUT of the absent dir (fresh boots put it there).
  process.env.CCSERVER_SANDBOX_SEATBELT_TMP = tmpRoot;
  try {
    const sb = buildSeatbeltLaunch(baseOpts({ controlSockDenies: [sock] }));
    trackDir(sb.dir);
    const text = readFileSync(sb.profilePath, 'utf-8');
    assert.ok(text.includes(`(path-literal "${sock}")`), 'raw spelling pinned');
    const priv = sock.replace(tmpdir(), realpathSync(tmpdir()));
    assert.ok(text.includes(`(path-literal "${priv}")`), 'symlink-resolved spelling pinned');
  } finally {
    if (prev === undefined) delete process.env.CCSERVER_SANDBOX_SEATBELT_TMP;
    else process.env.CCSERVER_SANDBOX_SEATBELT_TMP = prev;
  }
});

test('control-plane pin paths track the producers (rename-safe)', () => {
  // The network-outbound deny is only as good as its path: if pty-host or
  // meta renames its socket, the pin must follow. Both producers build from
  // git-broker.js's shared constants, and so does the pin list.
  const prevPty = process.env.CCSERVER_PTY_HOST_SOCK;
  const prevXdg = process.env.XDG_RUNTIME_DIR;
  delete process.env.CCSERVER_PTY_HOST_SOCK;
  delete process.env.XDG_RUNTIME_DIR;
  try {
    assert.equal(getPtyHostSockPath(), join(hostRuntimeDir(), PTY_HOST_SOCK_NAME));
    assert.equal(getMetaSockPath(), join(hostRuntimeDir(), META_SOCK_NAME));
    const pins = seatbeltControlSockPaths(null);
    assert.ok(pins.includes(getPtyHostSockPath()), 'pty-host socket pinned');
    assert.ok(pins.includes(getMetaSockPath()), 'meta socket pinned');
    const metaPins = seatbeltControlSockPaths(getMetaSockPath());
    assert.ok(!metaPins.includes(getMetaSockPath()), 'meta session keeps its channel');
    assert.ok(metaPins.includes(getPtyHostSockPath()), 'pty-host pinned even for meta');
  } finally {
    if (prevPty === undefined) delete process.env.CCSERVER_PTY_HOST_SOCK;
    else process.env.CCSERVER_PTY_HOST_SOCK = prevPty;
    if (prevXdg === undefined) delete process.env.XDG_RUNTIME_DIR;
    else process.env.XDG_RUNTIME_DIR = prevXdg;
  }
});

test('commit-guard config and broker allowlist are write-pinned', () => {
  // The in-sandbox commit-msg hook re-reads its config on every commit;
  // bwrap ro-binds it, so seatbelt must deny-write it (and the allowlist).
  const brokerDir = mkdtempSync(join(tmpdir(), 'ccserver-seatbelt-broker-'));
  DIRS.push(brokerDir);
  const allowlistPath = join(brokerDir, 'allow.json');
  writeFileSync(allowlistPath, '{}');
  const guardPath = join(brokerDir, 'guard.json');
  writeFileSync(guardPath, '{}');
  const sb = buildSeatbeltLaunch(baseOpts({
    gitBroker: { sockPath: join(brokerDir, 'broker.sock'), allowlistPath, dir: brokerDir },
    commitGuard: { configPath: guardPath },
  }));
  trackDir(sb.dir);
  const text = readFileSync(sb.profilePath, 'utf-8');
  assert.equal(finalWriteVerdict(text, guardPath), 'deny', 'guard config immutable');
  assert.equal(finalWriteVerdict(text, allowlistPath), 'deny', 'allowlist immutable');
});

test('buildSeatbeltLaunch pins ghPaths only while the git broker is on', () => {
  const brokerDir = mkdtempSync(join(tmpdir(), 'ccserver-seatbelt-broker-'));
  DIRS.push(brokerDir);
  const gitBroker = { sockPath: join(brokerDir, 'broker.sock'), allowlistPath: join(brokerDir, 'allow.json'), dir: brokerDir };
  const sb = buildSeatbeltLaunch(baseOpts({ gitBroker, ghPaths: ['/opt/homebrew/bin/gh', '/usr/bin/gh'] }));
  trackDir(sb.dir);
  const text = readFileSync(sb.profilePath, 'utf-8');
  assert.ok(text.includes('(deny process-exec (literal "/opt/homebrew/bin/gh") (literal "/usr/bin/gh"))'), 'real gh denied');
  const denyExecs = text.split('\n').filter((l) => l.includes('deny process-exec')).join('\n');
  assert.ok(!denyExecs.includes(join(sb.binDir, 'gh')), 'PATH shim itself is never denied');
  const sbOff = buildSeatbeltLaunch(baseOpts({ gitBroker: null, ghPaths: ['/opt/homebrew/bin/gh'] }));
  trackDir(sbOff.dir);
  const textOff = readFileSync(sbOff.profilePath, 'utf-8');
  assert.ok(!textOff.includes('(literal "/opt/homebrew/bin/gh")'), 'no gh pin without a broker');
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
