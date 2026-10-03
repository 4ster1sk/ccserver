import { findModel } from './useOpencodeChat.js';

// Context usage the way opencode itself measures it
// (opencode/packages/core/src/session/compaction.ts): the last successful
// assistant message's tokens -- what the model saw plus what it wrote.

function tokensTotal(t) {
  return (t.input || 0) + (t.output || 0) + (t.reasoning || 0) + (t.cache?.read || 0) + (t.cache?.write || 0);
}

// { used, tokens } of the latest measured assistant message, or null.
export function lastUsage(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.type !== 'assistant' || m.error || !m.tokens) continue;
    const used = tokensTotal(m.tokens);
    if (used > 0) return { used, tokens: m.tokens };
  }
  return null;
}

// The context window of a session's model (input limit first, as opencode's
// compaction does), or null when the catalog does not say.
export function contextLimit(models, ref) {
  const limit = findModel(models, ref)?.limit;
  const n = limit?.input || limit?.context;
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Tokens and cost summed over every assistant message (cost: null when no
// message has one, e.g. Claude Code's).
export function sessionTotals(messages) {
  let tokens = 0;
  let cost = null;
  for (const m of messages) {
    if (m.type !== 'assistant') continue;
    if (m.tokens) tokens += tokensTotal(m.tokens);
    if (typeof m.cost === 'number') cost = (cost || 0) + m.cost;
  }
  return { tokens, cost };
}

// 950 -> "950", 1234 -> "1.2k", 12345 -> "12k", 1200000 -> "1.2M".
export function formatTokens(n) {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0).replace(/\.0$/, '')}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
}
