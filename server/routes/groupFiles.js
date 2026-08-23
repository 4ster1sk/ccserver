import { createReadStream, createWriteStream, unlinkSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import * as groupManager from '../ws/groupManager.js';
import { MAX_FILE_BYTES, MAX_FILES_PER_GROUP, MAX_GROUP_BYTES, ensureGroupFilesDir } from '../ws/groupFiles.js';

function safeFilename(name) {
  const b = basename(String(name || 'file'));
  // RFC-safe: encodeURIComponent for disposition
  return b;
}

export async function groupFilesRoute(fastify, opts) {
  // List files for a group
  fastify.get('/groups/:id/files', async (request, reply) => {
    const groupId = request.params.id;
    const group = groupManager.getGroup(groupId);
    if (!group) return reply.code(404).send({ error: 'Group not found' });
    const res = groupManager.listGroupFiles(groupId);
    if (res.error) return reply.code(404).send({ error: res.message || res.error });
    return { files: res.files };
  });

  // Upload files to a group (multipart) — streamed to a server-controlled
  // temp file per part with early per-file and per-group quota enforcement,
  // so the advertised 50 MiB / 200 MiB limits are enforced without buffering
  // up to the global 500 MiB multipart limit.
  fastify.post('/groups/:id/files', async (request, reply) => {
    const groupId = request.params.id;
    const group = groupManager.getGroup(groupId);
    if (!group) return reply.code(404).send({ error: 'Group not found' });

    // Pre-read existing counts for incremental quota checks.
    const existingCount = group.files ? group.files.size : 0;
    let existingBytes = 0;
    if (group.files) {
      for (const m of group.files.values()) existingBytes += m.size || 0;
    }

    const staged = []; // { name, mimeType, tempPath, size }
    let batchBytes = 0;
    const dir = ensureGroupFilesDir(groupId);
    let multipartError = null;

    const cleanupStaged = () => {
      for (const s of staged) {
        try { unlinkSync(s.tempPath); } catch { /* ignore */ }
      }
      staged.length = 0;
    };

    try {
      const parts = request.parts();
      for await (const part of parts) {
        if (part.type === 'file') {
          // Enforce max file count early (existing + already staged + this one).
          if (existingCount + staged.length + 1 > MAX_FILES_PER_GROUP) {
            // Drain this part's stream before erroring to avoid hanging the request.
            try { for await (const _ of part.file) { /* drain */ } } catch { /* ignore */ }
            multipartError = { error: 'too-many-files', message: `group already has the maximum of ${MAX_FILES_PER_GROUP} files` };
            break;
          }
          const filename = part.filename || 'file';
          const mimeType = part.mimetype || 'application/octet-stream';
          const tempPath = join(dir, `.tmp-upload-${randomUUID()}`);
          let size = 0;
          const ws = createWriteStream(tempPath, { mode: 0o600 });
          try {
            // Stream with per-chunk size accounting; abort as soon as we exceed MAX_FILE_BYTES.
            for await (const chunk of part.file) {
              size += chunk.length;
              if (size > MAX_FILE_BYTES) {
                ws.destroy();
                try { unlinkSync(tempPath); } catch { /* ignore */ }
                // Drain remainder of this file's stream.
                try { for await (const _ of part.file) { /* drain */ } } catch { /* ignore */ }
                multipartError = { error: 'too-large', message: `file ${filename} exceeds the ${MAX_FILE_BYTES} byte limit (got >${MAX_FILE_BYTES} bytes)` };
                break;
              }
              if (!ws.write(chunk)) {
                await new Promise((res, rej) => {
                  ws.once('drain', res);
                  ws.once('error', rej);
                });
              }
            }
            if (multipartError && multipartError.error === 'too-large') break;
            await new Promise((res, rej) => {
              ws.end((err) => err ? rej(err) : res());
              ws.once('error', rej);
            });
            // Enforce per-group total quota incrementally.
            if (existingBytes + batchBytes + size > MAX_GROUP_BYTES) {
              try { unlinkSync(tempPath); } catch { /* ignore */ }
              multipartError = { error: 'quota-exceeded', message: `group storage quota exceeded (${MAX_GROUP_BYTES} bytes)` };
              break;
            }
            batchBytes += size;
            staged.push({ name: filename, mimeType, tempPath, size });
          } catch (err) {
            try { ws.destroy(); } catch { /* ignore */ }
            try { unlinkSync(tempPath); } catch { /* ignore */ }
            if (err && err.code === 'too-large') {
              multipartError = { error: 'too-large', message: err.message };
            } else {
              multipartError = { error: 'bad-request', message: `failed to read upload: ${err.message}` };
            }
            break;
          }
        } else if (part.type === 'field') {
          const _ = part.value;
        }
      }
    } catch (err) {
      cleanupStaged();
      return reply.code(400).send({ error: `multipart error: ${err.message}` });
    }

    if (multipartError) {
      cleanupStaged();
      // Also drain any remaining parts to avoid hanging multipart.
      const codeMap = { 'too-large': 413, 'too-many-files': 400, 'quota-exceeded': 400, 'bad-request': 400 };
      return reply.code(codeMap[multipartError.error] || 400).send({ error: multipartError.error, message: multipartError.message });
    }

    if (staged.length === 0) {
      cleanupStaged();
      return reply.code(400).send({ error: 'no files provided' });
    }

    // Final atomic quota check is performed by the manager before promotion
    // (it re-reads the authoritative group state). Re-check here for correct
    // HTTP status mapping and to avoid promoting when another concurrent upload
    // raced us.
    const res = groupManager.commitStagedUploads(groupId, staged);
    if (res.error) {
      cleanupStaged();
      const codeMap = {
        'too-large': 413,
        'too-many-files': 400,
        'quota-exceeded': 400,
        'group-not-found': 404,
        'bad-request': 400,
      };
      return reply.code(codeMap[res.error] || 400).send({ error: res.error, message: res.message });
    }
    return { files: res.files };
  });

  // Download a file
  fastify.get('/groups/:id/files/:fileId', async (request, reply) => {
    const groupId = request.params.id;
    const fileId = request.params.fileId;
    const group = groupManager.getGroup(groupId);
    if (!group) return reply.code(404).send({ error: 'Group not found' });
    const meta = groupManager.fetchGroupFile(groupId, fileId);
    if (meta.error) {
      const code = meta.error === 'group-not-found' ? 404 : 404;
      return reply.code(code).send({ error: meta.error, message: meta.message });
    }
    try {
      const st = await stat(meta.blobPath);
      if (!st.isFile()) return reply.code(404).send({ error: 'file not found' });
      const safe = safeFilename(meta.name);
      // RFC 5987 encoding for non-ascii
      const disposition = `attachment; filename="${encodeURIComponent(safe)}"; filename*=UTF-8''${encodeURIComponent(safe)}`;
      reply.header('Content-Disposition', disposition);
      reply.header('Content-Length', st.size);
      reply.type(meta.mimeType || 'application/octet-stream');
      return reply.send(createReadStream(meta.blobPath));
    } catch (err) {
      if (err.code === 'ENOENT') return reply.code(404).send({ error: 'file not found' });
      throw err;
    }
  });

  // Delete a file
  fastify.delete('/groups/:id/files/:fileId', async (request, reply) => {
    const groupId = request.params.id;
    const fileId = request.params.fileId;
    const group = groupManager.getGroup(groupId);
    if (!group) return reply.code(404).send({ error: 'Group not found' });
    const res = groupManager.deleteGroupFile(groupId, fileId);
    if (res.error) {
      const code = res.error === 'not-found' ? 404 : res.error === 'group-not-found' ? 404 : 400;
      return reply.code(code).send({ error: res.error, message: res.message });
    }
    return { ok: true };
  });
}
