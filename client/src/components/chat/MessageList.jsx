import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react';
import Markdown from './Markdown.jsx';
import ToolCard from './ToolCard.jsx';
import { displayFiles, isImageMime } from './attachments.js';

function Reasoning({ part }) {
  const [open, setOpen] = useState(false);
  if (!part.text) return null;
  return (
    <div className="chat-reasoning">
      <button type="button" className="chat-reasoning-toggle" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        {open ? '▾' : '▸'} 思考過程
      </button>
      {open && <div className="chat-reasoning-body">{part.text}</div>}
    </div>
  );
}

const AssistantMessage = memo(function AssistantMessage({ message, streaming }) {
  const content = message.content || [];
  return (
    <div className="chat-msg assistant">
      {content.map((part, i) => {
        if (part.type === 'text') return part.text ? <Markdown key={i} text={part.text} /> : null;
        if (part.type === 'reasoning') return <Reasoning key={i} part={part} />;
        if (part.type === 'tool') return <ToolCard key={part.id || i} part={part} />;
        return null;
      })}
      {streaming && content.length === 0 && <div className="chat-thinking"><span className="chat-spinner small" /> 考え中…</div>}
      {message.error && <div className="chat-msg-error">{message.error.message || 'エラーが発生しました'}</div>}
    </div>
  );
});

// A prompt's attachments: images as thumbnails (tap to enlarge), the rest
// as name chips.
function UserFiles({ files }) {
  const [open, setOpen] = useState(null);
  const items = displayFiles(files);
  if (items.length === 0) return null;
  return (
    <div className="chat-user-files">
      {items.map((f) => (isImageMime(f.mime) && f.src ? (
        <button key={f.key} type="button" className="chat-user-image" onClick={() => setOpen(f)} title={f.name || '画像'}>
          <img src={f.src} alt={f.name || '添付画像'} />
        </button>
      ) : (
        <span key={f.key} className="chat-user-file" title={f.name || f.mime}>
          <span className="chat-attachment-icon" aria-hidden="true">{f.mime === 'application/pdf' ? 'PDF' : 'TXT'}</span>
          {f.name || f.mime}
        </span>
      )))}
      {open && (
        <div className="chat-image-overlay" role="dialog" aria-label={open.name || '添付画像'} onClick={() => setOpen(null)}>
          <img src={open.src} alt={open.name || '添付画像'} />
        </div>
      )}
    </div>
  );
}

function UserBubble({ text, files, pending, failed, onDismiss }) {
  return (
    <div className={`chat-msg user${pending ? ' pending' : ''}${failed ? ' failed' : ''}`}>
      <UserFiles files={files} />
      {text && <div className="chat-bubble">{text}</div>}
      {failed && (
        <div className="chat-msg-error">
          送信できませんでした: {failed}
          {onDismiss && <button type="button" className="btn chat-link-btn" onClick={onDismiss}>閉じる</button>}
        </div>
      )}
    </div>
  );
}

function NoteMessage({ text }) {
  return <div className="chat-msg note">{text}</div>;
}

function renderMessage(m, streamingId) {
  switch (m.type) {
    case 'user':
      return <UserBubble key={m.id} text={m.text} files={m.files} />;
    case 'assistant':
      return <AssistantMessage key={m.id} message={m} streaming={m.id === streamingId} />;
    case 'shell':
      return (
        <div key={m.id} className="chat-msg note">
          <pre className="chat-tool-output">$ {m.command}{m.output?.output ? `\n${m.output.output}` : ''}</pre>
        </div>
      );
    case 'synthetic':
    case 'system':
      return m.description || m.text ? <NoteMessage key={m.id} text={m.description || m.text} /> : null;
    case 'compaction':
      return <NoteMessage key={m.id} text="会話を要約しました" />;
    case 'agent-switched':
      return <NoteMessage key={m.id} text={`エージェント: ${m.agent ?? ''}`} />;
    case 'model-switched':
      return <NoteMessage key={m.id} text={`モデル: ${m.model?.providerID ?? ''}/${m.model?.id ?? ''}`} />;
    default:
      return null;
  }
}

// The conversation. Follows the bottom while the user is there; once they
// scroll up to read, new output no longer yanks them down (a "最新へ"
// button brings them back).
export default function MessageList({ messages, pending, busy, onDismissPending, footer }) {
  const scrollRef = useRef(null);
  const atBottomRef = useRef(true);
  const [showJump, setShowJump] = useState(false);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    atBottomRef.current = atBottom;
    setShowJump(!atBottom);
  };

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && atBottomRef.current) el.scrollTop = el.scrollHeight;
  });

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return undefined;
    // Content that grows without a React update of this list (a code block
    // getting its copy button, an image of a font loading) keeps the pin.
    const ro = new ResizeObserver(() => {
      if (atBottomRef.current) el.scrollTop = el.scrollHeight;
    });
    for (const child of el.children) ro.observe(child);
    return () => ro.disconnect();
  }, []);

  const jump = () => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    atBottomRef.current = true;
    setShowJump(false);
  };

  let streamingId = null;
  if (busy) {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].type === 'assistant') { streamingId = messages[i].id; break; }
      if (messages[i].type === 'user') break;
    }
  }

  return (
    <div className="chat-scroll" ref={scrollRef} onScroll={onScroll}>
      <div className="chat-messages">
        {messages.length === 0 && pending.length === 0 && (
          <div className="chat-empty">メッセージを送って会話を始めましょう</div>
        )}
        {messages.map((m) => renderMessage(m, streamingId))}
        {pending.map((p) => (
          <UserBubble key={p.localId} text={p.text} files={p.files} pending failed={p.failed} onDismiss={() => onDismissPending(p.localId)} />
        ))}
        {busy && !streamingId && <div className="chat-thinking"><span className="chat-spinner small" /> 考え中…</div>}
        {footer}
      </div>
      {showJump && (
        <button type="button" className="chat-jump" onClick={jump}>↓ 最新へ</button>
      )}
    </div>
  );
}
