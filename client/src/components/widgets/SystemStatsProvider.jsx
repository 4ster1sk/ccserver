import { createContext, useContext, useMemo } from 'react';
import { useSystemStats } from './useSystemStats.js';

const SystemStatsContext = createContext(null);

export function SystemStatsProvider({ active, children }) {
  const stats = useSystemStats(active);
  const value = useMemo(() => stats, [stats.data, stats.error, stats.interval, stats.showIpmi]);
  return (
    <SystemStatsContext.Provider value={value}>
      {children}
    </SystemStatsContext.Provider>
  );
}

export function useSystemStatsContext() {
  return useContext(SystemStatsContext);
}
