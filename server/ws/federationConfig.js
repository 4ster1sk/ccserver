// Federation's own slice of sandbox.config.json, read the same way
// sandbox.js's loadSandboxConfig() reads every other feature's config
// (CCSERVER_SANDBOX_CONFIG env override, else server/sandbox.config.json) --
// kept as its own tiny reader rather than folded into loadSandboxConfig
// itself so a mistake here can't touch the much larger, security-sensitive
// sandbox-launch config parser that every session spawn depends on.
//
// Shape: { "federation": { "requireTokenForPairing": true } }

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function federationConfig() {
  const configPath = process.env.CCSERVER_SANDBOX_CONFIG
    || join(__dirname, '..', 'sandbox.config.json');
  let raw = {};
  try {
    raw = JSON.parse(readFileSync(configPath, 'utf-8'));
  } catch {
    raw = {};
  }
  const federation = (raw.federation && typeof raw.federation === 'object') ? raw.federation : {};
  return {
    // Gates the bootstrap POST /pairing-requests-equivalent (pairing.propose
    // RPC, see federationServer.js) on the SAME shared secret the browser
    // already uses (CCSERVER_TOKEN) -- opt-in, default off (plan section 7).
    // This never grants trust by itself: a token-gated propose still only
    // reaches 'pending_local_approval', identical to an ungated one.
    requireTokenForPairing: federation.requireTokenForPairing === true,
  };
}
