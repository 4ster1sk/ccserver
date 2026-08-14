// Sandbox status for the client's reuse dialog. GET /api/sandbox/status
// answers whether persistent per-project HOMEs are enabled, whether a
// previous sandbox already left state for the given cwd, and whether that
// HOME is currently in use by a live sandboxed session (the client disables
// the destructive "新規作成" option while it is).

import { sandboxHomeStatus } from '../ws/sandbox.js';
import { sandboxHomeInUse } from '../ws/sessionManager.js';

export async function sandboxRoute(fastify) {
  fastify.get('/sandbox/status', async (request, reply) => {
    const cwd = typeof request.query.cwd === 'string' && request.query.cwd.length > 0
      ? request.query.cwd
      : null;
    if (!cwd) {
      return reply.code(400).send({ error: 'cwd query parameter is required' });
    }
    const { enabled, exists, path } = sandboxHomeStatus(cwd);
    return { enabled, exists, path, inUse: enabled ? sandboxHomeInUse(cwd) : 0 };
  });
}
