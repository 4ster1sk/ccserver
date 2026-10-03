import { useState, useEffect, useCallback } from 'react';
import { authFetch } from '../auth.js';
import { readJsonError, postJson, runPasskeyStepUp } from '../passkeyStepUp.js';
import { enrollPasskey, lockSigningKey } from '../commitSigningApi.js';
import { useCommitSigningStatusContext } from './CommitSigningStatusProvider.jsx';
import CommitSigningUnlockForm from './CommitSigningUnlockForm.jsx';

// 「コミット署名」 (SettingsView.jsx 左メニュー, plan: sandbox-no-secrets).
// サンドボックスには鍵もエージェントのソケットも渡さない。サンドボックス内の
// git commit は gpg.program 経由でホストに署名を依頼し、ホストがこの画面の鍵で
// 署名する (server/ws/commitSignService.js)。鍵はホスト専用の GNUPGHOME
// にあり、推奨はマスター鍵から切り出した署名用サブキー。

function writeClipboardText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    return navigator.clipboard.writeText(text);
  }
  return Promise.reject(new Error('clipboard unavailable'));
}

function CopyButton({ text, label }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback(() => {
    writeClipboardText(text)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {});
  }, [text]);
  return (
    <button type="button" className="btn btn-secondary" onClick={handleCopy}>
      {copied ? 'コピーしました' : label}
    </button>
  );
}

const fmtDate = (ms) => (ms ? new Date(ms).toLocaleDateString() : 'なし');

export default function CommitSigningSection() {
  const ctx = useCommitSigningStatusContext();
  const status = ctx?.data;
  const [publicKey, setPublicKey] = useState(null);
  const [signatures, setSignatures] = useState([]);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState(null);
  const [setupMode, setSetupMode] = useState('import'); // 'import' | 'generate'
  const [keyArmored, setKeyArmored] = useState('');
  const [nameReal, setNameReal] = useState('');
  const [nameEmail, setNameEmail] = useState('');
  const [pass1, setPass1] = useState('');
  const [pass2, setPass2] = useState('');
  const [enrollPass, setEnrollPass] = useState('');

  const configured = !!status?.configured && !!status?.key;
  const fingerprint = status?.key?.signingFingerprint;

  const loadDetails = useCallback(async () => {
    try {
      const sig = await authFetch('/api/commit-signing/signatures?limit=20');
      setSignatures(sig.ok ? (await sig.json()).signatures : []);
      if (configured) {
        const pub = await authFetch('/api/commit-signing/public-key');
        setPublicKey(pub.ok ? (await pub.json()).publicKeyArmored : null);
      } else {
        setPublicKey(null);
      }
    } catch {
      // keep what we have
    }
  }, [configured]);

  useEffect(() => { loadDetails(); }, [loadDetails, fingerprint]);

  const act = useCallback(async (fn, fallback) => {
    if (busy) return;
    setBusy(true);
    setActionError(null);
    try {
      await fn();
      await ctx?.refresh();
    } catch (err) {
      setActionError(err.message || fallback);
    } finally {
      setBusy(false);
    }
  }, [busy, ctx]);

  const handleImport = () => act(async () => {
    await postJson('/api/commit-signing/import', { keyArmored });
    setKeyArmored('');
  }, 'インポートに失敗しました');

  const handleGenerate = () => {
    if (pass1 !== pass2) {
      setActionError('パスフレーズが一致しません');
      return;
    }
    const passphrase = pass1;
    setPass1('');
    setPass2('');
    act(() => postJson('/api/commit-signing/generate', { nameReal, nameEmail, passphrase }), '鍵の生成に失敗しました');
  };

  const handleLock = () => act(lockSigningKey, 'ロックに失敗しました');

  const handleEnroll = () => {
    const passphrase = enrollPass;
    setEnrollPass('');
    act(() => enrollPasskey(passphrase), 'パスキーの登録に失敗しました');
  };

  const handleClearPasskeys = () => {
    if (!window.confirm('パスキーでのロック解除をすべて解除します。続けますか?')) return;
    act(() => postJson('/api/commit-signing/passkeys/clear', {}), '解除に失敗しました');
  };

  const handleDelete = () => {
    if (!window.confirm(
      'このホストから署名鍵を削除します (バックアップは取りません)。\n'
      + 'サブキーを今後使わない場合は、主鍵のある環境で失効させ、GitHub の公開鍵も更新してください。続けますか?',
    )) return;
    act(async () => {
      let res = await authFetch('/api/commit-signing/delete-key', { method: 'POST' });
      if (res.status === 403) {
        await runPasskeyStepUp();
        res = await authFetch('/api/commit-signing/delete-key', { method: 'POST' });
      }
      if (!res.ok) throw new Error(await readJsonError(res));
    }, '削除に失敗しました');
  };

  return (
    <section className="settings-section">
      <div className="settings-section-header">
        <h3>コミット署名</h3>
      </div>
      <p className="settings-hint">
        サンドボックスには署名鍵を渡しません。起動オプション「コミットに署名する」を有効にしたセッションの
        git commit は、ホストがこの鍵で署名します。署名されるのは、署名鍵の名前・メールアドレスで作られた
        いまのコミットだけです (タグや任意のデータには署名しません)。署名ありの起動は毎回承認を求めます。
      </p>
      {ctx?.error && <p className="settings-error">読み込みに失敗しました: {ctx.error}</p>}
      {!status && !ctx?.error && <p className="settings-empty">読み込み中…</p>}
      {status && (
        <>
          {status.toolsAvailable === false && (
            <p className="settings-error">このホストには gpg / gpgconf / gpg-connect-agent がありません。コミット署名は使えません。</p>
          )}
          {status.error && <p className="settings-error">署名鍵が使えません: {status.error}</p>}
          {actionError && <p className="settings-error">{actionError}</p>}

          {!status.configured && status.toolsAvailable !== false && (
            <>
              <div className="general-setting-row">
                <label>
                  <input type="radio" checked={setupMode === 'import'} onChange={() => setSetupMode('import')} />
                  {' '}署名用サブキーをインポート (推奨)
                </label>
                <label>
                  <input type="radio" checked={setupMode === 'generate'} onChange={() => setSetupMode('generate')} />
                  {' '}このホスト専用の鍵を生成
                </label>
              </div>
              {setupMode === 'import' && (
                <>
                  <p className="settings-hint">
                    手元のマスター鍵に署名用サブキー (有効期限は1年程度を推奨) を追加し、
                    <code>gpg --armor --export-secret-subkeys &lt;サブキーID&gt;!</code> の出力を貼り付けてください。
                    ホストのシェルからは <code>node server/cli/commit-signing-key.js import &lt;ファイル&gt;</code> でも登録できます。
                    サブキーにはパスフレーズを付けてください。
                  </p>
                  <textarea
                    className="settings-code-block"
                    rows={8}
                    value={keyArmored}
                    onChange={(e) => setKeyArmored(e.target.value)}
                    placeholder="-----BEGIN PGP PRIVATE KEY BLOCK-----"
                    spellCheck={false}
                    autoComplete="off"
                  />
                  <button type="button" className="btn btn-secondary" onClick={handleImport} disabled={busy || !keyArmored.trim()}>
                    {busy ? 'インポート中…' : 'インポート'}
                  </button>
                </>
              )}
              {setupMode === 'generate' && (
                <>
                  <p className="settings-hint">
                    主鍵 (証明用) と署名用サブキーを生成します。有効期限は1年です。マスター鍵を持っていないときに使ってください。
                  </p>
                  <div className="general-setting-row">
                    <label htmlFor="signing-name">名前</label>
                    <input id="signing-name" type="text" value={nameReal} onChange={(e) => setNameReal(e.target.value)} placeholder="Taro Yamada" />
                  </div>
                  <div className="general-setting-row">
                    <label htmlFor="signing-email">メールアドレス</label>
                    <input id="signing-email" type="email" value={nameEmail} onChange={(e) => setNameEmail(e.target.value)} placeholder="taro@example.com" />
                  </div>
                  <div className="general-setting-row">
                    <label htmlFor="signing-pass1">パスフレーズ (8文字以上)</label>
                    <input id="signing-pass1" type="password" autoComplete="new-password" value={pass1} onChange={(e) => setPass1(e.target.value)} />
                  </div>
                  <div className="general-setting-row">
                    <label htmlFor="signing-pass2">パスフレーズ (確認)</label>
                    <input id="signing-pass2" type="password" autoComplete="new-password" value={pass2} onChange={(e) => setPass2(e.target.value)} />
                  </div>
                  <button type="button" className="btn btn-secondary" onClick={handleGenerate} disabled={busy || !nameReal.trim() || !nameEmail.trim() || !pass1}>
                    {busy ? '生成中…' : '鍵を生成'}
                  </button>
                </>
              )}
            </>
          )}

          {configured && (
            <>
              <p className="settings-hint">
                {status.key.nameReal} &lt;{status.key.nameEmail}&gt;<br />
                署名に使う鍵: {status.key.signingFingerprint}{status.key.usesSubkey ? ' (サブキー)' : ' (主鍵)'}<br />
                有効期限: {fmtDate(status.key.expiresAt)}{' / '}
                状態: {status.unlocked ? (status.needsPassphrase ? 'ロック解除済み' : 'パスフレーズなし') : 'ロック中'}
              </p>
              {status.key.primarySecretPresent && (
                <p className="settings-error">
                  主鍵の秘密鍵もこのホストにあります。主鍵はオフラインに置き、署名用サブキーだけを入れることを推奨します。
                </p>
              )}
              {!status.unlocked && (
                <CommitSigningUnlockForm passkeys={status.passkeys} onUnlocked={() => ctx?.refresh()} />
              )}
              {status.unlocked && status.needsPassphrase && (
                <button type="button" className="btn btn-secondary" onClick={handleLock} disabled={busy}>ロック</button>
              )}
              {' '}
              <button type="button" className="btn btn-secondary" onClick={handleDelete} disabled={busy}>署名鍵を削除</button>

              {status.passkeys?.available && status.needsPassphrase && (
                <div className="settings-subsection">
                  <h4 className="general-setting-subhead">パスキーでロック解除</h4>
                  <p className="settings-hint">
                    パスフレーズを PRF 対応パスキーで暗号化して保存し、以後はタップでロックを解除できます。
                    登録済み: {status.passkeys.enrolled}個
                  </p>
                  <div className="general-setting-row">
                    <input
                      type="password"
                      autoComplete="off"
                      placeholder="署名鍵のパスフレーズ"
                      value={enrollPass}
                      onChange={(e) => setEnrollPass(e.target.value)}
                      aria-label="登録用のパスフレーズ"
                    />
                    <button type="button" className="btn btn-secondary" onClick={handleEnroll} disabled={busy || !enrollPass}>
                      このパスキーを登録
                    </button>
                    {status.passkeys.enrolled > 0 && (
                      <button type="button" className="btn btn-secondary" onClick={handleClearPasskeys} disabled={busy}>
                        登録をすべて解除
                      </button>
                    )}
                  </div>
                </div>
              )}

              {publicKey && (
                <div className="settings-subsection">
                  <h4 className="general-setting-subhead">GitHub登録用の公開鍵</h4>
                  <p className="settings-hint">
                    GitHub の Settings &gt; SSH and GPG keys &gt; New GPG key に登録してください。
                    サブキーを差し替えたときは登録し直します。
                  </p>
                  <CopyButton text={publicKey} label="公開鍵をコピー" />
                  <pre className="settings-code-block">{publicKey}</pre>
                </div>
              )}
            </>
          )}

          {signatures.length > 0 && (
            <div className="settings-subsection">
              <h4 className="general-setting-subhead">最近の署名</h4>
              <ul className="settings-list">
                {signatures.map((s) => (
                  <li key={s.id}>
                    {new Date(s.createdAt).toLocaleString()} — {s.subject || '(件名なし)'}
                    <span className="settings-hint"> {s.cwd} ({s.app || 'shell'}) tree {s.tree.slice(0, 12)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </section>
  );
}
