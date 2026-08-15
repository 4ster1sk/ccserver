// Settings page: list created (persistent) sandboxes with their disk usage
// and delete them. GET /api/sandboxes returns each sandbox's slug, real
// project path (when known), size and whether a live session is currently
// using it; DELETE /api/sandboxes/:name removes its persistent HOME and the
// matching docker data-root, refusing while it is in use.

import { listSandboxHomes, sandboxHomeSize, deleteSandboxHome } from '../ws/sandbox.js';
import { sandboxHomeInUsePath } from '../ws/sessionManager.js';

export async function sandboxesRoute(fastify) {
  fastify.get('/sandboxes', async () => {
    const homes = listSandboxHomes();
    const sandboxes = homes.map((h) => ({
      name: h.name,
      path: h.path,
      cwd: h.cwd,
      size: sandboxHomeSize(h.path),
      inUse: sandboxHomeInUsePath(h.path),
    }));
    return { sandboxes };
  });

  fastify.delete('/sandboxes/:name', async (request, reply) => {
    const { name } = request.params;
    // Bare slug only -- the delete helper refuses anything with separators,
    // but give a clean 400 here rather than a 500-vs-ok inconsistency.
    if (typeof name !== 'string' || !/^[A-Za-z0-9_]+$/.test(name)) {
      return reply.code(400).send({ error: 'invalid sandbox name' });
    }
    const path = listSandboxHomes().find((h) => h.name === name)?.path;
    if (path && sandboxHomeInUsePath(path) > 0) {
      return reply.code(409).send({
        error: 'このサンドボックスを利用中のセッションがあるため削除できません。先にタブを閉じてください。',
      });
    }
    const res = deleteSandboxHome(name);
    if (!res.ok) {
      return reply.code(400).send({ error: res.error || 'invalid sandbox name' });
    }
    return { success: true, name };
  });
}
