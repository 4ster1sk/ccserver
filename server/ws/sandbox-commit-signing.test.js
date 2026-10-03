// buildSandboxSpawn's bwrap branch with commit signing on: what the sandbox
// gets (the sign wrapper, the PUBLIC key, the identity -- never a socket or
// key material) and every way the launch is refused instead of silently
// launching unsigned. The real git broker runs; the key, the approval and
// gpg are injected.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSandboxSpawn } from './sandbox.js';

let root;
let repo;
let cfgPath;
let prevCfg;
const spawned = [];

const KEY = { nameReal: 'Sandbox Bot', nameEmail: 'bot@example.com', signingFingerprint: 'A'.repeat(40), keyId: 'AAAAAAAAAAAAAAAA' };

function deps({ approve = true, key = KEY } = {}) {
  const calls = { approvals: [], handlers: [] };
  return {
    calls,
    deps: {
      dockerSandboxAvailable: () => false,
      resolveLaunchSigningKey: async () => {
        if (!key) throw new Error('commit signing was requested but no signing key is set up on the host');
        return key;
      },
      requestLaunchApproval: async (req) => {
        calls.approvals.push(req);
        if (!approve) throw new Error('commit signing launch approval was rejected -- launch refused');
      },
      exportPublicKey: async () => '-----BEGIN PGP PUBLIC KEY BLOCK-----\nTEST\n',
      createSignHandler: (opts) => { calls.handlers.push(opts); return async () => ({ ok: false, reason: 'test' }); },
    },
  };
}

function writeConfig(cfg) {
  writeFileSync(cfgPath, JSON.stringify({ docker: false, persistentHome: false, gitBroker: true, ...cfg }));
}

before(() => {
  root = mkdtempSync(join(tmpdir(), 'ccs-sign-bwrap-'));
  cfgPath = join(root, 'sandbox.config.json');
  prevCfg = process.env.CCSERVER_SANDBOX_CONFIG;
  process.env.CCSERVER_SANDBOX_CONFIG = cfgPath;
  repo = join(root, 'repo');
  mkdirSync(repo);
  // No remote at all: a signing launch still gets a broker to carry the
  // sign requests (the empty allow-list still denies every credential).
  execFileSync('git', ['init', '-q', repo], { env: { ...process.env, GIT_CONFIG_COUNT: '0' } });
  writeConfig({});
});

after(() => {
  for (const s of spawned) {
    try { s.gitBrokerProc?.kill('SIGKILL'); } catch { /* gone */ }
    try { if (s.gitBrokerDir) rmSync(s.gitBrokerDir, { recursive: true, force: true }); } catch { /* gone */ }
  }
  if (prevCfg === undefined) delete process.env.CCSERVER_SANDBOX_CONFIG; else process.env.CCSERVER_SANDBOX_CONFIG = prevCfg;
  rmSync(root, { recursive: true, force: true });
});

const bindsOf = (args, flag) => args.flatMap((x, i) => (x === flag ? [[args[i + 1], args[i + 2]]] : []));
const gitConfigOf = (args) => {
  const env = Object.fromEntries(bindsOf(args, '--setenv'));
  const out = {};
  for (let i = 0; i < Number(env.GIT_CONFIG_COUNT || 0); i++) out[env[`GIT_CONFIG_KEY_${i}`]] = env[`GIT_CONFIG_VALUE_${i}`];
  return { env, cfg: out };
};

test('a signing launch: approved once, wrapper + public key + identity, no agent socket', { skip: process.platform !== 'linux' }, async () => {
  const { deps: d, calls } = deps();
  const s = await buildSandboxSpawn({ cwd: repo, targetCommand: ['/bin/true'], app: 'claude', sandboxOpts: { commitSigning: true } }, d);
  spawned.push(s);
  assert.equal(calls.approvals.length, 1);
  assert.equal(calls.approvals[0].cwd, repo);
  assert.equal(calls.approvals[0].backend, 'bwrap');
  assert.equal(calls.handlers[0].key, KEY);
  assert.ok(s.gitBrokerProc, 'a broker starts for a repo without remotes');
  assert.equal(s.commitSigningActive, true);

  const roBinds = bindsOf(s.args, '--ro-bind');
  assert.ok(roBinds.some(([src, dst]) => src.endsWith('sandbox-gpg-sign-wrapper.cjs') && dst === '/ccserver-sandbox-gpg-sign.cjs'));
  const pub = roBinds.find(([, dst]) => dst === '/ccserver-sandbox-signing-pubkey.asc');
  assert.match(readFileSync(pub[0], 'utf-8'), /PUBLIC KEY BLOCK/);
  const { env, cfg } = gitConfigOf(s.args);
  assert.equal(env.CCSANDBOX_SIGNING_PUBKEY, '/ccserver-sandbox-signing-pubkey.asc');
  assert.equal(cfg['gpg.program'], '/ccserver-sandbox-gpg-sign.cjs');
  assert.equal(cfg['commit.gpgsign'], 'true');
  assert.equal(cfg['user.signingkey'], `${KEY.signingFingerprint}!`);
  assert.equal(cfg['user.name'], KEY.nameReal);
  assert.equal(cfg['user.email'], KEY.nameEmail);
  assert.equal(env.GNUPGHOME, undefined);
  assert.ok(!s.args.some((a) => /S\.gpg-agent/.test(a)), 'no gpg-agent socket of any kind');
});

test('no signing requested: no approval, no wrapper, commitSigningActive false', { skip: process.platform !== 'linux' }, async () => {
  const { deps: d, calls } = deps();
  const s = await buildSandboxSpawn({ cwd: repo, targetCommand: ['/bin/true'], app: 'claude' }, d);
  spawned.push(s);
  assert.equal(calls.approvals.length, 0);
  assert.equal(s.commitSigningActive, false);
  assert.ok(!s.args.includes('/ccserver-sandbox-gpg-sign.cjs'));
  assert.equal(s.gitBrokerProc, null, 'no remotes and no signing: no broker, as before');
});

test('the sandbox.config.json default turns signing on; a launch can turn it off', { skip: process.platform !== 'linux' }, async () => {
  writeConfig({ commitSigning: true });
  try {
    const on = deps();
    const s1 = await buildSandboxSpawn({ cwd: repo, targetCommand: ['/bin/true'], app: 'claude' }, on.deps);
    spawned.push(s1);
    assert.equal(s1.commitSigningActive, true);
    const off = deps();
    const s2 = await buildSandboxSpawn({ cwd: repo, targetCommand: ['/bin/true'], app: 'claude', sandboxOpts: { commitSigning: false } }, off.deps);
    spawned.push(s2);
    assert.equal(s2.commitSigningActive, false);
    assert.equal(off.calls.approvals.length, 0);
  } finally {
    writeConfig({});
  }
});

test('refusals: rejected approval, no key, git broker off -- nothing started, never an unsigned launch', { skip: process.platform !== 'linux' }, async () => {
  const opts = { cwd: repo, targetCommand: ['/bin/true'], app: 'claude', sandboxOpts: { commitSigning: true } };
  const rejected = deps({ approve: false });
  await assert.rejects(buildSandboxSpawn(opts, rejected.deps), /rejected -- launch refused/);
  assert.equal(rejected.calls.handlers.length, 0);

  const noKey = deps({ key: null });
  await assert.rejects(buildSandboxSpawn(opts, noKey.deps), /no signing key/);
  assert.equal(noKey.calls.approvals.length, 0, 'no approval asked for a launch that cannot sign anyway');

  writeConfig({ gitBroker: false });
  try {
    const noBroker = deps();
    await assert.rejects(buildSandboxSpawn(opts, noBroker.deps), /needs the git broker/);
    assert.equal(noBroker.calls.approvals.length, 0);
  } finally {
    writeConfig({});
  }
});
