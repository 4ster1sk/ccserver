// opencode chat mode inside the sandboxes: the bwrap command line wraps the
// agent in the chat bridge and binds what it needs; the qemu planner puts
// the bridge + password in the guest runtime and forwards the relay socket
// over the session ssh.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSandboxSpawn, CHAT_BRIDGE_SCRIPT } from './sandbox.js';
import { buildGuestRuntime, buildGuestSshArgs, buildSessionUserData, GUEST_CHAT_BRIDGE, GUEST_CHAT_PASSWORD, SETUP_PREFIX } from './sandbox-qemu.js';

function withConfig(cfg, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'ccserver-chat-sbx-'));
  const cfgPath = join(dir, 'sandbox.config.json');
  writeFileSync(cfgPath, JSON.stringify(cfg));
  const prev = process.env.CCSERVER_SANDBOX_CONFIG;
  process.env.CCSERVER_SANDBOX_CONFIG = cfgPath;
  return Promise.resolve(fn(dir)).finally(() => {
    if (prev === undefined) delete process.env.CCSERVER_SANDBOX_CONFIG;
    else process.env.CCSERVER_SANDBOX_CONFIG = prev;
    rmSync(dir, { recursive: true, force: true });
  });
}

function bindPairs(args, flag) {
  const out = [];
  args.forEach((a, i) => { if (a === flag) out.push([args[i + 1], args[i + 2]]); });
  return out;
}

test('bwrap: a chat launch runs the agent under the bridge, with node, the bridge and the chat dir bound', async () => {
  await withConfig({ docker: false, gitBroker: false, persistentHome: false, commitMessageGuard: { enabled: false } }, async (dir) => {
    const cwd = mkdtempSync(join(tmpdir(), 'ccserver-chat-proj-'));
    const chatDir = join(dir, 'chat');
    try {
      const spawn = await buildSandboxSpawn({
        cwd, targetCommand: ['opencode', 'serve', '--stdio', '--hostname', '127.0.0.1'], app: 'opencode', sandboxOpts: null,
        chat: { hostDir: chatDir },
      });
      const sep = spawn.args.indexOf('--');
      const bwrapArgs = spawn.args.slice(0, sep);
      const inner = spawn.args.slice(sep + 1);
      assert.deepEqual(inner.slice(0, 4), ['/usr/bin/bash', '/ccserver-sandbox-entrypoint.sh', '/ccserver-sandbox-node', '/ccserver-sandbox-chat-bridge.cjs']);
      assert.deepEqual(inner.slice(4, 9), ['--sock', '/ccserver-sandbox-chat.d/oc.sock', '--password-file', '/ccserver-sandbox-chat.d/password', '--']);
      assert.deepEqual(inner.slice(-4), ['serve', '--stdio', '--hostname', '127.0.0.1']);
      const ro = bindPairs(bwrapArgs, '--ro-bind');
      assert.ok(ro.some(([src, dst]) => src === CHAT_BRIDGE_SCRIPT && dst === '/ccserver-sandbox-chat-bridge.cjs'));
      assert.ok(ro.some(([, dst]) => dst === '/ccserver-sandbox-node'));
      assert.ok(bindPairs(bwrapArgs, '--bind').some(([src, dst]) => src === chatDir && dst === '/ccserver-sandbox-chat.d'));
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

test('bwrap: a terminal launch is untouched by chat mode', async () => {
  await withConfig({ docker: false, gitBroker: false, persistentHome: false, commitMessageGuard: { enabled: false } }, async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ccserver-chat-proj-'));
    try {
      const spawn = await buildSandboxSpawn({ cwd, targetCommand: ['opencode'], app: 'opencode', sandboxOpts: null });
      assert.equal(spawn.args.includes('/ccserver-sandbox-chat-bridge.cjs'), false);
      assert.equal(spawn.args.includes('/ccserver-sandbox-chat.d'), false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

const scripts = {
  credHelper: '/repo/cred.cjs', ghWrapper: '/repo/gh.cjs', sshWrapper: '/repo/ssh.cjs', mcpBridge: '/repo/mcp.cjs',
  commitMsgHook: '/repo/hook.cjs', gitconfig: '/repo/gitconfig', knownHostsDefault: '/repo/kh', sshConfig: '/repo/ssh-config',
  knownHostsUser: null,
};

test('qemu: the guest runtime carries the bridge and a 0600 password file, and links node', () => {
  const r = buildGuestRuntime({ scripts, chat: { bridge: '/repo/bridge.cjs', passwordFile: '/run/u/chat/password' } });
  assert.deepEqual(r.files, [
    { src: '/repo/bridge.cjs', dest: 'chat-bridge.cjs', mode: 0o755 },
    { src: '/run/u/chat/password', dest: 'chat-password', mode: 0o600 },
  ]);
  assert.deepEqual(r.links, [['/ccserver-sandbox-node', '/usr/bin/node']]);
  assert.equal(GUEST_CHAT_BRIDGE, '/ccserver-sandbox/chat-bridge.cjs');
  assert.equal(GUEST_CHAT_PASSWORD, '/ccserver-sandbox/chat-password');
  // The password is never part of the env (the ssh command line).
  assert.deepEqual(r.env, {});
});

test('qemu: the session ssh forwards the relay socket, before the destination', () => {
  const network = { pipeBin: '/bin/netbroker', guestSshSock: '/run/ssh.sock' };
  const plain = buildGuestSshArgs({ keyPath: '/k', knownHosts: '/kh', network, user: 'u', tty: true });
  assert.equal(plain.includes('-L'), false);
  const args = buildGuestSshArgs({ keyPath: '/k', knownHosts: '/kh', network, user: 'u', tty: true, forwards: [['/run/u/chat/oc.sock', '/tmp/ccserver-chat/oc.sock']] });
  const i = args.indexOf('-L');
  assert.equal(args[i + 1], '/run/u/chat/oc.sock:/tmp/ccserver-chat/oc.sock');
  assert.ok(args.includes('StreamLocalBindUnlink=yes'));
  assert.equal(args[args.length - 1], 'u@ccs-vm');
});

test('qemu: the session setup announces itself on the console first thing', () => {
  const doc = buildSessionUserData({
    user: 'u', uid: 1000, gid: 1000, home: '/home/u', cwd: '/home/u/p', shares: [],
    sshPubKey: 'ssh-ed25519 AAA', hostKey: { privateKey: 'x', publicKey: 'y' }, readyToken: 'tok', timezone: null,
  });
  const at = doc.indexOf(`${SETUP_PREFIX}tok`);
  assert.ok(at > 0);
  assert.ok(at < doc.indexOf('userdel'), 'before any setup step');
});
