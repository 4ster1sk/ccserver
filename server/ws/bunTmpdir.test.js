// Unit tests for the noexec-TMPDIR -> BUN_TMPDIR switch (see bunTmpdir.js).
// The pure helpers are tested with synthetic /proc/self/mounts lines; the
// env-reading wrappers only get cases that are deterministic everywhere (a
// relative or nonexistent TMPDIR must report not-noexec without touching
// /proc, and the override must match the real mount state of the test
// TMPDIR).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseMountOptions, mountHasNoexec, isTmpNoexec, bunTmpdirOverride, bunTmpdirEnv } from './bunTmpdir.js';

test('parseMountOptions extracts mountpoint and options from real-style lines', () => {
  const lines = [
    'sysfs /sys sysfs rw,nosuid,nodev,noexec,relatime 0 0',
    'proc /proc proc rw,nosuid,nodev,noexec,relatime 0 0',
    'tmpfs /tmp tmpfs rw,nosuid,nodev,inode64 0 0',
    '/dev/sda1 / rw,relatime 0 0',
  ];
  const mounts = parseMountOptions(lines);
  assert.equal(mounts.length, 4);
  assert.deepEqual(mounts[0], { mountpoint: '/sys', options: 'rw,nosuid,nodev,noexec,relatime' });
  assert.deepEqual(mounts[2], { mountpoint: '/tmp', options: 'rw,nosuid,nodev,inode64' });
});

test('parseMountOptions unescapes octal escapes in mountpoints', () => {
  const mounts = parseMountOptions(['/dev/sda1 /tmp/My\\040Folder ext4 rw,noexec 0 0']);
  assert.equal(mounts[0].mountpoint, '/tmp/My Folder');
  assert.equal(mounts[0].options, 'rw,noexec');
});

test('parseMountOptions skips blank and malformed lines', () => {
  const mounts = parseMountOptions(['', '   ', 'garbage', 'overlay /mnt overlay rw 0 0']);
  assert.equal(mounts.length, 1);
  assert.deepEqual(mounts[0], { mountpoint: '/mnt', options: 'rw' });
});

test('mountHasNoexec detects noexec on the matched mount', () => {
  const lines = [
    '/dev/sda1 / rw,relatime 0 0',
    'tmpfs /tmp tmpfs rw,nosuid,nodev,noexec,relatime,inode64 0 0',
  ];
  assert.equal(mountHasNoexec('/tmp', lines), true);
  assert.equal(mountHasNoexec('/tmp/foo/bar', lines), true);
  assert.equal(mountHasNoexec('/', lines), false);
  assert.equal(mountHasNoexec('/usr', lines), false);
});

test('mountHasNoexec tolerates option order and surrounding options', () => {
  for (const options of ['noexec,rw', 'rw,noexec,relatime', 'rw,relatime,noexec']) {
    assert.equal(mountHasNoexec('/tmp', [`tmpfs /tmp tmpfs ${options} 0 0`]), true, `options: ${options}`);
  }
  assert.equal(mountHasNoexec('/tmp', ['tmpfs /tmp tmpfs rw,nosuid,nodev 0 0']), false);
});

test('mountHasNoexec uses the longest-prefix mount, not the first match', () => {
  const lines = [
    '/dev/sda1 / rw,relatime 0 0',
    'tmpfs /tmp tmpfs rw,nosuid,nodev,noexec,relatime 0 0',
    '/dev/sdb1 /tmp/foo ext4 rw,nosuid 0 0',
  ];
  // /tmp/foo is the longest match for paths under it and is not noexec.
  assert.equal(mountHasNoexec('/tmp/foo', lines), false);
  assert.equal(mountHasNoexec('/tmp/foo/x', lines), false);
  // Everything else under /tmp falls back to the noexec /tmp mount.
  assert.equal(mountHasNoexec('/tmp', lines), true);
  assert.equal(mountHasNoexec('/tmp/bar', lines), true);
  // A mountpoint with a trailing slash matches like any other.
  assert.equal(mountHasNoexec('/tmp/foo', ['tmpfs /tmp/ tmpfs rw,noexec 0 0']), true);
});

test('mountHasNoexec returns false for unknown paths', () => {
  assert.equal(mountHasNoexec('/nonexistent', ['/dev/sda1 / rw,relatime 0 0']), false);
  assert.equal(mountHasNoexec('/tmpfoo', ['tmpfs /tmp tmpfs rw,noexec 0 0']), false);
});

test('isTmpNoexec is false for a relative TMPDIR', () => {
  const before = process.env.TMPDIR;
  process.env.TMPDIR = 'relative/tmp';
  try {
    assert.equal(isTmpNoexec(), false);
  } finally {
    if (before === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = before;
  }
});

test('isTmpNoexec is false for a nonexistent TMPDIR', () => {
  const before = process.env.TMPDIR;
  process.env.TMPDIR = join(tmpdir(), 'ccserver-no-such-tmpdir');
  try {
    assert.equal(isTmpNoexec(), false);
  } finally {
    if (before === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = before;
  }
});

test('bunTmpdirOverride matches the real mount state of the TMPDIR', () => {
  const before = process.env.TMPDIR;
  const dir = mkdtempSync(join(tmpdir(), 'ccserver-bun-tmpdir-test-'));
  process.env.TMPDIR = dir;
  try {
    // The mkdtemp dir sits on whatever mount the host TMPDIR does, so the
    // expected outcome is computed from the live mount table instead of
    // assuming exec (which would fail exactly on the noexec hosts this
    // feature targets).
    let lines = [];
    try {
      lines = readFileSync('/proc/self/mounts', 'utf-8').split('\n');
    } catch {
      // Non-linux or unreadable: no mount info, so no override is expected.
    }
    const expected = mountHasNoexec(dir, lines) ? dir : null;
    assert.equal(bunTmpdirOverride(), expected);
    assert.deepEqual(bunTmpdirEnv(), expected ? { BUN_TMPDIR: dir } : {});
  } finally {
    if (before === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = before;
    rmSync(dir, { recursive: true, force: true });
  }
});
