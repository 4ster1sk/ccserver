import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

// The production server runs under systemd, whose default PATH
// (/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin) misses nvm's bin and
// ~/.local/bin. resolveApp must still find the agent CLIs via its fallback
// dirs, or pty.spawn fails with "execvp(3) failed.: No such file or directory".
const BARE_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin';

function resolveInBareEnv(app) {
  const script = `
    import { resolveApp } from './sandbox.js';
    console.log(JSON.stringify(resolveApp('${app}')));
  `;
  const res = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: import.meta.dirname,
    env: { ...process.env, PATH: BARE_PATH },
    encoding: 'utf-8',
    timeout: 15000,
  });
  assert.equal(res.status, 0, `subprocess failed: ${res.stderr}`);
  return JSON.parse(res.stdout.trim().split('\n').at(-1));
}

test('resolveApp finds opencode under a bare PATH (systemd) via fallback dirs', () => {
  const r = resolveInBareEnv('opencode');
  assert.ok(r.command.startsWith('/'), `expected absolute path, got: ${r.command}`);
  assert.ok(existsSync(r.command), `resolved command missing: ${r.command}`);
});

test('resolveApp finds claude under a bare PATH (systemd) via fallback dirs', () => {
  const r = resolveInBareEnv('claude');
  assert.ok(r.command.startsWith('/'), `expected absolute path, got: ${r.command}`);
  assert.ok(existsSync(r.command), `resolved command missing: ${r.command}`);
});

test('resolveApp keeps the bare command name when PATH resolves it', () => {
  const script = `
    import { resolveApp } from './sandbox.js';
    console.log(JSON.stringify(resolveApp('claude')));
  `;
  const res = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: import.meta.dirname,
    env: process.env,
    encoding: 'utf-8',
    timeout: 15000,
  });
  assert.equal(res.status, 0, `subprocess failed: ${res.stderr}`);
  const r = JSON.parse(res.stdout.trim().split('\n').at(-1));
  assert.ok(['claude', 'claude.exe'].includes(r.command), `expected bare name, got: ${r.command}`);
});
