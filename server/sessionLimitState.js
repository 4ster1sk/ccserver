// Process-global "most recently known session-limit reset time" -- a passive
// cache fed by two independent sources (usage.js's /usage capture and
// sessionLimitDetect.js's PTY-output detector), consumed by the scheduler
// panel's default-time hint. Never triggers a capture itself.
let latest = null; // { resetAtMs, timeZone, source, updatedAt } | null

export function recordSessionLimitReset({ resetAtMs, timeZone = null, source }) {
  if (!Number.isFinite(resetAtMs)) return;
  latest = { resetAtMs, timeZone, source, updatedAt: Date.now() };
}

// Returns null once the recorded time is in the past (a stale detection
// should not keep suggesting an already-passed time).
export function getLatestSessionLimitReset() {
  if (!latest || latest.resetAtMs <= Date.now()) return null;
  return latest;
}
