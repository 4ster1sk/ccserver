import { useCallback, useState } from 'react';

// Auto-Y pieces shared by TerminalView and ChatView: the log of what was
// auto-approved, and the confirmation before enabling it outside a sandbox.

const SKIP_NOSANDBOX_AUTOY_WARNING_KEY = 'ccserver-skip-nosandbox-autoy-warning';

export function AutoYesLogPanel({ log, onClose }) {
  return (
    <div className="auto-yes-log">
      <div className="auto-yes-log-header">
        <span>Auto-Yes Log ({log.length})</span>
        <button className="btn btn-secondary btn-sm" onClick={onClose}>&#10005;</button>
      </div>
      <div className="auto-yes-log-list">
        {[...log].reverse().map((entry, i) => (
          <div key={log.length - 1 - i} className="auto-yes-log-entry">
            <span className="auto-yes-log-time">{new Date(entry.time).toLocaleTimeString()}</span>
            <span className="auto-yes-log-prompt">{entry.prompt}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// toggle(next) asks first when enabling outside a sandbox (there is no
// isolation to catch an auto-approved destructive operation), unless the
// user dismissed that for good. `dialog` is the element to render.
export function useAutoYesToggle({ sandbox, send }) {
  const [showWarning, setShowWarning] = useState(false);
  const [dontAsk, setDontAsk] = useState(false);
  const [skipWarning, setSkipWarning] = useState(
    () => localStorage.getItem(SKIP_NOSANDBOX_AUTOY_WARNING_KEY) === '1'
  );

  const toggle = useCallback((next) => {
    if (next && !sandbox && !skipWarning) {
      setShowWarning(true);
      return;
    }
    send({ type: 'set_auto_yes', enabled: next });
  }, [sandbox, skipWarning, send]);

  // Confirm the warning: persist the dismiss flag if checked, then send the
  // enable exactly as the toggle would have.
  const confirm = useCallback(() => {
    if (dontAsk) {
      localStorage.setItem(SKIP_NOSANDBOX_AUTOY_WARNING_KEY, '1');
      setSkipWarning(true);
    }
    setShowWarning(false);
    send({ type: 'set_auto_yes', enabled: true });
  }, [dontAsk, send]);

  const dialog = showWarning ? (
    <div className="resume-overlay" onClick={() => setShowWarning(false)}>
      <div className="resume-dialog" onClick={(e) => e.stopPropagation()}>
        <h3>サンドボックス外でAuto-Yを有効にしますか?</h3>
        <p>このセッションはサンドボックスで隔離されていません。Auto-Yは権限確認プロンプトをすべて自動承認するため、ファイル削除やコマンド実行などの操作が確認なしにホスト環境へ直接反映されます。</p>
        <label className="close-confirm-checkbox">
          <input
            type="checkbox"
            checked={dontAsk}
            onChange={(e) => setDontAsk(e.target.checked)}
          />
          次回以降確認しない
        </label>
        <div className="resume-actions">
          <button className="btn btn-secondary" onClick={() => setShowWarning(false)}>
            キャンセル
          </button>
          <button className="btn btn-primary" onClick={confirm}>
            有効にする
          </button>
        </div>
      </div>
    </div>
  ) : null;

  return { toggle, dialog };
}
