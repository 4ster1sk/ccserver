import { useState, useEffect, useCallback, useRef } from 'react';
import { authFetch } from '../../auth.js';
import { isAppSelectable } from '../../appAvailability.js';

export function pctClass(pct) {
  if (pct >= 80) return 'usage-bar-fill high';
  if (pct >= 50) return 'usage-bar-fill mid';
  return 'usage-bar-fill low';
}

export function paceMark(l, now) {
  if (!l.resetAt || !l.windowMs) return null;
  const frac = 1 - (l.resetAt - now) / l.windowMs;
  return Math.max(0, Math.min(100, frac * 100));
}

export function fmtAge(updatedAt) {
  if (!updatedAt) return '';
  const s = Math.max(0, Math.round((Date.now() - updatedAt) / 1000));
  if (s < 60) return `${s}秒前`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}分前`;
  return `${Math.round(m / 60)}時間前`;
}

const USAGE_APP_KEY = 'ccserver-usage-app';

export function loadSavedUsageApp() {
  try {
    const v = window.localStorage.getItem(USAGE_APP_KEY);
    return v === 'claude' || v === 'codex' ? v : null;
  } catch {
    return null;
  }
}

export function saveUsageApp(app) {
  try {
    window.localStorage.setItem(USAGE_APP_KEY, app);
  } catch {
    // Storage unavailable (private mode etc.) -- selection just won't persist.
  }
}

export function useUsageTab({ defaultApp = 'claude', availableApps = null, hiddenApps = [] } = {}) {
  const isSelectable = useCallback(
    (app) => isAppSelectable(app, availableApps, hiddenApps),
    [availableApps, hiddenApps]
  );
  const [tab, setTabState] = useState(() => {
    const saved = loadSavedUsageApp();
    if (saved && isAppSelectable(saved, availableApps, hiddenApps)) return saved;
    return defaultApp === 'codex' ? 'codex' : 'claude';
  });

  useEffect(() => {
    if (!availableApps) return;
    const saved = loadSavedUsageApp();
    setTabState((cur) => {
      if (saved && saved !== cur && isAppSelectable(saved, availableApps, hiddenApps)) return saved;
      if (isAppSelectable(cur, availableApps, hiddenApps)) return cur;
      const other = cur === 'codex' ? 'claude' : 'codex';
      if (isAppSelectable(other, availableApps, hiddenApps)) {
        saveUsageApp(other);
        return other;
      }
      return cur;
    });
  }, [availableApps, hiddenApps]);

  const setTab = useCallback((app) => {
    saveUsageApp(app);
    setTabState(app);
  }, []);

  const claudeAvailable = isSelectable('claude');
  const codexAvailable = isSelectable('codex');

  return { tab, setTab, isSelectable, claudeAvailable, codexAvailable };
}

export function useUsageData(tab) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const tabRef = useRef(tab);
  tabRef.current = tab;

  const load = useCallback(async (force = false) => {
    const app = tabRef.current;
    setLoading(true);
    try {
      const res = await authFetch(`/api/usage?app=${app}${force ? '&force=1' : ''}`);
      const json = await res.json();
      setData(json);
    } catch (err) {
      setData({ error: String(err?.message || err) });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { setData(null); load(false); }, [tab, load]);

  return { data, loading, load };
}
