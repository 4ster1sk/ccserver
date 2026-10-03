// Persistent qemu VMs shared by many sessions (a VM template with
// "persistent" set, or sandbox.config.json qemu.persistent).
//
// One VM per pool key, which is the template alone (sandbox.js
// pooledVmKey): a settings edit never boots a second VM next to a running
// one. The parts of the network policy a running broker takes live -- the
// operating mode (network.mode, enforce/audit) and the allow/deny lists --
// are kept in line per VM: the Settings GUI pushes a change to every VM
// (setOpModeAll, setListsAll), and attach() sets a VM to the launch's mode
// and lists before joining it, refusing the join if the broker will not take
// them, so a session never runs under a looser policy than it launched
// with. The rest (resources, cloud-config, golden image, the broker's
// advanced policy and credentials) is fixed at boot: a launch whose
// configDigest differs from the VM's joins it anyway and marks it stale,
// shown in the Settings GUI until the VM is stopped and booted again.
//
// A session attaching to a VM:
//   1. boots the VM if none is running for its key (later launches wait
//      for the same boot)
//   2. hot-plugs its project dir and persistent HOME (qemuShares.js). Each
//      host dir is mounted once at a neutral guest path, /ccs/s/<hash>, and
//      shared by every session that uses it; nothing is mounted at the
//      host path itself, so overlapping projects never nest mounts
//   3. gets an attach plan for the launcher (the pty child), which logs in
//      over ssh and runs the command inside bwrap. bwrap binds just that
//      session's shares into place (sandbox-qemu-remote.cjs
//      buildGuestBwrapArgs), so other sessions' projects are not visible
// Releasing a session drops its shares (the last user unmounts them) and,
// when it was the VM's last session, starts the idle timer that stops it
// (the Settings GUI's idle time, 2 hours by default).
//
// What a per-session VM has and a pooled one does not yet: the host
// services (git broker, commit guard, gpg vault, ssh-agent, MCP sockets),
// and sandbox.config.json binds. The planned design for these is in
// docs/qemu-persistent-vm.md. The running-session network toggle is offered,
// but per VM: the broker is the whole VM's, so setNetworkMode() flips it for
// every session on it, and a session joining later inherits its current mode.

import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildVirtiofsdArgs, prepareQemuPoolVm } from './sandbox-qemu.js';
import { setGoBrokerLists, setGoBrokerMode, setGoBrokerOpMode } from './netbrokerClient.js';
import { openHotplugShares } from './qemuShares.js';
import { getPoolIdleStopMinutes } from '../vmTemplates.js';
import boot from './sandbox-qemu-boot.cjs';
import remote from './sandbox-qemu-remote.cjs';

export const GUEST_SHARE_ROOT = '/ccs/s';

// The Settings GUI's idle time (vmTemplates.js), read whenever a VM goes
// idle so a change applies without a restart. CCSERVER_QEMU_POOL_IDLE_SEC
// overrides it (tests).
export function poolIdleStopMs() {
  const sec = Number(process.env.CCSERVER_QEMU_POOL_IDLE_SEC);
  if (process.env.CCSERVER_QEMU_POOL_IDLE_SEC && Number.isFinite(sec) && sec >= 0) return sec * 1000;
  return getPoolIdleStopMinutes() * 60 * 1000;
}

// Stable key for "may these launches share one VM".
export function poolKey(parts) {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 16);
}

// Where a host dir is mounted inside a pooled VM.
export function guestSharePath(hostPath, readonly = false) {
  return `${GUEST_SHARE_ROOT}/${createHash('sha256').update(`${readonly ? 'ro' : 'rw'}\0${hostPath}`).digest('hex').slice(0, 24)}`;
}

const sameLists = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// The lists a VM's broker gets: the inject hosts it was booted with added
// to the allow list (as the launch that booted it did).
function withExtra({ allowedHosts, deniedHosts }, extraAllowedHosts) {
  return { allowedHosts: [...allowedHosts, ...extraAllowedHosts.filter((h) => !allowedHosts.includes(h))], deniedHosts };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readTail(path, bytes = 2000) {
  try { return readFileSync(path, 'utf-8').slice(-bytes).trim() || '(empty log)'; } catch { return '(no log)'; }
}

// Boots one pooled VM. startBroker() starts its Go network broker (the
// caller's policy); vm holds prepareQemuPoolVm's resource/template inputs.
// Resolves to { plan, shares, stop(), onExit(cb) } once sshd answers.
export async function bootPooledVm({ startBroker, vm, log = (m) => console.log(`[qemu-pool] ${m}`) }) {
  const broker = startBroker();
  let plan = null;
  let qemu = null;
  let shares = null;
  let exited = false;
  const exitCbs = [];
  const killBroker = () => {
    try { broker.proc.kill('SIGTERM'); } catch { /* already dead */ }
    try { rmSync(broker.dir, { recursive: true, force: true }); } catch { /* best effort */ }
  };
  const stopQemu = async () => {
    if (!qemu || exited) return;
    qemu.kill('SIGTERM');
    const until = Date.now() + 3000;
    while (!exited && Date.now() < until) await sleep(50);
    if (!exited) qemu.kill('SIGKILL');
  };
  try {
    plan = prepareQemuPoolVm({
      ...vm,
      network: { vnetSock: broker.vnetSock, guestSshSock: broker.guestSshSock, pipeBin: broker.pipeBin, caPem: broker.caPem },
    });
    mkdirSync(join(plan.runDir, 'sessions'), { mode: 0o700 });
    const fd = openSync(join(plan.runDir, 'qemu.log'), 'a', 0o600);
    qemu = spawn(plan.qemu.bin, plan.qemu.args, { stdio: ['ignore', fd, fd] });
    closeSync(fd);
    qemu.on('exit', (code, sig) => {
      exited = true;
      log(`VM ${plan.id} exited (${sig || code})`);
      for (const cb of exitCbs) { try { cb(); } catch { /* listener bug */ } }
    });
    const t0 = Date.now();
    for (;;) {
      // The run dir (and the log in it) is removed below, so quote it.
      if (exited) throw new Error(`qemu exited during boot: ${readTail(join(plan.runDir, 'qemu.log'))}`);
      const st = boot.consoleState(plan);
      if (st === 'ready') break;
      if (st?.fail) throw new Error(`VM setup failed: ${st.fail}`);
      if (Date.now() - t0 > plan.bootTimeoutMs) throw new Error('timed out waiting for the VM to finish booting');
      await sleep(150);
    }
    while (!(await boot.sshBanner(plan.guestSshSock))) {
      if (exited) throw new Error('qemu exited during boot');
      if (Date.now() - t0 > plan.bootTimeoutMs + 15000) throw new Error('timed out waiting for sshd');
      await sleep(150);
    }
    shares = await openHotplugShares(plan, { buildVirtiofsdArgs });
    log(`VM ${plan.id} up in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  } catch (e) {
    await stopQemu();
    killBroker();
    if (plan) rmSync(plan.runDir, { recursive: true, force: true });
    throw e;
  }
  return {
    plan,
    shares,
    broker,
    onExit(cb) { if (exited) cb(); else exitCbs.push(cb); },
    async stop() {
      try { await shares.close(); } catch { /* the VM is going away anyway */ }
      await stopQemu();
      killBroker();
      rmSync(plan.runDir, { recursive: true, force: true });
    },
  };
}

// The `vm` of an attach()/attachShell() result for a booted VM record.
// network is { adminSock, mode } of its broker as of now (the mode a toggle
// left it in, not the one it booted with), null without a broker.
function leaseVm(vm) {
  const { rt } = vm;
  return {
    id: rt.plan.id, key: vm.key, runDir: rt.plan.runDir, startedAt: vm.startedAt, info: vm.info,
    network: rt.broker ? { adminSock: rt.broker.adminSock, mode: rt.broker.state } : null,
  };
}

export class QemuVmPool {
  #vms = new Map(); // key -> vm record
  #boot;
  #setBrokerMode;
  #setBrokerOpMode;
  #setBrokerLists;
  #idleStopMs;
  #log;

  // bootVm(spec) -> Promise<runtime> (see bootPooledVm); injectable for tests.
  // setBrokerMode(adminSock, mode) -> Promise<boolean> (see setGoBrokerMode).
  // setBrokerOpMode(adminSock, mode) -> Promise<boolean> (see setGoBrokerOpMode).
  // setBrokerLists(adminSock, { allowedHosts, deniedHosts }) -> Promise<boolean>
  //   (see setGoBrokerLists).
  // idleStopMs: a number, or a function read each time a VM goes idle.
  constructor({ bootVm = (spec) => bootPooledVm(spec), setBrokerMode = setGoBrokerMode, setBrokerOpMode = setGoBrokerOpMode, setBrokerLists = setGoBrokerLists, idleStopMs = poolIdleStopMs, log = (m) => console.log(`[qemu-pool] ${m}`) } = {}) {
    this.#boot = bootVm;
    this.#setBrokerMode = setBrokerMode;
    this.#setBrokerOpMode = setBrokerOpMode;
    this.#setBrokerLists = setBrokerLists;
    this.#idleStopMs = idleStopMs;
    this.#log = log;
  }

  // Attaches one session to the VM for `key`, booting it from `spec` when
  // none runs. Resolves to { planPath, vm: { id, runDir, startedAt, info,
  // network }, release() } (see leaseVm); release() is idempotent and never
  // throws.
  //
  //   session: { cwd, home, homeHostPath (null = tmpfs HOME), argv,
  //              fallbackArgv, env, agent ({ hostDir, guestDir }: the
  //              agent install, shared read-only; null for none) }
  //   opMode:  the launch's operating mode ('enforce' | 'audit'); a VM in
  //            another one is switched to it first (see the file comment).
  //   lists:   the launch's { allowedHosts, deniedHosts } (without the inject
  //            hosts, extraAllowedHosts, which the VM adds); a VM with other
  //            lists is switched to them first. null leaves them alone.
  //   configDigest: what the VM boots with besides the key; a VM booted
  //            with another one is joined and marked stale.
  async attach({ key, spec, info = {}, session, opMode = null, lists = null, configDigest = null, extraAllowedHosts = [] }) {
    const vm = this.#vmFor(key, spec, info, { lists, configDigest, extraAllowedHosts });
    if (configDigest && vm.configDigest !== configDigest && !vm.stale) {
      vm.stale = true;
      this.#log(`the settings of the persistent VM for ${info.templateName || key} changed; joining the running VM (stop it to boot one with the new settings)`);
    }
    const leases = [];
    let planPath = null;
    const { token, release } = this.#join(vm, async () => {
      if (planPath) { try { rmSync(planPath, { force: true }); } catch { /* run dir already gone */ } }
      await Promise.all(leases.map((l) => l.release().catch((e) => this.#log(`releasing ${l.guestPath}: ${e.message}`))));
    });
    try {
      const rt = await vm.ready;
      if (opMode && rt.broker && rt.broker.mode !== opMode) {
        if (!(await this.#setBrokerOpMode(rt.broker.adminSock, opMode))) {
          throw new Error(`could not set the persistent VM's network mode to ${opMode}`);
        }
        rt.broker.mode = opMode;
      }
      if (lists && rt.broker && !sameLists(vm.lists, lists)) {
        if (!(await this.#setBrokerLists(rt.broker.adminSock, withExtra(lists, vm.extraAllowedHosts)))) {
          throw new Error("could not update the persistent VM's network allow/deny lists");
        }
        vm.lists = lists;
      }
      const share = async (hostPath, readonly = false) => {
        const lease = await rt.shares.acquire(hostPath, { guestPath: guestSharePath(hostPath, readonly), readonly });
        leases.push(lease);
        return lease.guestPath;
      };
      const [cwdSource, homeSource, agentSource] = await Promise.all([
        share(session.cwd),
        session.homeHostPath ? share(session.homeHostPath) : null,
        session.agent ? share(session.agent.hostDir, true) : null,
      ]);
      const bwrapArgs = remote.buildGuestBwrapArgs({
        cwd: session.cwd, cwdSource, home: session.home, homeSource,
        agent: agentSource ? { source: agentSource, target: session.agent.guestDir } : null,
      });
      planPath = join(rt.plan.runDir, 'sessions', `${token}.json`);
      writeFileSync(planPath, JSON.stringify({
        attach: true,
        ssh: rt.plan.ssh,
        remote: {
          bwrapArgs,
          cwd: session.cwd,
          argv: session.argv,
          fallbackArgv: session.fallbackArgv || null,
          env: { ...rt.plan.remote.env, ...(session.env || {}) },
        },
      }), { mode: 0o600 });
      return {
        planPath,
        vm: leaseVm(vm),
        release,
      };
    } catch (e) {
      await release();
      throw e;
    }
  }

  // Sets the network broker of the booted VM with this id to 'enforce' or
  // 'open', for every session on it. Resolves false if there is no such VM
  // or the broker refused.
  async setNetworkMode(id, mode) {
    const vm = [...this.#vms.values()].find((v) => v.rt?.plan.id === id);
    if (!vm?.rt.broker) return false;
    if (!(await this.#setBrokerMode(vm.rt.broker.adminSock, mode))) return false;
    vm.rt.broker.state = mode;
    return true;
  }

  // Sets the operating mode ('enforce' | 'audit') of every booted VM's
  // broker. Resolves to [{ id, ok }]; a VM whose broker refused keeps its
  // mode (a later attach() retries before joining it).
  async setOpModeAll(mode) {
    const vms = [...this.#vms.values()].filter((v) => v.rt?.broker);
    return Promise.all(vms.map(async (vm) => {
      const ok = await this.#setBrokerOpMode(vm.rt.broker.adminSock, mode).catch(() => false);
      if (ok) vm.rt.broker.mode = mode;
      return { id: vm.rt.plan.id, ok };
    }));
  }

  // Sets the allow/deny lists ({ allowedHosts, deniedHosts }, without the
  // inject hosts: each VM adds its own) of every booted VM's broker.
  // Resolves to [{ id, ok }]; a VM whose broker refused keeps its lists (a
  // later attach() retries before joining it).
  async setListsAll(lists) {
    const vms = [...this.#vms.values()].filter((v) => v.rt?.broker);
    return Promise.all(vms.map(async (vm) => {
      const ok = await this.#setBrokerLists(vm.rt.broker.adminSock, withExtra(lists, vm.extraAllowedHosts)).catch(() => false);
      if (ok) vm.lists = lists;
      return { id: vm.rt.plan.id, ok };
    }));
  }

  // A shell on the booted VM with this id, for the Settings GUI's VM
  // Terminal: the guest user's login shell in its home, WITHOUT the guest
  // bwrap (it sees the whole VM, every session's shares included). It counts
  // as a session, so the VM is not idle-stopped under it. Same result shape
  // as attach(); rejects when no such VM runs.
  async attachShell(id, { home }) {
    const vm = [...this.#vms.values()].find((v) => v.rt?.plan.id === id);
    if (!vm) throw new Error('VM not found');
    let planPath = null;
    const { token, release } = this.#join(vm, async () => {
      if (planPath) { try { rmSync(planPath, { force: true }); } catch { /* run dir already gone */ } }
    });
    try {
      const { rt } = vm;
      planPath = join(rt.plan.runDir, 'sessions', `${token}.json`);
      writeFileSync(planPath, JSON.stringify({
        attach: true,
        ssh: rt.plan.ssh,
        remote: { bwrapArgs: null, cwd: home, argv: ['bash', '-l', '-i'], env: rt.plan.remote.env },
      }), { mode: 0o600 });
      return {
        planPath,
        vm: leaseVm(vm),
        release,
      };
    } catch (e) {
      await release();
      throw e;
    }
  }

  // Counts one session on `vm` (before any await, so the idle timer cannot
  // stop the VM under a session that is still attaching). release() runs
  // cleanup once, then arms the idle timer if that was the last session;
  // it is idempotent and never throws.
  #join(vm, cleanup) {
    const token = randomUUID();
    vm.sessions.add(token);
    this.#cancelIdle(vm);
    const release = async () => {
      if (!vm.sessions.delete(token)) return;
      await cleanup();
      if (vm.sessions.size === 0) this.#armIdle(vm);
    };
    return { token, release };
  }

  // [{ key, id, runDir, startedAt, sessions, idleSince, idleStopAt, stale,
  // info, shares }] of booted VMs. idleSince / idleStopAt: when its last
  // session left and when it will be stopped for it, null while in use.
  // stale: a later launch had settings the VM was not booted with.
  list() {
    return [...this.#vms.values()].filter((v) => v.rt).map((v) => ({
      key: v.key, id: v.rt.plan.id, runDir: v.rt.plan.runDir, startedAt: v.startedAt,
      sessions: v.sessions.size, idleSince: v.idleSince ?? null, idleStopAt: v.idleStopAt ?? null,
      stale: !!v.stale, info: v.info, shares: v.rt.shares.list(),
    }));
  }

  // Whether a VM for this key exists (booted or still booting): a launch
  // with this key joins it instead of booting a new one.
  has(key) {
    return this.#vms.has(key);
  }

  // Stops the booted VM with this id now, whether or not sessions use it
  // (theirs end with the ssh connection). Resolves false if there is none.
  async stop(id) {
    const vm = [...this.#vms.values()].find((v) => v.rt?.plan.id === id);
    if (!vm) return false;
    await this.#stop(vm);
    return true;
  }

  async stopAll() {
    await Promise.all([...this.#vms.values()].map((v) => this.#stop(v)));
  }

  // boot: what the VM boots with, kept for later launches to compare against
  // (lists, configDigest) or to add (extraAllowedHosts); see attach().
  #vmFor(key, spec, info, { lists = null, configDigest = null, extraAllowedHosts = [] } = {}) {
    let vm = this.#vms.get(key);
    if (vm) return vm;
    vm = {
      key, info, sessions: new Set(), idleTimer: null, rt: null, startedAt: Date.now(), stopping: null,
      lists, configDigest, extraAllowedHosts, stale: false,
    };
    vm.ready = this.#boot(spec).then((rt) => {
      vm.rt = rt;
      rt.onExit(() => {
        if (this.#vms.get(key) === vm) this.#vms.delete(key);
        this.#cancelIdle(vm);
      });
      return rt;
    }, (e) => {
      if (this.#vms.get(key) === vm) this.#vms.delete(key);
      throw e;
    });
    vm.ready.catch(() => {});
    this.#vms.set(key, vm);
    return vm;
  }

  #cancelIdle(vm) {
    if (vm.idleTimer) { clearTimeout(vm.idleTimer); vm.idleTimer = null; }
    vm.idleSince = null;
    vm.idleStopAt = null;
  }

  // Starts (or, with idleSince, restarts) the countdown of an idle VM.
  #armIdle(vm, idleSince = Date.now()) {
    this.#cancelIdle(vm);
    const ms = typeof this.#idleStopMs === 'function' ? this.#idleStopMs() : this.#idleStopMs;
    vm.idleSince = idleSince;
    vm.idleStopAt = idleSince + ms;
    vm.idleTimer = setTimeout(() => {
      vm.idleTimer = null;
      if (vm.sessions.size === 0) this.#stop(vm);
    }, Math.max(0, vm.idleStopAt - Date.now()));
    vm.idleTimer.unref?.();
  }

  // After the idle time setting changed: idle VMs count the new time from
  // when they went idle (one idle past it stops now).
  rearmIdle() {
    for (const vm of this.#vms.values()) {
      if (vm.idleTimer) this.#armIdle(vm, vm.idleSince);
    }
  }

  #stop(vm) {
    if (vm.stopping) return vm.stopping;
    if (this.#vms.get(vm.key) === vm) this.#vms.delete(vm.key);
    this.#cancelIdle(vm);
    vm.stopping = vm.ready.then((rt) => {
      this.#log(`stopping VM ${rt.plan.id}`);
      return rt.stop();
    }, () => {}).catch((e) => this.#log(`stopping VM: ${e.message}`));
    return vm.stopping;
  }
}

export const qemuVmPool = new QemuVmPool();
