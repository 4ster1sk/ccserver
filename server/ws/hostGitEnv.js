// Environment for every git / gh process ccserver runs ON THE HOST against
// a project repository (git broker's gh relay, gitAllowlist's rev-parse).
//
// The project directory is writable from inside the sandbox (bwrap or VM),
// so its .git/config and .git/hooks are attacker-controlled once an agent
// misbehaves. Several git settings run arbitrary commands (hooks,
// core.fsmonitor, core.sshCommand, ext:: remotes, pagers, editors, external
// diff). Command-line/env config (GIT_CONFIG_COUNT) takes precedence over
// repository config, so pinning those keys here neutralizes a planted
// value without touching the repo.
//
// External diff / textconv drivers cannot be pinned off this way (an empty
// diff.external is executed as a command named ""), so callers that run
// `git diff` must pass --no-ext-diff --no-textconv themselves.
// uploadpack.packObjectsHook is never read from repo config by git.
//
// Known residual risk (documented, not fixable by key pinning): filter
// drivers (filter.<name>.smudge/clean) and multi-valued credential.helper
// entries defined in the repo config. Prefer read-only operations on
// sandbox-written repos.

const PINNED = [
  ['core.hooksPath', '/dev/null'],
  ['core.fsmonitor', 'false'],
  ['core.sshCommand', 'ssh'],
  ['core.pager', 'cat'],
  ['core.editor', 'true'],
  ['sequence.editor', 'true'],
  ['protocol.ext.allow', 'never'],
];

export const HARDENED_GIT_KEYS = Object.freeze(PINNED.map(([k]) => k));

export function hardenedGitEnv(base = process.env) {
  const env = { ...base };
  let n = Number.parseInt(env.GIT_CONFIG_COUNT || '0', 10);
  if (!Number.isInteger(n) || n < 0) n = 0;
  for (const [k, v] of PINNED) {
    env[`GIT_CONFIG_KEY_${n}`] = k;
    env[`GIT_CONFIG_VALUE_${n}`] = v;
    n++;
  }
  env.GIT_CONFIG_COUNT = String(n);
  env.GIT_TERMINAL_PROMPT = '0';
  env.GIT_PAGER = 'cat';
  env.PAGER = 'cat';
  env.GH_PROMPT_DISABLED = '1';
  return env;
}
