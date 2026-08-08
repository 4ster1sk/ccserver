// Parses OSC 52 (clipboard) sequences in terminal output:
//   \x1b]52;c;<base64>\x07    app writes text to the clipboard
//   \x1b]52;c;?\x07           app asks for the clipboard content
// xterm.js ignores OSC 52, so the browser clipboard never updates — this
// extracts the sequences (removing them from the stream) and forwards them to
// injected callbacks. Browser-specific clipboard code stays in the caller so
// this module is testable under node.
//
// Stateful across chunks (a sequence may be split by WS messages); unbounded
// sequences are capped and passed through as-is.

const MAX_OSC_LEN = 128 * 1024;

function decodeBase64(b64) {
  try {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  } catch {
    return '';
  }
}

export function createOsc52Handler({ onWrite, onQuery }) {
  let pending = '';

  function handle(body) {
    // body is everything after "\x1b]" and before the terminator. Returns
    // true when the sequence was a well-formed OSC 52 (stripped from the
    // stream), false when it should pass through untouched.
    if (!body.startsWith('52;')) return false;
    const semicolon = body.indexOf(';', 3);
    if (semicolon === -1) return false; // malformed — leave it alone
    const clip = body.slice(3, semicolon) || 'c';
    const data = body.slice(semicolon + 1);
    if (clip === 'c') {
      if (data === '?') {
        if (onQuery) onQuery();
      } else {
        const text = decodeBase64(data);
        if (onWrite) onWrite(text);
      }
    }
    return true; // non-primary clipboards are ignored but still stripped
  }

  return {
    // Returns the chunk with OSC 52 sequences removed; others are emitted
    // unchanged.
    process(chunk) {
      const buf = pending + chunk;
      pending = '';
      let out = '';
      let i = 0;

      while (i < buf.length) {
        const idx = buf.indexOf('\x1b]', i);
        if (idx === -1) {
          out += buf.slice(i);
          break;
        }
        out += buf.slice(i, idx);

        // Locate the terminator (BEL or ESC \) — but not a trailing ESC that
        // could start the terminator in the next chunk.
        let term = -1;
        for (let j = idx + 2; j < buf.length; j++) {
          if (buf.charCodeAt(j) === 0x07) { term = j; break; }
          if (buf[j] === '\x1b' && buf[j + 1] === '\\') { term = j; break; }
        }

        if (term === -1) {
          const body = buf.slice(idx + 2);
          if (body.length > MAX_OSC_LEN) {
            out += buf.slice(idx); // too long to be a real OSC — emit as-is
          } else {
            pending = buf.slice(idx); // wait for the terminator
          }
          break;
        }

        if (handle(buf.slice(idx + 2, term))) {
          i = term + (buf.charCodeAt(term) === 0x07 ? 1 : 2);
        } else {
          i = term + (buf.charCodeAt(term) === 0x07 ? 1 : 2);
          out += buf.slice(idx, i); // non-52 OSC — pass through
        }
      }
      return out;
    },

    flush() {
      const rest = pending;
      pending = '';
      return rest;
    },
  };
}
