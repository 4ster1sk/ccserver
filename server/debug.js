// Server-side debug logging for session lifecycle issues (attach/detach
// races when the same session is opened from multiple devices). Off unless
// the server runs with CCSERVER_DEBUG=1.

const enabled = process.env.CCSERVER_DEBUG === '1';

export function dbg(...args) {
  if (!enabled) return;
  console.log('[ccserver]', ...args.map((a) => (typeof a === 'object' && a !== null ? JSON.stringify(a) : a)));
}
