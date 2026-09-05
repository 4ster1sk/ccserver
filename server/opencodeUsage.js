// Background "OpenCode Go usage" reader. Unlike Claude (screen-scraped
// `/usage` via `--ax-screen-reader`, see server/usage.js) and Codex
// (`codex app-server` JSON-RPC, see server/codexUsage.js), Go exposes an
// official HTTPS quota endpoint: GET https://opencode.ai/zen/go/v1/usage
// with the Go API key as `Authorization: Bearer`, returning
// `{ usage: { rolling, weekly, monthly } }` where each window carries
// `status` ("ok" | "rate-limited"), `percent` (used, dashboard semantics)
// and an ISO `resetsAt`. No pty, no CLI spawn, no sandbox involved -- just
// one HTTPS request authenticated with the key opencode itself stores.
// Reading quota makes no billable call, so this does not consume usage.
//
// An opencode CLI install alone says nothing about a Go subscription, so
// visibility is gated in three layers (see the plan in AGENTS.md context):
//   1. toggle: `opencodeGoUsage` in sandbox.config.json (default on;
//      `CCSERVER_OPENCODE_GO_USAGE` env wins). false disables everything --
//      no key is read, no request is sent.
//   2. key presence: the "opencode-go" entry of
//      ~/.local/share/opencode/auth.json (or OPENCODE_AUTH_CONTENT).
//      Synchronous and network-free, so GET /api/dirs/home can report it.
//   3. subscription validity: a 403 from the endpoint means "no Go
//      subscription on this key" and surfaces as an in-popover message
//      (not a silent hide) so the cause is visible.
//
// The mapped result uses the same shape parseUsage()/mapRateLimits()
// produce, so UsageButton.jsx needs no app-specific rendering logic.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadSandboxConfig, isAppHidden } from './ws/sandbox.js';

const CACHE_TTL_MS = 60 * 1000;        // serve cache without re-fetching
const FETCH_TIMEOUT_MS = 10 * 1000;    // hard cap on a single fetch
const USAGE_URL = 'https://opencode.ai/zen/go/v1/usage';
const AUTH_PROVIDER_ID = 'opencode-go';

let cache = null;      // { usage, updatedAt }
let inflight = null;   // Promise<fetchResult> while a fetch is running

// Layer 1: the config toggle (default on; env override handled inside
// loadSandboxConfig -- see ws/sandbox.js's opencodeGoUsage). Accepts an
// already-loaded config so callers that need multiple fields (e.g. GET
// /dirs/home) don't read sandbox.config.json twice.
export function opencodeGoEnabled(cfg = loadSandboxConfig()) {
  return cfg.opencodeGoUsage !== false;
}

function authFilePath() {
  const dataHome = process.env.XDG_DATA_HOME && process.env.XDG_DATA_HOME.trim() !== ''
    ? process.env.XDG_DATA_HOME
    : join(homedir(), '.local', 'share');
  return join(dataHome, 'opencode', 'auth.json');
}

// Pull the Go API key out of an auth.json-shaped object ({ providerId:
// { type: 'api', key } }). Returns the key string or null. Pure (no I/O),
// so tests can cover the shape without touching the real file.
export function extractGoKey(authObj) {
  if (!authObj || typeof authObj !== 'object') return null;
  const entry = authObj[AUTH_PROVIDER_ID];
  if (!entry || typeof entry !== 'object') return null;
  if (entry.type !== 'api') return null;
  return typeof entry.key === 'string' && entry.key.length > 0 ? entry.key : null;
}

function readAuthFile() {
  try {
    return JSON.parse(readFileSync(authFilePath(), 'utf-8'));
  } catch {
    return null;
  }
}

// Resolve the Go API key, or null when absent. OPENCODE_AUTH_CONTENT (the
// same override opencode's own Auth layer honors) wins over auth.json.
// The key value itself is never logged and never sent to the client -- it
// only leaves the process as the Bearer credential to the canonical usage
// endpoint below.
export function readOpencodeGoKey() {
  const fromEnv = process.env.OPENCODE_AUTH_CONTENT;
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') {
    try {
      const key = extractGoKey(JSON.parse(fromEnv));
      if (key) return key;
    } catch {
      // fall through to auth.json
    }
  }
  return extractGoKey(readAuthFile());
}

// Layer 2: synchronous, network-free availability for GET /api/dirs/home
// (toggle on AND a key exists). Subscription validity (layer 3, the 403
// case) is only known after a fetch, so it is handled at fetch time.
// hiddenApps (issue #105) wins over both: a hidden app must never read as
// "available" in the picker just because a key happens to exist.
export function opencodeGoAvailable(cfg = loadSandboxConfig()) {
  if (isAppHidden('opencode')) return false;
  return opencodeGoEnabled(cfg) && readOpencodeGoKey() != null;
}

function formatResets(resetAtMs) {
  if (resetAtMs == null) return null;
  const d = new Date(resetAtMs);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// Window descriptors: rolling = the 5-hour limit, weekly = 7d. monthly
// anchors on the subscription anniversary (not a fixed span), so it
// deliberately carries no windowMs -- UsageButton's pace marker then
// hides itself for that row (same as a null resetAt).
const WINDOWS = [
  { key: 'rolling', label: '5時間', windowMs: 5 * 3600 * 1000 },
  { key: 'weekly', label: '週次', windowMs: 7 * 24 * 3600 * 1000 },
  { key: 'monthly', label: '月次', windowMs: null },
];

function mapWindow(raw, { label, windowMs }) {
  if (!raw || typeof raw !== 'object') return null;
  const { percent, status, resetsAt } = raw;
  // No upper bound: a rate-limited window can legitimately report over 100%
  // (e.g. 104%), and that's a normal state to surface, not a malformed
  // payload -- rejecting it here used to discard the whole fetch (see
  // getOpencodeUsage's WINDOWS.length check), hiding two otherwise-valid
  // windows along with it. UsageButton.jsx already clamps the bar width.
  if (typeof percent !== 'number' || !Number.isFinite(percent) || percent < 0) return null;
  if (status !== 'ok' && status !== 'rate-limited') return null;
  const resetAt = typeof resetsAt === 'string' ? Date.parse(resetsAt) : NaN;
  if (!Number.isFinite(resetAt)) return null;
  return { label, pct: percent, resets: formatResets(resetAt), resetAt, windowMs };
}

// Turn a `{ usage: { rolling, weekly, monthly } }` payload into the shared
// `{ limits, cost, plan }` shape. Malformed windows are skipped; callers
// treat an incomplete set as a failed fetch (no partial cache overwrite).
export function mapGoUsage(payload) {
  const usage = payload && typeof payload === 'object' ? payload.usage : null;
  if (!usage || typeof usage !== 'object') return { limits: [], cost: null, plan: null };
  const limits = [];
  for (const w of WINDOWS) {
    const mapped = mapWindow(usage[w.key], w);
    if (mapped) limits.push(mapped);
  }
  return { limits, cost: null, plan: limits.length ? 'OpenCode Go' : null };
}

async function fetchOnce(key) {
  let res;
  try {
    res = await fetch(USAGE_URL, {
      headers: { accept: 'application/json', authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    return { error: `Could not reach opencode.ai: ${err?.message || err}` };
  }
  if (res.status === 401) {
    return { error: 'Invalid opencode Go API key (rejected by opencode.ai)' };
  }
  if (res.status === 403) {
    return { error: 'No OpenCode Go subscription on this key' };
  }
  if (!res.ok) {
    return { error: `opencode.ai returned HTTP ${res.status}` };
  }
  let payload;
  try {
    payload = await res.json();
  } catch {
    return { error: 'Could not parse the opencode Go usage response' };
  }
  const mapped = mapGoUsage(payload);
  if (!mapped.limits.length || mapped.limits.length !== WINDOWS.length) {
    return { error: 'Could not parse the opencode Go usage response' };
  }
  return { usage: mapped };
}

function capture() {
  // hiddenApps (issue #105) first, same guard usage.js/codexUsage.js apply
  // for claude/codex: an operator who hasn't contracted for opencode must
  // never have this reach out to opencode.ai, regardless of toggle/key.
  if (isAppHidden('opencode')) {
    return Promise.resolve({ error: 'opencode is hidden on this server (sandbox.config.json\'s "hiddenApps")' });
  }
  // Layer 1 next: disabled means no key read and no request at all.
  if (!opencodeGoEnabled()) {
    return Promise.resolve({ error: 'opencode Go usage is disabled by config (opencodeGoUsage: false)' });
  }
  const key = readOpencodeGoKey();
  if (!key) {
    return Promise.resolve({ error: 'opencode Go API key not found (run /connect in opencode and sign in to OpenCode Go)' });
  }
  return fetchOnce(key);
}

// Return the latest OpenCode Go usage, fetching if the cache is
// missing/stale (or forced). Concurrent callers share one in-flight fetch.
export async function getOpencodeUsage({ force = false } = {}) {
  const fresh = cache && Date.now() - cache.updatedAt < CACHE_TTL_MS;
  if (!force && fresh) {
    return { usage: cache.usage, updatedAt: cache.updatedAt, cached: true };
  }

  if (!inflight) {
    inflight = capture()
      .then((res) => {
        inflight = null;
        if (res.usage && res.usage.limits && res.usage.limits.length) {
          cache = { usage: res.usage, updatedAt: Date.now() };
        }
        return res;
      })
      .catch((err) => {
        inflight = null;
        return { error: String(err?.message || err) };
      });
  }

  const res = await inflight;

  if (res.usage && res.usage.limits && res.usage.limits.length) {
    return {
      usage: res.usage,
      updatedAt: cache ? cache.updatedAt : Date.now(),
      cached: false,
    };
  }

  // Fetch failed; fall back to a stale cache if we have one.
  if (cache) {
    return { usage: cache.usage, updatedAt: cache.updatedAt, cached: true, error: res.error };
  }
  return { usage: null, error: res.error || 'Could not read opencode Go usage' };
}

// Best-effort cache warm at server startup so the first click is instant.
// Skips entirely when disabled or keyless (no pointless external request).
export function warmOpencodeUsage() {
  if (!opencodeGoAvailable()) return;
  getOpencodeUsage({ force: true }).catch(() => { /* best effort */ });
}
