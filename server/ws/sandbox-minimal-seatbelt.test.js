// buildMinimalSeatbeltSpawn (server/ws/sandbox.js): the macOS minimal launch
// used by the background usage captures (server/usage.js, server/codexUsage.js).
//
// Regression for docs/usage-widget-macos-sandbox-investigation.md: the minimal
// path used to (a) drop `app` before buildSeatbeltLaunch and (b) skip the
// Keychain seed that full sessions do, so a Keychain-only host login never
// reached a sandboxed `/usage` capture (30s timeout under forceSandbox:true).
//
// Platform-independent by design (no IS_MACOS check inside; only the caller
// buildMinimalSandboxSpawn branches on it), so this runs on Linux CI too.
// Isolated via CCSERVER_SANDBOX_SEATBELT_TMP; real-launch cases clean up their
// seatbelt dirs in after().

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildMinimalSeatbeltSpawn } from './sandbox.js';

let tmpRoot;
let prevSeatbeltTmp;
const DIRS = [];

before(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'ccserver-minimal-sbtest-'));
  prevSeatbeltTmp = process.env.CCSERVER_SANDBOX_SEATBELT_TMP;
  process.env.CCSERVER_SANDBOX_SEATBELT_TMP = join(tmpRoot, 'seatbelt');
});

after(() => {
  for (const d of DIRS) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  if (prevSeatbeltTmp === undefined) delete process.env.CCSERVER_SANDBOX_SEATBELT_TMP;
  else process.env.CCSERVER_SANDBOX_SEATBELT_TMP = prevSeatbeltTmp;
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

function makeCwd() {
  const d = mkdtempSync(join(tmpdir(), 'ccserver-minimal-sbtest-cwd-'));
  DIRS.push(d);
  return d;
}

function stubDeps({ seen = {}, seedCalls = [], launchImpl = null } = {}) {
  return {
    resolveFn: (app) => ({ command: app === 'codex' ? 'codex' : 'claude', installDir: null, found: true }),
    ensureDirsFn: () => { seen.ensureDirs = (seen.ensureDirs || 0) + 1; },
    seedFn: () => { seedCalls.push(1); return false; },
    launchFn: launchImpl || ((opts) => {
      seen.launchOpts = opts;
      // Minimal stand-in for buildSeatbeltLaunch's return: only the fields
      // buildMinimalSeatbeltSpawn reads (profilePath/env/dir).
      return { profilePath: join(tmpRoot, 'fake.sb'), env: { FAKE: '1' }, dir: tmpRoot };
    }),
  };
}

test('minimal seatbelt passes app through to buildSeatbeltLaunch', () => {
  for (const app of ['claude', 'codex', 'opencode']) {
    const seen = {};
    const deps = stubDeps({ seen });
    buildMinimalSeatbeltSpawn(
      { cwd: makeCwd(), targetCommand: [app, '--version'], app },
      deps,
    );
    assert.equal(seen.launchOpts.app, app, `app:${app} must reach the seatbelt launch`);
  }
});

test('minimal seatbelt seeds Keychain credentials for claude only', () => {
  const claudeSeeds = [];
  buildMinimalSeatbeltSpawn(
    { cwd: makeCwd(), targetCommand: ['claude', '--ax-screen-reader'], app: 'claude' },
    stubDeps({ seedCalls: claudeSeeds }),
  );
  assert.equal(claudeSeeds.length, 1, 'claude capture must attempt the Keychain seed');

  for (const app of ['codex', 'opencode']) {
    const seeds = [];
    buildMinimalSeatbeltSpawn(
      { cwd: makeCwd(), targetCommand: [app], app },
      stubDeps({ seedCalls: seeds }),
    );
    assert.equal(seeds.length, 0, `${app} must not attempt the Claude Keychain seed`);
  }
});

test('minimal seatbelt survives a throwing seed (non-fatal)', () => {
  const seen = {};
  const deps = stubDeps({ seen });
  deps.seedFn = () => { throw new Error('security ACL denied'); };
  const spawn = buildMinimalSeatbeltSpawn(
    { cwd: makeCwd(), targetCommand: ['claude', '--ax-screen-reader'], app: 'claude' },
    deps,
  );
  assert.ok(spawn, 'a seed failure must not abort the capture launch assembly');
  assert.equal(seen.launchOpts.app, 'claude');
});

test('minimal seatbelt builds a real launch (integration, Linux-runnable)', () => {
  // No launchFn stub: exercises the real buildSeatbeltLaunch + withClaude
  // wiring on Linux. Verifies the argv shape full sessions use
  // (sandbox-exec -f <profile> /usr/bin/env ... bash entrypoint <resolved>).
  const cwd = makeCwd();
  const spawn = buildMinimalSeatbeltSpawn(
    { cwd, targetCommand: ['claude', '--ax-screen-reader'], app: 'claude' },
    {
      resolveFn: (app) => ({ command: 'claude', installDir: null, found: true }),
      ensureDirsFn: () => {},
      seedFn: () => false,
    },
  );
  DIRS.push(spawn.seatbeltDir);
  assert.equal(spawn.command, '/usr/bin/sandbox-exec');
  assert.equal(spawn.args[0], '-f');
  // withClaude swaps the leading bare 'claude' for the resolved launcher,
  // keeping the capture flags intact.
  assert.ok(spawn.args.includes('claude'), 'resolved claude command present in argv');
  assert.ok(spawn.args.includes('--ax-screen-reader'), 'capture flags preserved');
  assert.equal(spawn.docker, false);
  assert.equal(spawn.seatbeltFiles, null);
});
