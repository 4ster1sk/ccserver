// Builds the command line ssh runs inside a qemu-backend VM. Shared by
// sandbox-qemu.js (ESM, planning/tests) and sandbox-qemu-launcher.cjs (the
// pty child, which adds the pty's own env at run time) so the quoting rules
// exist exactly once.
'use strict';

function shellQuote(s) {
  const str = String(s);
  if (/^[A-Za-z0-9_\-./=:@%+,]+$/.test(str)) return str;
  return `'${str.replace(/'/g, `'\\''`)}'`;
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

// ssh joins its argv with spaces and hands the result to the remote login
// shell, so everything is quoted here once: cd into the project, set env,
// exec the target. With fallbackArgv, a target binary missing from the guest
// (e.g. the host's $SHELL is a shell the image lacks) runs that instead.
function buildRemoteCommand({ cwd, argv, env = {}, fallbackArgv = null }) {
  const envParts = Object.entries(env)
    .filter(([k]) => ENV_NAME.test(k))
    .map(([k, v]) => `${k}=${shellQuote(v)}`);
  const envPrefix = `exec env ${envParts.join(' ')}${envParts.length ? ' ' : ''}`;
  const target = envPrefix + argv.map(shellQuote).join(' ');
  if (!fallbackArgv) return `cd ${shellQuote(cwd)} && ${target}`;
  const fallback = envPrefix + fallbackArgv.map(shellQuote).join(' ');
  return `cd ${shellQuote(cwd)} && if command -v ${shellQuote(argv[0])} >/dev/null 2>&1; then ${target}; else ${fallback}; fi`;
}

// The subset of the launcher's own environment (what sessionManager gave
// the pty) that belongs in the guest: terminal hints and ccserver/agent
// settings -- never host paths or identity (PATH, HOME, SSH_AUTH_SOCK...).
const FORWARD_NAMES = ['COLORTERM', 'FORCE_COLOR', 'NO_COLOR'];
const FORWARD_PREFIXES = ['CLAUDE_CODE_', 'CCSERVER_', 'CCSANDBOX_'];
// Credentials stay on the host (e.g. the host's CLAUDE_CODE_OAUTH_TOKEN):
// the VM gets placeholders the network broker swaps (qemuAgents.js).
const SECRET_NAME = /TOKEN|SECRET|PASSWORD|API_KEY|CREDENTIAL/;

function forwardedEnv(source) {
  const out = {};
  for (const [k, v] of Object.entries(source || {})) {
    if (typeof v !== 'string' || SECRET_NAME.test(k)) continue;
    if (FORWARD_NAMES.includes(k) || FORWARD_PREFIXES.some((p) => k.startsWith(p))) out[k] = v;
  }
  return out;
}

// bwrap inside a persistent VM (qemuVmPool.js): every session of the VM
// logs in as the same guest user, so what keeps one session out of another's
// project is that its root is built from nothing but the system dirs, its
// own project and its own HOME. Other sessions' hot-plugged shares are never
// bound, so they do not exist in its view; its own pid namespace hides their
// processes.
//
//   cwdSource:  guest path of this session's hot-plugged project dir
//               (bound at cwd)
//   homeSource: guest path of this session's hot-plugged persistent HOME,
//               or null for a throwaway tmpfs HOME
//   agent:      { source, target } -- the hot-plugged read-only agent
//               install (qemuAgents.js) and where it goes, or null. The
//               target dir must already exist in the guest (/opt is ro).
//   extraBinds: [{ source, target, readonly }] bound after everything else
//               (opencode chat mode's bridge files and relay socket dir).
//               A target must be creatable: under /tmp or at the top level.
function buildGuestBwrapArgs({ cwd, cwdSource = cwd, home, homeSource = null, agent = null, extraBinds = [] }) {
  return [
    '--die-with-parent',
    '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--unshare-cgroup-try',
    '--ro-bind', '/usr', '/usr',
    '--symlink', 'usr/bin', '/bin',
    '--symlink', 'usr/sbin', '/sbin',
    '--symlink', 'usr/lib', '/lib',
    '--symlink', 'usr/lib64', '/lib64',
    '--ro-bind', '/etc', '/etc',
    '--ro-bind-try', '/opt', '/opt',
    ...(agent ? ['--ro-bind', agent.source, agent.target] : []),
    '--proc', '/proc',
    '--dev', '/dev',
    '--tmpfs', '/tmp',
    '--tmpfs', '/var/tmp',
    '--tmpfs', '/run',
    // /etc/resolv.conf may point here (systemd-resolved).
    '--ro-bind-try', '/run/systemd/resolve', '/run/systemd/resolve',
    ...(homeSource ? ['--bind', homeSource, home] : ['--tmpfs', home]),
    // After HOME: the project usually lives under it.
    '--bind', cwdSource, cwd,
    ...extraBinds.flatMap((b) => [b.readonly ? '--ro-bind' : '--bind', b.source, b.target]),
    '--setenv', 'HOME', home,
    '--chdir', cwd,
  ];
}

// The ssh remote command for a pooled session: bwrap, then inside it the
// usual cd/env/exec of buildRemoteCommand. preDirs: guest dirs created
// (private to the guest user) before bwrap starts, for extraBinds sources
// that live outside it.
function buildConfinedRemoteCommand({ bwrapArgs, cwd, argv, env = {}, fallbackArgv = null, preDirs = [] }) {
  const inner = buildRemoteCommand({ cwd, argv, env, fallbackArgv });
  const pre = preDirs.length ? `umask 077 && mkdir -p ${preDirs.map(shellQuote).join(' ')} && ` : '';
  return `${pre}exec bwrap ${bwrapArgs.map(shellQuote).join(' ')} -- /bin/sh -c ${shellQuote(inner)}`;
}

module.exports = { shellQuote, buildRemoteCommand, forwardedEnv, buildGuestBwrapArgs, buildConfinedRemoteCommand };
