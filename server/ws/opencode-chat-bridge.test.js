// The chat bridge run for real against a fake `opencode serve`: it retries
// a serve that exits at startup because opencode's database is locked by
// another session, and fails the stage on any other early exit.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CHAT_BRIDGE_SCRIPT } from './sandbox.js';

// Fails `failures` times with `message` on stderr (counting in a file), then
// prints the serve handshake and waits for stdin to close.
function fakeServe(dir, { failures, message }) {
  const script = join(dir, 'serve.cjs');
  writeFileSync(script, `
const fs = require('node:fs');
const n = Number(fs.existsSync(${JSON.stringify(join(dir, 'count'))}) ? fs.readFileSync(${JSON.stringify(join(dir, 'count'))}, 'utf-8') : 0) + 1;
fs.writeFileSync(${JSON.stringify(join(dir, 'count'))}, String(n));
if (n <= ${failures}) { process.stderr.write(${JSON.stringify(`${message}\n`)}); process.exit(1); }
process.stdout.write(JSON.stringify({ url: 'http://127.0.0.1:4567' }) + '\\n');
process.stdin.resume();
process.stdin.on('end', () => process.exit(0));
`);
  return script;
}

function runBridge(dir, script) {
  writeFileSync(join(dir, 'password'), 'pw\n', { mode: 0o600 });
  const p = spawn(process.execPath, [CHAT_BRIDGE_SCRIPT, '--sock', join(dir, 'oc.sock'), '--password-file', join(dir, 'password'), '--', process.execPath, script], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  p.stdout.setEncoding('utf-8');
  p.stdout.on('data', (c) => { out += c; });
  return { p, output: () => out };
}

const waitFor = async (cond, ms) => {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
};

test('bridge: a serve that finds the database locked is retried until it comes up', { timeout: 20000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccs-bridge-'));
  const { p, output } = runBridge(dir, fakeServe(dir, { failures: 2, message: 'SQLiteError: database is locked' }));
  try {
    await waitFor(() => output().includes('ccserver-stage;agent;done') || p.exitCode !== null, 15000);
    assert.equal(p.exitCode, null, output());
    assert.equal(readFileSync(join(dir, 'count'), 'utf-8'), '3');
    assert.match(output(), /database is locked by another session; retrying/);
    assert.ok(existsSync(join(dir, 'oc.sock')));
  } finally {
    p.kill('SIGTERM');
    await new Promise((r) => p.once('exit', r));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('bridge: any other early exit fails the agent stage without a retry', { timeout: 20000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ccs-bridge-'));
  const { p, output } = runBridge(dir, fakeServe(dir, { failures: 1, message: 'no provider configured' }));
  try {
    const code = await new Promise((r) => p.once('exit', r));
    assert.equal(code, 1);
    assert.equal(readFileSync(join(dir, 'count'), 'utf-8'), '1');
    assert.match(output(), /ccserver-stage;agent;error;opencode serve exited \(1\): no provider configured/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
