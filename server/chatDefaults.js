// The model / effort a new chat-mode session starts with, per app: the last
// one picked in any chat session of that app (recorded by the server-side
// chat monitor on `session.model.selected`, see opencodeChat.js). Applied
// once, when initChatSession opens the conversation -- never on an attach,
// so a running session keeps whatever it is using.
//
// Stored in opencode's Model.Ref shape ({ providerID, id, variant? }; the
// variant is the effort), which is also what claude-chat-adapter serves.

import { getSetting, setSetting } from './settingsStore.js';

export const CHAT_DEFAULT_APPS = ['claude', 'opencode'];
const FIELD_MAX = 200;

function key(app) {
  return ['global', '', `chat.defaultModel.${app}`];
}

function field(v) {
  return typeof v === 'string' && v !== '' && v.length <= FIELD_MAX;
}

// A model ref, or null when it is not one.
export function normalizeChatModel(m) {
  if (!m || typeof m !== 'object') return null;
  if (!field(m.providerID) || !field(m.id)) return null;
  if (m.variant !== undefined && m.variant !== null && !field(m.variant)) return null;
  return { providerID: m.providerID, id: m.id, ...(m.variant ? { variant: m.variant } : {}) };
}

export function getChatDefaultModel(app) {
  if (!CHAT_DEFAULT_APPS.includes(app)) return null;
  return normalizeChatModel(getSetting(...key(app), null));
}

// Best effort: an invalid model or a failed write records nothing.
export function setChatDefaultModel(app, model) {
  if (!CHAT_DEFAULT_APPS.includes(app)) return false;
  const m = normalizeChatModel(model);
  if (!m) return false;
  try {
    setSetting(...key(app), m);
    return true;
  } catch (err) {
    console.warn(`[chat] could not record the default model for ${app}: ${err.message}`);
    return false;
  }
}
