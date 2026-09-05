import { useState, useEffect, useRef, useCallback } from 'react';
import { authFetch } from '../../auth.js';

export function useSystemStats(active) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [interval, setIntervalMs] = useState(() => {
    const saved = localStorage.getItem('monitor-interval');
    return saved ? Number(saved) : 2000;
  });
  const [showIpmi, setShowIpmi] = useState(() => {
    const saved = localStorage.getItem('monitor-show-ipmi');
    return saved !== null ? saved === 'true' : true;
  });
  const timerRef = useRef(null);
  const showIpmiRef = useRef(showIpmi);
  useEffect(() => { showIpmiRef.current = showIpmi; }, [showIpmi]);

  const fetchStats = useCallback(async () => {
    try {
      const params = showIpmiRef.current ? '?ipmi=1' : '';
      const res = await authFetch(`/api/system-stats${params}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setData(json);
      setError(null);
    } catch (e) {
      setError(e.message);
    }
  }, []);

  useEffect(() => {
    if (!active) {
      if (timerRef.current) clearInterval(timerRef.current);
      timerRef.current = null;
      return;
    }
    fetchStats();
    timerRef.current = setInterval(fetchStats, interval);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [active, interval, fetchStats]);

  const setIntervalAndSave = useCallback((v) => {
    setIntervalMs(v);
    localStorage.setItem('monitor-interval', v);
  }, []);

  const setShowIpmiAndSave = useCallback((v) => {
    setShowIpmi(v);
    localStorage.setItem('monitor-show-ipmi', v);
  }, []);

  return { data, error, interval, setInterval: setIntervalAndSave, showIpmi, setShowIpmi: setShowIpmiAndSave, refresh: fetchStats };
}
