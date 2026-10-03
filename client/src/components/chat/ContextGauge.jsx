import { useEffect, useMemo, useRef, useState } from 'react';
import { contextLimit, formatTokens, lastUsage, sessionTotals } from './contextUsage.js';

const RADIUS = 7;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

function level(ratio) {
  if (ratio >= 0.9) return 'danger';
  if (ratio >= 0.7) return 'warn';
  return 'ok';
}

// A ring showing how full the context is; tapping it opens the breakdown.
export default function ContextGauge({ messages, models, model }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);

  const usage = useMemo(() => lastUsage(messages), [messages]);
  const totals = useMemo(() => sessionTotals(messages), [messages]);
  const limit = contextLimit(models, model);
  const ratio = usage && limit ? Math.min(usage.used / limit, 1) : 0;
  const percent = usage && limit ? Math.round((usage.used / limit) * 100) : null;

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (!rootRef.current?.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const label = percent !== null
    ? `コンテキスト ${percent}%`
    : usage ? `コンテキスト ${formatTokens(usage.used)} トークン` : 'コンテキスト使用量';
  const t = usage?.tokens;

  return (
    <div ref={rootRef} className="chat-context">
      <button
        type="button"
        className={`chat-context-gauge chat-context-gauge--${percent !== null ? level(ratio) : 'none'}`}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={label}
        title={label}
      >
        <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
          <circle className="chat-context-track" cx="9" cy="9" r={RADIUS} />
          {percent !== null && (
            <circle
              className="chat-context-fill"
              cx="9"
              cy="9"
              r={RADIUS}
              strokeDasharray={`${CIRCUMFERENCE * ratio} ${CIRCUMFERENCE}`}
              transform="rotate(-90 9 9)"
            />
          )}
        </svg>
        {percent !== null && <span className="chat-context-percent">{percent}%</span>}
      </button>
      {open && (
        <div className="chat-context-popover" role="dialog" aria-label="コンテキスト使用量">
          {!usage ? (
            <div className="chat-context-empty">
              まだ使用量はありません
              {limit && <div className="chat-context-sub">上限 {formatTokens(limit)} トークン</div>}
            </div>
          ) : (
            <>
              <div className="chat-context-head">
                <span>コンテキスト</span>
                <span>
                  {percent !== null && <strong>{percent}% </strong>}
                  {formatTokens(usage.used)}{limit ? ` / ${formatTokens(limit)}` : ''}
                </span>
              </div>
              {percent !== null && (
                <div className="chat-context-bar">
                  <div className={`chat-context-bar-fill chat-context-bar-fill--${level(ratio)}`} style={{ width: `${ratio * 100}%` }} />
                </div>
              )}
              <dl className="chat-context-rows">
                <dt>入力</dt><dd>{formatTokens(t.input || 0)}</dd>
                <dt>キャッシュ読込</dt><dd>{formatTokens(t.cache?.read || 0)}</dd>
                <dt>キャッシュ書込</dt><dd>{formatTokens(t.cache?.write || 0)}</dd>
                <dt>出力</dt><dd>{formatTokens(t.output || 0)}</dd>
                {t.reasoning > 0 && <><dt>思考</dt><dd>{formatTokens(t.reasoning)}</dd></>}
              </dl>
              <div className="chat-context-sub">
                セッション累計 {formatTokens(totals.tokens)} トークン
                {totals.cost !== null && ` · $${totals.cost.toFixed(2)}`}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
