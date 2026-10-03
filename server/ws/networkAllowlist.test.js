// Store boundary for the network-isolation settings GUI: validation,
// normalization, and read-modify-write preservation of the rest of
// sandbox.config.json. Runs against a throwaway CCSERVER_SANDBOX_CONFIG so
// the host's real config is never touched (same precedent as
// sandbox-config.test.js).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getNetworkSettings, updateNetworkSettings, resolveSandboxConfigPath } from './networkAllowlist.js';
import { isHostAllowed, isHostDenied, isHostMatched, normalizeAllowedHosts } from './networkAllowlist.js';

let tmpRoot;
let cfgPath;
let prevConfig;

before(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'ccserver-network-allowlist-'));
  cfgPath = join(tmpRoot, 'sandbox.config.json');
  prevConfig = process.env.CCSERVER_SANDBOX_CONFIG;
  process.env.CCSERVER_SANDBOX_CONFIG = cfgPath;
});

after(() => {
  if (prevConfig === undefined) delete process.env.CCSERVER_SANDBOX_CONFIG;
  else process.env.CCSERVER_SANDBOX_CONFIG = prevConfig;
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

function writeRaw(obj) {
  writeFileSync(cfgPath, JSON.stringify(obj));
}

test('resolveSandboxConfigPath honors CCSERVER_SANDBOX_CONFIG', () => {
  assert.equal(resolveSandboxConfigPath(), cfgPath);
});

test('getNetworkSettings defaults on a missing file', () => {
  try { rmSync(cfgPath, { force: true }); } catch { /* ignore */ }
  assert.deepEqual(getNetworkSettings(), { mode: 'enforce', allowedHosts: [], deniedHosts: [] });
});

test('getNetworkSettings mirrors loadSandboxConfig parsing', () => {
  writeRaw({ network: { mode: 'audit', allowedHosts: ['api.example.com', 42, null, ''], deniedHosts: ['evil.example', 42, null, ''] } });
  assert.deepEqual(getNetworkSettings(), { mode: 'audit', allowedHosts: ['api.example.com'], deniedHosts: ['evil.example'] });
});

test('getNetworkSettings ignores the retired isolate/initialState keys', () => {
  writeRaw({ network: { isolate: true, initialState: 'enforce' } });
  assert.deepEqual(getNetworkSettings(), { mode: 'enforce', allowedHosts: [], deniedHosts: [] });
});

test('updateNetworkSettings creates the file and normalizes entries', () => {
  try { rmSync(cfgPath, { force: true }); } catch { /* ignore */ }
  const res = updateNetworkSettings({ mode: 'audit', allowedHosts: ['  API.Example.COM ', '.example.net', 'api.example.com'], deniedHosts: ['  Evil.Example ', '.tracker.example'] });
  assert.equal(res.ok, true);
  assert.deepEqual(res.settings, { mode: 'audit', allowedHosts: ['api.example.com', '.example.net'], deniedHosts: ['evil.example', '.tracker.example'] });
  const onDisk = JSON.parse(readFileSync(cfgPath, 'utf-8'));
  assert.deepEqual(onDisk.network.allowedHosts, ['api.example.com', '.example.net']);
  assert.deepEqual(onDisk.network.deniedHosts, ['evil.example', '.tracker.example']);
});

test('updateNetworkSettings is partial and preserves other keys', () => {
  writeRaw({ '//note': 'keep me', docker: false, network: { mode: 'enforce', allowedHosts: ['a.example'] } });
  const res = updateNetworkSettings({ allowedHosts: ['b.example'] });
  assert.equal(res.ok, true);
  const onDisk = JSON.parse(readFileSync(cfgPath, 'utf-8'));
  assert.equal(onDisk['//note'], 'keep me', 'comment keys survive');
  assert.equal(onDisk.docker, false, 'unrelated keys survive');
  assert.deepEqual(onDisk.network, { mode: 'enforce', allowedHosts: ['b.example'] }, 'unpatched keys stay untouched on disk');
});

test('updateNetworkSettings rejects bad mode/list', () => {
  writeRaw({});
  for (const patch of [
    { mode: 'sometimes' },
    { allowedHosts: 'api.example.com' },
    { allowedHosts: ['https://api.example.com'] },
    { allowedHosts: ['api.example.com:443'] },
    { allowedHosts: ['*.example.com'] },
    { allowedHosts: ['not a host'] },
    { allowedHosts: [''] },
    { deniedHosts: 'evil.example' },
    { deniedHosts: ['https://evil.example'] },
    { deniedHosts: ['*.evil.example'] },
    { deniedHosts: ['not a host'] },
    null,
    42,
  ]) {
    const res = updateNetworkSettings(patch);
    assert.equal(res.ok, false, `must reject ${JSON.stringify(patch)}`);
    assert.equal(res.code, 'validation');
  }
  // Rejected writes change nothing on disk.
  assert.deepEqual(JSON.parse(readFileSync(cfgPath, 'utf-8')), {});
});

test('updateNetworkSettings refuses a corrupt file instead of overwriting it', () => {
  writeFileSync(cfgPath, '{ not json');
  const res = updateNetworkSettings({ allowedHosts: ['a.example'] });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'internal');
  assert.equal(readFileSync(cfgPath, 'utf-8'), '{ not json', 'corrupt file left untouched');
});

// --- host matching + allow-list normalization (pure) -------------------------

test('isHostAllowed: exact match', () => {
  assert.equal(isHostAllowed('api.example.com', ['api.example.com']), true);
  assert.equal(isHostAllowed('api.example.com', ['API.EXAMPLE.COM']), true, 'case-insensitive');
  assert.equal(isHostAllowed('other.example.com', ['api.example.com']), false);
});

test('isHostAllowed: leading-dot suffix matches the domain and its subdomains', () => {
  assert.equal(isHostAllowed('example.com', ['.example.com']), true);
  assert.equal(isHostAllowed('api.example.com', ['.example.com']), true);
  assert.equal(isHostAllowed('deep.api.example.com', ['.example.com']), true);
  assert.equal(isHostAllowed('notexample.com', ['.example.com']), false, 'must not match a bare suffix without the dot boundary');
  assert.equal(isHostAllowed('example.com.attacker.example', ['.example.com']), false);
});

test('isHostAllowed: fails closed on empty/malformed input', () => {
  assert.equal(isHostAllowed('api.example.com', []), false);
  assert.equal(isHostAllowed('api.example.com', undefined), false);
  assert.equal(isHostAllowed('api.example.com', [null, 42, '']), false);
  assert.equal(isHostAllowed('', ['api.example.com']), false);
  assert.equal(isHostAllowed(null, ['api.example.com']), false);
});

// testdata/host-policy.json is a copy of ccserver-netbroker's
// testdata/host-policy.json (keep them identical): both implementations
// run the same cases, so the
// qemu backend's Go broker and this module cannot drift on what a host entry
// means or matches.

const HOST_POLICY_FIXTURE = JSON.parse(readFileSync(new URL('./testdata/host-policy.json', import.meta.url), 'utf-8'));

test('shared fixture: normalizeAllowedHosts matches ccserver-netbroker/policy', () => {
  for (const c of HOST_POLICY_FIXTURE.normalize) {
    assert.deepEqual(normalizeAllowedHosts(c.input), { hosts: c.hosts, rejected: c.rejected });
  }
});

test('shared fixture: isHostMatched matches ccserver-netbroker/policy', () => {
  for (const c of HOST_POLICY_FIXTURE.match) {
    assert.equal(isHostMatched(c.host, c.list), c.want, `${c.host} vs ${JSON.stringify(c.list)}`);
  }
});

test('isHostDenied: same exact-or-leading-dot syntax as the allow-list', () => {
  assert.equal(isHostDenied('evil.example', ['evil.example']), true);
  assert.equal(isHostDenied('sub.evil.example', ['.evil.example']), true);
  assert.equal(isHostDenied('evil.example', ['.evil.example']), true);
  assert.equal(isHostDenied('not-evil.example', ['.evil.example']), false);
  assert.equal(isHostMatched('a.example', ['a.example']), true, 'shared matcher');
  assert.equal(isHostDenied('a.example', []), false);
});
