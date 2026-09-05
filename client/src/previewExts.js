// Which files the Files tab opens inline, decided by MIME type: text/* plus
// application/json and application/jsonc. The server
// (server/routes/files.js) applies the same rule; server/routes/files.test.js
// asserts the two agree, so a change on one side without the other fails
// `npm test`.
import mime from 'mime';

// Same overrides as the server: extensions where the `mime` database returns
// the wrong answer (or none) for a plain-text source file. Keys are bare
// lowercase extensions without the dot.
export const MIME_OVERRIDES = {
  md: 'text/markdown',
  markdown: 'text/markdown',
  js: 'text/javascript',
  mjs: 'text/javascript',
  cjs: 'text/javascript',
  ts: 'text/typescript',
  mts: 'text/typescript',
  cts: 'text/typescript',
  tsx: 'text/tsx',
  jsx: 'text/jsx',
  vue: 'text/x-vue',
  svelte: 'text/x-svelte',
  astro: 'text/x-astro',
  py: 'text/x-python',
  rb: 'text/x-ruby',
  go: 'text/x-go',
  rs: 'text/x-rust',
  sh: 'text/x-sh',
  bash: 'text/x-sh',
  zsh: 'text/x-sh',
  fish: 'text/x-sh',
  ksh: 'text/x-sh',
  csh: 'text/x-csh',
  php: 'text/x-php',
  pl: 'text/x-perl',
  pm: 'text/x-perl',
  tcl: 'text/x-tcl',
  bat: 'text/x-bat',
  cmd: 'text/x-bat',
  ps1: 'text/x-powershell',
  lua: 'text/x-lua',
  r: 'text/x-r',
  scala: 'text/x-scala',
  kt: 'text/x-kotlin',
  swift: 'text/x-swift',
  cs: 'text/x-csharp',
  vb: 'text/x-vb',
  hpp: 'text/x-c',
  dart: 'text/x-dart',
  xml: 'text/xml',
  xsl: 'text/xml',
  xsd: 'text/xml',
  rss: 'text/xml',
  atom: 'text/xml',
  graphql: 'text/x-graphql',
  gql: 'text/x-graphql',
  sql: 'text/x-sql',
  diff: 'text/x-diff',
  patch: 'text/x-diff',
  toml: 'text/x-toml',
  jsonc: 'application/jsonc',
};

// Files bigger than this ask "really open?" before fetching (see
// requestPreview in DirectoryBrowser.jsx). formatSize uses 1024-based units,
// so follow it here; strictly greater (exactly 100 KiB opens without asking).
export const PREVIEW_CONFIRM_BYTES = 100 * 1024;

/**
 * MIME type used to decide whether a file is previewable.
 * @param {string} name File name (not a path; only the extension matters).
 * @returns {string} e.g. 'text/plain'; 'application/octet-stream' when unknown.
 */
export function mimeForPreview(name) {
  const base = String(name || '').split('/').pop();
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return 'application/octet-stream';
  const ext = base.slice(dot + 1).toLowerCase();
  return MIME_OVERRIDES[ext] || mime.getType(ext) || 'application/octet-stream';
}

/**
 * Whether the MIME type is viewable inline as text.
 * @param {string} mt MIME type.
 * @returns {boolean}
 */
export function isPreviewableMime(mt) {
  return mt === 'text/markdown'
    || mt === 'application/json'
    || mt === 'application/jsonc'
    || String(mt).startsWith('text/');
}

/**
 * Whether the file browser should open this file inline.
 * @param {string} name File name (not a path; only the extension matters).
 * @returns {boolean}
 */
export function isPreviewable(name) {
  return isPreviewableMime(mimeForPreview(name));
}

/**
 * Classify a file name for the preview viewer (client mirror of the server's
 * previewKind; kept for the agreement test and future callers).
 * @param {string} name File name (not a path; only the extension matters).
 * @returns {'markdown' | 'json' | 'text' | null} null when the file is not previewable.
 */
export function previewKind(name) {
  const mt = mimeForPreview(name);
  if (mt === 'text/markdown') return 'markdown';
  if (mt === 'application/json' || mt === 'application/jsonc') return 'json';
  if (String(mt).startsWith('text/')) return 'text';
  return null;
}
