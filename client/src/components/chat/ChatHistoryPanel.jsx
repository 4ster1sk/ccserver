import { useEffect, useState } from 'react';
import { ocRequest } from './chatApi.js';

function fmtTime(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return `今日 ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  }
  return d.toLocaleString([], { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

// The conversations the session's serve knows (GET /api/session), newest
// first. Picking one hands its id to onSelect; the current one and, while a
// turn runs, all of them are not pickable.
export default function ChatHistoryPanel({ sessionId, currentId, busy, switching, onSelect, onClose }) {
  const [list, setList] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    ocRequest(sessionId, 'GET', 'session')
      .then((res) => {
        if (cancelled) return;
        const data = Array.isArray(res?.data) ? res.data : [];
        setList([...data].sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0)));
      })
      .catch((err) => { if (!cancelled) setError(err.message); });
    return () => { cancelled = true; };
  }, [sessionId, currentId]);

  return (
    <div className="chat-history-panel">
      <div className="chat-log-header">
        <span>会話の履歴</span>
        <button type="button" className="btn chat-icon-btn" onClick={onClose} aria-label="履歴を閉じる">✕</button>
      </div>
      <div className="chat-history-list">
        {error && <div className="chat-msg-error">{error}</div>}
        {!error && !list && <div className="chat-history-empty">読み込み中…</div>}
        {list && list.length === 0 && <div className="chat-history-empty">会話はまだありません</div>}
        {busy && list && list.length > 1 && <div className="chat-history-empty">実行中は切り替えられません</div>}
        {list && list.map((s) => {
          const current = s.id === currentId;
          return (
            <button
              key={s.id}
              type="button"
              className={`chat-history-item${current ? ' current' : ''}`}
              disabled={current || busy || switching}
              onClick={() => onSelect(s.id)}
            >
              <span className="chat-history-title">{s.title || '(無題)'}</span>
              <span className="chat-history-meta">
                {fmtTime(s.time?.updated ?? s.time?.created)}
                {current && <span className="chat-history-current">● 現在</span>}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
