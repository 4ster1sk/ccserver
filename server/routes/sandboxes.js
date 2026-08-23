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
    const sandboxes = await Promise.all(homes.map(async (h) => ({
      name: h.name,
      path: h.path,
      cwd: h.cwd,
      size: await sandboxHomeSize(h.path),
      inUse: sandboxHomeInUsePath(h.path),
    })));
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
    const res = await deleteSandboxHome(name);
    if (!res.ok) {
      if (res.error === 'docker-daemon-in-use') {
        return reply.code(409).send({
          error: 'このサンドボックスの docker デーモンがまだ起動中のため削除できません。しばらく待つか、サーバーを再起動してからもう一度お試しください。',
        });
      }
      if (res.error === 'invalid-sandbox-name') {
        return reply.code(400).send({ error: res.error });
      }
      // Permission trouble removing the data-root/HOME (e.g. containerd
      // overlayfs dirs owned by a subuid the server can't read). Surfaced as a
      // clean 500 with the reason instead of the raw EACCES.
      return reply.code(500).send({ error: `削除に失敗しました: ${res.error}` });
    }
    return { success: true, name };
  });
}
