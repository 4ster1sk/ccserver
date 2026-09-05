// Unit tests for the OpenCode Go usage reader. The pure mapping
// (mapGoUsage/extractGoKey) plus the toggle/key gating are covered here.
// getOpencodeUsage()'s success path stubs the global fetch -- no real
// request to opencode.ai ever leaves the process. Never touches the real
// ~/.local/share/opencode/auth.json: XDG_DATA_HOME and
// CCSERVER_SANDBOX_CONFIG are pinned to temp dirs (and OPENCODE_AUTH_CONTENT
// is cleared) for the whole file.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  extractGoKey,
  mapGoUsage,
  opencodeGoEnabled,
  opencodeGoAvailable,
  readOpencodeGoKey,
  getOpencodeUsage,
} from './opencodeUsage.js';

let tmpRoot;
let cfgPath;
let dataHome;
let prevConfigEnv;
let prevDataHome;
let prevAuthContent;
let prevGoUsageEnv;
let origFetch;

const VALID_PAYLOAD = {
  usage: {
    rolling: { status: 'ok', percent: 4, resetsAt: '2026-08-13T16:27:38.287Z' },
    weekly: { status: 'ok', percent: 3, resetsAt: '2026-08-17T00:00:00.287Z' },
    monthly: { status: 'ok', percent: 1, resetsAt: '2026-09-13T06:06:01.287Z' },
  },
};

function writeConfig(obj) {
  writeFileSync(cfgPath, JSON.stringify(obj));
}

function writeAuthKey(key = 'test-key') {
  mkdirSync(join(dataHome, 'opencode'), { recursive: true });
  writeFileSync(join(dataHome, 'opencode', 'auth.json'), JSON.stringify({ 'opencode-go': { type: 'api', key } }));
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'ccserver-opencode-usage-'));
  cfgPath = join(tmpRoot, 'sandbox.config.json');
  dataHome = join(tmpRoot, 'data-home');
  writeConfig({});
  prevConfigEnv = process.env.CCSERVER_SANDBOX_CONFIG;
  prevDataHome = process.env.XDG_DATA_HOME;
  prevAuthContent = process.env.OPENCODE_AUTH_CONTENT;
  prevGoUsageEnv = process.env.CCSERVER_OPENCODE_GO_USAGE;
  process.env.CCSERVER_SANDBOX_CONFIG = cfgPath;
  process.env.XDG_DATA_HOME = dataHome;
  delete process.env.OPENCODE_AUTH_CONTENT;
  delete process.env.CCSERVER_OPENCODE_GO_USAGE;
  origFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = origFetch;
  if (prevConfigEnv === undefined) delete process.env.CCSERVER_SANDBOX_CONFIG;
  else process.env.CCSERVER_SANDBOX_CONFIG = prevConfigEnv;
  if (prevDataHome === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = prevDataHome;
  if (prevAuthContent === undefined) delete process.env.OPENCODE_AUTH_CONTENT;
  else process.env.OPENCODE_AUTH_CONTENT = prevAuthContent;
  if (prevGoUsageEnv === undefined) delete process.env.CCSERVER_OPENCODE_GO_USAGE;
  else process.env.CCSERVER_OPENCODE_GO_USAGE = prevGoUsageEnv;
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

test('extractGoKey: api entry yields its key', () => {
  assert.equal(extractGoKey({ 'opencode-go': { type: 'api', key: 'k123' } }), 'k123');
});

test('extractGoKey: missing entry, wrong type, empty key, null input -> null', () => {
  assert.equal(extractGoKey({}), null);
  assert.equal(extractGoKey({ 'opencode-go': { type: 'oauth', key: 'k' } }), null);
  assert.equal(extractGoKey({ 'opencode-go': { type: 'api', key: '' } }), null);
  assert.equal(extractGoKey({ 'opencode-go': { type: 'api' } }), null);
  assert.equal(extractGoKey(null), null);
  assert.equal(extractGoKey('nope'), null);
});

test('mapGoUsage: three windows map to the shared shape', () => {
  const result = mapGoUsage(VALID_PAYLOAD);
  assert.equal(result.plan, 'OpenCode Go');
  assert.equal(result.cost, null);
  assert.equal(result.limits.length, 3);

  const [rolling, weekly, monthly] = result.limits;
  assert.equal(rolling.label, '5時間');
  assert.equal(rolling.pct, 4);
  assert.equal(rolling.resetAt, Date.parse('2026-08-13T16:27:38.287Z'));
  assert.equal(rolling.windowMs, 5 * 3600 * 1000);
  assert.equal(typeof rolling.resets, 'string');

  assert.equal(weekly.label, '週次');
  assert.equal(weekly.pct, 3);
  assert.equal(weekly.windowMs, 7 * 24 * 3600 * 1000);

  // monthly anchors on the subscription anniversary: no fixed window,
  // so no pace marker client-side.
  assert.equal(monthly.label, '月次');
  assert.equal(monthly.pct, 1);
  assert.equal(monthly.windowMs, null);
});

test('mapGoUsage: null/invalid payload -> empty limits, null plan/cost', () => {
  assert.deepEqual(mapGoUsage(null), { limits: [], cost: null, plan: null });
  assert.deepEqual(mapGoUsage({}), { limits: [], cost: null, plan: null });
  assert.deepEqual(mapGoUsage({ usage: null }), { limits: [], cost: null, plan: null });
});

test('mapGoUsage: malformed windows are skipped', () => {
  const result = mapGoUsage({
    usage: {
      rolling: { status: 'ok', percent: 120, resetsAt: '2026-08-13T16:27:38.287Z' }, // out of range
      weekly: { status: 'weird', percent: 3, resetsAt: '2026-08-17T00:00:00.287Z' }, // bad status
      monthly: { status: 'ok', percent: 1, resetsAt: 'not-a-date' }, // bad resetsAt
    },
  });
  assert.equal(result.limits.length, 0);
  assert.equal(result.plan, null);
});

test('mapGoUsage: rate-limited window is still surfaced with its pct', () => {
  const result = mapGoUsage({
    usage: {
      rolling: { status: 'rate-limited', percent: 100, resetsAt: '2026-08-13T16:27:38.287Z' },
      weekly: { status: 'ok', percent: 3, resetsAt: '2026-08-17T00:00:00.287Z' },
      monthly: { status: 'ok', percent: 1, resetsAt: '2026-09-13T06:06:01.287Z' },
    },
  });
  assert.equal(result.limits.length, 3);
  assert.equal(result.limits[0].pct, 100);
});

test('opencodeGoEnabled: default on; file false disables; env wins both ways', () => {
  assert.equal(opencodeGoEnabled(), true);
  writeConfig({ opencodeGoUsage: false });
  assert.equal(opencodeGoEnabled(), false);
  process.env.CCSERVER_OPENCODE_GO_USAGE = '1';
  assert.equal(opencodeGoEnabled(), true);
  writeConfig({ opencodeGoUsage: true });
  process.env.CCSERVER_OPENCODE_GO_USAGE = '0';
  assert.equal(opencodeGoEnabled(), false);
  // Unrecognized env falls back to the file.
  process.env.CCSERVER_OPENCODE_GO_USAGE = 'maybe';
  assert.equal(opencodeGoEnabled(), true);
});

test('readOpencodeGoKey / opencodeGoAvailable: key file presence gates, toggle wins', () => {
  assert.equal(readOpencodeGoKey(), null);
  assert.equal(opencodeGoAvailable(), false);
  writeAuthKey('k123');
  assert.equal(readOpencodeGoKey(), 'k123');
  assert.equal(opencodeGoAvailable(), true);
  writeConfig({ opencodeGoUsage: false });
  assert.equal(opencodeGoAvailable(), false, 'disabled toggle hides even with a key');
});

test('readOpencodeGoKey: OPENCODE_AUTH_CONTENT wins over auth.json', () => {
  writeAuthKey('file-key');
  process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({ 'opencode-go': { type: 'api', key: 'env-key' } });
  assert.equal(readOpencodeGoKey(), 'env-key');
});

test('getOpencodeUsage: disabled config short-circuits without fetching', async () => {
  writeConfig({ opencodeGoUsage: false });
  writeAuthKey('k123');
  let fetched = false;
  globalThis.fetch = async () => { fetched = true; throw new Error('must not fetch'); };
  const res = await getOpencodeUsage({ force: true });
  assert.equal(res.usage, null);
  assert.match(res.error, /disabled by config/);
  assert.equal(fetched, false);
});

test('getOpencodeUsage: missing key errors without fetching', async () => {
  let fetched = false;
  globalThis.fetch = async () => { fetched = true; throw new Error('must not fetch'); };
  const res = await getOpencodeUsage({ force: true });
  assert.equal(res.usage, null);
  assert.match(res.error, /API key not found/);
  assert.equal(fetched, false);
});

test('getOpencodeUsage: 403 means no subscription', async () => {
  writeAuthKey('k123');
  globalThis.fetch = async () => ({ status: 403, ok: false });
  const res = await getOpencodeUsage({ force: true });
  assert.equal(res.usage, null);
  assert.match(res.error, /No OpenCode Go subscription/);
});

test('getOpencodeUsage: 401 means rejected key', async () => {
  writeAuthKey('k123');
  globalThis.fetch = async () => ({ status: 401, ok: false });
  const res = await getOpencodeUsage({ force: true });
  assert.equal(res.usage, null);
  assert.match(res.error, /Invalid opencode Go API key/);
});

test('getOpencodeUsage: incomplete windows are an error, not a partial cache', async () => {
  writeAuthKey('k123');
  globalThis.fetch = async () => ({
    status: 200,
    ok: true,
    json: async () => ({ usage: { rolling: VALID_PAYLOAD.usage.rolling } }),
  });
  const res = await getOpencodeUsage({ force: true });
  assert.equal(res.usage, null);
  assert.match(res.error, /Could not parse/);
});

// NOTE: this success case runs last: it populates the module cache, and the
// failure cases above assert `usage: null`, which a stale-cache fallback
// would otherwise turn into a cache hit.
test('getOpencodeUsage: 200 maps through and sends the Bearer key', async () => {
  writeAuthKey('k123');
  let seenAuth = null;
  let seenUrl = null;
  globalThis.fetch = async (url, opts) => {
    seenUrl = String(url);
    seenAuth = opts?.headers?.authorization;
    return { status: 200, ok: true, json: async () => VALID_PAYLOAD };
  };
  const res = await getOpencodeUsage({ force: true });
  assert.equal(seenUrl, 'https://opencode.ai/zen/go/v1/usage');
  assert.equal(seenAuth, 'Bearer k123');
  assert.equal(res.usage.plan, 'OpenCode Go');
  assert.equal(res.usage.limits.length, 3);
  assert.equal(typeof res.updatedAt, 'number');
});
