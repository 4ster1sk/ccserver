// Stream transform for agent TUIs that ccserver cannot configure via env vars.
//
// opencode (open-tui) enters the alternate screen (DECSET 1049), where
// xterm.js keeps no scrollback — the scroll buttons/wheel do nothing while it
// is active. opencode has no env var to disable the alternate screen, so we
// rewrite the byte stream instead:
//
//   1. \x1b[?1049h / \x1b[?1049l are dropped, keeping the TUI in the main
//      buffer where xterm.js scrollback works.
//
//   2. opencode redraws in place (per-cell cursor positioning) and never
//      emits newlines, so even in the main buffer scrollback never grows and
//      earlier conversation frames are simply overwritten. To make history
//      scrollable, whole-screen frames are buffered and, when one completes,
//      the *current* screen is pushed into scrollback (jump to the bottom
//      row, emit `rows` line feeds) before the new frame is drawn. A frame is
//      "whole-screen" when it repaints at least ~40% of the viewport (8+ rows
//      on a 30-row terminal); partial frames (streaming tokens, spinners,
//      status-bar ticks) pass through immediately so live updates stay
//      smooth.
//
//   3. Pushes are coalesced (at most one per COALESCE_MS) so a burst of rapid
//      full redraws (submit -> thinking -> response) doesn't flood scrollback
//      with near-identical pages.
//
// The transform is stateful: escape sequences and frames split across WS
// chunks are buffered until they can be decided.

const SYNC_BEGIN = '\x1b[?2026h'; // synchronized-output mode on (frame start)
const SYNC_END = '\x1b[?2026l';   // ... off (frame end)

const TARGETS = [
  '\x1b[?1049h',
  '\x1b[?1049l',
  SYNC_BEGIN,
  SYNC_END,
];

const MAX_SEQ_LEN = Math.max(...TARGETS.map((t) => t.length));

const COALESCE_MS = 2000;
const MAX_FRAME_BYTES = 64 * 1024;

// A frame repaints this many distinct rows to count as whole-screen.
// Measured against real opencode output: conversation-level redraws paint
// ~8-11 rows (message area + input + status) while streaming updates paint
// 1-3 rows (changed cells only).
function fullRowsFor(rows) {
  return Math.min(8, Math.floor(rows * 0.4));
}

const CUP_RE = /\x1b\[(\d+);\d+H/g;

// Returns a { transform, flush } object for `app`, or null when the app needs
// no rewriting (claude, shells).
export function createOutputTransform(app, rows = 24, { now = Date.now } = {}) {
  if (app !== 'opencode') return null;
  let pending = '';
  let rowsNow = rows;

  // Frame collection state (sync-mode frames \x1b[?2026h .. \x1b[?2026l).
  let collecting = false;
  let frameBuf = '';
  let oversized = false; // frame exceeded MAX_FRAME_BYTES: emit raw, no push

  // Scrollback paging state.
  let fullRows = fullRowsFor(rowsNow);
  let rowsSincePush = new Set(); // rows painted by frames since the last push
  let lastPushAt = now();        // created => the first frame never pushes

  return {
    // Update the pty row count (window resizes); used for the frame-size
    // heuristic and the number of line feeds emitted per scrollback push.
    setRows(r) {
      rowsNow = r;
      fullRows = fullRowsFor(rowsNow);
    },

    transform(chunk) {
      const data = pending + chunk;
      pending = '';
      let out = '';
      let i = 0;

      // Append to the collected frame, flushing raw once the cap trips so a
      // malformed/unbounded frame can never grow memory or stall output.
      const appendToFrame = (s) => {
        if (oversized) {
          out += s;
        } else {
          frameBuf += s;
          if (frameBuf.length > MAX_FRAME_BYTES) {
            out += frameBuf;
            frameBuf = '';
            oversized = true;
          }
        }
      };

      while (i < data.length) {
        const esc = data.indexOf('\x1b', i);
        if (esc === -1) {
          const rest = data.slice(i);
          if (collecting) appendToFrame(rest);
          else out += rest;
          break;
        }
        if (collecting) appendToFrame(data.slice(i, esc));
        else out += data.slice(i, esc);

        // Complete target at this position?
        let matched = null;
        for (const t of TARGETS) {
          if (data.startsWith(t, esc)) { matched = t; break; }
        }

        if (matched) {
          if (matched === SYNC_BEGIN && !collecting) {
            // Start of a frame: buffer it so we can decide full vs partial.
            collecting = true;
            frameBuf = '';
            oversized = false;
            appendToFrame(SYNC_BEGIN);
          } else if (matched === SYNC_END && collecting) {
            appendToFrame(SYNC_END);
            out = finalizeFrame(out);
          } else if (collecting && matched !== '\x1b[?1049h' && matched !== '\x1b[?1049l') {
            // A nested sync-begin inside a frame: keep it verbatim. 1049
            // markers are dropped everywhere so the alt screen can never
            // activate (it would freeze xterm.js scrollback).
            appendToFrame(matched);
          }
          // else: unmatched \x1b[?1049* or a stray \x1b[?2026l outside a
          // frame are dropped — the alt screen must not be entered, and an
          // orphan sync-end is harmless.
          i = esc + matched.length;
          continue;
        }

        // Tail is a strict prefix of a target (may continue in the next
        // chunk)? Hold it back. Capped at MAX_SEQ_LEN - 1 so stray ESC
        // sequences can never grow the pending buffer.
        const rest = data.slice(esc);
        if (rest.length < MAX_SEQ_LEN) {
          let isPrefix = false;
          for (const t of TARGETS) {
            if (t.startsWith(rest)) { isPrefix = true; break; }
          }
          if (isPrefix) {
            pending = rest;
            break;
          }
        }

        // Not a target: emit the ESC itself and keep scanning after it.
        if (collecting) appendToFrame('\x1b');
        else out += '\x1b';
        i = esc + 1;
      }
      return out;
    },

    flush() {
      const rest = pending;
      pending = '';
      const buf = frameBuf;
      frameBuf = '';
      collecting = false;
      return buf + rest;
    },
  };

  // A complete sync frame was collected: decide whether the previous screen
  // goes into scrollback, then emit the frame.
  function finalizeFrame(out) {
    if (!oversized) {
      const painted = new Set();
      for (const m of frameBuf.matchAll(CUP_RE)) {
        const r = Number(m[1]);
        if (r >= 1 && r <= rowsNow) painted.add(r);
      }
      if (
        painted.size >= fullRows &&
        rowsSincePush.size >= fullRows &&
        now() - lastPushAt >= COALESCE_MS
      ) {
        // Move to the bottom row, then emit rows line feeds: each one scrolls
        // the top line into xterm.js's scrollback, so the whole previous
        // frame becomes history before the new frame is drawn.
        out += `\x1b[${rowsNow};1H` + '\n'.repeat(rowsNow);
        lastPushAt = now();
        rowsSincePush = new Set();
      }
      for (const r of painted) rowsSincePush.add(r);
    }
    out += frameBuf; // empty in oversized mode
    frameBuf = '';
    collecting = false;
    oversized = false;
    return out;
  }
}
