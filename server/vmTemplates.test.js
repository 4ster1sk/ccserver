// VM templates (vmTemplates.js): CRUD on the vm_templates table, YAML
// cloud-config validation on save, the default pointer in settings, and what
// a launch resolves to.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDb, closeDb } from './db.js';
import {
  listVmTemplates, getVmTemplate, createVmTemplate, updateVmTemplate, deleteVmTemplate,
  getDefaultVmTemplateId, setDefaultVmTemplateId, resolveVmTemplate, parseTemplateCloudConfig,
} from './vmTemplates.js';

let tmpRoot;
const savedDbPath = process.env.CCSERVER_DB_PATH;

before(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'ccserver-vmtpl-'));
  process.env.CCSERVER_DB_PATH = join(tmpRoot, 'test.sqlite3');
});

after(() => {
  closeDb();
  if (savedDbPath === undefined) delete process.env.CCSERVER_DB_PATH;
  else process.env.CCSERVER_DB_PATH = savedDbPath;
  rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
  getDb().exec("DELETE FROM vm_templates; DELETE FROM settings WHERE scope = 'global'");
});

const base = { name: 'dev', memoryMiB: 4096, cpus: 2, diskGiB: 32, bootTimeoutSec: 120, cloudConfig: '' };

test('create / update / list / delete', () => {
  const t = createVmTemplate({ ...base, cloudConfig: '#cloud-config\npackages:\n  - htop\n' });
  assert.equal(t.name, 'dev');
  assert.equal(t.cloudConfig, '#cloud-config\npackages:\n  - htop\n', 'the YAML source is kept as typed');
  const u = updateVmTemplate(t.id, { ...base, name: 'dev2', cpus: 8 });
  assert.equal(u.name, 'dev2');
  assert.equal(u.cpus, 8);
  assert.deepEqual(listVmTemplates().map((x) => x.name), ['dev2']);
  deleteVmTemplate(t.id);
  assert.equal(getVmTemplate(t.id), null);
  assert.throws(() => deleteVmTemplate(t.id), (e) => e.code === 'not-found');
});

test('validation: resources in range, unique names, cloud-config rules', () => {
  const v = (body) => assert.throws(() => createVmTemplate(body), (e) => e.code === 'validation');
  v({ ...base, name: '' });
  v({ ...base, memoryMiB: 100 });
  v({ ...base, cpus: 1.5 });
  v({ ...base, diskGiB: 99999 });
  v({ ...base, bootTimeoutSec: '120' });
  v({ ...base, cloudConfig: 'users:\n  - name: x\n' });
  v({ ...base, cloudConfig: 'packages: [htop\n' });
  createVmTemplate(base);
  assert.throws(() => createVmTemplate(base), (e) => e.code === 'conflict');
});

test('parseTemplateCloudConfig: YAML errors and forbidden keys are reported', () => {
  assert.deepEqual(parseTemplateCloudConfig('  \n'), { ok: true, value: {} });
  assert.deepEqual(parseTemplateCloudConfig('runcmd:\n  - echo hi\n').value, { runcmd: ['echo hi'] });
  const bad = parseTemplateCloudConfig('a: 1\na: 2\n');
  assert.equal(bad.ok, false);
  assert.match(bad.errors[0], /^YAML: /);
  assert.match(parseTemplateCloudConfig('ssh_keys: {}\n').errors[0], /not allowed/);
});

test('default template: set, cleared on delete, resolved for launches', () => {
  assert.equal(resolveVmTemplate(null), null, 'no template at all -> config values');
  const a = createVmTemplate({ ...base, name: 'a', cloudConfig: 'packages: [htop]' });
  const b = createVmTemplate({ ...base, name: 'b', cpus: 4 });
  setDefaultVmTemplateId(a.id);
  assert.equal(getDefaultVmTemplateId(), a.id);
  assert.equal(resolveVmTemplate(null).template.id, a.id);
  assert.deepEqual(resolveVmTemplate(undefined).cloudConfig, { packages: ['htop'] });
  assert.equal(resolveVmTemplate(b.id).template.cpus, 4, 'an explicit pick wins over the default');
  assert.throws(() => setDefaultVmTemplateId('nope'), (e) => e.code === 'not-found');
  deleteVmTemplate(a.id);
  assert.equal(getDefaultVmTemplateId(), null);
  assert.equal(resolveVmTemplate(null), null);
  assert.throws(() => resolveVmTemplate(a.id), /has been deleted/, 'a deleted pick never falls back silently');
  setDefaultVmTemplateId(b.id);
  setDefaultVmTemplateId(null);
  assert.equal(getDefaultVmTemplateId(), null);
});

test('a stored config that no longer validates refuses the launch', () => {
  const t = createVmTemplate(base);
  getDb().prepare('UPDATE vm_templates SET cloud_config = ? WHERE id = ?').run('users: []\n', t.id);
  assert.throws(() => resolveVmTemplate(t.id), /invalid cloud-config/);
});

test('persistent: off by default, stored as given, must be a boolean', () => {
  const t = createVmTemplate(base);
  assert.equal(t.persistent, false);
  assert.equal(updateVmTemplate(t.id, { ...base, persistent: true }).persistent, true);
  assert.equal(getVmTemplate(t.id).persistent, true);
  assert.throws(() => createVmTemplate({ ...base, name: 'x', persistent: 'yes' }), /persistent must be true or false/);
});
