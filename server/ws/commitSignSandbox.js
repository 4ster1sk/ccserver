// The sandbox half of host-side commit signing that both backends share
// (bwrap: sandbox.js, VM: sandbox-qemu.js / qemuVmPool.js). Leaf module on
// purpose -- sandbox-qemu.js must not pull in the DB or gpg code.

// Fixed in-sandbox paths (bwrap binds them; the VM backends link them from
// the read-only runtime share).
export const SANDBOX_GPG_SIGN_PATH = '/ccserver-sandbox-gpg-sign.cjs';
export const SANDBOX_SIGNING_PUBKEY_PATH = '/ccserver-sandbox-signing-pubkey.asc';

// The git config a signing session runs with: its identity IS the key's
// UID (the host refuses commits by anyone else), every commit is signed
// through the wrapper, and tags are not (the host refuses them).
export function signingGitConfig(key) {
  return [
    ['user.name', key.nameReal],
    ['user.email', key.nameEmail],
    ['user.signingkey', `${key.signingFingerprint}!`],
    ['commit.gpgsign', 'true'],
    ['gpg.format', 'openpgp'],
    ['gpg.program', SANDBOX_GPG_SIGN_PATH],
    ['tag.gpgSign', 'false'],
  ];
}
