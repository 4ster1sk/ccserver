import { useEffect, useMemo, useRef, useState } from 'react';

const DRAFT_PREFIX = 'ccserver-chat-draft:';
const MAX_HEIGHT_PX = 220;

function modelRef(m) {
  return { id: m.modelID || m.id, providerID: m.providerID };
}

function modelKey(ref) {
  return ref ? `${ref.providerID}/${ref.id}` : '';
}

// The input area: a growing textarea, send / stop, `/command` completion
// and the agent / model pickers. Enter sends on a desktop keyboard
// (Shift+Enter for a newline); on touch devices Enter is a newline and the
// button sends, since a soft keyboard has no Shift+Enter.
export default function Composer({ draftKey, disabled, busy, onSend, onCommand, onInterrupt, commands, agents, models, agent, model, onAgent, onModel }) {
  const isTouch = useMemo(() => 'ontouchstart' in window, []);
  const [text, setText] = useState(() => {
    try { return sessionStorage.getItem(DRAFT_PREFIX + draftKey) || ''; } catch { return ''; }
  });
  const [cmdIndex, setCmdIndex] = useState(0);
  const ref = useRef(null);

  useEffect(() => {
    try {
      if (text) sessionStorage.setItem(DRAFT_PREFIX + draftKey, text);
      else sessionStorage.removeItem(DRAFT_PREFIX + draftKey);
    } catch { /* storage unavailable */ }
  }, [text, draftKey]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT_PX)}px`;
  }, [text]);

  // `/name` typed as the whole first word: offer matching commands.
  const cmdMatch = /^\/(\S*)$/.exec(text);
  const suggestions = cmdMatch
    ? commands.filter((c) => c.name.toLowerCase().startsWith(cmdMatch[1].toLowerCase())).slice(0, 8)
    : [];

  const submit = () => {
    const value = text.trim();
    if (!value || disabled) return;
    const cmd = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(value);
    if (cmd && commands.some((c) => c.name === cmd[1])) onCommand(cmd[1], cmd[2] || '');
    else onSend(value);
    setText('');
  };

  const onKeyDown = (e) => {
    if (suggestions.length > 0) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setCmdIndex((i) => (i + 1) % suggestions.length); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setCmdIndex((i) => (i - 1 + suggestions.length) % suggestions.length); return; }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault();
        setText(`/${suggestions[Math.min(cmdIndex, suggestions.length - 1)].name} `);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !isTouch && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
    if (e.key === 'Escape' && busy) onInterrupt();
  };

  const currentModelKey = modelKey(model);
  const modelOptions = models.map((m) => ({ key: modelKey(modelRef(m)), label: m.name || `${m.providerID}/${m.modelID || m.id}`, ref: modelRef(m) }));
  if (currentModelKey && !modelOptions.some((o) => o.key === currentModelKey)) {
    modelOptions.unshift({ key: currentModelKey, label: currentModelKey, ref: model });
  }

  return (
    <div className="chat-composer">
      {suggestions.length > 0 && (
        <ul className="chat-cmd-list" role="listbox">
          {suggestions.map((c, i) => (
            <li key={c.name} role="option" aria-selected={i === cmdIndex} className={i === cmdIndex ? 'active' : ''}>
              <button type="button" onMouseDown={(e) => { e.preventDefault(); setText(`/${c.name} `); ref.current?.focus(); }}>
                <span className="chat-cmd-name">/{c.name}</span>
                {c.description && <span className="chat-cmd-desc">{c.description}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="chat-composer-row">
        <textarea
          ref={ref}
          className="chat-input"
          rows={1}
          value={text}
          placeholder={disabled ? '準備中…' : (isTouch ? 'メッセージを入力' : 'メッセージを入力（Enter で送信 / Shift+Enter で改行 / / でコマンド）')}
          onChange={(e) => { setText(e.target.value); setCmdIndex(0); }}
          onKeyDown={onKeyDown}
          disabled={disabled}
          aria-label="メッセージ"
        />
        {busy && (
          <button type="button" className="btn chat-stop-btn" onClick={onInterrupt} title="停止 (Esc)" aria-label="停止">■</button>
        )}
        <button type="button" className="btn btn-primary chat-send-btn" onClick={submit} disabled={disabled || !text.trim()} aria-label="送信">
          {busy ? 'キュー' : '送信'}
        </button>
      </div>
      <div className="chat-composer-meta">
        {agents.length > 0 && (
          <select className="chat-select" value={agent || ''} onChange={(e) => onAgent(e.target.value)} disabled={disabled} aria-label="エージェント">
            {!agents.some((a) => a.id === agent) && agent && <option value={agent}>{agent}</option>}
            {agents.map((a) => <option key={a.id} value={a.id}>{a.name || a.id}</option>)}
          </select>
        )}
        {modelOptions.length > 0 && (
          <select
            className="chat-select"
            value={currentModelKey}
            onChange={(e) => { const o = modelOptions.find((x) => x.key === e.target.value); if (o) onModel(o.ref); }}
            disabled={disabled}
            aria-label="モデル"
          >
            {!currentModelKey && <option value="">既定のモデル</option>}
            {modelOptions.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
          </select>
        )}
        {busy && <span className="chat-busy-hint">実行中 — 送信するとキューに入ります</span>}
      </div>
    </div>
  );
}
