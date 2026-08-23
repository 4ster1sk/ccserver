import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename } from 'node:path';
import * as groupManager from '../ws/groupManager.js';

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

  // Upload files to a group (multipart)
  fastify.post('/groups/:id/files', async (request, reply) => {
    const groupId = request.params.id;
    const group = groupManager.getGroup(groupId);
    if (!group) return reply.code(404).send({ error: 'Group not found' });

    const files = [];
    try {
      const parts = request.parts();
      for await (const part of parts) {
        if (part.type === 'file') {
          // Ignore non-file fields; do not accept path parameter
          const filename = part.filename || 'file';
          const mimeType = part.mimetype || 'application/octet-stream';
          let buf;
          try {
            buf = await part.toBuffer();
          } catch (err) {
            return reply.code(400).send({ error: `failed to read upload: ${err.message}` });
          }
          files.push({ name: filename, mimeType, data: buf });
        } else if (part.type === 'field') {
          // For security, ignore any field named 'path' etc.; just consume
          // But we should not allow a field to specify disk path.
          // No-op: consume value
          const _ = part.value;
        }
      }
    } catch (err) {
      return reply.code(400).send({ error: `multipart error: ${err.message}` });
    }

    if (files.length === 0) {
      return reply.code(400).send({ error: 'no files provided' });
    }

    const res = groupManager.publishGroupFilesFromUpload(groupId, files, null);
    if (res.error) {
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
