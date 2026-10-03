---
title: 必要な環境
description: ccserver の実行に必要な環境と対応 AI CLI
---

- Node.js >= 22.13 / npm >= 9 (組み込みの `node:sqlite` を使用。SQLite migration に失敗した場合はサーバーの起動を拒否します)
- C++ コンパイラ (node-pty のビルドに必要。Arch: `base-devel`、Ubuntu: `build-essential`)
- Claude Code、[opencode](https://opencode.ai/)、[OpenAI Codex CLI](https://developers.openai.com/codex/cli/) のいずれか 1 つ以上。サーバーにインストールされている CLI だけを選べます。
- Linux でサンドボックスを利用する場合は `bwrap` (bubblewrap)。sandbox 内 Docker には rootless Docker、`rootlesskit`、`uidmap`、`slirp4netns` も必要です。

## 各 CLI について

- **[Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code)** — Claude の Usage 表示など、一部の機能で使用します。
- **[opencode](https://opencode.ai/)** — インストール方法は[公式サイト](https://opencode.ai/)を参照してください。
- **[OpenAI Codex CLI](https://developers.openai.com/codex/cli/)** (`codex`) — OpenAI 公式手順でインストールします。Usage 表示は `codex app-server` の JSON-RPC を利用します。

サンドボックスを使わない通常セッションは macOS でも利用できます。macOS 向けのサンドボックスバックエンドはありません。
