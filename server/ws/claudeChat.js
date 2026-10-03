// Claude Code chat mode, server side: the bridge (claude-chat-bridge.cjs)
// bundled with the claude-chat-adapter package into the single file a
// sandbox bind or a VM share carries. Everything after the bridge is up --
// the proxy, the monitor, the chat view -- is shared with opencode's chat
// mode (opencodeChat.js), since the adapter serves the same opencode v2 API.

import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { bundleStandalone } = require('claude-chat-adapter/bundle');

const __dirname = dirname(fileURLToPath(import.meta.url));
export const CLAUDE_CHAT_BRIDGE_SOURCE = join(__dirname, 'claude-chat-bridge.cjs');

let cached = null;

// The standalone bridge source. Built once per process: the inputs are this
// checkout's files, which only change with a restart.
export function claudeChatBridgeSource() {
  if (!cached) cached = bundleStandalone(CLAUDE_CHAT_BRIDGE_SOURCE);
  return cached;
}
