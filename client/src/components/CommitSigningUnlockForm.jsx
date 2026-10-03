import { useState, useCallback } from 'react';
import { unlockWithPassphrase, unlockWithPasskey } from '../commitSigningApi.js';

// Unlock the host commit signing key: type the passphrase, or tap a passkey
// enrolled for it (passkeys.enrolled > 0). Shared by the top bar and the
// approval banner. The passphrase lives in this input only: cleared on
// every attempt, never stored, autocomplete off so no password manager
// offers to keep it.
export default function CommitSigningUnlockForm({ passkeys, onUnlocked }) {
  const [passphrase, setPassphrase] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const run = useCallback(async (fn) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await fn();
      await onUnlocked?.();
    } catch (err) {
      setError(err.message || 'ロック解除に失敗しました');
    } finally {
      setBusy(false);
    }
  }, [busy, onUnlocked]);

  const submit = useCallback((e) => {
    e.preventDefault();
    const value = passphrase;
    setPassphrase('');
    if (!value) return;
    run(() => unlockWithPassphrase(value));
  }, [passphrase, run]);

  return (
    <form className="commit-signing-unlock-form" onSubmit={submit} autoComplete="off">
      <input
        type="password"
        autoComplete="off"
        name="commit-signing-passphrase"
        placeholder="署名鍵のパスフレーズ"
        value={passphrase}
        onChange={(e) => setPassphrase(e.target.value)}
        disabled={busy}
        aria-label="署名鍵のパスフレーズ"
      />
      <button type="submit" className="btn btn-primary" disabled={busy || !passphrase}>
        {busy ? '解除中…' : 'ロック解除'}
      </button>
      {passkeys?.enrolled > 0 && (
        <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => run(unlockWithPasskey)}>
          パスキーで解除
        </button>
      )}
      {error && <p className="settings-error">{error}</p>}
    </form>
  );
}
