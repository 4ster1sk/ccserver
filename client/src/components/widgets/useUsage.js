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

// 同一appへの同時リクエストを一本化するためのin-flight共有マップ
// (app -> Promise)。UsageButtonとUsageWidgetのマウント時など、
// 同タイミングの同一クエリが2本飛ぶのを防ぐ。settledら除去し、
// 結果のキャッシュはしない (stalenessを持ち込まない)。
const inflightUsage = new Map();

export function useUsageData(tab, { enabled = true } = {}) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const tabRef = useRef(tab);
  const requestIdRef = useRef(0);

  useEffect(() => { tabRef.current = tab; });

  const load = useCallback(async (force = false) => {
    const app = tabRef.current;
    const requestId = ++requestIdRef.current;
    setLoading(true);
    try {
      let pending = !force ? inflightUsage.get(app) : null;
      if (!pending) {
        pending = (async () => {
          const res = await authFetch(`/api/usage?app=${app}${force ? '&force=1' : ''}`);
          return res.json();
        })();
        // force時は共有マップを汚さない (明示更新は常に新規取得)。
        if (!force) inflightUsage.set(app, pending);
        try {
          await pending;
        } finally {
          if (inflightUsage.get(app) === pending) inflightUsage.delete(app);
        }
      }
      const json = await pending;
      if (requestIdRef.current === requestId) setData(json);
    } catch (err) {
      if (requestIdRef.current === requestId) setData({ error: String(err?.message || err) });
    } finally {
      if (requestIdRef.current === requestId) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    setData(null);
    load(false);
  }, [tab, load, enabled]);

  return { data, loading, load };
}
