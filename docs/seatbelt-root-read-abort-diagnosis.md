# macOS Seatbelt: `/Users/...` cwd で shell が即 exit する問題の診断記録

- 日付: 2026-09-08
- 環境: macOS 14.8.5 (23J423), Mac mini M1
- 対象: `feat/sandbox-seatbelt-macos`（HEAD `0586ad9` 時点の診断スクリプト `scripts/seatbelt-diagnose.mjs` で再現）
- 症状: Terminal(shell) を `/Users/ast/Dev`（symlink → `/Volumes/External SSD/Users/ast/Dev`）等で起動すると即 `[Process exited with code 0]` で終了。`cwd=/` では起動する。

## TL;DR

**根本原因: Seatbelt はプロセス起動時に `/` 自体への file-read を要求するが、生成プロファイルはサブツリー（`^/usr/...` 等）のみ許可し `/` 自体（`(literal "/")`）を許可していなかった。**

- `(allow file-read* (literal "/"))` を1行足すだけで解消する。
- abort（exit 134 / SIGABRT）は **SBPL コンパイルエラーではなく「子プロセスの起動時 kill」** であり、`sandbox-exec` がそれを abort に変換する。UI はこれを `code 0` と報告していた（pty 層の exitCode 報告）。
- `cwd=/` で動いていたのは偶然: project ルール `subtrees('/')` が `^/(/.*)?$` となり **サンドボックスが実質全開（fail-open）** になっていたため。この fail-open も別途修正が必要。

## 再現・診断の経緯

### 初期観察

| cwd | 結果 |
|---|---|
| `/` | shell 起動する |
| `/Users/ast/Dev` | 即 exit（UI 上は code 0） |

- サーバーログ: `pty exited code=0`（spawn 失敗や SIGKILL ではなく正常 spawn 後の即 exit に見える）→ 誤解の原因
- `$SHELL=zsh`・`ls /Users/ast/Dev`（権限）・`PTY_HOST=[]` は正常 → 実行時要因はほぼ除外
- repo 実体はスペース入りの外付け SSD パス `/Volumes/External SSD/Users/ast/Dev`（`/Users/ast/Dev` は symlink）→ 当初スペース入り regex を疑ったが無関係

### 診断スクリプト

`node scripts/seatbelt-diagnose.mjs /Users/ast/Dev`（repo root から実行する必要がある。`/Users/ast/Dev` からは相対パス解決で MODULE_NOT_FOUND になる——途中これで stale ファイルを使い回し、数回の誤診を生んだ）

生成物:

- `/tmp/ccserver-seatbelt-diag/profile-root.sb`（cwd=`/` 用。正常コンパイル＆実行）
- `/tmp/ccserver-seatbelt-diag/profile-fails.sb`（cwd=`/Users/ast/Dev` 用。abort 再現）

プロファイル差分は cwd 由来ルール（project の read/write 2行 ×2綴り）＋per-launch UUID のみで、**プロファイル内容自体は文法的に正常**だった。

### 切り分け実験（時系列）

| # | テスト | 結果 | 判定 |
|---|---|---|---|
| 1 | baseline `(allow default)` | exit 0 | sandbox-exec 自体は健全 |
| 2 | root プロファイル全体 | exit 0 | 正常 |
| 3 | fails プロファイル全体 | abort(134) | 再現 |
| 4 | 単独 regex ルール（スペース有無・literal） | exit 71（exec deny） | 単独行は全てコンパイル可・無罪 |
| 5 | project トークン4つ除去（noproj） | abort | project ルール無罪（※初期は stale ファイルで誤測定あり） |
| 6 | `(allow signal (target same-sandbox))` 単体 | exit 0 | `same-sandbox` 無罪（macOS 14.8.5 で対応確認） |
| 7 | 前半23行（共通行）のみ | abort | 「前半のみで abort」に見えた→ 後述の通り原因別 |
| 8 | 前半＋`subpath` 足し戻し（TOPR） | abort | |
| 9 | root から `^/` 2トークン除去（root-noroot） | **abort** | `^/` の有無が相関 |
| 10 | 継承 cwd を `/`・`/tmp`・`/Users/ast/Dev` に変えて fails | 全て abort | cwd 無関係・内容のみの問題 |
| 11 | root-noroot に `/private`・`/Volumes`・`/Users` read や `file-read-metadata ^/` を足し戻し | 全て abort | サブツリー系では救済されない |
| 12 | root-noroot に `/private`・`/var` **write** 足し戻し | abort | dyld write 説棄却 |
| 13 | ダブルスペース正規化 | abort | パーサ問題棄却 |
| 14 | root-noroot に read-`^/`（`(regex #"^/(/.*)?$")`）戻し | **exit 0** | 救済は read の `/` 系 |
| 15 | root-noroot に `(allow file-read* (literal "/"))` のみ | **exit 0** | **犯人確定: `/` 自体の DATA 読み** |

テスト 7「前半23行のみ abort」は最終的に、abort が「exec 許可あり＋起動時クリティカルパス（ここでは `/` read）が deny」の**組み合わせ要因**であることで説明される。exec を許可しないプロファイル（テスト4）では clean な `execvp() ... Operation not permitted`（exit 71）になる。

## 検証済みの行動パターン（統一説明）

| 条件 | 結果 | 例 |
|---|---|---|
| exec 許可＋`/` read あり | 起動する | root・hybrid・t-rootliteral |
| exec 許可＋`/` read なし | **abort（起動時 kill）** | fails・noproj・root-noroot・前半23行 |
| exec 不許可 | clean deny（exit 71） | T1/T2/T4・後半半分 |

## 調査中の誤診と教訓

1. **stale ファイル問題**: diag スクリプトの再実行に失敗したまま（`MODULE_NOT_FOUND` を stderr で隠したため気づかず）古いファイルで検証し、`removed: 76 rules` 等の謎の結果が出た。→ **検証のたびに生成の成否と verify count を必ず確認する**。stderr を隠さない。
2. **「code 0」の誤解**: kill（シグナル死）でも pty 層が exitCode 0 を報告しうる。サーバーログの `pty exited code=0` は「正常終了」を意味しない。
3. **abort = コンパイル失敗という先入観**: SBPL は文法的に正常でも起動時 kill を abort に変換する。abort は sandboxd ログに残らない場合がある（今回は `log stream` の predicate でも捕捉できず）。
4. **スペース入りパスは無関係**: `/Volumes/External SSD` のスペースは SBPL regex でも問題にならない（単独でコンパイル可）。

## 修正方針（Phase 2）

1. **本修正**: `server/ws/sandbox-seatbelt.js` の system allow 群に `(allow file-read* (literal "/"))` を追加。露出は `/` の readdir のみで、中身の読み取りは各サブツリーの allow/deny に従う。
2. **cwd=`/` の fail-open 修正**: `subtrees('/')` が `^/(/.*)?$`（実質全開）になるのを拒否する（shell＋sandbox の組み合わせで `/` を拒否、fail-closed 方針）。
3. **回帰テスト**（`server/ws/sandbox-seatbelt.test.js`）:
   - 生成プロファイルに `(allow file-read* (literal "/"))` が含まれること
   - `cwd=/` での seatbelt launch が拒否されること
4. **診断スクリプト**: `scripts/seatbelt-diagnose.mjs` の `new URL(...).pathname` → `fileURLToPath`（`/Volumes/External%20SSD/...` の `%20` アーティファクト修正）。
5. **実機検証**: Mac 上で `/Users/...` cwd の Terminal 起動を確認する（診断者側）。
