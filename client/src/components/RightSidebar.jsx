import { useState, useRef, useEffect } from 'react';
import { useWidgetPrefs } from '../hooks/useWidgetPrefs.js';
import { useSystemStatsContext } from './widgets/SystemStatsProvider.jsx';
import { CpuCard, MemoryCard, StorageCard, TempCard, GpuCard, IpmiCards } from './widgets/MonitorCards.jsx';
import UsageWidget from './widgets/UsageWidget.jsx';

const WIDGET_DEFS = [
  { id: 'usage', title: 'Usage', defaultVisible: true },
  { id: 'cpu', title: 'CPU', defaultVisible: true },
  { id: 'memory-storage', title: 'Memory / Storage', defaultVisible: true },
  { id: 'temps', title: 'Temperatures', defaultVisible: false },
  { id: 'gpu', title: 'GPU', defaultVisible: true },
  { id: 'ipmi', title: 'IPMI', defaultVisible: false },
];

function WidgetShell({ title, onHide, onMoveUp, onMoveDown, children }) {
  const [collapsed, setCollapsed] = useState(false);
  return (
    <section className="widget-card">
      <header className="widget-card-header">
        <button
          type="button"
          className="widget-card-title"
          onClick={() => setCollapsed((v) => !v)}
          title={collapsed ? '展開' : '折りたたみ'}
        >
          <span className="widget-collapse-mark">{collapsed ? '▸' : '▾'}</span>
          {title}
        </button>
        <span className="widget-card-actions">
          <button type="button" className="widget-icon-btn" onClick={onMoveUp} title="上へ">↑</button>
          <button type="button" className="widget-icon-btn" onClick={onMoveDown} title="下へ">↓</button>
          <button type="button" className="widget-icon-btn" onClick={onHide} title="非表示">✕</button>
        </span>
      </header>
      {!collapsed && <div className="widget-card-body">{children}</div>}
    </section>
  );
}

export default function RightSidebar({ usageProps = {}, prefs }) {
  const internalPrefs = useWidgetPrefs(WIDGET_DEFS);
  const { open, setOpen, visibleWidgets, hiddenWidgets, setWidgetVisible, moveWidget } = prefs || internalPrefs;
  const [addOpen, setAddOpen] = useState(false);
  const addWrapRef = useRef(null);
  const stats = useSystemStatsContext();

  useEffect(() => {
    if (!addOpen) return;
    const onClick = (e) => {
      if (addWrapRef.current && !addWrapRef.current.contains(e.target)) setAddOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [addOpen]);

  if (!open) return null;

  const renderWidgetBody = (id) => {
    if (id === 'usage') {
      if (usageProps?.hidden) return <div className="usage-empty">データがありません</div>;
      return <UsageWidget {...usageProps} />;
    }
    const data = stats?.data;
    const showIpmi = stats?.showIpmi;
    if (stats?.error && !data) return <div className="error">Failed to load system stats: {stats.error}</div>;
    if (!data) return <div className="loading">Loading system stats...</div>;
    switch (id) {
      case 'cpu':
        return <CpuCard data={data} />;
      case 'memory-storage':
        return (
          <>
            <MemoryCard data={data} />
            <StorageCard data={data} />
          </>
        );
      case 'temps':
        return <TempCard data={data} />;
      case 'gpu':
        return <GpuCard data={data} />;
      case 'ipmi':
        return <IpmiCards data={data} showIpmi={showIpmi} />;
      default:
        return null;
    }
  };

  return (
    <aside className="right-sidebar">
      <div className="sidebar-header">
        <span className="sidebar-title">Widgets</span>
        <span className="sidebar-header-actions">
          {hiddenWidgets.length > 0 && (
            <span className="sidebar-add-wrap" ref={addWrapRef}>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => setAddOpen((v) => !v)}
                title="非表示のウィジェットを追加"
              >
                ＋
              </button>
              {addOpen && (
                <span className="sidebar-add-menu">
                  {hiddenWidgets.map((w) => (
                    <button
                      key={w.id}
                      type="button"
                      className="sidebar-add-item"
                      onClick={() => { setWidgetVisible(w.id, true); setAddOpen(false); }}
                    >
                      {w.title}
                    </button>
                  ))}
                </span>
              )}
            </span>
          )}
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => setOpen(false)}
            title="サイドバーを閉じる"
          >
            ▶
          </button>
        </span>
      </div>
      <div className="sidebar-widgets">
        {visibleWidgets.map((w) => (
          <WidgetShell
            key={w.id}
            title={w.title}
            onHide={() => setWidgetVisible(w.id, false)}
            onMoveUp={() => moveWidget(w.id, 'up')}
            onMoveDown={() => moveWidget(w.id, 'down')}
          >
            {renderWidgetBody(w.id)}
          </WidgetShell>
        ))}
        {visibleWidgets.length === 0 && (
          <div className="sidebar-empty">表示中のウィジェットがありません。＋から追加してください。</div>
        )}
      </div>
    </aside>
  );
}

export { WIDGET_DEFS };

export const MONITOR_WIDGET_IDS = ['cpu', 'memory-storage', 'temps', 'gpu', 'ipmi'];
