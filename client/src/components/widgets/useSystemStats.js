import { useState, useEffect, useRef, useCallback } from 'react';
import { authFetch } from '../../auth.js';

const DEFAULT_INTERVAL = 2000;
const MIN_INTERVAL = 1000;

// localStorage の不正値 (NaN・0・負数・1秒未満) を弾き、
// 常に [MIN_INTERVAL, ∞) の有限値に正規化する。
function normalizeInterval(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_INTERVAL;
  return Math.max(MIN_INTERVAL, Math.floor(n));
}

export function useSystemStats(active) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [interval, setIntervalMs] = useState(() => {
    const saved = localStorage.getItem('monitor-interval');
    return saved ? normalizeInterval(saved) : DEFAULT_INTERVAL;
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
    const normalized = normalizeInterval(v);
    setIntervalMs(normalized);
    localStorage.setItem('monitor-interval', normalized);
  }, []);

  const setShowIpmiAndSave = useCallback((v) => {
    setShowIpmi(v);
    localStorage.setItem('monitor-show-ipmi', v);
  }, []);

  return { data, error, interval, setInterval: setIntervalAndSave, showIpmi, setShowIpmi: setShowIpmiAndSave, refresh: fetchStats };
}
