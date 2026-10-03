// Shared path-containment policy for issue #189's browseRoots restriction.
// Used by both the HTTP layer (routes/files.js, routes/dirs.js) and the
// WS/session layer (ws/sessionManager.js, ws/sandbox.js), so it stays
// dependency-free (node builtins only) to avoid a circular import between
// those two layers.

import { resolve, sep, dirname, basename, join } from 'node:path';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { scratchRoots } from './paths.js';

const HOME = homedir();

function expandHome(p) {
  if (p === '~') return HOME;
  if (p.startsWith('~/')) return resolve(HOME, p.slice(2));
  return p;
}

// Parses sandbox.config.json's raw browseRoots. [] or a non-array means
// "unrestricted" (the existing host-wide behavior is preserved) -- same
// "silently drop invalid values" policy as hiddenApps (sandbox.js).
export function normalizeBrowseRoots(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const entry of raw) {
    if (typeof entry !== 'string' || !entry) continue;
    const abs = resolve(expandHome(entry));
    if (!out.includes(abs)) out.push(abs);
  }
  return out;
}

// Whether absPath (already resolve()d) equals or sits under one of roots.
// roots=[] means unrestricted (back-compat). Mirrors the
// `x === root || x.startsWith(root + '/')` containment check in
// sessionManager.js.
function withinRoots(absPath, roots) {
  if (roots.length === 0) return true;
  return roots.some((root) => absPath === root || absPath.startsWith(root + sep));
}

function realOrSelf(p) {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

// realpath(), but tolerant of absPath not existing yet (about to be
// created): walks up to the nearest existing ancestor, resolves THAT, and
// reattaches the missing tail. This is what makes containment symlink-safe
// in both directions at once -- a root that itself sits behind a symlink
// (macOS's /tmp -> /private/tmp is the common case) still lines up with a
// not-yet-created path underneath it, while a symlink planted INSIDE an
// allowed root that points outside it (an escape attempt) still resolves to
// its real, out-of-bounds target once it exists.
//
export function realOrNearest(absPath) {
  try {
    return realpathSync(absPath);
  } catch {
    const parent = dirname(absPath);
    if (parent === absPath) return absPath; // reached the top; nothing left to resolve
    return join(realOrNearest(parent), basename(absPath));
  }
}

// Containment check with symlink-escape protection: safePath()/
// browseDirectory() historically only resolve() a path (never follow
// symlinks), so a symlink planted inside an allowed root that points outside
// it would otherwise defeat browseRoots entirely. Both absPath and each root
// are compared by their "real" spelling (realOrNearest), not their lexical
// one -- comparing a realpath'd absPath against lexical roots would
// otherwise misjudge a root that itself sits behind a symlink as "outside".
export function isContained(absPath, roots) {
  if (roots.length === 0) return true;
  const realRoots = roots.map(realOrSelf);
  return withinRoots(realOrNearest(absPath), realRoots);
}

// Resolves a user-supplied path the same way the pre-existing
// resolve('/', requestedPath || fallback) contract did (relative paths
// anchored at /, '..' collapsed -- see files.test.js's host-wide-policy
// pin), then applies containment on top.
export function resolveWithinRoots(requestedPath, roots, fallback = '/') {
  const path = resolve('/', requestedPath || fallback);
  return { ok: isContained(path, roots), path };
}

// browseRoots session-cwd exemption for trusted code-review jobs. Reviewer
// jobs run in disposable worktrees under ccserver's scratch roots, outside
// the operator's project roots. The caller must be trusted and the resolved
// path is checked again below to prevent a symlink from escaping the scratch
// tree. This applies only to launch cwd validation; file and directory APIs
// remain bounded by browseRoots.
//
// Both the legacy and XDG scratch roots remain recognized so worktrees from
// sessions already running during a data-directory migration continue to work.
export function isCcserverScratchPath(absPath) {
  const roots = scratchRoots().map((r) => resolve(r));
  if (!withinRoots(absPath, roots)) return false;
  return withinRoots(realOrNearest(absPath), roots.map((r) => realOrSelf(r)));
}
