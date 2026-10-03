// The qemu backend's running VMs for the Settings GUI's VM tab.
//
// Throwaway VMs are per-session, so stopping one means ending its session:
// destroySession's teardown kills the launcher (and with it QEMU) and
// removes the run dir with the overlay disk.
//
// Persistent VMs (qemuVmPool.js) are listed per VM, including while idle
// (no session attached, waiting for the idle stop). Stopping one ends every
// session on it and stops the VM now.
//
// GET /api/vms -> {
//   vms: [{ sessionId, cwd, app, shell, customLabel, templateId,
//     templateName, memoryMiB, cpus, diskGiB, startedAt, diskUsedBytes }],
//   pools: [{ vmId, templateId, templateName, memoryMiB, cpus, diskGiB,
//     startedAt, idleSince, idleStopAt, stale, shareCount, diskUsedBytes,
//     sessions: [{ sessionId, cwd, app, shell, customLabel }] }] }
// DELETE /api/vms/:sessionId -> stops that session's VM (404 if it has none).
// DELETE /api/vm-pool/:vmId -> stops that persistent VM (404 if none).

import { statSync } from 'node:fs';
import { join } from 'node:path';
import { listQemuVms, listPooledQemuSessions, destroySession } from '../ws/sessionManager.js';
import { qemuVmPool as defaultPool } from '../ws/qemuVmPool.js';

// Blocks the sparse overlay actually holds (its apparent size is diskGiB).
function overlayUsedBytes(runDir) {
  try {
    return statSync(join(runDir, 'overlay.qcow2')).blocks * 512;
  } catch {
    return null;
  }
}

export async function vmsRoute(fastify, { qemuVmPool = defaultPool } = {}) {
  fastify.get('/vms', async () => {
    const vms = listQemuVms().map(({ runDir, ...vm }) => ({ ...vm, diskUsedBytes: overlayUsedBytes(runDir) }));
    const pooled = listPooledQemuSessions();
    const pools = qemuVmPool.list().map((vm) => ({
      vmId: vm.id,
      ...vm.info,
      startedAt: vm.startedAt,
      idleSince: vm.idleSince,
      idleStopAt: vm.idleStopAt,
      stale: vm.stale,
      shareCount: vm.shares.length,
      diskUsedBytes: overlayUsedBytes(vm.runDir),
      sessions: pooled.filter((s) => s.vmId === vm.id).map(({ vmId, ...s }) => s),
    }));
    return { vms, pools };
  });

  fastify.delete('/vms/:sessionId', async (request, reply) => {
    const { sessionId } = request.params;
    if (!listQemuVms().some((vm) => vm.sessionId === sessionId)) {
      return reply.code(404).send({ error: 'VM not found' });
    }
    destroySession(sessionId, { keepSchedule: false, reason: 'vm-stop' });
    return reply.code(204).send();
  });

  fastify.delete('/vm-pool/:vmId', async (request, reply) => {
    const { vmId } = request.params;
    if (!qemuVmPool.list().some((vm) => vm.id === vmId)) {
      return reply.code(404).send({ error: 'VM not found' });
    }
    for (const s of listPooledQemuSessions()) {
      if (s.vmId === vmId) destroySession(s.sessionId, { keepSchedule: false, reason: 'vm-stop' });
    }
    await qemuVmPool.stop(vmId);
    return reply.code(204).send();
  });
}
