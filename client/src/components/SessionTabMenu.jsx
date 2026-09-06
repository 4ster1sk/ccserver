import { useEffect, useRef, useCallback } from 'react';
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
//
// a11y: 行コンテナは role="none" の非対話要素とし、「選択」と「閉じる/終了」
// を独立した button で提供する (menuitem 内に button を入れ子にしない)。
// メニュー内の上下矢印キーでフォーカス移動できる。
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
  const menuRef = useRef(null);

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

  // メニュー内のボタン間を矢印キーで移動する (menu パターンのキーボード操作)。
  const onMenuKeyDown = useCallback((e) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
    const menu = menuRef.current;
    if (!menu) return;
    const buttons = [...menu.querySelectorAll('button.session-menu-select, button.session-menu-close')];
    if (buttons.length === 0) return;
    const idx = buttons.indexOf(document.activeElement);
    e.preventDefault();
    if (e.key === 'Home') { buttons[0].focus(); return; }
    if (e.key === 'End') { buttons[buttons.length - 1].focus(); return; }
    const next = e.key === 'ArrowDown'
      ? buttons[(idx + 1 + buttons.length) % buttons.length]
      : buttons[(idx - 1 + buttons.length) % buttons.length];
    next.focus();
  }, []);

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
        <div className="session-menu" role="menu" aria-label="セッション一覧" ref={menuRef} onKeyDown={onMenuKeyDown}>
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
                  role="none"
                  className={`session-menu-item${isActive ? ' active' : ''} ${stateClass}${tab.type === 'terminal' && !tab.shell && !tab.sandbox ? ' no-sandbox' : ''}`}
                  title={tab.cwd || tab.label}
                >
                  <button
                    type="button"
                    role="menuitem"
                    className="session-menu-select"
                    aria-label={`${tab.exited ? '終了済み' : '稼働中'}: ${tab.label}`}
                    onClick={() => { onSelectTab(tab.id); }}
                  >
                    <span className="session-menu-item-top">
                      <TabIcon type={tab.type} app={tab.app} shell={tab.shell} isMetaAgent={!!tab.isMetaAgent} />
                      <span className="session-menu-label">{tab.label}</span>
                      {tab.remote && (
                        <span className="tab-remote-badge" title={`接続先: ${tab.remote.label}`}>⇄ {tab.remote.label}</span>
                      )}
                    </span>
                    <span className="session-menu-status">
                      {tab.cwd && <span className="session-menu-path" title={tab.cwd}>{baseName(tab.cwd)}</span>}
                      <span className="session-menu-state">{statusText}</span>
                      {!tab.shell && !tab.sandbox && <span className="session-badge no-sandbox">no sandbox</span>}
                      {tab.sandbox && <span className="session-badge sandbox">sandbox</span>}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="tab-close session-menu-close"
                    title="タブを閉じる"
                    aria-label={`タブを閉じる: ${tab.label}`}
                    onClick={() => { onCloseTab(tab.id); }}
                  >
                    &#10005;
                  </button>
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
                  role="none"
                  className={`session-menu-item ${s.connected ? 'is-running' : 'is-idle'}`}
                  title={s.cwd || s.id}
                >
                  <button
                    type="button"
                    role="menuitem"
                    className="session-menu-select"
                    aria-label={`${s.connected ? '稼働中' : 'アイドル'}: ${s.cwd || s.id}`}
                    onClick={() => { onOpenSession(s); }}
                  >
                    <span className="session-menu-item-top">
                      <TabIcon type="terminal" app={s.app} shell={!!s.shell} isMetaAgent={!!s.isMetaAgent} />
                      <span className="session-menu-label">{baseName(s.cwd) || s.id.slice(0, 8)}</span>
                    </span>
                    <span className="session-menu-status">
                      {s.cwd && <span className="session-menu-path" title={s.cwd}>{baseName(s.cwd)}</span>}
                      <span className="session-menu-state">
                        {s.shell ? `shell · ${s.connected ? 'connected' : 'idle'}` : `${appLabel(s)} · ${s.connected ? 'connected' : 'idle'}`}
                      </span>
                      {s.sandbox
                        ? <span className="session-badge sandbox">sandbox</span>
                        : (!s.shell ? <span className="session-badge no-sandbox">no sandbox</span> : null)}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="tab-close session-menu-close"
                    title="セッションを終了する"
                    aria-label={`セッションを終了する: ${s.cwd || s.id}`}
                    onClick={() => { onTerminateSession(s); }}
                  >
                    &#10005;
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
