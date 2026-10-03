// Deterministic per-project hash shared by every host-side dir that is keyed
// off a project's cwd but must live outside it (review worktrees, for
// example). A single shared function keeps those paths in one hash domain.

import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

// resolve() normalizes spelling variants (trailing slash, "..", ...) so they
// all map to the same hash. 24 hex chars (96 bits) of the sha256 is plenty
// of collision headroom for a handful of projects.
export function projectHashForCwd(cwd) {
  return createHash('sha256').update(resolve(cwd)).digest('hex').slice(0, 24);
}
