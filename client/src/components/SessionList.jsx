import TabIcon from './TabIcon.jsx';

export function baseName(path) {
  if (!path) return '';
  const parts = String(path).split(/[/\\]/).filter(Boolean);
  return parts.pop() || String(path);
}

export function appLabel(sessionOrTab) {
  if (sessionOrTab.shell) return 'shell';
  const app = sessionOrTab.app || 'claude';
  if (app === 'commandcode') return 'command-code';
  return app;
}

// セッション一覧の実体 (ポップアップ / 左サイドバーで共用するプレゼンテーショナル部品)。
// 外側ラッパー (.session-menu / .session-sidebar-list) や開閉ロジックは持たない。
// a11y: 行コンテナは role="none" の非対話要素とし、「選択」と「閉じる/終了」
// を独立した button で提供する (menuitem 内に button を入れ子にしない)。
export default function SessionList({
  sessionTabs,
  activeTabId,
  unopenedSessions,
  onSelectTab,
  onCloseTab,
  onOpenSession,
  onTerminateSession,
}) {
  return (
    <>
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
    </>
  );
}
