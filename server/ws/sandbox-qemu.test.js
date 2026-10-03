// Pure planning functions of the qemu backend: argv, cloud-init documents
// and remote-command quoting. Nothing here boots a VM (see the launcher's
// own VM test, which needs KVM and a golden image).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildQemuArgs, buildSessionUserData, buildRemoteCommand, buildVirtiofsdArgs, shellQuote,
  buildGoldenUserData, goldenVersion, forwardedEnv, READY_PREFIX, FAIL_PREFIX,
  buildNetworkConfig, buildQemuConfinement, prepareQemuSession,
  buildGuestRuntime, buildGuestRuntimeUserData, composeGitConfigEnv, SERVICE_IP, GOLDEN_PACKAGES,
  validateTemplateCloudConfig, buildGuestShareHelper, buildGuestSshArgs, GUEST_ADMIN_USER, GUEST_SHARE_HELPER,
} from './sandbox-qemu.js';

const baseArgs = {
  name: 'abc', memoryMiB: 2048, cpus: 2, overlay: '/r/overlay.qcow2', seedDir: '/r/seed',
  shares: [{ tag: 'proj', socketPath: '/r/fs0.sock' }, { tag: 'rt', socketPath: '/r/fs1.sock' }],
  vnetSock: '/run/nb/vnet.sock', consoleLog: '/r/console.log', qmpSocket: '/r/qmp.sock',
};

function netdevOf(args) {
  return args[args.indexOf('-netdev') + 1];
}

test('buildQemuArgs: the only NIC is a stream to the broker socket (no slirp, no host ports)', () => {
  const args = buildQemuArgs(baseArgs);
  const nd = netdevOf(args);
  assert.equal(nd, 'stream,id=n0,server=off,addr.type=unix,addr.path=/run/nb/vnet.sock');
  assert.equal(args.filter((a) => a === '-netdev').length, 1);
  assert.ok(!args.some((a) => /hostfwd|guestfwd|^user,/.test(a)));
  const comma = netdevOf(buildQemuArgs({ ...baseArgs, vnetSock: '/run/a,b/vnet.sock' }));
  assert.ok(comma.endsWith('addr.path=/run/a,,b/vnet.sock'), 'commas escaped for QEMU option parsing');
});

test('buildQemuArgs: one vhost-user-fs device per share, shareable memory, VGA present', () => {
  const args = buildQemuArgs(baseArgs);
  const devices = args.filter((_, i) => args[i - 1] === '-device');
  assert.deepEqual(devices.filter((d) => d.startsWith('vhost-user-fs-pci')),
    ['vhost-user-fs-pci,chardev=fs0,tag=proj', 'vhost-user-fs-pci,chardev=fs1,tag=rt']);
  assert.ok(args.includes('memory-backend-memfd,id=mem,size=2048M,share=on'));
  assert.ok(devices.includes('VGA'), 'Debian cloud image needs a display adapter to boot');
  assert.ok(args.includes('-nodefaults'));
  const sandbox = args[args.indexOf('-sandbox') + 1];
  for (const opt of ['obsolete=deny', 'elevateprivileges=deny', 'spawn=deny', 'resourcecontrol=deny']) {
    assert.ok(sandbox.split(',').includes(opt), `seccomp ${opt}`);
  }
});

test('buildQemuArgs: tcg fallback when kvm is off', () => {
  const args = buildQemuArgs({ ...baseArgs, kvm: false });
  assert.equal(args[args.indexOf('-machine') + 1], 'q35,accel=tcg');
  assert.equal(args[args.indexOf('-cpu') + 1], 'max');
});

test('buildVirtiofsdArgs: unprivileged namespace sandbox, readonly when asked', () => {
  const rw = buildVirtiofsdArgs({ socketPath: '/s', sharedDir: '/d' });
  assert.ok(rw.includes('--sandbox=namespace'));
  assert.ok(!rw.includes('--readonly'));
  assert.ok(buildVirtiofsdArgs({ socketPath: '/s', sharedDir: '/d', readonly: true }).includes('--readonly'));
});

test('shellQuote / buildRemoteCommand survive hostile paths and values', () => {
  assert.equal(shellQuote('plain/path-1.2'), 'plain/path-1.2');
  assert.equal(shellQuote("it's"), `'it'\\''s'`);
  const cwd = "/home/u/my proj/it's $(rm -rf ~)";
  const cmd = buildRemoteCommand({ cwd, argv: ['bash', '-l'], env: { FOO: 'a b;c', 'BAD-NAME': 'x', COLORTERM: 'truecolor' } });
  // Round-trip through a real shell: printing the parsed words proves no
  // injection and exact preservation.
  const echoed = execFileSync('/bin/sh', ['-c', cmd.replace(/^cd /, 'printf "%s\\n" ').replace(/ && exec env /, ' ').replace(/ bash -l$/, '')], { encoding: 'utf-8' });
  assert.deepEqual(echoed.trim().split('\n'), [cwd, 'FOO=a b;c', 'COLORTERM=truecolor']);
  assert.ok(!cmd.includes('BAD-NAME'), 'invalid env names are dropped');
});

function parseCloudConfig(doc) {
  assert.ok(doc.startsWith('#cloud-config\n'));
  return JSON.parse(doc.slice('#cloud-config\n'.length));
}

const sessionOpts = {
  user: 'ast', uid: 1000, gid: 1000, home: '/home/ast', cwd: '/home/ast/dev/p q',
  shares: [
    { tag: 'home', guestPath: '/home/ast' },
    { tag: 'proj', guestPath: '/home/ast/dev/p q' },
    { tag: 'rt', guestPath: '/ccserver-sandbox', readonly: true },
  ],
  sshPubKey: 'ssh-ed25519 AAAA test\n', hostKey: { privateKey: 'PRIV', publicKey: 'ssh-ed25519 BBBB host' },
  readyToken: 'tok123', timezone: 'Asia/Tokyo',
};

test('buildSessionUserData: no default user, keys outside HOME, mounts in order, ready marker last', () => {
  const cc = parseCloudConfig(buildSessionUserData(sessionOpts));
  assert.deepEqual(cc.users, [], 'cloud-init must not create the distro default user');
  assert.equal(cc.ssh_pwauth, false);
  assert.equal(cc.ssh_keys.ed25519_private, 'PRIV');
  assert.deepEqual(cc.ssh_genkeytypes, ['ed25519']);
  assert.equal(cc.write_files[0].path, '/etc/ssh/ccserver-keys/ast');
  const boot = cc.bootcmd[0][2];
  const iHome = boot.indexOf('mount -t virtiofs home');
  const iProj = boot.indexOf("mount -t virtiofs proj '/home/ast/dev/p q'");
  assert.ok(boot.indexOf('useradd') < iHome && iHome < iProj, 'user, then HOME, then the project on top of it');
  assert.ok(boot.includes('mount -t virtiofs -o ro rt /ccserver-sandbox'));
  assert.ok(boot.includes(`${FAIL_PREFIX}tok123 mount:proj`), 'a failed mount reports instead of running on an empty dir');
  assert.ok(cc.runcmd.at(-1)[2].endsWith(`echo ${READY_PREFIX}tok123 > /dev/ttyS0`));
  assert.equal(cc.timezone, 'Asia/Tokyo');
});

test('golden image recipe: hardened sshd, NoCloud only, version tracks the recipe', () => {
  const cc = parseCloudConfig(buildGoldenUserData());
  const sshd = cc.write_files.find((f) => f.path.includes('sshd_config.d')).content;
  assert.match(sshd, /AuthorizedKeysFile \/etc\/ssh\/ccserver-keys\/%u/);
  assert.match(sshd, /PasswordAuthentication no/);
  assert.ok(cc.write_files.some((f) => f.content.includes('datasource_list: [ NoCloud, None ]')));
  assert.equal(cc.power_state.mode, 'poweroff');
  assert.notEqual(goldenVersion('a'), goldenVersion('b'));
  assert.equal(goldenVersion('a'), goldenVersion('a'));
});

test('buildRemoteCommand: fallback runs when the target is missing in the guest', () => {
  const run = (argv) => execFileSync('/bin/sh', ['-c', buildRemoteCommand({ cwd: '/', argv, env: { X: '1' }, fallbackArgv: ['echo', 'fallback'] })], { encoding: 'utf-8' }).trim();
  assert.equal(run(['/nonexistent/zsh', '-l']), 'fallback');
  assert.equal(run(['echo', 'target']), 'target');
});

test('forwardedEnv: terminal and ccserver vars only, never host identity', () => {
  const fwd = forwardedEnv({
    COLORTERM: 'truecolor', FORCE_COLOR: '1', CLAUDE_CODE_DISABLE_MOUSE_CLICKS: '1', CCSERVER_NOTIFY_IDENTITY: '{}',
    PATH: '/usr/bin', HOME: '/home/u', SSH_AUTH_SOCK: '/run/agent', GITEA_TOKEN: 'secret',
    CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-secret', CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: '3', CCSERVER_API_KEY: 'k',
  });
  assert.deepEqual(Object.keys(fwd).sort(), ['CCSERVER_NOTIFY_IDENTITY', 'CLAUDE_CODE_DISABLE_MOUSE_CLICKS', 'COLORTERM', 'FORCE_COLOR']);
});

test('buildNetworkConfig: static address, gateway and DNS on the broker network', () => {
  const nc = JSON.parse(buildNetworkConfig());
  const eth = nc.ethernets.ccs0;
  assert.equal(nc.version, 2);
  assert.equal(eth.dhcp4, false);
  assert.deepEqual(eth.addresses, ['10.0.2.15/24']);
  assert.deepEqual(eth.routes, [{ to: 'default', via: '10.0.2.2' }]);
  assert.deepEqual(eth.nameservers.addresses, ['10.0.2.3'], 'the broker vnet resolver');
});

test('buildQemuConfinement: QEMU sees only /usr, /dev/kvm, the image, its run dir and the vnet socket', () => {
  const a = buildQemuConfinement({ runDir: '/q/run/x', goldenPath: '/q/images/g.qcow2', vnetSock: '/run/nb/vnet.sock' });
  for (const flag of ['--die-with-parent', '--unshare-all', '--new-session']) assert.ok(a.includes(flag), flag);
  const binds = [];
  for (let i = 0; i < a.length; i++) {
    if (/^--(ro-|dev-)?bind(-try)?$/.test(a[i])) binds.push([a[i], a[i + 1]]);
  }
  assert.deepEqual(binds.map(([, src]) => src).sort(), ['/dev/kvm', '/etc/ld.so.cache', '/q/images/g.qcow2', '/q/run/x', '/run/nb/vnet.sock', '/usr'].sort());
  assert.ok(binds.find(([, src]) => src === '/q/images/g.qcow2')[0] === '--ro-bind', 'golden image read-only');
  assert.ok(!a.includes('--share-net'), 'no network namespace sharing');
});

test('buildSessionUserData: setup steps and READY share one script; CA via ca_certs', () => {
  const cc = parseCloudConfig(buildSessionUserData({
    ...sessionOpts,
    runLines: [{ cmd: 'false', what: 'step1' }],
    caCerts: ['-----BEGIN CERTIFICATE-----\nX\n-----END CERTIFICATE-----\n'],
  }));
  assert.equal(cc.runcmd.length, 1);
  const script = cc.runcmd[0][2];
  assert.ok(script.indexOf(`${FAIL_PREFIX}tok123 step1`) < script.indexOf(`${READY_PREFIX}tok123`));
  // Real shell: a failing step must keep READY from ever printing.
  const consoleFile = join(mkdtempSync(join(tmpdir(), 'ccs-ud-')), 'console');
  const r = spawnSync('/bin/sh', ['-c', script.replace(/\/dev\/ttyS0/g, consoleFile)], { encoding: 'utf-8' });
  assert.equal(r.status, 1);
  assert.equal(readFileSync(consoleFile, 'utf-8').trim(), `${FAIL_PREFIX}tok123 step1`);
  assert.equal(cc.ca_certs.trusted.length, 1);
});

test('prepareQemuSession: refuses to plan a VM without a broker', () => {
  assert.throws(() => prepareQemuSession({ cwd: '/tmp', argv: ['bash'] }), /network broker is required/);
  assert.throws(() => prepareQemuSession({ cwd: '/tmp', argv: ['bash'], network: { vnetSock: '/x' } }), /network broker is required/);
});

const scripts = {
  credHelper: '/repo/cred.cjs', ghWrapper: '/repo/gh.cjs', sshWrapper: '/repo/ssh.cjs', mcpBridge: '/repo/mcp.cjs',
  commitMsgHook: '/repo/hook.cjs', gpgSignWrapper: '/repo/gpg-sign.cjs', gitconfig: '/repo/gitconfig', knownHostsDefault: '/repo/kh', sshConfig: '/repo/ssh-config',
  knownHostsUser: null,
};

test('buildGuestRuntime: nothing requested -> nothing in the VM', () => {
  const r = buildGuestRuntime({ scripts });
  assert.deepEqual(r, { files: [], links: [], services: [], env: {}, gitConfig: [] });
});

test('buildGuestRuntime: git broker -> fixed bwrap paths, token in a 0600 file (never the env)', () => {
  const r = buildGuestRuntime({ scripts, gitBroker: { sockPath: '/run/u/gb/broker.sock', allowlistPath: '/run/u/gb/allowlist.json', token: 'SECRET' } });
  assert.deepEqual(r.services, [{ name: 'git-broker', addr: `${SERVICE_IP}:7001`, unix: '/run/u/gb/broker.sock', guestPath: '/ccserver-sandbox-git-broker.sock' }]);
  const links = Object.fromEntries(r.links);
  assert.equal(links['/ccserver-sandbox-node'], '/usr/bin/node');
  assert.equal(links['/ccserver-sandbox-git-credential-helper.cjs'], '/ccserver-sandbox/git-credential-helper.cjs');
  assert.equal(links['/usr/local/bin/gh'], '/ccserver-sandbox/gh-wrapper.cjs');
  assert.equal(links['/usr/local/bin/ssh'], '/ccserver-sandbox/ssh-wrapper.cjs');
  assert.equal(r.env.GIT_CONFIG_GLOBAL, '/ccserver-sandbox/gitconfig');
  assert.equal(r.env.CCSANDBOX_REAL_SSH, '/usr/bin/ssh');
  assert.equal(r.env.GIT_SSH_COMMAND, '/usr/local/bin/ssh');
  assert.ok(!JSON.stringify(r.env).includes('SECRET'), 'token never in the env');
  assert.equal(r.env.CCSANDBOX_GIT_BROKER_TOKEN, undefined);
  const tok = r.files.find((f) => f.dest === 'git-broker-token');
  assert.equal(tok.data, 'SECRET\n');
  assert.equal(tok.mode, 0o600);
  assert.ok(r.files.find((f) => f.dest === 'known-hosts-user' && f.data === ''), 'empty user known_hosts when the host has none');
});

test('buildGuestRuntime: commit guard, ssh-agent and MCP sockets', () => {
  const r = buildGuestRuntime({
    scripts, commitGuard: { configPath: '/run/u/cg.json' }, sshAgentSock: '/tmp/agent.sock',
    mcp: { notify: '/run/n/sock', usage: '/run/u/sock' },
  });
  assert.deepEqual(r.gitConfig, [['core.hooksPath', '/ccserver-sandbox-git-hooks']]);
  const byName = Object.fromEntries(r.services.map((s) => [s.name, s]));
  assert.equal(byName['ssh-agent'].guestPath, '/run/ccserver/ssh-agent.sock');
  assert.equal(r.env.SSH_AUTH_SOCK, '/run/ccserver/ssh-agent.sock');
  assert.equal(r.env.GNUPGHOME, undefined, 'no GPG agent of any kind in the VM');
  assert.equal(byName['mcp-notify'].addr, `${SERVICE_IP}:7020`);
  assert.equal(byName['mcp-usage'].addr, `${SERVICE_IP}:7021`);
  assert.equal(r.env.CCSANDBOX_NOTIFY_MCP_SOCK, '/ccserver-sandbox-notify.d/sock');
  assert.equal(r.env.CCSANDBOX_USAGE_MCP_SOCK, '/ccserver-sandbox-usage.d/sock');
  assert.ok(r.links.some(([l]) => l === '/ccserver-sandbox-mcp-bridge'));
  assert.equal(new Set(r.services.map((s) => s.addr)).size, r.services.length, 'ports unique');

  const agentOnly = buildGuestRuntime({ scripts, sshAgentSock: '/tmp/agent.sock' });
  assert.deepEqual(agentOnly.services, [{ name: 'ssh-agent', addr: `${SERVICE_IP}:7012`, unix: '/tmp/agent.sock', guestPath: '/run/ccserver/ssh-agent.sock' }]);
  assert.deepEqual(agentOnly.links, [], 'no node needed for the agent alone');
});

test('buildGuestRuntime: commit signing goes over the git broker, the VM gets only the public key', () => {
  const key = { nameReal: 'Bot', nameEmail: 'bot@example.com', signingFingerprint: 'ABCDEF' };
  const gitBroker = { sockPath: '/h/b.sock', allowlistPath: '/h/a.json', token: 't' };
  const r = buildGuestRuntime({ scripts, gitBroker, signing: { key, pubkeyPath: '/h/pub.asc' } });
  assert.deepEqual(r.services.map((s) => s.name), ['git-broker'], 'no signing socket of its own');
  assert.ok(r.files.some((f) => f.src === '/repo/gpg-sign.cjs' && f.dest === 'gpg-sign.cjs' && f.mode === 0o755));
  assert.ok(r.files.some((f) => f.src === '/h/pub.asc' && f.dest === 'signing-pubkey.asc'));
  const links = Object.fromEntries(r.links);
  assert.equal(links['/ccserver-sandbox-gpg-sign.cjs'], '/ccserver-sandbox/gpg-sign.cjs');
  assert.equal(r.env.CCSANDBOX_SIGNING_PUBKEY, '/ccserver-sandbox-signing-pubkey.asc');
  const cfg = Object.fromEntries(r.gitConfig);
  assert.equal(cfg['gpg.program'], '/ccserver-sandbox-gpg-sign.cjs');
  assert.equal(cfg['user.signingkey'], 'ABCDEF!');
  assert.equal(cfg['commit.gpgsign'], 'true');
  assert.equal(cfg['user.email'], 'bot@example.com');
  assert.equal(cfg['tag.gpgSign'], 'false');

  // Without the broker there is nothing to carry the requests: no signing.
  const noBroker = buildGuestRuntime({ scripts, signing: { key, pubkeyPath: '/h/pub.asc' } });
  assert.deepEqual(noBroker.gitConfig, []);
});

test('buildGuestRuntimeUserData: symlinks after mounts, socket units, services started before READY', () => {
  const rt = buildGuestRuntime({
    scripts, gitBroker: { sockPath: '/h/b.sock', allowlistPath: '/h/a.json', token: 't' }, sshAgentSock: '/h/agent.sock',
  });
  const ud = buildGuestRuntimeUserData(rt, { uid: 1000, gid: 1000 });
  const sock = ud.writeFiles.find((f) => f.path === '/etc/systemd/system/ccs-svc-git-broker.socket');
  assert.match(sock.content, /^ListenStream=\/ccserver-sandbox-git-broker\.sock$/m);
  assert.match(sock.content, /^SocketUser=1000$/m);
  assert.match(sock.content, /^SocketMode=0600$/m);
  const svc = ud.writeFiles.find((f) => f.path === '/etc/systemd/system/ccs-svc-git-broker.service');
  assert.match(svc.content, /^ExecStart=\/usr\/lib\/systemd\/systemd-socket-proxyd 10\.0\.2\.100:7001$/m);
  assert.match(svc.content, /^DynamicUser=yes$/m);
  assert.deepEqual(ud.runLines, [{ what: 'services', cmd: 'systemctl daemon-reload && systemctl start ccs-svc-git-broker.socket ccs-svc-ssh-agent.socket' }]);

  const cc = parseCloudConfig(buildSessionUserData({ ...sessionOpts, ...ud }));
  const boot = cc.bootcmd[0][2];
  assert.ok(boot.indexOf('mount -t virtiofs -o ro rt /ccserver-sandbox') < boot.indexOf('ln -sfn /usr/bin/node /ccserver-sandbox-node'));
  assert.match(boot, /ln -sfn \/usr\/bin\/node \/ccserver-sandbox-node \|\| \{ echo CCSERVER-FAIL-tok123 link:\/ccserver-sandbox-node/);
  const run = cc.runcmd[0][2];
  assert.ok(run.indexOf('systemctl start') < run.indexOf(`${READY_PREFIX}tok123`));
  assert.ok(cc.write_files.some((f) => f.path === '/etc/systemd/system/ccs-svc-ssh-agent.socket'));
});

test('composeGitConfigEnv: ccserver entries first, operator entries renumbered after, never erased', () => {
  const env = {
    FOO: 'bar',
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'user.signingkey', GIT_CONFIG_VALUE_0: 'OLD',
    GIT_CONFIG_KEY_1: 'core.hooksPath', GIT_CONFIG_VALUE_1: '/elsewhere',
    GIT_CONFIG_KEY_7: 'ignored.beyondCount', GIT_CONFIG_VALUE_7: 'x',
  };
  const r = composeGitConfigEnv([['core.hooksPath', '/ccserver-sandbox-git-hooks'], ['user.signingkey', 'NEW']], env);
  assert.deepEqual(r.env, { FOO: 'bar' });
  assert.deepEqual(r.gitEnv, {
    GIT_CONFIG_COUNT: '4',
    GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: '/ccserver-sandbox-git-hooks',
    GIT_CONFIG_KEY_1: 'user.signingkey', GIT_CONFIG_VALUE_1: 'NEW',
    GIT_CONFIG_KEY_2: 'user.signingkey', GIT_CONFIG_VALUE_2: 'OLD',
    GIT_CONFIG_KEY_3: 'core.hooksPath', GIT_CONFIG_VALUE_3: '/elsewhere',
  });
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /core\.hooksPath/);

  assert.deepEqual(composeGitConfigEnv([], { A: '1' }), { env: { A: '1' }, gitEnv: {}, warnings: [] });
  assert.deepEqual(composeGitConfigEnv([['a.b', 'c']], { GIT_CONFIG_COUNT: 'junk' }).gitEnv,
    { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'a.b', GIT_CONFIG_VALUE_0: 'c' });
});

test('golden image carries gpg for verifying host-signed commits', () => {
  assert.ok(GOLDEN_PACKAGES.includes('gnupg'));
});

test('validateTemplateCloudConfig: allow-listed keys only, ccserver-owned paths refused', () => {
  assert.deepEqual(validateTemplateCloudConfig(null), { ok: true, value: {} });
  const ok = validateTemplateCloudConfig({
    packages: ['htop', 'git=1:2.47', ['jq', '1.7']], package_update: true, locale: 'en_US.UTF-8',
    runcmd: ['echo hi', ['touch', '/tmp/x']], bootcmd: ['true'],
    write_files: [{ path: '/etc/profile.d/x.sh', content: 'export A=1\n' }],
  });
  assert.equal(ok.ok, true);
  assert.deepEqual(Object.keys(ok.value).sort(), ['bootcmd', 'locale', 'package_update', 'packages', 'runcmd', 'write_files']);

  for (const bad of [
    { users: [{ name: 'x' }] },
    { ssh_authorized_keys: ['ssh-ed25519 AAAA'] },
    { power_state: { mode: 'poweroff' } },
    { write_files: [{ path: '/etc/ssh/sshd_config.d/99.conf', content: '' }] },
    { write_files: [{ path: '//etc/cloud/cloud.cfg.d/x.cfg', content: '' }] },
    { write_files: [{ path: '/etc/../etc/ssh/x', content: '' }] },
    { write_files: [{ path: '/ccserver-sandbox-git-allowlist.json', content: '' }] },
    { write_files: [{ path: 'relative', content: '' }] },
    { packages: ['bad name'] },
    { packages: 'htop' },
    { runcmd: [{}] },
    { package_update: 'yes' },
    ['not', 'a', 'mapping'],
  ]) {
    assert.equal(validateTemplateCloudConfig(bad).ok, false, JSON.stringify(bad));
  }
});

test('buildSessionUserData: template config merges after ccserver setup and can never override it', () => {
  const template = validateTemplateCloudConfig({
    packages: ['htop'], package_update: true,
    bootcmd: ['echo early'],
    write_files: [{ path: '/etc/profile.d/x.sh', content: 'A=1\n' }],
    runcmd: ['echo "it ran" > /tmp/out', ['false']],
  }).value;
  const cc = parseCloudConfig(buildSessionUserData({ ...sessionOpts, runLines: [{ cmd: 'true', what: 'step1' }], template }));
  assert.deepEqual(cc.packages, ['htop']);
  assert.equal(cc.package_update, true);
  assert.deepEqual(cc.users, []);
  assert.equal(cc.bootcmd.length, 2, "ccserver's setup script first, then the template's");
  assert.equal(cc.bootcmd[1], 'echo early');
  assert.equal(cc.write_files[0].path, '/etc/ssh/ccserver-keys/ast');
  assert.equal(cc.write_files.at(-1).path, '/etc/profile.d/x.sh');
  assert.equal(cc.runcmd.length, 1, 'template runcmd joins the READY script');
  const script = cc.runcmd[0][2];
  const iStep = script.indexOf(`${FAIL_PREFIX}tok123 step1`);
  const iPkg = script.indexOf(`${FAIL_PREFIX}tok123 template-package:htop`);
  const iCmd = script.indexOf(`${FAIL_PREFIX}tok123 template-runcmd:0`);
  assert.ok(iStep < iPkg && iPkg < iCmd && iCmd < script.indexOf(`${READY_PREFIX}tok123`));
  // Real shell, minus the package check (no htop on the test host is fine):
  // a failing template command keeps READY from printing.
  const dir = mkdtempSync(join(tmpdir(), 'ccs-tpl-'));
  const consoleFile = join(dir, 'console');
  const runnable = script.split('\n').filter((l) => !l.includes('dpkg-query')).join('\n')
    .replace(/\/dev\/ttyS0/g, consoleFile).replace('/tmp/out', join(dir, 'out'));
  const r = spawnSync('/bin/sh', ['-c', runnable], { encoding: 'utf-8' });
  assert.equal(r.status, 1);
  assert.equal(readFileSync(join(dir, 'out'), 'utf-8'), 'it ran\n');
  assert.equal(readFileSync(consoleFile, 'utf-8').trim(), `${FAIL_PREFIX}tok123 template-runcmd:1`);
});

test('buildQemuArgs: empty pcie root ports reserved for hot-plugged shares', () => {
  assert.ok(!buildQemuArgs(baseArgs).some((a) => a.startsWith('pcie-root-port')));
  const args = buildQemuArgs({ ...baseArgs, hotplugPorts: ['ccshp0', 'ccshp1'] });
  const ports = args.filter((a, i) => args[i - 1] === '-device' && a.startsWith('pcie-root-port'));
  assert.deepEqual(ports, [
    'pcie-root-port,id=ccshp0,chassis=1,addr=0x10.0x0,multifunction=on',
    'pcie-root-port,id=ccshp1,chassis=2,addr=0x10.0x1',
  ]);
  const many = buildQemuArgs({ ...baseArgs, hotplugPorts: Array.from({ length: 32 }, (_, i) => `p${i}`) });
  const addrs = many.filter((a) => a.startsWith('pcie-root-port')).map((a) => a.match(/addr=([^,]+)/)[1]);
  assert.equal(new Set(addrs).size, 32);
  assert.deepEqual([addrs[7], addrs[8], addrs[31]], ['0x10.0x7', '0x11.0x0', '0x13.0x7'], 'eight functions per slot');
});

test('buildSessionUserData: admin login is forced onto the share helper, via sudo for that helper only', () => {
  assert.ok(!buildSessionUserData(sessionOpts).includes(GUEST_ADMIN_USER), 'no admin channel unless asked');
  const cc = parseCloudConfig(buildSessionUserData({ ...sessionOpts, adminPubKey: 'ssh-ed25519 CCCC admin\n' }));
  const boot = cc.bootcmd[0][2];
  assert.ok(boot.indexOf(`useradd -r -M -d / -s /bin/sh ${GUEST_ADMIN_USER}`) > boot.indexOf('useradd -M -u 1000'),
    'the system admin user is created after the session user so it cannot take the host uid');
  const file = (path) => cc.write_files.find((f) => f.path === path);
  assert.equal(cc.write_files[0].path, '/etc/ssh/ccserver-keys/ast');
  assert.equal(file(`/etc/ssh/ccserver-keys/${GUEST_ADMIN_USER}`).content,
    'restrict,command="/usr/local/sbin/ccs-share-ssh" ssh-ed25519 CCCC admin\n');
  assert.equal(file('/etc/sudoers.d/ccs-share').content, `${GUEST_ADMIN_USER} ALL=(root) NOPASSWD: ${GUEST_SHARE_HELPER}\n`);
  assert.equal(file('/etc/sudoers.d/ccs-share').permissions, '0440');
  assert.equal(file('/usr/local/sbin/ccs-share-ssh').content, `#!/bin/sh\nexec sudo -n ${GUEST_SHARE_HELPER}\n`);
  assert.equal(file(GUEST_SHARE_HELPER).content, buildGuestShareHelper());
});

test('validateTemplateCloudConfig: templates cannot replace the share helper or its sudoers rule', () => {
  for (const path of [GUEST_SHARE_HELPER, '/etc/sudoers.d/ccs-share']) {
    assert.equal(validateTemplateCloudConfig({ write_files: [{ path, content: 'x' }] }).ok, false, path);
  }
});

test('guest share helper: parses cleanly and rejects malformed requests before touching mounts', () => {
  const script = buildGuestShareHelper();
  assert.equal(spawnSync('/bin/bash', ['-n'], { input: script }).status, 0);
  const dir = mkdtempSync(join(tmpdir(), 'ccs-share-'));
  const helper = join(dir, 'ccs-share');
  writeFileSync(helper, script, { mode: 0o755 });
  // Stand-ins that record whether a request ever reached the real tools.
  const fakeBin = join(dir, 'bin');
  const calls = join(dir, 'calls');
  mkdirSync(fakeBin);
  for (const t of ['mount', 'umount', 'mkdir']) writeFileSync(join(fakeBin, t), `#!/bin/sh\necho "${t} $*" >> ${calls}\n`, { mode: 0o755 });
  writeFileSync(join(fakeBin, 'findmnt'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const run = (line) => spawnSync('/bin/bash', [helper], { input: `${line}\n`, env: { PATH: `${fakeBin}:/usr/bin:/bin` } }).status;
  for (const bad of [
    'mount home rw /home/ast', // boot-time tags are off limits
    'mount ccshp0 rx /x',
    'mount ccshp0 rw relative',
    'mount ccshp0 rw /a/../etc',
    'mount ccshp0 rw /a/./b',
    'umount relative',
    'umount /a/../b',
    'reboot now',
  ]) {
    assert.equal(run(bad), 2, bad);
  }
  assert.ok(!existsSync(calls), 'no rejected request touched mkdir/mount/umount');
  assert.equal(run('mount ccshp3 ro /home/ast/my proj'), 0);
  assert.deepEqual(readFileSync(calls, 'utf-8').trim().split('\n'),
    ['mkdir -p -- /home/ast/my proj', 'mount -t virtiofs -o ro -- ccshp3 /home/ast/my proj']);
});

test('buildGuestSshArgs: session login gets a tty, admin requests are batch-mode', () => {
  const network = { pipeBin: '/opt/nb', guestSshSock: '/run/nb/ssh.sock' };
  const tty = buildGuestSshArgs({ keyPath: '/r/id', knownHosts: '/r/kh', network, user: 'ast', tty: true });
  assert.equal(tty[0], '-tt');
  assert.equal(tty.at(-1), 'ast@ccs-vm');
  assert.ok(!tty.includes('BatchMode=yes'));
  const admin = buildGuestSshArgs({ keyPath: '/r/admin', knownHosts: '/r/kh', network, user: GUEST_ADMIN_USER, tty: false });
  assert.equal(admin[0], '-T');
  assert.ok(admin.includes('BatchMode=yes'));
  assert.ok(admin.includes('ProxyCommand=/opt/nb pipe /run/nb/ssh.sock'));
  assert.equal(admin.at(-1), `${GUEST_ADMIN_USER}@ccs-vm`);
});
