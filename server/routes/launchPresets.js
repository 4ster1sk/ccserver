// REST boundary for the combo launch preset library. Registered under /api
// (server/index.js), so the optional token hook applies automatically.
//
// Status mapping follows the result-object codes from the store:
//   validation -> 400, duplicate-name -> 409, not-found -> 404, internal -> 500.
// POST/PUT return 200 like the rest of this codebase's create routes.
//
// The human-facing management UI for launch presets is intentionally out of
// scope for this phase (plan decision 6): the REST surface + the meta agent's
// MCP tools are the only management paths.

import { listLaunchPresets, createLaunchPreset, updateLaunchPreset, deleteLaunchPreset } from '../ws/launchPresets.js';
import { MAX_WORKERS } from './groups.js';

function errorFor(reply, res) {
  const status = res.code === 'validation' ? 400
    : res.code === 'duplicate-name' ? 409
    : res.code === 'not-found' ? 404
    : 500;
  return reply.code(status).send({ error: res.message || res.code });
}

export async function launchPresetsRoute(fastify) {
  fastify.get('/launch-presets', async (_request, reply) => {
    const res = listLaunchPresets();
    if (!res.ok) return errorFor(reply, res);
    return { presets: res.presets };
  });

  fastify.post('/launch-presets', async (request, reply) => {
    const res = createLaunchPreset(request.body, { maxWorkers: MAX_WORKERS });
    if (!res.ok) return errorFor(reply, res);
    return { preset: res.preset };
  });

  fastify.put('/launch-presets/:id', async (request, reply) => {
    const res = updateLaunchPreset(request.params.id, request.body, { maxWorkers: MAX_WORKERS });
    if (!res.ok) return errorFor(reply, res);
    return { preset: res.preset };
  });

  fastify.delete('/launch-presets/:id', async (request, reply) => {
    const res = deleteLaunchPreset(request.params.id);
    if (!res.ok) return errorFor(reply, res);
    return { success: true };
  });
}
