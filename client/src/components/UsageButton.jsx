import { useState, useRef, useEffect } from 'react';
import { pctClass, paceMark, fmtAge, useUsageTab, useUsageData } from './widgets/useUsage.js';

export default function UsageButton({ hidden = false, defaultApp = 'claude', availableApps = null, hiddenApps = [] }) {
  const [open, setOpen] = useState(false);
  const [, setTick] = useState(0);   // re-render so pace/age stay live while open
  // Which app the popover is currently showing. The persisted choice wins:
  // defaultApp (the active terminal tab's app) only seeds the very first view
  // when nothing valid has been saved yet. Availability is still respected --
  // a saved app that isn't installed or is hidden falls back below.
  const { tab, setTab, claudeAvailable, codexAvailable } = useUsageTab({ defaultApp, availableApps, hiddenApps });
  const { data, loading, load } = useUsageData(tab, { enabled: !hidden });
  const wrapRef = useRef(null);

  // Fetch fresh-ish data whenever the popover opens.
  useEffect(() => {
    if (open) load(false);
  }, [open, load]);

  useEffect(() => {
    if (!open) return;
    const onClick = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const id = setInterval(() => setTick((t) => t + 1), 30000);
    return () => clearInterval(id);
  }, [open]);

  const limits = data?.usage?.limits || [];
  const session = limits.find((l) => /session/i.test(l.label)) || limits[0];
  const now = Date.now();
  const appLabel = tab === 'codex' ? 'Codex 使用量' : 'Claude 使用量';

  // `hidden` is decided by the caller (showUsage pref / neither app installed).
  if (hidden) return null;

  return (
    <div className="usage-picker" ref={wrapRef}>
      <button
        className="btn usage-btn"
        onClick={() => setOpen((v) => !v)}
        title={appLabel}
      >
        <svg className="tab-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M2 13h12M4 13V8M8 13V4M12 13V6" />
        </svg>
        <span className="usage-btn-label">Usage</span>
        {session && <span className={`usage-btn-pct${session.pct >= 80 ? ' high' : ''}`}>{session.pct}%</span>}
        <span className="usage-btn-app">({tab})</span>
      </button>
      {open && (
        <div className="usage-menu">
          <div className="usage-menu-header">
            <span>{appLabel}</span>
            <button
              className="btn btn-secondary btn-sm"
              onClick={() => load(true)}
              disabled={loading}
              title="最新の状態を取得"
            >
              {loading ? '取得中…' : '更新'}
            </button>
          </div>

          {claudeAvailable && codexAvailable && (
            <div className="usage-tabs">
              <button
                type="button"
                className={`usage-tab${tab === 'claude' ? ' active' : ''}`}
                onClick={() => setTab('claude')}
              >Claude</button>
              <button
                type="button"
                className={`usage-tab${tab === 'codex' ? ' active' : ''}`}
                onClick={() => setTab('codex')}
              >Codex</button>
            </div>
          )}

          {data?.usage?.plan && (
            <div className="usage-plan">{data.usage.plan}</div>
          )}

          {limits.length > 0 ? (
            <div className="usage-limits">
              {limits.map((l, i) => {
                const pace = paceMark(l, now);
                const over = pace != null && l.pct > pace + 1;
                return (
                  <div className="usage-limit" key={i}>
                    <div className="usage-limit-top">
                      <span className="usage-limit-label">{l.label}</span>
                      <span className="usage-limit-pct">{l.pct}%</span>
                    </div>
                    <div className="usage-bar-wrap">
                      <div className="usage-bar">
                        <div className={pctClass(l.pct)} style={{ width: `${Math.min(100, l.pct)}%` }} />
                      </div>
                      {pace != null && (
                        <div
                          className={`usage-pace${over ? ' over' : ''}`}
                          style={{ left: `${pace}%` }}
                          title={`妥当なペースの目安 ${Math.round(pace)}%（経過時間ぶん）${over ? ' · ペース超過' : ''}`}
                        />
                      )}
                    </div>
                    {(l.resets || pace != null) && (
                      <div className="usage-limit-reset">
                        {l.resets && `リセット: ${l.resets}`}
                        {pace != null && `${l.resets ? ' · ' : ''}目安 ${Math.round(pace)}%`}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="usage-empty">
              {loading ? '読み込み中…' : (data?.error ? `取得できませんでした: ${data.error}` : 'データがありません')}
            </div>
          )}

          {data?.usage?.cost && data.usage.cost !== '$0.0000' && (
            <div className="usage-cost">セッション費用: {data.usage.cost}</div>
          )}

          <div className="usage-footer">
            {data?.updatedAt ? `更新 ${fmtAge(data.updatedAt)}` : ''}
            {data?.sandboxed ? ' · 🔒 サンドボックス' : ''}
          </div>
        </div>
      )}
    </div>
  );
}
