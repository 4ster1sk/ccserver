import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveVmAgentInstall, buildVmAgentAuth, vmAgentArgv, CLAUDE_TOKEN_PLACEHOLDER, OPENCODE_KEY_PLACEHOLDER, parseJsonc, readOpencodeHostProviders, resolveOpencodeProviders } from './qemuAgents.js';

let root;
let home;
before(() => {
  root = mkdtempSync(join(tmpdir(), 'ccs-agents-'));
  home = join(root, 'home');
  mkdirSync(home);
});
after(() => rmSync(root, { recursive: true, force: true }));

function file(path, content = '\x7fELF') {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
  chmodSync(path, 0o755);
  return path;
}

test('resolveVmAgentInstall: a native binary behind a symlink shares its dir', () => {
  const bin = file(join(home, '.local/share/claude/versions/1.2.3'));
  mkdirSync(join(home, '.local/bin'), { recursive: true });
  symlinkSync(bin, join(home, '.local/bin/claude'));
  assert.deepEqual(resolveVmAgentInstall(join(home, '.local/bin/claude'), { home }), {
    hostDir: join(home, '.local/share/claude/versions'), relBin: '1.2.3',
  });
});

test('resolveVmAgentInstall: a trailing bin/ shares its parent; a shell wrapper is followed', () => {
  file(join(root, 'opt/codex/bin/codex'));
  const wrapper = file(join(root, 'usr-bin/codex'), `#!/bin/sh\nexec "${join(root, 'opt/codex/bin/codex')}" "$@"\n`);
  assert.deepEqual(resolveVmAgentInstall(wrapper, { home }), { hostDir: join(root, 'opt/codex'), relBin: 'bin/codex' });
});

test('resolveVmAgentInstall: an npm install shares its whole node_modules', () => {
  const cli = file(join(root, 'nvm/lib/node_modules/@openai/codex/bin/codex.js'), '#!/usr/bin/env node\n');
  assert.deepEqual(resolveVmAgentInstall(cli, { home }), {
    hostDir: join(root, 'nvm/lib/node_modules'), relBin: '@openai/codex/bin/codex.js',
  });
});

test('resolveVmAgentInstall: refuses HOME and credential dirs, and a missing binary', () => {
  const inHome = file(join(home, 'opencode'));
  assert.throws(() => resolveVmAgentInstall(inHome, { home }), /contains HOME/);
  // ~/bin itself is fine (it is not HOME), and is not widened to HOME.
  assert.deepEqual(resolveVmAgentInstall(file(join(home, 'bin/opencode')), { home }), { hostDir: join(home, 'bin'), relBin: 'opencode' });
  const secret = join(root, 'tool/.creds');
  const bin = file(join(root, 'tool/agent'));
  assert.throws(() => resolveVmAgentInstall(bin, { home, protectedPaths: [secret] }), /contains .*\.creds/);
  assert.throws(() => resolveVmAgentInstall(join(root, 'nope'), { home }), /does not exist/);
  assert.throws(() => resolveVmAgentInstall(null, { home }), /not installed/);
});

test('vmAgentArgv: codex has its update check off', () => {
  assert.deepEqual(vmAgentArgv('codex', 'bin/codex', ['resume']), ['/opt/ccs-agent/codex/bin/codex', '-c', 'check_for_update_on_startup=false', 'resume']);
  assert.deepEqual(vmAgentArgv('claude', '1.2.3', []), ['/opt/ccs-agent/claude/1.2.3']);
});

test('buildVmAgentAuth: nothing set passes the operator inject through', () => {
  const op = [{ host: 'x.test', header: 'X-Key', valueFromEnv: 'X' }];
  assert.deepEqual(buildVmAgentAuth({ advanced: { inject: op } }), { inject: op, brokerEnv: {}, guestEnv: {}, opencodeConfig: null, hosts: [], digest: null });
  assert.equal(buildVmAgentAuth().inject, null);
});

test('buildVmAgentAuth: the claude token goes to the broker env, the guest gets a placeholder', () => {
  const token = 'sk-ant-oat01-secret';
  const op = [{ host: 'x.test', header: 'Authorization', valueFromEnv: 'X' }];
  const r = buildVmAgentAuth({ credentials: { claudeOAuthToken: token }, advanced: { inject: op } });
  assert.equal(r.guestEnv.CLAUDE_CODE_OAUTH_TOKEN, CLAUDE_TOKEN_PLACEHOLDER);
  assert.equal(r.inject[0], op[0], 'operator entries kept first');
  const ours = r.inject.slice(1);
  assert.deepEqual(ours.map((e) => e.host), ['api.anthropic.com', 'mcp-proxy.anthropic.com']);
  assert.ok(ours.every((e) => e.header === 'Authorization' && e.format === 'Bearer {}' && r.brokerEnv[e.valueFromEnv] === token));
  assert.deepEqual(r.hosts, ['api.anthropic.com', 'mcp-proxy.anthropic.com']);
  assert.ok(!JSON.stringify({ inject: r.inject, guestEnv: r.guestEnv, digest: r.digest }).includes(token));
  assert.notEqual(r.digest, buildVmAgentAuth({ credentials: { claudeOAuthToken: `${token}2` } }).digest);
});

test('buildVmAgentAuth: refuses without MITM, and on a clashing operator inject', () => {
  const credentials = { claudeOAuthToken: 'sk-ant-oat01-secret' };
  assert.throws(() => buildVmAgentAuth({ credentials, advanced: { mitm: { enabled: false } } }), /HTTPS interception/);
  assert.throws(
    () => buildVmAgentAuth({ credentials, advanced: { inject: [{ host: 'api.anthropic.com', header: 'authorization', valueFromEnv: 'X' }] } }),
    /already sets/,
  );
});

test('parseJsonc / readOpencodeHostProviders: comments, trailing commas, later files win', () => {
  assert.deepEqual(parseJsonc('{\n // c\n "a": "x//y", /* b */ "b": [1,2,],\n}'), { a: 'x//y', b: [1, 2] });
  const dir = join(root, 'oc-config');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'config.json'), '{ "provider": { "sakura": { "npm": "@ai-sdk/openai-compatible", "options": { "baseURL": "https://a.example/v1", }, }, }, }');
  writeFileSync(join(dir, 'opencode.jsonc'), '// x\n{ "provider": { "sakura": { "options": { "timeout": 5 } } }, "model": "m" }');
  writeFileSync(join(dir, 'opencode.json'), '{ broken');
  assert.deepEqual(readOpencodeHostProviders(dir), {
    sakura: { npm: '@ai-sdk/openai-compatible', options: { baseURL: 'https://a.example/v1', timeout: 5 } },
  });
  assert.deepEqual(readOpencodeHostProviders(join(root, 'nope')), {});
});

test('resolveOpencodeProviders: host config, built-ins, and what is left out', () => {
  const hostProviders = {
    sakura: {
      npm: '@ai-sdk/openai-compatible', name: 'Sakura',
      options: { baseURL: 'https://api.ai.sakura.ad.jp/v1', apiKey: 'real-secret', headers: { 'X-Secret': 's' }, project: '{env:PROJECT}' },
      models: { m: { name: 'M' } },
    },
    weird: { npm: '@ai-sdk/google', options: { baseURL: 'https://g.example' } },
    plain: { npm: '@ai-sdk/openai-compatible', options: { baseURL: 'http://insecure.example' } },
  };
  const { providers, skipped } = resolveOpencodeProviders({ hostProviders, providerIds: ['sakura', 'opencode-go', 'anthropic', 'weird', 'plain', 'unknown'] });
  assert.deepEqual(providers.map(({ id, host, header, format }) => ({ id, host, header, format })), [
    { id: 'sakura', host: 'api.ai.sakura.ad.jp', header: 'Authorization', format: 'Bearer {}' },
    { id: 'opencode-go', host: 'opencode.ai', header: 'Authorization', format: 'Bearer {}' },
    { id: 'anthropic', host: 'api.anthropic.com', header: 'x-api-key', format: '{}' },
  ]);
  // The guest copy: no real key, no custom headers, no {env:} references.
  assert.deepEqual(providers[0].configEntry, {
    npm: '@ai-sdk/openai-compatible', name: 'Sakura',
    options: { baseURL: 'https://api.ai.sakura.ad.jp/v1', apiKey: OPENCODE_KEY_PLACEHOLDER },
    models: { m: { name: 'M' } },
  });
  assert.deepEqual(providers[1].configEntry, { options: { apiKey: OPENCODE_KEY_PLACEHOLDER } });
  assert.deepEqual(skipped.map((s) => s.id), ['weird', 'plain', 'unknown']);
});

test('buildVmAgentAuth: opencode keys go to the broker env, the guest gets the provider config', () => {
  const { providers } = resolveOpencodeProviders({
    hostProviders: { sakura: { npm: '@ai-sdk/openai-compatible', options: { baseURL: 'https://api.ai.sakura.ad.jp/v1' } } },
    providerIds: ['sakura', 'opencode', 'opencode-go'],
  });
  const credentials = { opencodeApiKeys: { sakura: 'sk-1', opencode: 'zen', 'opencode-go': 'zen' } };
  const r = buildVmAgentAuth({ credentials, opencodeProviders: providers });
  assert.deepEqual(r.inject, [
    { host: 'api.ai.sakura.ad.jp', header: 'Authorization', format: 'Bearer {}', valueFromEnv: 'CCS_INJECT_OPENCODE_0' },
    // opencode and opencode-go share one entry for their one key.
    { host: 'opencode.ai', header: 'Authorization', format: 'Bearer {}', valueFromEnv: 'CCS_INJECT_OPENCODE_1' },
  ]);
  assert.deepEqual(r.brokerEnv, { CCS_INJECT_OPENCODE_0: 'sk-1', CCS_INJECT_OPENCODE_1: 'zen' });
  assert.deepEqual(r.guestEnv, {});
  assert.deepEqual(Object.keys(r.opencodeConfig.provider), ['sakura', 'opencode', 'opencode-go']);
  assert.ok(!JSON.stringify(r.opencodeConfig).includes('sk-1'));
  assert.deepEqual(r.hosts, ['api.ai.sakura.ad.jp', 'opencode.ai']);
  // A provider without a key is not injected.
  assert.equal(buildVmAgentAuth({ credentials: { opencodeApiKeys: { sakura: 'sk-1' } }, opencodeProviders: providers }).inject.length, 1);
  // The digest follows the key and the endpoint.
  assert.notEqual(r.digest, buildVmAgentAuth({ credentials: { ...credentials, opencodeApiKeys: { ...credentials.opencodeApiKeys, sakura: 'sk-2' } }, opencodeProviders: providers }).digest);
  const moved = providers.map((p) => (p.id === 'sakura' ? { ...p, host: 'other.example' } : p));
  assert.notEqual(r.digest, buildVmAgentAuth({ credentials, opencodeProviders: moved }).digest);
});

test('buildVmAgentAuth: two values for one header on one host are refused', () => {
  const { providers } = resolveOpencodeProviders({ providerIds: ['opencode', 'opencode-go'] });
  assert.throws(
    () => buildVmAgentAuth({ credentials: { opencodeApiKeys: { opencode: 'a', 'opencode-go': 'b' } }, opencodeProviders: providers }),
    /different values/,
  );
  // claude's bearer on api.anthropic.com vs an anthropic key in x-api-key: no clash.
  const anthropic = resolveOpencodeProviders({ providerIds: ['anthropic'] }).providers;
  const r = buildVmAgentAuth({ credentials: { claudeOAuthToken: 'sk-ant-oat01-x', opencodeApiKeys: { anthropic: 'sk-ant-api03-y' } }, opencodeProviders: anthropic });
  assert.equal(r.inject.filter((e) => e.host === 'api.anthropic.com').length, 2);
});
