import { useState, useCallback, useRef } from 'react';
import { authFetch } from '../auth.js';
import { useVisiblePolling } from './useVisiblePolling.js';

// Polled status of the host commit signing key (GET /api/commit-signing/status),
// shared through CommitSigningStatusProvider.jsx by the top-bar unlock button,
// the approval banner and the per-session badges, so they all see one poll.
const POLL_MS = 8000;

export function useCommitSigningStatus() {
  // { toolsAvailable, configured, key, unlocked, needsPassphrase, error, passkeys: { available, enrolled } }
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const inflightRef = useRef(false);

  const refresh = useCallback(async () => {
    if (inflightRef.current) return;
    inflightRef.current = true;
    try {
      const res = await authFetch('/api/commit-signing/status');
      if (!res.ok) {
        setError(`HTTP ${res.status}`);
        return;
      }
      setData(await res.json());
      setError(null);
    } catch (err) {
      setError(err.message || '読み込みに失敗しました');
    } finally {
      inflightRef.current = false;
    }
  }, []);

  useVisiblePolling(refresh, POLL_MS);

  return { data, error, refresh };
}
