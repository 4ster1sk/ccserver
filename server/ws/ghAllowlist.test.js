import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { classifyGhInvocation } from './ghAllowlist.js';

const ORIGIN = 'https://github.com/testowner/testrepo.git';
const cwdOrigin = () => ORIGIN;
const REPO = 'github.com/testowner/testrepo';

describe('classifyGhInvocation: subcommand safelist', () => {
  test('allowed subcommand, implicit repo from cwd origin', () => {
    const r = classifyGhInvocation(['pr', 'view', '1'], cwdOrigin);
    assert.deepEqual(r, { allowed: true, repos: [REPO], reason: null });
  });

  test('gh api is refused (not repo-scopable)', () => {
    const r = classifyGhInvocation(['api', '/user'], cwdOrigin);
    assert.equal(r.allowed, false);
    assert.equal(r.reason, 'subcommand-not-allowed');
  });

  for (const top of ['auth', 'secret', 'variable', 'ssh-key', 'gpg-key', 'gist', 'org']) {
    test(`gh ${top} is refused entirely`, () => {
      const r = classifyGhInvocation([top, 'list'], cwdOrigin);
      assert.equal(r.allowed, false);
      assert.equal(r.reason, 'subcommand-not-allowed');
    });
  }

  for (const sub of ['clone', 'fork', 'create', 'delete', 'rename']) {
    test(`gh repo ${sub} is refused (arbitrary target repo as bare positional)`, () => {
      const r = classifyGhInvocation(['repo', sub, 'someone/other'], cwdOrigin);
      assert.equal(r.allowed, false);
      assert.equal(r.reason, 'subcommand-not-allowed');
    });
  }

  test('unknown top-level command is refused', () => {
    const r = classifyGhInvocation(['completely-made-up'], cwdOrigin);
    assert.equal(r.allowed, false);
    assert.equal(r.reason, 'subcommand-not-allowed');
  });

  test('empty argv is refused', () => {
    const r = classifyGhInvocation([], cwdOrigin);
    assert.equal(r.allowed, false);
    assert.equal(r.reason, 'subcommand-not-allowed');
  });
});

describe('classifyGhInvocation: --repo/-R resolution', () => {
  test('--repo OWNER/REPO matching the allow-listed repo', () => {
    const r = classifyGhInvocation(['issue', 'list', '--repo', 'testowner/testrepo'], cwdOrigin);
    assert.deepEqual(r, { allowed: true, repos: [REPO], reason: null });
  });

  test('--repo pointing at an unrelated repo still resolves (allow-list check happens in the broker, not here)', () => {
    const r = classifyGhInvocation(['issue', 'list', '--repo', 'someoneelse/unrelated'], cwdOrigin);
    assert.equal(r.allowed, true);
    assert.deepEqual(r.repos, ['github.com/someoneelse/unrelated']);
  });

  test('-R attached form (-Rowner/repo)', () => {
    const r = classifyGhInvocation(['pr', 'list', '-Rtestowner/testrepo'], cwdOrigin);
    assert.equal(r.allowed, true);
    assert.deepEqual(r.repos, [REPO]);
  });

  test('--repo=owner/repo form', () => {
    const r = classifyGhInvocation(['pr', 'list', '--repo=testowner/testrepo'], cwdOrigin);
    assert.equal(r.allowed, true);
    assert.deepEqual(r.repos, [REPO]);
  });

  test('--repo with HOST/OWNER/REPO form', () => {
    const r = classifyGhInvocation(['pr', 'list', '--repo', 'github.example.com/testowner/testrepo'], cwdOrigin);
    assert.equal(r.allowed, true);
    assert.deepEqual(r.repos, ['github.example.com/testowner/testrepo']);
  });

  test('--repo with a garbage value fails to resolve', () => {
    const r = classifyGhInvocation(['pr', 'list', '--repo', 'not-a-repo-shape'], cwdOrigin);
    assert.equal(r.allowed, false);
    assert.equal(r.reason, 'repo-unresolved');
  });
});

describe('classifyGhInvocation: bundled short-flag safety (security)', () => {
  test('a standalone 2-char short flag is fine', () => {
    const r = classifyGhInvocation(['pr', 'view', '123', '-w'], cwdOrigin);
    assert.equal(r.allowed, true);
  });

  test('lone -R is fine (handled explicitly)', () => {
    const r = classifyGhInvocation(['pr', 'view', '-R', 'testowner/testrepo', '1'], cwdOrigin);
    assert.equal(r.allowed, true);
  });

  test('a bundled short flag that could be hiding -R is refused outright, even when it does not actually contain R', () => {
    // We can't know without gh's full flag schema whether "-qt" bundles a
    // hidden -R or not -- refuse conservatively either way.
    const r = classifyGhInvocation(['pr', 'view', '-qt', '1'], cwdOrigin);
    assert.equal(r.allowed, false);
    assert.equal(r.reason, 'ambiguous-flags');
  });

  test('SECURITY: -wR bundling -w and -R must not silently resolve to the cwd repo', () => {
    // This is the actual attack this check exists for: gh's real parser
    // (pflag/Cobra) would treat "-wR" as "-w -R", executing against
    // "someoneelse/unrelated" -- but naive parsing that only recognizes a
    // bare "-R" token would miss it and fall back to the (allow-listed) cwd
    // origin, approving a command that actually targets a different repo.
    const r = classifyGhInvocation(['pr', 'view', '-wR', 'someoneelse/unrelated', '5'], cwdOrigin);
    assert.equal(r.allowed, false);
    assert.equal(r.reason, 'ambiguous-flags');
  });
});

describe('classifyGhInvocation: positional URL targets (security)', () => {
  test('a PR URL to the allow-listed repo resolves to that repo, ignoring the /pull/N suffix', () => {
    const r = classifyGhInvocation(['pr', 'view', 'https://github.com/testowner/testrepo/pull/42'], cwdOrigin);
    assert.equal(r.allowed, true);
    assert.deepEqual(r.repos, [REPO]);
  });

  test('SECURITY: a PR URL to an unrelated repo is surfaced as its own repo reference, not silently defaulted to cwd', () => {
    // gh itself resolves the target repo FROM the URL, ignoring cwd/--repo
    // entirely -- classifyGhInvocation must report that repo (the caller in
    // git-broker.js is the one that actually denies it against the
    // allow-list), not the cwd's repo.
    const r = classifyGhInvocation(['pr', 'merge', 'https://github.com/someoneelse/unrelated/pull/999', '--squash'], cwdOrigin);
    assert.equal(r.allowed, true);
    assert.deepEqual(r.repos, ['github.com/someoneelse/unrelated']);
  });

  test('a plain PR number does not trigger URL handling and falls back to cwd origin', () => {
    const r = classifyGhInvocation(['pr', 'view', '42'], cwdOrigin);
    assert.equal(r.allowed, true);
    assert.deepEqual(r.repos, [REPO]);
  });

  test('a branch name (not a URL) also falls back to cwd origin', () => {
    const r = classifyGhInvocation(['pr', 'checkout', 'feature/some-branch'], cwdOrigin);
    assert.equal(r.allowed, true);
    assert.deepEqual(r.repos, [REPO]);
  });
});

describe('classifyGhInvocation: repo view bare positional (security)', () => {
  test('bare OWNER/REPO positional matching the allow-listed repo', () => {
    const r = classifyGhInvocation(['repo', 'view', 'testowner/testrepo'], cwdOrigin);
    assert.equal(r.allowed, true);
    assert.deepEqual(r.repos, [REPO]);
  });

  test('SECURITY: bare OWNER/REPO positional to an unrelated repo is surfaced, not defaulted to cwd', () => {
    const r = classifyGhInvocation(['repo', 'view', 'someoneelse/unrelated'], cwdOrigin);
    assert.equal(r.allowed, true);
    assert.deepEqual(r.repos, ['github.com/someoneelse/unrelated']);
  });

  test('no positional falls back to cwd origin', () => {
    const r = classifyGhInvocation(['repo', 'view'], cwdOrigin);
    assert.equal(r.allowed, true);
    assert.deepEqual(r.repos, [REPO]);
  });

  test('a non-repo-shaped stray token (e.g. a flag value) is ignored, not treated as a repo ref', () => {
    const r = classifyGhInvocation(['repo', 'view', '--jq', '.name'], cwdOrigin);
    assert.equal(r.allowed, true);
    assert.deepEqual(r.repos, [REPO]);
  });

  test('this bare-positional handling is specific to `repo view` -- other subcommands do not treat owner/repo-shaped positionals as repo refs', () => {
    // "someone/other" here is a hypothetical branch name, not a repo ref --
    // pr checkout does not accept an owner/repo shorthand.
    const r = classifyGhInvocation(['pr', 'checkout', 'someone/other'], cwdOrigin);
    assert.equal(r.allowed, true);
    assert.deepEqual(r.repos, [REPO]);
  });
});

describe('classifyGhInvocation: no repo context at all', () => {
  test('fails closed when cwd has no origin and no explicit repo reference is given', () => {
    const r = classifyGhInvocation(['pr', 'view', '1'], () => null);
    assert.equal(r.allowed, false);
    assert.equal(r.reason, 'repo-unresolved');
  });
});

describe('classifyGhInvocation: gh run (read-only)', () => {
  test('run list falls back to cwd origin', () => {
    const r = classifyGhInvocation(['run', 'list'], cwdOrigin);
    assert.deepEqual(r, { allowed: true, repos: [REPO], reason: null });
  });

  test('run view <run-id> falls back to cwd origin', () => {
    const r = classifyGhInvocation(['run', 'view', '123456789'], cwdOrigin);
    assert.deepEqual(r, { allowed: true, repos: [REPO], reason: null });
  });

  test('run watch <run-id> falls back to cwd origin', () => {
    const r = classifyGhInvocation(['run', 'watch', '123456789'], cwdOrigin);
    assert.deepEqual(r, { allowed: true, repos: [REPO], reason: null });
  });

  test('run rerun (trigger/write) is refused', () => {
    const r = classifyGhInvocation(['run', 'rerun', '123456789'], cwdOrigin);
    assert.equal(r.allowed, false);
    assert.equal(r.reason, 'subcommand-not-allowed');
  });
});

describe('classifyGhInvocation: gh api (Actions read-only)', () => {
  test('Actions GET endpoint resolves repo from cwd origin', () => {
    const r = classifyGhInvocation(['api', 'repos/testowner/testrepo/actions/runs'], cwdOrigin);
    assert.deepEqual(r, { allowed: true, repos: [REPO], reason: null });
  });

  test('Actions GET with {owner}/{repo} placeholders resolves from --repo', () => {
    const r = classifyGhInvocation(['api', 'repos/{owner}/{repo}/actions/workflows', '--repo', 'testowner/testrepo'], cwdOrigin);
    assert.deepEqual(r, { allowed: true, repos: [REPO], reason: null });
  });

  test('leading slash on the endpoint is accepted', () => {
    const r = classifyGhInvocation(['api', '/repos/testowner/testrepo/actions/runs/123/jobs'], cwdOrigin);
    assert.deepEqual(r, { allowed: true, repos: [REPO], reason: null });
  });

  test('explicit --method=GET is still allowed', () => {
    const r = classifyGhInvocation(['api', 'repos/testowner/testrepo/actions/runs', '--method=GET'], cwdOrigin);
    assert.deepEqual(r, { allowed: true, repos: [REPO], reason: null });
  });

  test('space-separated --method GET is allowed', () => {
    const r = classifyGhInvocation(['api', 'repos/testowner/testrepo/actions/runs', '--method', 'GET'], cwdOrigin);
    assert.deepEqual(r, { allowed: true, repos: [REPO], reason: null });
  });

  test('short-flag data flag -f is refused', () => {
    const r = classifyGhInvocation(['api', 'repos/testowner/testrepo/actions/runs', '-f', 'branch=main'], cwdOrigin);
    assert.equal(r.allowed, false);
    assert.equal(r.reason, 'ambiguous-flags');
  });

  test('--raw-field is refused (could silently flip the default method to POST)', () => {
    const r = classifyGhInvocation(['api', 'repos/testowner/testrepo/actions/runs', '--raw-field', 'branch=main'], cwdOrigin);
    assert.equal(r.allowed, false);
    assert.equal(r.reason, 'ambiguous-flags');
  });

  test('--method POST is refused (read-only only)', () => {
    const r = classifyGhInvocation(['api', 'repos/testowner/testrepo/actions/runs', '--method', 'POST'], cwdOrigin);
    assert.equal(r.allowed, false);
    assert.equal(r.reason, 'ambiguous-flags');
  });

  test('bundled short flag -iX is refused (short flags are fully banned for api)', () => {
    const r = classifyGhInvocation(['api', 'repos/testowner/testrepo/actions/runs', '-iX', 'POST'], cwdOrigin);
    assert.equal(r.allowed, false);
    assert.equal(r.reason, 'ambiguous-flags');
  });

  test('graphql endpoint is refused', () => {
    const r = classifyGhInvocation(['api', 'graphql', '-f', 'query=...'], cwdOrigin);
    assert.equal(r.allowed, false);
    assert.equal(r.reason, 'subcommand-not-allowed');
  });

  test('non-actions endpoint (/user) is refused', () => {
    const r = classifyGhInvocation(['api', '/user'], cwdOrigin);
    assert.equal(r.allowed, false);
    assert.equal(r.reason, 'subcommand-not-allowed');
  });

  test('non-actions repo endpoint is refused', () => {
    const r = classifyGhInvocation(['api', 'repos/testowner/testrepo/issues'], cwdOrigin);
    assert.equal(r.allowed, false);
    assert.equal(r.reason, 'subcommand-not-allowed');
  });

  test('SECURITY: endpoint repo and a conflicting --repo are both surfaced as required references', () => {
    // Same pitfall-2 pattern as pr merge <url> --repo x: gh would call the
    // endpoint's repo regardless of --repo, so the broker must be forced to
    // check BOTH (it denies if either is not allow-listed).
    const r = classifyGhInvocation(['api', 'repos/testowner/testrepo/actions/runs', '--repo', 'someoneelse/unrelated'], cwdOrigin);
    assert.equal(r.allowed, true);
    assert.deepEqual([...r.repos].sort(), ['github.com/someoneelse/unrelated', REPO].sort());
  });
});

describe('classifyGhInvocation: workflow run/enable/disable require explicit repo', () => {
  test('workflow run without --repo/-R is refused (cwd fallback disabled)', () => {
    const r = classifyGhInvocation(['workflow', 'run', 'deploy.yml'], cwdOrigin);
    assert.equal(r.allowed, false);
    assert.equal(r.reason, 'repo-must-be-explicit');
  });

  test('workflow enable without --repo/-R is refused', () => {
    const r = classifyGhInvocation(['workflow', 'enable', '123'], cwdOrigin);
    assert.equal(r.allowed, false);
    assert.equal(r.reason, 'repo-must-be-explicit');
  });

  test('workflow disable without --repo/-R is refused', () => {
    const r = classifyGhInvocation(['workflow', 'disable', '123'], cwdOrigin);
    assert.equal(r.allowed, false);
    assert.equal(r.reason, 'repo-must-be-explicit');
  });

  test('workflow run with --repo OWNER/REPO is allowed', () => {
    const r = classifyGhInvocation(['workflow', 'run', 'deploy.yml', '--repo', 'testowner/testrepo'], cwdOrigin);
    assert.deepEqual(r, { allowed: true, repos: [REPO], reason: null });
  });

  test('workflow run with attached -R form is allowed', () => {
    const r = classifyGhInvocation(['workflow', 'run', 'deploy.yml', '-Rtestowner/testrepo'], cwdOrigin);
    assert.deepEqual(r, { allowed: true, repos: [REPO], reason: null });
  });

  test('SECURITY: workflow run --repo pointing at an unrelated repo surfaces that repo (broker denies it)', () => {
    const r = classifyGhInvocation(['workflow', 'run', 'deploy.yml', '--repo', 'someoneelse/unrelated'], cwdOrigin);
    assert.equal(r.allowed, true);
    assert.deepEqual(r.repos, ['github.com/someoneelse/unrelated']);
  });

  test('regression: workflow view/list still fall back to cwd origin (no explicit-repo gate)', () => {
    assert.deepEqual(classifyGhInvocation(['workflow', 'view', '1'], cwdOrigin), { allowed: true, repos: [REPO], reason: null });
    assert.deepEqual(classifyGhInvocation(['workflow', 'list'], cwdOrigin), { allowed: true, repos: [REPO], reason: null });
  });
});
