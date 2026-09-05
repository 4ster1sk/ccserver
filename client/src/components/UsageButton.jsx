import { useState, useRef, useEffect } from 'react';
import { useUsageTab, useUsageData, USAGE_APP_LABELS, USAGE_TAB_LABELS } from './widgets/useUsage.js';
import UsagePanel from './widgets/UsagePanel.jsx';

export default function UsageButton({ hidden = false, defaultApp = 'claude', availableApps = null, hiddenApps = [] }) {
  const [open, setOpen] = useState(false);
  const [, setTick] = useState(0);   // re-render so pace/age stay live while open
  // Which app the popover is currently showing. The persisted choice wins:
  // defaultApp (the active terminal tab's app) only seeds the very first view
  // when nothing valid has been saved yet. Availability is still respected --
  // a saved app that isn't installed or is hidden falls back below.
  const { tab, setTab, visibleApps } = useUsageTab({ defaultApp, availableApps, hiddenApps });
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
  // Claude's first limit is the session window; Codex/Go label their
  // windows differently (5時間/週次/月次), so fall back to the first row.
  const session = limits.find((l) => /session/i.test(l.label)) || limits[0];
  const now = Date.now();
  const appLabel = USAGE_APP_LABELS[tab] || USAGE_APP_LABELS.claude;

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
          <UsagePanel
            tabLabel={appLabel}
            tabs={visibleApps}
            tab={tab}
            setTab={setTab}
            tabLabels={USAGE_TAB_LABELS}
            data={data}
            loading={loading}
            load={load}
            limits={limits}
            now={now}
          />
        </div>
      )}
    </div>
  );
}
