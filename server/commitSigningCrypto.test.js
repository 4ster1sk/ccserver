import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { generatePrfSalt, wrapPassphrase, unwrapPassphrase } from './commitSigningCrypto.js';

const ctx = (over = {}) => ({ prfSecret: Buffer.alloc(32, 7), credentialId: 'cred-a', fingerprint: 'FPR1', ...over });

test('a wrapped passphrase comes back only with the same PRF output, credential and key', () => {
  const pass = Buffer.from('correct horse battery staple');
  const wrap = wrapPassphrase(pass, ctx());
  assert.deepEqual(unwrapPassphrase(wrap, ctx()), pass);
  assert.throws(() => unwrapPassphrase(wrap, ctx({ prfSecret: randomBytes(32) })), 'another PRF output');
  assert.throws(() => unwrapPassphrase(wrap, ctx({ credentialId: 'cred-b' })), 'another passkey');
  assert.throws(() => unwrapPassphrase(wrap, ctx({ fingerprint: 'FPR2' })), 'a replaced signing key');
  const tampered = { ...wrap, ciphertext: Buffer.from(wrap.ciphertext) };
  tampered.ciphertext[0] ^= 1;
  assert.throws(() => unwrapPassphrase(tampered, ctx()));
});

test('salts are fresh and 32 bytes', () => {
  const a = generatePrfSalt();
  assert.equal(a.length, 32);
  assert.notDeepEqual(a, generatePrfSalt());
});
