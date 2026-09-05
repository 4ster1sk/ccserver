// Shared "reset at" formatter for the usage readers that don't already have
// their own (Claude's parseUsage() in usage.js uses a different scheme):
// codexUsage.js and opencodeUsage.js both rendered the exact same
// `M/D HH:MM` string independently -- one copy here instead.
export function formatResets(resetAtMs) {
  if (resetAtMs == null) return null;
  const d = new Date(resetAtMs);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
