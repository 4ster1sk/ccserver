// REST surface for the host-side commit signing key (plan:
// sandbox-no-secrets; commitSigning.js, ws/commitSignService.js). Registered
// under /api, so every route sits behind the server's normal auth hook.
//
// Passphrases arrive in request bodies and go straight to the signing agent
// (commitSigning.unlockSigningKey): never logged, never echoed, never stored
// in the clear, never in pending_approvals (an unlock only ever marks the
// waiting "commit_signing_unlock" approvals approved). The passkey quick
// unlock stores the passphrase wrapped under a passkey's PRF output
// (commitSigningCrypto.js); enrolling one requires the passphrase itself,
// which is what authorizes it (a PRF value for a not-yet-enrolled
// credential is unverifiable, see prfCeremony.js).

import { resolveAuthMode } from '../authMode.js';
import { getRequestSession, hasFreshStepUp } from '../authSessions.js';
import { getDb } from '../db.js';
import { reportSecurityEvent } from '../securityEvents.js';
import * as signing from '../commitSigning.js';
import * as signingDb from '../commitSigningDb.js';
import { generatePrfSalt, wrapPassphrase, unwrapPassphrase } from '../commitSigningCrypto.js';
import { resolvePendingUnlocks } from '../ws/commitSignService.js';
import {
  b64u, prfAuthenticationOptions, verifyPrfAssertion, zero, consumeFlow, startFlow,
} from './prfCeremony.js';

const STATUS_FOR_CODE = {
  'not-configured': 404,
  'already-configured': 409,
  'wrong-passphrase': 401,
  'bad-passphrase': 400,
  'bad-identity': 400,
  'bad-request': 400,
  'bad-key': 400,
  'multiple-keys': 409,
  'no-identity': 400,
  'no-signing-key': 400,
  'key-unusable': 409,
};

function sendError(request, reply, err, what) {
  if (err instanceof signing.SigningError) {
    const status = STATUS_FOR_CODE[err.code] || 500;
    if (status === 500) request.log.warn({ code: err.code }, `${what} failed`);
    // SigningError messages are written for users and never carry a secret.
    return reply.code(status).send({ error: status === 500 ? `${what} failed` : err.message, code: err.code });
  }
  request.log.error({ err: err?.message }, `${what} failed`);
  return reply.code(500).send({ error: `${what} failed` });
}

// Takes the passphrase out of the body (so nothing downstream -- error
// serializers included -- sees it again) as a Buffer the caller zeroes.
function takePassphrase(request) {
  const body = request.body || {};
  const value = body.passphrase;
  body.passphrase = undefined;
  return typeof value === 'string' && value.length > 0 ? Buffer.from(value, 'utf8') : null;
}

const passkeyMode = () => resolveAuthMode() === 'passkey';

function requirePasskeys(reply) {
  if (passkeyMode()) return true;
  reply.code(400).send({ error: 'passkey unlock is only available when CCSERVER_AUTH_MODE=passkey' });
  return false;
}

async function currentKeyOr404(reply) {
  let key = null;
  try {
    key = await signing.getSigningKey();
  } catch (err) {
    reply.code(409).send({ error: err.message, code: err.code });
    return null;
  }
  if (!key) {
    reply.code(404).send({ error: 'no commit signing key is set up', code: 'not-configured' });
    return null;
  }
  return key;
}

async function afterUnlock(key) {
  // Every commit waiting on the key goes ahead now.
  resolvePendingUnlocks();
  return { success: true, fingerprint: key.signingFingerprint };
}

export async function commitSigningRoute(fastify) {
  fastify.get('/commit-signing/status', async () => {
    const status = await signing.getSigningStatus();
    const fp = status.key?.signingFingerprint;
    return {
      ...status,
      passkeys: {
        available: passkeyMode(),
        enrolled: fp && passkeyMode() ? signingDb.listPasskeyWraps(fp).length : 0,
      },
    };
  });

  fastify.get('/commit-signing/public-key', async (request, reply) => {
    const key = await currentKeyOr404(reply);
    if (!key) return reply;
    return { publicKeyArmored: await signing.exportPublicKey(), ...key };
  });

  fastify.get('/commit-signing/signatures', async (request) => ({
    signatures: signingDb.listSignatures({ limit: request.query?.limit }),
  }));

  fastify.post('/commit-signing/generate', async (request, reply) => {
    const passphrase = takePassphrase(request);
    const body = request.body || {};
    try {
      const key = await signing.generateSigningKey({ nameReal: body.nameReal, nameEmail: body.nameEmail, passphrase });
      signingDb.deleteWrapsForOtherKeys(key.signingFingerprint);
      reportSecurityEvent('コミット署名鍵が生成されました', `${key.nameReal} <${key.nameEmail}> ${key.signingFingerprint}`);
      return { success: true, key };
    } catch (err) {
      return sendError(request, reply, err, 'key generation');
    } finally {
      zero(passphrase);
    }
  });

  fastify.post('/commit-signing/import', async (request, reply) => {
    const data = (request.body || {}).keyArmored;
    if (typeof data !== 'string' || !data.trim()) return reply.code(400).send({ error: 'keyArmored is required' });
    const buf = Buffer.from(data, 'utf8');
    try {
      const key = await signing.importSigningKey(buf);
      signingDb.deleteWrapsForOtherKeys(key.signingFingerprint);
      reportSecurityEvent('コミット署名鍵がインポートされました', `${key.nameReal} <${key.nameEmail}> ${key.signingFingerprint}`);
      return { success: true, key };
    } catch (err) {
      return sendError(request, reply, err, 'key import');
    } finally {
      zero(buf);
    }
  });

  // Destroys host key material: in passkey mode a fresh step-up (a user-
  // verified passkey assertion within the last 5 minutes) is required on
  // top of the session.
  fastify.post('/commit-signing/delete-key', async (request, reply) => {
    if (passkeyMode() && !hasFreshStepUp(getRequestSession(request))) {
      return reply.code(403).send({ error: 'deleting the signing key requires a fresh passkey step-up (within 5 minutes)', code: 'STEPUP_REQUIRED' });
    }
    const key = await signing.getSigningKey().catch(() => null);
    await signing.deleteSigningKey();
    signingDb.deletePasskeyWraps();
    reportSecurityEvent('コミット署名鍵が削除されました', key ? key.signingFingerprint : '(unusable key)');
    return { success: true };
  });

  fastify.post('/commit-signing/unlock', async (request, reply) => {
    const passphrase = takePassphrase(request);
    try {
      const key = await signing.unlockSigningKey(passphrase);
      return afterUnlock(key);
    } catch (err) {
      return sendError(request, reply, err, 'unlock');
    } finally {
      zero(passphrase);
    }
  });

  fastify.post('/commit-signing/lock', async () => {
    await signing.lockSigningKey();
    return { success: true };
  });

  // --- passkey quick unlock --------------------------------------------------

  // Enrol: any registered passkey, PRF over a fresh server-chosen salt.
  fastify.post('/commit-signing/passkeys/enroll-options', async (request, reply) => {
    if (!requirePasskeys(reply)) return reply;
    const key = await currentKeyOr404(reply);
    if (!key) return reply;
    const creds = getDb().prepare('SELECT id FROM webauthn_credentials').all();
    const salt = b64u(generatePrfSalt());
    const options = await prfAuthenticationOptions(request, creds.map((c) => ({ id: c.id })), { eval: { first: salt } });
    startFlow(request, reply, 'commit-signing-enroll', options.challenge, { salt, fingerprint: key.signingFingerprint });
    return options;
  });

  // The passphrase authorizes the enrolment: it must actually unlock the key
  // (which also leaves it unlocked) before it is wrapped for this passkey.
  fastify.post('/commit-signing/passkeys/enroll-verify', async (request, reply) => {
    if (!requirePasskeys(reply)) return reply;
    const passphrase = takePassphrase(request);
    let stepUp = null;
    try {
      const flow = consumeFlow(request, reply, 'commit-signing-enroll');
      if (!flow) return reply;
      stepUp = await verifyPrfAssertion(request, (request.body || {}).response, flow.challenge);
      if (stepUp.error) return reply.code(stepUp.status).send({ error: stepUp.error });
      const key = await signing.unlockSigningKey(passphrase);
      if (key.signingFingerprint !== flow.data.fingerprint) {
        return reply.code(409).send({ error: 'the signing key changed during enrolment; try again' });
      }
      const wrap = wrapPassphrase(passphrase, { prfSecret: stepUp.prfFirst, credentialId: stepUp.credentialId, fingerprint: key.signingFingerprint });
      signingDb.savePasskeyWrap({
        credentialId: stepUp.credentialId, fingerprint: key.signingFingerprint,
        prfSalt: Buffer.from(flow.data.salt, 'base64url'), ...wrap,
      });
      reportSecurityEvent('コミット署名鍵のパスキーアンロックが登録されました', `credential: ${stepUp.credentialId.slice(0, 12)}…`);
      return afterUnlock(key);
    } catch (err) {
      return sendError(request, reply, err, 'passkey enrolment');
    } finally {
      zero(passphrase, stepUp?.prfFirst);
    }
  });

  fastify.post('/commit-signing/passkeys/unlock-options', async (request, reply) => {
    if (!requirePasskeys(reply)) return reply;
    const key = await currentKeyOr404(reply);
    if (!key) return reply;
    const wraps = signingDb.listPasskeyWraps(key.signingFingerprint);
    if (wraps.length === 0) return reply.code(404).send({ error: 'no passkey is enrolled for this key', code: 'NO_PASSKEY' });
    const evalByCredential = Object.fromEntries(wraps.map((w) => [w.credentialId, { first: b64u(w.prfSalt) }]));
    const options = await prfAuthenticationOptions(request, wraps.map((w) => ({ id: w.credentialId })), { evalByCredential });
    startFlow(request, reply, 'commit-signing-unlock', options.challenge, { fingerprint: key.signingFingerprint });
    return options;
  });

  fastify.post('/commit-signing/passkeys/unlock-verify', async (request, reply) => {
    if (!requirePasskeys(reply)) return reply;
    let stepUp = null;
    let passphrase = null;
    try {
      const flow = consumeFlow(request, reply, 'commit-signing-unlock');
      if (!flow) return reply;
      stepUp = await verifyPrfAssertion(request, (request.body || {}).response, flow.challenge);
      if (stepUp.error) return reply.code(stepUp.status).send({ error: stepUp.error });
      const wrap = signingDb.getPasskeyWrap(stepUp.credentialId, flow.data.fingerprint);
      if (!wrap) return reply.code(401).send({ error: 'verification failed' });
      try {
        passphrase = unwrapPassphrase(wrap, { prfSecret: stepUp.prfFirst, credentialId: stepUp.credentialId, fingerprint: flow.data.fingerprint });
      } catch {
        return reply.code(401).send({ error: 'verification failed' });
      }
      const key = await signing.unlockSigningKey(passphrase);
      return afterUnlock(key);
    } catch (err) {
      // A stored passphrase that no longer unlocks (changed on the key):
      // say so, so the user re-enrols.
      if (err?.code === 'wrong-passphrase') {
        return reply.code(409).send({ error: 'the stored passphrase no longer unlocks the key -- enrol the passkey again', code: 'STALE_PASSKEY_WRAP' });
      }
      return sendError(request, reply, err, 'passkey unlock');
    } finally {
      zero(passphrase, stepUp?.prfFirst);
    }
  });

  fastify.post('/commit-signing/passkeys/clear', async () => {
    const removed = signingDb.deletePasskeyWraps();
    if (removed) reportSecurityEvent('コミット署名鍵のパスキーアンロックが解除されました', `${removed} passkey(s)`);
    return { success: true, removed };
  });
}
