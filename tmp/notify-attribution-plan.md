# notify ペイロードへの発信元属性付与 (host / project / group 自動注入)

対象ブランチ: `feat/notify-attribution` (Task 3 にて Plan のみ commit)

---

## 1. 現状の notify ペイロード構成と欠けている情報

### 配送の実体 (`server/ws/notify.js`)

- `buildContent({ title, body, level })` (`notify.js:152-158`) が
  `content` を組み立てる: `"[絵文字] title\nbody"`。
- `deliver(url, content)` (`notify.js:160-177`) が Discord 互換 JSON
  `{ content, username: 'ccserver' }` を global `fetch` POST (10s timeout)。
- `sendNotification({ title, body, level })` (`notify.js:182-202`) が Discord
  webhook + 購読 webhook すべてへ配送。**呼び出し側の情報は一切受け取らない**。

### 現状ペイロード (Discord で見える内容)

```
🚨 Build failed
details here
```

`username` は常に `ccserver` 固定。

### 欠けている情報

| 情報 | 現状 | 必要 |
|------|------|------|
| **ホスト名** | 無し (username も `ccserver` 固定) | サーバー側で自動付与可能 (`os.hostname()`) |
| **プロジェクト (cwd の basename)** | 無し | セッションの `cwd` から自動導出可能 |
| **グループ (groupId / コンボか否か)** | 無し | セッションの `groupId` / `groupRole` から自動付与可能 |
| **セッション ID / 役割** | 無し | トレーサビリティ用に短縮 ID を付与可能 |

### 属性を「自動」で入れるために解決すべき構造的な問題

`ccserver-notify` は**プロセス単一のグローバルソケット** (`$XDG_RUNTIME_DIR/ccserver-notify.sock`、
`notify.js:41,58-62`) でホストされており、すべての notify 対象セッション
(standalone agent / combo orchestrator) のサンドボックスに**同じ 1 本のソケット**
が bind される (`mcpBroker.js:144-150`、`sandbox.js:452-454`)。

- `listenMcp` の接続ハンドラ (`mcpBroker.js:74-90`) は接続ごとに
  `buildServer()` を呼ぶ (= MCP サーバーインスタンスは接続スコープ) が、
  notify の `buildNotifyMcpServer` には**毎回同じ閉じた `notifyApi` ファサード**
  が渡るだけ (`mcpServer.js:170-202`)。
- つまり「どのセッション/グループからのコールか」はサーバー側に一切伝わらない。
  control/handoff ブローカーのように「ソケットパス = グループ」という対応が無い
  (グローバル 1 ソケットのため)。

→ 「自動付与」には**接続スコープの発信元情報**をサーバーまで運ぶ仕組みが必要。

---

## 2. 設計

### 方針の分け方

| 情報 | 供給元 | 仕組み |
|------|--------|--------|
| ホスト名 | **サーバー側 (プロセスグローバル)** | `os.hostname()` (`notify.js` 内)。接続情報は不要 |
| プロジェクト / グループ / セッション | **接続スコープ (セッション毎)** | 下記「接続毎アイデンティティ」 |

### 2-a. ホスト名 (サーバー側で自動注入)

- `notify.js` の `sendNotification` / `deliver` で `import { hostname } from 'node:os'` を使い
  配送時のホスト名を確定する。
- 複数ホストが同じ webhook を共有する場合に備え、上書き手段を用意する
  (設定 `notify.hostname`、env `CCSERVER_HOSTNAME` は設定より優先 — 既存の
  `CCSERVER_DISCORD_WEBHOOK` と同じ優先順位パターン、`sandbox.js:142`)。
- 接続有無・ツール引数とは無関係に常に正しい値が入るため、ここは「自動」の本丸。

### 2-b. プロジェクト / グループ / セッション (接続毎アイデンティティ)

既存コードの強力な規約に従う:
> groupId / sessionId / role は **wire (ツール引数) から取らない**。制御サーバーの
> deps は groupId を接続時にクロージャで bind する (`mcpTools.js:6-13`)。

notify にこれを移植する形で、**接続時に閉じる per-connection アイデンティティ**を導入する。

#### アイデンティティの流れ

```
createSession (sessionManager.js:135-189)
  └─ notify descriptor { mode, sockPath, identity } を組み立て
       identity = { sessionId, groupId, groupRole, cwd, projectName, app }
       (projectName = path.basename(cwd))
mcpConfig.js: buildMcpConfigArgsAndEnv が identity を env 化
  └─ env に CCSERVER_NOTIFY_IDENTITY=<JSON> を追加 (notifySockEnv と同列)
sandbox-mcp-wrapper.cjs (notify モード)
  └─ connect 時に最初の 1 行として {"ccserver": <identity>}\n をソケットへ書く
       (env 無しなら {} を書く)。その後に既存の純バイト pipe
mcpBroker.js listenMcp (notify)
  └─ 接続毎に「最初の 1 行 = アイデンティティフレーム」を読む (許容的: 無ければ
       その 1 行を MCP データとして replay) → buildServer(identity)
mcpServer.js buildNotifyMcpServer({ notifyApi, identity })
  └─ notify ツールが notifyApi.sendNotification(args, identity) に渡す
notify.js sendNotification(args, identity) → ペイロード末尾に属性フッターを付与
```

#### 設計判断の根拠

- **何故 wire のツール引数でなく接続スコープか**: `notify` ツールのシグネチャを
  変えずに「自動」を満たせる。エージェントが groupId 等を毎回手で渡す必要が無く、
  `mcpTools.js` の「identity は wire から取らない」規約とも整合する。
- **何故 per-session ソケットではなく 1 ソケット + フレームか**:
  `createSession` は**同期関数** (`sessionManager.js:102`) であり、ソケットは
  サンドボックス bind の前に実体が必要。per-session ソケットだと起動経路ごとに
  async の事前生成が要り、`terminal.js:88` / `routes/groups.js` / schedule の
  auto-resume など全経路への侵襲が大きい。グローバル 1 ソケットを温存し、
  **接続の最初の 1 行だけ自前プロトコル化**するのが最小差分。
  (購読レジストリ・Discord webhook がプロセスグローバルである概念も不変 — `notify.js:5-6`)。
- **信頼性**: フレームは wrapper が `connect` ハンドラ内で pipe 確立**前**に
  書く (`sandbox-mcp-wrapper.cjs:31-35` の順序を維持するだけ) ため、クライアントの
  MCP initialize より常に先行する。サーバー側は最初の `\n` まで蓄積し、
  `{"ccserver": ...}` としてパースできれば identity、そうでなければ
  **蓄積分を丸ごと replay** して MCP データとして処理する (既存の直接 MCP クライアント
  = `mcpBroker.test.js` の `mcpClient` 等と後方互換)。
- **セキュリティ**: notify ソケットは same-user の sandbox のみ到達可という既存の
  境界のまま (`mcpServer.js:162-167`)。identity は**認可の根拠ではなく属性 (発信元表示)
  のみ**に使う。spoof されても「通知の表示が変わる」だけで権限は拡大しない。

#### ペイロード変更 (Discord 互換 `{ content, username }` を維持)

```
content = "[絵文字] title\nbody"   (既存 buildContent を維持)
          + "\n\n_from: <host> · <project> · group <groupShort> · session <sessionShort>"
```

- `<host>`: 常に付与。`<project>`: basename(cwd) (cwd が `/` なら省略か `cwd` 表示)。
  `<group>`: コンボ (groupId 有り) のみ。`<sessionShort>`: sessionId 先頭 8 文字。
- `notify.attribution: false` (設定) でフッターを丸ごと無効化可能 (既定 true)。

#### アイデンティティフレーム読み取りの実装メモ (mcpBroker.js)

- 接続ハンドラ (`mcpBroker.js:74-90`) を「先頭 1 行を読んでから
  buildServer(identity) + SocketTransport 生成」に変更。
- `SocketTransport` (`mcpServer.js:25-74`) に**初期バッファ (残りバイト) を seed**
  する引数を追加 (replay 用)。既存の `_buf` に初期値を入れるだけ。
- 無通信でハングしないよう、短い猶予 (例 1s) 後に残バッファを replay して
  transport に渡す防御を入れる。フレーム上限は `MAX_TRANSPORT_BUFFER_CHARS` と同様に
  越えたら replay → transport の既存オーバーフロー処理に任せる。
- control/handoff ブローカーは `buildServer` 引数 (identity) を無視するだけで無影響。

#### sendNotification シグネチャ

- `sendNotification(args, identity)` に拡張 (`notify.js:182`)。identity 無しは
  「ホスト名のみ」の従来通りの配送。`notifyApi` ファサード (`notify.js:207-212`) は
  同じ形を維持しつつ notify ツールから identity を渡す。
- `subscribe` / `unsubscribe` / `list_subscriptions` は**変更なし**。

---

## 3. 後方互換性への影響

| 対象 | 影響 | 対応 |
|------|------|------|
| `notify` ツールのスキーマ `{ title, body, level? }` | **変更なし** | – |
| `subscribe` / `unsubscribe` / `list_subscriptions` | **変更なし** | – |
| 配送ペイロードの形 `{ content, username }` | content 末尾にフッター追加のみ。Discord/webhook 側のパースに影響しない | `notify.attribution: false` で無効化可 |
| 購読済み webhook (`.saved-notifications.json` / 設定シード) | **変更なし** (形式不変、レジストリは無傷) | – |
| グローバル通知ソケットパス (`ccserver-notify.sock`) | **変更なし** | – |
| 旧 wrapper が identity を送らないケース / 直接 MCP クライアント | サーバーが最初の 1 行を identity と解釈できなければ replay → 従来通り動作 | 許容的パース + replay |
| `buildMcpConfigArgsAndEnv` の戻り値 env | `CCSERVER_NOTIFY_IDENTITY` キー追加 → `mcpConfig.test.js` の `deepEqual(env, ...)` が壊れる | テスト更新 (後述) |
| `sendNotification` のシグネチャ | 第 2 引数追加。呼び出しは `mcpServer.js` / `notify.test.js` のみ | 呼び出し側を更新 |
| env 経路 (sandbox/host 両モード) | bwrap は親 env を継承 (`sandbox.js` に `--clearenv` 無し) のため、pty env の `CCSERVER_NOTIFY_IDENTITY` はそのまま sandbox 内 wrapper へ届く | 実装時に確認 (既存 `CCSANDBOX_NOTIFY_MCP_SOCK` と同経路) |

---

## 4. 実装ステップとテスト方法

検証コマンド (既存パターン: `npm test` が server workspace の `node --test` を実行):

```bash
node --check server/ws/notify.js server/ws/mcpServer.js server/ws/mcpBroker.js server/ws/mcpConfig.js
npm test                      # server workspace (notify / mcpConfig / mcpBroker / sessionManager)
```

注意: `ws/sandbox-resolve.test.js:41` は環境依存の pre-existing failure (本タスクと無関係)。差分のみで評価。

### Step 1. notify.js — ホスト名 + 属性フッター

- `os.hostname()` 導入、`notify.hostname` / `CCSERVER_HOSTNAME` 上書き
  (`loadNotifyConfig` に hostname / attribution を追加 — `sandbox.js:135-162` の解析とセット)。
- `sendNotification(args, identity)` に拡張し、フッター生成ヘルパー
  `buildAttribution(identity)` (純関数) を追加。
- `notify.attribution === false` ならフッターなし。

テスト (`notify.test.js` 追加):
1. `sendNotification({...}, { hostname, groupId, groupRole, cwd })` → mock fetch の
   payload `content` 末尾に `_from: ...` が入る (host / project=basename / group)。
2. identity 無し → ホスト名のみ。`attribution: false` → フッター無し。
3. `CCSERVER_HOSTNAME` / `notify.hostname` の優先順位。
4. 既存の配送テスト (payload 形・非ブロッキング) がそのまま通る (regression)。

### Step 2. mcpBroker.js / mcpServer.js — 接続毎アイデンティティ

- `SocketTransport` に初期バッファ seed 引数。
- `listenMcp` に「先頭 1 行を許容的に読む」ロジックを追加し `buildServer(identity)` に渡す。
- `startNotifyBroker` が `buildServer: (identity) => buildNotifyMcpServer({ notifyApi, identity })` を渡す。
- `buildNotifyMcpServer` の notify ツールで `notifyApi.sendNotification(args, identity)`。

テスト (`mcpBroker.test.js` 追加):
1. **identity フレーム経由**: mock `buildServer` に identity が渡ることを assert
   (ソケットへ `{"ccserver": {...}}\n` を送ってから initialize)。
2. **replay 経路 (後方互換)**: フレーム無しで直接 initialize → 従来通り
   `serverInfo.name === 'ccserver-notify'`、ツール一覧が 4 つ。
3. 既存 notify broker ライフサイクルテストが通る (regression)。

### Step 3. mcpConfig.js / sessionManager.js — identity の運搬

- `buildMcpConfigArgsAndEnv(app, { notify })` の `notify` descriptor に `identity`
  を許容し、env へ `CCSERVER_NOTIFY_IDENTITY: JSON.stringify(identity)` を追加
  (`notifySockEnv` と同列、`mcpConfig.js:50-84`)。
- `createSession` の notify descriptor (`sessionManager.js:182-185`) に
  `identity: { sessionId: id, groupId, groupRole, cwd, projectName: path.basename(cwd), app: sessionApp }`
  を追加。

テスト (`mcpConfig.test.js` 更新):
1. 既存の `deepEqual(env, { CCSANDBOX_NOTIFY_MCP_SOCK })` を
   `{ CCSANDBOX_NOTIFY_MCP_SOCK, CCSERVER_NOTIFY_IDENTITY: <JSON> }` に更新。
2. identity 無し descriptor → env に `CCSERVER_NOTIFY_IDENTITY` が入らない。

### Step 4. sandbox-mcp-wrapper.cjs — フレーム送出

- notify モード (`process.argv[2] === 'notify'`) のとき、`connect` ハンドラ冒頭で
  `sock.write(JSON.stringify({ ccserver: parseIdentity(env.CCSERVER_NOTIFY_IDENTITY) }) + '\n')`
  を実行してから pipe を張る。env 無しは `{}`。

テスト: ユニット対象外 (wrapper は E2E/統合)。`node --check` で構文確認 +
  手動で `notify` モード起動して socket へ frame + 中継バイトが順に届くことを確認。

### Step 5. 設定サンプル / ドキュメント

- `server/sandbox.config.example.json` に `notify.hostname` / `notify.attribution` を追記。
- `README.md` の ccserver-notify 節 (README.md:108-138) に「自動で付与される発信元
  (host / project / group)」「`notify.attribution` での無効化」を追記。

---

## 5. 実装対象ファイル一覧

変更:
- `server/ws/notify.js` — `os.hostname()` + `notify.hostname`/`CCSERVER_HOSTNAME` 上書き +
  `sendNotification(args, identity)` 化 + `buildAttribution` (純関数) + `notify.attribution`
- `server/ws/notify.test.js` — 属性フッター / 上書き / 無効化テスト追加
- `server/ws/mcpBroker.js` — `listenMcp` の接続毎 identity フレーム読み取り +
  `buildServer(identity)` + `startNotifyBroker` の buildServer 変更
- `server/ws/mcpServer.js` — `SocketTransport` 初期バッファ seed +
  `buildNotifyMcpServer({ notifyApi, identity })` で notify ツールへ identity 受け渡し
- `server/ws/mcpConfig.js` — notify descriptor の `identity` を `CCSERVER_NOTIFY_IDENTITY` env 化
- `server/ws/sandbox-mcp-wrapper.cjs` — notify モードで先頭 identity フレーム送出
- `server/ws/sessionManager.js` — notify descriptor に identity を付与
- `server/sandbox.config.example.json` — `notify.hostname` / `notify.attribution` 追記
- `README.md` — ccserver-notify 節へ発信元属性の説明追記

テスト変更:
- `server/ws/mcpConfig.test.js` — env `deepEqual` の更新 + identity 無しケース
- `server/ws/mcpBroker.test.js` — identity フレーム経由 / replay 経由のテスト追加

変更不要:
- `server/ws/sandbox.js` — bwrap は親 env 継承のため env 経路のみ (既存
  `CCSANDBOX_NOTIFY_MCP_SOCK` と同経路で通る)。`buildBwrapArgs` 変更なし
- `server/ws/mcpTools.js` — identity は wire から取らない規約は維持
- 購読レジストリ / `.saved-notifications.json` の形式

---

## 6. 実装順序 (提案)

1. notify.js (ホスト名 + フッター) + notify.test.js
2. mcpBroker.js / mcpServer.js (接続毎 identity + replay) + mcpBroker.test.js
3. mcpConfig.js / sessionManager.js (identity 運搬) + mcpConfig.test.js
4. sandbox-mcp-wrapper.cjs (フレーム送出)
5. sandbox.config.example.json / README.md
