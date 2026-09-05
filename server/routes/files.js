import { createReadStream, constants } from 'node:fs';
import { stat, writeFile, open } from 'node:fs/promises';
import { resolve, basename, join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import mime from 'mime';

function safePath(requestedPath) {
  return resolve('/', requestedPath || '/');
}

// Inline preview cap. The file browser's viewer only needs the head of a huge
// file to be useful, and slurping a multi-GB log into memory just to show it
// would be a self-inflicted DoS. Anything past this is cut and reported via
// `truncated: true` so the client can point at the download button instead.
export const PREVIEW_MAX_BYTES = 1024 * 1024;

// Binary sniff window: a NUL byte inside the first 8 KiB is the classic
// "this is not text" signal (the same heuristic git's diff uses). Images,
// executables and archives all trip it; UTF-8 text never contains NUL.
export const SNIFF_BYTES = 8 * 1024;

// MIME overrides for extensions where the `mime` database returns the wrong
// answer (or none) for a plain-text source file. The keys are bare lowercase
// extensions without the dot; values feed the same previewable rule below
// (text/* + json in previewKind / isPreviewableMime).
//   .ts/.mts -> video/mp2t: registered media types that would hide
//     TypeScript sources behind "unsupported".
//   .cts/.tsx/.py/.go/.rb/.vue and friends -> unregistered (null): languages
//     the mime db simply does not know as file extensions.
//   .sh/.csh/.php/.pl/.tcl/.bat -> application/x-*: registered executable /
//     script types for plain-text sources, pinned back to text/*.
//   .js/.mjs -> application/javascript in mime v3 (root node_modules): pinned
//     to text/javascript so the rule holds regardless of the mime major.
//   .cjs -> application/node: Node-specific, pinned to text/javascript.
//   .xml/.xsl/.xsd/.rss/.atom -> application/*+xml: registered data types for
//     plain-text sources, pinned back to text/xml.
//   .sql -> application/sql, .toml -> application/toml: registered
//     non-text types for plain-text sources, pinned back to text/*.
//   .md/.markdown -> pinned to text/markdown so the markdown renderer is
//     driven by this table, not by whatever the library happens to return.
//   .jsonc -> unregistered: JSON with comments, viewable as JSON.
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

// Extensions the Files tab opens inline, decided by MIME type: text/* plus
// application/json and application/jsonc. Extension-less names and dotfiles
// (".md" alone) stay unsupported, matching the old extname() behaviour.
// Unknown extensions fall back to application/octet-stream (unsupported).
export function mimeForPreview(name) {
  const base = basename(String(name || ''));
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return 'application/octet-stream';
  const ext = base.slice(dot + 1).toLowerCase();
  return MIME_OVERRIDES[ext] || mime.getType(ext) || 'application/octet-stream';
}

/**
 * Whether a MIME type is viewable inline as text.
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
 * Classify a file name for the preview viewer.
 * @param {string} name File name or path.
 * @returns {'markdown' | 'json' | 'text' | null} null when the file is not previewable.
 */
export function previewKind(name) {
  const mt = mimeForPreview(name);
  if (mt === 'text/markdown') return 'markdown';
  if (mt === 'application/json' || mt === 'application/jsonc') return 'json';
  if (String(mt).startsWith('text/')) return 'text';
  return null;
}

/**
 * Read at most `limit` bytes from the start of a file plus one extra byte so
 * the caller can tell "exactly limit bytes" from "more than limit bytes"
 * without trusting the stat() size (the file may be growing).
 * @param {import('node:fs/promises').FileHandle} handle Open read handle.
 * @param {number} limit Maximum number of bytes to return.
 * @returns {Promise<{ data: Buffer, truncated: boolean }>}
 */
async function readHead(handle, limit) {
  const buf = Buffer.alloc(limit + 1);
  let offset = 0;
  while (offset < buf.length) {
    const { bytesRead } = await handle.read(buf, offset, buf.length - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  const truncated = offset > limit;
  return { data: buf.subarray(0, Math.min(offset, limit)), truncated };
}

export async function filesRoute(fastify, opts) {
  // Download
  fastify.get('/files', async (request, reply) => {
    const filePath = safePath(request.query.path);

    try {
      const st = await stat(filePath);
      if (!st.isFile()) {
        return reply.code(400).send({ error: 'Not a file' });
      }

      const name = basename(filePath);
      reply.header('Content-Disposition', `attachment; filename="${encodeURIComponent(name)}"`);
      reply.header('Content-Length', st.size);
      reply.type('application/octet-stream');
      return reply.send(createReadStream(filePath));
    } catch (err) {
      if (err.code === 'ENOENT') {
        return reply.code(404).send({ error: 'File not found' });
      }
      if (err.code === 'EACCES') {
        return reply.code(403).send({ error: 'Permission denied' });
      }
      throw err;
    }
  });

  // Inline preview for the file browser (text / markdown). Kept separate from
  // the download route above so its `Content-Disposition: attachment`
  // behaviour, which existing clients rely on, stays untouched.
  fastify.get('/files/content', async (request, reply) => {
    const requested = request.query.path;
    if (typeof requested !== 'string' || requested === '') {
      return reply.code(400).send({ error: 'path is required' });
    }
    const filePath = safePath(requested);
    const kind = previewKind(filePath);
    if (!kind) {
      return reply.code(415).send({ error: 'Unsupported file type' });
    }
    let handle = null;

    try {
      // Open first, validate through the handle. A stat() on the path followed
      // by a separate open() re-resolves the name, so a rename or symlink swap
      // in between would make us serve a file we never checked (TOCTOU).
      // Everything below -- type check, size, sniff, read -- goes through this
      // one FileHandle. O_NONBLOCK keeps a FIFO (or another blocking special
      // file) from parking the request and a libuv thread forever; it has no
      // effect on regular files.
      handle = await open(filePath, constants.O_RDONLY | constants.O_NONBLOCK);
      const st = await handle.stat();
      if (!st.isFile()) {
        return reply.code(400).send({ error: 'Not a file' });
      }

      const { data, truncated } = await readHead(handle, PREVIEW_MAX_BYTES);

      if (data.subarray(0, SNIFF_BYTES).includes(0)) {
        return reply.code(415).send({ error: 'Binary file' });
      }

      // 切り詰めた場合、末尾にUTF-8のマルチバイト列の途中が残り得る。
      // StringDecoderはその不完全な末尾を保持するので、end()を呼ばずに捨てる。
      // 切り詰めていない場合はend()で残りを吐き出す(不正なUTF-8ならU+FFFDになる)。
      const decoder = new StringDecoder('utf8');
      let content = decoder.write(data);
      if (!truncated) content += decoder.end();
      // 先頭のBOM(U+FEFF)は表示上見えないが、Markdownでは`#`の前に居座って
      // 見出しとして解釈されなくなる(Windows製エディタのファイルで起きる)ので落とす。
      if (content.charCodeAt(0) === 0xfeff) content = content.slice(1);

      return {
        path: filePath,
        name: basename(filePath),
        size: st.size,
        mtime: st.mtimeMs,
        kind,
        content,
        truncated,
      };
    } catch (err) {
      if (err.code === 'ENOENT') {
        return reply.code(404).send({ error: 'File not found' });
      }
      if (err.code === 'EACCES') {
        return reply.code(403).send({ error: 'Permission denied' });
      }
      // open() itself refuses some non-files before stat() gets a say:
      // directories on platforms that reject O_RDONLY on them, sockets (ENXIO).
      if (err.code === 'EISDIR' || err.code === 'ENXIO') {
        return reply.code(400).send({ error: 'Not a file' });
      }
      throw err;
    } finally {
      if (handle) await handle.close().catch(() => {});
    }
  });

  // Upload (multipart)
  fastify.post('/files', async (request, reply) => {
    const parts = request.parts();
    let destination = null;
    const uploaded = [];

    for await (const part of parts) {
      if (part.type === 'field' && part.fieldname === 'destination') {
        destination = safePath(part.value);
        continue;
      }

      if (part.type === 'file') {
        if (!destination) {
          // Consume and discard to avoid stream errors
          await part.toBuffer();
          return reply.code(400).send({ error: 'destination field must come before files' });
        }

        const name = basename(part.filename);
        if (!name || name === '.' || name === '..') {
          await part.toBuffer();
          continue;
        }

        const targetPath = join(destination, name);
        try {
          const buf = await part.toBuffer();
          await writeFile(targetPath, buf);
          uploaded.push({ name, path: targetPath, size: buf.length });
        } catch (err) {
          if (err.code === 'EACCES') {
            return reply.code(403).send({ error: `Permission denied: ${name}` });
          }
          if (err.code === 'ENOENT') {
            return reply.code(404).send({ error: 'Destination directory not found' });
          }
          throw err;
        }
      }
    }

    return { uploaded };
  });
}
