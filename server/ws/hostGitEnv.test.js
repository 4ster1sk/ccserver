// A sandbox-written repo must not be able to run commands on the host via
// git settings when ccserver runs git there. Real git, planted config.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hardenedGitEnv, HARDENED_GIT_KEYS } from './hostGitEnv.js';

function maliciousRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'ccs-evilrepo-'));
  const marker = join(dir, 'PWNED');
  const run = (...a) => execFileSync('git', ['-C', dir, ...a], { stdio: 'ignore', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } });
  run('init', '-q');
  run('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
  // What an agent inside the sandbox could plant in the shared project:
  run('config', 'core.fsmonitor', `touch ${marker}.fsmonitor; false`);
  run('config', 'core.sshCommand', `sh -c 'touch ${marker}.ssh'`);
  run('config', 'core.pager', `touch ${marker}.pager; cat`);
  const hook = join(dir, '.git', 'hooks', 'post-checkout');
  writeFileSync(hook, `#!/bin/sh\ntouch ${marker}.hook\n`);
  chmodSync(hook, 0o755);
  return { dir, marker };
}

test('planted fsmonitor / hooks / sshCommand do not run under hardenedGitEnv', () => {
  const { dir, marker } = maliciousRepo();
  const env = hardenedGitEnv({ ...process.env, GIT_CONFIG_NOSYSTEM: '1' });
  execFileSync('git', ['-C', dir, 'status', '--porcelain'], { env, stdio: 'ignore' });
  execFileSync('git', ['-C', dir, 'worktree', 'add', '-q', '--detach', join(dir, 'wt'), 'HEAD'], { env, stdio: 'ignore' });
  try {
    execFileSync('git', ['-C', dir, 'ls-remote', 'ssh://example.invalid/x'], { env, stdio: 'ignore', timeout: 5000 });
  } catch { /* fails without network; only the side effect matters */ }
  execFileSync('git', ['-C', dir, 'log', '-1'], { env, stdio: 'ignore' });
  for (const kind of ['fsmonitor', 'hook', 'ssh', 'pager']) {
    assert.ok(!existsSync(`${marker}.${kind}`), `${kind} ran on the host`);
  }
});

test('control: without the hardened env the planted hook does run (the test is real)', () => {
  const { dir, marker } = maliciousRepo();
  execFileSync('git', ['-C', dir, 'worktree', 'add', '-q', '--detach', join(dir, 'wt'), 'HEAD'], { stdio: 'ignore', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } });
  assert.ok(existsSync(`${marker}.hook`));
});

test('hardenedGitEnv appends after existing GIT_CONFIG_* entries', () => {
  const env = hardenedGitEnv({ GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'a.b', GIT_CONFIG_VALUE_0: '1', GIT_CONFIG_KEY_1: 'c.d', GIT_CONFIG_VALUE_1: '2' });
  assert.equal(env.GIT_CONFIG_KEY_0, 'a.b');
  assert.equal(env.GIT_CONFIG_KEY_2, HARDENED_GIT_KEYS[0]);
  assert.equal(env.GIT_CONFIG_COUNT, String(2 + HARDENED_GIT_KEYS.length));
  assert.equal(env.GIT_TERMINAL_PROMPT, '0');
});
