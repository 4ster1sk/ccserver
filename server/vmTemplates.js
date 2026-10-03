// QEMU VM templates: named resource sets (memory / cpus / disk / boot
// timeout), whether sessions share one persistent VM (persistent, see
// qemuVmPool.js), plus extra cloud-config for the qemu sandbox backend, managed from
// the Settings GUI (routes/vmTemplates.js). A session picks one through
// sandboxOpts.vmTemplateId; with none it gets the default template, and with
// no default either, sandbox.config.json's `qemu` values.
//
// Templates are read at launch only: a running VM keeps the resources and
// cloud-config it booted with, so editing or deleting a template never
// touches it (see settingsStore.js's configuration-model rule).
//
// cloud_config is stored as the YAML source the operator typed, and
// validated on save AND again at launch (the rules may have changed since it
// was saved).

import { randomUUID } from 'node:crypto';
import { parseDocument } from 'yaml';
import { getDb } from './db.js';
import { getSetting, setSetting, deleteSetting } from './settingsStore.js';
import { QEMU_RESOURCE_LIMITS, validateTemplateCloudConfig } from './ws/sandbox-qemu.js';

const DEFAULT_KEY = ['global', '', 'qemu.defaultTemplateId'];
const POOL_IDLE_KEY = ['global', '', 'qemu.poolIdleStopMinutes'];

// How long a persistent VM (qemuVmPool.js) stays up with no session
// attached before it is stopped.
export const POOL_IDLE_STOP_MINUTES = Object.freeze({ min: 1, max: 7 * 24 * 60, def: 120 });
const NAME_MAX = 64;
const CLOUD_CONFIG_MAX = 64 * 1024;

export class VmTemplateError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code; // 'validation' | 'not-found' | 'conflict'
  }
}

function rowToTemplate(r) {
  return {
    id: r.id,
    name: r.name,
    memoryMiB: r.memory_mib,
    cpus: r.cpus,
    diskGiB: r.disk_gib,
    bootTimeoutSec: r.boot_timeout_sec,
    cloudConfig: r.cloud_config,
    persistent: r.persistent === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// YAML source -> { ok, value } (validated cloud-config object) or
// { ok: false, errors }. An empty source is an empty config. A leading
// "#cloud-config" line is just a YAML comment.
export function parseTemplateCloudConfig(source) {
  if (typeof source !== 'string' || source.trim() === '') return { ok: true, value: {} };
  const doc = parseDocument(source, { prettyErrors: true, uniqueKeys: true });
  if (doc.errors.length) {
    return { ok: false, errors: doc.errors.map((e) => `YAML: ${e.message.split('\n')[0]}`) };
  }
  return validateTemplateCloudConfig(doc.toJS());
}

// Checks a POST/PUT body; returns the normalized fields or throws.
function normalizeInput(body) {
  if (!body || typeof body !== 'object') throw new VmTemplateError('validation', 'request body must be an object');
  const errors = [];
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name || name.length > NAME_MAX) errors.push(`name is required (max ${NAME_MAX} characters)`);
  const out = { name };
  for (const [k, { min, max }] of Object.entries(QEMU_RESOURCE_LIMITS)) {
    const v = body[k];
    if (!Number.isInteger(v) || v < min || v > max) errors.push(`${k} must be an integer between ${min} and ${max}`);
    out[k] = v;
  }
  const cloudConfig = body.cloudConfig ?? '';
  if (typeof cloudConfig !== 'string' || cloudConfig.length > CLOUD_CONFIG_MAX) {
    errors.push(`cloudConfig must be text (max ${CLOUD_CONFIG_MAX} bytes)`);
  } else {
    const parsed = parseTemplateCloudConfig(cloudConfig);
    if (!parsed.ok) errors.push(...parsed.errors.map((e) => `cloudConfig: ${e}`));
  }
  out.cloudConfig = cloudConfig;
  const persistent = body.persistent ?? false;
  if (typeof persistent !== 'boolean') errors.push('persistent must be true or false');
  out.persistent = persistent === true;
  if (errors.length) throw new VmTemplateError('validation', errors.join('\n'));
  return out;
}

function nameTaken(db, name, exceptId = null) {
  const row = db.prepare('SELECT id FROM vm_templates WHERE name = ?').get(name);
  return !!row && row.id !== exceptId;
}

export function listVmTemplates() {
  return getDb().prepare('SELECT * FROM vm_templates ORDER BY name').all().map(rowToTemplate);
}

export function getVmTemplate(id) {
  const row = getDb().prepare('SELECT * FROM vm_templates WHERE id = ?').get(id);
  return row ? rowToTemplate(row) : null;
}

export function createVmTemplate(body) {
  const t = normalizeInput(body);
  const db = getDb();
  if (nameTaken(db, t.name)) throw new VmTemplateError('conflict', `a template named "${t.name}" already exists`);
  const id = randomUUID();
  const now = Date.now();
  db.prepare(
    'INSERT INTO vm_templates (id, name, memory_mib, cpus, disk_gib, boot_timeout_sec, cloud_config, persistent, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(id, t.name, t.memoryMiB, t.cpus, t.diskGiB, t.bootTimeoutSec, t.cloudConfig, t.persistent ? 1 : 0, now, now);
  return getVmTemplate(id);
}

export function updateVmTemplate(id, body) {
  const db = getDb();
  if (!getVmTemplate(id)) throw new VmTemplateError('not-found', 'template not found');
  const t = normalizeInput(body);
  if (nameTaken(db, t.name, id)) throw new VmTemplateError('conflict', `a template named "${t.name}" already exists`);
  db.prepare(
    'UPDATE vm_templates SET name = ?, memory_mib = ?, cpus = ?, disk_gib = ?, boot_timeout_sec = ?, cloud_config = ?, persistent = ?, updated_at = ? WHERE id = ?',
  ).run(t.name, t.memoryMiB, t.cpus, t.diskGiB, t.bootTimeoutSec, t.cloudConfig, t.persistent ? 1 : 0, Date.now(), id);
  return getVmTemplate(id);
}

export function deleteVmTemplate(id) {
  const removed = getDb().prepare('DELETE FROM vm_templates WHERE id = ?').run(id).changes > 0;
  if (!removed) throw new VmTemplateError('not-found', 'template not found');
  if (getDefaultVmTemplateId() === id) deleteSetting(...DEFAULT_KEY);
}

// The default template's id, or null (none set, or it no longer exists).
export function getDefaultVmTemplateId() {
  const id = getSetting(...DEFAULT_KEY, null);
  return typeof id === 'string' && getVmTemplate(id) ? id : null;
}

export function setDefaultVmTemplateId(id) {
  if (id === null) {
    deleteSetting(...DEFAULT_KEY);
    return;
  }
  if (typeof id !== 'string' || !getVmTemplate(id)) throw new VmTemplateError('not-found', 'template not found');
  setSetting(...DEFAULT_KEY, id);
}

// What a qemu launch uses. requestedId: sandboxOpts.vmTemplateId (a string,
// or null/undefined for "the default"). Returns null when there is neither a
// requested nor a default template (the caller uses sandbox.config.json's
// values), else { template, cloudConfig } with the parsed config. A requested
// template that no longer exists, or whose stored config no longer validates,
// fails the launch rather than silently booting something else.
export function resolveVmTemplate(requestedId) {
  const explicit = typeof requestedId === 'string' && requestedId !== '';
  const id = explicit ? requestedId : getDefaultVmTemplateId();
  if (!id) return null;
  const template = getVmTemplate(id);
  if (!template) throw new Error('the selected VM template has been deleted; pick another one in the launch options');
  const parsed = parseTemplateCloudConfig(template.cloudConfig);
  if (!parsed.ok) throw new Error(`VM template "${template.name}" has an invalid cloud-config: ${parsed.errors.join('; ')}`);
  return { template, cloudConfig: parsed.value };
}

export function getPoolIdleStopMinutes() {
  const v = getSetting(...POOL_IDLE_KEY, null);
  const { min, max, def } = POOL_IDLE_STOP_MINUTES;
  return Number.isInteger(v) && v >= min && v <= max ? v : def;
}

export function setPoolIdleStopMinutes(minutes) {
  const { min, max } = POOL_IDLE_STOP_MINUTES;
  if (!Number.isInteger(minutes) || minutes < min || minutes > max) {
    throw new VmTemplateError('validation', `idleStopMinutes must be an integer between ${min} and ${max}`);
  }
  setSetting(...POOL_IDLE_KEY, minutes);
}
