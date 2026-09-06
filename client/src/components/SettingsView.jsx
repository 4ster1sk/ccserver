import { useState } from 'react';
import SandboxSection from './SandboxSection.jsx';
import PairedInstancesSection from './PairedInstancesSection.jsx';
import GeneralPlaceholderSection from './GeneralPlaceholderSection.jsx';

// 左メニュー定義。項目追加時はここに1行＋対応コンポーネントの
// 条件分岐を追加するだけで済む。選択状態は useState のみ
// (Settingsタブを閉じたらリセット。localStorage/ハッシュ連動なし)。
const SETTINGS_MENUS = [
  { key: 'sandboxes', label: '作成済みサンドボックス' },
  { key: 'pairing', label: 'ペアリング済みインスタンス' },
  { key: 'general', label: '一般' },
];

export default function SettingsView() {
  const [activeKey, setActiveKey] = useState('sandboxes');

  return (
    <div className="settings-view">
      <div className="settings-header">
        <h2>Settings</h2>
      </div>
      <div className="settings-layout">
        {/* 同一ビュー内のパネル切り替え (実質タブ) のため Tabs パターンで
            意味付けする。`aria-current="page"` は別ページ遷移を示す値なので
            使わない。 */}
        <div className="settings-sidebar" role="tablist" aria-label="設定メニュー">
          {SETTINGS_MENUS.map((menu) => (
            <button
              key={menu.key}
              type="button"
              role="tab"
              id={`settings-tab-${menu.key}`}
              aria-controls={`settings-panel-${menu.key}`}
              aria-selected={activeKey === menu.key}
              className={`settings-menu-btn${activeKey === menu.key ? ' active' : ''}`}
              onClick={() => setActiveKey(menu.key)}
            >
              {menu.label}
            </button>
          ))}
        </div>
        <div
          className="settings-content"
          role="tabpanel"
          id={`settings-panel-${activeKey}`}
          aria-labelledby={`settings-tab-${activeKey}`}
        >
          {activeKey === 'sandboxes' && <SandboxSection />}
          {activeKey === 'pairing' && <PairedInstancesSection />}
          {activeKey === 'general' && <GeneralPlaceholderSection />}
        </div>
      </div>
    </div>
  );
}
