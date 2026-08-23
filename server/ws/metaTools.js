// Pure MCP tool implementations for the META agent (ccserver-meta broker).
//
// SECURITY / TRUST MODEL -- READ BEFORE EDITING (plan section 4.2):
// Unlike mcpTools.js, the functions in this file DO take their target
// groupId/sessionId/slug from the WIRE. That is sound only because this
// module is wired to exactly one consumer: the process-global ccserver-meta
// socket (see metaAgent.js / mcpBroker.startMetaBroker), which is bound into
// the single sandbox launched with isMetaAgent:true and nothing else. Never
// register these functions on a group-scoped server.
//
// The per-connection identity frame ({ sessionId, groupId, groupRole, cwd,
// projectName, app } -- CCSERVER_META_IDENTITY via the bridge) arrives as
// deps.identity. It powers ONLY self-reference (the close_session /
// destroy_group self-target guards) and approval attribution
// (requestedBy) -- never an authorization input; the socket binding is the
// boundary.
//
// Conventions:
//   - Every function is pure with respect to imports: all mutable state is
//     reached through `deps` (assembled by ensureMetaAgentBroker), so unit
//     tests can inject fakes without real ptys or sockets.
//   - Results are plain JSON-able objects returned to the LLM verbatim.
//     Failures follow the store convention: { error: code, message }.
//
// STATUS: contract stubs. The tool registrations in mcpServer.js call every
// function below; each stub currently returns { error: 'not-implemented' }.
// Implement them one by one, keeping signatures and result shapes.

import { capSandboxOpts } from './mcpTools.js';

export { capSandboxOpts };

const NOT_IMPLEMENTED = { error: 'not-implemented', message: 'metaTools: this tool has no implementation yet' };

// ---------------------------------------------------------------------------
// deps (assembled by metaAgent.ensureMetaAgentBroker; tests inject fakes):
//   identity          - { sessionId, groupId, groupRole, cwd, projectName,
//                       app } | null (per-connection identity frame)
//   connectionIsAlive - () => boolean (true while the caller's socket lives)
//   groupManager      - extended facade (getGroupManagerApi() PLUS listGroups,
//                       getGroupSummary(groupId), destroyGroup(groupId))
//   sessionManager    - { listSessions(), getSession(id), destroySession(id),
//                       sandboxHomeInUsePath(homePath) }
//   approvalsApi      - { requestApproval({ kind, summary, payload,
//                       requestedBy }) -> Promise<{ status, approval }>,
//                       APPROVAL_KINDS, APPROVAL_TIMEOUT_MS }
//   projectsApi       - { listProjects(), getProject(id), updateProjectLabel(
//                       id, label), findOrCreateProjectByCwd(cwd),
//                       recordSandboxHome(cwd, { createdBy }) }
//   workerPresetsApi  - { listPresets, getPreset, createPreset, updatePreset,
//                       deletePreset } (workerPresets.js result objects)
//   launchPresetsApi  - { listLaunchPresets, getLaunchPreset,
//                       createLaunchPreset(input), updateLaunchPreset(id,
//                       input), deleteLaunchPreset(id) } -- maxWorkers bound
//                       to groups.js's MAX_WORKERS
//   sandboxApi        - { listSandboxHomes(), sandboxHomeSize(path),
//                       deleteSandboxHome(slug), dindLockHeld(slug),
//                       isSandboxDeleteInFlight(slug), beginSandboxDelete(slug),
//                       endSandboxDelete(slug), sandboxRemnantsExist(slug) }
//   dirsApi           - { browseDirectory(path, showHidden),
//                       createDirectory({ parent, name, gitInit }) }
//   sessionsApi       - { createSessionViaApi(body) }: routes/sessions.js's
//                       shared POST /api/sessions implementation -- the ONLY
//                       sanctioned way to spawn sessions here, so REST and
//                       MCP launches cannot drift
// ---------------------------------------------------------------------------

// --- R (read-only) ----------------------------------------------------------

export function listProjects(deps) {
  void deps;
  return { ...NOT_IMPLEMENTED };
}

export async function listSandboxes(deps) {
  void deps;
  // Target shape (routes/sandboxes.js GET + project metadata):
  // { sandboxes: [{ name, path, cwd, projectLabel, gitRemote, lastUsedAt,
  //                 size, inUse, deleting, deleteError }] }
  return { ...NOT_IMPLEMENTED };
}

export async function browseDirectory(deps, { path, showHidden } = {}) {
  void deps;
  void path;
  void showHidden;
  // dirsApi.browseDirectory(path, showHidden) passthrough.
  return { ...NOT_IMPLEMENTED };
}

export function listGroups(deps) {
  void deps;
  return { ...NOT_IMPLEMENTED };
}

export function getGroup(deps, { groupId } = {}) {
  void deps;
  void groupId;
  // deps.groupManager.getGroupSummary(groupId); null -> not-found error.
  return { ...NOT_IMPLEMENTED };
}

export function listSessions(deps) {
  void deps;
  return { ...NOT_IMPLEMENTED };
}

export function listWorkerPresets(deps) {
  void deps;
  return { ...NOT_IMPLEMENTED };
}

export function listLaunchPresets(deps) {
  void deps;
  return { ...NOT_IMPLEMENTED };
}

// --- W-low (config CRUD) ----------------------------------------------------

export function createWorkerPreset(deps, args) {
  void deps;
  void args;
  return { ...NOT_IMPLEMENTED };
}

export function updateWorkerPreset(deps, args) {
  void deps;
  void args;
  return { ...NOT_IMPLEMENTED };
}

export function deleteWorkerPreset(deps, args) {
  void deps;
  void args;
  return { ...NOT_IMPLEMENTED };
}

export function createLaunchPreset(deps, args) {
  void deps;
  void args;
  return { ...NOT_IMPLEMENTED };
}

export function updateLaunchPreset(deps, args) {
  void deps;
  void args;
  return { ...NOT_IMPLEMENTED };
}

export function deleteLaunchPreset(deps, args) {
  void deps;
  void args;
  return { ...NOT_IMPLEMENTED };
}

export function updateProjectLabel(deps, args) {
  void deps;
  void args;
  return { ...NOT_IMPLEMENTED };
}

export async function createDirectory(deps, args) {
  void deps;
  void args;
  return { ...NOT_IMPLEMENTED };
}

// --- W-create (resource creation) -------------------------------------------

export async function launchSession(deps, args) {
  void deps;
  void args;
  // Route through deps.sessionsApi.createSessionViaApi(body). Apply
  // capSandboxOpts(args.sandboxOpts, mySandboxOpts) first, where
  // mySandboxOpts = deps.sessionManager.getSession(deps.identity?.sessionId)
  //   ?.sandboxOpts ?? null
  // (silently downgrade flags you do not hold -- never an error). Record the
  // HOME attribution via createSessionViaApi's requestedBy handling.
  return { ...NOT_IMPLEMENTED };
}

export async function launchGroup(deps, args) {
  void deps;
  void args;
  // Same canonical payload as POST /api/groups; delegate to the shared
  // groups-route launch function (see publish_doc "meta-foundation-interfaces").
  return { ...NOT_IMPLEMENTED };
}

export async function launchFromPreset(deps, args) {
  void deps;
  void args;
  // Snapshot-expand deps.launchPresetsApi.getLaunchPreset(args.presetId) into
  // a launch_group payload and delegate.
  return { ...NOT_IMPLEMENTED };
}

// --- W-destructive (ALWAYS through approvals; self-targets fail closed) -----

export async function closeSession(deps, args) {
  void deps;
  void args;
  // Order: validate + exists -> SELF-TARGET GUARD (args.sessionId ===
  // deps.identity?.sessionId => immediate { error: 'self-target', ... }, NO
  // approval dialog ever) -> await deps.approvalsApi.requestApproval({
  // kind: 'close_session', summary incl. reason, payload: { sessionId },
  // requestedBy: deps.identity?.sessionId }) -> approved ?
  // sessionManager.destroySession(id, { keepSchedule: false }) : no-op.
  return { ...NOT_IMPLEMENTED };
}

export async function destroyGroup(deps, args) {
  void deps;
  void args;
  // Same order; guard compares args.groupId against deps.identity?.groupId.
  return { ...NOT_IMPLEMENTED };
}

export async function deleteSandbox(deps, args) {
  void deps;
  void args;
  // No dedicated self-target guard needed: if YOUR OWN sandbox is mounted at
  // that slug, sessionManager.sandboxHomeInUsePath > 0 refuses it. Pre-check
  // guards BEFORE requesting approval (fail fast saves the user a pointless
  // dialog) AND re-check after approval (TOCTOU). Use begin/end/
  // endSandboxDelete like the DELETE route does.
  return { ...NOT_IMPLEMENTED };
}
