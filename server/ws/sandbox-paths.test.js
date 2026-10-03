import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentConfigDirs, isBlockedCredentialBind } from './sandbox-paths.js';

test('agentConfigDirs includes only the supported CLI configuration paths', () => {
  assert.deepEqual(agentConfigDirs('/home/u'), [
    '/home/u/.claude',
    '/home/u/.claude.json',
    '/home/u/.local/share/claude',
    '/home/u/.config/opencode',
    '/home/u/.local/share/opencode',
    '/home/u/.local/state/opencode',
    '/home/u/.codex',
  ]);
});

test('isBlockedCredentialBind rejects the SSH and GitHub CLI credential trees', () => {
  const home = '/home/u';
  assert.equal(isBlockedCredentialBind('/home/u/.ssh', home), true);
  assert.equal(isBlockedCredentialBind('/home/u/.ssh/id_ed25519', home), true);
  assert.equal(isBlockedCredentialBind('/home/u/.config/gh/hosts.yml', home), true);
  assert.equal(isBlockedCredentialBind('/home/u/.sshfoo', home), false);
  assert.equal(isBlockedCredentialBind('/srv/shared', home), false);
});
