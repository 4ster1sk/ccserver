import { useState, useEffect, useCallback, useRef } from 'react';
import { authFetch } from '../auth.js';

function formatSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const val = bytes / Math.pow(1024, i);
  return `${i === 0 ? val : val.toFixed(1)} ${units[i]}`;
}

// sandboxes.lastUsedAt (INTEGER ms, plan §2 v2) -> "YYYY/MM/DD HH:MM" in the
// browser's local timezone. Returns null when absent/unparseable so older
// servers without the field render nothing instead of "Invalid Date".
function formatLastUsed(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function SettingsView() {
  const [sandboxes, setSandboxes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [deleting, setDeleting] = useState(null);
  // Guards against overlapping polls: setInterval starts a new fetch even if
  // the previous one is still outstanding, and a slow stale response could
  // then clobber a newer one.
  const refreshingRef = useRef(false);

  // loading only covers the very first load; later refreshes keep the list
  // mounted (toggling it per poll made the whole list flash every 1.5s).
  const refresh = useCallback(async () => {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    try {
      const res = await authFetch('/api/sandboxes');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setSandboxes(Array.isArray(data.sandboxes) ? data.sandboxes : []);
      setError(null);
    } catch (err) {
      setError(err.message || 'Failed to load sandboxes');
    } finally {
      refreshingRef.current = false;
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Deletion runs server-side in the background; keep polling until every
  // "削除中" row either disappears or reports a deleteError.
  const anyDeleting = sandboxes.some((sb) => sb.deleting);

  useEffect(() => {
    if (!anyDeleting) return undefined;
    const timer = setInterval(refresh, 1500);
    return () => clearInterval(timer);
  }, [anyDeleting, refresh]);

  const handleDelete = async (sb) => {
    if (sb.inUse > 0 || sb.deleting) return;
    const label = sb.cwd || sb.name;
    if (!window.confirm(`サンドボックス "${label}" を削除しますか？\n永続環境と docker キャッシュを削除します（取り消せません）。`)) return;
    setDeleting(sb.name);
    try {
      const res = await authFetch(`/api/sandboxes/${encodeURIComponent(sb.name)}`, { method: 'DELETE' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        window.alert(body.error || `削除に失敗しました (HTTP ${res.status})`);
        return;
      }
      // The removal itself continues in the background; the refreshed list
      // marks the row as 削除中 until it is gone.
      await refresh();
    } catch (err) {
      window.alert(`削除に失敗しました: ${err.message}`);
    } finally {
      setDeleting(null);
    }
  };

  return (
    <div className="settings-view">
      <div className="settings-header">
        <h2>Settings</h2>
        <button className="btn btn-secondary" onClick={refresh} disabled={loading}>
          Refresh
        </button>
      </div>
      <section className="settings-section">
        <h3>作成済みサンドボックス</h3>
        {error && <p className="settings-error">読み込みに失敗しました: {error}</p>}
        {loading && <p className="settings-empty">読み込み中…</p>}
        {!loading && sandboxes.length === 0 && (
          <p className="settings-empty">作成済みサンドボックスはありません。</p>
        )}
        {!loading && sandboxes.length > 0 && (
          <ul className="sandbox-list">
            {sandboxes.map((sb) => {
              const lastUsed = formatLastUsed(sb.lastUsedAt);
              return (
                <li key={sb.name} className="sandbox-row">
                  <div className="sandbox-body">
                    <div className="sandbox-item-top">
                      {sb.deleting && <span className="sandbox-deleting-badge">削除中…</span>}
                      {!sb.deleting && sb.inUse > 0 && <span className="sandbox-inuse-badge">利用中</span>}
                      <span className="sandbox-size">{formatSize(sb.size)}</span>
                      {lastUsed && (
                        <span className="sandbox-last-used" title={`最終使用: ${lastUsed}`}>
                          最終使用 {lastUsed}
                        </span>
                      )}
                    </div>
                    {/* projectLabel / gitRemote come from the sandboxes x
                        projects JOIN (plan §2 v2); both are optional -- rows
                        from an older server simply omit the extra lines. */}
                    <div className="sandbox-info">
                      {sb.projectLabel && (
                        <span className="sandbox-project-label" title={sb.projectLabel}>
                          {sb.projectLabel}
                        </span>
                      )}
                      <span className="sandbox-name" title={sb.cwd || sb.path}>
                        {sb.cwd || sb.name}
                      </span>
                      {sb.gitRemote && (
                        <span className="sandbox-git-remote" title={sb.gitRemote}>
                          {sb.gitRemote}
                        </span>
                      )}
                    </div>
                    {sb.deleteError && <p className="sandbox-delete-error">{sb.deleteError}</p>}
                  </div>
                  <button
                    className="sandbox-delete-btn"
                    onClick={() => handleDelete(sb)}
                    disabled={sb.inUse > 0 || sb.deleting || deleting === sb.name}
                    title={sb.deleting ? '削除中のため操作できません' : sb.inUse > 0 ? '利用中のため削除できません' : 'サンドボックスを削除'}
                    aria-label={`${sb.cwd || sb.name} を削除`}
                  >
                    &#10005;
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
