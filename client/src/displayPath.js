// Display-layer helper: abbreviate the $HOME prefix of a path as `~`.
// Server APIs keep returning raw absolute paths; only the string shown to
// the user goes through this. `title` attributes keep the raw path.
export function displayPath(path, home) {
  if (!path) return '';
  if (!home) return path;
  if (path === home) return '~';
  if (home.endsWith('/')) home = home.slice(0, -1);
  if (path.startsWith(home + '/')) return '~' + path.slice(home.length);
  return path;
}
