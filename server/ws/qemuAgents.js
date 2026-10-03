// The agent CLIs (claude / opencode / codex) inside a qemu-backend VM.
//
// Install: the golden image carries no agent. The host's own install is
// shared read-only (virtiofs) at /opt/ccs-agent/<app>, so the VM runs the
// same version as the host with nothing downloaded. Updating is the host's
// job; the CLIs' own updaters are turned off in the VM (the share is ro).
//
// Credentials: no secret enters the VM. The guest gets a placeholder, and
// the VM's network broker (ccserver-netbroker `inject`, MITM only) sets the
// real header on requests to the agent's API host. The secret lives in the
// broker's environment only -- not in its config file, the VM plan, the
// cloud-init seed or the guest env. Only credentials that never change are
// handled here (the broker sets `inject` values at startup):
//   claude:   a long-lived OAuth token from `claude setup-token`, stored in
//             ccserver's settings DB (vmAgentCredentials.js)
//   opencode: an API key per provider, stored in the same DB. The API host
//             and header come from the host's opencode config (its provider
//             section) or a built-in table; the guest gets that provider
//             section with a placeholder apiKey (OPENCODE_CONFIG_CONTENT).
// Rotating logins (claude's own .credentials.json, codex's ChatGPT login,
// opencode's OAuth providers) need a broker that can replace an injected
// value live; not yet.
//
// The host's agent config dirs (~/.claude etc., agentConfigDirs) are NOT
// shared with the VM as bwrap does: a VM writing ~/.claude/settings.json
// hooks would run code on the host.

import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';

export const GUEST_AGENT_ROOT = '/opt/ccs-agent';

// What the guest sees in CLAUDE_CODE_OAUTH_TOKEN. The broker replaces the
// Authorization header it produces.
export const CLAUDE_TOKEN_PLACEHOLDER = 'sk-ant-oat01-ccserver-vm-placeholder';
const CLAUDE_TOKEN_ENV = 'CCS_INJECT_CLAUDE_OAUTH';
// The hosts claude sends its OAuth bearer to (api calls, and the claude.ai
// MCP connectors' proxy).
const CLAUDE_TOKEN_HOSTS = ['api.anthropic.com', 'mcp-proxy.anthropic.com'];

// What the guest's opencode sends as each registered provider's apiKey. The
// broker replaces the header it produces.
export const OPENCODE_KEY_PLACEHOLDER = 'ccserver-vm-placeholder';
const OPENCODE_KEY_ENV = 'CCS_INJECT_OPENCODE_';

// The header an opencode provider's SDK package sends its key in.
const OPENCODE_NPM_HEADERS = {
  '@ai-sdk/openai-compatible': { header: 'Authorization', format: 'Bearer {}' },
  '@ai-sdk/openai': { header: 'Authorization', format: 'Bearer {}' },
  '@openrouter/ai-sdk-provider': { header: 'Authorization', format: 'Bearer {}' },
  '@ai-sdk/anthropic': { header: 'x-api-key', format: '{}' },
};
// Built-in providers (models.dev) a host config need not define.
const OPENCODE_BUILTIN_PROVIDERS = {
  opencode: { npm: '@ai-sdk/openai-compatible', baseURL: 'https://opencode.ai/zen/v1' },
  'opencode-go': { npm: '@ai-sdk/openai-compatible', baseURL: 'https://opencode.ai/zen/go/v1' },
  openrouter: { npm: '@openrouter/ai-sdk-provider', baseURL: 'https://openrouter.ai/api/v1' },
  deepseek: { npm: '@ai-sdk/openai-compatible', baseURL: 'https://api.deepseek.com' },
  anthropic: { npm: '@ai-sdk/anthropic', baseURL: 'https://api.anthropic.com/v1' },
  openai: { npm: '@ai-sdk/openai', baseURL: 'https://api.openai.com/v1' },
};

// Per-app guest env and leading args: no self-update in the VM.
const AGENT_ENV = {
  claude: { DISABLE_AUTOUPDATER: '1' },
  opencode: { OPENCODE_DISABLE_AUTOUPDATE: '1' },
  codex: {},
};
const AGENT_ARGS = {
  claude: [],
  opencode: [],
  codex: ['-c', 'check_for_update_on_startup=false'],
};

export const VM_AGENT_APPS = Object.freeze(Object.keys(AGENT_ENV));

export class VmAgentError extends Error {}

function isWithin(child, parent) {
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : `${parent}${sep}`);
}

// A small text file on PATH is usually a shell wrapper; follow the
// absolute path it execs (same rule as sandbox.js appInstallDir).
function followWrapper(path) {
  try {
    const st = statSync(path);
    if (!st.isFile() || st.size >= 64 * 1024) return path;
    const text = readFileSync(path, 'utf-8');
    if (!text.startsWith('#!')) return path;
    const m = text.match(/\bexec\s+"?(\/[^\s"']+)"?/);
    if (!m) return path;
    try { return realpathSync(m[1]); } catch { return m[1]; }
  } catch {
    return path;
  }
}

// Which host dir to share for the agent binary at hostCommand, and the
// binary's path inside it: { hostDir, relBin }.
//
//   - inside a node_modules tree (npm installs): that node_modules dir, so
//     a package's platform binaries in sibling packages come along
//   - otherwise the binary's dir, or the parent of a trailing bin/ (sibling
//     assets). claude's native install resolves to
//     ~/.local/share/claude/versions/<ver>, so the whole versions/ dir is
//     shared and a host update needs no new share.
//
// Refuses a dir that is HOME (or above it) or that holds credentials.
export function resolveVmAgentInstall(hostCommand, { home, protectedPaths = [] }) {
  if (!hostCommand) throw new VmAgentError('not installed on the host');
  let real;
  try { real = realpathSync(hostCommand); } catch { throw new VmAgentError(`${hostCommand} does not exist`); }
  real = followWrapper(real);

  let hostDir;
  const nm = real.lastIndexOf(`${sep}node_modules${sep}`);
  if (nm >= 0) {
    hostDir = real.slice(0, nm + `${sep}node_modules`.length);
  } else {
    hostDir = dirname(real);
    const parent = dirname(hostDir);
    if (basename(hostDir) === 'bin' && !['/', '/usr', '/usr/local', home, dirname(home)].includes(parent)) hostDir = parent;
  }
  if (isWithin(home, hostDir)) throw new VmAgentError(`its install dir ${hostDir} contains HOME`);
  const leak = protectedPaths.find((p) => isWithin(p, hostDir));
  if (leak) throw new VmAgentError(`its install dir ${hostDir} contains ${leak}`);
  return { hostDir, relBin: relative(hostDir, real) };
}

export function guestAgentDir(app) {
  return `${GUEST_AGENT_ROOT}/${app}`;
}

// The guest argv for an agent launch: the shared binary, the app's fixed
// args, then the caller's args.
export function vmAgentArgv(app, relBin, args) {
  return [`${guestAgentDir(app)}/${relBin}`, ...AGENT_ARGS[app], ...args];
}

export function vmAgentEnv(app) {
  return { ...AGENT_ENV[app] };
}

// JSON with comments and trailing commas, as opencode's config files are.
// Only strips them (outside strings); anything else must be JSON.
export function parseJsonc(text) {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 2;
    } else {
      out += c;
      i++;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

// The provider section of the host's opencode config (later files win, as
// opencode merges them). An unreadable or broken file is skipped.
export function readOpencodeHostProviders(configDir) {
  const providers = {};
  for (const name of ['config.json', 'opencode.json', 'opencode.jsonc']) {
    let cfg;
    try { cfg = parseJsonc(readFileSync(join(configDir, name), 'utf-8')); } catch { continue; }
    const p = cfg && cfg.provider;
    if (!p || typeof p !== 'object' || Array.isArray(p)) continue;
    for (const [id, def] of Object.entries(p)) {
      if (def && typeof def === 'object' && !Array.isArray(def)) providers[id] = { ...providers[id], ...def, options: { ...providers[id]?.options, ...def.options } };
    }
  }
  return providers;
}

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

// A host provider definition made safe for the guest: no {env:...} /
// {file:...} references (host paths and secrets), no custom headers (may
// carry a literal secret), and the placeholder as apiKey.
function guestProviderEntry(def) {
  const clean = (v) => {
    if (typeof v === 'string') return /\{(env|file):/.test(v) ? undefined : v;
    if (Array.isArray(v)) return v.map(clean).filter((x) => x !== undefined);
    if (isPlainObject(v)) {
      const o = {};
      for (const [k, x] of Object.entries(v)) {
        const c = clean(x);
        if (c !== undefined) o[k] = c;
      }
      return o;
    }
    return v;
  };
  const entry = clean(def || {});
  const { headers, apiKey, ...options } = isPlainObject(entry.options) ? entry.options : {};
  return { ...entry, options: { ...options, apiKey: OPENCODE_KEY_PLACEHOLDER } };
}

// Where each registered opencode provider's key goes:
// [{ id, host, header, format, configEntry }]. A provider whose API host or
// key header cannot be worked out is left out and reported in `skipped`
// ([{ id, reason }]): the launch goes on without it.
export function resolveOpencodeProviders({ hostProviders = {}, providerIds = [] } = {}) {
  const providers = [];
  const skipped = [];
  for (const id of providerIds) {
    const def = isPlainObject(hostProviders[id]) ? hostProviders[id] : null;
    const builtin = OPENCODE_BUILTIN_PROVIDERS[id];
    const npm = def?.npm || builtin?.npm;
    const baseURL = (isPlainObject(def?.options) && def.options.baseURL) || builtin?.baseURL;
    if (!def && !builtin) { skipped.push({ id, reason: 'not in the host opencode config' }); continue; }
    const how = OPENCODE_NPM_HEADERS[npm];
    if (!how) { skipped.push({ id, reason: npm ? `its package ${npm} is not supported` : 'its package (npm) is not set' }); continue; }
    let host;
    try {
      const u = new URL(baseURL);
      if (u.protocol !== 'https:') throw new Error('not https');
      host = u.hostname;
    } catch {
      skipped.push({ id, reason: baseURL ? `its baseURL ${baseURL} is not an https URL` : 'it has no baseURL' });
      continue;
    }
    providers.push({ id, host, ...how, configEntry: guestProviderEntry(def || {}) });
  }
  return { providers, skipped };
}

// The broker inject entries and guest env for the credentials ccserver
// has, for every app (a persistent VM's broker serves all its sessions).
//
//   credentials: { claudeOAuthToken: string | null,
//                  opencodeApiKeys: { [providerId]: string } }
//   opencodeProviders: resolveOpencodeProviders()'s providers for the keys
//   advanced:    sandbox.config.json's network advanced keys (mitm, inject...)
//
// Returns { inject, brokerEnv, guestEnv, opencodeConfig, hosts, digest }:
//   inject:    merged with the operator's advanced.inject
//   brokerEnv: the broker process's extra env (holds the secrets)
//   guestEnv:  placeholders for the guest
//   opencodeConfig: { provider } for an opencode guest's
//              OPENCODE_CONFIG_CONTENT, or null
//   hosts:     the inject hosts (the launch allows them)
//   digest:    hash of the injected values, for the persistent VM pool key
// Throws when a credential is set but cannot be injected (MITM off, the
// operator already injects the same header on the same host, or two
// credentials need different values in one header on one host).
export function buildVmAgentAuth({ credentials = {}, opencodeProviders = [], advanced = {} } = {}) {
  const inject = [];
  const brokerEnv = {};
  const guestEnv = {};
  const hash = createHash('sha256');
  const same = (a, b) => a.host === b.host && String(a.header).toLowerCase() === String(b.header).toLowerCase();
  const token = credentials.claudeOAuthToken;
  if (token) {
    brokerEnv[CLAUDE_TOKEN_ENV] = token;
    for (const host of CLAUDE_TOKEN_HOSTS) {
      inject.push({ host, header: 'Authorization', valueFromEnv: CLAUDE_TOKEN_ENV, format: 'Bearer {}' });
    }
    guestEnv.CLAUDE_CODE_OAUTH_TOKEN = CLAUDE_TOKEN_PLACEHOLDER;
    hash.update(`claude\0${token}\0`);
  }
  const keys = credentials.opencodeApiKeys || {};
  let opencodeConfig = null;
  for (const p of opencodeProviders) {
    const key = keys[p.id];
    if (!key) continue;
    const entry = { host: p.host, header: p.header, format: p.format };
    const prior = inject.find((e) => same(e, entry));
    if (prior) {
      const priorValue = brokerEnv[prior.valueFromEnv];
      if (priorValue !== key || prior.format !== p.format) {
        throw new VmAgentError(`the opencode key for ${p.id} and another VM agent credential both set ${p.header} for ${p.host} with different values`);
      }
    } else {
      const env = `${OPENCODE_KEY_ENV}${Object.keys(brokerEnv).filter((k) => k.startsWith(OPENCODE_KEY_ENV)).length}`;
      brokerEnv[env] = key;
      inject.push({ ...entry, valueFromEnv: env });
    }
    opencodeConfig ??= { provider: {} };
    opencodeConfig.provider[p.id] = p.configEntry;
    hash.update(`opencode\0${p.id}\0${p.host}\0${p.header}\0${key}\0${JSON.stringify(p.configEntry)}\0`);
  }
  if (inject.length === 0) {
    return { inject: advanced.inject || null, brokerEnv, guestEnv, opencodeConfig: null, hosts: [], digest: null };
  }
  if (advanced.mitm && advanced.mitm.enabled === false) {
    throw new VmAgentError('the VM agent credentials need HTTPS interception, but network.mitm.enabled is false in sandbox.config.json');
  }
  const operator = Array.isArray(advanced.inject) ? advanced.inject : [];
  const clash = inject.find((e) => operator.some((o) => o && same(o, e)));
  if (clash) {
    throw new VmAgentError(`network.inject in sandbox.config.json already sets ${clash.header} for ${clash.host}, which the VM agent credentials also set`);
  }
  return {
    inject: [...operator, ...inject],
    brokerEnv,
    guestEnv,
    opencodeConfig,
    hosts: [...new Set(inject.map((e) => e.host))],
    digest: hash.digest('hex').slice(0, 16),
  };
}

// Host paths whose content must never be shared into the VM as part of an
// agent install.
export function credentialPaths(home, agentConfigDirs) {
  return [
    ...agentConfigDirs,
    join(home, '.ssh'), join(home, '.gnupg'), join(home, '.config', 'gh'),
  ];
}
