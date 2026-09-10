# macOS Seatbelt バックエンド コードレビュー結果 (2026-09-10)

- 日付: 2026-09-10
- 対象ブランチ: `feat/sandbox-seatbelt-macos-resolved`
- 実行: `/code-review`（8 finder angle → dedup → ソース照合）
- レビュー範囲: `master..HEAD`（macOS Seatbelt バックエンドと関連する git-broker / usage / pty-host / groups の変更一式）
- 照合者による再検証: このドキュメントの `Verdict` 欄

## TL;DR

- **10 件中、テストカバレッジ補完コミット `7ba0e2b` が原因のものは 0 件。** すべて Seatbelt バックエンド本体（`8771155` 以降の複数コミット）の既存の問題。
- **セキュリティ 4 件**（A〜D: サンドボックス脱出 2 / DoS 1 / 認証情報漏洩 1）が対応推奨。
- **可用性・挙動リグレッション 3 件**（E〜G）、**コード品質 1 件**（H）。
- **誤検出寄り 2 件**（I, J: usage.js。`usageSendGate` 抽出は `force` パスをバイト等価に保っており、指摘された挙動変更は `cce890b` のもの)。

| # | 箇所 | 分類 | Verdict | 対応 |
|---|---|---|---|---|
| A | `sandbox.js:seatbeltControlSockPaths` | サンドボックス脱出 | CONFIRMED | ✅ 修正済 |
| B | `sandbox-seatbelt.js` netDenyLiterals | サンドボックス脱出 | CONFIRMED | ✅ 修正済 |
| C | `sandbox-seatbelt.js` runtime dir write | DoS（全ユーザー） | CONFIRMED | ✅ 修正済 |
| D | `sandbox-seatbelt.js` GIT_CONFIG helper | 認証情報漏洩 | CONFIRMED | ✅ 修正済 |
| E | `git-broker.js:ensureHostRuntimeDir` | 可用性 / ローカル DoS | CONFIRMED | ✅ 修正済 |
| F | `sandbox-seatbelt.js` XDG_RUNTIME_DIR 長 | 機能不全 | PLAUSIBLE | ✅ 修正済 |
| G | `routes/groups.js:454` | 挙動リグレッション (Linux) | CONFIRMED | 未対応 |
| H | `pty-host/ptyStore.js` teardown 4 重複 | コード品質 / 潜在バグ | CONFIRMED | 未対応 |
| I | `usage.js` force 送信 | — | 誤検出（`cce890b` 由来） | 要検討 |
| J | `usage.js` onData trust ハンドラ | — | 誤検出（`cce890b` 由来） | 要検討 |

---

## 対応状況（2026-09-10 実装）

A〜F を実装済み。G/H/I/J は未着手。

| # | 実装概要 | 主な変更ファイル |
|---|---|---|
| A | `seatbeltControlSockPaths()` が `CCSERVER_PTY_HOST_SHARDS` を読み、shard 1..N-1 の `ccserver-pty-host-<i>.sock`（および `CCSERVER_PTY_HOST_SOCK` override 時の `<value>-<i>`）も deny-pin に含める。 | `server/ws/sandbox.js` |
| B | 新ヘルパ `pathVariantsDeep()`（非存在パスでも最も近い実在祖先まで遡って raw + realpath 両綴りを合成）を追加し、`netDenyLiterals` 構築を階層数非依存に置換。2 階層 meta ソケットの `/private/tmp` 綴りが常に pin される。 | `server/ws/sandbox-seatbelt.js` |
| C | `buildSeatbeltLaunch` に `hostRuntimeDir` 引数を追加。プロファイル末尾に `deny file-write* (subpath <runtimeDir>)`（両綴り）を発行し、直後にこのセッションが connect() するソケットのみ literal 再許可。pty-host/meta は再許可対象外。runtime dir の rename/rmdir によるサーバー全体 DoS を封鎖。 | `server/ws/sandbox-seatbelt.js` / `server/ws/sandbox.js` |
| D | `gitConfigKeys` 先頭に `['credential.helper', '']`（空値リセット）を挿入し、`.gitconfig` / `.config/git/config` / repo `.git/config` の既存 helper を無効化してから broker shim を再設定。多層防御として `~/.git-credentials` と `~/.config/git/credentials` を broker 有効時に deny-write pin。 | `server/ws/sandbox-seatbelt.js` |
| E | `ensureHostRuntimeDir()` は「自 uid 所有 + mode 不正」のときだけ `chmodSync(0o700)` で self-heal（他人所有なら従来どおり refuse）。エラーメッセージに owner/mode と復旧手順を追記。throw 伝播設計の `mcpBroker.js` / `rpcServer.js` はそのまま。 | `server/ws/git-broker.js` |
| F | seatbelt launch dir のリーフを `ccserver-seatbelt-<uuid>`（54字）→ `ccserver-sb-<12hex>`（19字）に短縮。`<dir>/runtime` を単一 teardown 単位のまま実 `$TMPDIR` ベースで `sockaddr_un.sun_path` 104B に収める。sibling-deny プレフィクスも追随。 | `server/ws/sandbox-seatbelt.js` |

テスト: `server/ws/sandbox-seatbelt.test.js` に A〜F の回帰テストを追加。既存テストのうち GIT_CONFIG_COUNT / sibling-deny プレフィクス依存分を更新。

---

## A. pty-host シャードソケットの deny-pin 漏れ（サンドボックス脱出）

- 箇所: `server/ws/sandbox.js` `seatbeltControlSockPaths()`
- Verdict: **CONFIRMED**

### 内容

`seatbeltControlSockPaths()` は shard 0 の RPC ソケットしか deny-pin しない:

```js
const paths = [join(base, PTY_HOST_SOCK_NAME)];              // = <base>/ccserver-pty-host.sock
if (process.env.CCSERVER_PTY_HOST_SOCK) paths.push(...);
```

一方 `pty-host/index.js:getPtyHostSockPath(n)` は非ゼロ shard で
`<base>/ccserver-pty-host-<n>.sock` を返す（Issue #119 / Plan5 のシャーディング）。

### 失敗シナリオ

macOS デプロイでシャード pty-host（複数ユニット / `CCSERVER_PTY_HOST_SHARDS>1`）を
動かすと、サンドボックス内の侵害されたエージェントが shard N (N>0) の RPC ソケットへ
`connect()` できる（`(allow network*)` 済み、`/tmp` 到達可、パスは推測可能）。
そこへ `spawn` RPC を `sandbox:false` で発行 → **非サンドボックスのホスト実行**、
すなわち完全なサンドボックス脱出。この pin はまさにそれを塞ぐために存在する。

### 修正案

`seatbeltControlSockPaths()` で shard ソケットを範囲 pin する。例:

```js
const paths = [join(base, PTY_HOST_SOCK_NAME)];
for (let i = 1; i <= (Number(process.env.CCSERVER_PTY_HOST_SHARDS) || 1) - 1; i++) {
  paths.push(join(base, `ccserver-pty-host-${i}.sock`));
}
```

シャード数が動的なら、`ccserver-pty-host*.sock` を（network-outbound は
path-literal のみ受けるため）現実的な上限までループ pin するか、
そもそも pty-host ソケットを共有ランタイム dir から出して per-session dir に置く。

---

## B. 2 階層メタソケットの realpath 綴り漏れ（サンドボックス脱出）

- 箇所: `server/ws/sandbox-seatbelt.js` `netDenyLiterals` 構築部
- Verdict: **CONFIRMED**

### 内容

```js
const parentVariants = existsSync(parent)
  ? pathVariants(parent)
  : [parent, ...pathVariants(dirname(parent)).map((d) => join(d, basename(parent)))];
```

`pathVariants(p)` は `realpathSync` が throw する非存在パスで `[p]`（raw 綴りのみ）を返す。

- **pty-host ソケット（1 階層）** `<base>/ccserver-pty-host.sock`:
  `parent = <base>` が非存在 → `dirname(parent) = /tmp` は存在 →
  `pathVariants('/tmp') = ['/tmp', '/private/tmp']` → 両綴りが pin される。**OK**。
- **meta ソケット（2 階層）** `<base>/ccserver-meta.d/sock`:
  `parent = <base>/ccserver-meta.d` が非存在 → `dirname(parent) = <base>` も非存在 →
  `pathVariants(<base>) = [<base>]`（raw のみ）→ deny literal は
  `/tmp/ccserver-runtime-<uid>/ccserver-meta.d/sock` のみ。
  **`/private/tmp/...` 綴りが欠落**。

### 失敗シナリオ

初回サンドボックス起動（`XDG_RUNTIME_DIR` なし、broker/guard/pty-host 全 off で
ランタイム dir 未作成）。Seatbelt は connect() を realpath（`/private/tmp/...`）で
評価するため deny がマッチせず `(allow network*)` が勝つ。後からメタエージェント
セッションがこのサンドボックス稼働中に開始されると、非特権エージェントが
特権メタブローカーへ `connect()` 可能。

### 修正案

`netDenyLiterals` 構築を「祖先を `/` まで辿って全階層の realpath 綴りを合成」に
変更。または `hostRuntimeDir()` を起動前に `ensureHostRuntimeDir()` で必ず
materialize してから pin を組む（存在すれば `pathVariants` が両綴りを返す）。

---

## C. ランタイム dir 自体が書き込み可能（全サーバー DoS）

- 箇所: `server/ws/sandbox-seatbelt.js`（`writeRegexes` の `^/tmp(/.*)?$` と
  `netDenyLiterals` の exact-match pin）
- Verdict: **CONFIRMED**

### 内容

制御ソケットの *ファイル* は write-pin 済み:

```js
denyWriteRegexes.push(...netDenyLiterals.map((s) => `^${escapeSeatbeltRegex(s)}$`));
```

しかし親ディレクトリ `/tmp/ccserver-runtime-<uid>` 自体は `^/tmp(/.*)?$` の
write-allow 下で、deny-pin されていない。

### 失敗シナリオ

サンドボックスプロセスはサーバーと同一 uid で動き、`/tmp/ccserver-runtime-<uid>`
(0700) はその uid が所有する。macOS `/tmp`（→`/private/tmp`）は sticky だが、
sticky は「自分が所有するエントリ」の rename/delete を止めない。よって
`rename('/tmp/ccserver-runtime-<uid>', '/tmp/x')` や（空なら）`rmdir` が許可される。
ソケットのリーフ pin は *祖先ディレクトリ* の rename を防がない。

ホストの pty-host RPC / meta / notify / usage / reviewer ソケットが一斉に
存在しないパスに解決され、ホスト側の新規 connect と他セッションの制御プレーン
通信が全滅 → **サンドボックス起点でサーバー全体（他ユーザー含む）を DoS**。
bwrap はランタイム dir を書き込み可能な形で公開しない（特定のソケットファイルのみ bind）。

### 修正案

```lisp
(deny file-write* (subpath "<hostRuntimeDir()>"))
```

をランタイム dir ツリー全体に対して発行する。サンドボックスが必要とするのは
ソケットへの `connect()`（`network-outbound` で別途仲介）だけで、ランタイム dir 配下へ
`file-write*` する必要はない（`XDG_RUNTIME_DIR` はサンドボックス側で launch dir の
`runtime/` に差し替え済み）。gitBroker のソケットは *別* の per-broker tmp dir
（`gitBroker.dir`）にあるので影響しない。両綴りを pin すること。

---

## D. GIT_CONFIG 経由の `credential.helper` がリスト追加になる（認証情報漏洩）

- 箇所: `server/ws/sandbox-seatbelt.js`（`gitConfigKeys.push(['credential.helper', ...])`）
- Verdict: **CONFIRMED**

### 内容

bwrap は `GENERATED_GITCONFIG` を `~/.gitconfig` に ro-bind し、user 定義の
helper を完全に上書きする。Seatbelt はマウントが無いため `GIT_CONFIG_KEY_N=
credential.helper` を env で注入するが、git の multi-valued key セマンティクスでは
これは **リストへの追加**であって置換ではない。

### 失敗シナリオ

永続 HOME 再利用時:

1. 以前 `gitBroker: false` のセッションで `git config --global credential.helper store`
   が実行された（gitBroker off の間は `.gitconfig` の write-pin が無い）。
2. 後の `gitBroker: true` セッション。`.gitconfig` の write-pin は新規書き込みを
   止めるが git は既存ファイルを **読む**。`GIT_CONFIG_KEY_x=credential.helper` は
   ブローカー shim を **追加** → 実効 helper リストは `[store, broker-shim]`。
3. `git fetch` 成功後、git は全 helper に `approve` を呼ぶ → `store` が
   ブローカー発行トークン（ユーザーの `gh auth token` 全体、リポジトリ非スコープ）を
   `~/.git-credentials` に書く。
4. エージェントは `~/.git-credentials` を読める（`effectiveHome` は全読み取り可、
   かつ `~/.git-credentials` は write-pin 対象外）→ そのトークンで allowlist 外の
   任意の github.com リポジトリに直接アクセス。

### 修正案

helper リストの先頭で空値リセットを注入する（git: 空文字列の `credential.helper` は
それ以前の helper リストをクリアする）:

```js
if (gitBroker) {
  gitConfigKeys.push(['credential.helper', '']);            // <- リセットを先に
  gitConfigKeys.push(['credential.useHttpPath', 'true']);
  gitConfigKeys.push(['credential.helper', shEscapeWord(credHelperShim)]);
}
```

`GIT_CONFIG_*` は git が最後に（最高優先で）読むため、この 2 エントリで
`.gitconfig` / `.config/git/config` / repo `.git/config` の helper がすべて無効化され、
shim だけが残る。あわせて `~/.git-credentials` を deny-write pin する（多層防御）。

---

## E. `ensureHostRuntimeDir()` の fail-closed が uncaught でサーバーを brick

- 箇所: `server/ws/git-broker.js` `ensureHostRuntimeDir()`（呼び出し元
  `mcpBroker.js` / `pty-host/rpcServer.js`）
- Verdict: **CONFIRMED**（可用性 / ローカル DoS）

### 内容

macOS で `XDG_RUNTIME_DIR` なしのとき、ベースは sticky・world-writable な
`/tmp` 配下の `/tmp/ccserver-runtime-<uid>`。`ensureHostRuntimeDir()` は
既存 dir の mode が `0700` でない、または owner が自 uid でないと **throw** する。
`mkdirSync` は既存 dir の mode を直さず、どこも chmod self-heal しない。

### 失敗シナリオ

- 別のローカルユーザーが `/tmp/ccserver-runtime-<victim-uid>` を先に作る、または
- 過去 / 別ツールが `0755` で残す、または
- ホストの umask ポリシーで `0700` にならない

すると:
- `startGitBroker` → catch 済み（ブローカー無効化）
- `mcpBroker.listenMcp`（`mcpBroker.js:95`）→ **uncaught throw**
- pty-host `createRpcServer`（`rpcServer.js:83`）→ **uncaught throw**

サンドボックスセッション・MCP ブローカー・pty-host RPC がそのホストで停止し、
ログにも復旧手順が出ず、手動でディレクトリを消すまで復旧不能。

### 修正案

所有権 / mode チェック自体は正しい（他人の dir を使わない）。ただし
`mcpBroker` / `rpcServer` 側で catch し、feature を graceful に無効化 +
remediation をログ出力する。あるいは `ensureHostRuntimeDir()` が
「自分所有 + mode 不正」のときだけ `chmodSync(0o700)` で self-heal する
（他人所有なら従来どおり refuse）。

---

## F. 面内 `XDG_RUNTIME_DIR` が深いパス（sockaddr_un 104B 制限の再導入）

- 箇所: `server/ws/sandbox-seatbelt.js`（`env.XDG_RUNTIME_DIR = join(dir, 'runtime')`）
- Verdict: **PLAUSIBLE**（機能不全、セキュリティではない）

### 内容

macOS で `dir` は概ね
`/private/var/folders/xx/<28char>/T/ccserver-seatbelt-<36char>/runtime`（約 115B）。
`git-broker.js` の `hostRuntimeDir()` が短い `/tmp` ベースにしたのは
`sockaddr_un.sun_path` の 104B 制限を避けるため。同じ制限がサンドボックス内に戻る。

### 失敗シナリオ

`$XDG_RUNTIME_DIR` 直下に unix ソケットを bind するツール
（gpg-agent の socketdir フォールバック、tmux、`ssh -o ControlPath=%d/...`）が
`bind()` で `ENAMETOOLONG` / `EINVAL`。

### 修正案

サンドボックス内 `XDG_RUNTIME_DIR` も短い base（例
`$TMPDIR/ccs-rt-<短縮 id>` や `/tmp/ccs-<uid>-<id>`）に置く。ただし teardown 単位が
`dir` 配下という前提を崩さないよう、`dir` 自体を短縮するか、runtime だけ別管理にする。

---

## G. orchestrator-restart が全プラットフォームで無条件 `destroySession()`

- 箇所: `server/routes/groups.js:454`
- Verdict: **CONFIRMED**（挙動リグレッション、非 macOS）

### 内容

```js
if (s) destroySession(existing, { reason: 'orchestrator-restart' });
```

`sessionManager.fireSchedule` の同等 retire は
`Array.isArray(s.sandboxSeatbeltFiles)`（= seatbelt overlay を持つセッション）で
ゲートしているが、groups.js 側は無条件。

### 失敗シナリオ

Linux/bwrap（`seatbeltFiles` なし）でも、終了済み orchestrator セッションを
即座に強制破棄 → ターミナルタブを開いたままのビューアに `destroyed` イベント、
スクロールバック / 復元メタデータを破棄。以前は reap されるまで残っていた。
非 macOS の一般的な restart フローの挙動変更 + `fireSchedule` との不整合。

### 修正案

groups.js 側も seatbelt overlay を持つ場合のみ retire する（`fireSchedule` と
同じゲート）。または両者を共通ヘルパに寄せる（下記 H と併せて）。

---

## H. seatbelt overlay teardown ロジックの 4 重複

- 箇所: `server/pty-host/ptyStore.js`（spawn-catch + `destroy()`）、
  `server/ws/sessionManager.js`（spawn-catch + `destroySession()`）
- Verdict: **CONFIRMED**（コード品質 / 潜在バグ）

### 内容

「`sandboxSeatbeltFiles` を unlink する。ただし他の生存セッションがまだ参照して
いれば残す」というスキャンが 4 箇所にコピペされている。2 つの spawn-catch コピーは
destroy コピーが持つ `other === self` 除外を欠く。

### 失敗シナリオ

overlay ファイルの所有 / 参照モデルが 4 箇所に分散し、ガードが微妙に異なる。
将来この参照モデルを変更したとき（あるいは self 除外を欠くコピーの片方を
間違えたとき）、生存中の orchestrator の overlay を実行中に unlink するか、
古い CLAUDE.md/AGENTS.md をユーザーのリポジトリに残す。

### 修正案

`releaseSeatbeltOverlay(files, owners, { exclude })` のような単一ヘルパに集約。

---

## I / J. usage.js の `force` 送信 / onData trust ハンドラ（誤検出寄り）

- 箇所: `server/usage.js`（`sendUsage({force:true})` / `ptyProc.onData` の trust ゲート処理）
- Verdict: **誤検出（`7ba0e2b` 由来ではない）**

### finder の主張

- I: 「forced post-trust 送信が `/usage` 既送信時にスキップしなくなった → `/usage/usage`」
- J: 「onData の trust ゲート処理が `!sentUsage` ガードを失った → ダッシュボード表示後に
  live セッションへ `y`+Enter」

### 再検証

`7ba0e2b` の `usageSendGate` 抽出は `if (!force) { ... }` の構造を **不変**に保っており、
`force` パスは以前もこのブロックを丸ごとスキップしていた（`force` は常に送信）。
`onData` の trust ハンドラと `TRUST_RE` の拡張は `cce890b`（`fix(usage): harden
sandboxed /usage capture`）の変更で、`7ba0e2b` は一切触れていない。

### とはいえ検討価値のある点（`cce890b` 側）

- `buf` は最大 256KB のスクロールバックを保持し、`TRUST_RE` は
  `do you trust` / `trust this directory|project` にも広がった。後続画面の
  レンダ文字列が偶然マッチすると、`warmUsage()` がサーバー起動時に無人で
  live claude REPL へ `y`+Enter を打つ余地がある（`trustHandled` で 1 回に
  制限されるので影響は限定的）。
- 対策候補: trust 判定を「画面末尾 N 行」だけに限定する、`sentUsage` 後は
  判定しない、`answerTrustThenUsage` の force 送信前に Ctrl-U を打つ。

---

## 対応方針（提案）

1. **A〜D を優先**（セキュリティ）。A・C・D は比較的小さい変更 + テスト追加で閉じられる。
   B は `netDenyLiterals` 構築の作り直しが必要。
2. E〜G を次点（可用性 / 挙動）。
3. H は A〜G の修正に合わせてリファクタ。
4. I/J は `cce890b` のスコープとして別途。
