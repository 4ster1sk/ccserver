import { createContext, useContext, useMemo } from 'react';
import { useCommitSigningStatus } from '../hooks/useCommitSigningStatus.js';

// Mounted once near the App.jsx root so the top bar, the approval banner and
// every session badge share one poller.
const CommitSigningStatusContext = createContext(null);

export function CommitSigningStatusProvider({ children }) {
  const status = useCommitSigningStatus();
  const value = useMemo(() => status, [status.data, status.error]);
  return (
    <CommitSigningStatusContext.Provider value={value}>
      {children}
    </CommitSigningStatusContext.Provider>
  );
}

export function useCommitSigningStatusContext() {
  return useContext(CommitSigningStatusContext);
}
