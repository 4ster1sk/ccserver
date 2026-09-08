# サンドボックス内 nvm/node 導入の調査結果と修正方針

- 日付: 2026-09-09
- 対象: `ccserver_dev`（macOS seatbelt サンドボックス内セッション）
- 目的: 別エージェントへの引き継ぎ。ビルド可否検証と、サンドボックス内への nvm/node 導入実験の記録。

## 1. 環境

- ホスト: macOS 23.6.0 arm64（Mac mini M1）、プロジェクト実体 `/Volumes/External SSD/Users/ast/Dev/ccserver_dev`（`/Users/ast/Dev` は symlink）
- ホスト node: `v22.13.1`（`/Users/ast/.nvm/versions/node/v22.13.1/bin/node`、直接指定のみ実行可。サンドボックス内 `PATH` には含まれない）
- サンドボックス HOME（永続）: `/Users/ast/.local/share/ccserver-sandbox/home/Volumes_External_SSD_Users_ast_Dev_ccserver_dev`
- プロファイル生成: `server/ws/sandbox-seatbelt.js`（deny-by-default、egress は `allow network*` で開放）
- 依存関係: `node_modules/` 195 パッケージあり（workspaces hoist 済み）。`client/dist/` はサンドボックス外の事前ビルド成果物あり。

## 2. 検証結果（結論: 現状サンドボックス内ではビルド不可）

本プロジェクトのビルドは `client: vite build`（`minify: terser`）のみ。サーバーにビルド工程なし。

| 実行 | 結果 |
|---|---|
| `vite.build({root:'client'})`（`--preserve-symlinks -e` 経由） | 失敗: `[commonjs--resolver] EPERM realpath '.../client/index.html'` |
| `node --check server/index.js`、`node --test` | 失敗: `EPERM lstat '/Volumes'`（`realpathSync` 経由） |
| `node -e "fs.readFileSync / stat"` | 成功（相対 open/stat は通る） |
| `node -e "fs.realpathSync(...)"`（project 内・HOME 内いずれも） | 失敗: `EPERM lstat '/Volumes'` または `EPERM lstat '/Users'`、`/tmp` は `EPERM lstat '/private'` |
| ホスト `npm` | 使用不可（`bin/npm -> ../lib/...` の symlink 先が `Operation not permitted`、かつ `PATH` に不在） |

`--preserve-symlinks` 付き `-e` の import までは通るが、vite/rollup 内部の `realpath` で落ちる。`mkdir -p` も親の `lstat` で失敗する（存在済みディレクトリへの `mkdir -p` すら `mkdir: /Users: Operation not permitted` で exit 1）。

## 3. nvm サンドボックス内導入実験（ホストパス流し込みなし）

方針: ホスト `~/.nvm` を公開せず、サンドボックス HOME 配下 `$HOME/.nvm` に入れる。自動プロビジョニングは作らない。

実施済み（サンドボックス内手作業、永続 HOME に残置あり）：

1. `mkdir "$HOME/.nvm"`（単発。`-p` は不可）＋ `versions`、`versions/node`、`.cache` を単発 `mkdir` で作成。
2. `install.sh` 不使用。`https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/{nvm.sh,nvm-exec,bash_completion}` を curl 直取得（git broker が `git clone` を拒否するため。`fatal: could not create leading directories ... Operation not permitted` を確認）。
3. `nvm install 22.13.1` はバイナリ tarball 取得・checksum までは成功するが、内部 `mkdir -p` で展開に失敗。以降ソースビルドにフォールバックして失敗。キャッシュ済み `node-v22.13.1-darwin-arm64.tar.xz`（約25MB）を `tar -xzf --strip-components=1 -C versions/node/v22.13.1` で手展開した。

結果：

- OK: `nvm --version`（`/bin/bash` 経由で 0.40.3）、`nvm use 22.13.1`、`$NVM_DIR/versions/node/v22.13.1/bin/node -e`（v22.13.1）
- NG: `npm -v`（`nvm use` 後は `EPERM lstat '/Users'`。素の PATH では `env: node: No such file or directory`）、`node --check` 等のファイル実行（`EPERM lstat '/Volumes'`）、HOME 内ファイルの `realpath`（`EPERM lstat '/Users'`）
- 副次知見: 同一条件で zsh 上の source では `nvm` 関数が見えず（`nvm not found`）、bash では動作。`touch`・単発 `mkdir`・`tar` 展開・curl 取得自体は許可内。

## 4. 根本原因

- seatbelt プロファイルが許可 subtree の親ディレクトリ（`/Volumes`、`/Users`、`/private` 等）の `lstat`（`file-read-metadata` 相当）を許可していない。`/` 自体の literal 許可のみ。Node 系ツールは解決時に必ず `realpath` するため、配置場所（project 配下・HOME 配下）によらず死ぬ。
- `mkdir -p` も親を `stat` するため同因で死ぬ。`git clone` は git ブローカーの allowlist でホスト外 repo（`nvm-sh/nvm`）が拒否される。
- ホスト npm 不可は `dirname(nodeBin)`（`.../bin`）のみ許可で `../lib` が範囲外＋ `PATH` 不在の複合要因。ただし本件方針ではホスト公開しないため対応不要。

## 5. 修正方針

ホストパス流し込み・自動インストール機構は作らない。前提条件修正のみ行う。

1. `server/ws/sandbox-seatbelt.js`: 許可 subtree（`projectDir`・`effectiveHome`・`dir`・`tmpDirs`・`nodeBin`）の祖先を `/` 直前まで列挙し、exact-match（`^<parent>$`、subtree 化しない）で `allow file-read*` に追加。raw 綴り＋ `pathVariants()` の realpath 綴りの両方。兄弟ディレクトリの中身は開かない。
2. テスト `server/ws/sandbox-seatbelt.test.js`: 親 exact 許可の存在・subtree でないこと・両綴りを assert。実機で `node --check`、`realpathSync`、`npm -v`（in-sandbox nvm 経由）が通ることを確認。
3. bwrap 側・`sandbox-provision.sh`・`entrypoint` の改修なし。`tools.node` 追加なし。
4. 運用: 初回のみ手動導入（本ファイル §3 手順）、以降は永続 HOME 再利用で使い回す。`.node-version` 変更時は手動 `nvm install/use`。zsh 利用時は rc への source 行追加が別途必要。

## 6. 残置物（リポジトリ外）

- `$HOME/.nvm`: `nvm.sh`、`nvm-exec`、`bash_completion`（v0.40.3、curl 取得）、`versions/node/v22.13.1`（手展開済みバイナリ）、`.cache/bin/...`（tarball 残存）。プロファイル修正後にそのまま利用可能。
- `/tmp/nvm-install.sh`: 取得済みインストーラ（未使用、参考用）。

## 7. 再現コマンド例

```bash
# realpath 失敗の確認（サンドボックス内）
/Users/ast/.nvm/versions/node/v22.13.1/bin/node --preserve-symlinks -e \
  "const fs=require('fs'); try{console.log(fs.realpathSync('package.json'))}catch(e){console.log('FAIL',e.code,e.path)}"
# in-sandbox nvm（bash）
/bin/bash -c 'export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 22.13.1; node -v'
```

## 8. 引き継ぎタスク

- [x] 親 exact-match 許可の実装（seatbelt のみ）→ 別エージェントが実装・セッション再起動済み。本ファイル §9 で再検証。
- [x] 単体テスト追加と実機確認（`node --check`、`npm -v`、`vite build` 小規模試行）
- [ ] zsh 用 source 手順の文書化（必要なら。§9 参照: bash では動作確認済み）

## 9. 修正後の再検証（2026-09-09、同一サンドボックス内）

前提条件修正（親 chain の exact-match 許可）が反映されたセッションで再実行。`realpathSync` が project 配下・HOME 配下とも成功するようになった。

- `node --check server/index.js`: 成功（修正前 `EPERM lstat '/Volumes'`）
- in-sandbox npm（`$HOME/.nvm` の node 22.13.1 + `nvm use`）: `npm -v` → 10.9.2（修正前 `EPERM lstat '/Users'`）
- クライアントビルド: `npm run build --workspace=client` 成功（`✓ built in 2.45s`、81 modules）。ただし `node_modules/.bin/vite` が symlink ではなくコピー化（2542 bytes 実体）していたため、そのままでは `ERR_MODULE_NOT_FOUND .../node_modules/dist/node/cli.js` で失敗する。これはサンドボックス無関係の既存の `node_modules` 破損。`node_modules/.bin/vite -> ../vite/bin/vite.js` を張り直して解決（`node_modules` は git 管理外のためリポジトリ変更なし。新規 `npm install` で正規に再生成されるはず）。
- サーバーテスト（`npm run test --workspace=server`、1095 tests）: 起動するようになった。pass 740 / fail 333 / cancelled 9 / skipped 13。
  - seatbelt テストは本検証で2件追加修正し 51 pass / 0 fail / 1 skip（Linux専用skip）になった。修正内容（`server/ws/sandbox-seatbelt.test.js` のみ、profile 本体は不変）:
    1. `mkdtemp` prefix `ccserver-seatbelt-*` → `ccserver-sbtest-*`: セッションの sibling-deny（`^<TMPDIR>/ccserver-seatbelt-`）とテスト自身の一時 dir 名が衝突し `EPERM` になっていた。
    2. symlink 綴り2件の期待値を `realpathSync()` 解決値に変更: macOS では `/var/...` が `/private/var/...` に解決されるため `/var` 綴りのままでは成立しない（Linux では `realpath == 自身` で従来通り。`/tmp` control-socket テストと同方針）。
  - 残り 333 fail は環境依存（`git broker failed to start ... socket not ready`、`bwrap` は macOS 非対応、federation の ports/certs、dockerd lock 等）。純粋ロジック系（usage/db/sessionLimitState: 26 tests）は全 pass。Linux CI を正とする。

## 10. 残置物（リポジトリ外、§6 から変更なし）

- `$HOME/.nvm`: nvm 0.40.3＋node 22.13.1（手展開）。本検証はこれ経由で実行。
- `/tmp/nvm-install.sh`: 参考用。

## 11. 環境不備チェック（2026-09-09、同一サンドボックス内）

- `.bin` 実体化: `node_modules/.bin` 20件中19件がコピー（symlinkは0）。lockfile基準で内容一致を確認の上 symlink 復元（`playwright` のみ提供元2件の競合→元バイトと一致する `../@playwright/test/cli.js` を選択）。その後 `npm install --no-audit --no-fund`（changed 2 packages）で正規化し symlink 22件に回復。`vite`/`terser`/`playwright --version` の実行を確認。`package.json`/`package-lock.json` の変更なし。
- node-pty: prebuilt `darwin-arm64` で spawn 実行可（in-sandbox node・host node とも）。
- 現セッション profile（`$TMPDIR/ccserver-seatbelt-*/sandbox.sb`）: 親 exact 許可（`^/Volumes$` … `^/Users$` … `^/private$` …＋nvm chain）・sibling deny＋re-allow・pin deny ともに想定通り。
- 本番起動: `CCSERVER_DB_PATH=$HOME/smoke.sqlite3 PORT=34561 NODE_ENV=production node server/index.js` で起動、`GET /` → 200、`/api/dirs/home` → 正常JSON。既定 `CCSERVER_DB_PATH`（`server/db.js:33`＝リポジトリの親 `Dev/ccserver.sqlite3`）は sandbox 可視範囲外のため `ERR_SQLITE_ERROR errcode:14` で起動失敗する。`.saved-*.json` 系も同型の既定値（`__dirname/../..`）を持つ。sandbox 内運用では env 上書きが必要。
  - 副次: 起動時 `[db] v2 postApply failed (continuing)`（`$HOME/.local/share/ccserver-sandbox/home/.index.json` の rename ENOENT）。HOME リマップ時の旧 index 移行パス想定漏れ。継続動作するため軽微。
  - `availableApps` は全 false（ホストに agent CLI 未検出）のため shell session のみ起動可。これはホスト実態の反映。
