import type { Plugin } from "@opencode-ai/plugin"

// RTK OpenCode plugin -- rewrites commands to use rtk for token savings.
// Requires: rtk >= 0.23.0 in PATH.
//
// Vendored from https://github.com/rtk-ai/rtk (hooks/opencode/rtk.ts, develop
// branch) for ccserver's sandbox RTK injection: the sandbox binds this file
// read-only at /ccserver-sandbox-rtk.ts and the injected opencode config (see
// server/ws/mcpConfig.js) registers it via the `plugin` key, so opencode runs
// inside a ccserver sandbox rewrites its Bash tool calls through the host
// rtk binary without any host-level `rtk init`.
//
// This is a thin delegating plugin: all rewrite logic lives in `rtk rewrite`,
// which is the single source of truth (src/discover/registry.rs).
// To add or change rewrite rules, edit the Rust registry -- not this file.
// Upstream license: Apache-2.0.
export const RtkOpenCodePlugin: Plugin = async ({ $ }) => {
  try {
    await $`which rtk`.quiet()
  } catch {
    console.warn("[rtk] rtk binary not found in PATH — plugin disabled")
    return {}
  }

  return {
    "tool.execute.before": async (input, output) => {
      const tool = String(input?.tool ?? "").toLowerCase()
      if (tool !== "bash" && tool !== "shell") return
      const args = output?.args
      if (!args || typeof args !== "object") return

      const command = (args as Record<string, unknown>).command
      if (typeof command !== "string" || !command) return

      try {
        const result = await $`rtk rewrite ${command}`.quiet().nothrow()
        const rewritten = String(result.stdout).trim()
        if (rewritten && rewritten !== command) {
          ;(args as Record<string, unknown>).command = rewritten
        }
      } catch {
        // rtk rewrite failed — pass through unchanged
      }
    },
  }
}
