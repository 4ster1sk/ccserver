# server/ — エージェント向けガイド

## 起点
- `index.js`: ルート登録、起動時の初期化 (DB マイグレーション、承認の掃除、署名鍵のロック)、終了処理
- `ws/sessionManager.js` の `createSession` → `ws/sandbox.js` の `buildSandboxSpawn` → pty 起動
- `ws/terminal.js`: ブラウザとの WebSocket

## 大きいファイルは丸読みしない
`grep -n "^export function\|^function\|^async function\|^export async function" <file>` で索引を取り、該当関数だけ読む。
- `ws/sandbox.js` (約2700行): `loadSandboxConfig`, `buildBwrapArgs`, `buildQemuSpawn`, `buildPooledQemuSpawn`, `buildSandboxSpawn`
- `ws/sessionManager.js` (約2300行): `createSession`, `destroySession`, `gracefulShutdown`
- `ws/sandbox-qemu.js`: `buildGuestRuntime` (VM に渡すホストサービスとファイル), `prepareVm`
- `ws/qemuVmPool.js`: `attach` (常駐 VM へのセッション参加)
- `ws/git-broker.js`: 冒頭コメントにソケットのプロトコル一覧がある

## サンドボックスの約束 (セキュリティ境界)
- サンドボックスには鍵・トークン・エージェントのソケットを渡さない。必要な操作はホスト側のブローカーが代行する
  (git 認証と gh は `ws/git-broker.js`、コミット署名は `ws/commitSignService.js`)。
- サンドボックス内で動くスクリプトは `ws/sandbox-*.cjs`。shebang は `#!/ccserver-sandbox-node` で、ホスト側のモジュールを import しない。
- サンドボックスが書き換えられるリポジトリでホストの git を動かすときは `ws/hostGitEnv.js` の `hardenedGitEnv()` を使う。
- bwrap / 使い捨て VM / 常駐 VM の 3 経路があるので、サンドボックスに何かを足すときは 3 つとも配線する
  (`buildBwrapArgs`, `buildGuestRuntime`, `qemuVmPool.attach`)。

## よく使う仕組み
- 人の承認を待つ: `ws/approvals.js` の `requestApproval` (種類ごとに `setApprovalDecisionGuard` で制限できる)
- 保存先のパス: `paths.js` の `resolvePath(PATH_IDS.xxx)`。パスを直書きしない
- 設定の読み込み: `ws/sandbox.js` の `loadSandboxConfig()` (sandbox.config.json、再起動で反映)、動的設定は `settingsStore.js`
- 運用者向け CLI は `cli/` (HTTP を通さず DB や鍵を直接扱う)
