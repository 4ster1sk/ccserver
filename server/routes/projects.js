// REST boundary for the projects store (read + label edit). Registered under
// /api (server/index.js), so the optional token hook applies automatically.
//
// Status mapping follows the result-object codes from the store:
//   validation -> 400, not-found -> 404, internal -> 500.

import { getProject, listProjects, updateProjectLabel } from '../ws/projects.js';

function errorFor(reply, res) {
  const status = res.code === 'validation' ? 400
    : res.code === 'not-found' ? 404
    : 500;
  return reply.code(status).send({ error: res.message || res.code });
}

export async function projectsRoute(fastify) {
  fastify.get('/projects', async (_request, reply) => {
    const res = listProjects();
    if (!res.ok) return errorFor(reply, res);
    return { projects: res.projects };
  });

  fastify.get('/projects/:id', async (request, reply) => {
    const res = getProject(request.params.id);
    if (!res.ok) return errorFor(reply, res);
    return { project: res.project };
  });

  // Label-only update (the meta agent's update_project_label tool shares the
  // same store function). null clears the label -- the UI falls back to the
  // project's basename.
  fastify.put('/projects/:id/label', async (request, reply) => {
    const body = request.body || {};
    const res = updateProjectLabel(request.params.id, body.label === undefined ? null : body.label);
    if (!res.ok) return errorFor(reply, res);
    return { project: res.project };
  });
}
