// Settings page: list created (persistent) sandboxes with their disk usage
// and delete them. GET /api/sandboxes returns each sandbox's slug, real
// project path (when known), size, whether a live session is currently using
// it, and -- while a deletion is in flight or has just failed -- `deleting`
// and `deleteError`. DELETE /api/sandboxes/:name kicks the removal off in the
// background and answers 204 right away: deleting a multi-GB docker data-root
// takes minutes, and holding the request open froze clients behind the call.
// Deletion progress/failures are polled back through GET.

import { listSandboxHomes, sandboxHomeSize, deleteSandboxHome, dindLockHeld } from '../ws/sandbox.js';
import { sandboxHomeInUsePath } from '../ws/sessionManager.js';

const inFlight = new Set(); // slugs with a deletion currently running
const lastErrors = new Map(); // slug -> why its last delete failed

export async function sandboxesRoute(fastify) {
  fastify.get('/sandboxes', async () => {
    const homes = listSandboxHomes();
    const sandboxes = await Promise.all(homes.map(async (h) => ({
      name: h.name,
      path: h.path,
      cwd: h.cwd,
      size: await sandboxHomeSize(h.path),
      inUse: sandboxHomeInUsePath(h.path),
      deleting: inFlight.has(h.name),
      deleteError: lastErrors.get(h.name) || null,
    })));
    // A half-finished deletion (HOME already gone, only the unlisted docker
    // data-root left) would otherwise vanish from the page together with the
    // reason it failed -- synthesize an entry so the error stays visible
    // until the user retries or cleans up manually.
    const listed = new Set(sandboxes.map((s) => s.name));
    for (const [slug, message] of lastErrors) {
      if (!listed.has(slug)) {
        sandboxes.push({ name: slug, path: null, cwd: null, size: null, inUse: 0, deleting: false, deleteError: message });
      }
    }
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
    // Pre-check so the common "leaked dockerd still holds the data-root" case
    // gets an immediate 409 instead of surfacing later as a list-side error;
    // deleteSandboxHome re-checks to close the check/start race.
    if (dindLockHeld(name)) {
      return reply.code(409).send({
        error: 'このサンドボックスの docker デーモンがまだ起動中のため削除できません。しばらく待つか、サーバーを再起動してからもう一度お試しください。',
      });
    }
    inFlight.add(name);
    lastErrors.delete(name);
    void deleteSandboxHome(name)
      .then((res) => {
        if (!res.ok) {
          lastErrors.set(name, res.error === 'docker-daemon-in-use'
            ? 'このサンドボックスの docker デーモンがまだ起動中のため削除できません。しばらく待つか、サーバーを再起動してからもう一度お試しください。'
            : `削除に失敗しました: ${res.error}`);
        }
      })
      .catch(() => {
        lastErrors.set(name, '削除に失敗しました');
      })
      .finally(() => {
        inFlight.delete(name);
        // lastErrors is deliberately kept: the failed dirs (and the reason)
        // must stay visible until a retry succeeds or the user cleans up.
      });
    return reply.code(204).send();
  });
}
