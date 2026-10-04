import { useCallback, useRef, useState } from 'react';
import { useDismissableMenu } from '../../hooks/useDismissableMenu.js';

const ICON = {
  menu: <path d="M3 4h10M3 8h10M3 12h10" />,
  history: <><path d="M2.5 8a5.5 5.5 0 1 0 1.6-3.9" /><path d="M2.5 2.5v2.5H5" /><path d="M8 5v3l2 1.5" /></>,
  timer: <><circle cx="8" cy="8" r="6" /><path d="M8 4.5V8l2.5 1.5" /></>,
  autoYes: <path d="M3 8.5l3 3 7-7" />,
  list: <><path d="M5 4h8M5 8h8M5 12h8" /><path d="M2.5 4h.01M2.5 8h.01M2.5 12h.01" /></>,
  bell: <><path d="M6 12.5a2 2 0 004 0" /><path d="M4.5 6.5a3.5 3.5 0 017 0c0 2 .5 3 1.5 4.5H3C4 9.5 4.5 8.5 4.5 6.5z" /></>,
  log: <><path d="M4 2h5l3 3v9H4z" /><path d="M9 2v3h3M6 8h4M6 11h4" /></>,
};

function Icon({ name }) {
  return (
    <svg className="header-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {ICON[name]}
    </svg>
  );
}

function Switch({ on }) {
  return <span className={`chat-menu-switch${on ? ' on' : ''}`} aria-hidden="true" />;
}

// The chat header's ☰ menu: panels (履歴 / タイマー / 承認ログ / ログ) open
// over the conversation via onPanel(name); toggles (Auto-Y / 通知) flip in
// place and keep the menu open.
export default function ChatHeaderMenu({
  panel, onPanel, live, hasSession,
  schedule, fmtServer,
  autoYes, autoYesLogCount, onToggleAutoYes,
  notifyEnabled, notifyPermission, onToggleNotify,
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const close = useCallback(() => setOpen(false), []);
  useDismissableMenu(ref, close, { enabled: open });

  const pick = (name) => {
    onPanel(panel === name ? null : name);
    setOpen(false);
  };
  const notifyBlocked = notifyPermission === 'denied' || notifyPermission === 'unsupported';
  const notifyNote = notifyPermission === 'denied' ? 'ブラウザの設定で拒否されています'
    : notifyPermission === 'unsupported' ? 'このブラウザは非対応です' : null;
  const badge = !!schedule || autoYes;

  return (
    <div className="chat-menu" ref={ref}>
      <button
        type="button"
        className={`btn chat-menu-btn${open || panel ? ' active' : ''}`}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="メニュー"
        title="メニュー"
      >
        <Icon name="menu" />
        {badge && <span className="chat-menu-badge" />}
      </button>
      {open && (
        <div className="chat-menu-list" role="menu">
          <button type="button" role="menuitem" className={`chat-menu-item${panel === 'history' ? ' active' : ''}`} disabled={!live} onClick={() => pick('history')}>
            <Icon name="history" />
            <span className="chat-menu-label">履歴</span>
            <span className="chat-menu-chevron">›</span>
          </button>
          <button type="button" role="menuitem" className={`chat-menu-item${panel === 'timer' ? ' active' : ''}`} disabled={!hasSession} onClick={() => pick('timer')}>
            <Icon name="timer" />
            <span className="chat-menu-label">タイマー</span>
            {schedule && <span className="chat-menu-note warn">{fmtServer(schedule.at, { hour: '2-digit', minute: '2-digit' })} 予約中</span>}
            <span className="chat-menu-chevron">›</span>
          </button>
          <div className="chat-menu-sep" />
          <button type="button" role="menuitemcheckbox" aria-checked={autoYes} className="chat-menu-item" disabled={!hasSession} onClick={onToggleAutoYes}
            title="ツールの許可要求を自動で「今回のみ許可」します（プランの承認と質問は対象外）">
            <Icon name="autoYes" />
            <span className="chat-menu-label">自動承認 (Auto-Y)</span>
            <Switch on={autoYes} />
          </button>
          {autoYesLogCount > 0 && (
            <button type="button" role="menuitem" className={`chat-menu-item sub${panel === 'autoYesLog' ? ' active' : ''}`} onClick={() => pick('autoYesLog')}>
              <Icon name="list" />
              <span className="chat-menu-label">承認ログ</span>
              <span className="chat-menu-count">{autoYesLogCount}</span>
              <span className="chat-menu-chevron">›</span>
            </button>
          )}
          <button type="button" role="menuitemcheckbox" aria-checked={!!notifyEnabled} className="chat-menu-item" disabled={notifyBlocked} onClick={onToggleNotify}
            title={notifyNote || '応答の完了や入力待ちをブラウザ通知で知らせます'}>
            <Icon name="bell" />
            <span className="chat-menu-label">通知{notifyNote && <span className="chat-menu-sublabel">{notifyNote}</span>}</span>
            <Switch on={!!notifyEnabled && !notifyBlocked} />
          </button>
          <div className="chat-menu-sep" />
          <button type="button" role="menuitem" className={`chat-menu-item${panel === 'log' ? ' active' : ''}`} onClick={() => pick('log')}>
            <Icon name="log" />
            <span className="chat-menu-label">ログ<span className="chat-menu-note">起動ログ</span></span>
            <span className="chat-menu-chevron">›</span>
          </button>
        </div>
      )}
    </div>
  );
}
