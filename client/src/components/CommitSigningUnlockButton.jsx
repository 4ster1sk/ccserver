import { useState, useCallback } from 'react';
import { useCommitSigningStatusContext } from './CommitSigningStatusProvider.jsx';
import CommitSigningUnlockForm from './CommitSigningUnlockForm.jsx';

// Top-bar shortcut: shown only while a signing key exists, needs a
// passphrase and is locked. Opens the same unlock form the approval banner
// uses (passphrase, or a tap on an enrolled passkey).
export default function CommitSigningUnlockButton() {
  const signing = useCommitSigningStatusContext();
  const [open, setOpen] = useState(false);
  const done = useCallback(async () => {
    setOpen(false);
    await signing?.refresh();
  }, [signing]);

  const data = signing?.data;
  if (!data?.configured || !data.key || data.unlocked) return null;

  return (
    <span className="commit-signing-unlock">
      <button
        type="button"
        className="btn commit-signing-unlock-btn"
        onClick={() => setOpen((v) => !v)}
        title="コミット署名鍵のロックを解除"
        aria-label="コミット署名鍵のロックを解除"
        aria-expanded={open}
      >
        🔑 署名鍵ロック中
      </button>
      {open && (
        <div className="commit-signing-unlock-popover" role="dialog" aria-label="コミット署名鍵のロック解除">
          <CommitSigningUnlockForm passkeys={data.passkeys} onUnlocked={done} />
        </div>
      )}
    </span>
  );
}
