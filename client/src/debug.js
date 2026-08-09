// Debug logging for session lifecycle issues (device switching, reconnects,
// attach/detach races). Everything is off unless enabled:
//   - URL query:  ?debug=1
//   - localStorage key 'ccserver-debug' set to '1'
// The Setting panel can call setDebugEnabled() to toggle it in-place.

const KEY = 'ccserver-debug';

function initialEnabled() {
  try {
    if (new URLSearchParams(window.location.search).has('debug')) return true;
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

let enabled = initialEnabled();

export function setDebugEnabled(on) {
  enabled = !!on;
  try {
    if (enabled) localStorage.setItem(KEY, '1');
    else localStorage.removeItem(KEY);
  } catch { /* storage unavailable */ }
  if (enabled) console.log('[ccserver] debug logging enabled');
}

export function isDebugEnabled() {
  return enabled;
}

// Log a lifecycle event with a stable prefix; objects are serialized so the
// message stays a single line in the console.
export function dbg(...args) {
  if (!enabled) return;
  console.log('[ccserver]', ...args.map((a) => (typeof a === 'object' && a !== null ? JSON.stringify(a) : a)));
}
