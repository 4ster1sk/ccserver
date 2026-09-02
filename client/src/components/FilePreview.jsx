import { useState, useEffect, useMemo } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { authFetch } from '../auth.js';
import { formatSize } from '../formatSize.js';

// Markdown -> HTML happens entirely in the browser. marked does no sanitizing
// (dropped in v8), and the source is whatever sits on the server's disk, so
// every render goes through DOMPurify before it reaches innerHTML.
marked.use({ gfm: true, breaks: false });

// リンクは常に別タブで開く。ダイアログ内で同一タブ遷移するとSPAごと離脱してしまう。
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A' && node.hasAttribute('href')) {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

/**
 * Render markdown source to sanitized HTML.
 * @param {string} src Markdown source.
 * @returns {string} HTML safe to assign to innerHTML.
 */
export function renderMarkdown(src) {
  const html = marked.parse(src);
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    // DOMPurify keeps <style> and style="" by default (CSS is not script), but
    // a file's stylesheet would apply to the whole page -- `body { display:
    // none }` blanks the app, position:fixed overlays cover the UI. Drop both;
    // rendered markdown gets its look from .markdown-body only.
    FORBID_TAGS: ['style'],
    FORBID_ATTR: ['style'],
  });
}

/**
 * Modal viewer for a text or markdown file in the directory browser.
 * @param {{ file: { name: string, path: string, size?: number }, onClose: () => void, onDownload: (file: object) => void }} props
 */
export default function FilePreview({ file, onClose, onDownload }) {
  const [state, setState] = useState({ status: 'loading', data: null, error: null });
  const [showSource, setShowSource] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading', data: null, error: null });
    setShowSource(false);
    (async () => {
      try {
        const params = new URLSearchParams({ path: file.path });
        const res = await authFetch(`/api/files/content?${params}`);
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || `HTTP ${res.status}`);
        }
        const data = await res.json();
        if (!cancelled) setState({ status: 'ready', data, error: null });
      } catch (err) {
        if (!cancelled) setState({ status: 'error', data: null, error: err.message });
      }
    })();
    return () => { cancelled = true; };
  }, [file.path]);

  // Escape closes, like the other overlays in the app.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const data = state.data;
  const isMarkdown = data?.kind === 'markdown';
  const html = useMemo(
    () => (isMarkdown && !showSource ? renderMarkdown(data.content) : null),
    [isMarkdown, showSource, data]
  );
  const size = data?.size ?? file.size;

  return (
    <div className="resume-overlay" onClick={onClose}>
      <div
        className="resume-dialog file-preview-dialog"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={file.name}
      >
        <div className="file-preview-header">
          <span className="file-preview-title" title={file.path}>{file.name}</span>
          {typeof size === 'number' && <span className="file-preview-meta">{formatSize(size)}</span>}
          {isMarkdown && (
            <div className="file-preview-toggle" role="group" aria-label="View mode">
              <button
                className={`btn btn-secondary${!showSource ? ' active' : ''}`}
                onClick={() => setShowSource(false)}
                aria-pressed={!showSource}
              >
                Rendered
              </button>
              <button
                className={`btn btn-secondary${showSource ? ' active' : ''}`}
                onClick={() => setShowSource(true)}
                aria-pressed={showSource}
              >
                Source
              </button>
            </div>
          )}
          <button
            className="btn btn-secondary file-preview-icon-btn"
            onClick={() => onDownload(file)}
            title="Download"
            aria-label="Download"
          >
            &#8595;
          </button>
          <button
            className="btn btn-secondary file-preview-icon-btn"
            onClick={onClose}
            title="Close"
            aria-label="Close"
          >
            &#10005;
          </button>
        </div>

        {data?.truncated && (
          <div className="file-preview-notice">
            Showing the first {formatSize(utf8ByteLength(data.content))} of this file. Download it to see the rest.
          </div>
        )}

        <div className="file-preview-body">
          {state.status === 'loading' && <div className="loading">Loading...</div>}
          {state.status === 'error' && <div className="error">Error: {state.error}</div>}
          {state.status === 'ready' && (
            html !== null
              ? <div className="markdown-body" dangerouslySetInnerHTML={{ __html: html }} />
              : <pre className="file-preview-text">{data.content}</pre>
          )}
        </div>
      </div>
    </div>
  );
}

// UTF-8 byte length of a JS string (TextEncoder is universal in browsers;
// Buffer is not).
function utf8ByteLength(str) {
  return new TextEncoder().encode(str).length;
}
