// Project store (SQLite, DB v2): one row per real project directory (the
// resolved cwd), plus the per-project persistent sandbox HOME bookkeeping
// that used to live in sandbox.js's homeIndex.json sidecar. path_hash is the
// shared projectHashForCwd value so rows correlate with the orchestrator dir
// / worktree root directory names; git_remote is resolveOriginUrl()'s raw
// origin URL (NULL for non-git projects and unreadable repos).
//
// Error semantics follow workerPresets.js: user-facing reads/writes return
// { ok:false, code, message } result objects; recordSandboxHome /
// listSandboxRowsBySlug / forgetSandboxHome are best-effort operational
// bookkeeping called from sandbox.js's spawn/delete paths -- a failure there
// must never fail a launch or a deletion, so they log and degrade instead.

import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { getDb } from '../db.js';
import { projectHashForCwd } from './projectHash.js';
import { resolveOriginUrl } from './gitAllowlist.js';

const LABEL_MAX = 200;

function isUniqueViolation(err) {
  return err?.code === 'SQLITE_CONSTRAINT_UNIQUE'
    || /UNIQUE constraint failed/.test(err?.message || '');
}

function rowToProject(row) {
  if (!row) return null;
  return {
    id: row.id,
    cwd: row.cwd,
    pathHash: row.path_hash,
    label: row.label ?? null,
    gitRemote: row.git_remote ?? null,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
  };
}

export function getProject(id) {
  try {
    const row = getDb()
      .prepare('SELECT id, cwd, path_hash, label, git_remote, created_at, last_seen_at FROM projects WHERE id = ?')
      .get(id);
    if (!row) return { ok: false, code: 'not-found', message: 'project not found' };
    return { ok: true, project: rowToProject(row) };
  } catch (err) {
    return { ok: false, code: 'internal', message: err.message };
  }
}

export function listProjects() {
  try {
    const rows = getDb()
      .prepare('SELECT id, cwd, path_hash, label, git_remote, created_at, last_seen_at FROM projects ORDER BY last_seen_at DESC, id ASC')
      .all();
    return { ok: true, projects: rows.map(rowToProject) };
  } catch (err) {
    return { ok: false, code: 'internal', message: err.message };
  }
}

// Find-or-create by exact resolved cwd; every call touches last_seen_at so
// "which projects are actually in use" stays fresh. Internal callers (the
// meta agent's list_projects via listProjects(), launch flows via
// recordSandboxHome) rely on this always yielding a row for a resolvable
// path. Returns a result object; an internal failure surfaces as
// { ok:false, code:'internal' } rather than throwing.
export function findOrCreateProjectByCwd(cwd) {
  let target;
  try {
    target = resolve(cwd);
  } catch {
    return { ok: false, code: 'validation', message: 'cwd must be a filesystem path' };
  }
  try {
    const db = getDb();
    const now = Date.now();
    const existing = db.prepare('SELECT id FROM projects WHERE cwd = ?').get(target);
    if (existing) {
      db.prepare('UPDATE projects SET last_seen_at = ? WHERE id = ?').run(now, existing.id);
      return getProject(existing.id);
    }
    // A stale row keyed by the same hash but a different spelling of the same
    // path cannot exist (hash is computed over the resolved path), so UNIQUE
    // collisions here mean genuine corruption -- surface them as internal.
    const id = randomUUID();
    let origin = null;
    try { origin = resolveOriginUrl(target); } catch { /* non-git / unreadable */ }
    db.prepare('INSERT INTO projects (id, cwd, path_hash, label, git_remote, created_at, last_seen_at) VALUES (?, ?, ?, NULL, ?, ?, ?)')
      .run(id, target, projectHashForCwd(target), origin, now, now);
    return getProject(id);
  } catch (err) {
    return { ok: false, code: 'internal', message: err.message };
  }
}

// Best-effort upsert of a persistent sandbox HOME row (called from
// buildSandboxSpawn on every sandboxed launch): find-or-create the project,
// then insert-or-update the slug's row with fresh timestamps. Replaces the
// old homeIndex.json write -- same "must never break a launch" contract.
export function recordSandboxHome(cwd, { createdBy = null } = {}) {
  try {
    const target = resolve(cwd);
    const project = findOrCreateProjectByCwd(target);
    if (!project.ok) {
      console.warn(`[projects] could not record sandbox HOME for ${target}: ${project.message}`);
      return false;
    }
    const slug = slugForCwd(target);
    const now = Date.now();
    getDb()
      .prepare(`INSERT INTO sandboxes (slug, project_id, cwd, created_at, last_used_at, created_by)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(slug) DO UPDATE SET
                  project_id = excluded.project_id,
                  cwd = excluded.cwd,
                  last_used_at = excluded.last_used_at,
                  created_by = COALESCE(sandboxes.created_by, excluded.created_by)`)
      .run(slug, project.project.id, target, now, now, createdBy ?? null);
    return true;
  } catch (err) {
    console.warn(`[projects] could not record sandbox HOME for ${cwd}: ${err.message}`);
    return false;
  }
}

// The sandbox HOME slug (sandbox.js slugify(resolve(cwd))). Mirrors
// sandbox.js's private slugify exactly; a test asserts lockstep.
function slugForCwd(cwd) {
  return resolve(cwd).replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'root';
}

// slug -> enriched row map for listSandboxHomes()'s LEFT JOIN view. Empty map
// on any failure (the disk walk remains the source of truth).
export function listSandboxRowsBySlug() {
  const out = new Map();
  try {
    const rows = getDb()
      .prepare(`SELECT s.slug, s.project_id, s.cwd, s.created_at, s.last_used_at, s.created_by,
                       p.label AS project_label, p.git_remote AS git_remote
                FROM sandboxes s LEFT JOIN projects p ON p.id = s.project_id`)
      .all();
    for (const r of rows) out.set(r.slug, r);
  } catch (err) {
    console.warn(`[projects] could not read sandbox rows: ${err.message}`);
  }
  return out;
}

// Best-effort removal of a deleted sandbox's row (called from
// deleteSandboxHome after both trees were removed successfully). Returns
// whether the row existed; failures log only.
export function forgetSandboxHome(slug) {
  try {
    return getDb().prepare('DELETE FROM sandboxes WHERE slug = ?').run(slug).changes > 0;
  } catch (err) {
    console.warn(`[projects] could not forget sandbox ${slug}: ${err.message}`);
    return false;
  }
}

// Pure label validation shared by updateProjectLabel and its REST/MCP callers.
// null clears the label (UI falls back to basename(cwd)); otherwise a trimmed
// non-empty string of at most LABEL_MAX chars with no control characters.
export function normalizeProjectLabel(label) {
  if (label === null || label === undefined || label === '') return { ok: true, value: null };
  if (typeof label !== 'string') return { ok: false, errors: ['label must be a string or null'] };
  const t = label.trim();
  if (!t || t.length > LABEL_MAX) return { ok: false, errors: [`label must be 1-${LABEL_MAX} characters`] };
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(t)) return { ok: false, errors: ['label must not contain control characters'] };
  return { ok: true, value: t };
}

export function updateProjectLabel(id, label) {
  if (typeof id !== 'string' || !id) return { ok: false, code: 'not-found', message: 'project not found' };
  const existing = getProject(id);
  if (!existing.ok) return existing;
  const n = normalizeProjectLabel(label);
  if (!n.ok) return { ok: false, code: 'validation', message: n.errors.join('; ') };
  try {
    getDb().prepare('UPDATE projects SET label = ? WHERE id = ?').run(n.value, id);
  } catch (err) {
    return { ok: false, code: 'internal', message: err.message };
  }
  return getProject(id);
}
