import { useState, useCallback } from 'react';

const SIDEBAR_OPEN_KEY = 'ccserver-sidebar-open';
const ORDER_KEY = 'ccserver-widget-order';
const VIS_KEY_PREFIX = 'ccserver-widget:';
const VIS_SUFFIX = ':visible';

function loadOpen() {
  try {
    return localStorage.getItem(SIDEBAR_OPEN_KEY) !== '0';
  } catch {
    return true;
  }
}

function loadOrder(defaultIds) {
  try {
    const raw = localStorage.getItem(ORDER_KEY);
    if (!raw) return defaultIds;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return defaultIds;
    const known = new Set(defaultIds);
    const seen = new Set();
    const ordered = parsed.filter(
      (id) => known.has(id) && !seen.has(id) && (seen.add(id), true)
    );
    for (const id of defaultIds) {
      if (!ordered.includes(id)) ordered.push(id);
    }
    return ordered;
  } catch {
    return defaultIds;
  }
}

function loadVisibility(id, defaultVisible) {
  try {
    const v = localStorage.getItem(`${VIS_KEY_PREFIX}${id}${VIS_SUFFIX}`);
    if (v === null) return defaultVisible;
    return v === '1';
  } catch {
    return defaultVisible;
  }
}

export function useWidgetPrefs(widgetDefs) {
  const defaultIds = widgetDefs.map((w) => w.id);
  const [open, setOpenState] = useState(loadOpen);
  const [order, setOrderState] = useState(() => loadOrder(defaultIds));
  const [hiddenIds, setHiddenIds] = useState(() => {
    const hidden = new Set();
    for (const w of widgetDefs) {
      if (!loadVisibility(w.id, w.defaultVisible !== false)) hidden.add(w.id);
    }
    return hidden;
  });

  const setOpen = useCallback((v) => {
    setOpenState(v);
    try {
      localStorage.setItem(SIDEBAR_OPEN_KEY, v ? '1' : '0');
    } catch {
      // ignore
    }
  }, []);

  const setWidgetVisible = useCallback((id, visible) => {
    setHiddenIds((prev) => {
      const next = new Set(prev);
      if (visible) next.delete(id);
      else next.add(id);
      return next;
    });
    try {
      localStorage.setItem(`${VIS_KEY_PREFIX}${id}${VIS_SUFFIX}`, visible ? '1' : '0');
    } catch {
      // ignore
    }
  }, []);

  const moveWidget = useCallback((id, dir) => {
    setOrderState((prev) => {
      const idx = prev.indexOf(id);
      const next = [...prev];
      if (dir === 'up' && idx > 0) {
        [next[idx - 1], next[idx]] = [next[idx], next[idx - 1]];
      } else if (dir === 'down' && idx >= 0 && idx < next.length - 1) {
        [next[idx + 1], next[idx]] = [next[idx], next[idx + 1]];
      } else {
        return prev;
      }
      try {
        localStorage.setItem(ORDER_KEY, JSON.stringify(next));
      } catch {
        // ignore
      }
      return next;
    });
  }, []);

  const visibleWidgets = order
    .map((id) => widgetDefs.find((w) => w.id === id))
    .filter((w) => w && !hiddenIds.has(w.id));
  const hiddenWidgets = widgetDefs.filter((w) => hiddenIds.has(w.id));

  return { open, setOpen, order, visibleWidgets, hiddenWidgets, setWidgetVisible, moveWidget };
}
