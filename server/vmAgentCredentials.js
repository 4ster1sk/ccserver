// Credentials the qemu backend's network broker injects for agents in a VM
// (see ws/qemuAgents.js). Kept in the settings DB, which no sandbox can
// see. The value is write-only over the API: the Settings GUI only learns
// whether one is set.
//
// claudeOAuthToken: a long-lived token from `claude setup-token` (run on
// the host). Its value never changes until it is replaced, which is what the
// broker's startup-time inject needs.
//
// opencodeApiKeys: { [providerId]: key }, an API key per opencode provider.
// Where each goes (API host, header) is worked out at launch
// (qemuAgents.js resolveOpencodeProviders).

import { getSetting, setSetting, deleteSetting } from './settingsStore.js';

const CLAUDE_KEY = ['global', '', 'qemu.agentAuth.claudeOAuthToken'];
const CLAUDE_TOKEN_RE = /^sk-ant-oat01-[A-Za-z0-9_-]{20,}$/;
const OPENCODE_KEY = ['global', '', 'qemu.agentAuth.opencodeApiKeys'];
const OPENCODE_PROVIDER_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const OPENCODE_KEY_MAX = 4096;

export class VmAgentCredentialError extends Error {}

function opencodeApiKeys() {
  const v = getSetting(...OPENCODE_KEY, null);
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  return Object.fromEntries(Object.entries(v).filter(([id, k]) => OPENCODE_PROVIDER_RE.test(id) && typeof k === 'string' && k));
}

export function getVmAgentCredentials() {
  const t = getSetting(...CLAUDE_KEY, null);
  return { claudeOAuthToken: typeof t === 'string' && t ? t : null, opencodeApiKeys: opencodeApiKeys() };
}

export function vmAgentCredentialStatus() {
  const { claudeOAuthToken, opencodeApiKeys: keys } = getVmAgentCredentials();
  return { claude: claudeOAuthToken !== null, opencode: Object.keys(keys).sort() };
}

// token: a string to set, or null to clear.
export function setClaudeOAuthToken(token) {
  if (token === null) {
    deleteSetting(...CLAUDE_KEY);
    return;
  }
  const t = typeof token === 'string' ? token.trim() : '';
  if (!CLAUDE_TOKEN_RE.test(t)) {
    throw new VmAgentCredentialError('not a Claude OAuth token (expected the sk-ant-oat01-... value printed by `claude setup-token`)');
  }
  setSetting(...CLAUDE_KEY, t);
}

// providerId: the opencode provider id (as in its config / auth.json).
// key: a string to set, or null to clear.
export function setOpencodeApiKey(providerId, key) {
  if (typeof providerId !== 'string' || !OPENCODE_PROVIDER_RE.test(providerId)) {
    throw new VmAgentCredentialError('not an opencode provider id (letters, digits, ".", "_" and "-")');
  }
  const keys = opencodeApiKeys();
  if (key === null) {
    delete keys[providerId];
  } else {
    const k = typeof key === 'string' ? key.trim() : '';
    // eslint-disable-next-line no-control-regex
    if (!k || k.length > OPENCODE_KEY_MAX || /[\x00-\x20\x7f]/.test(k)) {
      throw new VmAgentCredentialError('not an API key (expected a single non-empty value without spaces)');
    }
    keys[providerId] = k;
  }
  if (Object.keys(keys).length) setSetting(...OPENCODE_KEY, keys);
  else deleteSetting(...OPENCODE_KEY);
}
