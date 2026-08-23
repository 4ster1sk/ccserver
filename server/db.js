// SQLite foundation for ccserver's persistent state (plan: sqlite-worker-presets).
//
// Design: lazy singleton + explicit initDb(), deliberately different from the
// other modules' "read env at module load" convention -- reading CCSERVER_DB_PATH
// inside getDb() means tests can set the env before the first call without
// dynamic-import tricks, and a broken DB refuses boot (initDb fail-fast) instead
// of failing lazily on first store access.
//
// Error semantics (do not mix these up):
//   - migration/init failure  -> throw (index.js turns that into log + exit(1))
//   - normal runtime failures -> callers decide; safeDb() exists for the later
//     phases' best-effort operational-state writes, never for user-facing CRUD.

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

let dbInstance = null;

// Repo-root DB by default (next to .saved-groups.json et al), overridable for
// tests / multi-instance hosts. Read on every getDb() call, never cached.
export function dbPath() {
  return process.env.CCSERVER_DB_PATH || join(__dirname, '..', '..', 'ccserver.sqlite3');
}

function applyPragmas(db) {
  // WAL: concurrent readers during writes (the UI polls while stores persist).
  // NORMAL fsync is the documented WAL pairing. busy_timeout keeps parallel
  // writers (group launches) from failing on a transient lock.
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA busy_timeout = 5000');
}

// v1: worker presets only. Later phases move more JSON stores onto this
// mechanism -- one table per store, INTEGER ms timestamps, UUID TEXT ids,
// FKs added by new migrations when both sides exist.
export const MIGRATIONS = [
  {
    version: 1,
    up(db) {
      db.exec(`
        CREATE TABLE worker_presets (
          id         TEXT PRIMARY KEY,
          name       TEXT NOT NULL,
          role       TEXT NOT NULL UNIQUE,
          app        TEXT NOT NULL,
          model      TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `);
    },
    // importLegacy(db) -- hook for the later JSON-store migration phases. A
    // migration that imports a legacy file defines it here; the runner calls
    // it inside the same transaction as up(): target tables empty AND legacy
    // file present -> tolerant parse -> INSERT. After the COMMIT succeeds the
    // caller renames the file to `.migrated`; if that rename fails it logs
    // and moves on -- the "don't import into a non-empty table" idempotence
    // guard is what protects the next boot, not the rename.
  },
];

// Runs pending migrations in order. Each one executes inside BEGIN IMMEDIATE
// with its user_version bump in the same transaction (SQLite DDL is
// transactional; user_version lives atomically in the DB header), so a failed
// migration leaves the DB exactly as before -- then we fail fast.
export function migrate(db, migrations = MIGRATIONS) {
  const current = Number(db.prepare('PRAGMA user_version').get().user_version);
  for (const m of migrations) {
    if (m.version <= current) continue;
    db.exec('BEGIN IMMEDIATE');
    try {
      m.up(db);
      if (typeof m.importLegacy === 'function') m.importLegacy(db);
      db.exec(`PRAGMA user_version = ${m.version}`);
      db.exec('COMMIT');
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch { /* transaction already unwound */ }
      throw new Error(`db migration v${m.version} failed: ${err.message}`);
    }
  }
}

export function getDb() {
  if (dbInstance) return dbInstance;
  if (typeof DatabaseSync !== 'function') {
    throw new Error('ccserver requires Node >= 22.13 (node:sqlite)');
  }
  const path = dbPath();
  if (path !== ':memory:') {
    try { mkdirSync(dirname(path), { recursive: true }); } catch { /* open will report */ }
  }
  const db = new DatabaseSync(path);
  applyPragmas(db);
  migrate(db);
  dbInstance = db;
  return dbInstance;
}

// Explicit startup init for index.js: same work as getDb(), but named for the
// boot-time contract -- a failure here must refuse the launch (log + exit(1)),
// not surface later as a 500 from some unrelated route.
export function initDb() {
  getDb();
}

// Test seam (and shutdown helper): closes the singleton so the next getDb()
// re-opens from disk -- how the "survives a restart" behavior is exercised
// in-process.
export function closeDb() {
  if (!dbInstance) return;
  const db = dbInstance;
  dbInstance = null;
  try { db.close(); } catch { /* best effort */ }
}

// Best-effort wrapper for the later phases' operational-state writes (the
// groups/schedules hot paths whose JSON persistence today swallows errors).
// Deliberately NOT used by user-facing CRUD: those must surface failures.
export function safeDb(fn, fallback) {
  try {
    return fn(getDb());
  } catch (err) {
    console.warn(`[db] operation failed (best-effort): ${err.message}`);
    return fallback;
  }
}
