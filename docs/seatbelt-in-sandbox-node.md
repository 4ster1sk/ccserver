# サンドボックス内 nvm/node 導入メモ（macOS seatbelt）

- 日付: 2026-09-09
- 対象: macOS seatbelt サンドボックス内セッション（例: `/Volumes/External SSD/...` 配下のプロジェクト）
- 前提: ホストパス流し込み・自動インストール機構は作らない。初回のみ手動導入し、永続 HOME 再利用で使い回す。

## 根本原因（修正済み）

seatbelt プロファイルが許可 subtree の**親ディレクトリ**（`/Volumes`・`/Users`・`/private` 等）の `lstat`（`file-read-metadata` 相当）を許可していなかった。`/` 自体の literal 許可のみ。Node 系ツールは解決時に必ず `realpath` するため、配置場所（project 配下・HOME 配下）によらず `EPERM` で死ぬ。`mkdir -p` も親の `stat` で死ぬ。

修正: `ancestorExactRegexes()`（`server/ws/sandbox-seatbelt.js`）が `projectDir`・`effectiveHome`・launch `dir`・`tmpDirs`・`nodeBin` の祖先を `/` 直前まで列挙し、exact-match（`^<parent>$`、subtree 化しない）で `allow file-read*` に追加。raw 綴り＋ realpath 綴りの両方。兄弟ディレクトリの中身は開かない。

## 検証済みの症状（修正前の記録）

| 実行 | 結果 |
|---|---|
| `vite build`（`minify: terser`） | `[commonjs--resolver] EPERM realpath '.../client/index.html'` |
| `node --check`、`node --test` | `EPERM lstat '/Volumes'`（`realpathSync` 経由） |
| `fs.readFileSync` / `stat`（相対） | 成功 |
| `fs.realpathSync(...)`（project 内・HOME 内） | `EPERM lstat '/Users'` 等、`/tmp` は `EPERM lstat '/private'` |
| 存在済み dir への `mkdir -p` | `mkdir: /Users: Operation not permitted`（exit 1） |
| `git clone nvm-sh/nvm` | git broker の allowlist で拒否 |

## 初回のみの手動導入手順（サンドボックス内、永続 HOME に残置）

方針: ホスト `~/.nvm` は公開せず、サンドボックス HOME 配下 `$HOME/.nvm` に入れる。

1. `mkdir` は単発で（`-p` 不可）。`"$HOME/.nvm"`、`versions`、`versions/node`、`.cache` を順に作成。
2. `install.sh` 不使用。以下を curl 直取得（`git clone` は broker が拒否する）:
   `https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/{nvm.sh,nvm-exec,bash_completion}`
3. `nvm install 22.13.1` は tarball 取得・checksum までは成功するが内部 `mkdir -p` で展開失敗するため、キャッシュ済み `node-v22.13.1-darwin-arm64.tar.xz` を手展開:
   `tar -xzf --strip-components=1 -C versions/node/v22.13.1`
4. 利用（bash）:
   `export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 22.13.1`

確認済み動作: `nvm --version`（0.40.3）、`nvm use`、`node -e`（v22.13.1）。`touch`・単発 `mkdir`・`tar` 展開・curl 取得は許可内。

## zsh 利用時の注意

zsh 上の `source` では `nvm` 関数が見えない（`nvm not found`）ことがある。bash では動作する。zsh で使う場合は rc への source 行追加が別途必要。

## 実機検証コマンド（プロファイル修正の pull 後）

```bash
# realpath が通ること（サンドボックス内）
/Users/ast/.nvm/versions/node/v22.13.1/bin/node --preserve-symlinks -e \
  "const fs=require('fs'); try{console.log(fs.realpathSync('package.json'))}catch(e){console.log('FAIL',e.code,e.path)}"
# in-sandbox nvm（bash）
/bin/bash -c 'export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 22.13.1; node -v'
# 通れば: node --check、npm -v（in-sandbox nvm 経由）、vite build 小規模試行
```

## 残置物（リポジトリ外、参考）

- `$HOME/.nvm`（サンドボックス永続 HOME 配下）: `nvm.sh`・`nvm-exec`・`bash_completion`（v0.40.3）、`versions/node/v22.13.1`（手展開済み）、`.cache/bin/...`（tarball 残存）
- `/tmp/nvm-install.sh`: 取得済みインストーラ（未使用）

## 対象外（対応しない）

- bwrap 側・`sandbox-provision.sh`・`entrypoint` の改修なし。`tools.node` 追加なし。
- ホスト npm の公開（`dirname(nodeBin)` のみ許可で `../lib` が範囲外＋ PATH 不在の複合要因だが、方針上対応不要）。
