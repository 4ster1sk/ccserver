// Group-scoped file exchange: blob storage, manifest, quotas, and helpers.
// Blobs live outside project worktrees in a server-managed directory:
//   <groupFilesRoot>/<groupId>/<generated-id>
// Manifest lives in .saved-group-files.json (parallel to docs), with per-file
// metadata: id, name, size, mimeType, direction, publishedBy, publishedAt, storedName.
// All path generation is server-controlled; upload filenames are never used as
// path components.

import { homedir } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { mkdirSync, existsSync, statSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Limits (plan section 2): per-file, per-group count, per-group bytes.
export const MAX_FILE_BYTES = 50 * 1024 * 1024;
export const MAX_FILES_PER_GROUP = 20;
export const MAX_GROUP_BYTES = 200 * 1024 * 1024;

// Fixed in-sandbox path where each live member's group-file root is read-only bound.
export const SANDBOX_GROUP_FILES_PATH = '/ccserver-group-files';

// Blob root (host) and manifest path, both overridable for tests.
export function getGroupFilesRoot() {
  return process.env.CCSERVER_GROUP_FILES_ROOT
    || join(homedir(), '.local', 'share', 'ccserver-sandbox', 'group-files');
}

export function getGroupFilesManifestPath() {
  return process.env.CCSERVER_GROUP_FILES_PATH
    || join(__dirname, '..', '..', '.saved-group-files.json');
}

export function getGroupFilesDir(groupId) {
  return join(getGroupFilesRoot(), String(groupId));
}

export function ensureGroupFilesDir(groupId) {
  const dir = getGroupFilesDir(groupId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

// Display name sanitization: basename, trim, fallback to 'file', length cap.
export function sanitizeDisplayName(name) {
  if (typeof name !== 'string' || !name) return 'file';
  let base = basename(String(name));
  base = base.trim();
  if (!base || base === '.' || base === '..') return 'file';
  // Avoid empty after sanitization and cap length.
  if (base.length > 255) base = base.slice(0, 255);
  return base;
}

const MIME_MAP = {
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.js': 'text/javascript',
  '.ts': 'text/typescript',
  '.html': 'text/html',
  '.css': 'text/css',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.tar': 'application/x-tar',
  '.gz': 'application/gzip',
};

export function mimeForName(name) {
  const ext = extname(String(name || '')).toLowerCase();
  return MIME_MAP[ext] || 'application/octet-stream';
}

export function generateFileId() {
  return randomUUID();
}

// Stored blob name: generated id only, never the upload's filename.
// Using the id alone avoids any injection via filename.
export function storedNameForId(fileId) {
  return String(fileId);
}

export function blobPathFor(groupId, storedName) {
  // storedName is server-generated (uuid), so joining is safe; still validate
  // that the result stays under the group's root to guard against future misuse.
  const dir = getGroupFilesDir(groupId);
  const p = join(dir, String(storedName));
  const resolved = resolve(p);
  const rootResolved = resolve(dir);
  if (resolved !== rootResolved && !resolved.startsWith(rootResolved + '/')) {
    throw new Error('blob path escapes group root');
  }
  return resolved;
}

export function sandboxPathFor(storedName) {
  return join(SANDBOX_GROUP_FILES_PATH, String(storedName));
}

// Quota helpers: pure over a files Map (id -> meta).
export function totalBytesForFiles(filesMap) {
  let total = 0;
  for (const meta of filesMap.values()) total += meta.size || 0;
  return total;
}

export function checkQuotaBeforeAdd(filesMap, newSize) {
  if (newSize > MAX_FILE_BYTES) {
    return { error: 'too-large', message: `file exceeds the ${MAX_FILE_BYTES} byte limit (got ${newSize} bytes)` };
  }
  if (filesMap.size >= MAX_FILES_PER_GROUP) {
    return { error: 'too-many-files', message: `group already has the maximum of ${MAX_FILES_PER_GROUP} files` };
  }
  const total = totalBytesForFiles(filesMap);
  if (total + newSize > MAX_GROUP_BYTES) {
    return { error: 'quota-exceeded', message: `group storage quota exceeded (${MAX_GROUP_BYTES} bytes)` };
  }
  return null;
}

// Validate an agent's claimed source path: must be relative, no absolute,
// and after resolving against cwd and realpath, must remain under the real
// worktree root and be a regular file.
// Returns { ok: true, realPath } or { error, message }.
export function resolveAgentSourcePath(cwd, relativePath) {
  if (typeof relativePath !== 'string' || !relativePath) {
    return { error: 'bad-request', message: 'path must be a non-empty string' };
  }
  if (relativePath.startsWith('/') || relativePath.includes('\0')) {
    return { error: 'bad-request', message: 'path must be relative and not absolute' };
  }
  // Reject traversal attempts before realpath as well (defense in depth).
  // The real containment check below is authoritative, this just gives a
  // clearer error for obvious traversal.
  if (relativePath.split('/').includes('..')) {
    // Still attempt realpath check to catch symlink escapes, but flag early
    // if the normalized join would escape.
    // We don't return immediately; let the containment check decide, but we
    // can keep the error as bad-request.
  }
  const joined = join(cwd, relativePath);
  const resolved = resolve(joined);
  // Ensure the resolved path is inside cwd (before realpath).
  const cwdResolved = resolve(cwd);
  if (resolved !== cwdResolved && !resolved.startsWith(cwdResolved + '/')) {
    return { error: 'bad-request', message: 'path escapes the worktree' };
  }
  let realCwd;
  let realTarget;
  try {
    realCwd = realpathSync(cwdResolved);
  } catch {
    return { error: 'bad-request', message: 'worktree not found' };
  }
  try {
    realTarget = realpathSync(resolved);
  } catch (err) {
    if (err.code === 'ENOENT') return { error: 'not-found', message: 'file not found' };
    return { error: 'bad-request', message: `cannot resolve path: ${err.message}` };
  }
  if (realTarget !== realCwd && !realTarget.startsWith(realCwd + '/')) {
    return { error: 'bad-request', message: 'path escapes the worktree (symlink)' };
  }
  // Must be a regular file.
  let st;
  try {
    st = statSync(realTarget);
  } catch {
    return { error: 'not-found', message: 'file not found' };
  }
  if (!st.isFile()) {
    return { error: 'bad-request', message: 'not a regular file' };
  }
  return { ok: true, realPath: realTarget, size: st.size };
}

// Verify that a path to be deleted is safely under the group-files root.
// Prevents recursive delete of arbitrary host paths via a caller-derived groupId.
export function safeGroupFilesDirForDelete(groupId) {
  const root = resolve(getGroupFilesRoot());
  const dir = resolve(getGroupFilesDir(groupId));
  if (dir === root || (!dir.startsWith(root + '/'))) {
    throw new Error('group files dir escapes root');
  }
  // Also guard against empty or path-traversal groupIds.
  if (String(groupId).includes('/') || String(groupId).includes('\0') || String(groupId).includes('..')) {
    throw new Error('invalid groupId for deletion');
  }
  return dir;
}
