import { getThemeIds, getTheme } from '../themes.js';

// "一般" メニュー: テーマ・終了確認・ウィジェット表示・サンドボックス既定値。
// いずれも即時反映し、localStorage に永続化される (保存先の詳細は
// 各 setter 側 = App.jsx / useWidgetPrefs.js / themes.js / sandboxDefaults.js を参照)。
export default function GeneralSection({
  themeId,
  onThemeChange,
  confirmBeforeClose,
  onConfirmBeforeCloseChange,
  sidebarOverlay,
  onSidebarOverlayChange,
  sandboxDefaults,
  onSandboxDefaultsChange,
}) {
  const updateSandboxDefault = (key, value) => {
    onSandboxDefaultsChange({ ...sandboxDefaults, [key]: value });
  };
  return (
    <section className="settings-section">
      <h3>一般</h3>
      <div className="general-setting-row">
        <label htmlFor="general-theme-select">テーマ</label>
        <select
          id="general-theme-select"
          value={themeId}
          onChange={(e) => onThemeChange(e.target.value)}
        >
          {getThemeIds().map((id) => (
            <option key={id} value={id}>
              {getTheme(id).name}
            </option>
          ))}
        </select>
      </div>
      <label className="general-setting-check">
        <input
          type="checkbox"
          checked={confirmBeforeClose}
          onChange={(e) => onConfirmBeforeCloseChange(e.target.checked)}
        />
        タブを閉じる前に確認する
      </label>
      <p className="settings-hint">
        オフにすると、稼働中のタブも確認なしで閉じます
        (終了確認ダイアログの「次回以降確認しない」と同じ設定です)。
      </p>
      <label className="general-setting-check">
        <input
          type="checkbox"
          checked={sidebarOverlay}
          onChange={(e) => onSidebarOverlayChange(e.target.checked)}
        />
        ウィジェットをCLIの上に重ねて表示する
      </label>
      <p className="settings-hint">
        オンにすると、デスクトップ幅でもサイドバーがCLIのサイズを変更せず
        前面に重ねて表示されます。
      </p>
      <h4 className="general-setting-subhead">サンドボックス起動の既定値</h4>
      <label className="general-setting-check">
        <input
          type="checkbox"
          checked={!!sandboxDefaults.gpg}
          onChange={(e) => updateSandboxDefault('gpg', e.target.checked)}
        />
        GPG署名を使う
      </label>
      <label className="general-setting-check">
        <input
          type="checkbox"
          checked={!!sandboxDefaults.sshAgent}
          onChange={(e) => updateSandboxDefault('sshAgent', e.target.checked)}
        />
        ssh-agentを転送する
      </label>
      <label className="general-setting-check">
        <input
          type="checkbox"
          checked={!!sandboxDefaults.rtk}
          onChange={(e) => updateSandboxDefault('rtk', e.target.checked)}
        />
        rtk を導入する
      </label>
      <label className="general-setting-check">
        <input
          type="checkbox"
          checked={!!sandboxDefaults.codeReviewGraph}
          onChange={(e) => updateSandboxDefault('codeReviewGraph', e.target.checked)}
        />
        code-review-graph MCP を導入する
      </label>
      <p className="settings-hint">
        ディレクトリ別に記憶済みの場所には適用されず、
        未設定のディレクトリの初期値として使われます。
      </p>
    </section>
  );
}
