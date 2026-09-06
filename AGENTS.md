## 作業手順
- コードやドキュメントの変更作業を始める前に、必ず以下を行うこと
  1. ベースブランチ（原則 `develop`）から作業用ブランチを作成する
  2. そのブランチに対応する git worktree を作成し、その中で作業する
- `develop` や `master` 上で直接編集・コミットしないこと

## Node.js / npm の利用
- このリポジトリは Node.js 22 系が必須（`package.json` の `engines` は `node >=22.13`、CI も `node-version: '22'` を使用）
- 実行環境によっては `node` / `npm` / `npx` がデフォルトの `PATH` に存在しないため、`command not found` の場合は nvm 経由で有効化すること
- `node` / `npm` / `npx` を使うシェル操作では、同一コマンド内で先に nvm を読み込むこと（セッション間で引き継がれないことを前提とし、読み込みと実行を `&&` でつなげる）
  ```sh
  [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" && node --version && npm --version
  ```
- nvm 自体が未インストールの場合（`$NVM_DIR/nvm.sh` が存在しない場合）は、先に nvm をインストールしてから Node.js 22 系を導入すること
  ```sh
  curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
  [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
  nvm install 22 && nvm use 22 && node --version
  ```
- `npm test` などの実行例: `[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" && npm test`

## テストコード
- 機能追加・バグ修正・仕様変更を伴う実装では、対応するテストコードを同一ブランチ内に含めること
- ドキュメントのみ・誤字修正・フォーマットのみの変更にはテストコードは不要
- テストがない実装のみのコミットを作らないこと

## コミットメッセージ
- AIエージェントが `git commit` で作成するメッセージの件名・本文は日本語で書くこと
- 形式は `type: 日本語の要約` とし、type（feat, fix, chore, docs, refactor, test, ci など）とスコープは英語のままとする
  - 例: `feat: ○○を追加`、`fix: ○○の不具合を修正`
- マージコミットや revert など自動生成されるメッセージは対象外とし、書き換えないこと

## コミット後のテスト
- コミットごとに、最低限 `npm test`（サーバーのユニットテスト）を必ず実行すること
- クライアントや E2E に影響する変更では、必要に応じて `npm run build --workspace=client` や `npm run test:e2e` も実行すること
- テストに失敗した場合は原因を修正し、`--amend` や履歴の書き換えはせず、追加コミットで対応すること

## やってはいけないこと
- 既存のテストを、通す目的だけで修正・削除・スキップしないこと（アサーションの緩和、期待値の書き換え、`skip` 化を含む）
- 仕様変更などでテスト自体の修正が正当と思われる場合は、独断で修正せず、理由と修正案を添えてユーザーに質問し、許可を得てから修正すること
