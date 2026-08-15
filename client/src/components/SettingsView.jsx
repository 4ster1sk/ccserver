import { useState, useEffect, useCallback } from 'react';
import { authFetch } from '../auth.js';

function formatSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const val = bytes / Math.pow(1024, i);
  return `${i === 0 ? val : val.toFixed(1)} ${units[i]}`;
}

export default function SettingsView() {
  const [sandboxes, setSandboxes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [deleting, setDeleting] = useState(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await authFetch('/api/sandboxes');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setSandboxes(Array.isArray(data.sandboxes) ? data.sandboxes : []);
      setError(null);
    } catch (err) {
      setError(err.message || 'Failed to load sandboxes');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleDelete = async (sb) => {
    if (sb.inUse > 0) return;
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
      setSandboxes((prev) => prev.filter((s) => s.name !== sb.name));
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
        {!error && loading && <p className="settings-empty">読み込み中…</p>}
        {!error && !loading && sandboxes.length === 0 && (
          <p className="settings-empty">作成済みサンドボックスはありません。</p>
        )}
        {!error && !loading && sandboxes.length > 0 && (
          <ul className="sandbox-list">
            {sandboxes.map((sb) => (
              <li key={sb.name} className="sandbox-row">
                <div className="sandbox-body">
                  <div className="sandbox-item-top">
                    {sb.inUse > 0 && <span className="sandbox-inuse-badge">利用中</span>}
                    <span className="sandbox-size">{formatSize(sb.size)}</span>
                  </div>
                  <span className="sandbox-name" title={sb.cwd || sb.path}>
                    {sb.cwd || sb.name}
                  </span>
                </div>
                <button
                  className="sandbox-delete-btn"
                  onClick={() => handleDelete(sb)}
                  disabled={sb.inUse > 0 || deleting === sb.name}
                  title={sb.inUse > 0 ? '利用中のため削除できません' : 'サンドボックスを削除'}
                  aria-label={`${sb.cwd || sb.name} を削除`}
                >
                  &#10005;
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
