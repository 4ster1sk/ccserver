import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findSessionLimitReset, nextZonedTimeEpoch } from './sessionLimitDetect.js';

test('findSessionLimitReset: matches the normally-spaced message', () => {
  const now = Date.UTC(2026, 7, 17, 0, 0, 0); // 2026-08-17T00:00:00Z (09:00 JST)
  const text = "You've hit your session limit · resets 2:10am (Asia/Tokyo)";
  const result = findSessionLimitReset(text, now);
  assert.ok(result);
  assert.equal(result.timeZone, 'Asia/Tokyo');
  // 2:10am JST has already passed at 09:00 JST -> next occurrence is tomorrow.
  assert.equal(result.resetAtMs, Date.UTC(2026, 7, 17, 17, 10, 0, 0));
});

test('findSessionLimitReset: matches when Ink cursor-positioning strips all spaces', () => {
  // Simulates the ANSI-stripped-but-space-collapsed rendering described in
  // sessionLimitDetect.js: ESC[<N>G cursor moves leave no space behind.
  const now = Date.UTC(2026, 7, 17, 0, 0, 0);
  const text = "You'vehityoursessionlimit·resets2:10am(Asia/Tokyo)";
  const result = findSessionLimitReset(text, now);
  assert.ok(result);
  assert.equal(result.timeZone, 'Asia/Tokyo');
  assert.equal(result.resetAtMs, Date.UTC(2026, 7, 17, 17, 10, 0, 0));
});

test('findSessionLimitReset: matches with irregular extra whitespace too', () => {
  const now = Date.UTC(2026, 7, 17, 0, 0, 0);
  const text = "You've   hit your   session limit· resets   2:10am  (Asia/Tokyo)";
  const result = findSessionLimitReset(text, now);
  assert.ok(result);
  assert.equal(result.resetAtMs, Date.UTC(2026, 7, 17, 17, 10, 0, 0));
});

test('findSessionLimitReset: the pre-hit warning never matches (no double-fire)', () => {
  assert.equal(findSessionLimitReset("You've used 99% of your session limit"), null);
  assert.equal(findSessionLimitReset('used 99% of your session limit · resets 2:10am (Asia/Tokyo)'), null);
  assert.equal(findSessionLimitReset('just some normal claude output'), null);
});

test('findSessionLimitReset: rejects an out-of-range time or invalid timezone', () => {
  assert.equal(findSessionLimitReset("hit your session limit · resets 13:10am (Asia/Tokyo)"), null);
  assert.equal(findSessionLimitReset("hit your session limit · resets 2:70am (Asia/Tokyo)"), null);
  assert.equal(findSessionLimitReset("hit your session limit · resets 2:10am (Not/AZone)"), null);
});

test('nextZonedTimeEpoch: today when the time is still ahead in that zone', () => {
  const now = Date.UTC(2026, 0, 1, 0, 0, 0); // 09:00 JST on 2026-01-01
  const epoch = nextZonedTimeEpoch(10, 0, 'Asia/Tokyo', now);
  assert.equal(epoch, Date.UTC(2026, 0, 1, 1, 0, 0, 0)); // 10:00 JST same day
});

test('nextZonedTimeEpoch: rolls to tomorrow when the time has already passed', () => {
  const now = Date.UTC(2026, 0, 1, 0, 0, 0); // 09:00 JST on 2026-01-01
  const epoch = nextZonedTimeEpoch(8, 0, 'Asia/Tokyo', now);
  assert.equal(epoch, Date.UTC(2026, 0, 1, 23, 0, 0, 0)); // 08:00 JST next day
});

test('nextZonedTimeEpoch: America/New_York outside DST (EST, UTC-5)', () => {
  const now = Date.UTC(2026, 0, 15, 0, 0, 0); // mid-January, EST
  const epoch = nextZonedTimeEpoch(9, 0, 'America/New_York', now);
  assert.equal(epoch, Date.UTC(2026, 0, 15, 14, 0, 0, 0)); // 9:00 EST = 14:00 UTC
});

test('nextZonedTimeEpoch: America/New_York inside DST (EDT, UTC-4)', () => {
  const now = Date.UTC(2026, 6, 1, 0, 0, 0); // July, EDT
  const epoch = nextZonedTimeEpoch(9, 0, 'America/New_York', now);
  assert.equal(epoch, Date.UTC(2026, 6, 1, 13, 0, 0, 0)); // 9:00 EDT = 13:00 UTC
});

test('nextZonedTimeEpoch: converges across a spring-forward DST boundary', () => {
  // 2026-03-08 is when America/New_York springs forward (02:00 EST -> 03:00 EDT).
  // "now" sits on 03-07 (still EST); the requested 1:30am has already passed
  // that day, so the next occurrence rolls to 03-08 -- still pre-2am, so still EST.
  const now = Date.UTC(2026, 2, 7, 12, 0, 0); // 2026-03-07T12:00:00Z
  const epoch = nextZonedTimeEpoch(1, 30, 'America/New_York', now);
  assert.equal(epoch, Date.UTC(2026, 2, 8, 6, 30, 0, 0)); // 1:30 EST = 06:30 UTC
});

test('nextZonedTimeEpoch: invalid IANA timezone name returns null', () => {
  assert.equal(nextZonedTimeEpoch(9, 0, 'Not/AZone', Date.now()), null);
  assert.equal(nextZonedTimeEpoch(9, 0, '', Date.now()), null);
});
