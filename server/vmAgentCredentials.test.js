import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { getVmAgentCredentials, vmAgentCredentialStatus, setClaudeOAuthToken, setOpencodeApiKey } from './vmAgentCredentials.js';

beforeEach(() => {
  setClaudeOAuthToken(null);
  for (const id of vmAgentCredentialStatus().opencode) setOpencodeApiKey(id, null);
});

test('claude token: set, read, clear; status never carries the value', () => {
  assert.deepEqual(vmAgentCredentialStatus(), { claude: false, opencode: [] });
  setClaudeOAuthToken('  sk-ant-oat01-abcdefghijklmnopqrstuvwxyz_-0123  ');
  assert.equal(getVmAgentCredentials().claudeOAuthToken, 'sk-ant-oat01-abcdefghijklmnopqrstuvwxyz_-0123');
  assert.deepEqual(vmAgentCredentialStatus(), { claude: true, opencode: [] });
  setClaudeOAuthToken(null);
  assert.equal(getVmAgentCredentials().claudeOAuthToken, null);
});

test('claude token: anything but a setup-token value is refused', () => {
  for (const bad of ['', 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz', 'sk-ant-oat01-short', 'sk-ant-oat01-abcdefghijklmnopqrstuvwxyz\nX', 42]) {
    assert.throws(() => setClaudeOAuthToken(bad), /not a Claude OAuth token/);
  }
  assert.equal(getVmAgentCredentials().claudeOAuthToken, null);
});

test('opencode keys: set per provider, replace, clear; status lists ids only', () => {
  setOpencodeApiKey('sakura', '  key-one  ');
  setOpencodeApiKey('opencode-go', 'key-two');
  assert.deepEqual(getVmAgentCredentials().opencodeApiKeys, { sakura: 'key-one', 'opencode-go': 'key-two' });
  assert.deepEqual(vmAgentCredentialStatus(), { claude: false, opencode: ['opencode-go', 'sakura'] });
  setOpencodeApiKey('sakura', 'key-three');
  assert.equal(getVmAgentCredentials().opencodeApiKeys.sakura, 'key-three');
  setOpencodeApiKey('sakura', null);
  setOpencodeApiKey('opencode-go', null);
  assert.deepEqual(getVmAgentCredentials().opencodeApiKeys, {});
});

test('opencode keys: a bad provider id or key is refused', () => {
  for (const bad of ['', 'has space', '../x', '-lead', 42, null]) {
    assert.throws(() => setOpencodeApiKey(bad, 'k'), /not an opencode provider id/);
  }
  for (const bad of ['', '   ', 'a b', 'a\nb', 'x'.repeat(4097), 42]) {
    assert.throws(() => setOpencodeApiKey('sakura', bad), /not an API key/);
  }
  assert.deepEqual(getVmAgentCredentials().opencodeApiKeys, {});
});
