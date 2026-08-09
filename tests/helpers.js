import { execFileSync } from 'node:child_process';

// opencode isn't installed on every machine this suite runs on (e.g. this
// repo's plain ubuntu-latest CI runner has neither claude nor opencode) --
// the webServer these tests drive runs on the same machine, so a local check
// is a valid proxy for whether the server can actually spawn it.
export function hasOpencode() {
  try {
    execFileSync('which', ['opencode'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
