import { useRef, useCallback } from 'react';
import SessionList from './SessionList.jsx';

// 左セッションサイドバー: 右ウィジェット (RightSidebar) と同じ挙動の常時表示パネル。
// - open でゲートし、閉じている間は null (RightSidebarInner と同一方針)
// - popup のような外側クリック / Escape では閉じない。閉じるのはタブバーの
//   トグルボタンのみ (デスクトップ overlay 時にトグルが埋もれないよう
//   .main-row 内 absolute に留める設計も右と同一)
// - 選択しても閉じない (popup は選択で閉じる)
// - キーボードの矢印/Home/End 移動は popup と同一パターン
export default function SessionSidebar({
  open,
  sessionTabs,
  activeTabId,
  unopenedSessions,
  unopenedGroups,
  onSelectTab,
  onCloseTab,
  onOpenSession,
  onTerminateSession,
  onOpenGroup,
  customLabels,
  onRowContextMenu,
}) {
  const listRef = useRef(null);

  const onListKeyDown = useCallback((e) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
    const list = listRef.current;
    if (!list) return;
    const buttons = [...list.querySelectorAll('button.session-menu-select, button.session-menu-close')];
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

  if (!open) return null;

  const openedCount = sessionTabs.length;

  return (
    <aside className="left-sidebar" aria-label="セッションサイドバー">
      <div className="sidebar-header">
        <span className="sidebar-title">
          Sessions
          {openedCount > 0 && (
            <span className="session-menu-count" aria-hidden="true" style={{ marginLeft: 8 }}>{openedCount}</span>
          )}
        </span>
      </div>
      <div className="sidebar-widgets session-sidebar-list" ref={listRef} onKeyDown={onListKeyDown} role="menu" aria-label="セッション一覧">
        <SessionList
          sessionTabs={sessionTabs}
          activeTabId={activeTabId}
          unopenedSessions={unopenedSessions}
          unopenedGroups={unopenedGroups}
          onSelectTab={onSelectTab}
          onCloseTab={onCloseTab}
          onOpenSession={onOpenSession}
          onTerminateSession={onTerminateSession}
          onOpenGroup={onOpenGroup}
          customLabels={customLabels}
          onRowContextMenu={onRowContextMenu}
        />
      </div>
    </aside>
  );
}
