// Combo launch: create/inspect/destroy a group of sessions (2 workers + 1
// orchestrator) sharing a project directory. Sessions are created server-side
// via the normal createSession() path (they are NOT a third app kind -- just
// sessions with groupId/groupRole set); the browser then attaches to all
// three over the regular WS attach flow.
//
// The orchestrator runs in its own isolated directory (orchestratorDir) with
// only CLAUDE.md/AGENTS.md, in a mandatory sandbox. Its reach into the workers
// is the control MCP server socket (see mcpBroker.js / mcpTools.js) -- basic
// project facts are obtained through the repo_info tool, never by direct
// filesystem access. CLAUDE.md/AGENTS.md are generated fresh on every
// (re)spawn from server/ws/orchestrator-template.md plus the group's saved
// custom instructions, then ro-bind mounted over the two files -- see
// groupManager.generateOrchestratorClaudeMdSrc and sandbox.js's
// buildBwrapArgs. The orchestrator (a live LLM reachable through prompt
// injection from worker output) can never persist an edit to its own
// operating rules.
//
// orchestratorDir is deterministic per project (hashed from the resolved cwd),
// so it survives group launches and server restarts for the same project.
// Concurrent groups for one cwd are refused at creation time, so at most one
// live group ever owns a dir at once.

import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, statSync, rmSync, existsSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import * as groupManager from '../ws/groupManager.js';
import { createSession, getSession } from '../ws/sessionManager.js';
import { sandboxAvailable } from '../ws/sandbox.js';
import { isValidApp } from '../ws/appLaunch.js';

const ORCHESTRATOR_ROOT = join(homedir(), '.local', 'share', 'ccserver-sandbox', 'orchestrator');

// The orchestrator dir is derived deterministically from the project path
// (not the random groupId), so it can be reused as the orchestrator's cwd
// (scratch space) across the group being destroyed and a new group launching
// for the same project -- see destroyGroup's comment in groupManager.js.
// CLAUDE.md/AGENTS.md themselves are never persisted here (see the header
// comment above); only the dir itself is reused. resolve() normalizes
// spelling variants (trailing slash, "..", ...) so they all map to the same
// dir. 24 hex chars (96 bits) of the sha256 is plenty of collision headroom
// for a handful of projects.
export function orchestratorDirForCwd(cwd) {
  const hash = createHash('sha256').update(resolve(cwd)).digest('hex').slice(0, 24);
  return join(ORCHESTRATOR_ROOT, hash);
}

// Pure duplicate-project detection for POST /groups: two groups for the same
// project would share one orchestratorDir, cross-talking through resumeLast
// and fighting over CLAUDE.md. `groups` is a listGroups() listing; resolve()
// keeps cwd spelling variants from slipping past the check. Exposed for tests.
export function groupExistsForCwd(cwd, groups) {
  const target = resolve(cwd);
  return groups.find((g) => resolve(g.cwd) === target) || null;
}

function validCwd(cwd) {
  if (typeof cwd !== 'string' || !cwd.startsWith('/') || cwd === '/') return false;
  try {
    return statSync(cwd).isDirectory();
  } catch {
    return false;
  }
}

function memberSpecFromBody(spec) {
  const source = spec && typeof spec === 'object' ? spec : {};
  const result = {};
  if (Object.prototype.hasOwnProperty.call(source, 'app')) {
    result.app = typeof source.app === 'string' && isValidApp(source.app) ? source.app : null;
  }
  if (Object.prototype.hasOwnProperty.call(source, 'model')) {
    if (source.model !== null && typeof source.model !== 'string') result.model = undefined;
    else result.model = source.model;
  }
  if (Object.prototype.hasOwnProperty.call(source, 'sandboxOpts')) {
    result.sandboxOpts = source.sandboxOpts && typeof source.sandboxOpts === 'object'
      ? { gpg: !!source.sandboxOpts.gpg, sshAgent: !!source.sandboxOpts.sshAgent }
      : null;
  }
  return result;
}

// Session options for the orchestrator-restart route. Extracted (and pure)
// so the resume policy is unit-testable: the restart always continues the
// group's most recent orchestrator conversation (orchestratorDir is exclusive
// to the project (cwd); concurrent groups for the same project are refused at
// creation time, so at most one live group ever owns it at a time --
// `resumeLast` maps 1:1 onto "the previous conversation"). projectName is the
// real project's basename: the session's cwd is the hashed orchestratorDir,
// which must not leak into the notify footer (see sessionManager).
export function orchestratorRestartSessionOpts({ group, app, model = null, sandboxOpts = null, mcpSocketPath, orchestratorClaudeMdSrc = null }) {
  return {
    cwd: group.orchestratorDir,
    cols: 80,
    rows: 24,
    sandbox: true,
    sandboxOpts,
    app,
    model,
    resumeLast: true,
    groupId: group.id,
    groupRole: 'orchestrator',
    projectName: group.cwd ? basename(group.cwd) : null,
    mcpSocketPath,
    orchestratorClaudeMdSrc,
  };
}

export async function groupsRoute(fastify, opts) {
  fastify.post('/groups', async (request, reply) => {
    const body = request.body || {};
    const { cwd } = body;

    if (!validCwd(cwd)) {
      return reply.code(400).send({ error: 'cwd must be an existing directory (not /)' });
    }
    // The orchestrator dir is derived from cwd, so a second group for the same
    // project would share it (cross-talk through resumeLast, CLAUDE.md fights).
    // Refuse up front -- live or closed -- and point at the existing group.
    const existingGroup = groupExistsForCwd(cwd, groupManager.listGroups());
    if (existingGroup) {
      return reply.code(409).send({
        error: existingGroup.liveCount > 0
          ? `a group is already running for this project (${existingGroup.groupId}); use it instead of creating a new one`
          : `a group already exists for this project (${existingGroup.groupId}, currently closed); reopen it instead of creating a new one`,
      });
    }
    if (!sandboxAvailable()) {
      return reply.code(400).send({ error: 'combo launch requires the sandbox (bwrap not found on this host)' });
    }

    const workerA = memberSpecFromBody(body.workerA);
    const workerB = memberSpecFromBody(body.workerB);
    const orchestrator = memberSpecFromBody(body.orchestrator);
    // copilot has no CLI-arg/env MCP injection (config-file only), so combo
    // members can never use the group's broker tools -- refuse it explicitly
    // here. Codex supports process-scoped -c MCP overrides.
    const invalidApp = (spec) => Object.prototype.hasOwnProperty.call(spec || {}, 'app')
      && (!spec.app || spec.app === 'copilot');
    if (invalidApp(workerA) || invalidApp(workerB) || invalidApp(orchestrator)) {
      return reply.code(400).send({ error: 'workerA/workerB/orchestrator app must be claude, opencode, or codex (Copilot is not supported in groups)' });
    }
    if ((Object.prototype.hasOwnProperty.call(workerA, 'model') && workerA.model === undefined)
      || (Object.prototype.hasOwnProperty.call(workerB, 'model') && workerB.model === undefined)
      || (Object.prototype.hasOwnProperty.call(orchestrator, 'model') && orchestrator.model === undefined)) {
      return reply.code(400).send({ error: 'member model must be a string or null' });
    }
    const sandboxOpts = (body.sandboxOpts && typeof body.sandboxOpts === 'object')
      ? { gpg: !!body.sandboxOpts.gpg, sshAgent: !!body.sandboxOpts.sshAgent }
      : null;

    const groupId = randomUUID();
    const orchestratorDir = orchestratorDirForCwd(cwd);
    // Only a dir this request created is cleaned up on failure: a reused dir
    // is a per-project resource (see the header comment) that must survive a
    // failed launch.
    const dirAlreadyExisted = existsSync(orchestratorDir);
    try {
      mkdirSync(orchestratorDir, { recursive: true, mode: 0o700 });
    } catch (err) {
      return reply.code(500).send({ error: `Failed to create orchestrator dir: ${err.message}` });
    }

    const instructions = (body.orchestrator && typeof body.orchestrator.instructions === 'string'
      && body.orchestrator.instructions.trim())
      ? body.orchestrator.instructions
      : null;

    // Broker start failures (socket path collision, permission errors, ...)
    // must surface as a launch error, not a silent "success".
    try {
      await groupManager.createGroup({
        groupId,
        cwd,
        orchestratorDir,
        sandboxOpts,
        orchestratorApp: orchestrator.app,
        orchestratorModel: orchestrator.model,
        orchestratorSandboxOpts: orchestrator.sandboxOpts ?? null,
        memberPrefs: { workerA, workerB, orchestrator },
        instructions,
      });
    } catch (err) {
      if (!dirAlreadyExisted) { try { rmSync(orchestratorDir, { recursive: true, force: true }); } catch { /* best effort */ } }
      return reply.code(500).send({ error: `Failed to start control broker: ${err.message}` });
    }
    const controlBroker = groupManager.getGroup(groupId).controlBroker;

    // Roll back cleanly if any of the three spawns fails.
    const fail = (message) => {
      groupManager.destroyGroup(groupId);
      if (!dirAlreadyExisted) { try { rmSync(orchestratorDir, { recursive: true, force: true }); } catch { /* best effort */ } }
      return reply.code(400).send({ error: message });
    };

    // Merge the template with `instructions` and write the result to the
    // host-only overlay path; sandbox.js ro-binds it over CLAUDE.md/AGENTS.md
    // (see the header comment). Generated only now that the group record
    // exists (group.instructions is what the merge reads).
    let orchestratorClaudeMdSrc;
    try {
      orchestratorClaudeMdSrc = groupManager.generateOrchestratorClaudeMdSrc(groupId);
    } catch (err) {
      return fail(`failed to generate orchestrator instructions: ${err.message}`);
    }

    // Workers reuse addMember (the open_tab path) so validation, channel
    // creation, session spawn and registration can't drift between the
    // initial trio and later open_tab additions. Two workers in parallel.
    const workerResults = await Promise.all(
      [['workerA', workerA], ['workerB', workerB]].map(async ([role, spec]) => ({
        role,
        res: await groupManager.addMember(groupId, role, { ...spec, cwd }),
      })),
    );
    for (const { role, res } of workerResults) {
      if (res.error) return fail(`worker ${role} failed to launch: ${res.message || res.error}`);
    }

    const orchRes = createSession({
      cwd: orchestratorDir,
      cols: 80,
      rows: 24,
      sandbox: true,
      sandboxOpts: orchestrator.sandboxOpts ?? null,
      // An absent orchestrator app must not fall through to createSession's
      // defaultApp(): a config defaulting to copilot would launch a group
      // member copilot can't run (no MCP injection). claude is the group
      // default.
      app: orchestrator.app || 'claude',
      model: orchestrator.model ?? null,
      groupId,
      groupRole: 'orchestrator',
      // The session's cwd is the hashed orchestratorDir; the notify footer
      // must attribute the orchestrator to the real project instead.
      projectName: basename(cwd),
      mcpSocketPath: controlBroker ? controlBroker.sockPath : null,
      orchestratorClaudeMdSrc,
    });
    if (orchRes.error || !orchRes.session) {
      return fail(`orchestrator failed to launch: ${orchRes.error || 'unknown error'}`);
    }
    groupManager.registerMember(groupId, 'orchestrator', orchRes.sessionId);
    groupManager.setMemberPrefs(groupId, 'orchestrator', {
      app: orchRes.session.app,
      model: orchRes.session.model,
      sandboxOpts: orchestrator.sandboxOpts ?? null,
    });
    // Assembly is complete: the group is now subject to the "no live members"
    // auto-destroy in onSessionExit. Before this point a member crash must
    // not tear the half-built group (and its control broker) down.
    groupManager.markGroupAssembled(groupId);

    fastify.log.info(`[groups] ${groupId} launched at ${cwd} (workers ${workerA.app || 'default'}/${workerB.app || 'default'}, orchestrator ${orchRes.session.app})`);
    return {
      groupId,
      cwd,
      members: groupManager.listGroupMembers(groupId),
      currentTurn: groupManager.getGroup(groupId)?.currentTurn ?? null,
      lastHandoffAt: groupManager.getGroup(groupId)?.lastHandoffAt ?? null,
    };
  });

  fastify.get('/groups', async (request, reply) => {
    return { groups: groupManager.listGroups() };
  });

  fastify.get('/groups/:id', async (request, reply) => {
    const group = groupManager.getGroup(request.params.id);
    if (!group) {
      return reply.code(404).send({ error: 'Group not found' });
    }
    return {
      groupId: group.id,
      cwd: group.cwd,
      allowedCwds: [...group.allowedCwds],
      orchestratorDir: group.orchestratorDir,
      members: groupManager.listGroupMembers(group.id),
      currentTurn: group.currentTurn,
      lastHandoffAt: group.lastHandoffAt,
    };
  });

  // Restart a dead orchestrator: recreate the control broker and spawn a new
  // orchestrator session in the group's own directory. Workers stay as they
  // are. 404 when the group is gone; 409 while an orchestrator still lives.
  fastify.post('/groups/:id/orchestrator', async (request, reply) => {
    const group = groupManager.getGroup(request.params.id);
    if (!group) {
      return reply.code(404).send({ error: 'Group not found' });
    }
    const existing = group.members.get('orchestrator');
    if (existing) {
      const s = getSession(existing);
      if (s && !s.exited) {
        return reply.code(409).send({ error: 'orchestrator is still running' });
      }
    }

    // Prefer the persisted launch app; fall back to the restored member's
    // saved app (legacy groups persisted before orchestratorApp existed).
    const orchMember = groupManager.listGroupMembers(request.params.id).find((m) => m.role === 'orchestrator');
    const pref = groupManager.getMemberPrefs(request.params.id, 'orchestrator') || {};
    const app = pref.app || group.orchestratorApp || orchMember?.app || 'claude';
    const model = pref.model ?? orchMember?.model ?? group.orchestratorModel ?? null;
    const sandboxOpts = pref.sandboxOpts ?? orchMember?.sandboxOpts ?? null;
    if (!isValidApp(app)) {
      return reply.code(400).send({ error: 'orchestrator app unavailable for restart' });
    }
    if (!group.orchestratorDir) {
      return reply.code(400).send({ error: 'orchestrator dir missing' });
    }

    const mcpSocketPath = await groupManager.resolveGroupMcpSocket(request.params.id, 'orchestrator');
    if (!mcpSocketPath) {
      return reply.code(500).send({ error: 'failed to re-create the control broker' });
    }

    // Regenerated on every restart (see groupManager.generateOrchestratorClaudeMdSrc):
    // picks up any template edit since the orchestrator's last launch, and
    // always overrides whatever it may have tried to write to the previous
    // (ro-bound) CLAUDE.md/AGENTS.md.
    let orchestratorClaudeMdSrc;
    try {
      orchestratorClaudeMdSrc = groupManager.generateOrchestratorClaudeMdSrc(group.id);
    } catch (err) {
      return reply.code(500).send({ error: `failed to generate orchestrator instructions: ${err.message}` });
    }

    const res = createSession(orchestratorRestartSessionOpts({ group, app, model, sandboxOpts, mcpSocketPath, orchestratorClaudeMdSrc }));
    if (res.error || !res.session) {
      return reply.code(500).send({ error: `orchestrator restart failed: ${res.error || 'unknown error'}` });
    }
    groupManager.registerMember(group.id, 'orchestrator', res.sessionId);
    groupManager.setMemberPrefs(group.id, 'orchestrator', { app, model: res.session.model, sandboxOpts });
    fastify.log.info(`[groups] ${group.id} orchestrator restarted (${app})`);
    return {
      groupId: group.id,
      members: groupManager.listGroupMembers(group.id),
    };
  });

  fastify.delete('/groups/:id', async (request, reply) => {
    const group = groupManager.getGroup(request.params.id);
    if (!group) {
      return reply.code(404).send({ error: 'Group not found' });
    }
    groupManager.destroyGroup(request.params.id);
    return { success: true, groupId: request.params.id };
  });
}
