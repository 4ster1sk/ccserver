import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  normalizeLaunchPresetInput,
  normalizePresetWorker,
  listLaunchPresets,
  getLaunchPreset,
  createLaunchPreset,
  updateLaunchPreset,
  deleteLaunchPreset,
} from './launchPresets.js';
import { closeDb } from '../db.js';

let tmpRoot;
const MAX_WORKERS = 7; // mirrors routes/groups.js's MAX_WORKERS

const validBody = (name) => ({
  name,
  orchestratorApp: 'claude',
  orchestratorModel: null,
  instructions: 'まず plan を publish_doc してから着手してください',
  workers: [
    { name: '実装担当', role: `workerImpl${suffix()}`, app: 'codex', model: 'gpt-5.4', sandboxOpts: { gpg: true, sshAgent: false } },
    { role: `workerRev${suffix()}`, app: 'opencode' },
  ],
});

let counter = 0;
function suffix() {
  return `${Date.now().toString(36)}${(counter++).toString(36)}`;
}

before(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'ccserver-launch-presets-'));
  process.env.CCSERVER_DB_PATH = join(tmpRoot, 'launch-presets.sqlite3');
});

after(() => {
  closeDb();
  delete process.env.CCSERVER_DB_PATH;
  rmSync(tmpRoot, { recursive: true, force: true });
});

test('normalizePresetWorker requires an app and reuses the shared rules', () => {
  const ok = normalizePresetWorker({ role: 'workerSolo', app: 'claude' });
  assert.equal(ok.ok, true);
  assert.equal(ok.value.name, null, 'missing name -> null (role label fallback)');
  assert.deepEqual(ok.value.sandboxOpts, { gpg: false, sshAgent: false });

  for (const bad of [
    { role: 'workerX' },                       // app required in presets
    { role: 'workerX', app: 'copilot' },       // copilot refused
    { role: 'orchestrator', app: 'claude' },   // bad role
    { app: 'claude' },                         // role required
    { role: 'workerX', app: 'claude', model: 5 },
  ]) {
    assert.equal(normalizePresetWorker(bad).ok, false, JSON.stringify(bad));
  }
});

test('normalizeLaunchPresetInput validates the full payload', () => {
  const n = normalizeLaunchPresetInput(validBody('ok preset'), { maxWorkers: MAX_WORKERS });
  assert.equal(n.ok, true);
  assert.equal(n.value.workers.length, 2);
  assert.deepEqual(n.value.workers.map((w) => w.position), [0, 1]);
  assert.equal(n.value.workers[0].sandboxOpts.gpg, true);
  assert.equal(n.value.workers[1].name, null);

  for (const [label, body] of Object.entries({
    'no name': { ...validBody('x'), name: '' },
    'no workers': { ...validBody('x'), workers: [] },
    'workers too many': { ...validBody('x'), workers: Array.from({ length: MAX_WORKERS + 1 }, (_, i) => ({ role: `workerW${i}${suffix()}`, app: 'claude' })) },
    'dup roles': { ...validBody('x'), workers: [{ role: 'workerDup', app: 'claude' }, { role: 'workerDup', app: 'codex' }] },
    'bad orchestratorApp': { ...validBody('x'), orchestratorApp: 'copilot' },
    'instructions too long': { ...validBody('x'), instructions: 'a'.repeat(8 * 1024 + 1) },
    'workers not array': { ...validBody('x'), workers: 'two' },
  })) {
    assert.equal(normalizeLaunchPresetInput(body, { maxWorkers: MAX_WORKERS }).ok, false, label);
  }
});

test('create/get round-trip stores nested workers with positions and flags', () => {
  const res = createLaunchPreset(validBody('実装+レビュー'), { maxWorkers: MAX_WORKERS });
  assert.equal(res.ok, true, JSON.stringify(res));
  const p = res.preset;
  assert.match(p.id, /^[0-9a-f-]{36}$/);
  assert.equal(p.orchestratorApp, 'claude');
  assert.equal(p.instructions.includes('publish_doc'), true);
  assert.equal(p.workers.length, 2);
  assert.equal(p.workers[0].position, 0);
  assert.equal(p.workers[0].sandboxOpts.gpg, true);
  assert.equal(p.workers[1].app, 'opencode');

  const fetched = getLaunchPreset(p.id);
  assert.equal(fetched.ok, true);
  assert.deepEqual(fetched.preset, p, 'get returns the identical nested shape');

  const list = listLaunchPresets();
  assert.equal(list.ok, true);
  assert.ok(list.presets.some((x) => x.id === p.id), 'listed');
});

test('duplicate preset names are refused with duplicate-name', () => {
  const body = validBody(`combo ${suffix()}`);
  assert.equal(createLaunchPreset(body, { maxWorkers: MAX_WORKERS }).ok, true);
  const dup = createLaunchPreset({ ...validBody('other'), name: body.name }, { maxWorkers: MAX_WORKERS });
  assert.equal(dup.ok, false);
  assert.equal(dup.code, 'duplicate-name');
  assert.match(dup.message, /already exists/);
});

test('update replaces the whole snapshot (workers included) atomically', async () => {
  const created = createLaunchPreset(validBody(`upd ${suffix()}`), { maxWorkers: MAX_WORKERS }).preset;
  await new Promise((r) => setTimeout(r, 5));
  const newRole = `workerNew${suffix()}`;
  const res = updateLaunchPreset(created.id, {
    name: created.name,
    orchestratorApp: 'codex',
    instructions: null,
    workers: [{ role: newRole, app: 'claude', sandboxOpts: { gpg: false, sshAgent: true } }],
  }, { maxWorkers: MAX_WORKERS });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.preset.updatedAt > created.updatedAt, true, 'updated_at bumped');
  assert.equal(res.preset.orchestratorApp, 'codex');
  assert.equal(res.preset.instructions, null);
  assert.equal(res.preset.workers.length, 1, 'old worker rows replaced');
  assert.equal(res.preset.workers[0].role, newRole);
  assert.equal(res.preset.workers[0].sandboxOpts.sshAgent, true);

  // Renaming onto another preset's name is duplicate-name...
  const other = createLaunchPreset(validBody(`other ${suffix()}`), { maxWorkers: MAX_WORKERS }).preset;
  const clash = updateLaunchPreset(created.id, { ...validBody(created.name.replace(/.*/, 'x')), name: other.name }, { maxWorkers: MAX_WORKERS });
  assert.equal(clash.code, 'duplicate-name');

  // ...and a failed rename must not have clobbered the snapshot.
  const intact = getLaunchPreset(created.id);
  assert.equal(intact.preset.workers[0].role, newRole);

  assert.equal(updateLaunchPreset('no-such-id', validBody('x'), { maxWorkers: MAX_WORKERS }).code, 'not-found');
});

test('delete removes the preset and its workers', () => {
  const created = createLaunchPreset(validBody(`del ${suffix()}`), { maxWorkers: MAX_WORKERS }).preset;
  assert.equal(deleteLaunchPreset(created.id).ok, true);
  assert.equal(getLaunchPreset(created.id).code, 'not-found');
  assert.equal(deleteLaunchPreset(created.id).code, 'not-found');
});

test('presets survive closeDb + reopen (restart simulation)', () => {
  const body = validBody(`persist ${suffix()}`);
  const created = createLaunchPreset(body, { maxWorkers: MAX_WORKERS }).preset;
  closeDb();
  const found = getLaunchPreset(created.id);
  assert.equal(found.ok, true);
  assert.deepEqual(found.preset, created, 'identical nested content after reopen');
});
