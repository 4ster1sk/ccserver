// DB access for host-side commit signing (db.js v15): passkey wraps of the
// signing key's passphrase, and the audit log of what was signed. CRUD
// only; crypto lives in commitSigningCrypto.js, gpg in commitSigning.js.

import { getDb } from './db.js';

const AUDIT_KEEP_ROWS = 10_000;

// --- passkey wraps -------------------------------------------------------------

export function listPasskeyWraps(fingerprint) {
  return getDb()
    .prepare('SELECT credential_id, prf_salt FROM commit_signing_passkeys WHERE key_fingerprint = ? ORDER BY created_at ASC')
    .all(fingerprint)
    .map((r) => ({ credentialId: r.credential_id, prfSalt: Buffer.from(r.prf_salt) }));
}

export function getPasskeyWrap(credentialId, fingerprint) {
  const r = getDb()
    .prepare('SELECT * FROM commit_signing_passkeys WHERE credential_id = ? AND key_fingerprint = ?')
    .get(credentialId, fingerprint);
  if (!r) return null;
  return {
    credentialId: r.credential_id,
    prfSalt: Buffer.from(r.prf_salt),
    ciphertext: Buffer.from(r.wrapped),
    iv: Buffer.from(r.wrap_nonce),
    tag: Buffer.from(r.wrap_tag),
  };
}

// Insert or replace the wrap for one passkey (re-enrolling after a
// passphrase change overwrites the old wrap).
export function savePasskeyWrap({ credentialId, fingerprint, prfSalt, ciphertext, iv, tag }) {
  getDb().prepare(`INSERT INTO commit_signing_passkeys
      (credential_id, key_fingerprint, prf_salt, wrapped, wrap_nonce, wrap_tag, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(credential_id) DO UPDATE SET
        key_fingerprint = excluded.key_fingerprint, prf_salt = excluded.prf_salt,
        wrapped = excluded.wrapped, wrap_nonce = excluded.wrap_nonce, wrap_tag = excluded.wrap_tag,
        created_at = excluded.created_at`)
    .run(credentialId, fingerprint, prfSalt, ciphertext, iv, tag, Date.now());
}

export function deletePasskeyWraps() {
  return getDb().prepare('DELETE FROM commit_signing_passkeys').run().changes;
}

// Wraps made for a key that is no longer the configured one are useless and
// would only keep an old passphrase around.
export function deleteWrapsForOtherKeys(fingerprint) {
  return getDb().prepare('DELETE FROM commit_signing_passkeys WHERE key_fingerprint != ?').run(fingerprint ?? '').changes;
}

// --- audit log -----------------------------------------------------------------

export function recordSignature({ cwd, app, fingerprint, tree, parents, subject, payloadSha256, now = Date.now() }) {
  const db = getDb();
  db.prepare(`INSERT INTO commit_signatures
      (created_at, cwd, app, key_fingerprint, tree, parents, subject, payload_sha256)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(now, cwd, app ?? null, fingerprint, tree, parents.join(' '), subject, payloadSha256);
  db.prepare(`DELETE FROM commit_signatures WHERE id <= (
      SELECT id FROM commit_signatures ORDER BY id DESC LIMIT 1 OFFSET ?)`).run(AUDIT_KEEP_ROWS);
}

export function listSignatures({ limit = 50 } = {}) {
  const n = Math.min(Math.max(Number(limit) || 50, 1), 500);
  return getDb()
    .prepare('SELECT * FROM commit_signatures ORDER BY id DESC LIMIT ?')
    .all(n)
    .map((r) => ({
      id: r.id,
      createdAt: r.created_at,
      cwd: r.cwd,
      app: r.app,
      fingerprint: r.key_fingerprint,
      tree: r.tree,
      parents: r.parents ? r.parents.split(' ') : [],
      subject: r.subject,
      payloadSha256: r.payload_sha256,
    }));
}
