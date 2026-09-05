import { useState, useEffect } from 'react';
import { useUsageTab, useUsageData, USAGE_APP_LABELS, USAGE_TAB_LABELS } from './useUsage.js';
import UsagePanel from './UsagePanel.jsx';

export default function UsageWidget({ defaultApp = 'claude', availableApps = null, hiddenApps = [] }) {
  const [, setTick] = useState(0);
  const { tab, setTab, visibleApps } = useUsageTab({ defaultApp, availableApps, hiddenApps });
  const { data, loading, load } = useUsageData(tab);

  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 30000);
    return () => clearInterval(id);
  }, []);

  const limits = data?.usage?.limits || [];
  const now = Date.now();
  const appLabel = USAGE_APP_LABELS[tab] || USAGE_APP_LABELS.claude;

  return (
    <div className="usage-widget">
      <UsagePanel
        tabLabel={appLabel}
        tabs={visibleApps}
        tab={tab}
        setTab={setTab}
        tabLabels={USAGE_TAB_LABELS}
        data={data}
        loading={loading}
        load={load}
        limits={limits}
        now={now}
      />
    </div>
  );
}
