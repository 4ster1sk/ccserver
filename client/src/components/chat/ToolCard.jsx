import { memo, useMemo, useState } from 'react';
import { toolSummary, toolText } from './chatReducer.js';
import { diffStats, lineDiff } from './lineDiff.js';

const OUTPUT_PREVIEW_CHARS = 20_000;

function StatusIcon({ status }) {
  if (status === 'completed') return <span className="chat-tool-status ok" aria-label="完了">✔</span>;
  if (status === 'error') return <span className="chat-tool-status err" aria-label="エラー">✖</span>;
  return <span className="chat-spinner small" aria-label="実行中" />;
}

// opencode's edit: { path, oldString, newString } / write: { path, content };
// Claude Code's Edit: { file_path, old_string, new_string } / Write:
// { file_path, content } / MultiEdit: { file_path, edits: [Edit...] }.
function editDiff(e) {
  const oldS = e?.oldString ?? e?.old_string;
  const newS = e?.newString ?? e?.new_string;
  return typeof oldS === 'string' && typeof newS === 'string' ? lineDiff(oldS, newS) : null;
}

function toolDiff(name, input) {
  if (!input || typeof input !== 'object') return null;
  const tool = String(name || '').toLowerCase();
  if (tool === 'edit') return editDiff(input);
  if (tool === 'multiedit' && Array.isArray(input.edits)) {
    const parts = input.edits.map(editDiff);
    if (parts.some((d) => !d)) return null;
    return parts.flatMap((d, i) => (i === 0 ? d : [{ op: ' ', text: '…' }, ...d]));
  }
  if (tool === 'write' && typeof input.content === 'string') return lineDiff('', input.content);
  return null;
}

function DiffView({ lines }) {
  return (
    <pre className="chat-diff">
      {lines.map((l, i) => (
        <div key={i} className={`chat-diff-line ${l.op === '+' ? 'add' : l.op === '-' ? 'del' : ''}`}>
          <span className="chat-diff-op">{l.op}</span>{l.text}
        </div>
      ))}
    </pre>
  );
}

// One tool call: header (status, name, the input in one line), expandable
// to the full input, output and -- for edit/write -- a diff.
function ToolCard({ part }) {
  const { name, state } = part;
  const status = state?.status || 'streaming';
  const input = state?.input;
  const diff = useMemo(() => (status === 'error' ? null : toolDiff(name, input)), [name, input, status]);
  const [open, setOpen] = useState(false);
  const showDiff = diff && (open || status === 'completed');
  const output = toolText(state?.content);
  const summary = toolSummary(name, input);
  const stats = diff ? diffStats(diff) : null;

  return (
    <div className={`chat-tool chat-tool--${status}`}>
      <button type="button" className="chat-tool-header" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <StatusIcon status={status} />
        <span className="chat-tool-name">{name}</span>
        <span className="chat-tool-summary" title={summary}>{summary}</span>
        {stats && <span className="chat-tool-stats"><span className="add">+{stats.add}</span> <span className="del">−{stats.del}</span></span>}
        <span className="chat-tool-caret">{open ? '▾' : '▸'}</span>
      </button>
      {showDiff && <DiffView lines={diff} />}
      {open && (
        <div className="chat-tool-body">
          {input !== undefined && !diff && (
            <pre className="chat-tool-input">{typeof input === 'string' ? input : JSON.stringify(input, null, 2)}</pre>
          )}
          {status === 'error' && (
            <div className="chat-tool-error">{state?.error?.message || 'エラー'}</div>
          )}
          {output && (
            <pre className="chat-tool-output">{output.length > OUTPUT_PREVIEW_CHARS ? `${output.slice(0, OUTPUT_PREVIEW_CHARS)}\n…(省略)` : output}</pre>
          )}
        </div>
      )}
      {!open && status === 'error' && (
        <div className="chat-tool-error compact">{state?.error?.message || 'エラー'}</div>
      )}
    </div>
  );
}

export default memo(ToolCard);
