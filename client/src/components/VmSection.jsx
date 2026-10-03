import { useState, useEffect, useCallback } from 'react';
import { authFetch } from '../auth.js';
import { formatSize } from '../formatSize.js';
import { useVisiblePolling } from '../hooks/useVisiblePolling.js';

// QEMU VM 管理 (サンドボックス方式で VM を選んだ起動に使われる)。
//  - テンプレート: リソース量 + 追加 cloud-config (YAML) の作成/編集/削除と既定の指定。
//    サンドボックス起動オプションで選択し、未選択時は既定テンプレート、
//    それも無ければ sandbox.config.json の qemu 値で起動する。
//  - 稼働中VM: qemu セッションの VM 一覧と停止 (= セッション終了、overlay 破棄)。
//    常駐VM (persistent テンプレート) は VM 単位で1行に出し、乗っている
//    セッションか、アイドル中なら停止予定時刻を表示する。停止は VM 本体を
//    止め、乗っているセッションも終了する。
//  - 常駐VM: アイドル停止までの時間 (分)。
//  - エージェントの認証: VM のネットワークブローカーが注入する認証情報。
//    値は書き込み専用で、画面には設定済みかどうかだけが返る。
// テンプレートは起動時にのみ読まれるため、編集/削除は稼働中VMに影響しない。

const RESOURCE_FIELDS = [
  { key: 'cpus', label: 'CPU', unit: 'コア' },
  { key: 'memoryMiB', label: 'メモリ', unit: 'MiB' },
  { key: 'diskGiB', label: 'ディスク', unit: 'GiB' },
  { key: 'bootTimeoutSec', label: '起動タイムアウト', unit: '秒' },
];

const CLOUD_CONFIG_PLACEHOLDER = `#cloud-config
packages:
  - htop
runcmd:
  - echo "hello" > /etc/motd`;

function formatTime(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function resourceSummary(t) {
  return `${t.cpus} CPU / ${t.memoryMiB} MiB / ${t.diskGiB} GiB`;
}

async function readError(res) {
  const body = await res.json().catch(() => ({}));
  return body.error || `HTTP ${res.status}`;
}

function TemplateForm({ initial, info, onCancel, onSaved }) {
  const [form, setForm] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const setNumber = (key, value) => setForm((f) => ({ ...f, [key]: value === '' ? '' : Number(value) }));

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const { id, ...body } = form;
      const res = await authFetch(id ? `/api/vm-templates/${encodeURIComponent(id)}` : '/api/vm-templates', {
        method: id ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(await readError(res));
      onSaved();
    } catch (err) {
      setError(err.message || '保存に失敗しました');
    } finally {
      setSaving(false);
    }
  };

  const hostMax = { cpus: info.host.cpus, memoryMiB: info.host.totalMemMiB };

  return (
    <form className="vm-form" onSubmit={handleSubmit}>
      <h4>{form.id ? 'テンプレートを編集' : '新しいテンプレート'}</h4>
      <div className="general-setting-row">
        <label htmlFor="vm-template-name">名前</label>
        <input
          id="vm-template-name"
          type="text"
          value={form.name}
          maxLength={64}
          onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
          required
        />
      </div>
      <div className="vm-resource-grid">
        {RESOURCE_FIELDS.map(({ key, label, unit }) => {
          const lim = info.limits[key];
          return (
            <label key={key} className="vm-resource-field">
              <span>{label} ({unit})</span>
              <input
                type="number"
                min={lim.min}
                max={lim.max}
                step={1}
                value={form[key]}
                onChange={(e) => setNumber(key, e.target.value)}
                required
              />
              <span className="vm-resource-hint">
                {lim.min}〜{lim.max}
                {hostMax[key] ? ` (ホスト: ${hostMax[key]})` : ''}
              </span>
            </label>
          );
        })}
      </div>
      <label className="vm-persistent-option">
        <input
          type="checkbox"
          checked={!!form.persistent}
          onChange={(e) => setForm((f) => ({ ...f, persistent: e.target.checked }))}
        />
        <span>常駐VMで共有する</span>
      </label>
      <p className="settings-hint">
        オンにすると、このテンプレートのセッションは1台のVMを共有し、それぞれVM内のbwrapで隔離されます。プロジェクトと永続HOMEはセッション開始時にマウントされ、使うセッションが無くなると外されます。VMは最後のセッションが終わってから、下の「常駐VM」で設定した時間 (既定 2 時間) 使われないと停止します。
        今のところ git broker・GPG vault・ssh-agent・MCP 連携とセッション中のネットワーク切替は使えません。
      </p>
      <div className="general-setting-row">
        <label htmlFor="vm-template-cloud-config">追加 cloud-config (YAML)</label>
      </div>
      <textarea
        id="vm-template-cloud-config"
        className="vm-cloud-config"
        placeholder={CLOUD_CONFIG_PLACEHOLDER}
        value={form.cloudConfig}
        onChange={(e) => setForm((f) => ({ ...f, cloudConfig: e.target.value }))}
        rows={12}
        spellCheck={false}
      />
      <p className="settings-hint">
        使えるキー: {info.cloudConfigKeys.join(', ')}。ccserver のセッション設定 (ユーザー作成・マウント・ssh 鍵) の後に root で実行され、runcmd やパッケージ導入が失敗すると起動失敗になります。
        packages / apt はブート時にネットワークを使うため、ネットワーク隔離中は deb.debian.org などを許可ホストに追加し、必要なら起動タイムアウトを延ばしてください。
      </p>
      {error && <div className="error vm-form-error">{error}</div>}
      <div className="resume-actions">
        <button type="button" className="btn btn-secondary" onClick={onCancel} disabled={saving}>キャンセル</button>
        <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? '保存中...' : '保存'}</button>
      </div>
    </form>
  );
}

function TemplatesBlock({ info, refresh }) {
  const [editing, setEditing] = useState(null); // null | form initial values
  const [busy, setBusy] = useState(null);

  const startNew = () => setEditing({ name: '', ...info.fallback, cloudConfig: '', persistent: !!info.fallback.persistent });
  const startEdit = (t) => setEditing({
    id: t.id, name: t.name, cpus: t.cpus, memoryMiB: t.memoryMiB, diskGiB: t.diskGiB, bootTimeoutSec: t.bootTimeoutSec, cloudConfig: t.cloudConfig, persistent: !!t.persistent,
  });

  const setDefault = async (id) => {
    setBusy(id ?? 'default');
    try {
      const res = await authFetch('/api/vm-templates-default', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      if (!res.ok) window.alert(await readError(res));
      await refresh();
    } finally {
      setBusy(null);
    }
  };

  const handleDelete = async (t) => {
    if (!window.confirm(`テンプレート "${t.name}" を削除しますか？\n稼働中のVMには影響しません。このテンプレートを選んでいたディレクトリは次回起動時にエラーになります。`)) return;
    setBusy(t.id);
    try {
      const res = await authFetch(`/api/vm-templates/${encodeURIComponent(t.id)}`, { method: 'DELETE' });
      if (!res.ok) window.alert(await readError(res));
      await refresh();
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="settings-section">
      <div className="settings-section-header">
        <h3>VMテンプレート</h3>
        {!editing && <button className="btn btn-secondary" onClick={startNew}>新規作成</button>}
      </div>
      <p className="settings-hint">
        テンプレート未選択時は既定テンプレート、既定も無ければ sandbox.config.json の値 ({resourceSummary(info.fallback)}) で起動します。
      </p>
      {editing && (
        <TemplateForm
          key={editing.id || 'new'}
          initial={editing}
          info={info}
          onCancel={() => setEditing(null)}
          onSaved={async () => { setEditing(null); await refresh(); }}
        />
      )}
      {info.templates.length === 0 && !editing && <p className="settings-empty">テンプレートはまだありません。</p>}
      {info.templates.length > 0 && (
        <ul className="sandbox-list">
          {info.templates.map((t) => {
            const isDefault = info.defaultTemplateId === t.id;
            return (
              <li key={t.id} className="sandbox-row vm-template-row">
                <div className="sandbox-body">
                  <div className="sandbox-item-top">
                    {isDefault && <span className="sandbox-inuse-badge">既定</span>}
                    {t.persistent && <span className="sandbox-inuse-badge">常駐VM</span>}
                    <span className="sandbox-size">{resourceSummary(t)}</span>
                  </div>
                  <div className="sandbox-info">
                    <span className="sandbox-project-label" title={t.name}>{t.name}</span>
                    {t.cloudConfig.trim() && <span className="sandbox-git-remote">cloud-config あり</span>}
                  </div>
                </div>
                <div className="vm-row-actions">
                  <button className="btn btn-secondary" onClick={() => startEdit(t)} disabled={busy === t.id}>編集</button>
                  <button
                    className="btn btn-secondary"
                    onClick={() => setDefault(isDefault ? null : t.id)}
                    disabled={busy !== null}
                  >
                    {isDefault ? '既定を解除' : '既定にする'}
                  </button>
                  <button
                    className="sandbox-delete-btn"
                    onClick={() => handleDelete(t)}
                    disabled={busy === t.id}
                    title="テンプレートを削除"
                    aria-label={`${t.name} を削除`}
                  >
                    &#10005;
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function AgentAuthBlock({ info, refresh }) {
  const [token, setToken] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const configured = info.agentAuth?.claude;

  const save = async (value) => {
    setSaving(true);
    setError(null);
    try {
      const res = await authFetch('/api/vm-agent-auth', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ claudeOAuthToken: value }),
      });
      if (!res.ok) throw new Error(await readError(res));
      setToken('');
      await refresh();
    } catch (err) {
      setError(err.message || '保存に失敗しました');
    } finally {
      setSaving(false);
    }
  };

  const handleSave = (e) => {
    e.preventDefault();
    save(token.trim());
  };

  const handleClear = () => {
    if (!window.confirm('VM 用の Claude トークンを削除しますか？\n次の起動から、VM 内の Claude はログインしていない状態になります。')) return;
    save(null);
  };

  return (
    <section className="settings-section">
      <h3>エージェントの認証</h3>
      <p className="settings-hint">
        VM 内のエージェントには本物の認証情報を渡しません。VM にはダミーの値だけを渡し、ネットワークブローカーが API への通信に本物を付けます (HTTPS の傍受が有効なときだけ)。エージェントの本体は、ホストにインストールされているものを読み取り専用で共有します。
      </p>
      <form className="vm-pool-settings" onSubmit={handleSave}>
        <label className="vm-resource-field">
          <span>Claude のトークン ({configured ? '設定済み' : '未設定'})</span>
          <input
            type="password"
            autoComplete="off"
            placeholder="sk-ant-oat01-..."
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
          <span className="vm-resource-hint">ホストで <code>claude setup-token</code> を実行して表示される値 (1年有効)</span>
        </label>
        <button type="submit" className="btn btn-primary" disabled={saving || !token.trim()}>{saving ? '保存中...' : (configured ? '置き換え' : '保存')}</button>
        {configured && <button type="button" className="btn" onClick={handleClear} disabled={saving}>削除</button>}
      </form>
      <OpencodeKeysBlock info={info} refresh={refresh} />
      <p className="settings-hint">
        変更は次の起動から使われます。常駐VMは新しい値で別に起動し、古い値の常駐VMは、乗っているセッションが終わるとアイドル停止の対象になります。
      </p>
      {error && <div className="error vm-form-error">{error}</div>}
    </section>
  );
}

function OpencodeKeysBlock({ info, refresh }) {
  const [provider, setProvider] = useState('');
  const [key, setKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const providers = info.agentAuth?.opencode || [];

  const save = async (id, value) => {
    setSaving(true);
    setError(null);
    try {
      const res = await authFetch('/api/vm-agent-auth', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ opencodeApiKey: { provider: id, key: value } }),
      });
      if (!res.ok) throw new Error(await readError(res));
      setKey('');
      if (value !== null) setProvider('');
      await refresh();
    } catch (err) {
      setError(err.message || '保存に失敗しました');
    } finally {
      setSaving(false);
    }
  };

  const handleSave = (e) => {
    e.preventDefault();
    save(provider.trim(), key.trim());
  };

  const handleClear = (id) => {
    if (!window.confirm(`VM 用の opencode のキー (${id}) を削除しますか？`)) return;
    save(id, null);
  };

  const replacing = providers.includes(provider.trim());

  return (
    <>
      <h4>opencode の API キー</h4>
      {providers.length > 0 && (
        <ul className="sandbox-list">
          {providers.map((id) => (
            <li key={id} className="sandbox-row vm-template-row">
              <div className="sandbox-body">
                <div className="sandbox-info">
                  <span className="sandbox-project-label" title={id}>{id}</span>
                  <span className="sandbox-git-remote">設定済み</span>
                </div>
              </div>
              <div className="vm-row-actions">
                <button type="button" className="btn btn-secondary" onClick={() => setProvider(id)} disabled={saving}>置き換え</button>
                <button type="button" className="btn" onClick={() => handleClear(id)} disabled={saving}>削除</button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <form className="vm-pool-settings" onSubmit={handleSave}>
        <label className="vm-resource-field">
          <span>プロバイダ ID</span>
          <input
            type="text"
            autoComplete="off"
            placeholder="sakura, opencode-go など"
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
          />
        </label>
        <label className="vm-resource-field">
          <span>API キー</span>
          <input
            type="password"
            autoComplete="off"
            value={key}
            onChange={(e) => setKey(e.target.value)}
          />
        </label>
        <button type="submit" className="btn btn-primary" disabled={saving || !provider.trim() || !key.trim()}>{saving ? '保存中...' : (replacing ? '置き換え' : '追加')}</button>
      </form>
      <p className="settings-hint">
        接続先とヘッダは、起動のたびにホストの opencode 設定 (<code>~/.config/opencode</code> の provider 節) か組み込みの表 (opencode, opencode-go, openrouter, deepseek, anthropic, openai) から決まります。VM の opencode には、そのプロバイダの定義だけをダミーのキー付きで渡します。決められないプロバイダのキーは注入せず、サーバーのログに警告を出します。
      </p>
      {error && <div className="error vm-form-error">{error}</div>}
    </>
  );
}

function PoolSettingsBlock({ info, refresh }) {
  const lim = info.pool.limits.idleStopMinutes;
  const [minutes, setMinutes] = useState(info.pool.idleStopMinutes);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const dirty = minutes !== info.pool.idleStopMinutes;

  const handleSave = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const res = await authFetch('/api/vm-pool-settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idleStopMinutes: minutes }),
      });
      if (!res.ok) throw new Error(await readError(res));
      await refresh();
    } catch (err) {
      setError(err.message || '保存に失敗しました');
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="settings-section">
      <h3>常駐VM</h3>
      <form className="vm-pool-settings" onSubmit={handleSave}>
        <label className="vm-resource-field">
          <span>アイドル停止までの時間 (分)</span>
          <input
            type="number"
            min={lim.min}
            max={lim.max}
            step={1}
            value={minutes}
            onChange={(e) => setMinutes(e.target.value === '' ? '' : Number(e.target.value))}
            required
          />
          <span className="vm-resource-hint">{lim.min}〜{lim.max} (既定 {lim.def} 分)</span>
        </label>
        <button type="submit" className="btn btn-primary" disabled={saving || !dirty}>{saving ? '保存中...' : '保存'}</button>
      </form>
      <p className="settings-hint">
        常駐VMは、使うセッションが1つも無い状態がこの時間続くと停止します。変更はすでにアイドル中のVMにも、アイドルになった時刻から数えて適用されます。
      </p>
      {error && <div className="error vm-form-error">{error}</div>}
    </section>
  );
}

// 常駐VM 1台の行。乗っているセッションと、アイドル中なら停止予定時刻を出す。
// Terminal はゲスト内の bwrap を通さないシェルをこのVMに開く。
function PoolVmRow({ vm, stopping, onStop, onOpenTerminal }) {
  const started = formatTime(vm.startedAt);
  const stopAt = formatTime(vm.idleStopAt);
  const label = vm.templateName || '既定設定';
  return (
    <li className="sandbox-row">
      <div className="sandbox-body">
        <div className="sandbox-item-top">
          <span className="sandbox-inuse-badge">{label}</span>
          <span className="sandbox-inuse-badge">常駐VM</span>
          {Number.isFinite(vm.cpus) && <span className="sandbox-size">{resourceSummary(vm)}</span>}
          {vm.diskUsedBytes != null && <span className="sandbox-size" title="overlay の実使用量">使用 {formatSize(vm.diskUsedBytes)}</span>}
          {started && <span className="sandbox-last-used">起動 {started}</span>}
          {vm.stale && (
            <span
              className="sandbox-inuse-badge"
              title="起動後にテンプレート・イメージ・ネットワークの詳細設定・認証情報が変わりました。停止すると次の起動から新しい設定になります (許可/拒否リストと動作モードは起動中でも反映済み)"
            >
              設定変更あり
            </span>
          )}
        </div>
        <div className="sandbox-info">
          {vm.sessions.length > 0 ? (
            <>
              <span className="sandbox-project-label">セッション {vm.sessions.length}</span>
              <span className="sandbox-name" title={vm.sessions.map((x) => x.cwd).join('\n')}>
                {vm.sessions.map((x) => x.customLabel || x.cwd).join(', ')}
              </span>
            </>
          ) : (
            <span className="sandbox-project-label">アイドル中{stopAt ? ` · ${stopAt} に停止予定` : ''}</span>
          )}
        </div>
      </div>
      <div className="vm-row-actions">
        {onOpenTerminal && (
          <button
            className="btn btn-secondary"
            onClick={() => onOpenTerminal(vm)}
            disabled={stopping}
            title="このVMにシェルで入る (ゲスト内の隔離なし)"
          >
            Terminal
          </button>
        )}
        <button
          className="sandbox-delete-btn"
          onClick={() => onStop(vm)}
          disabled={stopping}
          title="常駐VMを停止"
          aria-label={`常駐VM ${label} を停止`}
        >
          &#10005;
        </button>
      </div>
    </li>
  );
}

function RunningVmsBlock({ onOpenTerminal }) {
  const [vms, setVms] = useState(null);
  const [pools, setPools] = useState([]);
  const [error, setError] = useState(null);
  const [stopping, setStopping] = useState(null);

  const refresh = useCallback(async () => {
    try {
      const res = await authFetch('/api/vms');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setVms(Array.isArray(data.vms) ? data.vms : []);
      setPools(Array.isArray(data.pools) ? data.pools : []);
      setError(null);
    } catch (err) {
      setError(err.message || 'Failed to load VMs');
    }
  }, []);

  useVisiblePolling(refresh, 5000);

  const handleStop = async (vm) => {
    const label = vm.customLabel || vm.cwd;
    const message = `VM "${label}" を停止しますか？\nセッションを終了し、VMのディスク (overlay) を破棄します。プロジェクトと永続HOMEは残ります。`;
    if (!window.confirm(message)) return;
    setStopping(vm.sessionId);
    try {
      const res = await authFetch(`/api/vms/${encodeURIComponent(vm.sessionId)}`, { method: 'DELETE' });
      if (!res.ok && res.status !== 404) window.alert(`停止に失敗しました: ${await readError(res)}`);
      await refresh();
    } finally {
      setStopping(null);
    }
  };

  const handleStopPool = async (vm) => {
    const n = vm.sessions.length;
    const message = n > 0
      ? `常駐VM "${vm.templateName || '既定設定'}" を停止しますか？\n乗っている ${n} 個のセッションも終了します。プロジェクトと永続HOMEは残ります。`
      : `アイドル中の常駐VM "${vm.templateName || '既定設定'}" を今すぐ停止しますか？`;
    if (!window.confirm(message)) return;
    setStopping(vm.vmId);
    try {
      const res = await authFetch(`/api/vm-pool/${encodeURIComponent(vm.vmId)}`, { method: 'DELETE' });
      if (!res.ok && res.status !== 404) window.alert(`停止に失敗しました: ${await readError(res)}`);
      await refresh();
    } finally {
      setStopping(null);
    }
  };

  const empty = vms && vms.length === 0 && pools.length === 0;

  return (
    <section className="settings-section">
      <div className="settings-section-header">
        <h3>稼働中のVM</h3>
        <button className="btn btn-secondary" onClick={refresh}>Refresh</button>
      </div>
      {error && <p className="settings-error">読み込みに失敗しました: {error}</p>}
      {vms === null && !error && <p className="settings-empty">読み込み中…</p>}
      {empty && <p className="settings-empty">稼働中のVMはありません。</p>}
      {pools.length > 0 && (
        <ul className="sandbox-list">
          {pools.map((vm) => (
            <PoolVmRow key={vm.vmId} vm={vm} stopping={stopping === vm.vmId} onStop={handleStopPool} onOpenTerminal={onOpenTerminal} />
          ))}
        </ul>
      )}
      {vms && vms.length > 0 && (
        <ul className="sandbox-list">
          {vms.map((vm) => {
            const started = formatTime(vm.startedAt);
            return (
              <li key={vm.sessionId} className="sandbox-row">
                <div className="sandbox-body">
                  <div className="sandbox-item-top">
                    <span className="sandbox-inuse-badge">{vm.templateName || '既定設定'}</span>
                    {Number.isFinite(vm.cpus) && <span className="sandbox-size">{resourceSummary(vm)}</span>}
                    {vm.diskUsedBytes != null && <span className="sandbox-size" title="overlay の実使用量">使用 {formatSize(vm.diskUsedBytes)}</span>}
                    {started && <span className="sandbox-last-used">起動 {started}</span>}
                  </div>
                  <div className="sandbox-info">
                    <span className="sandbox-project-label">{vm.customLabel || (vm.shell ? 'shell' : vm.app)}</span>
                    <span className="sandbox-name" title={vm.cwd}>{vm.cwd}</span>
                  </div>
                </div>
                <button
                  className="sandbox-delete-btn"
                  onClick={() => handleStop(vm)}
                  disabled={stopping === vm.sessionId}
                  title="VMを停止 (セッション終了)"
                  aria-label={`${vm.cwd} のVMを停止`}
                >
                  &#10005;
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

export default function VmSection({ onOpenVmTerminal }) {
  const [info, setInfo] = useState(null);
  const [error, setError] = useState(null);

  const refresh = useCallback(async () => {
    try {
      const res = await authFetch('/api/vm-templates');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setInfo(await res.json());
      setError(null);
    } catch (err) {
      setError(err.message || 'Failed to load VM templates');
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  if (error) return <section className="settings-section"><h3>QEMU VM</h3><p className="settings-error">読み込みに失敗しました: {error}</p></section>;
  if (!info) return <section className="settings-section"><h3>QEMU VM</h3><p className="settings-empty">読み込み中…</p></section>;

  return (
    <>
      <p className="settings-hint vm-backend-note">
        テンプレートはサンドボックス起動の方式で VM (QEMU) を選んだときに使われます (既定の方式: {info.backend === 'qemu' ? 'VM' : 'bwrap'})。
      </p>
      {!info.qemu.ok && (
        <div className="error">QEMU サンドボックスが利用できません: {info.qemu.reason}{info.qemu.hint ? ` — ${info.qemu.hint}` : ''}</div>
      )}
      <TemplatesBlock info={info} refresh={refresh} />
      <PoolSettingsBlock key={info.pool.idleStopMinutes} info={info} refresh={refresh} />
      <AgentAuthBlock info={info} refresh={refresh} />
      <RunningVmsBlock onOpenTerminal={onOpenVmTerminal} />
    </>
  );
}
