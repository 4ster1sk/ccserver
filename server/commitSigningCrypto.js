// Pure crypto for the commit signing key's passkey quick-unlock (plan:
// sandbox-no-secrets). The passphrase of the host signing key
// (commitSigning.js) can be stored wrapped under a key derived from a
// passkey's WebAuthn PRF output, so unlocking is one tap instead of typing
// it. Nothing here touches the DB, WebAuthn or gpg.
//
//   prf_salt_C (32B random per credential, server-chosen)
//     --[live WebAuthn PRF ceremony against credential C]--> prfSecret
//     --[HKDF-SHA256(ikm=prfSecret, info=...credentialId)]--> wrappingKey_C
//     --[AES-256-GCM(wrappingKey_C, aad=credentialId:fingerprint)]--> passphrase
//
// The AAD binds a wrap to the key it unlocks: replacing the signing key
// makes every old wrap fail closed instead of feeding a stale passphrase to
// the new key. Carried over from the retired GPG vault's crypto
// (gpgVaultCrypto.js), with its own HKDF info so the two can never collide.

import { randomBytes, hkdfSync, createCipheriv, createDecipheriv } from 'node:crypto';

export function generatePrfSalt() {
  return randomBytes(32);
}

export function deriveWrappingKey(prfSecret, credentialId) {
  return Buffer.from(hkdfSync(
    'sha256',
    prfSecret,
    Buffer.alloc(0),
    Buffer.from(`ccserver-commit-signing-passphrase-wrap-v1:${credentialId}`, 'utf8'),
    32,
  ));
}

// AES-256-GCM with a random 12-byte IV. Decrypt throws on any mismatch
// (wrong PRF output, tampered row, other key): callers treat all of them
// the same way -- fail closed.
export function aesGcmEncrypt(key, plaintext, aad) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  if (aad) cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { ciphertext, iv, tag: cipher.getAuthTag() };
}

export function aesGcmDecrypt(key, ciphertext, iv, tag, aad) {
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  if (aad) decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

const wrapAad = (credentialId, fingerprint) => `${credentialId}:${fingerprint}`;

// Returns { ciphertext, iv, tag }. The wrapping key never outlives the call.
export function wrapPassphrase(passphrase, { prfSecret, credentialId, fingerprint }) {
  const key = deriveWrappingKey(prfSecret, credentialId);
  try {
    return aesGcmEncrypt(key, passphrase, wrapAad(credentialId, fingerprint));
  } finally {
    key.fill(0);
  }
}

// Returns the passphrase Buffer (the caller zeroes it) or throws.
export function unwrapPassphrase({ ciphertext, iv, tag }, { prfSecret, credentialId, fingerprint }) {
  const key = deriveWrappingKey(prfSecret, credentialId);
  try {
    return aesGcmDecrypt(key, ciphertext, iv, tag, wrapAad(credentialId, fingerprint));
  } finally {
    key.fill(0);
  }
}
