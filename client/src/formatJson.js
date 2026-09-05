/**
 * Pretty-print JSON source with 2-space indentation.
 * @param {string} src Raw JSON source.
 * @returns {string | null} Formatted JSON, or null when the source is not
 * valid JSON (malformed, JSONC comments, or cut off by truncation).
 */
export function formatJson(src) {
  try {
    return JSON.stringify(JSON.parse(src), null, 2);
  } catch {
    return null;
  }
}
