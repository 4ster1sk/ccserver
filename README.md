# ccserver

**Languages:** [日本語](README.md) | [English](README.en.md) | [Français](README.fr.md)

> **Context & Coordination Server** — AI CLIセッションを管理する Web サーバー。

> **Note:** このプロジェクトは対応するAI CLIの各ベンダー・プロジェクトとは無関係の非公式サードパーティツールです。各ベンダー・プロジェクトによる公式サポートの対象外です。

ディレクトリを指定して複数の AI CLI ([Claude Code](https://docs.anthropic.com/en/docs/claude-code)、[opencode](https://opencode.ai/)、[OpenAI Codex CLI](https://developers.openai.com/codex/cli/)) を起動・管理する Web フロントエンド。VS Code のようにフォルダを選択し、ブラウザ内のターミナルで操作できます。

📖 **詳しいドキュメントは [ドキュメントサイト](https://nananek.github.io/ccserver/) を参照してください。**

## 主な機能

- AI CLI の統一管理 (Claude Code / opencode / OpenAI Codex CLI) — [起動ガイド](https://nananek.github.io/ccserver/guides/launching/)
- `bwrap` + rootless docker によるプロジェクト単位の隔離サンドボックス実行 — [サンドボックス](https://nananek.github.io/ccserver/sandbox/overview/)
- 予約プロンプト (指定時刻・利用制限解除時刻に自動でプロンプトを投入) — [詳細](https://nananek.github.io/ccserver/guides/scheduled-prompts/)
- `ccserver-notify` MCP による Discord / webhook / PWA (Web Push) 通知 — [詳細](https://nananek.github.io/ccserver/guides/notify/)
- サンドボックス内の AI CLI が出すデスクトップ通知の転送 (端末のエスケープシーケンスを捕捉) — [詳細](https://nananek.github.io/ccserver/guides/notify/)
- 使用量 (Usage) 表示 (Claude Code `/usage` / Codex レート制限) — [詳細](https://nananek.github.io/ccserver/guides/usage/)

## アーキテクチャ

```
ブラウザ (xterm.js) <── WebSocket ──> Fastify <── node-pty ──> claude / opencode / codex CLI
                    <── HTTP REST ──>         (ディレクトリ一覧 API)
```

| レイヤー | 技術スタック |
|----------|-------------|
| Frontend | React 19 + Vite + xterm.js |
| Backend  | Node.js + Fastify + @fastify/websocket + node-pty |

## 必要な環境

- Node.js >= 22.13 / npm >= 9
  - CI が実際に検証しているのは **Node 22 / 24 / 26** です (22 = Maintenance LTS、24 = Active LTS、26 = Current。26 は 2026-10-28 に Active LTS になります)。`engines` に上限を置いていないのは、より新しい Node で `npm install` が警告を出す/止まるのを避けるためで、未検証のバージョンが動く保証ではありません。
- C++ コンパイラ (node-pty のビルドに必要。Arch: `base-devel`、Ubuntu: `build-essential`)
- 対応する AI CLI のいずれか 1 つ以上 (Claude Code / opencode / OpenAI Codex CLI)。サーバーにインストールされている CLI だけを起動時に選べます。

詳細 (各 CLI のインストール方法・docker 利用時の追加パッケージ等) は [必要な環境](https://nananek.github.io/ccserver/getting-started/requirements/) を参照してください。

## クイックスタート

```bash
git clone <repo-url> ccserver
cd ccserver
npm install
npm run setup           # 何がどこに作られるか確認 (ドライラン)
npm run setup -- --yes  # 実行
```

`npm run setup` はホストごとに一度必要です (新規インストールでも)。設定・データ・状態を
XDG のディレクトリ (`~/.config/ccserver`, `~/.local/share/ccserver`,
`~/.local/state/ccserver`) に用意し、既存インストールではリポジトリ配下にあった設定・状態
ファイルをそこへ移行します。実行するまで Web UI は新しいセッションの作成を
拒否します。既存環境ではサーバーを停止してから実行してください。
詳細: [設定モデル](https://nananek.github.io/ccserver/reference/configuration-model/)

**開発モード** (ターミナルを 2 つ開いて実行):

```bash
npm run dev:server   # バックエンド (port 3001)
npm run dev:client   # フロントエンド (port 5173)
```

ブラウザで http://localhost:5173 を開きます。

**本番モード**:

```bash
npm run build --workspace=client
NODE_ENV=production node server/index.js
```

ブラウザで http://localhost:3001 を開きます (ポートは `PORT` 環境変数で変更可能)。

常駐運用 (systemd) や Tailnet 内への HTTPS 公開 (Tailscale Serve) は [デプロイガイド](https://nananek.github.io/ccserver/deployment/systemd/) を参照してください。

## VM サンドボックス (QEMU) を使う場合

サンドボックスの方式に VM (QEMU) を選ぶと、セッションごとに KVM の VM で動かします
(Linux のみ)。VM のネットワークは、ホスト側の Go 製ブローカー
`ccs-netbroker` がすべて中継します。ブローカーは別リポジトリ
([ccserver-netbroker](https://git.tomadoi.com/4sterisk/ccserver-netbroker)) で配布しているので、
`npm install` とは別に取得が必要です。

```bash
# 1. ホストのパッケージ (Debian / Ubuntu の例)。ccserver を動かすユーザーを kvm グループに入れる
sudo apt install qemu-system-x86 qemu-utils virtiofsd bubblewrap
sudo usermod -aG kvm "$USER"

# 2. ネットワークブローカーを取得する
npm run fetch:netbroker

# 3. VM のゴールデンイメージを作る (初回のみ。Debian 13 のクラウドイメージを元に作る)
node server/cli/qemu-image-build.js
```

- `npm run fetch:netbroker` は、`server/netbroker.version.json` に固定された版を
  `.netbroker/bin/ccs-netbroker` にダウンロードし、SHA256 を検証します。
  インストール済みの版が一致していれば何もしません。
- ブローカーの版を上げるときは、`server/netbroker.version.json` の `version` と
  `sha256` を更新してから、もう一度 `npm run fetch:netbroker` を実行します。
- 自分でビルドしたブローカーを使う場合は、`CCSERVER_NETBROKER_BIN_DIR` に
  `ccs-netbroker` を置いたディレクトリを指定します。
- VM は起動オプションでセッションごとに選べます。既定を VM にするには、
  `sandbox.config.json` に `"backend": "qemu"` を書きます。
- VM 内のエージェントには、ホストにインストールされた本体を読み取り専用で共有します。
  認証情報は VM に入れず、ブローカーが付けます。Claude を使う場合は、ホストで
  `claude setup-token` を実行し、表示された値を設定画面の「VM」→「エージェントの認証」に登録します。

詳細: [サンドボックスの設定](https://nananek.github.io/ccserver/sandbox/configuration/)

## ドキュメント

インストール・起動オプション・各種 MCP ツール (notify / usage)・サンドボックスの内部構成・API リファレンス・デプロイ手順など、詳細は [ドキュメントサイト](https://nananek.github.io/ccserver/) にまとまっています。

## ライセンス

MIT
