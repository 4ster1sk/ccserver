import { join } from 'node:path';

// Agent CLI config/state directories exposed to sandboxed processes. Keep the
// bwrap bind list in one place so additions cannot expose unexpected paths.
export const AGENT_CONFIG_REL_PATHS = [
  ['.claude'],
  ['.claude.json'],
  ['.local', 'share', 'claude'],
  ['.config', 'opencode'],
  ['.local', 'share', 'opencode'],
  ['.local', 'state', 'opencode'],
  ['.codex'],
];

export function agentConfigDirs(home) {
  return AGENT_CONFIG_REL_PATHS.map((segments) => join(home, ...segments));
}

export function isBlockedCredentialBind(resolvedSrc, home) {
  return [join(home, '.ssh'), join(home, '.config', 'gh')]
    .some((path) => resolvedSrc === path || resolvedSrc.startsWith(`${path}/`));
}
