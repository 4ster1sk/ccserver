// Extensions the Files tab opens inline. Must match PREVIEW_EXTS in
// server/routes/files.js -- server/routes/files.test.js asserts the two agree,
// so a change on one side without the other fails `npm test`.
export const PREVIEW_EXTS = ['.md', '.txt'];

/**
 * Whether the file browser should open this file inline.
 * @param {string} name File name (not a path; only the extension matters).
 * @returns {boolean}
 */
export function isPreviewable(name) {
  const lower = String(name || '').toLowerCase();
  // `lower.length > ext.length` keeps dotfiles like ".md" out: extname() on the
  // server treats them as extension-less, and the two sides must agree.
  return PREVIEW_EXTS.some((ext) => lower.length > ext.length && lower.endsWith(ext));
}
