# ccserver — エージェント向けガイド

ブラウザから claude / opencode / codex をサンドボックス (bwrap または QEMU VM) の中で動かすサーバー。
`server/` (Fastify・node:sqlite・ESM) と `client/` (React 19 + Vite) の npm workspaces。

このファイルは入口だけ。サブツリーを触るときは `server/AGENTS.md` / `client/AGENTS.md` を読む。
それ以上の詳細は末尾のポインタから、必要になったときだけ読む。

## 地図
- `server/` 本体。`ws/` セッション・サンドボックス・ブローカー、`routes/` REST (`/api/*`)、`cli/` ホスト用 CLI
- `client/src/` UI
- `tests/` Playwright の E2E
- `docs-site/` 利用者向けドキュメント (日本語)、`docs/` 設計メモ
- 読まなくてよい: `opencode/` `xterm.js/` `.tools/` `tmp/` `vuln_scan/` `node_modules/` (外部の checkout・作業用)

## コマンド
- node が PATH に無いことがある: `export PATH=$HOME/.nvm/versions/node/v22.23.3/bin:$PATH`
- サーバーテスト全体 (約90秒): `cd server && env -u GIT_CONFIG_COUNT npm test`
- 1 ファイルだけ: `cd server && env -u GIT_CONFIG_COUNT node --test --import ./testEnvDefaults.js <file>`
- クライアントのビルド確認: `cd client && npx vite build --outDir <一時ディレクトリ>`
- E2E: `npm run test:e2e` (ルートで)

## 落とし穴
- ccserver のサンドボックス内では `GIT_CONFIG_*` で `commit.gpgsign=true` が注入されている。
  - テストは `env -u GIT_CONFIG_COUNT` を付けて流す (付けないと git を使う既存テストが十数件落ちる)。
  - 自分のコミットは `git -c commit.gpgsign=false commit ...`。
- `--import ./testEnvDefaults.js` 無しでテストを走らせると、`server/paths.js` が実パスの解決を拒否して落ちる (意図した安全装置)。
- 環境依存で落ちることがあるテスト: `db.test.js` の dbPath、`routes/opencodeChat.test.js` のチャット 3 件、`ws/sessionManager.test.js` の writeToSession。
  失敗したら、変更前 (`git stash`) でも落ちるか比べてから判断する。
- ホストの実データ (`~/.config/ccserver`, `~/.local/share/ccserver*`) をテストで触らない。
  新しい保存先は `server/paths.js` の REGISTRY に足し、`server/testEnvDefaults.js` と `server/paths.test.js` も更新する。
- DB マイグレーションは `server/db.js` の MIGRATIONS に追記するだけ。既存の version は書き換えない。

## 規約
- コードコメントは英語、UI の文言とドキュメントは日本語。コメントの量は周りのコードに合わせる。
- テストは対象の隣に `*.test.js` (node:test + `node:assert/strict`)。
- 外部依存はテストで差し替えられるよう `deps` 引数で受ける (例: `buildSandboxSpawn(opts, deps)`)。新しいコードもこの形に合わせる。
- コミットメッセージ: `feat(scope): 日本語の要約` の形 (`git log --oneline` を参照)。

## 詳しく調べるとき (必要なときだけ読む)
- ファイル構成の全体: `docs-site/src/content/docs/reference/project-structure.md`
- 設定の静的 (sandbox.config.json) / 動的 (DB) の区別: `docs-site/src/content/docs/reference/configuration-model.md`
- `sandbox.config.json` の全キー: `server/sandbox.config.example.json`
- サンドボックス・認証情報・コミット署名: `docs-site/src/content/docs/sandbox/*.md`
- QEMU VM / 常駐 VM: `docs/qemu-sandbox.md`, `docs/qemu-persistent-vm.md`
- REST API 一覧: `docs-site/src/content/docs/reference/api.md`
