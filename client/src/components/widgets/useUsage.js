import { useState, useEffect, useCallback, useRef } from 'react';
import { authFetch } from '../../auth.js';
import { isAppVisible } from '../../appAvailability.js';

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

// Apps with a Usage tab. opencode Go needs no binary (Go subscription only),
// so visibility follows isAppVisible's Go rule (toggle + key), not install
// detection. Shared by UsageButton and UsageWidget so the tab sets agree.
export const USAGE_APPS = ['claude', 'codex', 'opencode'];

export const USAGE_APP_LABELS = {
  claude: 'Claude 使用量',
  codex: 'Codex 使用量',
  opencode: 'OpenCode Go 使用量',
};

export const USAGE_TAB_LABELS = {
  claude: 'Claude',
  codex: 'Codex',
  opencode: 'OpenCode',
};

export function loadSavedUsageApp(validApps = USAGE_APPS) {
  try {
    const v = window.localStorage.getItem(USAGE_APP_KEY);
    return validApps.includes(v) ? v : null;
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

export function useUsageTab({ defaultApp = 'claude', availableApps = null, hiddenApps = [], apps = USAGE_APPS } = {}) {
  // isAppVisible covers opencode Go's toggle+key rule on top of
  // isAppSelectable's claude/codex rule (see appAvailability.js), so the
  // Usage tabs and App.jsx's button visibility can't drift.
  const isSelectable = useCallback(
    (app) => isAppVisible(app, availableApps, hiddenApps),
    [availableApps, hiddenApps]
  );
  const [tab, setTabState] = useState(() => {
    const saved = loadSavedUsageApp(apps);
    if (saved && isAppVisible(saved, availableApps, hiddenApps)) return saved;
    if (apps.includes(defaultApp) && isAppVisible(defaultApp, availableApps, hiddenApps)) return defaultApp;
    return apps[0];
  });

  useEffect(() => {
    if (!availableApps) return;
    const saved = loadSavedUsageApp(apps);
    setTabState((cur) => {
      if (saved && saved !== cur && isAppVisible(saved, availableApps, hiddenApps)) return saved;
      if (isAppVisible(cur, availableApps, hiddenApps)) return cur;
      const fallback = apps.find((a) => a !== cur && isAppVisible(a, availableApps, hiddenApps));
      if (fallback) {
        saveUsageApp(fallback);
        return fallback;
      }
      return cur;
    });
  }, [availableApps, hiddenApps, apps]);

  const setTab = useCallback((app) => {
    saveUsageApp(app);
    setTabState(app);
  }, []);

  const visibleApps = apps.filter((a) => isSelectable(a));

  return { tab, setTab, isSelectable, visibleApps };
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
