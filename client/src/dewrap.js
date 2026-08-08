// Claude Code (and similar CLIs) hard-wrap their own prose output to fit the
// terminal width themselves, printing each wrapped line as a real newline
// with a fixed indent -- rather than relying on the terminal's own soft-wrap,
// which xterm.js could otherwise cleanly distinguish via a buffer line's
// isWrapped flag. That means a copied paragraph normally comes out as one
// line per screen row, 2-space continuation indent and all, instead of the
// single flowing paragraph it visually reads as.
//
// This heuristically rejoins lines that look like wrap continuations: no
// buffer access, just the already-copied text, so it also works as a plain
// post-process on term.getSelection()'s output.
const BLOCK_MARKERS = /^[-●○✻✓✔⏺─━╭╰│┃❯>#*•]|^\d+[.)]\s/;

export function dewrapSelection(text, cols) {
  if (!text) return text;
  const lines = text.split('\n');
  // A wrapped continuation line only exists because the previous line was
  // pushed right up against the terminal width; a line well short of that
  // was a deliberate break, not a forced one.
  const widthThreshold = Math.max(20, Math.floor((cols || 80) * 0.7));

  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.replace(/\s+$/, '');
    const leading = line.match(/^[ \t]*/)[0];
    const content = line.slice(leading.length).replace(/\s+$/, '');

    if (out.length === 0) {
      out.push(trimmed);
      continue;
    }

    const prevTrimmed = lines[i - 1].replace(/\s+$/, '');
    const prevIsBlank = prevTrimmed.trim().length === 0;
    const curIsBlank = trimmed.trim().length === 0;
    const curStartsBlock = BLOCK_MARKERS.test(content);
    const prevLooksForced = prevTrimmed.length >= widthThreshold;

    if (prevIsBlank || curIsBlank || curStartsBlock || !prevLooksForced) {
      out.push(trimmed);
    } else {
      out[out.length - 1] += ' ' + content;
    }
  }

  // Strip a shared leading indent across every resulting line (e.g. a
  // selection that starts mid-indent, or an indented code snippet copied on
  // its own) -- same idea as Python's textwrap.dedent.
  const nonBlank = out.filter((l) => l.trim().length > 0);
  if (nonBlank.length === 0) return out.join('\n');
  const common = nonBlank.reduce((min, l) => {
    const m = l.match(/^[ \t]*/)[0];
    let i = 0;
    while (i < min.length && i < m.length && min[i] === m[i]) i++;
    return min.slice(0, i);
  }, nonBlank[0].match(/^[ \t]*/)[0]);
  if (!common) return out.join('\n');
  return out.map((l) => (l.startsWith(common) ? l.slice(common.length) : l)).join('\n');
}
