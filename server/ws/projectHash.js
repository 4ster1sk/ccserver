// Deterministic per-project hash shared by every host-side dir that is keyed
// off a project's cwd but must live outside it (the orchestrator dir in
// routes/groups.js, the worktree root in worktree.js). A single shared
// function keeps the two from drifting into separate hash domains for what
// is conceptually the same "which project is this" question.

import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

// resolve() normalizes spelling variants (trailing slash, "..", ...) so they
// all map to the same hash. 24 hex chars (96 bits) of the sha256 is plenty
// of collision headroom for a handful of projects.
export function projectHashForCwd(cwd) {
  return createHash('sha256').update(resolve(cwd)).digest('hex').slice(0, 24);
}
