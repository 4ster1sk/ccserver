// A small line diff for the edit/write tool cards: LCS over lines, which is
// exact for the hunk-sized strings an edit carries. Past MAX_CELLS the
// table would get expensive, so it degrades to "all old lines removed, all
// new lines added".
const MAX_CELLS = 250_000;

// Returns [{ op: ' ' | '-' | '+', text }].
export function lineDiff(oldText, newText) {
  const a = (oldText ?? '').split('\n');
  const b = (newText ?? '').split('\n');
  if (oldText === '' || oldText == null) return b.map((text) => ({ op: '+', text }));
  if (a.length * b.length > MAX_CELLS) {
    return [...a.map((text) => ({ op: '-', text })), ...b.map((text) => ({ op: '+', text }))];
  }
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ op: ' ', text: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ op: '-', text: a[i] }); i++; }
    else { out.push({ op: '+', text: b[j] }); j++; }
  }
  while (i < n) out.push({ op: '-', text: a[i++] });
  while (j < m) out.push({ op: '+', text: b[j++] });
  return out;
}

export function diffStats(lines) {
  let add = 0;
  let del = 0;
  for (const l of lines) {
    if (l.op === '+') add++;
    else if (l.op === '-') del++;
  }
  return { add, del };
}
