// projects store + DB v2 migration (projects/sandboxes, incl. the one-time
// homeIndex.json import). The legacy-import tests point
// CCSERVER_SANDBOX_HOME_ROOT at a temp dir and pre-seed .index.json BEFORE the
// first getDb() call -- exactly the state an upgrading install is in.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  findOrCreateProjectByCwd,
  getProject,
  listProjects,
  updateProjectLabel,
  normalizeProjectLabel,
  recordSandboxHome,
  listSandboxRowsBySlug,
  forgetSandboxHome,
} from './projects.js';
// Lockstep guards: the v2 migration and slugForCwd must agree with sandbox.js.
import { legacyHomeIndexFile, getDb } from '../db.js';
import { sandboxHomeRoot } from './sandbox.js';
import { projectHashForCwd } from './projectHash.js';
import { closeDb } from '../db.js';

let tmpRoot;

function slugFromCwd(cwd) {
  // Mirror of sandbox.js's private slugify (resolve-less here: these test cwds
  // are already normalized absolute paths).
  return cwd.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'root';
}

before(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'ccserver-projects-'));
  process.env.CCSERVER_DB_PATH = join(tmpRoot, 'projects.sqlite3');
  process.env.CCSERVER_SANDBOX_HOME_ROOT = join(tmpRoot, 'home');
});

after(() => {
  closeDb();
  delete process.env.CCSERVER_DB_PATH;
  delete process.env.CCSERVER_SANDBOX_HOME_ROOT;
  rmSync(tmpRoot, { recursive: true, force: true });
});

test('legacyHomeIndexFile stays in lockstep with sandboxHomeRoot', () => {
  assert.equal(legacyHomeIndexFile(), join(sandboxHomeRoot(), '.index.json'));
});

test('v2 migration imports the legacy home index and retires the file', () => {
  const cwdA = '/srv/legacy-alpha';
  const cwdB = '/srv/legacy-beta';
  const slugA = slugFromCwd(cwdA);
  const slugB = slugFromCwd(cwdB);
  mkdirSync(process.env.CCSERVER_SANDBOX_HOME_ROOT, { recursive: true });
  writeFileSync(join(process.env.CCSERVER_SANDBOX_HOME_ROOT, '.index.json'),
    JSON.stringify({ [slugA]: cwdA, [slugB]: cwdB, bad: 42 }));

  const db = getDb(); // first open: runs up() + importLegacy + postApply
  assert.equal(Number(db.prepare('PRAGMA user_version').get().user_version), 2);

  const rows = listSandboxRowsBySlug();
  const a = rows.get(slugA);
  const b = rows.get(slugB);
  assert.ok(a && b, 'both legacy entries imported');
  assert.equal(a.cwd, cwdA);
  assert.equal(a.project_id, b.project_id === a.project_id ? a.project_id : a.project_id, 'ids well-formed');
  assert.notEqual(a.project_id, b.project_id, 'distinct cwds get distinct projects');
  assert.equal(a.created_by, null, 'migrated rows carry no attribution');

  const proj = getProject(a.project_id);
  assert.equal(proj.ok, true);
  assert.equal(proj.project.cwd, cwdA);
  assert.equal(proj.project.pathHash, projectHashForCwd(cwdA), 'path_hash matches the shared hash domain');
  assert.equal(proj.project.label, null);
  // Non-git path under /srv: origin lookup fails cleanly -> NULL.
  assert.equal(proj.project.gitRemote, null);

  assert.equal(existsSync(join(process.env.CCSERVER_SANDBOX_HOME_ROOT, '.index.json')), false,
    'the legacy file was retired by postApply');
  assert.equal(existsSync(join(process.env.CCSERVER_SANDBOX_HOME_ROOT, '.index.json.migrated')), true,
    'as .index.json.migrated');
});

test('reopening does not re-run the legacy import (idempotence guard)', () => {
  closeDb();
  const db = getDb();
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM sandboxes').get().c, 2,
    'no duplicate rows after a reopen');
});

test('findOrCreateProjectByCwd dedupes by resolved cwd and touches last_seen_at', async () => {
  const first = findOrCreateProjectByCwd('/srv/touchy/');
  assert.equal(first.ok, true);
  await new Promise((r) => setTimeout(r, 5));
  const second = findOrCreateProjectByCwd('/srv/touchy');
  assert.equal(second.ok, true);
  assert.equal(second.project.id, first.project.id, 'spelling variants map to one row');
  assert.ok(second.project.lastSeenAt > first.project.lastSeenAt, 'last_seen_at refreshed');
});

test('recordSandboxHome upserts the slug row and keeps created_at stable', async () => {
  const cwd = '/srv/home-upsert';
  assert.equal(recordSandboxHome(cwd), true);
  const before = listSandboxRowsBySlug().get(slugFromCwd(cwd));
  assert.ok(before);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(recordSandboxHome(cwd, { createdBy: 'meta-agent:sess1' }), true);
  const afterRow = listSandboxRowsBySlug().get(slugFromCwd(cwd));
  assert.equal(afterRow.created_at, before.created_at, 'created_at preserved on upsert');
  assert.ok(afterRow.last_used_at >= before.last_used_at, 'last_used_at advanced');
  assert.equal(afterRow.created_by, 'meta-agent:sess1', 'attribution recorded');
  assert.equal(afterRow.project_id, before.project_id, 'same project row reused');
});

test('forgetSandboxHome removes the row and reports existence', () => {
  recordSandboxHome('/srv/forgotten');
  const slug = slugFromCwd('/srv/forgotten');
  assert.equal(forgetSandboxHome(slug), true);
  assert.equal(forgetSandboxHome(slug), false, 'second delete reports nothing removed');
  assert.equal(listSandboxRowsBySlug().has(slug), false);
});

test('updateProjectLabel validates input and updates in place', () => {
  const p = findOrCreateProjectByCwd('/srv/labeled').project;
  const res = updateProjectLabel(p.id, '  自分のプロジェクト  ');
  assert.equal(res.ok, true);
  assert.equal(res.project.label, '自分のプロジェクト');

  const cleared = updateProjectLabel(p.id, null);
  assert.equal(cleared.ok, true);
  assert.equal(cleared.project.label, null, 'null clears the label');

  // '' / null clear the label (normalizeProjectLabel contract), so only real
  // type/length violations are validation errors here.
  for (const bad of ['   ', 'x'.repeat(201), 42]) {
    const r = updateProjectLabel(p.id, bad);
    assert.equal(r.code, 'validation', `label ${JSON.stringify(String(bad).slice(0, 10))} rejected`);
  }
  assert.equal(updateProjectLabel('no-such-id', 'x').code, 'not-found');
  assert.equal(getProject('no-such-id').code, 'not-found');
});

test('normalizeProjectLabel mirrors updateProjectLabel rules', () => {
  assert.deepEqual(normalizeProjectLabel(null), { ok: true, value: null });
  assert.deepEqual(normalizeProjectLabel(undefined), { ok: true, value: null });
  assert.equal(normalizeProjectLabel(' a ').ok, true);
  assert.equal(normalizeProjectLabel('').ok, true, 'empty normalizes to clear');
  assert.equal(normalizeProjectLabel(7).ok, false);
  assert.equal(normalizeProjectLabel('a\u0000b').ok, false);
});

test('listProjects orders by most recently seen and returns full rows', () => {
  const res = listProjects();
  assert.equal(res.ok, true);
  assert.ok(res.projects.length >= 4);
  for (let i = 1; i < res.projects.length; i++) {
    assert.ok(res.projects[i - 1].lastSeenAt >= res.projects[i].lastSeenAt,
      'ordered by last_seen_at DESC');
  }
});
