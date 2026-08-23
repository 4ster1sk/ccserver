// REST boundary for the shared worker preset library. Registered under /api
// (server/index.js), so the optional token hook applies automatically.
//
// Status mapping follows the result-object codes from the store:
//   validation -> 400, duplicate-role -> 409, not-found -> 404, internal -> 500.
// POST returns 200 like the rest of this codebase's create routes.

import { listPresets, createPreset, updatePreset, deletePreset } from '../ws/workerPresets.js';

function errorFor(reply, res) {
  const status = res.code === 'validation' ? 400
    : res.code === 'duplicate-role' ? 409
    : res.code === 'not-found' ? 404
    : 500;
  return reply.code(status).send({ error: res.message || res.code });
}

export async function workerPresetsRoute(fastify) {
  fastify.get('/worker-presets', async (_request, reply) => {
    const res = listPresets();
    if (!res.ok) return errorFor(reply, res);
    return { presets: res.presets };
  });

  fastify.post('/worker-presets', async (request, reply) => {
    const res = createPreset(request.body);
    if (!res.ok) return errorFor(reply, res);
    return { preset: res.preset };
  });

  fastify.put('/worker-presets/:id', async (request, reply) => {
    const res = updatePreset(request.params.id, request.body);
    if (!res.ok) return errorFor(reply, res);
    return { preset: res.preset };
  });

  fastify.delete('/worker-presets/:id', async (request, reply) => {
    const res = deletePreset(request.params.id);
    if (!res.ok) return errorFor(reply, res);
    return { success: true };
  });
}
