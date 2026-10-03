import { useEffect, useMemo, useRef, useState } from 'react';
import { DEFAULT_VARIANT, findModel, modelVariants } from './useOpencodeChat.js';
import { ACCEPT, addAttachments, formatBytes } from './attachments.js';

const DRAFT_PREFIX = 'ccserver-chat-draft:';
const MAX_HEIGHT_PX = 220;

// A session's model ref names the catalog entry by its id (opencode's ACP
// switch does the same); modelID is the provider's own name for it.
function modelRef(m) {
  return { id: m.id || m.modelID, providerID: m.providerID };
}

// "high" -> "High", "extra_high" -> "Extra High" (opencode's ACP labels).
function variantLabel(variant) {
  return variant.split(/[_-]/).map((p) => (p ? p.charAt(0).toUpperCase() + p.slice(1) : p)).join(' ');
}

function modelKey(ref) {
  return ref ? `${ref.providerID}/${ref.id}` : '';
}

// The input area: a growing textarea, send / stop, `/command` completion,
// attachments (the 📎 button, pasting, dropping files) and the agent /
// model / effort pickers. Enter sends on a desktop keyboard
// (Shift+Enter for a newline); on touch devices Enter is a newline and the
// button sends, since a soft keyboard has no Shift+Enter.
export default function Composer({ draftKey, disabled, busy, onSend, onCommand, onInterrupt, commands, agents, models, agent, model, onAgent, onModel, onEffort }) {
  const isTouch = useMemo(() => 'ontouchstart' in window, []);
  const [text, setText] = useState(() => {
    try { return sessionStorage.getItem(DRAFT_PREFIX + draftKey) || ''; } catch { return ''; }
  });
  const [cmdIndex, setCmdIndex] = useState(0);
  // Not kept with the draft: sessionStorage is far too small for them.
  const [attachments, setAttachments] = useState([]);
  const [attachError, setAttachError] = useState(null);
  const [dragging, setDragging] = useState(false);
  const ref = useRef(null);
  const listRef = useRef(null);
  const fileRef = useRef(null);
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;

  const attach = async (files) => {
    if (!files || files.length === 0) return;
    const { list, errors } = await addAttachments(attachmentsRef.current, [...files]);
    setAttachments(list);
    setAttachError(errors.length ? errors.join('\n') : null);
  };
  const removeAttachment = (id) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
    setAttachError(null);
  };

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

  // Keep the highlighted command visible when the list scrolls.
  useEffect(() => {
    listRef.current?.querySelector('li.active')?.scrollIntoView({ block: 'nearest' });
  }, [cmdIndex, suggestions.length]);

  const canSend = !disabled && (text.trim() !== '' || attachments.length > 0);

  const submit = () => {
    const value = text.trim();
    if (!canSend) return;
    // A command takes no files: with attachments it is sent as a prompt.
    const cmd = attachments.length === 0 && /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(value);
    if (cmd && commands.some((c) => c.name === cmd[1])) onCommand(cmd[1], cmd[2] || '');
    else onSend(value, attachments);
    setText('');
    setAttachments([]);
    setAttachError(null);
  };

  const onPaste = (e) => {
    const files = e.clipboardData?.files;
    if (files && files.length > 0) {
      e.preventDefault();
      attach(files);
    }
  };

  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  const onDragOver = (e) => {
    if (disabled || !hasFiles(e)) return;
    e.preventDefault();
    setDragging(true);
  };
  const onDragLeave = (e) => {
    if (!e.currentTarget.contains(e.relatedTarget)) setDragging(false);
  };
  const onDrop = (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    setDragging(false);
    if (!disabled) attach(e.dataTransfer.files);
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
  // Effort: the current model's variants, plus opencode's default.
  const variants = modelVariants(findModel(models, model));
  const effort = model?.variant && variants.includes(model.variant) ? model.variant : DEFAULT_VARIANT;

  return (
    <div className={`chat-composer${dragging ? ' dragging' : ''}`} onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>
      {suggestions.length > 0 && (
        <ul ref={listRef} className="chat-cmd-list" role="listbox">
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
      {attachments.length > 0 && (
        <ul className="chat-attachments" aria-label="添付ファイル">
          {attachments.map((a) => (
            <li key={a.id} className="chat-attachment">
              {a.kind === 'image'
                ? <img src={a.dataUrl} alt="" className="chat-attachment-thumb" />
                : <span className="chat-attachment-icon" aria-hidden="true">{a.kind === 'pdf' ? 'PDF' : 'TXT'}</span>}
              <span className="chat-attachment-name" title={a.name}>{a.name}</span>
              <span className="chat-attachment-size">{formatBytes(a.size)}</span>
              <button type="button" className="chat-attachment-remove" onClick={() => removeAttachment(a.id)} aria-label={`${a.name} を外す`}>×</button>
            </li>
          ))}
        </ul>
      )}
      {attachError && <div className="chat-attach-error" role="alert">{attachError}</div>}
      <div className="chat-composer-row">
        <input
          ref={fileRef}
          type="file"
          multiple
          accept={ACCEPT}
          hidden
          onChange={(e) => { attach(e.target.files); e.target.value = ''; }}
        />
        <button type="button" className="btn chat-attach-btn" onClick={() => fileRef.current?.click()} disabled={disabled} title="ファイルを添付" aria-label="ファイルを添付">📎</button>
        <textarea
          ref={ref}
          className="chat-input"
          rows={1}
          value={text}
          placeholder={disabled ? '準備中…' : (isTouch ? 'メッセージを入力' : 'メッセージを入力（Enter で送信 / Shift+Enter で改行 / / でコマンド）')}
          onChange={(e) => { setText(e.target.value); setCmdIndex(0); }}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          disabled={disabled}
          aria-label="メッセージ"
        />
        {busy && (
          <button type="button" className="btn chat-stop-btn" onClick={onInterrupt} title="停止 (Esc)" aria-label="停止">■</button>
        )}
        <button type="button" className="btn btn-primary chat-send-btn" onClick={submit} disabled={!canSend} aria-label="送信">
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
        {variants.length > 0 && (
          <select className="chat-select" value={effort} onChange={(e) => onEffort(e.target.value)} disabled={disabled} aria-label="effort">
            <option value={DEFAULT_VARIANT}>既定の effort</option>
            {variants.filter((v) => v !== DEFAULT_VARIANT).map((v) => <option key={v} value={v}>{variantLabel(v)}</option>)}
          </select>
        )}
        {busy && <span className="chat-busy-hint">実行中 — 送信するとキューに入ります</span>}
      </div>
    </div>
  );
}
