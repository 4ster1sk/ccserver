// Settings page: list created (persistent) sandboxes with their disk usage
// and delete them. GET /api/sandboxes returns each sandbox's slug, real
// project path (when known), size, whether a live session is currently using
// it, and -- while a deletion is in flight or has just failed -- `deleting`
// and `deleteError`. DELETE /api/sandboxes/:name kicks the removal off in the
// background and answers 204 right away: deleting a multi-GB docker data-root
// takes minutes, and holding the request open froze clients behind the call.
// Deletion progress/failures are polled back through GET.

import {
  listSandboxHomes,
  sandboxHomeSize,
  deleteSandboxHome,
  dindLockHeld,
  sandboxRemnantsExist,
  isSandboxDeleteInFlight,
  sandboxDeletesInFlight,
  beginSandboxDelete,
  endSandboxDelete,
} from '../ws/sandbox.js';
import { sandboxHomeInUsePath } from '../ws/sessionManager.js';

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
      deleting: isSandboxDeleteInFlight(h.name),
      deleteError: lastErrors.get(h.name) || null,
    })));
    const listed = new Set(sandboxes.map((s) => s.name));
    for (const [slug, message] of lastErrors) {
      if (!sandboxRemnantsExist(slug)) {
        // The leftovers are gone -- e.g. the user cleaned them up manually as
        // the error message itself instructs. Stop showing a row for dirs
        // that no longer exist.
        lastErrors.delete(slug);
        continue;
      }
      // A half-finished deletion (HOME already gone, only the unlisted docker
      // data-root left) would otherwise vanish from the page together with the
      // reason it failed -- synthesize an entry so the error stays visible
      // until the user retries or cleans up manually.
      if (!listed.has(slug)) {
        sandboxes.push({ name: slug, path: null, cwd: null, size: null, inUse: 0, deleting: false, deleteError: message });
        listed.add(slug);
      }
    }
    // A retry (or any deletion whose HOME is already gone) has no homes entry;
    // without this the row would vanish from the page mid-deletion and the
    // client would stop polling.
    for (const slug of sandboxDeletesInFlight()) {
      if (!listed.has(slug)) {
        sandboxes.push({ name: slug, path: null, cwd: null, size: null, inUse: 0, deleting: true, deleteError: null });
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
    // Two concurrent background removals over the same trees would race
    // (interleaved escalations, a late failure resurrecting an error row for
    // an already-fully-removed slug). The client disables the button, but
    // that only covers one tab.
    if (isSandboxDeleteInFlight(name)) {
      return reply.code(409).send({
        error: 'このサンドボックスの削除はすでに進行中です。しばらく待ってから状態を更新してください。',
      });
    }
    beginSandboxDelete(name);
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
        endSandboxDelete(name);
        // lastErrors is deliberately kept: the failed dirs (and the reason)
        // must stay visible until a retry succeeds or the user cleans up.
      });
    return reply.code(204).send();
  });
}
