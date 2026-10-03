import { useEffect, useMemo, useRef } from 'react';

// Terminal control sequences (colors, cursor moves, OSC incl. the stage
// markers) are noise in a plain <pre>.
const ANSI_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[()][A-Z0-9]|\x1b[=>]|\r(?!\n)/g;

export function stripTerminal(text) {
  return text.replace(ANSI_RE, '').replace(/\r\n/g, '\n');
}

// The pty output of a chat session: the chat bridge, `opencode serve` and,
// for a VM, the qemu launcher. Where to look when startup fails.
export default function ChatLogPanel({ log, onClose }) {
  const text = useMemo(() => stripTerminal(log || ''), [log]);
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [text]);
  return (
    <div className="chat-log-panel">
      <div className="chat-log-header">
        <span>起動ログ</span>
        {onClose && <button type="button" className="btn chat-icon-btn" onClick={onClose} aria-label="ログを閉じる">✕</button>}
      </div>
      <pre ref={ref} className="chat-log-body">{text || '(出力はまだありません)'}</pre>
    </div>
  );
}
