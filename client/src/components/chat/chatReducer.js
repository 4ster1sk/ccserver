// Applies opencode's live session events to the message list the chat view
// renders, the same way opencode's own projection does
// (opencode/packages/core/src/session/message-updater.ts): content parts are
// appended as they start, and a delta always extends the LATEST part of its
// kind. Durable boundaries (text.ended, tool.success, ...) carry the full
// value, so a missed delta heals there.
//
// Messages are plain objects in opencode's wire shape (Session.Message.*);
// every update returns new arrays/objects so React sees the change.

function latestIndex(content, pred) {
  for (let i = content.length - 1; i >= 0; i--) if (pred(content[i])) return i;
  return -1;
}

function updateAssistant(messages, id, fn) {
  const i = messages.findIndex((m) => m.id === id);
  if (i < 0) return messages;
  const msg = messages[i];
  const next = fn({ ...msg, content: [...(msg.content || [])], time: { ...(msg.time || {}) } });
  if (next === msg) return messages;
  const copy = [...messages];
  copy[i] = next;
  return copy;
}

function updateLatest(msg, pred, fn) {
  const i = latestIndex(msg.content, pred);
  if (i < 0) return msg;
  msg.content[i] = fn({ ...msg.content[i] });
  return msg;
}

const isText = (p) => p.type === 'text';
const isReasoning = (p) => p.type === 'reasoning';
const isTool = (id) => (p) => p.type === 'tool' && p.id === id;

export function upsertMessage(messages, message) {
  const i = messages.findIndex((m) => m.id === message.id);
  if (i < 0) return sortMessages([...messages, message]);
  const copy = [...messages];
  copy[i] = message;
  return copy;
}

export function sortMessages(messages) {
  return [...messages].sort((a, b) => (a.time?.created ?? 0) - (b.time?.created ?? 0));
}

// Returns the next message list for one event (unchanged list when the
// event is not about message content).
export function applyMessageEvent(messages, event) {
  const d = event.data || {};
  const now = event.created || Date.now();
  switch (event.type) {
    case 'session.step.started':
      if (messages.some((m) => m.id === d.assistantMessageID)) return messages;
      return [...messages, {
        id: d.assistantMessageID, type: 'assistant', agent: d.agent, model: d.model,
        content: [], time: { created: now },
      }];
    case 'session.step.ended':
      return updateAssistant(messages, d.assistantMessageID, (m) => {
        m.time.completed = now;
        m.finish = d.finish;
        if (d.tokens) m.tokens = d.tokens;
        if (d.cost !== undefined) m.cost = d.cost;
        return m;
      });
    case 'session.step.failed':
      return updateAssistant(messages, d.assistantMessageID, (m) => {
        m.time.completed = now;
        m.error = d.error;
        return m;
      });
    case 'session.text.started':
      return updateAssistant(messages, d.assistantMessageID, (m) => {
        m.content.push({ type: 'text', text: '' });
        return m;
      });
    case 'session.text.delta':
      return updateAssistant(messages, d.assistantMessageID, (m) => updateLatest(m, isText, (p) => ({ ...p, text: (p.text || '') + d.delta })));
    case 'session.text.ended':
      return updateAssistant(messages, d.assistantMessageID, (m) => updateLatest(m, isText, (p) => ({ ...p, text: d.text })));
    case 'session.reasoning.started':
      return updateAssistant(messages, d.assistantMessageID, (m) => {
        m.content.push({ type: 'reasoning', text: '', time: { created: now } });
        return m;
      });
    case 'session.reasoning.delta':
      return updateAssistant(messages, d.assistantMessageID, (m) => updateLatest(m, isReasoning, (p) => ({ ...p, text: (p.text || '') + d.delta })));
    case 'session.reasoning.ended':
      return updateAssistant(messages, d.assistantMessageID, (m) => updateLatest(m, isReasoning, (p) => ({ ...p, text: d.text, time: { ...(p.time || {}), completed: now } })));
    case 'session.tool.input.started':
      return updateAssistant(messages, d.assistantMessageID, (m) => {
        m.content.push({ type: 'tool', id: d.id, name: d.name, time: { created: now }, state: { status: 'streaming', input: '' } });
        return m;
      });
    case 'session.tool.input.delta':
      return updateAssistant(messages, d.assistantMessageID, (m) => updateLatest(m, isTool(d.id), (p) => (
        p.state?.status === 'streaming' ? { ...p, state: { ...p.state, input: (p.state.input || '') + d.delta } } : p
      )));
    case 'session.tool.input.ended':
      return updateAssistant(messages, d.assistantMessageID, (m) => updateLatest(m, isTool(d.id), (p) => (
        p.state?.status === 'streaming' ? { ...p, state: { ...p.state, input: d.text } } : p
      )));
    case 'session.tool.called':
      return updateAssistant(messages, d.assistantMessageID, (m) => {
        // A provider-executed tool may arrive without an input.started.
        if (latestIndex(m.content, isTool(d.id)) < 0) {
          m.content.push({ type: 'tool', id: d.id, name: d.name || 'tool', time: { created: now }, state: { status: 'streaming', input: '' } });
        }
        return updateLatest(m, isTool(d.id), (p) => ({
          ...p, executed: d.executed, time: { ...(p.time || {}), ran: now },
          state: { status: 'running', input: d.input || {}, metadata: {} },
        }));
      });
    case 'session.tool.progress':
      return updateAssistant(messages, d.assistantMessageID, (m) => updateLatest(m, isTool(d.id), (p) => (
        p.state?.status === 'running' ? { ...p, state: { ...p.state, metadata: d.metadata || {} } } : p
      )));
    case 'session.tool.success':
      return updateAssistant(messages, d.assistantMessageID, (m) => updateLatest(m, isTool(d.id), (p) => ({
        ...p, time: { ...(p.time || {}), completed: now },
        state: {
          status: 'completed',
          input: p.state?.input && typeof p.state.input === 'object' ? p.state.input : {},
          content: d.content || [],
          ...(d.metadata === undefined ? {} : { metadata: d.metadata }),
        },
      })));
    case 'session.tool.failed':
      return updateAssistant(messages, d.assistantMessageID, (m) => updateLatest(m, isTool(d.id), (p) => ({
        ...p, time: { ...(p.time || {}), completed: now },
        state: {
          status: 'error',
          input: p.state?.input && typeof p.state.input === 'object' ? p.state.input : {},
          error: d.error,
          ...(d.content ? { content: d.content } : {}),
          ...(d.metadata === undefined ? {} : { metadata: d.metadata }),
        },
      })));
    case 'session.message.content.updated':
      return updateAssistant(messages, d.messageID, (m) => ({ ...m, content: d.content || [] }));
    default:
      return messages;
  }
}

// The text of a tool's content parts (Tool.TextContent), joined.
export function toolText(content) {
  if (!Array.isArray(content)) return '';
  return content.filter((c) => c && c.type === 'text').map((c) => c.text).join('\n');
}

// A short one-line summary of a tool call's input for its card header.
export function toolSummary(name, input) {
  if (!input || typeof input !== 'object') return typeof input === 'string' ? input.slice(0, 120) : '';
  const pick = input.filePath || input.file_path || input.notebook_path || input.path || input.file || input.command || input.pattern || input.url || input.query || input.description;
  if (typeof pick === 'string') return pick;
  const first = Object.values(input).find((v) => typeof v === 'string');
  return first ? first.slice(0, 120) : '';
}

// Whether the conversation's last assistant turn is still being produced
// (used before any execution.* event has been seen).
export function lastAssistantRunning(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.type === 'assistant') return !m.time?.completed && !m.error;
    if (m.type === 'user') return false;
  }
  return false;
}
