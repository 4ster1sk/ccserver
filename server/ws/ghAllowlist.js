// Decides whether a `gh` invocation from inside the sandbox may be forwarded
// to the host and actually executed (by git-broker.js, over the same socket
// used for git HTTPS credentials -- see that file's protocol comment).
//
// gh's own API surface can't be repo-scoped by terminating/proxying its TLS
// traffic (that's why plain `gh` is bound-over inside the sandbox at all --
// see sandbox.js), so instead of trying to inspect network traffic we run
// specific, known-safe gh subcommands ourselves, on the host, after
// resolving which repo(s) they target and checking every one of them
// against the same allow-list already computed for git (gitAllowlist.js).
// Anything not explicitly named in ALLOWED is refused -- most importantly:
//   - `gh api` (any GitHub API endpoint, not repo-scoped at all -- could
//     read/write far beyond any single repo). The one exception: a GET
//     against repos/{owner}/{repo}/actions/... is repo-scoped and read-only,
//     so it's allowed (see classifyGhApi below); every other `gh api` call
//     is still refused.
//   - `gh auth` / `gh secret` / `gh variable` / `gh ssh-key` / `gh gpg-key`
//     (credential/secret management, not a repo operation)
//   - `gh repo clone` / `fork` / `create` / `delete` / `rename` (the target
//     repo is a bare positional argument with subcommand-specific parsing;
//     rather than reimplement that parsing to gate it, these are refused --
//     `gh repo view` is allowed since its target is only --repo/cwd/a bare
//     owner-repo positional, all handled below)
//
// This is an allow-list, not a deny-list: a new gh subcommand is refused by
// default until someone deliberately adds it here.
//
// Two argument-shape pitfalls this module exists to close (found in review,
// before this ever shipped -- see git history for the concrete repro):
//
//   1. Bundled short flags. gh uses pflag/Cobra, which bundles short flags
//      into one token (`-wR value` == `-w -R value`, R's value taken from
//      the rest of the token or the next one). If we don't recognize a
//      bundled "-R", we'd resolve/check the WRONG repo (falling back to cwd)
//      while the real `gh` binary -- parsing the same argv with its own,
//      complete grammar -- still finds and acts on the hidden -R's actual
//      target. Rather than reimplement gh's full short-flag grammar
//      (fragile, drifts as gh's flags change -- see the ssh wrapper's argv
//      parser for the same class of problem), any short token that could
//      possibly be bundling something is refused outright: only a lone "-R"
//      or the unambiguous attached form "-Rvalue" are accepted; standalone
//      2-char short flags (e.g. "-w", "-t") are harmless (nothing to bundle
//      in a single letter) and left alone.
//
//   2. Positional URLs. Several allowed subcommands accept
//      `<number>|<url>|<branch>` (pr view/checkout/diff/merge/close/edit/...,
//      issue view/close/edit/...) or `[HOST/]OWNER/REPO|<url>` (repo view).
//      When given a URL (or, for `repo view`, a bare owner/repo), gh
//      resolves the repo FROM THAT ARGUMENT, ignoring --repo/-R and the
//      cwd's remote entirely -- e.g. `gh pr merge <url-to-unrelated-repo>`
//      would otherwise sail through as "repo resolved from cwd, allowed"
//      while actually merging a PR in a completely different, unchecked
//      repo. Every URL-shaped token anywhere in argv, and (for `repo view`
//      only, where a bare positional is meaningful) every bare
//      owner/repo-shaped token, is therefore treated as its own required
//      repo reference.

import { normalizeGitUrl } from './gitAllowlist.js';

const ALLOWED = {
  pr: new Set(['create', 'view', 'list', 'edit', 'comment', 'merge', 'close', 'reopen', 'ready', 'review', 'checks', 'diff', 'status', 'checkout']),
  issue: new Set(['create', 'view', 'list', 'edit', 'comment', 'close', 'reopen', 'status']),
  release: new Set(['create', 'view', 'list', 'edit', 'delete', 'upload', 'download', 'delete-asset']),
  workflow: new Set(['run', 'view', 'list', 'enable', 'disable']),
  run: new Set(['list', 'view', 'watch']),
  repo: new Set(['view']),
};

const URL_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;

// The only `gh api` endpoint shape allowed: a GET on repos/{owner}/{repo}/
// actions/... . The leading "/" is optional; owner/repo are either the
// "{owner}"/"{repo}" placeholders gh fills from --repo/cwd, or literal
// owner/repo strings. Anything under actions/ is required (a bare
// "repos/o/r/actions" call has no real-world use, so it's not accepted).
// graphql, /user, /orgs/..., non-actions repos/... endpoints, and absolute
// URLs (https://api.github.com/...) all fail this regex and stay refused.
const API_ACTIONS_PATH_RE = /^\/?repos\/([^/]+)\/([^/]+)\/actions\/.+$/;

// workflow run/enable/disable trigger/write operations (kick off CI, toggle
// a workflow's on/off state), so unlike every other subcommand they must NOT
// silently fall back to the cwd origin -- an explicit --repo/-R or a URL
// positional in argv is required. Read-only subcommands (pr/issue/release/
// repo view, run/workflow view+list, gh api Actions) keep the cwd fallback.
const REQUIRE_EXPLICIT_REPO = new Set(['workflow:run', 'workflow:enable', 'workflow:disable']);

// See pitfall (1) above. Only a bare "-R" or the attached "-Rvalue" form are
// unambiguous; any other multi-letter short-dash token (length > 2, not
// starting with "-R") could be bundling flags we don't know about, possibly
// including a hidden "-R". A 2-char short flag ("-w", "-t", ...) can't bundle
// anything -- there's only one letter -- so those are left alone.
function hasAmbiguousShortFlag(argv) {
  return argv.some((a) => {
    if (a === '-' || !a.startsWith('-') || a.startsWith('--')) return false;
    if (a === '-R' || a.length <= 2) return false;
    return !a.startsWith('-R');
  });
}

// Find the value of -R/--repo in argv, in any of gh's accepted forms
// (`-R owner/repo`, `-Rowner/repo`, `--repo owner/repo`, `--repo=owner/repo`).
function parseRepoFlag(argv) {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-R' || a === '--repo') return argv[i + 1] || null;
    if (a.startsWith('--repo=')) return a.slice('--repo='.length);
    if (a.startsWith('-R') && a.length > 2) return a.slice(2);
  }
  return null;
}

// A PR/issue/discussion URL (https://github.com/owner/repo/pull/123) points
// at a repo just as much as a plain repo URL does, but has extra path
// segments after owner/repo -- normalizeGitUrl alone would keep them as
// part of the "path" and never match the plain "host/owner/repo" allow-list
// entry. Take only the first two path segments (owner/repo) from the URL,
// then run those through normalizeGitUrl for the actual host normalization.
function repoFromUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  const segments = u.pathname.split('/').filter(Boolean);
  if (segments.length < 2) return null;
  return normalizeGitUrl(`https://${u.host}/${segments[0]}/${segments[1]}`);
}

// gh's -R/--repo (and repo view's bare positional) accepts "OWNER/REPO"
// (assumed github.com), "HOST/OWNER/REPO", or a full URL.
function normalizeOwnerRepoOrUrl(raw) {
  if (!raw) return null;
  if (URL_RE.test(raw)) return repoFromUrl(raw);
  const parts = raw.split('/').filter(Boolean);
  if (parts.length === 2) return normalizeGitUrl(`https://github.com/${parts[0]}/${parts[1]}`);
  if (parts.length === 3) return normalizeGitUrl(`https://${parts[0]}/${parts[1]}/${parts[2]}`);
  return null;
}

// `gh api`'s data flags (-f/--raw-field, -F/--field, --input) silently turn
// the default HTTP method into POST when no method is given, and the bundled
// short-flag hazard (-fX bundling -f with -X) can't be safely distinguished
// here -- so for `api` specifically, short flags are refused entirely (only
// long-form flags are accepted) and the data flags are always refused (v1:
// no GET-query-parameter via -f/--field yet -- could be relaxed later by
// allowing them when --method=GET is explicit). If --method is present its
// value (either form) must be GET (case-insensitive); omitting --method is
// fine since the data flags are already banned, so gh's default (GET) can't
// silently become POST. Returns true when the invocation must be refused.
function apiRejectsFlags(argv) {
  return argv.some((a, i) => {
    if (a === '-' || !a.startsWith('-')) return false;
    if (!a.startsWith('--')) return true; // any short-flag token is refused
    if (a === '--raw-field' || a.startsWith('--raw-field=') ||
        a === '--field' || a.startsWith('--field=') ||
        a === '--input' || a.startsWith('--input=')) return true;
    if (a === '--method') {
      const v = argv[i + 1];
      return !v || v.toUpperCase() !== 'GET';
    }
    if (a.startsWith('--method=')) return a.slice('--method='.length).toUpperCase() !== 'GET';
    return false;
  });
}

// The dedicated `gh api` path: only GETs on repos/{owner}/{repo}/actions/...
// (see API_ACTIONS_PATH_RE) are allowed. The endpoint's own owner/repo, when
// literal, is collected as its own required repo reference (pitfall 2: an
// endpoint naming one repo plus a --repo flag naming another must have both
// checked by the caller). When {owner}/{repo} placeholders are used, gh
// fills them from the repo flag / cwd, so the explicit flag (or the cwd
// fallback below) is the repo the endpoint actually targets.
function classifyGhApi(argv, resolveCwdOrigin) {
  const endpoint = argv[1];
  if (!endpoint || !API_ACTIONS_PATH_RE.test(endpoint)) {
    return { allowed: false, repos: [], reason: 'subcommand-not-allowed' };
  }
  if (apiRejectsFlags(argv)) {
    return { allowed: false, repos: [], reason: 'ambiguous-flags' };
  }

  const [, owner, repo] = API_ACTIONS_PATH_RE.exec(endpoint);
  const ownerIsPlaceholder = owner === '{owner}';
  const repoIsPlaceholder = repo === '{repo}';

  const repoFlagValue = parseRepoFlag(argv);
  const explicit = repoFlagValue ? normalizeOwnerRepoOrUrl(repoFlagValue) : null;
  if (repoFlagValue && !explicit) return { allowed: false, repos: [], reason: 'repo-unresolved' };

  const repos = new Set();
  if (explicit) repos.add(explicit);

  if (!ownerIsPlaceholder && !repoIsPlaceholder) {
    const literal = normalizeGitUrl(`https://github.com/${owner}/${repo}`);
    if (!literal) return { allowed: false, repos: [], reason: 'repo-unresolved' };
    repos.add(literal);
  }

  if (repos.size === 0) {
    const fallback = normalizeGitUrl(resolveCwdOrigin() || '');
    if (!fallback) return { allowed: false, repos: [], reason: 'repo-unresolved' };
    repos.add(fallback);
  }

  return { allowed: true, repos: [...repos], reason: null };
}

// Classify a gh invocation. `resolveCwdOrigin` is a callback returning the
// session cwd's raw origin remote URL (or null) -- called lazily, only when
// no repo reference is found anywhere in argv, since it shells out to git.
//
// Returns { allowed, repos, reason }:
//   - allowed: whether the subcommand is on the safelist AND every repo
//     reference found in argv could be resolved. This does NOT check the
//     resolved repo(s) against the session's git allow-list -- callers must
//     do that themselves (see git-broker.js), since this module only knows
//     about gh's own argument shape.
//   - repos: array of normalized "host[:port]/path" targets that must ALL be
//     allow-listed (usually one entry; can be more if e.g. both --repo and a
//     URL positional are present).
//   - reason: set when allowed is false ('subcommand-not-allowed',
//     'ambiguous-flags', 'repo-unresolved', or 'repo-must-be-explicit').
export function classifyGhInvocation(argv, resolveCwdOrigin) {
  const top = argv[0];
  const sub = argv[1];

  // `gh api` has no subcommand in the safelist sense -- its first positional
  // is the endpoint. Route it to its own dedicated (Actions-read-only-only)
  // classifier before the generic subcommand check below.
  if (top === 'api') {
    return classifyGhApi(argv, resolveCwdOrigin);
  }

  if (!top || !ALLOWED[top] || !sub || !ALLOWED[top].has(sub)) {
    return { allowed: false, repos: [], reason: 'subcommand-not-allowed' };
  }
  if (hasAmbiguousShortFlag(argv)) {
    return { allowed: false, repos: [], reason: 'ambiguous-flags' };
  }

  const rest = argv.slice(2);
  const repoFlagValue = parseRepoFlag(argv);
  const explicit = repoFlagValue ? normalizeOwnerRepoOrUrl(repoFlagValue) : null;
  if (repoFlagValue && !explicit) return { allowed: false, repos: [], reason: 'repo-unresolved' };

  const urlRefs = rest.filter((a) => URL_RE.test(a)).map((u) => repoFromUrl(u));
  if (urlRefs.some((u) => !u)) return { allowed: false, repos: [], reason: 'repo-unresolved' };

  // `repo view`'s positional accepts a bare owner/repo shorthand too (not
  // just a URL) -- everything else's non-URL positionals are numbers/branch
  // names/tags/workflow ids, never a repo reference, so this only applies here.
  let bareRepoRefs = [];
  if (top === 'repo') {
    bareRepoRefs = rest
      .filter((a) => a !== repoFlagValue && !a.startsWith('-') && !URL_RE.test(a))
      .map((a) => normalizeOwnerRepoOrUrl(a))
      .filter(Boolean); // tokens that don't parse as owner/repo are flag values etc. -- not a repo reference, ignored
  }

  const repos = new Set();
  if (explicit) repos.add(explicit);
  for (const u of urlRefs) repos.add(u);
  for (const r of bareRepoRefs) repos.add(r);

  if (repos.size === 0) {
    if (REQUIRE_EXPLICIT_REPO.has(`${top}:${sub}`)) {
      return { allowed: false, repos: [], reason: 'repo-must-be-explicit' };
    }
    const fallback = normalizeGitUrl(resolveCwdOrigin() || '');
    if (!fallback) return { allowed: false, repos: [], reason: 'repo-unresolved' };
    repos.add(fallback);
  }

  return { allowed: true, repos: [...repos], reason: null };
}
