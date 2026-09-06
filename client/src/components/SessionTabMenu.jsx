import { useEffect, useRef } from 'react';
import TabIcon from './TabIcon.jsx';

function baseName(path) {
  if (!path) return '';
  const parts = String(path).split(/[/\\]/).filter(Boolean);
  return parts.pop() || String(path);
}

function appLabel(sessionOrTab) {
  if (sessionOrTab.shell) return 'shell';
  const app = sessionOrTab.app || 'claude';
  if (app === 'commandcode') return 'command-code';
  return app;
}

// セッションタブ用ハンバーガーメニュー: 開いている terminal タブを上段、
// サーバー上で稼働中だが未オープンのセッションを下段に縦並びで表示する。
// 開閉はウィジェット系 (RightSidebar / UsageButton) と同じ方式:
// ラッパー ref による外側 mousedown で閉じる + Escape で閉じる。
export default function SessionTabMenu({
  open,
  onToggle,
  onClose,
  sessionTabs,
  activeTabId,
  unopenedSessions,
  onSelectTab,
  onCloseTab,
  onOpenSession,
  onTerminateSession,
}) {
  const wrapRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) onClose?.();
    };
    const onKey = (e) => {
      if (e.key === 'Escape') onClose?.();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, onClose]);

  const openedCount = sessionTabs.length;

  return (
    <div className="session-menu-wrap" ref={wrapRef}>
      <button
        type="button"
        className="btn session-menu-btn"
        onClick={onToggle}
        title={openedCount > 0 ? `開いているセッション (${openedCount})` : '開いているセッション'}
        aria-label="セッション一覧メニュー"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <span aria-hidden="true">☰</span>
        {openedCount > 0 && (
          <span className="session-menu-count" aria-hidden="true">{openedCount}</span>
        )}
      </button>
      {open && (
        <div className="session-menu" role="menu" aria-label="セッション一覧">
          <div className="session-menu-section" data-section="opened">
          <div className="session-menu-section-label">開いているセッション</div>
          {sessionTabs.length === 0 ? (
            <div className="session-menu-empty">開いているセッションはありません</div>
          ) : (
            sessionTabs.map((tab) => {
              const isActive = tab.id === activeTabId;
              const stateClass = tab.exited ? 'is-exited' : 'is-running';
              const stateText = tab.exited ? 'exited' : 'connected';
              const statusText = tab.shell ? `shell · ${stateText}` : `${appLabel(tab)} · ${stateText}`;
              return (
                <div
                  key={tab.id}
                  role="menuitem"
                  tabIndex={0}
                  className={`session-menu-item${isActive ? ' active' : ''} ${stateClass}${tab.type === 'terminal' && !tab.shell && !tab.sandbox ? ' no-sandbox' : ''}`}
                  title={tab.cwd || tab.label}
                  aria-label={`${tab.exited ? '終了済み' : '稼働中'}: ${tab.label}`}
                  onClick={() => { onSelectTab(tab.id); }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelectTab(tab.id); }
                  }}
                >
                  <span className="session-menu-item-top">
                    <TabIcon type={tab.type} app={tab.app} shell={tab.shell} isMetaAgent={!!tab.isMetaAgent} />
                    <span className="session-menu-label">{tab.label}</span>
                    {tab.remote && (
                      <span className="tab-remote-badge" title={`接続先: ${tab.remote.label}`}>⇄ {tab.remote.label}</span>
                    )}
                    <button
                      type="button"
                      className="tab-close session-menu-close"
                      title="タブを閉じる"
                      aria-label={`タブを閉じる: ${tab.label}`}
                      onClick={(e) => { e.stopPropagation(); onCloseTab(tab.id); }}
                      onKeyDown={(e) => {
                        // 親 menuitem の選択動作 (Enter/Space) へのバブリングのみ止める。
                        // Escape は document の keydown リスナに届けてメニューを閉じさせる。
                        if (e.key === 'Enter' || e.key === ' ') e.stopPropagation();
                      }}
                    >
                      &#10005;
                    </button>
                  </span>
                  <span className="session-menu-status">
                    {tab.cwd && <span className="session-menu-path" title={tab.cwd}>{baseName(tab.cwd)}</span>}
                    <span className="session-menu-state">{statusText}</span>
                    {!tab.shell && !tab.sandbox && <span className="session-badge no-sandbox">no sandbox</span>}
                    {tab.sandbox && <span className="session-badge sandbox">sandbox</span>}
                  </span>
                </div>
              );
            })
          )}
          </div>
          {unopenedSessions.length > 0 && (
            <div className="session-menu-section" data-section="unopened">
              <div className="session-menu-sep" />
              <div className="session-menu-section-label">稼働中のセッション</div>
              {unopenedSessions.map((s) => (
                <div
                  key={s.id}
                  role="menuitem"
                  tabIndex={0}
                  className={`session-menu-item ${s.connected ? 'is-running' : 'is-idle'}`}
                  title={s.cwd || s.id}
                  aria-label={`${s.connected ? '稼働中' : 'アイドル'}: ${s.cwd || s.id}`}
                  onClick={() => { onOpenSession(s); }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpenSession(s); }
                  }}
                >
                  <span className="session-menu-item-top">
                    <TabIcon type="terminal" app={s.app} shell={!!s.shell} isMetaAgent={!!s.isMetaAgent} />
                    <span className="session-menu-label">{baseName(s.cwd) || s.id.slice(0, 8)}</span>
                    <button
                      type="button"
                      className="tab-close session-menu-close"
                      title="セッションを終了する"
                      aria-label={`セッションを終了する: ${s.cwd || s.id}`}
                      onClick={(e) => { e.stopPropagation(); onTerminateSession(s); }}
                      onKeyDown={(e) => {
                        // 親 menuitem の選択動作 (Enter/Space) へのバブリングのみ止める。
                        // Escape は document の keydown リスナに届けてメニューを閉じさせる。
                        if (e.key === 'Enter' || e.key === ' ') e.stopPropagation();
                      }}
                    >
                      &#10005;
                    </button>
                  </span>
                  <span className="session-menu-status">
                    {s.cwd && <span className="session-menu-path" title={s.cwd}>{s.cwd}</span>}
                    <span className="session-menu-state">
                      {s.shell ? `shell · ${s.connected ? 'connected' : 'idle'}` : `${appLabel(s)} · ${s.connected ? 'connected' : 'idle'}`}
                    </span>
                    {s.sandbox
                      ? <span className="session-badge sandbox">sandbox</span>
                      : (!s.shell ? <span className="session-badge no-sandbox">no sandbox</span> : null)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
