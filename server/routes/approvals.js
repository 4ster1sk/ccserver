// REST boundary for the destructive-action approval flow (see ws/approvals.js).
// Registered under /api (server/index.js), so the optional token hook applies
// automatically.
//
// The browser polls GET /api/approvals (a few seconds' interval, same pattern
// as the settings page's deletion polling) and POSTs a decision per request.

import { decideApproval, listApprovals } from '../ws/approvals.js';

function errorFor(reply, res) {
  const status = res.code === 'validation' ? 400
    : res.code === 'not-found' ? 404
    : res.code === 'already-resolved' ? 409
    : 500;
  return reply.code(status).send({ error: res.message || res.code });
}

export async function approvalsRoute(fastify) {
  fastify.get('/approvals', async (_request, reply) => {
    const res = listApprovals();
    if (!res.ok) return errorFor(reply, res);
    return { pending: res.pending, history: res.history };
  });

  fastify.post('/approvals/:id/decision', async (request, reply) => {
    const body = request.body || {};
    const res = decideApproval(request.params.id, body.decision);
    if (!res.ok) return errorFor(reply, res);
    return { success: true, approval: res.approval };
  });
}
