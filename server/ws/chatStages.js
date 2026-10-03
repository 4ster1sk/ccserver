// Startup stages of an opencode chat session (the "⟳ VM 起動中…" list the
// chat view shows before the conversation opens).
//
// The pty children that know when a stage begins/ends -- the qemu launcher
// (vm_boot, vm_setup) and the chat bridge (opencode) -- report it in-band
// with an OSC sequence a terminal ignores:
//
//   ESC ] 777 ; ccserver-stage ; <stage> ; <state> [; <message>] BEL
//
// sessionManager parses those out of the pty stream; the stages it owns
// itself (sandbox, session) it sets directly. The writers are CommonJS
// helpers that run outside this process, so they format the marker
// themselves (see stageMarker in opencode-chat-bridge.cjs and
// sandbox-qemu-launcher.cjs) -- keep the three in sync.

export const STAGE_STATES = ['pending', 'running', 'done', 'error'];

const MARKER_RE = /\x1b\]777;ccserver-stage;([a-z_]+);(pending|running|done|error)(?:;([^\x07\x1b]*))?(?:\x07|\x1b\\)/g;

// The stages a chat launch goes through, in display order. The VM stages
// only exist for a qemu VM booted for this session (a session joining a
// running persistent VM has nothing to wait for there).
export function chatStageIds({ sandboxed, backend, pooled = false }) {
  return [
    ...(sandboxed ? ['sandbox'] : []),
    ...(sandboxed && backend === 'qemu' && !pooled ? ['vm_boot', 'vm_setup'] : []),
    'opencode',
    'session',
  ];
}

export function initialChatStages(ids) {
  return ids.map((id) => ({ id, state: 'pending', startedAt: null, endedAt: null, message: null }));
}

// Mutates `stages` (the session's list) in place. Unknown stage ids are
// ignored rather than appended: the list is fixed at launch. Returns
// whether anything changed.
export function applyStage(stages, id, state, message = null, now = Date.now()) {
  const stage = stages.find((s) => s.id === id);
  if (!stage || !STAGE_STATES.includes(state)) return false;
  if (stage.state === state && (message ?? null) === stage.message) return false;
  if (state === 'running' && !stage.startedAt) stage.startedAt = now;
  if (state === 'done' || state === 'error') {
    if (!stage.startedAt) stage.startedAt = now;
    stage.endedAt = now;
  }
  stage.state = state;
  stage.message = message ?? null;
  // A stage starting means every earlier one is over: the launcher does not
  // send a separate "done" for a stage the next one implies.
  if (state === 'running' || state === 'done') {
    for (const prev of stages) {
      if (prev === stage) break;
      if (prev.state === 'pending' || prev.state === 'running') {
        if (!prev.startedAt) prev.startedAt = now;
        prev.endedAt = now;
        prev.state = 'done';
      }
    }
  }
  return true;
}

// Marks the first unfinished stage failed (the launch died before reaching
// the end). No-op once every stage is done.
export function failCurrentStage(stages, message, now = Date.now()) {
  const current = stages.find((s) => s.state === 'pending' || s.state === 'running');
  if (!current) return false;
  return applyStage(stages, current.id, 'error', message, now);
}

// Every marker in `chunk`, in order. A marker split across two pty chunks
// is missed by design of a stateless parse, so the caller feeds a short
// carry-over window (see sessionManager's chatStageBuf).
export function parseStageMarkers(text) {
  const out = [];
  MARKER_RE.lastIndex = 0;
  let m;
  while ((m = MARKER_RE.exec(text)) !== null) {
    out.push({ id: m[1], state: m[2], message: m[3] ? m[3] : null, end: MARKER_RE.lastIndex });
  }
  return out;
}

export function formatStageMarker(id, state, message) {
  const msg = message ? `;${String(message).replace(/[\x00-\x1f\x7f;]/g, ' ').slice(0, 300)}` : '';
  return `\x1b]777;ccserver-stage;${id};${state}${msg}\x07`;
}
