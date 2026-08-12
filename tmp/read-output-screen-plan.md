# Plan: read_output でスピナー状態を誤判しない (仮想画面 + 画面ベースの活動判定)

## 目的

`read_output` でワーカーのスピナー (作業中インジケータ) の状態を見ようとすると誤判する
問題を解決する。スピナーは TUI 特有の描画 (カーソル移動・行消去・代替画面への差分描画)
で更新されるため、生の xterm 描画ストリームを上から追う形では「今見えている状態」を
復元できない。**セッションごとに軽量な仮想画面 (ANSI 解釈) を維持し、read_output に
「現在の画面」と「画面が最後に変化した時刻」を提供**して、スピナーの有無・作業中か
静止か (busy/idle) を安定して観測できるようにする。

## 調査結果 (コードを読んで裏取り済み)

### 現状の read_output の実装

- `readOutput` (mcpTools.js:50-75) は以下しか返さない:
  - `raw` — `session.outputBuffer.slice(-n).join('')` (**生バイトの連結**)
  - `text` — `stripAnsi(raw)` (正規表現 `ANSI_RE` による削除、mcpTools.js:20)
  - `truncated` — 16KB キャップの有無
- outputBuffer は pty の `onData` を chunk 単位で追記するだけ (sessionManager.js:313-318,
  `appendToBuffer` 1103-1111)。**サーバー側に画面状態 (仮想端末) のモデルは存在しない**。
- 代替画面 (DECSET 1049) の扱い: claude には
  `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1` を注入する (sessionManager.js:255-258) が、
  **opencode は TUI のまま** (コメント 259-262 で明示的に alt 画面を許可)。opencode の
  スピナー/ステータス行は代替画面内のカーソル位置固定描画。

### なぜ誤判するか

1. **バイト連結では「今見えている画面」を復元できない**:
   opencode の TUI はスピナーを `\r`/CSI カーソル移動 + 行消去 (CSI K 等) + フレーム文字の
   書き換えで描画する。`raw` は「フレーム1, フレーム2, ...」の全フレームが順番に並んだ
   ストリームであり、`text` はそれらを単に連結したものになる (例: `⠋ 分析中…⠙ 分析中…⠹
   分析中…`)。どのフレームが「現在画面に残っているか」はバイト列からは決まらない。
2. **スピナーが止まった直後も誤った印象を与える**: 完了時に行を消去して別の表示に切り
   替えると、tail に残るのは古いスピナーフレーム。逆に静止プロンプト表示中でも、直前の
   スピナーフレームが tail に残っていれば「まだ作業中」に見える。
3. **バイトベースの idleForMs はスピナーで常に更新される**: `get_tab_status` の
   `idleForMs` は `lastOutputAt` (バイト出力時刻) ベース (mcpTools.js:150, sessionManager
   .js:297)。スピナーが回っている間は**内容が同じでも**バイトが出続けるため、
   「実はモデルが待機/停滞しているのに作業中と誤判」する。
4. **付随する正確性の問題**:
   - `text` の 16KB slice (`raw.slice(-MAX_READOUTPUT_CHARS)`) がエスケープシーケンスの
     途中で切れると、`stripAnsi` が取りこぼして制御文字が `text` に漏れる。
   - pty chunk 境界で UTF-8 マルチバイト文字が分割されると mojibake になる
     (outputBuffer は文字列として連結するため、跨ぎは join では修復できない)。

### 既存の周辺資産

- サーバー側に ANSI パーサは無い (`ANSI_RE` は正規表現のみ)。クライアントは xterm.js
  が画面を持つ (ccserver 側の再利用は想定しない — サーバーは Node で動く軽量モデルを新設)。
- read_output の呼び出し側 (オーケストレーター) は、テンプレート
  (routes/groups.js `DEFAULT_ORCHESTRATOR_TEMPLATE` 135-141) で「read_output で
  アイドル/完了プロンプトかどうか確認」する運用を既にしているため、**この判定を
  安定させる API が必要**。

## 実装方針

### フェーズ1: 軽量仮想画面モデル `server/ws/screenModel.js` (新規・純モジュール)

1. 新モジュール `screenModel.js` を追加。node --test で直接ユニットテスト可能な
   純関数/ファクトリ構成にする (mcpTools.js と同じ「アプリの mutable モジュールを
   import しない」制約を踏襲)。
   - 状態: 可視行リスト (最近 N 行、既定 200、1 行は幅 W=80 で wrap)、カーソル位置、
     代替画面フラグ、**部分エスケープ保持バッファ** (chunk 跨ぎのシーケンスを安全に継続)。
   - 処理する制御 (サブセットで十分。未対応シーケンスは無害に無視):
     - 表示文字 (改行 wrap)、CR / LF / BS / TAB
     - CSI: CUP/H, CUU/A, CUD/B, CUF/C, CUB/D, CHA/G, EL/K (0/1/2), ED/J (0/2/3),
       SGR (描画属性は無視して破棄), 25l/25h (カーソル表示は無視)
     - 代替画面: CSI ?1049h/l, ?47h/l (切り替え時は内容を保持し、フラグで公開)
     - OSC / その他の ESC シーケンス: 破棄
   - 出力: `screenRows()` (現在の可視行), `altScreenActive()`, `version()` (1 画面変更ごと
     に増える整数 — 変化検知用)。
2. サイズ上限: 可視行 200 行 × 80 文字 ≒ 16KB 相当でメモリは有界 (outputBuffer 512KB と同格)。
3. `server/ws/sessionManager.js` — `appendToBuffer` (1103-1111) で
   `session.screen = screenModel` を並行維持:
   - `session.screen` が無ければ作成 (createSession で初期化)。
   - chunk 追記時に `screen.feed(data)` を呼び、画面が実際に変化したら
     `session.screenLastChangeAt = Date.now()` を更新。
   - UTF-8 の chunk 跨ぎ: chunk を `Buffer` 経由ではなく `TextDecoder` の stream モードで
     連結し、末尾の未完了文字を次 chunk へ持ち越す (mojibake を防ぐ)。decode 済み文字列を
     outputBuffer と screen の両方に渡す。
   - 既存の outputBuffer / autoYesBuf 等の挙動は変えない (screen は追加物)。

### フェーズ2: read_output / get_tab_status への画面ベース情報の追加

4. `server/ws/mcpTools.js` — `readOutput` の結果に追加 (raw/text/truncated は後方互換で維持):
   - `screen` — 現在の可視画面の末尾 (例: 最大 40 行、1 行 80 文字、行数が多い場合は
     末尾を返し `screenTruncated: true`)。生バイト tail ではなく「今見えている状態」。
   - `screenAlt` — 代替画面使用中か。
   - `screenIdleMs` — 画面が最後に変化してからの経過 (スピナーが回っていれば小さい、
     静止プロンプトなら大きい)。**バイト出力ではなく画面変化ベース**なので、
     「スピナーだけ回って中身は停滞」も busy として正しく判定される。
   - サイズ: `screen` は 16KB キャップを独立に適用 (コンテキスト肥大化防止の既存思想)。
5. `server/ws/mcpTools.js` — `getTabStatus` にも `screenIdleMs` を追加 (read_output を
   呼ばずに判定できるように)。`idleForMs` (バイトベース) は互換のため残す。
6. `server/ws/mcpServer.js` — ツール説明文を更新:
   - `read_output`: 「`screen` と `screenIdleMs` を優先せよ。`text` は後方互換の
     バイトストリーム。スピナー等の動的描画は生ストリームでは判定できない」旨を明記。
   - `get_tab_status`: `screenIdleMs` の説明を追記。
7. `server/routes/groups.js` `DEFAULT_ORCHESTRATOR_TEMPLATE` — 「stuck 判定は
   `read_output` の `screen` / `screenIdleMs` で行う」旨に更新
   (現在の「read_output でアイドル/完了プロンプトか確認」の記述を具体化)。

### フェーズ3: テスト

8. `server/ws/screenModel.test.js` (新規):
   - スピナー描画列 (フレーム + 行消去 + カーソル位置固定) を feed → `screenRows()` が
     最新フレームの 1 行だけになる。
   - CR 上書き / 行消去 / 画面消去 / 代替画面 1049 切替 / スクロール (行数超過) /
     未対応 CSI の無視。
   - エスケープシーケンスが chunk 境界で分割されても正しく処理される (partial 保持)。
   - UTF-8 マルチバイト文字の chunk 跨ぎ分割で mojibake しない (TextDecoder stream)。
9. `server/ws/mcpTools.test.js` — readOutput の統合テスト追加 (fake session に
   outputBuffer + screen を注入):
   - スピナー風出力を注入した fake セッションで、`screen` が最新 1 行、
     `screenIdleMs` が画面変化時刻と整合すること。
   - `get_tab_status` の `screenIdleMs` が返ること。

## 変更しない範囲

- `raw` / `text` / `truncated` の既存フィールドと意味 (後方互換)。
- outputBuffer の chunk 構造と 512KB キャップ (既存の attach/replay/resume 経路に影響
  させない)。
- クライアント側の xterm.js 描画 (サーバー側モデルは read_output 専用)。
- 代替画面の注入方針 (claude は無効化、opencode は TUI のまま — 変えない)。

## 検証コマンド

```bash
npm test                        # workspace=server の全ユニット (screenModel / read_output 含む)
npm run build --workspace=client
npm run test:e2e                # 回帰確認
```

- 手動確認: 実サーバーで opencode ワーカーを起動し、作業中 (スピナー表示) と待機中
  (静止プロンプト) のそれぞれで `read_output` を呼び、`screen` が実際の見た目に一致し、
  `screenIdleMs` が busy/idle を正しく区別することを確認。

## 完了条件

- read_output が「現在見えている画面」(`screen`) と「画面変化ベースの idle 時間」
  (`screenIdleMs`) を返し、スピナー/動的描画を安定して判定できる。
- エスケープシーケンスの chunk 跨ぎ・UTF-8 マルチバイト跨ぎで破損しない
  (ユニットテストで検証済み)。
- `text` の 16KB slice でシーケンスが途中切断されない (chunk 粒度で切る修正を含む)。
- オーケストレーターのテンプレートとツール説明が新 API を指すよう更新されている。
- サーバー単体テスト・E2E が通る。
