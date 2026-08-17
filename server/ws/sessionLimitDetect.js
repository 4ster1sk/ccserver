// Pure detection/time-math helpers for the "session limit hit" auto-resume
// feature. No imports, no app state -- unit-testable directly with
// node --test (see sessionLimitDetect.test.js). sessionManager.js owns ANSI
// stripping (mcpTools.js's stripAnsi) and buffering; this module only
// consumes the resulting text.
//
// Claude's Ink renderer sometimes draws a status line word-by-word using
// cursor-absolute-position escapes (`ESC[<N>G`) instead of plain spaces.
// Stripping ANSI codes then removes the *positioning* but not-a-space gap
// between words, so the text can arrive as
// "You'vehityoursessionlimit·resets2:10am(Asia/Tokyo)" with no spaces
// at all. appLaunch.js's detectPermissionPrompt hit the same issue for
// permission-prompt detection and settled on matching against a
// space-collapsed copy of the buffer; this module follows that established
// pattern rather than trying to guess where spaces might or might not
// survive.

// Matches only "hit your session limit" (never the earlier warning "used
// 99% of your session limit"), so a same-session warning-then-hit sequence
// can't double-fire and a warning alone never fires at all. `\D*?` between
// "limit" and "resets" absorbs the separator ("·", punctuation, or
// nothing) regardless of which characters survive ANSI stripping. `g` lets
// findSessionLimitReset walk past a candidate that parses to nothing (see
// below) instead of giving up at the first substring match.
const SESSION_LIMIT_RE = /hityoursessionlimit\D*?resets(\d{1,2}):(\d{2})(am|pm)\(([^)]+)\)/gi;

// text: the session's recent output, ANSI-stripped by the caller (raw bytes,
// not the virtual screen -- see sessionManager.js for why). Returns
// { resetAtMs, timeZone } for the soonest VALID matching reset, or null when
// there is no candidate at all, or every candidate fails to parse.
//
// The buffer this scans is an accumulation of raw terminal bytes, which can
// contain more than just the agent's own status line -- e.g. a wrapped
// terminal line can interleave a stray "\r" mid-word and mangle an unrelated
// substring into something that only *looks* like a match (this is exactly
// what happens when a shell echoes back a long command line under an 80-col
// pty, which is how this module's own tests reproduce it). Stopping at the
// first regex match and returning null on its failure would let one mangled
// false-positive substring hide a real, well-formed message later in the
// same buffer -- so on a parse failure this keeps scanning for the next
// candidate rather than giving up.
export function findSessionLimitReset(text, now = Date.now()) {
  const noSpace = String(text).replace(/\s+/g, '');
  SESSION_LIMIT_RE.lastIndex = 0;
  let m;
  while ((m = SESSION_LIMIT_RE.exec(noSpace)) !== null) {
    const hour12 = parseInt(m[1], 10);
    const minute = parseInt(m[2], 10);
    const meridiem = m[3].toLowerCase();
    const timeZone = m[4];
    if (hour12 >= 1 && hour12 <= 12 && minute <= 59) {
      let hour = hour12 % 12;
      if (meridiem === 'pm') hour += 12;
      const resetAtMs = nextZonedTimeEpoch(hour, minute, timeZone, now);
      if (resetAtMs != null) return { resetAtMs, timeZone };
    }
  }
  return null;
}

// The UTC offset (ms) that `timeZone` observes at `epochMs`, i.e. how much to
// ADD to a UTC instant to get that zone's local wall-clock reading (so
// `epochMs + offset` formatted in UTC equals `epochMs` formatted in
// `timeZone`).
function tzOffsetMs(epochMs, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(epochMs));
  const map = {};
  for (const p of parts) map[p.type] = p.value;
  // hour can render "24" for midnight under hourCycle:h23 in some ICU
  // versions; normalize so Date.UTC doesn't roll into the next day.
  const hour = Number(map.hour) % 24;
  const asUtc = Date.UTC(
    Number(map.year), Number(map.month) - 1, Number(map.day),
    hour, Number(map.minute), Number(map.second),
  );
  return asUtc - epochMs;
}

// Absolute epoch (ms) for the next occurrence of `hour:minute` (24h) wall-
// clock time in `timeZone`: today if that time is still ahead of `now`,
// tomorrow otherwise. Two rounds of Intl-based offset correction converge
// even across a DST transition (the same fixed-point technique date-fns-tz
// uses for zonedTimeToUtc -- one pass can land on the wrong side of a
// spring-forward/fall-back boundary, a second pass re-reads the offset at
// the corrected instant). Returns null for an invalid IANA timezone name.
export function nextZonedTimeEpoch(hour, minute, timeZone, now = Date.now()) {
  try {
    // Constructing (and exercising) the formatter is what validates the
    // timezone name -- an invalid one throws RangeError here.
    new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date(now));
  } catch {
    return null;
  }

  const dateParts = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(now));
  const map = {};
  for (const p of dateParts) map[p.type] = p.value;
  const year = Number(map.year);
  const month = Number(map.month);
  const day = Number(map.day);

  const epochFor = (y, mo, d) => {
    let guess = Date.UTC(y, mo - 1, d, hour, minute, 0, 0);
    for (let i = 0; i < 2; i++) {
      guess = Date.UTC(y, mo - 1, d, hour, minute, 0, 0) - tzOffsetMs(guess, timeZone);
    }
    return guess;
  };

  let epoch = epochFor(year, month, day);
  if (epoch <= now) {
    const tomorrow = new Date(Date.UTC(year, month - 1, day + 1));
    epoch = epochFor(tomorrow.getUTCFullYear(), tomorrow.getUTCMonth() + 1, tomorrow.getUTCDate());
  }
  return epoch;
}
