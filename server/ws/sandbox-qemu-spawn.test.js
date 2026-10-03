// buildSandboxSpawn's qemu branch (buildQemuSpawn) with its brokers and VM
// planning injected: which host services reach the VM, and that everything
// already started is torn down when a later step fails. No VM, no KVM.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSandboxSpawn, qemuLaunchPoolKey, prepareVmClaudeJson } from './sandbox.js';

let dir;
let prevConfig;
before(() => {
  dir = mkdtempSync(join(tmpdir(), 'ccs-qspawn-'));
  prevConfig = process.env.CCSERVER_SANDBOX_CONFIG;
  process.env.CCSERVER_SANDBOX_CONFIG = join(dir, 'sandbox.config.json');
  writeFileSync(process.env.CCSERVER_SANDBOX_CONFIG, JSON.stringify({
    backend: 'qemu', persistentHome: false, gitBroker: true,
    env: { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'user.signingkey', GIT_CONFIG_VALUE_0: 'OLD' },
  }));
});
after(() => {
  if (prevConfig === undefined) delete process.env.CCSERVER_SANDBOX_CONFIG;
  else process.env.CCSERVER_SANDBOX_CONFIG = prevConfig;
  rmSync(dir, { recursive: true, force: true });
});

function fakes({ prepareThrows = false } = {}) {
  const killed = [];
  const mk = (name) => {
    const d = join(dir, `${name}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(d);
    return d;
  };
  const calls = {};
  const deps = {
    dockerSandboxAvailable: () => false,
    startGitBroker: (opts) => {
      calls.gitBroker = opts;
      const d = mk('gb');
      writeFileSync(join(d, 'allowlist.json'), '{}');
      return { proc: { kill: () => killed.push('gitBroker') }, dir: d, sockPath: join(d, 'broker.sock'), allowlistPath: join(d, 'allowlist.json'), token: 'TOK' };
    },
    startCommitGuard: () => {
      const d = mk('cg');
      writeFileSync(join(d, 'commit-guard.json'), '{}');
      return { dir: d, configPath: join(d, 'commit-guard.json') };
    },
    startGoNetworkBroker: (opts) => {
      calls.broker = opts;
      return { proc: { kill: () => killed.push('netBroker') }, dir: mk('nb'), vnetSock: '/x/v', guestSshSock: '/x/s', adminSock: '/x/a', caPem: null, state: opts.state };
    },
    prepareQemuSession: (opts) => {
      calls.prepare = opts;
      if (prepareThrows) throw new Error('no golden VM image');
      return { runDir: join(dir, 'run'), planPath: join(dir, 'run', 'plan.json') };
    },
  };
  return { deps, calls, killed };
}

const launch = (deps, extra = {}) => buildSandboxSpawn({
  cwd: dir, targetCommand: ['bash'], app: 'claude', sandboxOpts: { sshAgent: false },
  notifySocketPath: '/run/n/sock', ...extra,
}, deps);

test('qemu spawn: git broker, commit guard and MCP reach the VM as broker services', { skip: process.platform !== 'linux' }, async () => {
  const { deps, calls } = fakes();
  const r = await launch(deps);
  assert.equal(calls.broker.state, 'open', 'every VM session starts open; the toggle switches to enforce');
  assert.deepEqual(calls.broker.services.map((s) => s.name), ['git-broker', 'mcp-notify']);
  assert.ok(calls.broker.services.every((s) => !('guestPath' in s)), 'only name/addr/unix go to the broker');
  const rt = calls.prepare.runtime;
  assert.equal(rt.env.CCSANDBOX_GIT_BROKER_TOKEN_FILE, '/ccserver-sandbox/git-broker-token');
  assert.deepEqual(rt.gitConfig, [['core.hooksPath', '/ccserver-sandbox-git-hooks']]);
  assert.equal(calls.prepare.env.GIT_CONFIG_KEY_0, 'user.signingkey', 'operator env passed through for prepareQemuSession to merge');
  assert.ok(r.gitBrokerProc && r.gitBrokerDir && r.commitGuardDir, 'teardown handles returned');
  assert.equal(r.commitSigningActive, false);
});

test('qemu spawn: a failure after the brokers started stops and removes all of them', { skip: process.platform !== 'linux' }, async () => {
  const { deps, calls, killed } = fakes({ prepareThrows: true });
  await assert.rejects(launch(deps), /no golden VM image/);
  assert.deepEqual(killed.sort(), ['gitBroker', 'netBroker']);
  assert.ok(calls.broker);
  for (const s of calls.broker.services) {
    if (s.name === 'git-broker') assert.ok(!existsSync(s.unix.replace(/\/broker\.sock$/, '')), 'git broker dir removed');
  }
  assert.ok(!existsSync(calls.prepare.runtime.files.find((f) => f.dest === 'commit-guard.json').src), 'commit guard dir removed');
});

test('qemu spawn: the VM template supplies resources and cloud-config; none -> sandbox.config.json values', { skip: process.platform !== 'linux' }, async () => {
  const { deps, calls } = fakes();
  const asked = [];
  deps.resolveVmTemplate = (id) => {
    asked.push(id);
    return {
      template: { id: 't1', name: 'big', memoryMiB: 8192, cpus: 4, diskGiB: 64, bootTimeoutSec: 600 },
      cloudConfig: { packages: ['htop'] },
    };
  };
  const r = await launch(deps, { sandboxOpts: { sshAgent: false, vmTemplateId: 't1' } });
  assert.deepEqual(asked, ['t1']);
  assert.equal(calls.prepare.memoryMiB, 8192);
  assert.equal(calls.prepare.cpus, 4);
  assert.equal(calls.prepare.diskGiB, 64);
  assert.equal(calls.prepare.bootTimeoutSec, 600);
  assert.deepEqual(calls.prepare.templateCloudConfig, { packages: ['htop'] });
  assert.equal(r.qemuVm.templateName, 'big');
  assert.equal(r.qemuVm.cpus, 4);

  const none = fakes();
  none.deps.resolveVmTemplate = () => null;
  const r2 = await launch(none.deps);
  assert.equal(none.calls.prepare.memoryMiB, 4096, 'config default');
  assert.equal(none.calls.prepare.templateCloudConfig, null);
  assert.equal(r2.qemuVm.templateId, null);
});

test('qemu spawn: a deleted template refuses the launch before any broker starts', { skip: process.platform !== 'linux' }, async () => {
  const { deps, calls } = fakes();
  deps.resolveVmTemplate = () => { throw new Error('the selected VM template has been deleted'); };
  await assert.rejects(launch(deps, { sandboxOpts: { vmTemplateId: 'gone' } }), /has been deleted/);
  assert.equal(calls.gitBroker, undefined);
  assert.equal(calls.broker, undefined);
});

test('qemu spawn: backend is picked per launch, over the configured default', { skip: process.platform !== 'linux' }, async () => {
  const cfgPath = process.env.CCSERVER_SANDBOX_CONFIG;
  const { readFileSync } = await import('node:fs');
  const saved = readFileSync(cfgPath, 'utf-8');
  try {
    writeFileSync(cfgPath, JSON.stringify({ ...JSON.parse(saved), backend: 'bwrap' }));
    const { deps, calls } = fakes();
    deps.resolveVmTemplate = () => null;
    const r = await launch(deps, { sandboxOpts: { backend: 'qemu' } });
    assert.ok(calls.prepare, 'the qemu branch ran although the default is bwrap');
    assert.ok(r.qemuRunDir);
  } finally {
    writeFileSync(cfgPath, saved);
  }
});

// --- persistent (pooled) VM ------------------------------------------------

function withConfig(extra, fn) {
  return async () => {
    const path = process.env.CCSERVER_SANDBOX_CONFIG;
    const saved = JSON.parse(readFileSync(path, 'utf-8'));
    writeFileSync(path, JSON.stringify({ ...saved, ...extra }));
    try { await fn(); } finally { writeFileSync(path, JSON.stringify(saved)); }
  };
}

function fakePool(network = { adminSock: '/run/vm/a.sock', mode: 'open' }) {
  const attaches = [];
  return {
    attaches,
    qemuVmPool: {
      async attach(opts) {
        attaches.push(opts);
        return { planPath: '/run/vm/sessions/t.json', vm: { id: 'vm1', runDir: '/run/vm', startedAt: 1, info: opts.info, network }, release: async () => {} };
      },
    },
  };
}

test('qemu spawn, persistent: joins the pool by template with the launch policy; its own git broker and commit guard', { skip: process.platform !== 'linux' }, withConfig({ qemu: { persistent: true } }, async () => {
  const { deps, calls } = fakes();
  const pool = fakePool();
  const r = await launch({ ...deps, ...pool });
  assert.ok(calls.gitBroker, "a pooled session gets its own git broker");
  assert.equal(calls.broker, undefined, 'the broker is started by the pool, only when it boots a VM');
  assert.ok(r.gitBrokerProc && r.gitBrokerDir && r.commitGuardDir, 'teardown handles returned');
  const a = pool.attaches[0];
  assert.equal(a.session.cwd, dir);
  assert.deepEqual(a.session.argv, ['bash']);
  assert.deepEqual(a.session.fallbackArgv, ['bash', '-l', '-i']);
  assert.equal(a.session.env.GIT_CONFIG_KEY_0, 'user.signingkey');
  assert.equal(a.session.homeHostPath, null, 'persistentHome is off in this config');
  const broker = a.spec.startBroker();
  assert.deepEqual(calls.broker.services, [], 'host services ride each session\'s ssh, not the VM broker');
  const rt = a.session.runtime;
  assert.deepEqual(rt.sockets.map((x) => [x.name, x.guestPath]), [['git-broker', '/ccserver-sandbox-git-broker.sock']]);
  assert.ok(existsSync(join(rt.hostDir, 'git-broker-token')), 'helper files materialized in the per-session runtime dir');
  assert.equal(statSync(join(rt.hostDir, 'git-broker-token')).mode & 0o777, 0o600);
  assert.equal(rt.env.CCSANDBOX_GIT_BROKER_TOKEN_FILE, '/ccserver-sandbox/git-broker-token');
  assert.deepEqual(rt.gitConfig, [['core.hooksPath', '/ccserver-sandbox-git-hooks']]);
  assert.equal(broker.pipeBin.endsWith('ccs-netbroker'), true);
  assert.deepEqual(r.args.slice(1), ['/run/vm/sessions/t.json']);
  assert.equal(r.qemuRunDir, undefined, "the VM's run dir is the pool's, never removed with a session");
  assert.ok(r.qemuPoolLease);
  assert.equal(r.qemuVm.pooled, true);
  assert.equal(r.qemuVm.vmId, 'vm1');
}));

test("qemu spawn, persistent: the network toggle is armed with the VM's broker and its current mode", { skip: process.platform !== 'linux' }, withConfig({ qemu: { persistent: true } }, async () => {
  const { deps } = fakes();
  const r = await launch({ ...deps, ...fakePool() });
  assert.equal(r.networkIsolateArmed, true);
  assert.equal(r.networkBrokerAdminSock, '/run/vm/a.sock');
  assert.equal(r.networkIsolateMode, 'open', 'the mode the VM is in now, not the launch\'s starting state');
  assert.equal(r.networkExtraAllowedHosts, undefined, 'the lists are pushed per VM (qemuVmPool.setListsAll)');
  const bare = await launch({ ...deps, ...fakePool(null) });
  assert.equal(bare.networkIsolateArmed, false, 'no broker, no toggle');
}));

test('qemu spawn, persistent: the operating mode is not in the key but goes to attach', { skip: process.platform !== 'linux' }, async () => {
  const seen = [];
  for (const mode of ['enforce', 'audit']) {
    await withConfig({ qemu: { persistent: true }, network: { mode } }, async () => {
      const { deps } = fakes();
      const pool = fakePool();
      await launch({ ...deps, ...pool });
      seen.push(pool.attaches[0]);
    })();
  }
  assert.equal(seen[0].key, seen[1].key, 'a mode change joins the running VM instead of booting another');
  assert.deepEqual(seen.map((a) => a.opMode), ['enforce', 'audit']);
});

test('qemuLaunchPoolKey: the key the launch joins the pool with, computed without starting anything', { skip: process.platform !== 'linux' }, async () => {
  for (const network of [{}, { allowedHosts: ['example.test'] }]) {
    await withConfig({ qemu: { persistent: true }, network }, async () => {
      const { deps, calls } = fakes();
      const pool = fakePool();
      const key = qemuLaunchPoolKey({ vmTemplateId: null }, deps);
      assert.equal(calls.broker, undefined, 'nothing started for the check');
      await launch({ ...deps, ...pool });
      assert.equal(key, pool.attaches[0].key);
    })();
  }
});

test('qemuLaunchPoolKey: the template alone is the key -- any edit of it joins the running VM; another template never shares', { skip: process.platform !== 'linux' }, () => {
  const tpl = (over) => ({
    template: { id: 't1', name: 'test', updatedAt: 1, memoryMiB: 4096, cpus: 2, diskGiB: 32, bootTimeoutSec: 120, persistent: true, ...over },
    cloudConfig: null,
  });
  const keyFor = (over) => qemuLaunchPoolKey({ vmTemplateId: 't1' }, { resolveVmTemplate: () => tpl(over) });
  const base = keyFor({});
  assert.ok(base);
  assert.equal(keyFor({ bootTimeoutSec: 240, updatedAt: 2 }), base, 'only the boot timeout changed: join the running VM');
  assert.equal(keyFor({ name: 'renamed', updatedAt: 3 }), base);
  assert.equal(keyFor({ memoryMiB: 8192, updatedAt: 4 }), base, 'a resource change still joins (the VM is marked stale)');
  assert.notEqual(qemuLaunchPoolKey({ vmTemplateId: 't2' }, { resolveVmTemplate: () => tpl({ id: 't2' }) }), base, 'another template never shares');
});

test('qemuLaunchPoolKey: null for a non-persistent VM and for a launch that cannot resolve its template', { skip: process.platform !== 'linux' }, async () => {
  assert.equal(qemuLaunchPoolKey({ vmTemplateId: null }), null, 'throwaway VM: always boots its own');
  await withConfig({ qemu: { persistent: true } }, async () => {
    const deps = { resolveVmTemplate: () => { throw new Error('the selected VM template has been deleted'); } };
    assert.equal(qemuLaunchPoolKey({ vmTemplateId: 'gone' }, deps), null);
  })();
});

// --- commit signing ---------------------------------------------------------

const SIGN_KEY = { nameReal: 'Bot', nameEmail: 'bot@example.com', signingFingerprint: 'F'.repeat(40), keyId: 'FFFFFFFFFFFFFFFF' };
function withSigning(deps, { approve = true } = {}) {
  const asked = [];
  return {
    asked,
    deps: {
      ...deps,
      resolveLaunchSigningKey: async () => SIGN_KEY,
      requestLaunchApproval: async (req) => {
        asked.push(req);
        if (!approve) throw new Error('commit signing launch approval was rejected -- launch refused');
      },
      exportPublicKey: async () => '-----BEGIN PGP PUBLIC KEY BLOCK-----\n',
      createSignHandler: ({ key }) => Object.assign(async () => ({ ok: true }), { key }),
    },
  };
}

test('qemu spawn, signing: approved per launch; the VM gets the wrapper, the public key and the identity, no key', { skip: process.platform !== 'linux' }, async () => {
  const { deps, calls } = fakes();
  const sig = withSigning(deps);
  const r = await launch(sig.deps, { sandboxOpts: { commitSigning: true } });
  assert.equal(sig.asked.length, 1);
  assert.equal(sig.asked[0].backend, 'qemu');
  assert.equal(sig.asked[0].key, SIGN_KEY);
  assert.equal(typeof calls.gitBroker.signHandler, 'function', 'the broker relays sign requests');
  const rt = calls.prepare.runtime;
  const cfg = Object.fromEntries(rt.gitConfig);
  assert.equal(cfg['gpg.program'], '/ccserver-sandbox-gpg-sign.cjs');
  assert.equal(cfg['user.email'], 'bot@example.com');
  const pub = rt.files.find((f) => f.dest === 'signing-pubkey.asc');
  assert.match(readFileSync(pub.src, 'utf-8'), /PUBLIC KEY/);
  assert.ok(!rt.services.some((x) => /gpg/.test(x.name)), 'no signing socket into the VM');
  assert.equal(r.commitSigningActive, true);
});

test('qemu spawn, signing: a rejected approval refuses the launch before anything starts', { skip: process.platform !== 'linux' }, async () => {
  const { deps, calls } = fakes();
  const sig = withSigning(deps, { approve: false });
  await assert.rejects(launch(sig.deps, { sandboxOpts: { commitSigning: true } }), /rejected -- launch refused/);
  assert.equal(calls.gitBroker, undefined);
  assert.equal(calls.broker, undefined);
});

test('qemu spawn, persistent: signing reaches a shared VM through the session\'s own broker', { skip: process.platform !== 'linux' }, withConfig({ qemu: { persistent: true } }, async () => {
  const { deps, calls } = fakes();
  const pool = fakePool();
  const sig = withSigning(deps);
  const r = await launch({ ...sig.deps, ...pool }, { sandboxOpts: { commitSigning: true } });
  assert.equal(typeof calls.gitBroker.signHandler, 'function');
  const rt = pool.attaches[0].session.runtime;
  assert.equal(Object.fromEntries(rt.gitConfig)['gpg.program'], '/ccserver-sandbox-gpg-sign.cjs');
  assert.ok(rt.links.some(([l]) => l === '/ccserver-sandbox-gpg-sign.cjs'));
  assert.ok(existsSync(join(rt.hostDir, 'gpg-sign.cjs')));
  assert.equal(r.commitSigningActive, true);
}));

test('qemu spawn, persistent: a failed attach removes the session\'s brokers and runtime dir', { skip: process.platform !== 'linux' }, withConfig({ qemu: { persistent: true } }, async () => {
  const { deps, killed } = fakes();
  let seen = null;
  const pool = { qemuVmPool: { async attach(opts) { seen = opts; throw new Error('VM boot failed'); } } };
  await assert.rejects(launch({ ...deps, ...pool }), /VM boot failed/);
  assert.deepEqual(killed, ['gitBroker']);
  assert.ok(!existsSync(seen.session.runtime.hostDir));
}));

// --- agents (qemuAgents.js) ------------------------------------------------

const TOKEN = 'sk-ant-oat01-REALSECRETVALUE0123456789';
const fakeAgent = (app, targetCommand) => (targetCommand[0] === 'claude'
  ? { hostDir: '/host/claude/versions', relBin: '9.9.9', guestDir: '/opt/ccs-agent/claude', argv: ['/opt/ccs-agent/claude/9.9.9', ...targetCommand.slice(1)], env: { DISABLE_AUTOUPDATER: '1' } }
  : null);
const withAgent = (deps, token = TOKEN) => ({
  ...deps,
  resolveQemuAgent: fakeAgent,
  getVmAgentCredentials: () => ({ claudeOAuthToken: token }),
});

test('qemu spawn, agent: install shared ro, token only in the broker env', { skip: process.platform !== 'linux' }, withConfig({ network: { allowedHosts: ['example.test'] } }, async () => {
  const { deps, calls } = fakes();
  const r = await launch(withAgent(deps), { targetCommand: ['claude', '--resume'] });
  assert.deepEqual(calls.prepare.argv, ['/opt/ccs-agent/claude/9.9.9', '--resume']);
  assert.equal(calls.prepare.fallbackArgv, null);
  assert.deepEqual(calls.prepare.extraShares, [{ tag: 'agent', hostPath: '/host/claude/versions', guestPath: '/opt/ccs-agent/claude', readonly: true }]);
  assert.equal(calls.prepare.env.DISABLE_AUTOUPDATER, '1');
  assert.match(calls.prepare.env.CLAUDE_CODE_OAUTH_TOKEN, /placeholder/);
  const envName = calls.broker.advanced.inject[0].valueFromEnv;
  assert.equal(calls.broker.env[envName], TOKEN);
  assert.deepEqual(calls.broker.advanced.inject.map((e) => e.host), ['api.anthropic.com', 'mcp-proxy.anthropic.com']);
  assert.deepEqual(calls.broker.allowedHosts, ['example.test', 'api.anthropic.com', 'mcp-proxy.anthropic.com']);
  assert.deepEqual(r.networkExtraAllowedHosts, ['api.anthropic.com', 'mcp-proxy.anthropic.com']);
  const { env: _brokerEnv, ...brokerRest } = calls.broker;
  assert.ok(!JSON.stringify(calls.prepare).includes(TOKEN), 'the VM plan never sees the token');
  assert.ok(!JSON.stringify(brokerRest).includes(TOKEN), 'the broker config never sees the token');
}));

test('qemu spawn, agent: a shell target gets no agent share but still the credentials', { skip: process.platform !== 'linux' }, async () => {
  const { deps, calls } = fakes();
  await launch(withAgent(deps));
  assert.deepEqual(calls.prepare.argv, ['bash']);
  assert.deepEqual(calls.prepare.extraShares, []);
  assert.ok(calls.broker.advanced.inject.length > 0);
});

test('qemu spawn, agent: credentials without HTTPS interception refuse the launch before any broker', { skip: process.platform !== 'linux' }, withConfig({ network: { mitm: { enabled: false } } }, async () => {
  const { deps, calls } = fakes();
  await assert.rejects(launch(withAgent(deps), { targetCommand: ['claude'] }), /HTTPS interception/);
  assert.equal(calls.broker, undefined);
  assert.equal(calls.gitBroker, undefined);
}));

test('qemu spawn, agent: no credentials -> no inject, no extra hosts', { skip: process.platform !== 'linux' }, async () => {
  const { deps, calls } = fakes();
  const r = await launch(withAgent(deps, null), { targetCommand: ['claude'] });
  assert.equal(calls.broker.advanced.inject, null);
  assert.deepEqual(calls.broker.env, {});
  assert.equal(calls.prepare.env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.deepEqual(r.networkExtraAllowedHosts, []);
});

test('qemu spawn, persistent agent: ro share in the session, token digest in the config digest', { skip: process.platform !== 'linux' }, withConfig({ qemu: { persistent: true } }, async () => {
  const keys = [];
  const digests = [];
  for (const token of [TOKEN, `${TOKEN}x`, TOKEN]) {
    const { deps, calls } = fakes();
    const pool = fakePool();
    await launch({ ...withAgent(deps, token), ...pool }, { targetCommand: ['claude'] });
    const a = pool.attaches[0];
    keys.push(a.key);
    digests.push(a.configDigest);
    assert.deepEqual(a.session.agent, { hostDir: '/host/claude/versions', guestDir: '/opt/ccs-agent/claude' });
    assert.deepEqual(a.session.argv, ['/opt/ccs-agent/claude/9.9.9']);
    assert.ok(!JSON.stringify(a).includes(token), 'the attach request never carries the token');
    a.spec.startBroker();
    assert.equal(Object.values(calls.broker.env)[0], token);
  }
  assert.deepEqual(new Set(keys).size, 1, 'a replaced token joins the running VM');
  assert.notEqual(digests[0], digests[1], 'but marks it stale');
  assert.equal(digests[0], digests[2]);
}));

const OC_KEY = 'sk-sakura-REALSECRET0123456789';
const withOpencode = (deps, { token = null, keys = { sakura: OC_KEY } } = {}) => ({
  ...deps,
  resolveQemuAgent: (app, targetCommand) => (targetCommand[0] === 'opencode'
    ? { hostDir: '/host/opencode', relBin: 'bin/opencode', guestDir: '/opt/ccs-agent/opencode', argv: ['/opt/ccs-agent/opencode/bin/opencode'], env: { OPENCODE_DISABLE_AUTOUPDATE: '1' } }
    : fakeAgent(app, targetCommand)),
  getVmAgentCredentials: () => ({ claudeOAuthToken: token, opencodeApiKeys: keys }),
  readOpencodeHostProviders: () => ({
    sakura: { npm: '@ai-sdk/openai-compatible', options: { baseURL: 'https://api.ai.sakura.ad.jp/v1', apiKey: 'host-literal-key' } },
    gone: { npm: '@ai-sdk/google', options: { baseURL: 'https://g.example' } },
  }),
});

test('qemu spawn, opencode: provider config with a placeholder in the guest, merged over the operator env; key only in the broker env', { skip: process.platform !== 'linux' }, withConfig({ env: { OPENCODE_CONFIG_CONTENT: JSON.stringify({ mcp: { x: { type: 'local', command: ['x'] } }, provider: { other: { npm: 'p' } } }) } }, async () => {
  const { deps, calls } = fakes();
  const r = await launch(withOpencode(deps, { keys: { sakura: OC_KEY, gone: 'unused' } }), { app: 'opencode', targetCommand: ['opencode'] });
  const cfg = JSON.parse(calls.prepare.env.OPENCODE_CONFIG_CONTENT);
  assert.deepEqual(cfg.mcp, { x: { type: 'local', command: ['x'] } });
  assert.deepEqual(Object.keys(cfg.provider), ['other', 'sakura']);
  assert.equal(cfg.provider.sakura.options.apiKey, 'ccserver-vm-placeholder');
  assert.deepEqual(calls.broker.advanced.inject, [{ host: 'api.ai.sakura.ad.jp', header: 'Authorization', format: 'Bearer {}', valueFromEnv: 'CCS_INJECT_OPENCODE_0' }]);
  assert.deepEqual(calls.broker.env, { CCS_INJECT_OPENCODE_0: OC_KEY });
  assert.deepEqual(r.networkExtraAllowedHosts, ['api.ai.sakura.ad.jp']);
  for (const secret of [OC_KEY, 'host-literal-key', 'unused']) {
    assert.ok(!JSON.stringify(calls.prepare).includes(secret), `the VM plan never sees ${secret}`);
  }
}));

test('qemu spawn, opencode keys only: claude gets no provider config and keeps its first-run setup', { skip: process.platform !== 'linux' }, withConfig({ persistentHome: true }, async () => {
  const { deps, calls } = fakes();
  await launch(withOpencode(deps), { targetCommand: ['claude'] });
  assert.equal(calls.prepare.env.OPENCODE_CONFIG_CONTENT, undefined);
  assert.equal(calls.prepare.env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.ok(calls.broker.advanced.inject.length > 0, 'the broker still injects for other sessions');
  assert.ok(calls.prepare.homeHostPath, 'a persistent HOME');
  let onboarded = false;
  try { onboarded = JSON.parse(readFileSync(join(calls.prepare.homeHostPath, '.claude.json'), 'utf-8')).hasCompletedOnboarding === true; } catch { /* none */ }
  assert.equal(onboarded, false);
}));

test('qemu spawn, persistent opencode: the key is part of the config digest, not the pool key', { skip: process.platform !== 'linux' }, withConfig({ qemu: { persistent: true } }, async () => {
  const attaches = [];
  for (const k of [OC_KEY, `${OC_KEY}x`]) {
    const { deps } = fakes();
    const pool = fakePool();
    await launch({ ...withOpencode(deps, { keys: { sakura: k } }), ...pool }, { app: 'opencode', targetCommand: ['opencode'] });
    attaches.push(pool.attaches[0]);
    assert.ok(!JSON.stringify(pool.attaches[0]).includes(k));
    assert.deepEqual(pool.attaches[0].extraAllowedHosts, ['api.ai.sakura.ad.jp']);
  }
  assert.equal(attaches[0].key, attaches[1].key);
  assert.notEqual(attaches[0].configDigest, attaches[1].configDigest);
}));

test('qemu spawn, persistent: the allow/deny lists go to the pool as lists, outside the key and the config digest', { skip: process.platform !== 'linux' }, async () => {
  const attaches = [];
  for (const network of [{}, { allowedHosts: ['example.test'], deniedHosts: ['bad.test'] }, { rules: [] }]) {
    await withConfig({ qemu: { persistent: true }, network }, async () => {
      const { deps } = fakes();
      const pool = fakePool();
      await launch({ ...deps, ...pool });
      attaches.push(pool.attaches[0]);
    })();
  }
  assert.deepEqual(attaches.map((a) => a.lists), [
    { allowedHosts: [], deniedHosts: [] },
    { allowedHosts: ['example.test'], deniedHosts: ['bad.test'] },
    { allowedHosts: [], deniedHosts: [] },
  ]);
  assert.equal(new Set(attaches.map((a) => a.key)).size, 1);
  assert.equal(attaches[0].configDigest, attaches[1].configDigest, 'a list edit is applied live');
  assert.notEqual(attaches[0].configDigest, attaches[2].configDigest, 'an advanced policy edit needs a new boot');
});

test("prepareVmClaudeJson: bwrap's empty mount-point .claude.json becomes {} in place; anything else is left alone", () => {
  const home = mkdtempSync(join(dir, 'home-'));
  const file = join(home, '.claude.json');
  assert.equal(prepareVmClaudeJson(home), null, 'absent: nothing to do');
  assert.equal(existsSync(file), false);

  writeFileSync(file, '');
  assert.equal(prepareVmClaudeJson(home), 'repaired');
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf-8')), {});

  // bwrap creates the mount-point stub read-only (0444).
  rmSync(file);
  writeFileSync(file, '');
  chmodSync(file, 0o444);
  assert.equal(prepareVmClaudeJson(home), 'repaired');
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf-8')), {});
  assert.equal(statSync(file).mode & 0o777, 0o600, 'writable again so claude can save its config');

  writeFileSync(file, '{"numStartups":3}');
  assert.equal(prepareVmClaudeJson(home), null, 'real content is never touched without skipOnboarding');
  assert.equal(readFileSync(file, 'utf-8'), '{"numStartups":3}');

  rmSync(file);
  const outside = join(dir, 'outside.json');
  writeFileSync(outside, '');
  symlinkSync(outside, file);
  assert.equal(prepareVmClaudeJson(home, { skipOnboarding: true }), null, 'a symlink planted in HOME is not followed');
  assert.equal(readFileSync(outside, 'utf-8'), '');
  assert.ok(lstatSync(file).isSymbolicLink());

  assert.equal(prepareVmClaudeJson(null, { skipOnboarding: true }), null, 'tmpfs HOME (persistentHome off)');
});

test('prepareVmClaudeJson, skipOnboarding: claude with the VM token skips its first-run login screen', () => {
  const home = mkdtempSync(join(dir, 'home-'));
  const file = join(home, '.claude.json');
  const read = () => JSON.parse(readFileSync(file, 'utf-8'));

  assert.equal(prepareVmClaudeJson(home, { skipOnboarding: true }), 'created');
  assert.deepEqual(read(), { hasCompletedOnboarding: true });
  assert.equal(statSync(file).mode & 0o777, 0o600);

  writeFileSync(file, '');
  chmodSync(file, 0o444);
  assert.equal(prepareVmClaudeJson(home, { skipOnboarding: true }), 'repaired');
  assert.deepEqual(read(), { hasCompletedOnboarding: true });

  writeFileSync(file, JSON.stringify({ userID: 'x', projects: { '/p': { a: 1 } } }));
  assert.equal(prepareVmClaudeJson(home, { skipOnboarding: true }), 'onboarding');
  assert.deepEqual(read(), { userID: 'x', projects: { '/p': { a: 1 } }, hasCompletedOnboarding: true }, 'every other key kept');

  const before = statSync(file).mtimeMs;
  assert.equal(prepareVmClaudeJson(home, { skipOnboarding: true }), null, 'already onboarded: not rewritten');
  assert.equal(statSync(file).mtimeMs, before);

  writeFileSync(file, '{"userID": "x", trunc');
  assert.equal(prepareVmClaudeJson(home, { skipOnboarding: true }), null, 'unparseable: left to claude');
  assert.equal(readFileSync(file, 'utf-8'), '{"userID": "x", trunc');

  writeFileSync(file, '[1,2]');
  assert.equal(prepareVmClaudeJson(home, { skipOnboarding: true }), null, 'not an object: left alone');
});

test('qemu spawn: a chat launch runs the agent under the bridge and forwards its socket', { skip: process.platform !== 'linux' }, async () => {
  const { deps, calls } = fakes();
  deps.resolveQemuAgent = (app, targetCommand) => ({
    hostDir: dir, relBin: 'opencode', guestDir: '/opt/ccserver-agents/opencode',
    argv: ['/opt/ccserver-agents/opencode/opencode', ...targetCommand.slice(1)], env: {},
  });
  const chatDir = join(dir, 'chat');
  mkdirSync(chatDir);
  writeFileSync(join(chatDir, 'password'), 'pw\n', { mode: 0o600 });
  await launch(deps, { targetCommand: ['opencode', 'serve', '--stdio'], app: 'opencode', chat: { hostDir: chatDir } });
  assert.deepEqual(calls.prepare.argv, [
    '/usr/bin/node', '/ccserver-sandbox/chat-bridge.cjs',
    '--sock', '/tmp/ccserver-chat/oc.sock', '--password-file', '/ccserver-sandbox/chat-password', '--',
    '/opt/ccserver-agents/opencode/opencode', 'serve', '--stdio',
  ]);
  assert.deepEqual(calls.prepare.sshForwards, [[join(chatDir, 'oc.sock'), '/tmp/ccserver-chat/oc.sock']]);
  const files = Object.fromEntries(calls.prepare.runtime.files.map((f) => [f.dest, f]));
  assert.equal(files['chat-password'].src, join(chatDir, 'password'));
  assert.equal(files['chat-password'].mode, 0o600);
});

test('qemu spawn: a Claude Code chat launch ships its own bridge and passes the bridge flags', { skip: process.platform !== 'linux' }, async () => {
  const { deps, calls } = fakes();
  deps.resolveQemuAgent = (app, targetCommand) => ({
    hostDir: dir, relBin: 'claude', guestDir: '/opt/ccserver-agents/claude',
    argv: ['/opt/ccserver-agents/claude/claude', ...targetCommand.slice(1)], env: {},
  });
  const chatDir = join(dir, 'chat-claude');
  mkdirSync(chatDir);
  writeFileSync(join(chatDir, 'password'), 'pw\n', { mode: 0o600 });
  writeFileSync(join(chatDir, 'bridge.cjs'), '// bundled\n');
  await launch(deps, { targetCommand: ['claude'], app: 'claude', chat: { hostDir: chatDir, bridgeScript: join(chatDir, 'bridge.cjs'), bridgeArgs: ['--resume', 'abc'] } });
  assert.deepEqual(calls.prepare.argv, [
    '/usr/bin/node', '/ccserver-sandbox/chat-bridge.cjs',
    '--sock', '/tmp/ccserver-chat/oc.sock', '--password-file', '/ccserver-sandbox/chat-password', '--resume', 'abc', '--',
    '/opt/ccserver-agents/claude/claude',
  ]);
  const files = Object.fromEntries(calls.prepare.runtime.files.map((f) => [f.dest, f]));
  assert.equal(files['chat-bridge.cjs'].src, join(chatDir, 'bridge.cjs'));
});

test('qemu spawn, persistent: a chat launch runs the bridge from the session runtime share and forwards its socket', { skip: process.platform !== 'linux' }, withConfig({ qemu: { persistent: true } }, async () => {
  const { deps } = fakes();
  const pool = fakePool();
  deps.resolveQemuAgent = (app, targetCommand) => ({
    hostDir: dir, relBin: 'opencode', guestDir: '/opt/ccserver-agents/opencode',
    argv: ['/opt/ccserver-agents/opencode/opencode', ...targetCommand.slice(1)], env: {},
  });
  const chatDir = join(dir, 'chat-pooled');
  mkdirSync(chatDir);
  writeFileSync(join(chatDir, 'password'), 'pw\n', { mode: 0o600 });
  await launch({ ...deps, ...pool }, { targetCommand: ['opencode', 'serve', '--stdio'], app: 'opencode', chat: { hostDir: chatDir } });
  const { session } = pool.attaches[0];
  assert.deepEqual(session.argv, [
    '/usr/bin/node', '/ccserver-sandbox/chat-bridge.cjs',
    '--sock', '/tmp/ccserver-chat/oc.sock', '--password-file', '/ccserver-sandbox/chat-password', '--',
    '/opt/ccserver-agents/opencode/opencode', 'serve', '--stdio',
  ]);
  assert.deepEqual(session.chat, { hostSock: join(chatDir, 'oc.sock') });
  // The bridge and password ride the session's runtime share (GUEST_RT_DIR).
  const rtDir = session.runtime.hostDir;
  assert.equal(readFileSync(join(rtDir, 'chat-password'), 'utf-8'), 'pw\n');
  assert.equal(statSync(join(rtDir, 'chat-password')).mode & 0o777, 0o600);
  assert.ok(existsSync(join(rtDir, 'chat-bridge.cjs')));
}));
