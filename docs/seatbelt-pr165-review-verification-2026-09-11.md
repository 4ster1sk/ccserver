# PR #165 レビュー指摘の精査結果 (2026-09-11)

- 日付: 2026-09-11
- 対象 PR: nananek/ccserver#165「feat: macOS Seatbelt サンドボックスバックエンド (`sandbox-exec`)」
- 対象ブランチ: `feat/sandbox-seatbelt-macos-resolved` (HEAD `887b571`)
- レビュー元: nananek 氏の PR コメント (2026-09-10、Claude Code 生成)。inline API が使えず 1 コメントに集約されている
- 精査方法: 各指摘を該当コード (`git show 887b571:<path>`) と突き合わせ。実機 (macOS + `sandbox-exec`) を要する項目は「要実機確認」として末尾にコマンドを列挙

## TL;DR

- レビューの指摘は **全項目が妥当**。誤り・的外れは無い。一部は表現がやや強い/弱い程度。
- 対応優先度:
  1. **#1 / L1** control-broker ソケットが seatbelt サンドボックスから到達可能 (macOS 固有の隔離低下)。combo/group + 敵対的エージェント前提で、同一 ccserver インスタンスの全グループを乗っ取れる。
  2. **#10** `git-broker.js` のトークンのコメントが KERN_PROCARGS2 の既知の限界と矛盾 (コメントのみ、挙動は正しい)。
  3. **#13** サンドボックス化された `/usage` キャプチャがリトライされず、trust ゲート経由だと毎回フルタイムアウト頼み。
  4. **#3 #4 #5** seatbelt プロファイルの過剰な許可 (実ホーム直下の列挙 / node bin ディレクトリ全体 / sysctl prefix)。
  5. **#9 #12** overlay 所有権チェックの 4 箇所重複と retire-first の順序非保証。
  6. **#2 #6 #7 #8 #11 L2** 軽微 (cleanup 1 本にまとめられる)。

## 判定一覧

| # | 指摘 | 箇所 | 判定 | 深刻度 | 実機確認 |
|---|---|---|---|---|---|
| 1 | `seatbeltControlSockPaths()` にグループ control-broker ソケットが無い | `sandbox.js:1743` / `sandbox-seatbelt.js:365` | 妥当 | 高 | 推奨 |
| 2 | `buildMinimalSeatbeltSpawn` に `cwd==='/'` フェイルオープン防止ガード無し | `sandbox.js:1797` (ガードは `:1942` のみ) | 妥当 (多層防御) | 低 | 不要 |
| 3 | `ancestorExactRegexes(hostHome)` で実ホーム直下が列挙可能 | `sandbox-seatbelt.js:847` | 妥当 | 中低 | 必要 |
| 4 | `subtrees(dirname(nodeBin))` は bwrap の「node 単体 bind」parity ではない | `sandbox-seatbelt.js:886` | 妥当 | 低 | あれば可 |
| 5 | sysctl の `hw.` / `kern.os` prefix が広く、コメントの「拒否確認済み」と矛盾 | `sandbox-seatbelt.js:332-348` (主張は `:294-296`) | 妥当 (ほぼ確実) | 低 (記述の正確性) | 必要 |
| 6 | `shEscapeWord()` が改行をバックスラッシュエスケープ → 行継続で消える | `sandbox-seatbelt.js:572` (呼び出し `:761`) | 妥当 (潜在) | 極低 | 不要 |
| 7 | blocked パス / appConfigDirs が両バックエンドで二重管理 | `sandbox.js:1616` / `sandbox-seatbelt.js:1034`,`:937`,`:817` | 妥当 (保守性) | 低 | 不要 |
| 8 | `buildSeatbeltLaunch` の realpath/exists 冗長呼び出し | `sandbox-seatbelt.js` `subtrees()`/`pathVariants()` | 妥当 | 些細 | 不要 |
| 9 | overlay 所有権チェックの 4 箇所重複・兄弟が referencer 未登録 | `ptyStore.js:162`,`:345` / `sessionManager.js:1216`,`:2300` | 妥当 | 中 | 困難 |
| 10 | `git-broker.js` のトークンのコメントが KERN_PROCARGS2 の記述と矛盾 | `git-broker.js:320-326`,`:491-495` | 妥当 | 中 (セキュリティ記述の誤り) | 不要 |
| 11 | `sessionManager.js` cwd='/' ガードのメッセージが実態と不一致 | `sessionManager.js:623` | 妥当 | 軽微 | 不要 |
| 12 | retire-first の fire-and-forget `destroySession` → spawn が順序非保証 | `sessionManager.js:1831` / `groups.js:454` | 妥当 (狭いレース) | 低中 | 困難 |
| 13 | `sendUsage({force:true})` がリトライを武装しない | `usage.js:338-368` | 妥当 | 中 | 必要 |
| L1 | control-broker に接続認証が無い (macOS で露出増) | `mcpBroker.js` / `mcpServer.js:7` | 妥当 (= #1 と同根) | 高 | 推奨 |
| L2 | `discoverSshAuthSock()` に macOS 候補 (1Password 等) が無い | `sandbox.js:1069` | 妥当 | 低 (回避策あり) | 不要 |

---

## 詳細

### #1 / L1 — control-broker ソケットが seatbelt サンドボックスから到達可能 (最重要)

**確認した事実:**

- seatbelt プロファイルは `(allow network*)` (`sandbox-seatbelt.js:353`) の後、`controlSockDenies` = `seatbeltControlSockPaths()` が返す **pty-host RPC ソケットと meta ソケットだけ** を
  `(deny network-outbound (remote unix-socket (path-literal ...)))` で pin する (`sandbox-seatbelt.js:365`, `sandbox.js:1743-1780`)。
- グループの **control / handoff ソケット** (`mcpBroker.js` の `ccserver-mcp-<groupId>-<tag>.d/sock`) は deny リストに含まれない。`sockets.mcp` は逆に `readLiterals`/`writeLiterals` で **許可** される (`sandbox-seatbelt.js:895-905`)。
- `mcpBroker.js` の control broker には **接続認証が無い**。per-connection の identity frame は notify の属性付け専用で、control/handoff の `buildServer` は identity 引数を無視する (`mcpServer.js:7-14`)。`mcpServer.js:59` のコメント「The socket path is reachable by anything running as the same user, not just the group's sandbox」も同じ前提を認めている。
- seatbelt プロファイルは `/tmp` / `/private/tmp` を **broad read 許可** (`sandbox-seatbelt.js:792`)。`hostRuntimeDir()` は darwin で `/tmp/ccserver-runtime-<uid>` (`git-broker.js`)。
- worker セッションの `CCSANDBOX_MCP_SOCK` env に自分の handoff ソケットのフルパスが入る (`sandbox-seatbelt.js:657`)。ここから groupId が取れる。さらに `ls /tmp/ccserver-runtime-<uid>/` で **同一 ccserver インスタンスの全グループの control ソケットが列挙できる** (runtime dir は deny-write のみで read は許可)。
- control MCP ツール (`buildControlMcpServer`, `mcpServer.js:109-220`): `list_group_sessions` / `read_output` / `send_input` / `new_session` / `send_key` / `open_tab` / `close_tab` / `wait_for_handoff` 等。`deps.groupId` は `startControlBroker({ groupId })` でソケット単位に束縛され、ツール引数の `sessionId` は `isSessionInGroup(deps.groupId, sessionId)` で検証される (`mcpTools.js:134` 他) — つまり **接続したソケットのグループに対しては全ツールが使える**。

**帰結:** macOS + combo/group 実行時、サンドボックス内の敵対的エージェント (worker のプロンプトインジェクション等) は `(allow network*)` 経由で **任意のグループの control broker に `connect()` でき**、`send_input` (他セッションへ任意入力注入) / `read_output` (他エージェントの端末内容・秘密の窃取) / `new_session` / `close_tab` / `open_tab` を実行できる。bwrap は control ソケットの `.d` ディレクトリを orchestrator のマウント名前空間にしか bind しないため worker からは到達不可能 — **macOS 固有の隔離低下 (回帰)**。

**レビュー表現の補正:** 「自分の groupId から兄弟グループのパスを計算」は不正確 (`groupId` は `randomUUID()`, `routes/groups.js:261`)。ただし `ls` で列挙できるため結論は変わらず、むしろ全グループ横断でより広い。

**深刻度:** 高。前提は combo/group + 敵対的エージェント。ホスト RCE や別 UID への越境は無く、影響は当該 ccserver インスタンスのエージェント群に限定。単一セッションは無関係。

**推奨対応:** deny-pin ではなく **mcpBroker への接続トークン認証** (本 PR で git-broker に導入したのと同じ仕組み — `git-broker.js` の `CCSANDBOX_BROKER_TOKEN` / `tokenEq` / handleRequest 冒頭の検証)。deny-pin は「このセッションが正当に使うソケットだけ除外」する組み立てが必要で複雑。トークンなら bwrap 側や非サンドボックス同一 UID からの到達も塞げる。notify / usage / reviewer ソケットも同様に無認証なので、まとめて対応するのが妥当。

### #10 — `git-broker.js` のトークンのコメントが自己矛盾

`git-broker.js:320-326`:

> Connection auth: ... Without a matching per-session token -- delivered to the sandbox via CCSANDBOX_GIT_BROKER_TOKEN, and **unreadable from a peer session's env now that KERN_PROCARGS2 is denied** -- ...

`git-broker.js:491-495` にも「the profile denies KERN_PROCARGS2」。

これは `sandbox-seatbelt.js:302-331` の KNOWN LIMITATION と **このPR の説明文自身** (「KERN_PROCARGS2 は Seatbelt では塞げない、peer セッションが env を読める」) に真っ向から矛盾する。Part A/B (`17e8a30` / `5691bb5`) 時点の誤った前提 (`(deny sysctl-read (sysctl-name "kern.procargs2"))` が効くと考えていた) が、`f88e089` / `3b1eb1a` で否定された後もコメントに残存している。

コード挙動は正しい (トークン検証は有効、Linux では per-session マウントとの二重防御) ので **コメント修正のみ**。ただしセキュリティ姿勢を誤って伝えるため優先度は中。「トークンは監査・偶発防止の層であって、macOS では peer セッションから KERN_PROCARGS2 で読み取れる。実効境界は repo スコープ allow-list」に直す。

### #13 — サンドボックス化された `/usage` キャプチャがリトライされない

`usage.js:338-368`。`sendUsage({force:true})` (trust ゲート応答後 `answerTrustThenUsage` から呼ばれる, `:381`) の挙動:

- `usageSendGate` をスキップ (`:340`)
- **`sentUsage` を true にしない** (`:347-348` は `if (!force)` 内)、`resends` も増やさない
- `:351` `if (resend && !force)` false → Ctrl-U スキップ
- `:357` `if (!resend && !force)` false → **リトライ `schedule()` を武装しない**

throwaway-cwd のサンドボックス capture は必ず trust ゲートを最初に通る (`:385` `if (isTrustPrompt(buf)) answerTrustThenUsage(); else sendUsage();`)。この経路では非 force の `sendUsage()` が一度も呼ばれず、`sentUsage` は最後まで false。すると:

- `onData` の `:400` `if (!sentUsage) return;` で `looksReady` 判定に到達せず → **成功しても `settleTimer` 経由の即完了ができない**
- リトライも無い → `:409` の `hardTimer` (`CAPTURE_TIMEOUT_MS` = 30s) が `parseUsage(buf)` を読むまで待つ

指摘は「force パスがリトライ非武装」だが、実際は **trust ゲート先行の場合 `sentUsage` が立たず fast-complete もリトライも無く、30 秒の hardTimer 頼み** で影響が大きい。設計上の想定 (`:373` コメント「Runs even if a /usage was already sent」) は「非 force の send が先にあって `sentUsage=true` + リトライ済み」だが、サンドボックスの throwaway-cwd 経路ではこの前提が成立しない。PR 自身の `/usage` 堅牢化 (`8d7526b`, `1762245`) のスコープ内。

**修正案:** force パスでも `sentUsage = true` を立て、リトライ `schedule()` を武装する (Ctrl-U と gate だけスキップ)。

### #3 — `ancestorExactRegexes(hostHome)` で実ホーム直下が列挙可能

`sandbox-seatbelt.js:847`:

```js
readRegexes.push(...ancestorExactRegexes([
  projectDir, effectiveHome, dir, ...tmpDirs, nodeBin, hostHome, ...appConfigDirs, ...
]));
```

`ancestorExactRegexes` (`:192`) は各パスの `dirname(v)` から `/` 直前まで exact-match 正規表現を積む (`:197-204`)。`appConfigDirs` (`:817`) は常に `join(hostHome, '.claude')` 等 (実ホーム基準) を含むため、その祖先として `^/Users/<user>$` が emit される。これは `readRegexes` → `(allow file-read* ...)` に入る。

`file-read*` は `file-read-data` を含み、ディレクトリに対する `file-read-data` は `readdir` を許す。よって throwaway-HOME の capture セッション (本来は空の scratch home しか見えないはず) からでも `ls /Users/<user>` (ハードコードの実パス) で実ホーム直下のエントリ名 (`.ssh` `.aws` `.gnupg` `.config`、プロジェクト名など) が列挙できる。**中身は読めない** (`/Users/<user>/<file>` は `^/Users/<user>$` にマッチしない)。

bwrap の throwaway-HOME は実ホームが見えないので macOS 固有の情報漏洩。通常セッションでも `appConfigDirs` が hostHome を参照するため同様に発生する (指摘は throwaway-HOME を強調しているが一般的)。

**修正案:** 祖先は `file-read*` ではなく `file-read-metadata` のみで emit する。realpath / lstat の component walk には `file-read-metadata` で十分で、`readdir` は不可になる。既存 exec テスト (`sandbox-seatbelt.exec.test.js:288` node realpathSync、`:306` shim ロード) が回帰チェックになるが macOS 実機が必要。

### #4 — nodeBin

`sandbox-seatbelt.js:886`:

```js
if (nodeBin) readRegexes.push(...subtrees(dirname(nodeBin)));
```

node のインストール bin ディレクトリ **全体** を read 許可。直前のコメント (`:882-885`) は bwrap の `--ro-bind SANDBOX_NODE_PATH` (node ファイル単体) と parity と主張しているが、実際は違う。

- nvm / Volta / fnm: node 専用ディレクトリなので実害小 (`node` `npm` `npx` `corepack` のみ)
- `/usr/local/bin/node` 構成: **`/usr/local/bin` 全体** が読める。ローカルの各種ツールバイナリが露出

`nodeBin` は `realpathSync(process.execPath)` (`:1824`, `:2063`) なので解決済みパス。**修正案:** node ファイル単体 (read + exec の literal) + `ancestorExactRegexes` の祖先だけに絞る。

### #5 — sysctl 許可リストの prefix

`sandbox-seatbelt.js:332-348`:

```js
`(allow sysctl-read ${[
  ...
  '(sysctl-name-prefix "hw.")',
  ...
  '(sysctl-name-prefix "kern.os")',
  ...
```

コメント (`:294-296`) は「verified on macOS 14 hardware: a sandboxed read of kern.bootargs / kern.osvariant_status / hw.ephemeral_storage is refused」と主張。

SBPL の `sysctl-name-prefix` は通常の文字列 prefix マッチ (component 単位ではない)。従って:

- `hw.ephemeral_storage` → `(sysctl-name-prefix "hw.")` にマッチ → **許可される** (コメントと矛盾)
- `kern.osvariant_status` → `(sysctl-name-prefix "kern.os")` にマッチ → **許可される** (コメントと矛盾)
- `kern.bootargs` → allow リストのどれにもマッチしない → `(deny default)` で拒否 (コメント正しい)

`f88e089` の検証は `kern.bootargs` で行われ、他 2 つはコメント/docs-site (`sandbox/overview.md`) で一般化されて記載された可能性が高い。値自体は低機微 (VM/CI 検出程度で、認証情報ではない) なので実害は小。

**修正案:** prefix を狭める (`kern.os` → 具体名の列挙、`hw.` → 必要な `hw.*` の列挙 or `hw.ephemeral_storage` を明示 deny) か、コメント / docs-site の「拒否確認済み」記述を `kern.bootargs` のみに限定する。要実機確認。

### #9 / #12 — overlay 所有権と retire-first の順序

`stillReferenced` スキャン (「他の生存セッションの `seatbeltFiles` にこのファイルが載っていれば unlink しない」) が 4 箇所にコピペ:

- `ptyStore.js:162-172` (spawn 失敗時)
- `ptyStore.js:345-353` (通常 teardown, `other === entry` 除外あり)
- `sessionManager.js:1216-1227` (spawn 失敗時)
- `sessionManager.js:2300-2310` (`destroySession`, `other === session` 除外あり)

`buildSeatbeltLaunch` は overlay を `projectDir` に materialize する際、既存なら `preExisting = true` として `ruleCopies` に **加えない** (`sandbox-seatbelt.js:1013`, `:1022`)。よって既に overlay が存在する状態で起動した兄弟セッションは、自分の `seatbeltFiles` に overlay を記録しない → `stillReferenced` から見えない → 所有側セッション終了時に overlay が unlink され、兄弟が実行中のままルールファイルを失う。

retire-first (`sessionManager.js:1831-1838` の fireSchedule、`routes/groups.js:454` の orchestrator 再起動) は fire-and-forget。RemotePty の `kill()` / `destroy()` は pty-host への非同期 RPC (`sessionManager.js:2794-2796` のコメント参照)。その直後に `await createSession`。

- 単一 UDS 接続で `destroy` → `spawn` が順序内処理されるなら問題ない (predecessor の unlink が先、successor は `preExisting=false` で所有)
- **送信の間に UDS 断 → 再接続が挟まると** `destroy` が失われ、predecessor が pty-host 側に残る → successor は `preExisting=true` で未所有 → 後で predecessor が idle/exit で reap された時に overlay を消される

セキュリティレビュー H (PR で「一部対応」= spawn-catch 版に ownership ガード追加のみ、単一ヘルパ化は未実施) と同根。

**修正案:** `releaseSeatbeltOverlay(files, owners, { exclude })` 的な単一ヘルパへ集約 + 所有権を「exact セッション」ではなく「group + role」の refcount にする。retire は destroy の ack を待ってから spawn する。

### 軽微

- **#2** (`sandbox.js:1797` `buildMinimalSeatbeltSpawn`): `resolve(cwd) === '/'` ガードは `buildSandboxSpawn:1942` のみ。共有プリミティブ `buildSeatbeltLaunch` (`:552` は `projectDir = resolve(cwd)` のみ) に移すと堅牢。呼び出し元 (`usage.js:72` `USAGE_CWD`、`codexUsage.js:31` `CODEX_USAGE_CWD`) は固定の非 root ディレクトリなので現状は実害なし。
- **#6** (`sandbox-seatbelt.js:572` `shEscapeWord`): 許可リスト外の全文字をバックスラッシュエスケープ。改行 `\n` → `\<NL>` は `sh -c` の bare-word context で行継続として除去される。唯一の呼び出し (`:761` `shEscapeWord(credHelperShim)`) は内部生成パス (`join(binDir, ...)`) なので改行は入らず到達不可能。コメント追記か、改行を含む値で throw する程度で十分。
- **#7**: blocked 認証情報パスが `sandbox.js:1616` `BLOCKED_BIND_PATHS`、`sandbox-seatbelt.js:1034` `BLOCKED`、`sandbox-seatbelt.js:937-938` の 3 箇所。app config dir が `sandbox.js:1411` `appBinds` と `sandbox-seatbelt.js:817` `appConfigDirs` の 2 箇所。共有定数化して single source of truth に。
- **#8**: `buildSeatbeltLaunch` が同じアンカーパスを `subtrees()` / `pathVariants()` 経由で複数回 `realpathSync` / `existsSync`。1 起動あたり 20〜30 回程度の避けられるブロッキング syscall。メモ化で解消。正確性の問題ではない。
- **#11** (`sessionManager.js:623`): `if (cwd === '/' && (!shell || sandbox || cfg.forceSandbox))` は生の `sandbox` フラグで発火。`sandboxAvailable() === false` の環境で `{shell:true, cwd:'/', sandbox:true}` が来ると、実際にはサンドボックスが構築されないのに「the sandbox would grant the whole filesystem」というメッセージで拒否される。拒否自体は PR #135 のポリシー (利用不可な明示 sandbox 要求は refuse) と整合、メッセージのみ不正確。
- **L2** (`sandbox.js:1069` `discoverSshAuthSock`): `/tmp/ssh-*/agent.*` と `$XDG_RUNTIME_DIR/*` (Linux 規約) のみスキャン。macOS の 1Password (`~/Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock`)、Secretive、launchd (`/private/tmp/com.apple.launchd.*/Listeners`) が無い。`process.env.SSH_AUTH_SOCK` は候補に含む (`:1096`) ので、その env が立っている起動なら動く。`env.SSH_AUTH_SOCK` の明示指定で回避可 (`:1956`)。ssh-agent 転送は既定オフなので優先度低。

---

## 要実機確認 (macOS + `/usr/bin/sandbox-exec`)

サンドボックス shell セッションを起動して以下を実行する。`RUNTIME=/tmp/ccserver-runtime-$(id -u)`、`REALHOME` は実ユーザーのホーム。

### #1 (最優先) — control ソケットへの到達

```sh
# combo グループを 1 つ以上起動した状態で、worker セッションのサンドボックスから
ls -la "$RUNTIME"/          # 他グループの ccserver-mcp-*-control.d が見えるか
echo "$CCSANDBOX_MCP_SOCK"  # 自分の handoff ソケットのフルパス (groupId が取れる)

python3 - "$RUNTIME/ccserver-mcp-<他グループのgroupId>-control.d/sock" <<'EOF'
import socket, sys
s = socket.socket(socket.AF_UNIX); s.connect(sys.argv[1])
s.sendall(b'{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"x","version":"0"}}}\n')
print(s.recv(4096))
s.sendall(b'{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n')
print(s.recv(8192))
EOF
```

`initialize` に応答が返れば #1 は実証。`tools/list` に control ツールが並ぶか、さらに `send_input` が他セッションに通るかまで見られると完全。

### #3 — 実ホーム列挙

```sh
ls -la "$REALHOME"          # 直下エントリが列挙できてしまうか (できたら指摘どおり)
cat "$REALHOME/.zshrc"      # Operation not permitted になるべき (中身は読めない想定)
```

### #4 — node bin ディレクトリ

```sh
NB=$(readlink -f "$(command -v node)"); ls -la "$(dirname "$NB")"
```

### #5 — sysctl

```sh
sysctl hw.ephemeral_storage kern.osvariant_status kern.bootargs kern.osversion machdep.cpu.brand_string 2>&1
```

`hw.ephemeral_storage` と `kern.osvariant_status` が値を返したら、`sandbox-seatbelt.js:294-296` のコメントと `docs-site/.../sandbox/overview.md` の記述を要修正。

### #13 — `/usage` キャプチャのタイミング

`forceSandbox:true` で `GET /api/usage?app=claude&force=1` を実行し、

- 応答までの秒数 (毎回 ~30s なら指摘どおり)
- サーバーログの `[usage] capture timed out ... sentUsage=... resends=...` の有無と値

### #9 / #12

orchestrator 再起動中に pty-host の UDS を切断する必要があり、通常操作での再現は困難。コード上のレースとして対応判断すれば十分。

---

## 対応方針 (提案)

1. **#1 / L1** を最優先: mcpBroker への接続トークン認証 (git-broker と同じ仕組み)。notify / usage / reviewer も同時に。
2. **#10** (コメント修正) と **#13** (`/usage` リトライ) は小さく確実な修正。
3. **#3 #4 #5** は seatbelt プロファイルの絞り込み + exec テスト追加。
4. **#9 / #12** は overlay 所有権ヘルパの集約 (セキュリティレビュー H の残作業と合わせて)。
5. **#2 #6 #7 #8 #11 L2** はまとめて cleanup コミット 1 本で。
