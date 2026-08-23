import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { dbPath, getDb, initDb, closeDb, migrate, safeDb } from './db.js';

let tmpRoot;
const savedEnv = process.env.CCSERVER_DB_PATH;

before(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'ccserver-db-'));
  process.env.CCSERVER_DB_PATH = join(tmpRoot, 'test.sqlite3');
});

after(() => {
  closeDb();
  if (savedEnv === undefined) delete process.env.CCSERVER_DB_PATH;
  else process.env.CCSERVER_DB_PATH = savedEnv;
  rmSync(tmpRoot, { recursive: true, force: true });
});

test('fresh open runs migrations to the latest version', () => {
  closeDb();
  const db = getDb();
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 1);
  // The v1 table exists and is usable.
  db.prepare('INSERT INTO worker_presets (id, name, role, app, model, created_at, updated_at) VALUES (?,?,?,?,?,?,?)')
    .run('x', 'n', 'workerX', 'claude', null, 1, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM worker_presets').get().c, 1);
});

test('reopening is idempotent (migrations do not re-apply) and data survives', () => {
  closeDb();
  getDb(); // first open creates + migrates
  closeDb();
  const db = getDb(); // second open
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM worker_presets').get().c, 1, 'row from the previous handle is still there');
  // Re-running migrate() directly is a no-op once user_version matches.
  assert.doesNotThrow(() => migrate(db));
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 1);
});

test('pragmas are applied on open', () => {
  const db = getDb();
  assert.match(String(db.prepare('PRAGMA journal_mode').get().journal_mode), /wal/);
  assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  // NORMAL = 1
  assert.equal(db.prepare('PRAGMA synchronous').get().synchronous, 1);
  assert.equal(db.prepare('PRAGMA busy_timeout').get().timeout, 5000);
});

test('initDb() resolves the same singleton as getDb()', () => {
  closeDb();
  initDb();
  assert.equal(getDb(), getDb(), 'both entry points share one instance per generation');
});

test('dbPath() defaults to the repo root and honors CCSERVER_DB_PATH', () => {
  const saved = process.env.CCSERVER_DB_PATH;
  try {
    delete process.env.CCSERVER_DB_PATH;
    assert.ok(dbPath().endsWith(join('server', '..', 'ccserver.sqlite3')) || /[\\/]ccserver\.sqlite3$/.test(dbPath()), 'default is <repo>/ccserver.sqlite3');
    process.env.CCSERVER_DB_PATH = '/tmp/somewhere/x.sqlite3';
    assert.equal(dbPath(), '/tmp/somewhere/x.sqlite3');
  } finally {
    if (saved === undefined) delete process.env.CCSERVER_DB_PATH;
    else process.env.CCSERVER_DB_PATH = saved;
  }
});

test('a failing migration throws, rolls back, and leaves no partial schema', () => {
  const db = new DatabaseSync(':memory:');
  const badMigrations = [
    {
      version: 1,
      up(d) {
        d.exec('CREATE TABLE should_rollback (id TEXT)');
        d.exec('CREATE TABLE definitely_broken (');
      },
    },
  ];
  assert.throws(() => migrate(db, badMigrations), /^Error: db migration v1 failed:/);
  assert.equal(Number(db.prepare('PRAGMA user_version').get().user_version), 0, 'user_version bump rolled back with the migration');
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='should_rollback'").all();
  assert.equal(tables.length, 0, 'DDL from the failed migration was rolled back');
});

test('a failing importLegacy hook aborts its migration transaction too', () => {
  const db = new DatabaseSync(':memory:');
  assert.throws(() => migrate(db, [
    {
      version: 1,
      up(d) { d.exec('CREATE TABLE t (id TEXT)'); },
      importLegacy() { throw new Error('legacy file unreadable'); },
    },
  ]), /db migration v1 failed: legacy file unreadable/);
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='t'").all().length, 0);
});

test('safeDb returns the fn result on success and the fallback on failure', () => {
  closeDb();
  assert.equal(safeDb((db) => db.prepare('PRAGMA user_version').get().user_version, -1), 1, 'first call initializes the DB');
  assert.equal(safeDb(() => { throw new Error('boom'); }, 'fb'), 'fb');
});
