import { useEffect, useRef, useCallback } from 'react';
import SessionList from './SessionList.jsx';

// セッションタブ用ハンバーガーメニュー: 開いている terminal タブを上段、
// サーバー上で稼働中だが未オープンのセッションを下段に縦並びで表示する。
// 開閉はウィジェット系 (RightSidebar / UsageButton) と同じ方式:
// ラッパー ref による外側 mousedown で閉じる + Escape で閉じる。
//
// 一覧の実体は SessionList.jsx (左サイドバーと共用)。ここは popup ラッパー
// (.session-menu-wrap > button + .session-menu) と開閉ロジックのみを持つ。
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
  unopenedGroups,
  onSelectTab,
  onCloseTab,
  onOpenSession,
  onTerminateSession,
  onOpenGroup,
  customLabels,
  onRowContextMenu,
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
      )}
    </div>
  );
}
