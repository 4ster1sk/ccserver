import { useEffect, useState } from 'react';

// The stages the server reports (server/ws/chatStages.js), plus 'connect':
// the client's own wait for the launch to be accepted, before the server has
// a session (and stage list) to report.
const LABELS = {
  connect: 'セッションを起動中…',
  sandbox: 'サンドボックスを準備中…',
  vm_boot: 'VM 起動中…',
  vm_setup: 'VM セットアップ中…',
  opencode: 'opencode を起動中…',
  session: 'セッションを作成中…',
};

function elapsed(stage, now) {
  if (!stage.startedAt) return null;
  const end = stage.endedAt || now;
  return `${Math.max(0, (end - stage.startedAt) / 1000).toFixed(1)}s`;
}

function StageIcon({ state }) {
  if (state === 'done') return <span className="chat-stage-icon chat-stage-icon--done" aria-label="完了">✔</span>;
  if (state === 'error') return <span className="chat-stage-icon chat-stage-icon--error" aria-label="失敗">✖</span>;
  if (state === 'running') return <span className="chat-spinner" aria-label="実行中" />;
  return <span className="chat-stage-icon chat-stage-icon--pending" aria-label="未着手">○</span>;
}

// The "⟳ VM 起動中…" list shown until the conversation opens. `stages` is
// null until the server's first chat_state arrives; `launchError` is a
// launch refused before any stage ran.
export default function StartupProgress({ stages, launchError, exited, onShowLog, logOpen, onRelaunch }) {
  const [now, setNow] = useState(Date.now());
  const running = !launchError && !exited && (!stages || stages.some((s) => s.state === 'running' || s.state === 'pending'));
  useEffect(() => {
    if (!running) return undefined;
    const t = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(t);
  }, [running]);

  const list = stages || [{ id: 'connect', state: launchError ? 'error' : 'running', startedAt: null, endedAt: null, message: launchError }];
  const failed = list.find((s) => s.state === 'error');
  const errorText = launchError || failed?.message || (exited ? `プロセスが終了しました (code ${exited.exitCode})` : null);

  return (
    <div className="chat-startup" role="status" aria-live="polite">
      <div className="chat-startup-title">{errorText ? 'セッションを開始できませんでした' : 'セッションを準備しています'}</div>
      <ol className="chat-stage-list">
        {list.map((s) => (
          <li key={s.id} className={`chat-stage chat-stage--${s.state}`}>
            <StageIcon state={s.state} />
            <span className="chat-stage-label">{LABELS[s.id] || s.id}</span>
            <span className="chat-stage-time">{elapsed(s, now) || ''}</span>
          </li>
        ))}
      </ol>
      {errorText && <div className="chat-startup-error">{errorText}</div>}
      <div className="chat-startup-actions">
        <button type="button" className="btn btn-secondary" onClick={onShowLog}>
          {logOpen ? '▾ 起動ログを隠す' : '▸ 起動ログを表示'}
        </button>
        {(errorText || exited) && onRelaunch && (
          <button type="button" className="btn btn-primary" onClick={onRelaunch}>再起動</button>
        )}
      </div>
    </div>
  );
}
