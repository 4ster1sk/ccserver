import { memo, useEffect, useMemo, useRef } from 'react';
import { renderMarkdown } from '../PreviewDialog.jsx';

// Assistant markdown, sanitized by the same renderer as the file preview
// (no auto-fetching elements). Code blocks get a copy button.
function Markdown({ text }) {
  const html = useMemo(() => renderMarkdown(text || ''), [text]);
  const ref = useRef(null);
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    for (const pre of root.querySelectorAll('pre')) {
      if (pre.querySelector('.chat-copy-btn')) continue;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'chat-copy-btn';
      btn.textContent = 'コピー';
      btn.addEventListener('click', () => {
        const code = pre.querySelector('code')?.innerText ?? pre.innerText;
        navigator.clipboard?.writeText(code).then(() => {
          btn.textContent = 'コピーしました';
          setTimeout(() => { btn.textContent = 'コピー'; }, 1200);
        }).catch(() => {});
      });
      pre.appendChild(btn);
    }
  }, [html]);
  // eslint-disable-next-line react/no-danger
  return <div ref={ref} className="chat-md" dangerouslySetInnerHTML={{ __html: html }} />;
}

export default memo(Markdown);
