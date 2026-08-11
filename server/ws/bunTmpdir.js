// opencode runs on the Bun runtime. Bun unpacks its embedded `libopentui.so`
// into TMPDIR (default /tmp) and dlopens it at startup, so when /tmp is
// mounted noexec the mmap(PROT_EXEC) fails and the TUI dies immediately
// (opencode issues #26136 / #27580). ccserver works around it the same way as
// the upstream launcher PR #26134: when the host TMPDIR is on a noexec mount,
// point BUN_TMPDIR at ~/.cache/opencode/tmp so Bun's unpack succeeds.
//
// Pure helpers (parseMountOptions / mountHasNoexec) are exported for unit
// testing; the wrappers read the live environment.

import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, isAbsolute } from 'node:path';

// Unescape the octal escapes /proc/self/mounts uses for mountpoint
// characters that can't appear literally (space \040, tab \011, newline
// \012, backslash \134) so the mountpoint compares equal to the real path.
function unescapeMountPoint(mp) {
  return mp.replace(/\\([0-7]{3})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8)));
}

// Extract (mountpoint, options) pairs from /proc/self/mounts-style lines.
// Fields are whitespace-separated: device mountpoint fstype options dump pass.
export function parseMountOptions(lines) {
  const out = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length < 4) continue;
    out.push({ mountpoint: unescapeMountPoint(parts[1]), options: parts[3] });
  }
  return out;
}

// Longest-prefix mount match for `path` (the kernel picks the most specific
// mount), then check whether that mount's options contain `noexec`.
export function mountHasNoexec(path, lines) {
  let best = null;
  for (const { mountpoint, options } of parseMountOptions(lines)) {
    const prefix = mountpoint.endsWith('/') ? mountpoint : `${mountpoint}/`;
    if (path === mountpoint || path.startsWith(prefix)) {
      if (!best || mountpoint.length > best.mountpoint.length) {
        best = { mountpoint, options };
      }
    }
  }
  if (!best) return false;
  return best.options.split(',').includes('noexec');
}

// true only on Linux when the resolved TMPDIR (default /tmp) sits on a
// noexec mount. Relative or nonexistent TMPDIRs report false -- that is the
// historical behavior (no override), and a path Bun itself can't use is not
// one to mirror into BUN_TMPDIR.
export function isTmpNoexec() {
  if (process.platform !== 'linux') return false;
  const tmpdir = process.env.TMPDIR || '/tmp';
  if (!isAbsolute(tmpdir) || !existsSync(tmpdir)) return false;
  let lines;
  try {
    lines = readFileSync('/proc/self/mounts', 'utf-8').split('\n');
  } catch {
    return false;
  }
  return mountHasNoexec(tmpdir, lines);
}

// The replacement Bun temp dir, matching upstream launcher PR #26134.
function bunTmpDir() {
  return join(homedir(), '.cache', 'opencode', 'tmp');
}

// Returns the BUN_TMPDIR value when the host TMPDIR is noexec (creating the
// directory), or null otherwise -- the caller then launches exactly as
// before. mkdir failure quietly falls back to the historical /tmp launch.
export function bunTmpdirOverride() {
  if (!isTmpNoexec()) return null;
  const dir = bunTmpDir();
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    return null;
  }
  return dir;
}

// The env fragment for pty env assembly: { BUN_TMPDIR: dir } when an override
// is needed, {} otherwise -- so callers just spread it.
export function bunTmpdirEnv() {
  const dir = bunTmpdirOverride();
  return dir ? { BUN_TMPDIR: dir } : {};
}
