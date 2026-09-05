import { pctClass, paceMark } from './useUsage.js';

// UsageButton (popover) と UsageWidget (sidebar) で共有する limits/empty
// 表示。二重管理による乖離を避けるため、見た目の差異は作らないこと。
export default function UsageLimits({ limits, loading, error, now = Date.now() }) {
  if (limits.length === 0) {
    return (
      <div className="usage-empty">
        {loading ? '読み込み中…' : (error ? `取得できませんでした: ${error}` : 'データがありません')}
      </div>
    );
  }
  return (
    <div className="usage-limits">
      {limits.map((l, i) => {
        const pace = paceMark(l, now);
        const over = pace != null && l.pct > pace + 1;
        return (
          <div className="usage-limit" key={`${l.label}#${i}`}>
            <div className="usage-limit-top">
              <span className="usage-limit-label">{l.label}</span>
              <span className="usage-limit-pct">{l.pct}%</span>
            </div>
            <div className="usage-bar-wrap">
              <div className="usage-bar">
                <div className={pctClass(l.pct)} style={{ width: `${Math.min(100, l.pct)}%` }} />
              </div>
              {pace != null && (
                <div
                  className={`usage-pace${over ? ' over' : ''}`}
                  style={{ left: `${pace}%` }}
                  title={`妥当なペースの目安 ${Math.round(pace)}%（経過時間ぶん）${over ? ' · ペース超過' : ''}`}
                />
              )}
            </div>
            {(l.resets || pace != null) && (
              <div className="usage-limit-reset">
                {l.resets && `リセット: ${l.resets}`}
                {pace != null && `${l.resets ? ' · ' : ''}目安 ${Math.round(pace)}%`}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
