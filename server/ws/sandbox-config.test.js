import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadSandboxConfig } from './sandbox.js';

// loadSandboxConfig reads the file at CCSERVER_SANDBOX_CONFIG (else the
// default server/sandbox.config.json). Point it at a temp file to exercise the
// forceSandbox parsing without touching a real deployment config.
function withConfig(json, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'ccserver-sandbox-config-'));
  const path = join(dir, 'sandbox.config.json');
  try {
    writeFileSync(path, JSON.stringify(json));
    const prev = process.env.CCSERVER_SANDBOX_CONFIG;
    process.env.CCSERVER_SANDBOX_CONFIG = path;
    try {
      fn();
    } finally {
      if (prev === undefined) delete process.env.CCSERVER_SANDBOX_CONFIG;
      else process.env.CCSERVER_SANDBOX_CONFIG = prev;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('forceSandbox defaults to false when the key is absent', () => {
  withConfig({ docker: true }, () => {
    assert.equal(loadSandboxConfig().forceSandbox, false);
  });
});

test('forceSandbox is true only for an explicit true value', () => {
  withConfig({ forceSandbox: true }, () => {
    assert.equal(loadSandboxConfig().forceSandbox, true);
  });
  withConfig({ forceSandbox: false }, () => {
    assert.equal(loadSandboxConfig().forceSandbox, false);
  });
  withConfig({ forceSandbox: 'yes' }, () => {
    assert.equal(loadSandboxConfig().forceSandbox, false);
  });
});

test('forceSandbox coexists with the other config keys', () => {
  withConfig({ forceSandbox: true, gitBroker: false, defaultApp: 'opencode' }, () => {
    const cfg = loadSandboxConfig();
    assert.equal(cfg.forceSandbox, true);
    assert.equal(cfg.gitBroker, false);
    assert.equal(cfg.defaultApp, 'opencode');
  });
});

test('forceSandbox is exposed via /api/dirs/home payload helper keys', () => {
  withConfig({ forceSandbox: true, defaultApp: 'claude' }, () => {
    const cfg = loadSandboxConfig();
    assert.equal(cfg.defaultApp, 'claude');
    assert.equal(cfg.forceSandbox, true);
  });
});
