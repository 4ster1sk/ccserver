// The host half of sandbox commit signing (plan: sandbox-no-secrets).
//
//   sandbox: git commit -> gpg.program = sandbox-gpg-sign-wrapper.cjs
//     -> git-broker socket {op:'sign-commit'} (per-session token)
//     -> git-broker child -> IPC -> this module (main ccserver process)
//     -> checks -> commitSigning.signPayload() -> signature back to git
//
// Why the main process and not the broker child: a cold key has to be
// unlocked by a human (approval banner + passphrase / passkey), and the
// approval waiters, the routes and the signing agent queue all live here.
//
// What is checked before anything is signed (commitObject.js has the
// reasoning): the payload is an unsigned commit object; author and
// committer are the key's own identity; the committer date is now; tree
// and parents exist in a repository inside the session's project dir;
// the key is the one the session launched with; and a per-session rate
// limit. What is deliberately NOT checked is the content -- the sandbox
// could push the same tree unsigned anyway.
//
// Approval, one of two modes (sandboxOpts / sandbox.config.json
// "commitSigningApproval"):
//   'launch' -- the launch asks first (requestLaunchApproval); a rejected or
//               unanswered request refuses the launch.
//   'sign'   -- the launch does not ask; each commit that passes the checks
//               asks instead (requestSignApproval), and the banner can let
//               the rest of the session go without asking
//               (grantSessionSigning).

import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { isAbsolute, sep } from 'node:path';
import { promisify } from 'node:util';
import { parseCommitPayload, checkCommitPolicy, CommitPayloadError } from '../commitObject.js';
import * as commitSigning from '../commitSigning.js';
import { recordSignature } from '../commitSigningDb.js';
import { requestApproval, decideApproval, getApproval, listPendingApprovalIds, setApprovalDecisionGuard } from './approvals.js';
import { hardenedGitEnv } from './hostGitEnv.js';

const execFileAsync = promisify(execFile);

export const RATE_LIMIT = Object.freeze({ max: 300, windowMs: 10 * 60 * 1000 });
const OBJECT_CHECK_TIMEOUT_MS = 10_000;

// --- launch -------------------------------------------------------------------

// The signing key for a launch that asked for commit signing, or a thrown
// Error explaining why that launch cannot have it. Never "launch without":
// a session that asked for signing must not silently get unsigned commits.
export async function resolveLaunchSigningKey({ getSigningKey = commitSigning.getSigningKey } = {}) {
  let key;
  try {
    key = await getSigningKey();
  } catch (err) {
    throw new Error(`commit signing was requested but the host signing key cannot be used: ${err.message}`);
  }
  if (!key) {
    throw new Error('commit signing was requested but no signing key is set up on the host -- set one up in Settings > コミット署名 first.');
  }
  return key;
}

// Approval mode 'launch': the launch asks the user first (one dialog per
// launch; a rejection refuses the launch). Resolves when approved,
// throws otherwise.
export async function requestLaunchApproval({ cwd, app, backend, key }, { request = requestApproval } = {}) {
  const { status } = await request({
    kind: 'commit_signing_launch',
    summary: `${cwd} を ${app || 'shell'} で起動し、コミット署名 (${key.nameReal} <${key.nameEmail}>, ${key.keyId}) を有効にします`,
    payload: { cwd, app: app || null, backend: backend || null, fingerprint: key.signingFingerprint },
    requestedBy: app || null,
  });
  if (status !== 'approved') {
    throw new Error(status === 'expired'
      ? 'commit signing launch approval timed out -- launch refused'
      : 'commit signing launch approval was rejected -- launch refused');
  }
}

// --- per-commit approval ----------------------------------------------------------

// grantId (one per sign handler, i.e. per launch) -> { granted }. granted:
// the user chose "don't ask again for this session" on one of its requests.
const signGrants = new Map();

// Asks before one commit is signed (approval mode 'sign'). Resolves true
// when approved.
export async function requestSignApproval({ cwd, app, dir, commit, key, grantId }, { request = requestApproval } = {}) {
  const { status } = await request({
    kind: 'commit_signing_sign',
    summary: `「${commit.subject.slice(0, 120)}」に署名します (${dir}, tree ${commit.tree.slice(0, 12)}, 鍵 ${key.keyId})`,
    payload: {
      cwd, dir, app: app || null, tree: commit.tree, parents: commit.parents,
      subject: commit.subject.slice(0, 500), fingerprint: key.signingFingerprint, grantId,
    },
    requestedBy: app || null,
  });
  return status === 'approved';
}

// "Approve, and don't ask again for this session": approves the given
// pending sign request and every other one from the same launch, and lets
// that launch's later commits through without asking.
//   { ok:true } | { ok:false, code:'not-found' | 'already-resolved', message }
export function grantSessionSigning(approvalId) {
  const approval = getApproval(approvalId);
  const grant = approval?.kind === 'commit_signing_sign' ? signGrants.get(approval.payload?.grantId) : null;
  if (!grant) return { ok: false, code: 'not-found', message: 'signing approval not found' };
  if (approval.status !== 'pending') return { ok: false, code: 'already-resolved', message: `approval already ${approval.status}` };
  grant.granted = true;
  for (const id of listPendingApprovalIds('commit_signing_sign')) {
    if (getApproval(id)?.payload?.grantId === approval.payload.grantId) decideApproval(id, 'approved', { guards: false });
  }
  return { ok: true };
}

// --- unlock ---------------------------------------------------------------------

let pendingUnlock = null;

// Blocks until the signing key is unlocked (resolves true) or the request
// is rejected / expires (false). Concurrent callers share one request.
export function waitForUnlock({ cwd, app }, { request = requestApproval } = {}) {
  if (!pendingUnlock) {
    pendingUnlock = request({
      kind: 'commit_signing_unlock',
      summary: `コミット署名鍵がロックされています。署名を待っているコミットがあります (${cwd})`,
      payload: { cwd, app: app || null },
      requestedBy: app || null,
    }).then((r) => r.status === 'approved', () => false).finally(() => { pendingUnlock = null; });
  }
  return pendingUnlock;
}

// Call after any successful unlock: every commit waiting on it goes ahead.
export function resolvePendingUnlocks() {
  for (const id of listPendingApprovalIds('commit_signing_unlock')) {
    decideApproval(id, 'approved', { guards: false });
  }
}

// The banner may reject an unlock request, but "approve" only means
// something when the key really is unlocked -- which is done through the
// unlock endpoints, never by the decision route.
export function installApprovalGuards() {
  setApprovalDecisionGuard('commit_signing_unlock', (decision) => (decision === 'approved'
    ? 'unlock the signing key with its passphrase or a passkey to approve this'
    : null));
}

// --- signing -------------------------------------------------------------------

class SignRefusal extends Error {
  constructor(reason, message) {
    super(message);
    this.reason = reason;
  }
}

// dir (from the sandbox) must be inside the session's project dir; both
// sides are compared after realpath so a symlink cannot point outside.
function resolveRepoDir(dir, cwd) {
  const root = realpathSync(cwd);
  if (dir == null) return root;
  if (typeof dir !== 'string' || !isAbsolute(dir)) throw new SignRefusal('bad-request', 'dir must be an absolute path');
  let real;
  try {
    real = realpathSync(dir);
  } catch {
    throw new SignRefusal('outside-project', 'the repository is not visible to the host');
  }
  if (real !== root && !real.startsWith(root + sep)) {
    throw new SignRefusal('outside-project', 'the repository is outside this session\'s project directory');
  }
  return real;
}

// Host git against a sandbox-writable repo: hardened env (hostGitEnv.js),
// and replace refs / grafts off so the object checked is the object named.
async function objectsExist(dir, oids) {
  const env = { ...hardenedGitEnv(), GIT_NO_REPLACE_OBJECTS: '1', GIT_GRAFT_FILE: '/dev/null' };
  for (const oid of oids) {
    try {
      await execFileAsync('git', ['-C', dir, 'cat-file', '-e', oid], { env, timeout: OBJECT_CHECK_TIMEOUT_MS });
    } catch {
      return oid;
    }
  }
  return null;
}

function rateLimiter({ max, windowMs }) {
  const hits = [];
  return (now = Date.now()) => {
    while (hits.length && hits[0] <= now - windowMs) hits.shift();
    if (hits.length >= max) return false;
    hits.push(now);
    return true;
  };
}

// One handler per launch (one per git broker). key: the signing key the
// launch resolved -- signing with any other key is refused.
// approveEachSign: approval mode 'sign' (ask before each commit). The
// returned function has dispose(), called when its broker exits.
// Resolves a git-broker reply: { ok:true, signature, status } (signature
// base64) or { ok:false, reason, message }.
export function createSignHandler({ cwd, app, key, approveEachSign = false }, deps = {}) {
  const {
    signPayload = commitSigning.signPayload,
    waitForUnlock: wait = waitForUnlock,
    requestSignApproval: askSign = requestSignApproval,
    recordSignature: record = recordSignature,
    checkObjects = objectsExist,
    rateLimit = RATE_LIMIT,
    now = () => Date.now(),
  } = deps;
  const allow = rateLimiter(rateLimit);
  const identity = { name: key.nameReal, email: key.nameEmail };
  const grantId = randomUUID();
  const grant = { granted: false };
  if (approveEachSign) signGrants.set(grantId, grant);

  async function handleSign(req) {
    try {
      if (!req || typeof req.payload !== 'string') throw new SignRefusal('bad-request', 'payload is required');
      const payload = Buffer.from(req.payload, 'base64');
      let commit;
      try {
        commit = parseCommitPayload(payload);
      } catch (err) {
        if (err instanceof CommitPayloadError) throw new SignRefusal(err.code, err.message);
        throw err;
      }
      const policy = checkCommitPolicy(commit, { identity, nowSec: Math.floor(now() / 1000) });
      if (policy) throw new SignRefusal(policy.code, policy.message);
      const dir = resolveRepoDir(req.dir ?? null, cwd);
      const missing = await checkObjects(dir, [commit.tree, ...commit.parents]);
      if (missing) throw new SignRefusal('unknown-object', `object ${missing} is not in the repository at ${dir}`);
      if (!allow(now())) throw new SignRefusal('rate-limited', 'too many signatures from this session; try again later');
      // Asked only after the checks: a commit that would be refused anyway
      // never reaches the banner.
      if (approveEachSign && !grant.granted
        && !(await askSign({ cwd, app, dir, commit, key, grantId }))) {
        throw new SignRefusal('not-approved', 'signing this commit was not approved');
      }

      let signed;
      try {
        signed = await signPayload(payload, key.signingFingerprint);
      } catch (err) {
        if (err.code !== 'locked') throw err;
        if (!(await wait({ cwd, app }))) throw new SignRefusal('locked', 'the commit signing key is locked and was not unlocked');
        signed = await signPayload(payload, key.signingFingerprint);
      }

      try {
        record({
          cwd: dir, app, fingerprint: key.signingFingerprint, tree: commit.tree, parents: commit.parents,
          subject: commit.subject, payloadSha256: createHash('sha256').update(payload).digest('hex'),
        });
      } catch (err) {
        // The audit log must not turn a good signature into a failed commit.
        console.warn(`[commit-sign] could not record the signature: ${err.message}`);
      }
      console.log(`[commit-sign] signed ${commit.tree.slice(0, 12)} "${commit.subject.slice(0, 60)}" in ${dir}`);
      return { ok: true, signature: Buffer.from(signed.signature).toString('base64'), status: signed.status };
    } catch (err) {
      const reason = err instanceof SignRefusal ? err.reason : (err.code || 'sign-failed');
      console.warn(`[commit-sign] refused in ${cwd}: ${reason}: ${err.message}`);
      return { ok: false, reason, message: err.message };
    }
  }
  handleSign.dispose = () => { signGrants.delete(grantId); };
  return handleSign;
}

