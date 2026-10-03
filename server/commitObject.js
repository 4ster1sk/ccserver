// Parses and checks the payload git hands its gpg.program when signing a
// commit (plan: sandbox-no-secrets). The sandbox never holds a signing key
// any more: its gpg.program is sandbox-gpg-sign-wrapper.cjs, which forwards
// the payload to the host (git-broker.js -> ws/commitSignService.js), and
// the host signs it ONLY if it is a well-formed, unsigned commit object
// carrying the signing key's own identity. That is the whole point of the
// check: the host must not be a general-purpose signing oracle (tags,
// arbitrary data, ssh-style signatures), only a "sign this commit" service.
//
// The content of the commit is NOT judged -- the sandbox wrote the tree and
// could push it unsigned anyway. What a signature from this key attests is
// "a commit made through this ccserver, as this identity, just now".
//
// Pure: no fs/process/git. Callers check that tree/parents exist in the
// repository (commitSignService.js) -- this file only knows the bytes.

export const MAX_COMMIT_PAYLOAD_BYTES = 1024 * 1024;

// How far the committer timestamp may be from the host's clock. git stamps
// the committer date when it builds the object (also on rebase / amend /
// cherry-pick), so a fresh commit is seconds old; a backdated or future one
// would let a sandbox pre-mint signed commits that look older or newer than
// they are.
export const COMMITTER_TIME_SKEW_SEC = 10 * 60;

const OID_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
// "Name <email> 1700000000 +0900" -- git's ident line. The name may be empty
// in principle; email may be empty (<>) in principle too, both are refused
// later by the identity check.
const IDENT_RE = /^(.*) <([^<>\n]*)> (\d{1,12}) ([+-]\d{4})$/;

export class CommitPayloadError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function fail(code, message) {
  throw new CommitPayloadError(code, message);
}

function parseIdent(value, field) {
  const m = IDENT_RE.exec(value);
  if (!m) fail('bad-ident', `${field} line is not a valid git ident`);
  return { name: m[1], email: m[2], time: Number(m[3]), tz: m[4] };
}

// buf: the exact bytes git wrote to gpg.program's stdin. Returns
// { tree, parents, author, committer, encoding, subject, objectFormat } or
// throws CommitPayloadError.
//
// Header grammar accepted (git's own order, nothing else):
//   tree <oid>
//   parent <oid>          (0..n)
//   author <ident>
//   committer <ident>
//   encoding <name>       (optional)
//   <blank line>
//   <message>
// Refused on purpose:
//   - gpgsig / gpgsig-sha256: already signed (re-signing would let one
//     signature vouch for another key's statement)
//   - mergetag: an embedded tag object (with its own signature); merges of
//     signed tags must be committed without signing
//   - any other header, any continuation line (" ..."), duplicate fields,
//     out-of-order fields, CR characters, NUL bytes.
export function parseCommitPayload(buf) {
  if (!Buffer.isBuffer(buf)) fail('bad-request', 'payload must be bytes');
  if (buf.length === 0) fail('empty', 'empty payload');
  if (buf.length > MAX_COMMIT_PAYLOAD_BYTES) fail('too-large', `payload exceeds ${MAX_COMMIT_PAYLOAD_BYTES} bytes`);
  if (buf.includes(0)) fail('not-a-commit', 'payload contains NUL bytes');

  const sep = buf.indexOf('\n\n');
  if (sep === -1) fail('not-a-commit', 'payload has no header/message separator');
  // Headers must be valid UTF-8: a lossy decode would let the identity that
  // is checked differ from the bytes that are signed.
  let headerText;
  try {
    headerText = new TextDecoder('utf-8', { fatal: true }).decode(buf.subarray(0, sep));
  } catch {
    fail('not-a-commit', 'commit headers are not valid UTF-8');
  }
  if (headerText.includes('\r')) fail('not-a-commit', 'commit headers contain CR');

  const lines = headerText.split('\n');
  let i = 0;
  const next = () => (i < lines.length ? lines[i] : null);
  const field = (line) => {
    const sp = line.indexOf(' ');
    if (sp <= 0) fail('not-a-commit', 'malformed header line');
    return [line.slice(0, sp), line.slice(sp + 1)];
  };

  const first = next();
  if (first === null) fail('not-a-commit', 'missing tree');
  const [k0, tree] = field(first);
  if (k0 !== 'tree') fail('not-a-commit', 'a commit must start with "tree"');
  if (!OID_RE.test(tree)) fail('not-a-commit', 'tree is not an object id');
  i++;

  const parents = [];
  while (next() !== null && next().startsWith('parent ')) {
    const [, oid] = field(next());
    if (!OID_RE.test(oid)) fail('not-a-commit', 'parent is not an object id');
    if (oid.length !== tree.length) fail('not-a-commit', 'mixed object id formats');
    parents.push(oid);
    i++;
  }

  const authorLine = next();
  if (authorLine === null || !authorLine.startsWith('author ')) fail('not-a-commit', 'missing author');
  const author = parseIdent(field(authorLine)[1], 'author');
  i++;

  const committerLine = next();
  if (committerLine === null || !committerLine.startsWith('committer ')) fail('not-a-commit', 'missing committer');
  const committer = parseIdent(field(committerLine)[1], 'committer');
  i++;

  let encoding = null;
  if (next() !== null && next().startsWith('encoding ')) {
    encoding = field(next())[1];
    if (!/^[A-Za-z0-9._-]{1,40}$/.test(encoding)) fail('not-a-commit', 'bad encoding header');
    i++;
  }

  if (i < lines.length) {
    const extra = lines[i];
    const key = extra.startsWith(' ') ? '(continuation)' : extra.split(' ')[0];
    if (key === 'gpgsig' || key === 'gpgsig-sha256') fail('already-signed', 'the commit already carries a signature');
    if (key === 'mergetag') fail('mergetag', 'merges of signed tags (mergetag) are not signed by ccserver -- commit with -c commit.gpgsign=false');
    fail('not-a-commit', `unexpected commit header: ${key.slice(0, 40)}`);
  }

  // The message is never interpreted; the subject is for the audit log only.
  const subject = buf.subarray(sep + 2).toString('utf8').split('\n', 1)[0].slice(0, 200);
  return {
    tree,
    parents,
    author,
    committer,
    encoding,
    subject,
    objectFormat: tree.length === 64 ? 'sha256' : 'sha1',
  };
}

const sameEmail = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase();

// identity: { name, email } of the signing key's UID (what the sandbox's
// user.name / user.email were set to at launch). Returns null when the
// commit may be signed, or { code, message }.
//
// Both author and committer must be this identity: a "Verified" commit
// whose author is someone else would let the sandbox vouch for words it put
// in another person's mouth. Rebasing / cherry-picking someone else's
// commits therefore has to be done without signing.
export function checkCommitPolicy(commit, { identity, nowSec = Math.floor(Date.now() / 1000), skewSec = COMMITTER_TIME_SKEW_SEC }) {
  for (const role of ['author', 'committer']) {
    const who = commit[role];
    if (!sameEmail(who.email, identity.email)) {
      return {
        code: 'identity-mismatch',
        message: `${role} "${who.name} <${who.email}>" is not the signing identity "${identity.name} <${identity.email}>"`
          + ' (commits by someone else -- e.g. a cherry-pick or rebase of their work -- must be made with -c commit.gpgsign=false)',
      };
    }
  }
  if (Math.abs(commit.committer.time - nowSec) > skewSec) {
    return {
      code: 'stale-timestamp',
      message: `committer date is more than ${Math.round(skewSec / 60)} minutes away from now`,
    };
  }
  return null;
}
