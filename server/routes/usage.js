import { getUsage } from '../usage.js';
import { getCodexUsage } from '../codexUsage.js';
import { getOpencodeUsage } from '../opencodeUsage.js';
import { getLatestSessionLimitReset } from '../sessionLimitState.js';

export async function usageRoute(fastify) {
  // GET /api/usage[?app=codex|opencode][?force=1] — latest usage snapshot
  // for the given app (claude, the default, codex, or opencode Go). Served
  // from a short-lived cache; `force=1` re-captures on demand.
  fastify.get('/usage', async (request) => {
    const force = request.query.force === '1' || request.query.force === 'true';
    if (request.query.app === 'codex') return getCodexUsage({ force });
    if (request.query.app === 'opencode') return getOpencodeUsage({ force });
    return getUsage({ force });
  });

  // GET /api/session-limit-reset — the most recently known session-limit
  // reset time (passive: never triggers a /usage capture). Feeds the
  // scheduler panel's default-time hint. `{ resetAtMs: null }` when nothing
  // is known yet.
  fastify.get('/session-limit-reset', async () => {
    const latest = getLatestSessionLimitReset();
    return latest || { resetAtMs: null };
  });
}
