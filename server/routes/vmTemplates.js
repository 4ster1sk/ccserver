// REST boundary for the QEMU VM templates (vmTemplates.js), backing the
// Settings GUI's VM tab. Registered under /api (server/index.js), so the
// optional token auth hook applies automatically.
//
// GET also returns what the form needs: sandbox.config.json's qemu values
// (used when no template applies), the resource bounds, the host's size,
// whether the qemu backend is configured / usable at all, the
// persistent VMs' idle time (PUT /vm-pool-settings), and which agent
// credentials the VM's network broker injects (PUT /vm-agent-auth; the
// values themselves are never returned).
//
// Status mapping: validation -> 400, not-found -> 404, conflict -> 409.

import { cpus, totalmem } from 'node:os';
import {
  listVmTemplates, createVmTemplate, updateVmTemplate, deleteVmTemplate,
  getDefaultVmTemplateId, setDefaultVmTemplateId, VmTemplateError,
  getPoolIdleStopMinutes, setPoolIdleStopMinutes, POOL_IDLE_STOP_MINUTES,
} from '../vmTemplates.js';
import { qemuVmPool } from '../ws/qemuVmPool.js';
import { vmAgentCredentialStatus, setClaudeOAuthToken, setOpencodeApiKey, VmAgentCredentialError } from '../vmAgentCredentials.js';
import { loadSandboxConfig } from '../ws/sandbox.js';
import { qemuStatus, QEMU_RESOURCE_LIMITS, TEMPLATE_CLOUD_CONFIG_KEYS } from '../ws/sandbox-qemu.js';

const STATUS = { validation: 400, 'not-found': 404, conflict: 409 };

function sendError(reply, err) {
  if (err instanceof VmTemplateError) return reply.code(STATUS[err.code] || 500).send({ error: err.message });
  throw err;
}

export async function vmTemplatesRoute(fastify) {
  fastify.get('/vm-templates', async () => {
    const cfg = loadSandboxConfig();
    return {
      templates: listVmTemplates(),
      defaultTemplateId: getDefaultVmTemplateId(),
      fallback: cfg.qemu,
      limits: QEMU_RESOURCE_LIMITS,
      cloudConfigKeys: TEMPLATE_CLOUD_CONFIG_KEYS,
      host: { totalMemMiB: Math.floor(totalmem() / (1024 * 1024)), cpus: cpus().length },
      backend: cfg.backend,
      qemu: qemuStatus(),
      pool: { idleStopMinutes: getPoolIdleStopMinutes(), limits: { idleStopMinutes: POOL_IDLE_STOP_MINUTES } },
      agentAuth: vmAgentCredentialStatus(),
    };
  });

  fastify.post('/vm-templates', async (request, reply) => {
    try {
      return { template: createVmTemplate(request.body) };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  fastify.put('/vm-templates/:id', async (request, reply) => {
    try {
      return { template: updateVmTemplate(request.params.id, request.body) };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  fastify.delete('/vm-templates/:id', async (request, reply) => {
    try {
      deleteVmTemplate(request.params.id);
      return reply.code(204).send();
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // Body: { id: string | null } (null clears the default).
  fastify.put('/vm-templates-default', async (request, reply) => {
    const id = request.body?.id ?? null;
    try {
      setDefaultVmTemplateId(id);
      return { defaultTemplateId: getDefaultVmTemplateId() };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  // Body: { claudeOAuthToken: string | null } or
  // { opencodeApiKey: { provider: string, key: string | null } } (null
  // clears it). Applies from the next launch; a persistent VM with the old
  // value keeps running for its sessions until it idles out (the values are
  // part of its pool key).
  fastify.put('/vm-agent-auth', async (request, reply) => {
    const body = request.body || {};
    const claude = Object.hasOwn(body, 'claudeOAuthToken');
    const opencode = Object.hasOwn(body, 'opencodeApiKey');
    if (claude === opencode) return reply.code(400).send({ error: 'exactly one of claudeOAuthToken or opencodeApiKey is required' });
    const oc = body.opencodeApiKey;
    if (opencode && (!oc || typeof oc !== 'object' || !Object.hasOwn(oc, 'key'))) {
      return reply.code(400).send({ error: 'opencodeApiKey must be { provider, key }' });
    }
    try {
      if (claude) setClaudeOAuthToken(body.claudeOAuthToken);
      else setOpencodeApiKey(oc.provider, oc.key);
    } catch (err) {
      if (err instanceof VmAgentCredentialError) return reply.code(400).send({ error: err.message });
      throw err;
    }
    return { agentAuth: vmAgentCredentialStatus() };
  });

  // Body: { idleStopMinutes: integer }. Applies to VMs already idle too.
  fastify.put('/vm-pool-settings', async (request, reply) => {
    try {
      setPoolIdleStopMinutes(request.body?.idleStopMinutes);
      qemuVmPool.rearmIdle();
      return { idleStopMinutes: getPoolIdleStopMinutes() };
    } catch (err) {
      return sendError(reply, err);
    }
  });
}
