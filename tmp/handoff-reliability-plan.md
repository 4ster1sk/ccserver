# Plan: handoff の送受信失敗をなくす (wait_for_handoff / handoff_to_orchestrator の信頼性向上)

## 目的

オーケストレーターの `wait_for_handoff` とワーカーの `handoff_to_orchestrator` の間で、
ハンドオフイベントが「送受信されない」ことがある問題を解決する。調査の手がかりとして
報告された `ccserver_repo_info` の失敗 (`deps.groupManager.getGroup is not a function`) は
**確定バグ**として特定した (後述)。これを直すだけでなく、ハンドオフイベント自体が
キューから失われるレースをコードレベルで塞ぐ。

## 調査結果 (コードを読んで裏取り済み)

### 経路の全体像

```
worker (opencode/claude)
  └─ handoff_to_orchestrator (handoffソケット, buildHandoffMcpServer)
       └─ tools.handoffToOrchestrator (mcpTools.js:166)
            └─ groupManager.pushHandoff (groupManager.js:595)   …同期的にキューへ
                 └─ group.handoffQueue + handoffEmitter.emit('handoff')
                      └─ takeHandoff (groupManager.js:621) のウェイターが shift
                           └─ wait_for_handoff (controlソケット, buildControlMcpServer)
                                └─ orchestrator が結果を受信
```

- ブローカーは接続ごとに `buildServer()` で**新しい McpServer インスタンス**を作る
  (mcpBroker.js:101-111 `settleConnection`)。ツールの deps は `startControlBroker` /
  `startHandoffChannel` に渡された共通オブジェクトで、**接続ごとのクロージャを含まない**。
- ワーカー側の `handoffToOrchestrator` の push は**サーバー内で同期完結**する
  (mcpTools.js:174)。つまり ack が失われてもイベント自体はキューに残る。**イベント喪失の
  起点は「取り出し側」(takeHandoff) にしかない**。

### 原因1 (確定バグ): ブローカーの deps facade に `getGroup` が無い

- `repoInfo` は `deps.groupManager.getGroup(deps.groupId)` を呼ぶ (mcpTools.js:293)。
- 本番ではブローカーに `groupManagerApi` (groupManager.js:749-758) が渡されるが、
  **この facade には `getGroup` が含まれていない** (listGroupMembers / isSessionInGroup /
  getRoleForSession / setCurrentTurn / pushHandoff / takeHandoff / addMember / removeMember のみ)。
- 結果: 本番の `repo_info` は常に `TypeError: deps.groupManager.getGroup is not a function` を投げる。
  MCP SDK 1.30.0 はハンドラー例外を catch して `{ content:[...], isError:true }` を返す
  (node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js:135-142) ためプロセスは落ちないが、
  オーケストレーターにはツール失敗として見える。これが報告エラーの正体。
- **テストが検出できなかった理由**: `mcpTools.test.js` の `controlDeps` は**完全な
  groupManager モジュール**を注入している (mcpTools.test.js:57-63)。本番は facade を渡すため、
  テストと本番で deps の形が異なり、ズレがすり抜けた。

### 原因2 (イベント喪失レース): takeHandoff のウェイターが接続の死活を知らない

- `takeHandoff` はウェイターを `group.pendingTakes` に登録し、最大 15 分 (デフォルト
  timeoutMs) 待つ。**このウェイターは「どの接続が待っているか」を知らない**。
- クライアント側キャンセルでサーバー側のウェイターが生き残ることは、コードコメント自身が
  「既知の現実」として認めている (groupManager.js:612-620: "A client-side cancelled MCP
  request leaves its takeHandoff promise -- and its listener -- alive server-side")。
- これにより以下の経路で**イベントが消失**する:

  1. オーケストレーターが `wait_for_handoff` を発行 (サーバー側ウェイター登録)。
  2. 何らかの理由でこの要求が死ぬ/破棄される:
     - クライアント側タイムアウト・キャンセル (接続は生きたまま、要求だけ破棄)
     - 制御ブローカーの teardown (オーケストレーター pty exit → `onOrchestratorExit`
       (groupManager.js:652-659) が `stopBroker` で接続を destroy。**この時
       `pendingTakes` は settle されず放置**)
     - サーバー再起動・グループ破棄以外の要因で接続切断
  3. ワーカーが `handoff_to_orchestrator` → `pushHandoff` → イベント到着。
  4. **stale ウェイターがキューからイベントを shift し**、SDK が結果を
     (死んでいる/破棄された) 接続へ `SocketTransport.send` (mcpServer.js:80-83)。
     破棄済みソケットへの `write()` は握りつぶされる (ブローカーのエラーリスナー
     mcpBroker.js:83 が握るだけ)。
  5. オーケストレーターが `wait_for_handoff` を呼び直すとキューは空 → `{timedOut:true}`
     が返り、イベントは永遠に失われる。

- 既存の「上書き (supersede)」機構 (takeHandoff 冒頭の stale settle, groupManager.js:624-627)
  は、**新しいウェイターがイベント到着前に来た場合にしか救えない**。到着後に来た場合は
  取り返しがつかない。また stale への返値 `{orphaned: true}` は文書化されておらず、
  オーケストレーター (LLM) が「ハンドオフが来た」と誤解釈する余地がある
  (`{timedOut:true}` と違い、既知の形状でない)。

### 原因3 (周辺): ワーカー側 ack 喪失 (イベント自体は失われない)

- `addMember` のロール置換は `stopBroker(prevChannel)` (groupManager.js:523) で旧ワーカーの
  handoff チャネルを破棄する。この瞬間に旧ワーカーの in-flight な
  `handoff_to_orchestrator` があれば ack は失われるが、**push 自体はサーバー側で既に
  完了している**ためイベントはキューに残る。軽微。

## 実装方針

### フェーズ1: 原因1 (facade の getGroup 欠落) を修正

> **実装時の変更**: 調査後に master (PR #39, 6c9ab71) が同一バグを `getGroupCwd` 設計で
> 先行修正した。マージ時にその設計を採用する: facade には `getGroup` を追加せず
> (group オブジェクトは controlBroker のソケットパス・handoff チャネル・キュー等の内部を
> 持つため LLM 向けツールへ露出しない)、cwd のみを返す `getGroupCwd(groupId)` を facade に
> 公開し、`repoInfo` はこれを使う。以下 2 の「テストを本番と同じ形にする」方針は
> `getGroupManagerApi()` テストシームとして実装済み (master の `prodFacadeDeps` テストと併存)。

1. `server/ws/groupManager.js` — `groupManagerApi` (749-758) に `getGroup` を追加。
   - (master 統合後) **追加しない**: 代わりに master の `getGroupCwd` (cwd のみ) を facade が
     持つ。facade と mcpTools が使う関数の対応表をコメントで維持し、以後の
     追加ツールは必ず facade に入れる旨を明記。
2. **テストを本番と同じ形にする** (再発防止の本体):
   - `mcpTools.test.js` の `controlDeps` / `handoffDeps` が注入する `groupManager` を、
     完全モジュールではなく**実 facade** に切り替える。facade を取得できるように
     `groupManager.js` にテスト用 export (例: `export function getGroupManagerApi()`) を
     追加し、`mcpTools.test.js` はそれを使う。
   - `mcpBroker.test.js` に wire レベルの `repo_info` テストを追加: 実 tmp リポジトリを
     作って control ソケット経由で `repo_info` を呼び、`error` ではなく基本情報が返ること、
     `isError` にならないことを検証。これが通れば facade 欠落の再発は即座に検出される。

### フェーズ2: 原因2 (takeHandoff のイベント喪失レース) を修正

原則: **イベントは「取り出し時に、その取り出し先の接続が生きていると確認できる場合のみ」
キューから外す**。接続死やキャンセルで結果が届かない可能性がある場合、イベントは
キューに残し、次の `wait_for_handoff` が必ず受け取れるようにする。

3. `server/ws/groupManager.js` — `takeHandoff(groupId, timeoutMs, opts)` に `opts.isAlive`
   (関数) を追加:
   - `onHandoff` の dequeue 直前で `if (opts.isAlive && !opts.isAlive()) return;` —
     死んだ接続のウェイターはイベントを shift しない (キューに残る)。
   - `opts.isAlive` が無い場合 (テスト・既存呼び出し) は従来挙動。
4. `server/ws/groupManager.js` — 上書き (supersede) の再キュー化:
   - 各ウェイターは自身が shift したイベントを記録する。
   - 新しい `takeHandoff` が stale ウェイターを上書きする際、その stale が**直近にイベントを
     消費していたら**、そのイベントをキューの先頭に戻す (配信が怪しいので次ウェイターが
     確実に受け取れるように)。同一イベントの二重 re-queue は参照一致で防ぐ。
     - 併発する 2 接続 (旧接続がまだ生きている) のケースで二重配信になる可能性は、
       「旧接続が生きているのに要求だけキャンセルされる」パターンより遥かに稀で、
       喪失より二重のほうが安全 (オーケストレーターが同一ハンドオフを 2 回受けるだけで、
       キューは空にならない)。
   - stale への返値を `{orphaned: true}` → **`{timedOut: true}` に変更** (オーケストレーターが
     既知の形状のみ受け取る)。コメントも更新。
5. `server/ws/groupManager.js` — `onOrchestratorExit` (652-659) で `pendingTakes` を
   `{timedOut:true}` で settle する (制御ブローカー停止時に 15 分のゾンビウェイターを残さない。
   イベントはキューに残るため、再起動後の次の wait で受信される)。
6. `server/ws/mcpBroker.js` — control / handoff サーバーに**接続ごとの死活関数**を注入:
   - `settleConnection` で `SocketTransport` を先に生成し、
     `buildServer(identity, connectionIsAlive)` の形で per-connection クロージャ
     (`() => !socket.destroyed && !transport._closed`) を渡す。
   - `startControlBroker` は `buildControlMcpServer({ ...deps, connectionIsAlive })` に
     展開し、control サーバーの deps が接続ごとに固有になるようにする
     (現在は全接続で共通 deps のため、ここを必ず直す)。
7. `server/ws/mcpServer.js` / `server/ws/mcpTools.js` — `waitForHandoff` が
   `deps.connectionIsAlive` を `takeHandoff` の `opts.isAlive` に渡す。
   - control サーバーの `wait_for_handoff` の説明文に追記:
     「タイムアウト・接続断でもイベントは失われない。`{timedOut:true}` なら単に
     もう一度呼べばよい」。
8. テスト:
   - `groupManager.test.js`:
     - supersede 時の再キュー (stale がイベントを消費済み → 新しい wait がそのイベントを受信)。
     - `isAlive: () => false` のウェイターはイベントを消費しない (次の生きた wait が受信)。
     - `onOrchestratorExit` が pendingTakes を `{timedOut:true}` で settle する。
     - 既存の `{orphaned: true}` 検証テスト (166-199) を `{timedOut: true}` に更新。
   - `mcpBroker.test.js` (wire レベル):
     - **wait 中の接続が死んでもイベントは失われない**: クライアント A が
       `wait_for_handoff` を発行 → A のソケットを破棄 → ワーカーが handoff → 新クライアント B の
       `wait_for_handoff` が**そのイベントを受信**することを検証。
     - 接続クローズで pending ウェイターが残らないこと。
     - フェーズ1 の `repo_info` wire テスト。
   - `mcpTools.test.js`: facade 経由の deps で全ツールが正常動作すること (1 の切り替えで
     カバーされる)。

### フェーズ3: ドキュメント更新

9. `server/routes/groups.js` `DEFAULT_ORCHESTRATOR_TEMPLATE` — ハンドオフ規律に追記:
   - `wait_for_handoff` の `{timedOut:true}` は「そのままもう一度呼ぶ」で安全。
   - 接続再確立後も未受信ハンドオフはキューに残り、次の `wait_for_handoff` で届く。
10. `README.md` — handoff の MCP ツール説明に上記の保証を追記 (該当箇所を探して修正)。

## 変更しない範囲

- `pushHandoff` の同期 push / キューの FIFO と 100 件キャップ (喪失の起点ではない)。
- ハンドオフイベントの形状 (`fromSessionId/fromRole/summary/status/nextRole/at`)。
- `handoff_to_orchestrator` のデフォルト引数・権限境界 (identity はクロージャ由来)。
- チャネル/ブローカーのソケットパス決定規則 (listenMcp の既存挙動)。
- MCP SDK / トランスポート層のフレーミング。

## 検証コマンド

```bash
npm test                        # workspace=server の全ユニット/ワイヤーテスト
npm run build --workspace=client
npm run test:e2e                # 回帰確認
```

- 手動確認: 実サーバーでコンボ起動 → オーケストレーターから `repo_info` が成功すること、
  ワーカー→handoff→`wait_for_handoff` の往復が (再起動・再接続を挟んでも) 届くこと。

## 完了条件

- `repo_info` が本番 (facade) 経由で失敗しない。テストが facade を使用する形になり、
  同種のズレが再発しない。
- 待機中にクライアント接続が死んでも、ハンドオフイベントはキューに残り、次回の
  `wait_for_handoff` で必ず受信される (wire テストで検証済み)。
- 上書きされたウェイターへの返値が `{timedOut:true}` に統一され、未知の結果形状
  (`{orphaned:true}`) がオーケストレーターへ届かない。
- 制御ブローカー停止時に 15 分のゾンビウェイターが残らない。
- サーバー単体テスト・E2E が通る。
