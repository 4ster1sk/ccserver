// macOS Seatbelt backend for `sandbox-exec` (see sandbox.js's darwin branch).
//
// Unlike bwrap (Linux), sandbox-exec has no bind mounts, mount namespaces or
// chroot: the sandboxed process sees the whole host filesystem and access is
// mediated by a deny-by-default Seatbelt policy instead ("visible but
// untouchable"). This is strictly weaker isolation than bwrap -- a regex gap
// is a live escape -- and docker (rootless dind) is unsupported, so every
// seatbelt launch runs with docker: false.
//
// sandbox-exec also has no `--setenv`: sandbox.js prepends `/usr/bin/env
// K=V ...` to the spawn argv from the `env` object returned here.
//
// The git/ssh/gh/commit-guard wrappers use a `#!/ccserver-sandbox-node`
// shebang that only resolves inside bwrap. On macOS the host node binary is
// directly visible, so this module mints per-launch `#!/bin/sh` shims that
// exec the real host node with the real wrapper script (no spaces/quoting
// hazards in GIT_SSH_COMMAND or credential.helper), plus a `hooks/`
// directory for core.hooksPath.

import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

// Base dir for per-launch seatbelt runtime dirs. os.tmpdir() honors $TMPDIR,
// which on macOS is the per-user /var/folders/... path. Overridable via
// CCSERVER_SANDBOX_SEATBELT_TMP for tests.
export function seatbeltBaseDir() {
  return process.env.CCSERVER_SANDBOX_SEATBELT_TMP || tmpdir();
}

// Quote a host path for embedding in a Seatbelt `regex #"..."` literal.
// Seatbelt regexes follow ICU syntax; escaping every non-alphanumeric keeps
// paths like `/Users/oli/a+b (x)/` from becoming accidental alternations.
export function escapeSeatbeltRegex(s) {
  return String(s).replace(/[^a-zA-Z0-9/]/g, (c) => `\\${c}`);
}

// `^<dir>(/.*)?$` matches the dir itself plus everything underneath it.
export function subtreeRegex(dir) {
  return `^${escapeSeatbeltRegex(dir)}(/.*)?$`;
}

// Assemble the profile text. Each list holds ready-made `regex #"..."` bodies
// (see subtreeRegex) or exact-path literals:
//   readRegexes/writeRegexes    - allow file-read*/file-write* by pattern
//   readLiterals/writeLiterals  - allow by exact path (sockets, single files)
//   denyWriteRegexes            - deny file-write* (deny wins over allow)
export function buildSeatbeltProfileText({
  readRegexes = [],
  writeRegexes = [],
  readLiterals = [],
  writeLiterals = [],
  denyWriteRegexes = [],
} = {}) {
  const line = (op, sel) => `  (${op} ${sel})`;
  const regexes = (list) => list.map((r) => `(regex #"${r}")`).join(' ');
  const literals = (list) => list.map((p) => `(literal "${p}")`).join(' ');
  const out = [
    '(version 1)',
    '',
    ';; deny-by-default: everything not explicitly allowed below is refused.',
    ';; A deny rule always wins over an allow rule when both match.',
    '(deny default)',
    '',
    ';; process + network. Egress stays open (agent APIs, git, tool',
    ';; provisioning) -- file scope is what this sandbox restricts.',
    '(allow process-exec process-fork)',
    '(allow signal (target self))',
    '(allow sysctl-read)',
    '(allow mach-lookup)',
    '(allow network*)',
    '',
    ';; devices: the pty and /dev/null etc. must stay usable.',
    '(allow file-read* file-write* (regex #"^/dev(/.*)?$"))',
    '',
  ];
  if (readRegexes.length > 0 || readLiterals.length > 0) {
    const sels = [regexes(readRegexes), literals(readLiterals)].filter(Boolean).join(' ');
    out.push(';; readable trees and files (system, project, tooling, scripts).', line('allow file-read*', sels), '');
  }
  if (writeRegexes.length > 0 || writeLiterals.length > 0) {
    const sels = [regexes(writeRegexes), literals(writeLiterals)].filter(Boolean).join(' ');
    out.push(';; writable trees and files (project, sandbox HOME, sockets).', line('allow file-write*', sels), '');
  }
  if (denyWriteRegexes.length > 0) {
    out.push(
      ';; never writable, even when a broader allow above would match',
      ';; (raw keys / gh tokens stay behind the git broker).',
      line('deny file-write*', regexes(denyWriteRegexes)),
      '',
    );
  }
  return out.join('\n');
}

function expandAgainstHome(p, hostHome) {
  if (p === '~') return hostHome;
  if (p.startsWith('~/')) return join(hostHome, p.slice(2));
  return p;
}

// Full darwin launch assembly (mirrors buildBwrapArgs' recipe, translated
// from binds to allow-rules). All host paths are directly visible inside the
// sandbox, so "binds" become Seatbelt allow entries and fixed in-sandbox
// paths become host paths (sockets, shims, hooks dir).
//
//   cwd            - project dir (resolved here)
//   hostHome       - the real host $HOME (config/agent dirs live under it)
//   homeDir        - effective sandbox HOME, or null for a throwaway dir
//                    created inside the runtime dir (single teardown unit)
//   sandboxPathBase- SANDBOX_PATH value from sandbox.js
//   nodeBin        - host node binary (realpath of process.execPath)
//   serverDir      - sandbox.js's own dir (all wrapper scripts live under it)
//   scripts        - { ghWrapper, credHelper, sshWrapper, commitHook }
//   ssh            - { realSsh|null, configFile, knownHostsDefault, userKnownHosts|null }
//   gitBroker      - { sockPath, allowlistPath, dir } | null
//   commitGuard    - { configPath } | null
//   sockets        - { mcp, notify, usage, meta, reviewer } host paths | null
//   extraBinds/extraEnv - raw operator config (binds become allow rules;
//                    ~/.ssh and ~/.config/gh stay blocked, like bwrap)
//   authSock       - forwarded ssh-agent socket | null
//   claudeDir      - extra agent install dir | null
//   orchestratorClaudeMdSrc / gitCommonDir / groupFilesDir - like bwrap
//   tools          - resolved opt-in tool specs | null
//
// Returns { dir, profilePath, binDir, hooksDir, homeDir, env }. `dir` is the
// single teardown unit (also covers the throwaway HOME when homeDir was null).
export function buildSeatbeltLaunch({
  cwd,
  hostHome,
  homeDir = null,
  sandboxPathBase,
  nodeBin,
  serverDir,
  scripts,
  ssh = {},
  gitBroker = null,
  commitGuard = null,
  sockets = {},
  extraBinds = [],
  extraEnv = {},
  authSock = null,
  claudeDir = null,
  orchestratorClaudeMdSrc = null,
  gitCommonDir = null,
  groupFilesDir = null,
  tools = null,
}) {
  const dir = join(seatbeltBaseDir(), `ccserver-seatbelt-${randomUUID()}`);
  const binDir = join(dir, 'bin');
  const hooksDir = join(dir, 'hooks');
  mkdirSync(binDir, { recursive: true });
  mkdirSync(hooksDir, { recursive: true });

  const projectDir = resolve(cwd);
  // Throwaway HOME (minimal/usage sandboxes, or persistentHome off): lives
  // inside the runtime dir so teardown stays a single rm -rf.
  const effectiveHome = homeDir || join(dir, 'home');
  if (!homeDir) mkdirSync(effectiveHome, { recursive: true });

  // --- shims ---------------------------------------------------------------
  const shim = (name, target) => {
    const p = join(binDir, name);
    writeFileSync(p, `#!/bin/sh\nexec "${nodeBin}" "${target}" "$@"\n`, { mode: 0o755 });
    return p;
  };
  let sshShim = null;
  let credHelperShim = null;
  if (gitBroker) {
    // The `gh` shim is reached via the PATH prepend (binDir is first), so no
    // reference is needed here -- unlike the ssh/credential-helper shims,
    // which are pointed at by absolute-path env (GIT_SSH_COMMAND / helper).
    shim('gh', scripts.ghWrapper);
    credHelperShim = shim('ccserver-git-credential-helper', scripts.credHelper);
    if (ssh.realSsh) sshShim = shim('ccserver-git-ssh', scripts.sshWrapper);
  }
  if (commitGuard) {
    const p = join(hooksDir, 'commit-msg');
    writeFileSync(p, `#!/bin/sh\nexec "${nodeBin}" "${scripts.commitHook}" "$@"\n`, { mode: 0o755 });
  }

  // --- env (via /usr/bin/env, since sandbox-exec has no --setenv) ----------
  const hostLocalBin = join(hostHome, '.local', 'bin');
  const env = {
    HOME: effectiveHome,
    PATH: [binDir, join(effectiveHome, '.local', 'bin'), hostLocalBin, sandboxPathBase,
      '/opt/homebrew/bin', '/opt/homebrew/sbin'].join(':'),
    CCSANDBOX_DOCKER: '0',
  };
  if (sockets.mcp) env.CCSANDBOX_MCP_SOCK = sockets.mcp;
  if (authSock) env.SSH_AUTH_SOCK = authSock;

  // GIT_CONFIG_COUNT merges credential.helper (gitBroker) and core.hooksPath
  // (commitGuard) into one env mechanism -- same rule as buildBwrapArgs'
  // comment: a future feature reusing it must extend the count here.
  const gitConfigKeys = [];
  if (gitBroker) {
    env.CCSANDBOX_GIT_BROKER_SOCK = gitBroker.sockPath;
    env.CCSANDBOX_GIT_ALLOWLIST = gitBroker.allowlistPath;
    env.GIT_CONFIG_NOSYSTEM = '1';
    if (ssh.realSsh) {
      env.CCSANDBOX_REAL_SSH = ssh.realSsh;
      env.CCSANDBOX_SSH_CONFIG = ssh.configFile;
      env.GIT_SSH_COMMAND = sshShim;
    }
    gitConfigKeys.push(['credential.helper', credHelperShim]);
  }
  if (commitGuard) {
    env.CCSANDBOX_COMMIT_GUARD_CONFIG = commitGuard.configPath;
    gitConfigKeys.push(['core.hooksPath', hooksDir]);
  }
  if (gitConfigKeys.length > 0) {
    env.GIT_CONFIG_COUNT = String(gitConfigKeys.length);
    gitConfigKeys.forEach(([k, v], i) => {
      env[`GIT_CONFIG_KEY_${i}`] = k;
      env[`GIT_CONFIG_VALUE_${i}`] = v;
    });
  }

  if (tools && (tools.rtk || tools.codeReviewGraph)) {
    env.CCSANDBOX_PROVISION_RTK = tools.rtk ? '1' : '0';
    env.CCSANDBOX_PROVISION_CRG = tools.codeReviewGraph ? '1' : '0';
    env.CCSANDBOX_RTK_VERSION = tools.rtkSpec?.version || '';
    env.CCSANDBOX_RTK_URL = tools.rtkSpec?.url || '';
    env.CCSANDBOX_RTK_SHA256 = tools.rtkSpec?.sha256 || '';
    env.CCSANDBOX_CRG_VERSION = tools.crgSpec?.version || '';
  }

  // Operator env last, so it overrides the defaults above (like bwrap).
  for (const [k, v] of Object.entries(extraEnv || {})) {
    if (typeof k === 'string' && k) env[k] = expandAgainstHome(String(v), hostHome);
  }

  // --- profile allow/deny lists (binds translated to rules) ----------------
  const readRegexes = [
    '^/usr(/.*)?$', '^/bin(/.*)?$', '^/sbin(/.*)?$', '^/etc(/.*)?$',
    '^/System(/.*)?$', '^/Library(/.*)?$', '^/opt(/.*)?$',
    '^/private/etc(/.*)?$', '^/private/var(/.*)?$', '^/var(/.*)?$',
    '^/tmp(/.*)?$', '^/private/tmp(/.*)?$',
    subtreeRegex(projectDir),
    subtreeRegex(effectiveHome),
    subtreeRegex(dir),
    subtreeRegex(serverDir),
    subtreeRegex(hostLocalBin),
  ];
  const tmpDirs = new Set([tmpdir()]);
  try { tmpDirs.add(realpathSync(tmpdir())); } catch { /* best effort */ }
  for (const t of tmpDirs) {
    const r = subtreeRegex(t);
    if (!readRegexes.includes(r)) readRegexes.push(r);
  }
  // Agent config dirs keep working when a CLI resolves the real home via
  // macOS APIs instead of $HOME (mirrors buildBwrapArgs' appBinds). Regexes
  // for absent paths are harmless, so no existsSync gating is needed.
  const appConfigDirs = [
    join(hostHome, '.claude'), join(hostHome, '.claude.json'),
    join(hostHome, '.local', 'share', 'claude'),
    join(hostHome, '.config', 'opencode'),
    join(hostHome, '.local', 'share', 'opencode'),
    join(hostHome, '.local', 'state', 'opencode'),
    join(hostHome, '.config', 'github-copilot'),
    join(hostHome, '.copilot'),
    join(hostHome, '.codex'),
    join(hostHome, '.commandcode'),
  ];
  const writeRegexes = [
    subtreeRegex(projectDir),
    subtreeRegex(effectiveHome),
    subtreeRegex(dir),
    '^/tmp(/.*)?$', '^/private/tmp(/.*)?$',
    // macOS-API writers (NSSearchPath ignores $HOME): caches stay usable.
    subtreeRegex(join(hostHome, 'Library', 'Caches')),
    ...appConfigDirs.map(subtreeRegex),
  ];
  for (const t of tmpDirs) {
    const r = subtreeRegex(t);
    if (!writeRegexes.includes(r)) writeRegexes.push(r);
  }
  if (claudeDir && existsSync(claudeDir)) readRegexes.push(subtreeRegex(claudeDir));
  if (gitCommonDir) {
    readRegexes.push(subtreeRegex(gitCommonDir));
    writeRegexes.push(subtreeRegex(gitCommonDir));
  }
  if (groupFilesDir) readRegexes.push(subtreeRegex(groupFilesDir));

  const readLiterals = [];
  const writeLiterals = [];
  const sockPaths = [sockets.mcp, sockets.notify, sockets.usage, sockets.meta, sockets.reviewer]
    .filter(Boolean);
  if (gitBroker) sockPaths.push(gitBroker.sockPath);
  for (const s of new Set(sockPaths)) {
    readLiterals.push(s);
    writeLiterals.push(s); // connect() needs write
  }
  if (gitBroker) readLiterals.push(gitBroker.allowlistPath);
  if (commitGuard) readLiterals.push(commitGuard.configPath);
  if (ssh.userKnownHosts) readLiterals.push(ssh.userKnownHosts);
  if (ssh.knownHostsDefault) readLiterals.push(ssh.knownHostsDefault);
  if (ssh.configFile) readLiterals.push(ssh.configFile);
  if (orchestratorClaudeMdSrc) readLiterals.push(orchestratorClaudeMdSrc);

  // Raw keys / gh tokens are never reachable (mirrors bwrap's
  // BLOCKED_BIND_PATHS, unconditionally even with gitBroker off).
  const denyWriteRegexes = [
    subtreeRegex(join(hostHome, '.ssh')),
    subtreeRegex(join(hostHome, '.config', 'gh')),
  ];
  // Orchestrator rule overlay: bwrap shadows CLAUDE.md/AGENTS.md read-only;
  // without mounts the equivalent is denying writes to those two files.
  if (orchestratorClaudeMdSrc) {
    for (const name of ['CLAUDE.md', 'AGENTS.md']) {
      denyWriteRegexes.push(`^${escapeSeatbeltRegex(join(projectDir, name))}$`);
    }
  }

  // Operator extra binds become allow rules (no remount, so src is used
  // as-is; dest is ignored). Blocked paths are skipped with a warning.
  const BLOCKED = [join(hostHome, '.ssh'), join(hostHome, '.config', 'gh')];
  for (const b of extraBinds || []) {
    if (!b || !b.src) continue;
    const src = expandAgainstHome(String(b.src), hostHome);
    if (BLOCKED.some((p) => src === p || src.startsWith(`${p}/`))) {
      console.warn(`[sandbox] ignoring configured bind of ${src}: raw ssh keys / gh config are no longer exposed to the sandbox (see the git broker)`);
      continue;
    }
    readRegexes.push(subtreeRegex(src));
    if (b.mode === 'rw') writeRegexes.push(subtreeRegex(src));
  }

  const profileText = buildSeatbeltProfileText({
    readRegexes, writeRegexes, readLiterals, writeLiterals, denyWriteRegexes,
  });
  const profilePath = join(dir, 'sandbox.sb');
  writeFileSync(profilePath, profileText);
  return { dir, profilePath, binDir, hooksDir, homeDir: effectiveHome, nodeBin, env };
}

// Serialize the seatbelt env object for `sandbox-exec -f profile
// /usr/bin/env K=V ... <cmd>` (sandbox-exec has no --setenv). Array-form
// spawn passes each `K=V` literally, so values with spaces are safe.
export function seatbeltEnvArgs(env) {
  return Object.entries(env || {}).map(([k, v]) => `${k}=${v}`);
}
