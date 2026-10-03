// Persistent VM pool: one boot per key, shares per session, idle stop,
// attach plans the launcher runs. The VM itself is faked; the real boot and
// in-guest bwrap are covered by hand (see qemuVmPool.js).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QemuVmPool, guestSharePath, poolKey, GUEST_SHARE_ROOT } from './qemuVmPool.js';
import remote from './sandbox-qemu-remote.cjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fakeBooter() {
  const root = mkdtempSync(join(tmpdir(), 'qemu-pool-'));
  const boots = [];
  const bootVm = async (spec) => {
    await sleep(5);
    if (spec.fail) throw new Error('boot failed');
    const id = `vm${boots.length}`;
    const runDir = join(root, id);
    mkdirSync(join(runDir, 'sessions'), { recursive: true });
    const mounts = new Map(); // guestPath -> { hostPath, refs }
    let exitCb = null;
    const rt = {
      plan: { id, runDir, ssh: { bin: '/usr/bin/ssh', args: ['-tt', 'u@ccs-vm'] }, remote: { env: { LANG: 'C.UTF-8', SSL_CERT_FILE: '/ca' } } },
      shares: {
        async acquire(hostPath, { guestPath, readonly = false }) {
          const m = mounts.get(guestPath) || { hostPath, readonly, refs: 0 };
          m.refs++;
          mounts.set(guestPath, m);
          return {
            guestPath,
            async release() {
              if (--m.refs === 0) mounts.delete(guestPath);
            },
          };
        },
        list: () => [...mounts].map(([guestPath, m]) => ({ guestPath, ...m })),
      },
      stopped: false,
      onExit(cb) { exitCb = cb; },
      crash() { exitCb?.(); },
      async stop() { rt.stopped = true; },
    };
    boots.push({ spec, rt });
    return rt;
  };
  return { root, boots, bootVm, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const session = (cwd, extra = {}) => ({ cwd, home: '/home/ast', homeHostPath: `/hh${cwd}`, argv: ['claude'], fallbackArgv: null, env: { FOO: 'bar' }, ...extra });

test('pool: concurrent launches with one key share a single boot; a different key boots another', async () => {
  const f = fakeBooter();
  const pool = new QemuVmPool({ bootVm: f.bootVm, idleStopMs: 60000, log: () => {} });
  const [a, b] = await Promise.all([
    pool.attach({ key: 'k1', spec: {}, session: session('/p/a') }),
    pool.attach({ key: 'k1', spec: {}, session: session('/p/b') }),
  ]);
  assert.equal(f.boots.length, 1);
  assert.equal(a.vm.id, b.vm.id);
  const c = await pool.attach({ key: 'k2', spec: {}, session: session('/p/a') });
  assert.equal(f.boots.length, 2);
  assert.notEqual(c.vm.id, a.vm.id);
  assert.deepEqual(pool.list().map((v) => [v.key, v.sessions]).sort(), [['k1', 2], ['k2', 1]]);
  await pool.stopAll();
  f.cleanup();
});

test('pool: each host dir is mounted once at a neutral path and released with its last session', async () => {
  const f = fakeBooter();
  const pool = new QemuVmPool({ bootVm: f.bootVm, idleStopMs: 60000, log: () => {} });
  const a = await pool.attach({ key: 'k', spec: {}, session: session('/p/a') });
  const a2 = await pool.attach({ key: 'k', spec: {}, session: session('/p/a') });
  const shares = () => pool.list()[0].shares.map((s) => [s.hostPath, s.refs]).sort();
  assert.deepEqual(shares(), [['/hh/p/a', 2], ['/p/a', 2]]);
  for (const s of pool.list()[0].shares) assert.ok(s.guestPath.startsWith(`${GUEST_SHARE_ROOT}/`));
  await a.release();
  await a.release(); // idempotent
  assert.deepEqual(shares(), [['/hh/p/a', 1], ['/p/a', 1]]);
  await a2.release();
  assert.deepEqual(shares(), []);
  await pool.stopAll();
  f.cleanup();
});

test('pool: the attach plan confines the session to its own shares', async () => {
  const f = fakeBooter();
  const pool = new QemuVmPool({ bootVm: f.bootVm, idleStopMs: 60000, log: () => {} });
  const a = await pool.attach({ key: 'k', spec: {}, session: session('/home/ast/dev/p') });
  const plan = JSON.parse(readFileSync(a.planPath, 'utf-8'));
  assert.equal(plan.attach, true);
  assert.deepEqual(plan.ssh.args, ['-tt', 'u@ccs-vm']);
  assert.deepEqual(plan.remote.env, { LANG: 'C.UTF-8', SSL_CERT_FILE: '/ca', FOO: 'bar' }, "the VM's env, then the session's");
  const args = plan.remote.bwrapArgs;
  const binds = args.flatMap((x, i) => (x === '--bind' ? [[args[i + 1], args[i + 2]]] : []));
  assert.deepEqual(binds, [
    [guestSharePath('/hh/home/ast/dev/p'), '/home/ast'],
    [guestSharePath('/home/ast/dev/p'), '/home/ast/dev/p'],
  ], 'HOME, then the project on top -- nothing else writable');
  await a.release();
  assert.ok(!existsSync(a.planPath), 'the attach plan is removed with the session');
  await pool.stopAll();
  f.cleanup();
});

test('pool: the agent install is shared read-only and bound ro at its fixed path', async () => {
  const f = fakeBooter();
  const pool = new QemuVmPool({ bootVm: f.bootVm, idleStopMs: 60000, log: () => {} });
  const agent = { hostDir: '/host/claude/versions', guestDir: '/opt/ccs-agent/claude' };
  const [a, b] = await Promise.all([
    pool.attach({ key: 'k', spec: {}, session: session('/p/a', { agent }) }),
    pool.attach({ key: 'k', spec: {}, session: session('/p/b', { agent }) }),
  ]);
  const share = pool.list()[0].shares.find((s) => s.hostPath === agent.hostDir);
  assert.deepEqual([share.readonly, share.refs, share.guestPath], [true, 2, guestSharePath(agent.hostDir, true)]);
  const args = JSON.parse(readFileSync(a.planPath, 'utf-8')).remote.bwrapArgs;
  const roBinds = args.flatMap((x, i) => (x === '--ro-bind' ? [[args[i + 1], args[i + 2]]] : []));
  assert.ok(roBinds.some(([src, dst]) => src === share.guestPath && dst === agent.guestDir));
  assert.ok(!args.flatMap((x, i) => (x === '--bind' ? [args[i + 1]] : [])).includes(share.guestPath), 'never writable');
  await a.release();
  await b.release();
  assert.equal(pool.list()[0].shares.length, 0);
  await pool.stopAll();
  f.cleanup();
});

test('pool: a chat session gets its bridge files ro at the rt dir, a socket dir outside bwrap and an ssh -L to the host', async () => {
  const f = fakeBooter();
  const pool = new QemuVmPool({ bootVm: f.bootVm, idleStopMs: 60000, log: () => {} });
  const chat = { filesHostDir: '/run/ccs-chat-1/vm', hostSock: '/run/ccs-chat-1/oc.sock' };
  const a = await pool.attach({ key: 'k', spec: {}, session: session('/p/a', { chat }) });
  const plan = JSON.parse(readFileSync(a.planPath, 'utf-8'));
  const share = pool.list()[0].shares.find((s) => s.hostPath === chat.filesHostDir);
  assert.equal(share.readonly, true);
  const args = plan.remote.bwrapArgs;
  const binds = (flag) => args.flatMap((x, i) => (x === flag ? [[args[i + 1], args[i + 2]]] : []));
  assert.ok(binds('--ro-bind').some(([src, dst]) => src === share.guestPath && dst === '/ccserver-sandbox'));
  const [sockDir] = plan.remote.preDirs;
  assert.match(sockDir, /^\/tmp\/ccs-chat\/[0-9a-f-]{36}$/);
  assert.ok(binds('--bind').some(([src, dst]) => src === sockDir && dst === '/tmp/ccserver-chat'));
  assert.ok(args.indexOf(sockDir) > args.indexOf('/tmp'), 'bound after the /tmp tmpfs');
  assert.deepEqual(plan.ssh.args.slice(0, 2), ['-L', `${chat.hostSock}:${sockDir}/oc.sock`]);
  assert.deepEqual(plan.ssh.args.slice(-2), ['-tt', 'u@ccs-vm'], "the VM's own login args follow");
  const b = await pool.attach({ key: 'k', spec: {}, session: session('/p/b') });
  const planB = JSON.parse(readFileSync(b.planPath, 'utf-8'));
  assert.deepEqual(planB.ssh.args, ['-tt', 'u@ccs-vm'], 'a non-chat session has no forward');
  assert.deepEqual(planB.remote.preDirs, []);
  await a.release();
  await b.release();
  await pool.stopAll();
  f.cleanup();
});

test('pool: an idle VM stops after the timeout unless a session comes back', async () => {
  const f = fakeBooter();
  const pool = new QemuVmPool({ bootVm: f.bootVm, idleStopMs: 40, log: () => {} });
  const a = await pool.attach({ key: 'k', spec: {}, session: session('/p/a') });
  await a.release();
  await sleep(10);
  const b = await pool.attach({ key: 'k', spec: {}, session: session('/p/a') });
  await sleep(80);
  assert.equal(f.boots[0].rt.stopped, false, 'a returning session cancels the idle stop');
  assert.equal(f.boots.length, 1);
  await b.release();
  await sleep(80);
  assert.equal(f.boots[0].rt.stopped, true);
  assert.deepEqual(pool.list(), []);
  await pool.attach({ key: 'k', spec: {}, session: session('/p/a') });
  assert.equal(f.boots.length, 2, 'the next launch boots a fresh VM');
  await pool.stopAll();
  f.cleanup();
});

test('pool: a failed boot fails its launches and is retried by the next one; a crashed VM is replaced', async () => {
  const f = fakeBooter();
  const pool = new QemuVmPool({ bootVm: f.bootVm, idleStopMs: 60000, log: () => {} });
  await assert.rejects(pool.attach({ key: 'k', spec: { fail: true }, session: session('/p/a') }), /boot failed/);
  assert.deepEqual(pool.list(), []);
  await pool.attach({ key: 'k', spec: {}, session: session('/p/a') });
  assert.equal(pool.list().length, 1);
  f.boots[0].rt.crash();
  assert.deepEqual(pool.list(), []);
  await pool.attach({ key: 'k', spec: {}, session: session('/p/a') });
  assert.equal(f.boots.length, 2);
  await pool.stopAll();
  f.cleanup();
});

test('poolKey / guestSharePath: stable, and distinct for different inputs', () => {
  assert.equal(poolKey({ a: 1 }), poolKey({ a: 1 }));
  assert.notEqual(poolKey({ net: 'enforce' }), poolKey({ net: 'open' }));
  assert.equal(guestSharePath('/x'), guestSharePath('/x'));
  assert.notEqual(guestSharePath('/x'), guestSharePath('/x', true));
  assert.match(guestSharePath('/a b'), /^\/ccs\/s\/[0-9a-f]{24}$/);
});

test('buildConfinedRemoteCommand: bwrap wraps the usual cd/env/exec, quoting survives a real shell', () => {
  const cwd = "/home/u/my proj/it's";
  const bwrapArgs = remote.buildGuestBwrapArgs({ cwd, cwdSource: '/ccs/s/abc', home: '/home/u', homeSource: null });
  assert.deepEqual(bwrapArgs.slice(bwrapArgs.indexOf('--tmpfs', bwrapArgs.indexOf('/run/systemd/resolve')), bwrapArgs.indexOf('--setenv')),
    ['--tmpfs', '/home/u', '--bind', '/ccs/s/abc', cwd], 'no persistent HOME: a tmpfs one');
  const cmd = remote.buildConfinedRemoteCommand({ bwrapArgs, cwd, argv: ['claude', '--x'], env: { A: 'b c' } });
  assert.ok(cmd.startsWith('exec bwrap --die-with-parent '));
  // Swap bwrap for printf to see exactly the argv it would get.
  const out = execFileSync('/bin/sh', ['-c', cmd.replace(/^exec bwrap /, 'printf "%s\\n" ')], { encoding: 'utf-8' }).trim().split('\n');
  assert.deepEqual(out.slice(out.indexOf('--bind'), out.indexOf('--bind') + 3), ['--bind', '/ccs/s/abc', cwd]);
  assert.deepEqual(out.slice(-4, -1), ['--', '/bin/sh', '-c']);
  assert.equal(out.at(-1), remote.buildRemoteCommand({ cwd, argv: ['claude', '--x'], env: { A: 'b c' } }));
});

test('buildConfinedRemoteCommand: preDirs are created private to the guest user before bwrap', () => {
  const root = mkdtempSync(join(tmpdir(), 'qemu-predirs-'));
  try {
    const d = join(root, 'ccs chat', 'tok');
    const cmd = remote.buildConfinedRemoteCommand({ bwrapArgs: ['--x'], cwd: '/p', argv: ['a'], preDirs: [d] });
    assert.ok(cmd.startsWith('umask 077 && mkdir -p '));
    execFileSync('/bin/sh', ['-c', cmd.replace('exec bwrap ', 'true ')]);
    assert.equal(statSync(d).mode & 0o777, 0o700);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('pool: the idle time is read when a VM goes idle, and a change re-arms idle VMs from when they went idle', async () => {
  const f = fakeBooter();
  let idleMs = 60000;
  const pool = new QemuVmPool({ bootVm: f.bootVm, idleStopMs: () => idleMs, log: () => {} });
  const a = await pool.attach({ key: 'k', spec: {}, session: session('/p/a') });
  assert.equal(pool.list()[0].idleSince, null, 'in use');
  await a.release();
  const since = pool.list()[0].idleSince;
  assert.ok(Number.isFinite(since));
  await sleep(30);
  assert.equal(f.boots[0].rt.stopped, false);
  idleMs = 20; // already idle for longer than this
  pool.rearmIdle();
  await sleep(20);
  assert.equal(f.boots[0].rt.stopped, true, 'stopped right away');

  idleMs = 60000;
  const b = await pool.attach({ key: 'k', spec: {}, session: session('/p/a') });
  await b.release();
  idleMs = 120000;
  pool.rearmIdle();
  await sleep(30);
  assert.equal(f.boots[1].rt.stopped, false, 'a longer time keeps it up');
  await pool.stopAll();
  f.cleanup();
});

test('pool: list reports when an idle VM will stop; stop(id) stops one VM now', async () => {
  const f = fakeBooter();
  const pool = new QemuVmPool({ bootVm: f.bootVm, idleStopMs: 60000, log: () => {} });
  const a = await pool.attach({ key: 'k1', spec: {}, session: session('/p/a') });
  await pool.attach({ key: 'k2', spec: {}, session: session('/p/b') });
  assert.equal(pool.list().find((v) => v.key === 'k1').idleStopAt, null);
  await a.release();
  const idle = pool.list().find((v) => v.key === 'k1');
  assert.equal(idle.idleStopAt - idle.idleSince, 60000);
  assert.equal(await pool.stop(idle.id), true);
  assert.equal(f.boots[0].rt.stopped, true);
  assert.deepEqual(pool.list().map((v) => v.key), ['k2']);
  assert.equal(await pool.stop('nope'), false);
  await pool.stopAll();
  f.cleanup();
});

test('pool: has(key) is true from the first attach (while booting) until the VM stops', async () => {
  const f = fakeBooter();
  const pool = new QemuVmPool({ bootVm: f.bootVm, idleStopMs: 60000, log: () => {} });
  assert.equal(pool.has('k1'), false);
  const pending = pool.attach({ key: 'k1', spec: {}, session: session('/p/a') });
  assert.equal(pool.has('k1'), true, 'a booting VM is already the one a launch joins');
  await pending;
  assert.equal(pool.has('k2'), false);
  await pool.stop(pool.list()[0].id);
  assert.equal(pool.has('k1'), false);
  f.cleanup();
});

test('pool: attachShell opens an unconfined login shell on a running VM and holds off its idle stop', async () => {
  const f = fakeBooter();
  const pool = new QemuVmPool({ bootVm: f.bootVm, idleStopMs: 40, log: () => {} });
  const a = await pool.attach({ key: 'k', spec: {}, session: session('/p/a') });
  const vmId = pool.list()[0].id;
  const sh = await pool.attachShell(vmId, { home: '/home/ast' });
  assert.equal(sh.vm.id, vmId);
  const plan = JSON.parse(readFileSync(sh.planPath, 'utf8'));
  assert.equal(plan.attach, true);
  assert.deepEqual(plan.ssh, f.boots[0].rt.plan.ssh);
  assert.deepEqual(plan.remote, { bwrapArgs: null, cwd: '/home/ast', argv: ['bash', '-l', '-i'], env: { LANG: 'C.UTF-8', SSL_CERT_FILE: '/ca' } });
  assert.equal(pool.list()[0].sessions, 2);
  await a.release();
  await sleep(80);
  assert.equal(f.boots[0].rt.stopped, false, 'the open shell keeps the VM up');
  await sh.release();
  assert.equal(existsSync(sh.planPath), false);
  assert.notEqual(pool.list()[0].idleStopAt, null, 'idle once the shell is gone');
  await sleep(80);
  assert.equal(f.boots[0].rt.stopped, true);
  await assert.rejects(pool.attachShell(vmId, { home: '/home/ast' }), /VM not found/);
  await assert.rejects(pool.attachShell('nope', { home: '/home/ast' }), /VM not found/);
  await pool.stopAll();
  f.cleanup();
});

test('pool: setOpModeAll sets every VM; attach aligns a VM to the launch mode or refuses to join', async () => {
  const f = fakeBooter();
  const bootVm = async (spec) => {
    const rt = await f.bootVm(spec);
    rt.broker = { adminSock: `/run/${rt.plan.id}/a.sock`, mode: 'enforce', state: 'enforce' };
    return rt;
  };
  const calls = [];
  const refuse = new Set();
  const setBrokerOpMode = async (sock, mode) => { calls.push([sock, mode]); return !refuse.has(sock); };
  const pool = new QemuVmPool({ bootVm, setBrokerOpMode, idleStopMs: 60000, log: () => {} });
  const a = await pool.attach({ key: 'k1', spec: {}, session: session('/p/a'), opMode: 'enforce' });
  const b = await pool.attach({ key: 'k2', spec: {}, session: session('/p/b'), opMode: 'enforce' });
  assert.deepEqual(calls, [], 'a VM already in the launch mode is joined as is');

  refuse.add('/run/vm1/a.sock');
  const res = await pool.setOpModeAll('audit');
  assert.deepEqual(res.sort((x, y) => x.id.localeCompare(y.id)), [{ id: a.vm.id, ok: true }, { id: b.vm.id, ok: false }]);

  calls.length = 0;
  await pool.attach({ key: 'k1', spec: {}, session: session('/p/c'), opMode: 'audit' });
  assert.deepEqual(calls, [], 'vm0 took the push, nothing to align');
  await assert.rejects(
    pool.attach({ key: 'k2', spec: {}, session: session('/p/d'), opMode: 'audit' }),
    /network mode to audit/,
    'vm1 is still enforce and its broker refuses: the audit launch must not join',
  );
  refuse.clear();
  calls.length = 0;
  await pool.attach({ key: 'k1', spec: {}, session: session('/p/f'), opMode: 'enforce' });
  assert.deepEqual(calls, [['/run/vm0/a.sock', 'enforce']], 'an enforce launch switches an audit VM back before joining');
  await pool.stopAll();
  f.cleanup();
});

test('pool: attach aligns a VM to the launch lists (inject hosts added) or refuses to join; setListsAll sets every VM', async () => {
  const f = fakeBooter();
  const bootVm = async (spec) => {
    const rt = await f.bootVm(spec);
    rt.broker = { adminSock: `/run/${rt.plan.id}/a.sock`, mode: 'enforce', state: 'enforce' };
    return rt;
  };
  const calls = [];
  let accept = true;
  const setBrokerLists = async (sock, lists) => { calls.push([sock, lists]); return accept; };
  const pool = new QemuVmPool({ bootVm, setBrokerLists, idleStopMs: 60000, log: () => {} });
  const extraAllowedHosts = ['api.anthropic.com'];
  const lists0 = { allowedHosts: ['a.test'], deniedHosts: [] };
  const a = await pool.attach({ key: 'k1', spec: {}, session: session('/p/a'), lists: lists0, extraAllowedHosts });
  await pool.attach({ key: 'k1', spec: {}, session: session('/p/b'), lists: { ...lists0 } });
  assert.deepEqual(calls, [], 'the lists it booted with: joined as is');

  const lists1 = { allowedHosts: ['a.test', 'b.test'], deniedHosts: ['bad.test'] };
  await pool.attach({ key: 'k1', spec: {}, session: session('/p/c'), lists: lists1, extraAllowedHosts: [] });
  assert.equal(f.boots.length, 1, 'a list edit never boots a second VM');
  assert.deepEqual(calls, [['/run/vm0/a.sock', { allowedHosts: ['a.test', 'b.test', 'api.anthropic.com'], deniedHosts: ['bad.test'] }]], "the VM's own inject hosts are kept");

  accept = false;
  await assert.rejects(
    pool.attach({ key: 'k1', spec: {}, session: session('/p/d'), lists: lists0 }),
    /allow\/deny lists/,
    'a broker that refuses the launch lists: the launch must not join',
  );
  assert.equal(pool.list()[0].sessions, 3);

  calls.length = 0;
  accept = true;
  assert.deepEqual(await pool.setListsAll({ allowedHosts: [], deniedHosts: [] }), [{ id: a.vm.id, ok: true }]);
  assert.deepEqual(calls, [['/run/vm0/a.sock', { allowedHosts: ['api.anthropic.com'], deniedHosts: [] }]]);
  calls.length = 0;
  await pool.attach({ key: 'k1', spec: {}, session: session('/p/e'), lists: { allowedHosts: [], deniedHosts: [] } });
  assert.deepEqual(calls, [], 'the push is remembered');
  await pool.stopAll();
  f.cleanup();
});

test('pool: a launch with another config digest joins the running VM and marks it stale', async () => {
  const f = fakeBooter();
  const pool = new QemuVmPool({ bootVm: f.bootVm, idleStopMs: 60000, log: () => {} });
  await pool.attach({ key: 'k1', spec: {}, session: session('/p/a'), configDigest: 'd1' });
  await pool.attach({ key: 'k1', spec: {}, session: session('/p/b'), configDigest: 'd1' });
  assert.equal(pool.list()[0].stale, false);
  await pool.attach({ key: 'k1', spec: {}, session: session('/p/c'), configDigest: 'd2' });
  assert.equal(f.boots.length, 1);
  assert.equal(pool.list()[0].stale, true);
  await pool.stopAll();
  await pool.attach({ key: 'k1', spec: {}, session: session('/p/d'), configDigest: 'd2' });
  assert.equal(f.boots.length, 2);
  assert.equal(pool.list()[0].stale, false, 'a VM booted with the new settings');
  await pool.stopAll();
  f.cleanup();
});

test("pool: setNetworkMode flips the VM's broker; a later session inherits the mode", async () => {
  const f = fakeBooter();
  const bootVm = async (spec) => {
    const rt = await f.bootVm(spec);
    rt.broker = { adminSock: `/run/${rt.plan.id}/a.sock`, state: 'enforce' };
    return rt;
  };
  const calls = [];
  let accept = true;
  const setBrokerMode = async (sock, mode) => { calls.push([sock, mode]); return accept; };
  const pool = new QemuVmPool({ bootVm, setBrokerMode, idleStopMs: 60000, log: () => {} });
  const a = await pool.attach({ key: 'k1', spec: {}, session: session('/p/a') });
  assert.deepEqual(a.vm.network, { adminSock: '/run/vm0/a.sock', mode: 'enforce' });
  assert.equal(await pool.setNetworkMode(a.vm.id, 'open'), true);
  assert.deepEqual(calls, [['/run/vm0/a.sock', 'open']]);
  const b = await pool.attach({ key: 'k1', spec: {}, session: session('/p/b') });
  assert.equal(b.vm.network.mode, 'open');
  const sh = await pool.attachShell(a.vm.id, { home: '/home/ast' });
  assert.deepEqual(sh.vm.network, { adminSock: '/run/vm0/a.sock', mode: 'open' }, 'the VM Terminal gets the same toggle');
  accept = false;
  assert.equal(await pool.setNetworkMode(a.vm.id, 'enforce'), false, 'a refusing broker');
  assert.equal((await pool.attach({ key: 'k1', spec: {}, session: session('/p/c') })).vm.network.mode, 'open', 'the mode is kept when the broker refuses');
  assert.equal(await pool.setNetworkMode('nope', 'open'), false, 'no such VM');
  await pool.stopAll();
  f.cleanup();
});
