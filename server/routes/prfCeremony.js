// WebAuthn PRF step-up ceremonies, shared by every route that needs a live
// PRF evaluation from a registered passkey (today: the commit signing key's
// passkey quick-unlock, routes/commitSigning.js). Carried over from the
// retired GPG vault routes; the reasoning there still holds:
//
//  - userVerification 'required': this gates real secret material.
//  - PRF results are NOT covered by the assertion signature. For an ENROLLED
//    credential a wrong value only makes the AES-GCM unwrap fail closed; for
//    a credential being newly enrolled the value is unverifiable, so
//    enrolment must be authorized by something else (for the signing key:
//    the passphrase itself).
//  - every PRF salt is server-chosen and kept server-side in the challenge
//    flow, never trusted from the client.
//  - failures stay generic: specific rejection reasons are exactly what a
//    prober wants.

import { generateAuthenticationOptions, verifyAuthenticationResponse } from '@simplewebauthn/server';
import {
  startChallengeFlow,
  consumeChallengeFlowData,
  flowCookieHeader,
  clearFlowCookieHeader,
  resolveRpID,
  resolveOrigin,
} from '../webauthnChallenges.js';
import { getDb } from '../db.js';

export const b64u = (buf) => Buffer.from(buf).toString('base64url');

// `prf` is { eval: {first} } (one salt for whichever credential answers) or
// { evalByCredential: { id: { first } } }.
export async function prfAuthenticationOptions(request, allowCredentials, prf) {
  return generateAuthenticationOptions({
    rpID: resolveRpID(request),
    allowCredentials,
    userVerification: 'required',
    extensions: { prf },
  });
}

function parsePrfResult(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  const buf = Buffer.from(value, 'base64url');
  return buf.length >= 16 ? buf : null;
}

// Verifies one assertion against `expectedChallenge`, then reads its PRF
// output. Returns { credentialId, prfFirst } (prfFirst is the caller's to
// zero) or { status, error }.
export async function verifyPrfAssertion(request, response, expectedChallenge) {
  if (!response || typeof response !== 'object' || typeof response.id !== 'string') {
    return { status: 400, error: 'response is required' };
  }
  const row = getDb().prepare('SELECT id, public_key, counter FROM webauthn_credentials WHERE id = ?').get(response.id);
  if (!row) return { status: 401, error: 'verification failed' };

  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge,
      expectedOrigin: resolveOrigin(request),
      expectedRPID: resolveRpID(request),
      credential: { id: row.id, publicKey: row.public_key, counter: row.counter },
      requireUserVerification: true,
    });
  } catch {
    verification = { verified: false };
  }
  if (!verification.verified) return { status: 401, error: 'verification failed' };

  // Replay defense, same as auth.js: persist the new counter regardless of
  // what happens with the PRF result below.
  getDb().prepare('UPDATE webauthn_credentials SET counter = ?, last_used_at = ? WHERE id = ?')
    .run(verification.authenticationInfo.newCounter, Date.now(), row.id);

  const prfFirst = parsePrfResult(response.clientExtensionResults?.prf?.results?.first);
  if (!prfFirst) {
    return { status: 401, error: 'このパスキーはPRF (クイックアンロック) に対応していません。別のパスキーで再試行してください。' };
  }
  return { credentialId: row.id, prfFirst };
}

export function zero(...bufs) {
  for (const b of bufs) if (b) b.fill(0);
}

// One-time flow: consumed and its cookie cleared regardless of outcome.
export function consumeFlow(request, reply, kind) {
  const flow = consumeChallengeFlowData(request, kind);
  reply.header('Set-Cookie', clearFlowCookieHeader());
  if (!flow) {
    reply.code(401).send({ error: 'ceremony expired or not found -- request new options first' });
    return null;
  }
  return flow;
}

export function startFlow(request, reply, kind, challenge, data) {
  const flowId = startChallengeFlow(kind, challenge, data);
  reply.header('Set-Cookie', flowCookieHeader(flowId, { secure: request.protocol === 'https' }));
}
