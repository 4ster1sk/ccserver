// Sandbox status for the client's launch dialogs. GET /api/sandbox/status
// answers whether persistent per-project HOMEs are enabled, whether a
// previous sandbox already left state for the given cwd, and whether that
// HOME is currently in use by a live sandboxed session (the client disables
// the destructive "新規作成" option while it is).
//
// `backend` (optional: bwrap | qemu, else the configured default) is the
// launch's backend pick; the response echoes the resolved one. For qemu it
// also lists the VMs already running (throwaway VMs per session, and
// persistent VMs including idle ones), and `joinsRunningVm`: whether this
// launch (its `vmTemplateId`) would join a running persistent VM rather than
// boot a new one. Instead of the reuse dialog the client warns only before
// booting another VM while any runs.

import { sandboxHomeStatus, resolveSandboxBackend, qemuLaunchPoolKey as defaultLaunchPoolKey } from '../ws/sandbox.js';
import { sandboxHomeInUse, listQemuVms } from '../ws/sessionManager.js';
import { qemuVmPool as defaultPool } from '../ws/qemuVmPool.js';

function runningVms(qemuVmPool) {
  const throwaway = listQemuVms().map((vm) => ({
    kind: 'session',
    id: vm.sessionId,
    templateName: vm.templateName || null,
    cwd: vm.cwd,
    app: vm.app,
  }));
  const pooled = qemuVmPool.list().map((vm) => ({
    kind: 'pool',
    id: vm.id,
    templateName: vm.info?.templateName || null,
    sessionCount: vm.sessions,
    idle: vm.sessions === 0,
  }));
  return [...pooled, ...throwaway];
}

export async function sandboxRoute(fastify, { qemuVmPool = defaultPool, qemuLaunchPoolKey = defaultLaunchPoolKey } = {}) {
  fastify.get('/sandbox/status', async (request, reply) => {
    const cwd = typeof request.query.cwd === 'string' && request.query.cwd.length > 0
      ? request.query.cwd
      : null;
    if (!cwd) {
      return reply.code(400).send({ error: 'cwd query parameter is required' });
    }
    const { enabled, exists, path } = sandboxHomeStatus(cwd);
    const backend = resolveSandboxBackend({ backend: request.query.backend });
    const body = { enabled, exists, path, inUse: enabled ? sandboxHomeInUse(cwd) : 0, backend };
    if (backend === 'qemu') {
      const vmTemplateId = typeof request.query.vmTemplateId === 'string' && request.query.vmTemplateId !== ''
        ? request.query.vmTemplateId
        : null;
      const key = qemuLaunchPoolKey({ vmTemplateId });
      body.joinsRunningVm = key !== null && qemuVmPool.has(key);
      body.runningVms = runningVms(qemuVmPool);
    }
    return body;
  });
}
