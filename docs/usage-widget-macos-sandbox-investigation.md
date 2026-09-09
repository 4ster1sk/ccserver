# Usage widget が macOS サンドボックスで取得できない問題の調査記録

- 日付: 2026-09-10
- 症状: macOS + `forceSandbox:true` で Claude Usage タブが `Timed out reading /usage` になる
- 対象: `server/usage.js`（Claude `/usage` スクレイピング）、`server/ws/sandbox.js#buildMinimalSandboxSpawn`、`server/ws/sandbox-seatbelt.js`
- 関連: `a9896e8 fix(seatbelt): persist Claude Code / codex login` の後続調査

## TL;DR

- **根本原因候補の最有力は Keychain シード漏れ**: フル起動は `seedClaudeCredentialsFromHostKeychain(HOME)` を呼ぶが、usage capture 用の minimal 起動は呼んでいない。ホストが Keychain ログインのみ（`~/.claude/.credentials.json` なし）の場合、sandbox 内 claude は未ログイン画面のまま `/usage` に応答せず 30s タイムアウトする。`forceSandbox:true` では unsandboxed フォールバック禁止のため復帰不能。
- **副次バグは `app` 未伝搬**: `buildMinimalSandboxSpawn` は `resolveApp(app)` しつつ `buildSeatbeltLaunch` に `app` を渡していない。現状 `CLAUDE_CONFIG_DIR/CODEX_HOME` は無条件なので Claude は偶然動くが、opencode XDG 分岐等は壊れる。
- opencode Go（`server/opencodeUsage.js`）は HTTPS 直叩きで sandbox 不使用のため本件の対象外。

## 取得経路

```
client/.../useUsage.js
  -> GET /api/usage?app=claude[&force=1]  (server/routes/usage.js)
    -> server/usage.js#getUsage/capture()
```

`capture()` の分岐（`server/usage.js:218-244`）：

1. `sandboxAvailable()`（macOS では `seatbeltAvailable() = existsSync('/usr/bin/sandbox-exec')`）が真なら `buildMinimalSandboxSpawn({ cwd: USAGE_CWD, targetCommand: ['claude','--ax-screen-reader'] })` で sandbox-exec 経由起動
2. 失敗時のみ `forceSandbox` チェック → 直接起動フォールバック（`forceSandbox:true` では禁止してエラー）
3. `node-pty` で `/usage` をタイプし、`looksReady()`（session + weekly の2ブロック + Resets）待ち、最長 `CAPTURE_TIMEOUT_MS=30s` で `Timed out reading /usage`

`Timed out` は「sandbox-exec 自体は起動できたが、中の claude が 30 秒以内に dashboard を描画しなかった」ことを意味する。`forceSandbox` の文言エラーではないため、プロファイル生成・spawn 自体は成功している。

`USAGE_CWD = ~/.local/share/ccserver-sandbox/usage-cwd` は throwaway の空ディレクトリ。初回は trust ゲート（`TRUST_RE`）が出て `y` 応答後に `/usage` を送る。

## フル起動 vs minimal の非対称（本件の核心）

| 項目 | フル起動 `buildSandboxSpawn` macOS 分岐 | minimal `buildMinimalSandboxSpawn` macOS 分岐 |
|---|---|---|
| `ensureHostAgentConfigDirs()` | あり（`sandbox.js:1976`） | あり（`sandbox.js:1761`） |
| `seedClaudeCredentialsFromHostKeychain(HOME)`（`app==='claude'` 時） | あり（`sandbox.js:1982-1984`） | **なし（欠落）** |
| `buildSeatbeltLaunch` への `app` 伝搬 | あり（`app` を渡す） | **なし（`claudeDir` のみ）** |

`seed...` の仕様（`sandbox-seatbelt.js:38-96`）：

- Keychain は Seatbelt 下では到達不可（`~/Library/Keychains` 非 allow、`security` は `errSecNoDefaultKeychain`）。Claude は `<CLAUDE_CONFIG_DIR>/.credentials.json` にフォールバックする
- ホスト側（unsandboxed）で、ファイル不在時のみ Keychain からコピーする。既存ファイルは never overwrite。`ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN` があるときは no-op。失敗は non-fatal
- darwin 以外は即 `return false` のため、minimal 側で無条件呼びしても Linux 挙動は不変

`buildSeatbeltLaunch` の `app` 使用箇所（`sandbox-seatbelt.js:541-555`）：opencode 時のみ XDG 3 変数をホストに向ける。claude/codex の `CLAUDE_CONFIG_DIR / CODEX_HOME` は現状無条件のため、欠落しても Claude は偶然動く。ただし将来分岐のための latent bug。

## 仮説リスト（優先度順）

- H1: Keychain シード漏れ — 最有力。上表の通り。`forceSandbox` なしなら unsandboxed フォールバック（Keychain 到達可）で成功するため「sandbox 環境でのみ失敗」に一致
- H2: `app` 未伝搬 — latent bug。今回の直接原因ではない可能性が高いが同時修正すべき
- H3: バイナリ allow 漏れ — 即時失敗（ENOENT/exec-deny）なら timeout ではなく早期 `onExit` になるはず。症状からは副次的。`installDir` allow（`sandbox.js:677`）は一応ある
- H4: 起動遅延 > 30s — `BOOT_DELAY 3s + TRUST_SETTLE 1.5s + SETTLE 0.9s` に対し seatbelt 初回＋ trust ＋ network リフレッシュで超過の可能性。H1 解消後の残存タイムアウトはこれを疑う
- H5: throwaway HOME の副作用 — minimal は毎回 throwaway HOME のため他キャッシュが cold になり H4 を悪化させる

## 実機なし検証方針（sandbox 環境内・Linux CI）

- `sandbox-seatbelt.exec.test.js` は `darwin + /usr/bin/sandbox-exec` 必須で、それ以外は全 skip。さらに既 sandbox 内シェルからは `sandbox_apply: EPERM` で macOS 上でも skip（`nestedReason`）。実機検証は期待しない
- `buildSeatbeltLaunch` 自体は platform 非依存なので、Linux CI で回る pure テストに寄せる
- `seed...` は非 darwin で no-op のため、呼び出し追加自体は Linux で安全

## 実装のたびにやること（チェックリスト）

1. `node --test server/usage.test.js server/ws/sandbox-seatbelt.test.js server/ws/sandbox-resolve.test.js`（Linux で回る範囲）
2. exec テストは skip 確認のみ：`node --test server/ws/sandbox-seatbelt.exec.test.js` が `requires macOS with /usr/bin/sandbox-exec` で skip されること
3. 生成プロファイルの文字列 asserts：`~/.claude` の read+write allow、`~/Library/Keychains` の非 allow、control-sock deny が minimal プロファイルにも含まれること
4. macOS 実機・CI への持ち越し：`sandbox-seatbelt.exec.test.js` の `failures/*.sb` artifact 確認、`GET /api/usage?force=1` で `sandboxed:true` ＋更新時刻が返ることの確認は実機持ちに依頼

## 修正方針

- A: minimal capture でも `seedClaudeCredentialsFromHostKeychain` を呼ぶ（H1 直撃、影響最小）
- B: `app` を `buildSeatbeltLaunch` へ伝搬（H2、ついで修正）
- C: タイムアウト・リトライ調整やエラー文改善（H4 が残存した場合。`Timed out` に `sandboxed:true` と Keychain ヒント付与等）
- いずれも `forceSandbox:true` のフォールバック禁止は維持する

## 残課題

- codex タブの非回帰確認（codex は `~/.codex/auth.json` ファイルベースのため Keychain 問題なしの見込みだが、H2 の `app` 伝搬後は再確認）
- 初回 Keychain アクセス時の macOS 許可ダイアログ（`ccserver wants to use the Keychain`）の案内文要否
- C 案（タイムアウト値・エラー文改善）は H1/H2 解消後の残存タイムアウト有無を見て判断

## 実装記録（2026-09-10）

- `server/ws/sandbox.js`: minimal の macOS 分岐を `buildMinimalSeatbeltSpawn()` として export 分離（`IS_MACOS` 分岐自体は `buildMinimalSandboxSpawn` に残し、中身は委譲）。 seatbelt 組み立て自体は platform 非依存のため Linux CI で直接検証可能にした
  - `app` を `buildSeatbeltLaunch` へ伝搬（H2 修正）
  - `app==='claude'` 時に `seedClaudeCredentialsFromHostKeychain(HOME)` を呼び出し（H1 修正）。throw しても capture 組み立ては継続（non-fatal）。非 darwin では helper 自体が no-op のため Linux 挙動不変
- `server/ws/sandbox-minimal-seatbelt.test.js`（新規、Linux 可）: `app` 伝搬、`claude` のみ seed／他 app は seed なし、seed throw 時の non-fatal、実 `buildSeatbeltLaunch` との結合（argv 形状）を asserts。4 件 pass
- 非回帰: `sandbox-seatbelt.test.js` 56 pass、`usage.test.js` 12 pass、`sandbox-resolve.test.js` 6 pass を確認。`sandbox-provision/commit-guard/persistent-home` の失敗は本環境（seatbelt 内 sandbox での `EPERM mkdir .../ccserver-seatbelt-*`）による既存失敗で、stash 前後で件数一致（provision 10 fail、commit-guard 4 fail、persistent-home 9 fail）のため本変更の回帰ではない
- 実機持ち越し: `sandbox-seatbelt.exec.test.js` は本環境では skip が正常。macOS CI の `failures/*.sb` artifact と `GET /api/usage?force=1`（`sandboxed:true`）の確認は未実施
