import { useState, useEffect, useCallback, useMemo } from 'react';
import { authFetch } from '../auth.js';

// 許可/拒否リストの重なり検出 (保存は許容し拒否優先、GUIで警告する用)。
// 両リストとも完全一致か先頭ドット suffix の記法を想定し、小文字・trim
// 済みとして比較する。 exact×exact、exact×suffix、suffix×suffix の包含を
// すべて重なりとみなす (例: 許可 api.example.com × 拒否 .example.com)。
function allowDenyPairOverlaps(a, d) {
  if (!a || !d) return false;
  if (a === d) return true;
  const aSuffix = a.startsWith('.');
  const dSuffix = d.startsWith('.');
  if (aSuffix && dSuffix) {
    const A = a.slice(1);
    const B = d.slice(1);
    return A === B || A.endsWith(`.${B}`) || B.endsWith(`.${A}`);
  }
  if (aSuffix) return d === a.slice(1) || d.endsWith(a);
  if (dSuffix) return a === d.slice(1) || a.endsWith(d);
  return false;
}

export function findAllowDenyOverlaps(allowed, denied) {
  const norm = (v) => (typeof v === 'string' ? v.trim().toLowerCase() : '');
  const aList = [...new Set((Array.isArray(allowed) ? allowed : []).map(norm).filter(Boolean))];
  const dList = [...new Set((Array.isArray(denied) ? denied : []).map(norm).filter(Boolean))];
  const out = [];
  for (const a of aList) {
    for (const d of dList) {
      if (allowDenyPairOverlaps(a, d)) out.push({ allow: a, deny: d });
    }
  }
  return out;
}

function parseHostLines(text) {
  return (typeof text === 'string' ? text : '').split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
}

// ネットワーク隔離設定 (sandbox.config.json の network.mode / allowedHosts /
// deniedHosts) の GUI 編集。保存はファイルへ書き込み (次回起動から適用) ＋
// 実行中の隔離セッション全件へ許可・拒否リストと mode を自動反映し、件数を
// 報告する。deniedHosts は許可・open・audit に優先して常に拒否。VMセッションは
// 常に open で起動し、enforce/open 切替は各セッションの 🌐 トグルで行う。
export default function NetworkIsolationSection() {
  const [mode, setMode] = useState('enforce');
  const [hostsText, setHostsText] = useState('');
  const [deniedHostsText, setDeniedHostsText] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [liveApplied, setLiveApplied] = useState(null);

  const overlaps = useMemo(
    () => findAllowDenyOverlaps(parseHostLines(hostsText), parseHostLines(deniedHostsText)),
    [hostsText, deniedHostsText],
  );

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await authFetch('/api/network-settings');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const s = data.settings || {};
      setMode(s.mode === 'audit' ? 'audit' : 'enforce');
      setHostsText(Array.isArray(s.allowedHosts) ? s.allowedHosts.join('\n') : '');
      setDeniedHostsText(Array.isArray(s.deniedHosts) ? s.deniedHosts.join('\n') : '');
    } catch (err) {
      setError(err.message || '設定の読み込みに失敗しました');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleSave = async () => {
    const hosts = parseHostLines(hostsText);
    const denied = parseHostLines(deniedHostsText);
    // Reuse the already-memoized value (derived from the same hostsText/
    // deniedHostsText state above) instead of recomputing the O(allow×deny)
    // overlap scan from scratch.
    const overlapNote = overlaps.length > 0
      ? `\n⚠️ 許可と拒否の重複 ${overlaps.length} 件あり (拒否が優先されます):\n${overlaps.slice(0, 5).map((o) => `- 許可「${o.allow}」× 拒否「${o.deny}」`).join('\n')}${overlaps.length > 5 ? `\n他 ${overlaps.length - 5} 件` : ''}`
      : '';
    if (!window.confirm(`ネットワーク隔離設定を保存しますか？\n- mode: ${mode}\n- allowedHosts: ${hosts.length} 件\n- deniedHosts: ${denied.length} 件${overlapNote}\n実行中の隔離セッションへも自動反映されます。`)) return;
    setSaving(true);
    setSaveError(null);
    setLiveApplied(null);
    try {
      const res = await authFetch('/api/network-settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode, allowedHosts: hosts, deniedHosts: denied }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      const s = body.settings || {};
      setMode(s.mode === 'audit' ? 'audit' : 'enforce');
      setHostsText(Array.isArray(s.allowedHosts) ? s.allowedHosts.join('\n') : '');
      setDeniedHostsText(Array.isArray(s.deniedHosts) ? s.deniedHosts.join('\n') : '');
      setLiveApplied(body.liveApplied || { ok: 0, failed: 0 });
    } catch (err) {
      setSaveError(err.message || '保存に失敗しました');
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <section className="settings-section"><h3>ネットワーク隔離</h3><div className="loading">Loading...</div></section>;

  return (
    <section className="settings-section">
      <h3>ネットワーク隔離</h3>
      {error && <div className="error">Error: {error}</div>}
      <p className="settings-hint">
        VMセッションは常に open (制限なし) で起動します。許可リストのみに制限するには、各セッションの 🌐 トグルで enforce に切り替えてください (再起動不要)。
      </p>
      <div className="general-setting-row">
        <label htmlFor="network-mode-select">動作モード (mode)</label>
        <select
          id="network-mode-select"
          value={mode}
          onChange={(e) => setMode(e.target.value === 'audit' ? 'audit' : 'enforce')}
        >
          <option value="enforce">enforce (許可外をブロック)</option>
          <option value="audit">audit (ブロックせず記録のみ)</option>
        </select>
      </div>
      <p className="settings-hint">
        audit は全通信を通しつつ判定を記録します (許可セット洗い出し用)。保存すると実行中の隔離セッションへも即時反映されます (常駐VMでは同じVMの全セッションに効きます)。
      </p>
      <div className="general-setting-row">
        <label htmlFor="network-allowlist-input">許可ホスト (allowedHosts、1行1件)</label>
      </div>
      <textarea
        id="network-allowlist-input"
        className="open-menu-instructions"
        placeholder={'例:\napi.anthropic.com\n.opencode.ai\nregistry.npmjs.org'}
        value={hostsText}
        onChange={(e) => setHostsText(e.target.value)}
        rows={8}
      />
      <p className="settings-hint">
        完全一致か先頭ドット (サブドメイン含む) のみ有効です。scheme・ポート・`*` は不可。小文字化・重複除去されます。空＋enforce は全拒否になります。
      </p>
      <div className="general-setting-row">
        <label htmlFor="network-denylist-input">拒否ホスト (deniedHosts、1行1件)</label>
      </div>
      <textarea
        id="network-denylist-input"
        className="open-menu-instructions"
        placeholder={'例:\nmalicious.example\n.telemetry.example.com'}
        value={deniedHostsText}
        onChange={(e) => setDeniedHostsText(e.target.value)}
        rows={5}
      />
      <p className="settings-hint">
        許可・一時解除 (open)・audit に関わらず常に拒否されます。記法は許可と同じです (完全一致か先頭ドットのみ)。
      </p>
      {overlaps.length > 0 && (
        <div className="error">
          ⚠️ 許可と拒否が重複しています (拒否が優先されます、{overlaps.length} 件):
          <br />
          {overlaps.slice(0, 5).map((o) => `許可「${o.allow}」× 拒否「${o.deny}」`).join('／')}
          {overlaps.length > 5 ? `／他 ${overlaps.length - 5} 件` : ''}
        </div>
      )}
      <div className="resume-actions">
        <button className="btn btn-secondary" onClick={refresh} disabled={saving}>
          再読込
        </button>
        <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
          {saving ? '保存中...' : '保存'}
        </button>
      </div>
      {saveError && <div className="error">Error: {saveError}</div>}
      {liveApplied && (
        <p className="settings-hint">
          保存しました。実行中 {liveApplied.ok} セッションへ即時反映
          {liveApplied.failed > 0 ? ` (${liveApplied.failed} 件失敗)` : ''}。
        </p>
      )}
      {!liveApplied && (
        <p className="settings-hint">
          保存内容は新規起動から適用され、mode と許可・拒否リストは実行中の隔離セッションへも自動反映されます。
        </p>
      )}
    </section>
  );
}
