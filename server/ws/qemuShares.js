// Hot-plugged virtiofs shares of a running VM, reference-counted by guest
// mount point: the first acquire() attaches and mounts a host directory,
// the last release() unmounts and detaches it.
//
// Attaching one share:
//   1. start a virtiofsd for the host dir; its socket goes in the VM's run
//      dir, the only host path QEMU (confined by bwrap) can see
//   2. QMP chardev-add  (a socket chardev on that path)
//   3. QMP device_add   (vhost-user-fs-pci on a free pcie-root-port, which
//      buildQemuArgs pre-creates: q35 cannot hot-plug onto pcie.0)
//   4. guest: mount -t virtiofs <tag> <guestPath>  (guest.mount)
// Detaching runs the same steps backwards. device_del only completes once
// the guest has ejected the device (DEVICE_DELETED); if it never does, the
// share stays unmounted, its virtiofsd is stopped and the root port is
// retired rather than reused.
//
// Every operation on one mount point runs in order (a per-key promise
// chain), so an acquire racing the last release always ends attached.
//
// deps (injected so the logic is testable without a VM):
//   qmp:            a QmpClient (execute, waitEvent)
//   guest:          { mount(tag, guestPath, readonly), umount(guestPath) }
//   startVirtiofsd: ({ socketPath, hostPath, readonly }) => Promise<{ stop() }>
//                   resolves once the socket is listening

import { spawn } from 'node:child_process';
import { closeSync, existsSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { QmpClient } from './qemuQmp.js';

export const HOTPLUG_PORT_PREFIX = 'ccshp';
export const HOTPLUG_TAG_PREFIX = 'ccshp';
const DEVICE_DELETE_TIMEOUT_MS = 10000;

export function hotplugPortIds(count) {
  return Array.from({ length: count }, (_, i) => `${HOTPLUG_PORT_PREFIX}${i}`);
}

export class HotplugShareManager {
  #runDir;
  #qmp;
  #guest;
  #startVirtiofsd;
  #log;
  #freePorts;
  #entries = new Map(); // guestPath -> entry
  #seq = 0;
  #closed = false;
  #onClose;

  constructor({ runDir, ports, qmp, guest, startVirtiofsd, onClose = () => {}, log = (m) => console.warn(`[sandbox] ${m}`) }) {
    this.#onClose = onClose;
    this.#runDir = runDir;
    this.#freePorts = [...ports];
    this.#qmp = qmp;
    this.#guest = guest;
    this.#startVirtiofsd = startVirtiofsd;
    this.#log = log;
  }

  // Resolves to a lease once hostPath is mounted at guestPath. The same
  // guestPath may only ever carry one hostPath/readonly pair at a time.
  async acquire(hostPath, { guestPath = hostPath, readonly = false } = {}) {
    if (this.#closed) throw new Error('share manager is closed');
    // The guest helper takes the path as the rest of one line.
    if (!guestPath.startsWith('/') || /[\r\n]/.test(guestPath)) throw new Error(`invalid guest path: ${JSON.stringify(guestPath)}`);
    const entry = this.#entry(guestPath);
    await this.#run(entry, async () => {
      if (entry.attached) {
        if (entry.hostPath !== hostPath || entry.readonly !== readonly) {
          throw new Error(`${guestPath} is already shared from ${entry.hostPath}${entry.readonly ? ' (read-only)' : ''}`);
        }
      } else {
        await this.#attach(entry, hostPath, readonly);
      }
      entry.refs++;
    });
    let released = false;
    return {
      guestPath,
      release: () => {
        if (released) return Promise.resolve();
        released = true;
        return this.#release(entry);
      },
    };
  }

  // [{ guestPath, hostPath, readonly, tag, refs }] of attached shares.
  list() {
    return [...this.#entries.values()]
      .filter((e) => e.attached)
      .map((e) => ({ guestPath: e.guestPath, hostPath: e.hostPath, readonly: e.readonly, tag: e.tag, refs: e.refs }));
  }

  // Detaches everything regardless of refs (the VM is going away). Waits
  // for queued operations first.
  async close() {
    this.#closed = true;
    await Promise.all([...this.#entries.values()].map((e) => this.#run(e, async () => {
      if (!e.attached) return;
      e.refs = 0;
      await this.#detach(e);
    }).catch(() => {})));
    this.#onClose();
  }

  #entry(guestPath) {
    let e = this.#entries.get(guestPath);
    if (!e) {
      e = { guestPath, hostPath: null, readonly: false, attached: false, refs: 0, tag: null, port: null, vfsd: null, chain: Promise.resolve(), queued: 0 };
      this.#entries.set(guestPath, e);
    }
    return e;
  }

  // Runs fn after every earlier operation on the same entry; failures do
  // not poison the chain. The entry is forgotten once idle and detached.
  #run(entry, fn) {
    entry.queued++;
    const p = entry.chain.then(fn);
    entry.chain = p.catch(() => {}).then(() => {
      entry.queued--;
      if (entry.queued === 0 && !entry.attached && this.#entries.get(entry.guestPath) === entry) {
        this.#entries.delete(entry.guestPath);
      }
    });
    return p;
  }

  #release(entry) {
    return this.#run(entry, async () => {
      if (entry.refs <= 0) return;
      entry.refs--;
      if (entry.refs === 0 && entry.attached) await this.#detach(entry);
    });
  }

  async #attach(entry, hostPath, readonly) {
    const port = this.#freePorts.shift();
    if (!port) throw new Error('no free hot-plug slot left on this VM');
    const n = this.#seq++;
    const tag = `${HOTPLUG_TAG_PREFIX}${n}`;
    const chardevId = `${tag}-chr`;
    const deviceId = `${tag}-dev`;
    const socketPath = join(this.#runDir, `${tag}.sock`);
    const undo = [];
    try {
      const vfsd = await this.#startVirtiofsd({ socketPath, hostPath, readonly });
      undo.push(() => vfsd.stop());
      await this.#qmp.execute('chardev-add', {
        id: chardevId,
        backend: { type: 'socket', data: { addr: { type: 'unix', data: { path: socketPath } }, server: false } },
      });
      undo.push(() => this.#qmp.execute('chardev-remove', { id: chardevId }));
      await this.#qmp.execute('device_add', { driver: 'vhost-user-fs-pci', id: deviceId, chardev: chardevId, tag, bus: port });
      undo.push(() => this.#unplug(deviceId));
      await this.#guest.mount(tag, entry.guestPath, readonly);
      Object.assign(entry, { hostPath, readonly, attached: true, tag, port, vfsd, chardevId, deviceId });
    } catch (e) {
      let portClean = true;
      for (const u of undo.reverse()) {
        try { await u(); } catch (ue) {
          portClean = false;
          this.#log(`hot-plug rollback of ${entry.guestPath} failed: ${ue.message}`);
        }
      }
      if (portClean) this.#freePorts.push(port);
      throw e;
    }
  }

  async #detach(entry) {
    const { guestPath, tag, port, vfsd, chardevId, deviceId } = entry;
    entry.attached = false;
    try {
      await this.#guest.umount(guestPath);
    } catch (e) {
      this.#log(`unmounting ${guestPath} (${tag}) in the guest failed: ${e.message}`);
    }
    let portClean = true;
    try {
      await this.#unplug(deviceId);
      await this.#qmp.execute('chardev-remove', { id: chardevId });
    } catch (e) {
      portClean = false;
      this.#log(`detaching ${tag} failed, retiring its slot: ${e.message}`);
    }
    try { await vfsd.stop(); } catch { /* already gone */ }
    if (portClean) this.#freePorts.push(port);
  }

  async #unplug(deviceId) {
    const deleted = this.#qmp.waitEvent('DEVICE_DELETED', (d) => d.device === deviceId, DEVICE_DELETE_TIMEOUT_MS);
    try {
      await this.#qmp.execute('device_del', { id: deviceId });
    } catch (e) {
      deleted.catch(() => {});
      throw e;
    }
    await deleted;
  }
}

// --- wiring for a real VM --------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Same options as the boot-time shares (sandbox-qemu.js buildVirtiofsdArgs),
// passed in to keep this module free of the planning code.
export function makeVirtiofsdStarter({ bin, runDir, buildArgs, socketTimeoutMs = 5000 }) {
  return async ({ socketPath, hostPath, readonly }) => {
    const name = socketPath.slice(socketPath.lastIndexOf('/') + 1).replace(/\.sock$/, '');
    const log = openSync(join(runDir, `virtiofsd-${name}.log`), 'a', 0o600);
    const p = spawn(bin, buildArgs({ socketPath, sharedDir: hostPath, readonly }), { stdio: ['ignore', log, log] });
    closeSync(log);
    const exited = () => p.exitCode !== null || p.signalCode !== null;
    const deadline = Date.now() + socketTimeoutMs;
    while (!existsSync(socketPath)) {
      if (exited()) throw new Error(`virtiofsd for ${hostPath} exited (${p.exitCode ?? p.signalCode}); see ${runDir}/virtiofsd-${name}.log`);
      if (Date.now() > deadline) { p.kill('SIGKILL'); throw new Error(`virtiofsd for ${hostPath} did not start`); }
      await sleep(50);
    }
    return {
      async stop() {
        if (exited()) return;
        p.kill('SIGTERM');
        const until = Date.now() + 2000;
        while (!exited() && Date.now() < until) await sleep(50);
        if (!exited()) p.kill('SIGKILL');
      },
    };
  };
}

// The guest's ccs-share helper over the admin ssh login (plan.hotplug.admin).
export function makeGuestShareControl({ bin, args, timeoutMs = 30000 }) {
  const request = (line) => new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: ['pipe', 'ignore', 'pipe'] });
    let err = '';
    const timer = setTimeout(() => { p.kill('SIGKILL'); reject(new Error(`guest share request timed out: ${line}`)); }, timeoutMs);
    p.stderr.on('data', (d) => { if (err.length < 4096) err += d; });
    p.on('error', (e) => { clearTimeout(timer); reject(e); });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`guest share request failed (${code}): ${err.trim() || line}`));
    });
    p.stdin.end(`${line}\n`);
  });
  return {
    mount: (tag, guestPath, readonly) => request(`mount ${tag} ${readonly ? 'ro' : 'rw'} ${guestPath}`),
    umount: (guestPath) => request(`umount ${guestPath}`),
  };
}

// A share manager for the VM a qemu plan describes (sandbox-qemu.js
// prepareQemuSession). close() detaches every share and drops QMP.
export async function openHotplugShares(plan, { buildVirtiofsdArgs }) {
  const qmp = await QmpClient.connect(plan.qmpSocket);
  return new HotplugShareManager({
    runDir: plan.runDir,
    ports: plan.hotplug.ports,
    qmp,
    guest: makeGuestShareControl(plan.hotplug.admin),
    startVirtiofsd: makeVirtiofsdStarter({ bin: plan.hotplug.virtiofsd, runDir: plan.runDir, buildArgs: buildVirtiofsdArgs }),
    onClose: () => qmp.close(),
  });
}
