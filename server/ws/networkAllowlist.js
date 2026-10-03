// Read/write boundary for the network-isolation settings in
// sandbox.config.json (`network.mode` / `network.allowedHosts` /
// `network.deniedHosts`), backing
// the Settings GUI tab and its auto-apply to running sessions. Parsing is
// shared with loadSandboxConfig()'s network parsing in sandbox.js via
// normalizeNetworkSettings below, so the GUI cannot show
// something the launcher resolves differently.
//
// The file is read fresh on every call (same as loadSandboxConfig -- no
// cache), so a successful update governs the next launch with no reload.
// `//` comment keys survive read-modify-write untouched (they are plain JSON
// string keys); only formatting normalizes to 2-space + trailing newline.

import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { resolvePath, PATH_IDS, configRoot } from '../paths.js';

// --- host matching + allow-list normalization (pure, no I/O) ----------------
// Single home for the exact-or-leading-dot host syntax, shared by the config
// store below, loadSandboxConfig() (sandbox.js), and the qemu backend's Go
// broker (ccserver-netbroker; testdata/host-policy.json is copied in both
// repositories and pins the same semantics so the two cannot drift).

// True when `host` matches an entry in `list`: either an exact
// hostname, or (for an entry starting with '.') that suffix domain or any of
// its subdomains. Pure, case-insensitive, no I/O -- the enforcement decision
// itself, testable without spinning up the real proxy server. Port is
// deliberately not part of matching: CONNECT for HTTPS is always :443 in
// practice, and over-scoping to specific ports adds surface for no benefit.
// Shared by the allow-list and the deny-list (deniedHosts): both use the
// exact-or-leading-dot syntax.
export function isHostMatched(host, list) {
  if (typeof host !== 'string' || !host) return false;
  const h = host.toLowerCase();
  for (const entry of list || []) {
    if (typeof entry !== 'string' || !entry) continue;
    const e = entry.toLowerCase();
    if (e.startsWith('.')) {
      const suffix = e.slice(1);
      if (h === suffix || h.endsWith(e)) return true;
    } else if (h === e) {
      return true;
    }
  }
  return false;
}

export function isHostAllowed(host, allowedHosts) {
  return isHostMatched(host, allowedHosts);
}

// Deny-list match: same syntax as the allow-list. A match here always wins
// over the allow-list, the live open state, and audit mode.
export function isHostDenied(host, deniedHosts) {
  return isHostMatched(host, deniedHosts);
}

// Canonical allow-list entry validation/normalization, shared by the config
// store below and the Go broker's policy fixtures so the file and a running
// broker can never disagree on what an entry means.
// Accepts what isHostAllowed can match: an exact hostname or a leading-dot
// suffix (`.example.com` covers the domain and its subdomains). Anything
// else (schemes, ports, wildcards, whitespace, IPv6 literals) is rejected:
// the broker matches CONNECT hostnames only, so such entries could never
// match and would be dead data. Returns { hosts, rejected }: `hosts` is
// trimmed, lowercased and deduplicated; `rejected` holds the raw inputs that
// failed, for 400 responses.
export function normalizeAllowedHosts(entries) {
  const hosts = [];
  const rejected = [];
  const seen = new Set();
  // One DNS label: alphanumerics + interior hyphens. Dots separate labels;
  // a single leading dot marks a suffix entry (its remainder must itself be
  // a valid hostname).
  const LABEL = '[a-z0-9](?:[a-z0-9-]*[a-z0-9])?';
  const HOSTNAME_RE = new RegExp(`^${LABEL}(?:\\.${LABEL})*$`);
  for (const raw of Array.isArray(entries) ? entries : []) {
    if (typeof raw !== 'string') { rejected.push(raw); continue; }
    const e = raw.trim().toLowerCase();
    const body = e.startsWith('.') ? e.slice(1) : e;
    if (!e || e.length > 253 || !HOSTNAME_RE.test(body)) { rejected.push(raw); continue; }
    if (seen.has(e)) continue;
    seen.add(e);
    hosts.push(e);
  }
  return { hosts, rejected };
}

export const MAX_ALLOWED_HOSTS = 200;

// Canonical parse of the `network` key of sandbox.config.json into the
// shape both loadSandboxConfig() (sandbox.js, what a launch actually
// applies) and getNetworkSettings() (below, what the Settings
// GUI shows/saves) need (the broker always starts 'open', so there is no
// starting-state key; legacy isolate/initialState keys are ignored): mode
// is operator-only ('audit'
// never blocks a non-denied host, but deniedHosts still blocks even in
// audit); allowedHosts/deniedHosts use the same exact-or-leading-dot syntax
// and are only filtered to strings here (full validation/normalization on
// write is normalizeAllowedHosts above -- this parse just mirrors what's
// already on disk). Both call sites used to hand-duplicate this parse, kept
// in sync only by a comment claiming they mirrored each other; extracted
// here so they structurally cannot drift again.
export function normalizeNetworkSettings(rawNetwork) {
  const net = (rawNetwork && typeof rawNetwork === 'object' && !Array.isArray(rawNetwork)) ? rawNetwork : {};
  return {
    mode: net.mode === 'audit' ? 'audit' : 'enforce',
    allowedHosts: Array.isArray(net.allowedHosts)
      ? net.allowedHosts.filter((h) => typeof h === 'string' && h)
      : [],
    deniedHosts: Array.isArray(net.deniedHosts)
      ? net.deniedHosts.filter((h) => typeof h === 'string' && h)
      : [],
  };
}

export function resolveSandboxConfigPath() {
  return resolvePath(PATH_IDS.sandboxConfig);
}

// Atomic whole-file replace (attacker review F2). A plain writeFileSync
// truncates first, so a crash or ENOSPC mid-write leaves a partial JSON
// document behind -- and server/index.js refuses to BOOT on a config it cannot
// parse ("Refusing to start"). Writing to a sibling temp file and renaming
// makes the swap a single atomic operation: a reader sees either the old
// document or the new one, never half of one.
//
// The temp file is a sibling (same directory) so the rename cannot cross a
// filesystem boundary, and 0600 because this file holds the Discord webhook
// URL and, historically, API tokens.
//
// Shared by every writer of sandbox.config.json -- currently the network
// settings below and notifyBridgeSettings.js -- so the two cannot drift into
// one being atomic and the other not.
export function writeSandboxConfigAtomic(next) {
  const target = resolveSandboxConfigPath();
  const tmp = `${target}.tmp-${process.pid}`;
  // ccserver's own config directory does not exist yet on a host that has not
  // run the setup wizard (issue #201 R8), and the temp write below would fail
  // with ENOENT on its parent. The reader already treats a missing file as
  // {}, so the first Settings save should create the directory rather than
  // report a failure. This lives in the shared writer rather than at a call
  // site because every writer of the file goes through here.
  //
  // Scoped to OUR directory deliberately. When the operator has pointed
  // CCSERVER_SANDBOX_CONFIG elsewhere, a missing parent is a typo in that
  // value, and silently building a tree for it would turn a loud, correctable
  // mistake into a config written where nobody will look for it. That case
  // still fails, which is what 'a write that cannot land is reported, not
  // half-applied' pins.
  if (dirname(target) === configRoot()) {
    mkdirSync(configRoot(), { recursive: true, mode: 0o700 });
  }
  try {
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, target);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* nothing to clean up */ }
    throw err;
  }
}

function readRawConfig() {
  try {
    return { raw: JSON.parse(readFileSync(resolveSandboxConfigPath(), 'utf-8')), corrupt: false };
  } catch (err) {
    if (err?.code === 'ENOENT') return { raw: {}, corrupt: false };
    return { raw: null, corrupt: true };
  }
}

// Effective network settings exactly as loadSandboxConfig() resolves them
// (operator-only enforce/audit mode; string-only lists). deniedHosts uses the same syntax as allowedHosts but always wins:
// a denied host is blocked even in live open state and in audit mode. Parse
// is shared with loadSandboxConfig() (sandbox.js) via
// normalizeNetworkSettings above so the two structurally cannot drift apart.
export function getNetworkSettings() {
  const { raw } = readRawConfig();
  return normalizeNetworkSettings(raw && typeof raw === 'object' ? raw.network : undefined);
}

// Partial update: only keys present in `patch` change; everything else in the
// file (all other features' keys included) is preserved byte-for-byte in
// value. Returns { ok:true, settings } or { ok:false, code, message } with
// codes 'validation' | 'internal'.
export function updateNetworkSettings(patch = {}) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return { ok: false, code: 'validation', message: 'patch must be an object' };
  }
  const { raw, corrupt } = readRawConfig();
  if (corrupt) {
    return {
      ok: false,
      code: 'internal',
      message: `sandbox config is not valid JSON, refusing to overwrite it (${resolveSandboxConfigPath()}); fix it by hand first`,
    };
  }
  const next = { ...raw };
  const net = (next.network && typeof next.network === 'object' && !Array.isArray(next.network))
    ? { ...next.network }
    : {};
  if (patch.mode !== undefined) {
    if (patch.mode !== 'enforce' && patch.mode !== 'audit') {
      return { ok: false, code: 'validation', message: 'mode must be "enforce" or "audit"' };
    }
    net.mode = patch.mode;
  }
  if (patch.allowedHosts !== undefined) {
    if (!Array.isArray(patch.allowedHosts)) {
      return { ok: false, code: 'validation', message: 'allowedHosts must be an array of hostnames' };
    }
    const { hosts, rejected } = normalizeAllowedHosts(patch.allowedHosts);
    if (rejected.length > 0) {
      return {
        ok: false,
        code: 'validation',
        message: `invalid allow-list entries: ${rejected.slice(0, 5).map((r) => JSON.stringify(r)).join(', ')}${rejected.length > 5 ? ` (+${rejected.length - 5} more)` : ''} (exact hostname or leading-dot suffix, no scheme/port/wildcard)`,
      };
    }
    if (hosts.length > MAX_ALLOWED_HOSTS) {
      return { ok: false, code: 'validation', message: `allowedHosts exceeds ${MAX_ALLOWED_HOSTS} entries` };
    }
    net.allowedHosts = hosts;
  }
  if (patch.deniedHosts !== undefined) {
    if (!Array.isArray(patch.deniedHosts)) {
      return { ok: false, code: 'validation', message: 'deniedHosts must be an array of hostnames' };
    }
    const { hosts, rejected } = normalizeAllowedHosts(patch.deniedHosts);
    if (rejected.length > 0) {
      return {
        ok: false,
        code: 'validation',
        message: `invalid deny-list entries: ${rejected.slice(0, 5).map((r) => JSON.stringify(r)).join(', ')}${rejected.length > 5 ? ` (+${rejected.length - 5} more)` : ''} (exact hostname or leading-dot suffix, no scheme/port/wildcard)`,
      };
    }
    if (hosts.length > MAX_ALLOWED_HOSTS) {
      return { ok: false, code: 'validation', message: `deniedHosts exceeds ${MAX_ALLOWED_HOSTS} entries` };
    }
    net.deniedHosts = hosts;
  }
  next.network = net;
  try {
    writeSandboxConfigAtomic(next);
  } catch (err) {
    return { ok: false, code: 'internal', message: `failed to write sandbox config: ${err.message}` };
  }
  return { ok: true, settings: getNetworkSettings() };
}
