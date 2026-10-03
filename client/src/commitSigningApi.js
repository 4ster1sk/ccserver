import { postJson, runPrfCeremony } from './passkeyStepUp.js';

// Host-side commit signing key (server: routes/commitSigning.js). The
// passphrase goes straight into the request body and nowhere else: never
// kept in state longer than the input field, never stored in the browser.

export function unlockWithPassphrase(passphrase) {
  return postJson('/api/commit-signing/unlock', { passphrase });
}

export function unlockWithPasskey() {
  return runPrfCeremony({
    optionsUrl: '/api/commit-signing/passkeys/unlock-options',
    verifyUrl: '/api/commit-signing/passkeys/unlock-verify',
  });
}

export function enrollPasskey(passphrase) {
  return runPrfCeremony({
    optionsUrl: '/api/commit-signing/passkeys/enroll-options',
    verifyUrl: '/api/commit-signing/passkeys/enroll-verify',
    verifyExtra: { passphrase },
  });
}

export function lockSigningKey() {
  return postJson('/api/commit-signing/lock', {});
}
