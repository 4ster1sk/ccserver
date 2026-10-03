import TabIcon from './TabIcon.jsx';
import { useCommitSigningStatusContext } from './CommitSigningStatusProvider.jsx';
import { commitSigningBadgeState } from '../commitSigningBadge.js';
import { activityInfo } from '../activityLevel.js';

// エージェントの稼働度 (緑=待機中 / 黄=低活動 / 赤=稼働中)。行の左端の縦線は
// 「ビューアが接続しているか」という別の軸なので混ぜず、独立した点で出す。
// 色だけに頼らないよう、レベルごとに形 (中空 / 半分 / 塗りつぶし) を変え、
// 状態語は行の aria-label と title の両方に入れる (活動なしのときは何も
// 出さない: サーバーが level:null = 「その問いが成立しない」と返す)。
function ActivityDot({ activity }) {
  const info = activityInfo(activity);
  if (!info) return null;
  return (
    <span
      className={`session-activity ${info.className}${info.verified ? '' : ' is-unverified'}`}
      title={info.title}
      aria-hidden="true"
    />
  );
}

// サンドボックス起動のバッジ。VM (qemu) で起動したものは "VM" と出す。
function SandboxBadge({ backend }) {
  return backend === 'qemu'
    ? <span className="session-badge vm">VM</span>
    : <span className="session-badge sandbox">sandbox</span>;
}

// aria-label 用の接頭辞。状態語を読み上げに載せる (点自体は aria-hidden)。
function activityAria(activity) {
  const info = activityInfo(activity);
  return info ? `${info.ariaText}, ` : '';
}

export function baseName(path) {
  if (!path) return '';
  const parts = String(path).split(/[/\\]/).filter(Boolean);
  return parts.pop() || String(path);
}

export function appLabel(sessionOrTab) {
  if (sessionOrTab.shell) return 'shell';
  const app = sessionOrTab.app || 'claude';
  return app;
}

// セッション一覧の実体 (左サイドバーに表示するプレゼンテーショナル部品)。
// 外側ラッパー (.session-sidebar-list) や開閉ロジックは持たない。
// a11y: 行コンテナは role="none" の非対話要素とし、「選択」と「閉じる/終了」
// を独立した button で提供する (menuitem 内に button を入れ子にしない)。
// 各行の右クリックは onRowContextMenu(e, { id, currentLabel }) に委譲する
// (サーバー保存の表示名の設定用。サーバーセッション未確立のタブは対象外)。
export default function SessionList({
  sessionTabs,
  activeTabId,
  unopenedSessions,
  onSelectTab,
  onCloseTab,
  onOpenSession,
  onTerminateSession,
  customLabels,
  onRowContextMenu,
}) {
  const signingStatus = useCommitSigningStatusContext();
  const handleRowContextMenu = (e, id, currentLabel) => {
    if (!id || !onRowContextMenu) return;
    e.preventDefault();
    onRowContextMenu(e, { id, currentLabel: currentLabel || null });
  };
  const hasOpened = sessionTabs.length > 0;
  return (
    <>
      <div className="session-menu-section" data-section="opened">
        <div className="session-menu-section-label">開いているセッション</div>
        {!hasOpened ? (
          <div className="session-menu-empty">開いているセッションはありません</div>
        ) : (
          <>
          {sessionTabs.map((tab) => {
            const isActive = tab.id === activeTabId;
            const stateClass = tab.exited ? 'is-exited' : 'is-running';
            // 状態(connected/idle/exited)は左線の色で表現するため文字では出さない。
            // 下段右端にはCLI名のみを出す。
            const statusText = appLabel(tab);
            // サーバー保存の表示名があれば優先する (未確立タブは sessionId 不在のため対象外)。
            const sessionId = tab.sessionId || tab.attachSessionId || null;
            const customLabel = sessionId ? (customLabels?.get(sessionId) ?? null) : null;
            const displayLabel = customLabel || tab.label;
            return (
              <div
                key={tab.id}
                role="none"
                className={`session-menu-item${isActive ? ' active' : ''} ${stateClass}${tab.type === 'terminal' && !tab.shell && !tab.sandbox ? ' no-sandbox' : ''}`}
                title={tab.cwd || displayLabel}
                onContextMenu={(e) => handleRowContextMenu(e, sessionId, customLabel)}
              >
                <button
                  type="button"
                  role="menuitem"
                  className="session-menu-select"
                  aria-label={`${activityAria(tab.activity)}${tab.exited ? '終了済み' : '稼働中'}: ${displayLabel}`}
                  onClick={() => { onSelectTab(tab.id); }}
                >
                  <span className="session-menu-item-top">
                    <ActivityDot activity={tab.activity} />
                    <TabIcon type={tab.type} app={tab.app} shell={tab.shell} ui={tab.ui} />
                    <span className="session-menu-label">{displayLabel}</span>
                    {(() => {
                      // 一覧ではホスト署名ありで起動したセッションにだけ鍵を出す。
                      const badge = commitSigningBadgeState(tab, signingStatus?.data);
                      if (!badge) return null;
                      return <span className={`session-badge commit-signing-${badge.state}`} title={badge.reason}>🔑</span>;
                    })()}
                    {!tab.shell && !tab.sandbox && <span className="session-badge no-sandbox">no sandbox</span>}
                    {tab.sandbox && <SandboxBadge backend={tab.sandboxBackend} />}
                  </span>
                  <span className="session-menu-status">
                                        <span className="session-menu-state">{statusText}</span>
                  </span>
                </button>
                <button
                  type="button"
                  className="tab-close session-menu-close"
                  title="タブを閉じる"
                  aria-label={`タブを閉じる: ${displayLabel}`}
                  onClick={() => { onCloseTab(tab.id); }}
                >
                  &#10005;
                </button>
              </div>
            );
          })}
          </>
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
              title={s.customLabel || s.cwd || s.id}
              onContextMenu={(e) => handleRowContextMenu(e, s.id, s.customLabel)}
            >
              <button
                type="button"
                role="menuitem"
                className="session-menu-select"
                aria-label={`${activityAria(s.activity)}${s.connected ? '稼働中' : 'アイドル'}: ${s.customLabel || s.cwd || s.id}`}
                onClick={() => { onOpenSession(s); }}
              >
                <span className="session-menu-item-top">
                  <ActivityDot activity={s.activity} />
                  <TabIcon type="terminal" app={s.app} shell={!!s.shell} ui={s.ui} />
                  <span className="session-menu-label">{s.customLabel || baseName(s.cwd) || s.id.slice(0, 8)}</span>
                  {(() => {
                    const badge = commitSigningBadgeState(s, signingStatus?.data);
                    if (!badge) return null;
                    return <span className={`session-badge commit-signing-${badge.state}`} title={badge.reason}>🔑</span>;
                  })()}
                  {s.sandbox
                    ? <SandboxBadge backend={s.sandboxBackend} />
                    : (!s.shell ? <span className="session-badge no-sandbox">no sandbox</span> : null)}
                </span>
                <span className="session-menu-status">
                  <span className="session-menu-state">{appLabel(s)}</span>
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
