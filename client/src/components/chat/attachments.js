// Files attached to a chat prompt. They travel inline as data: URIs in
// opencode's prompt `files` ([{ uri, name }]) -- opencode serve takes them
// as they are, claude-chat-adapter turns them into Claude Code content
// blocks. The limits are the adapter's (Claude's 5 MB image limit; the
// proxy's 16 MB body leaves room for base64 of 10 MB).

export const MAX_FILES = 10;
export const MAX_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 10 * 1024 * 1024;

const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const PDF_MIME = 'application/pdf';
// Text the browser may not label text/* (or labels nothing at all).
const TEXT_MIMES = new Set([
  'application/json', 'application/xml', 'application/javascript', 'application/x-javascript',
  'application/typescript', 'application/x-yaml', 'application/yaml', 'application/toml',
  'application/x-sh', 'application/sql', 'application/x-ndjson', 'image/svg+xml',
]);

// What the file picker offers (anything else can still be dropped and is
// then checked by content).
export const ACCEPT = 'image/png,image/jpeg,image/gif,image/webp,application/pdf,text/*,.json,.yaml,.yml,.toml,.md,.log,.csv,.xml,.sh,.py,.js,.jsx,.ts,.tsx,.go,.rs,.java,.c,.h,.cpp,.rb,.php,.sql,.ini,.conf,.env,.diff,.patch';

export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function isImageMime(mime) {
  return IMAGE_MIMES.has(mime);
}

function readAs(file, method) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error || new Error('read failed'));
    r[method](file);
  });
}

// Whether the bytes are UTF-8 text (no NULs): how a file of unknown type is
// told apart from a binary one.
export function looksLikeText(buf) {
  const bytes = new Uint8Array(buf);
  if (bytes.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

function base64Of(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

let seq = 0;

// File -> { id, name, mime, size, kind, dataUrl }. Throws an Error with a
// message fit for the user when the file cannot be attached.
export async function readAttachment(file) {
  const name = file.name || (file.type.startsWith('image/') ? `image.${file.type.slice(6)}` : 'file');
  if (file.size > MAX_FILE_BYTES) throw new Error(`${name}: ${formatBytes(MAX_FILE_BYTES)} を超えるファイルは添付できません`);
  const type = (file.type || '').toLowerCase();
  let kind;
  if (IMAGE_MIMES.has(type)) kind = 'image';
  else if (type === PDF_MIME) kind = 'pdf';
  else if (type.startsWith('image/') || type.startsWith('audio/') || type.startsWith('video/')) {
    throw new Error(`${name}: この形式 (${type}) は添付できません（画像は PNG / JPEG / GIF / WebP）`);
  }
  const buf = await readAs(file, 'readAsArrayBuffer');
  let mime = type;
  if (!kind) {
    if (!looksLikeText(buf)) throw new Error(`${name}: 画像・PDF・テキスト以外のファイルは添付できません`);
    kind = 'text';
    if (!type.startsWith('text/') && !TEXT_MIMES.has(type)) mime = 'text/plain';
  }
  return { id: `att-${Date.now()}-${++seq}`, name, mime, size: file.size, kind, dataUrl: `data:${mime};base64,${base64Of(buf)}` };
}

// Adds files to `current`, within the limits. Resolves { list, errors }.
export async function addAttachments(current, files) {
  const list = [...current];
  const errors = [];
  for (const file of files) {
    if (list.length >= MAX_FILES) { errors.push(`添付は ${MAX_FILES} 個までです`); break; }
    try {
      const att = await readAttachment(file);
      const total = list.reduce((n, a) => n + a.size, 0) + att.size;
      if (total > MAX_TOTAL_BYTES) { errors.push(`${att.name}: 添付の合計は ${formatBytes(MAX_TOTAL_BYTES)} までです`); continue; }
      list.push(att);
    } catch (err) {
      errors.push(err.message);
    }
  }
  return { list, errors };
}

// The prompt body's `files`.
export function promptFiles(attachments) {
  return attachments.map((a) => ({ uri: a.dataUrl, name: a.name }));
}

// A user message's files (opencode's Prompt.FileAttachment: { data, mime,
// name? }) or a pending prompt's attachments -> what the bubble shows.
export function displayFiles(files) {
  if (!Array.isArray(files)) return [];
  return files.map((f, i) => {
    if (f.dataUrl) return { key: f.id || i, name: f.name, mime: f.mime, src: f.dataUrl };
    const mime = f.mime || 'application/octet-stream';
    return { key: i, name: f.name, mime, src: typeof f.data === 'string' ? `data:${mime};base64,${f.data}` : null };
  });
}
