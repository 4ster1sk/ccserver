---
title: API
description: 認証、REST API、WebSocket プロトコルのリファレンス
---

## 認証 (任意)

`CCSERVER_AUTH_MODE` 環境変数で `none` (既定、認証なし) / `token` (下記の固定共有トークン) / `passkey` (パスキー + ワンタイムトークン、[認証ガイド](/ccserver/guides/auth/) 参照) を切り替えます。未設定時は `CCSERVER_TOKEN` の有無で `token`/`none` のどちらかに解決されるため、この節で説明する `CCSERVER_TOKEN` 単体での有効化は従来通りそのまま使えます。

`CCSERVER_TOKEN` 環境変数を設定すると、`/api` と `/ws` 配下の全リクエストに Jupyter 風のトークン認証がかかります (未設定なら無効)。`?token=<TOKEN>` クエリか `Authorization: Bearer <TOKEN>` ヘッダのどちらかで通ります。クライアントは 401 を受けると `prompt()` でトークンを聞き、`localStorage` (`ccserver-token`) に保存して以降のリクエストへ自動付与します (`client/src/auth.js`)。

```bash
CCSERVER_TOKEN=some-secret NODE_ENV=production node server/index.js
```

## REST

| メソッド | パス | 説明 |
|---|---|---|
| GET | `/api/dirs?path=<path>&showHidden=1` | 指定パスのサブディレクトリ/ファイル一覧 |
| GET | `/api/dirs/home` | `{ home, browseRoots, initialBrowsePath, defaultApp, availableApps }` — サーバーのホームディレクトリ、許可ルート一覧 ([browseRoots](/ccserver/sandbox/configuration/) 参照、`[]` は無制限)、ブラウジング開始パス、既定起動アプリ、検出済みCLI (`claude`/`opencode`/`codex`)。`sandboxBackends` は方式ごとの可否 (`{ default, bwrap: { ok, reason }, qemu: { ok, reason, hint } }`)、`sandboxAvailable` はどちらかの方式が使えるか |
| POST | `/api/dirs` | `{ parent, name }` でフォルダ作成 |
| GET | `/api/sessions` | 実行中セッションの一覧 |
| DELETE | `/api/sessions/:id` | セッションを終了する (予約プロンプトも解除) |
| GET | `/api/files?path=<path>` | ファイルをダウンロード |
| GET | `/api/files/content?path=<path>` | ファイルブラウザのプレビュー用。`.md` / `.txt` のみ対象で、UTF-8 テキストを JSON (`{ path, name, size, mtime, kind, content, truncated }`) で返す。`kind` は `.md` なら `markdown`、`.txt` なら `text` (レンダリングはクライアント側で DOMPurify を通して行う)。先頭 1 MiB を超える分は切り捨てて `truncated: true`。他の拡張子、および先頭 8 KiB に NUL バイトを含むバイナリは 415 |
| POST | `/api/files` | multipart アップロード (`destination` フィールド + ファイルパート) |
| GET | `/api/system-stats?ipmi=1` | CPU/メモリ/温度/GPU (`nvidia-smi`)/IPMI (要 `ENABLE_IPMI=1`)・load average |
| GET | `/api/usage?force=1` | Claude Code `/usage` のキャッシュ済みスナップショット (`force=1` で即時再取得) |
| GET | `/api/projects` | プロジェクト一覧 (サンドボックス永続 HOME の所属プロジェクト行。`{ id, cwd, pathHash, label, gitRemote, lastSeenAt }`) |
| PUT | `/api/projects/:id/label` | プロジェクト表示ラベル変更 (`{ label }`、null でクリア) |
| POST | `/api/sessions` | 単発セッションをサーバー側で新規起動 (`{ cwd, app?, model?, shell?, sandbox?, sandboxOpts?, resume? }`) |
| GET | `/api/vm-templates` | QEMU VM テンプレート一覧と既定 (`{ templates, defaultTemplateId, fallback, limits, cloudConfigKeys, host, backend, qemu }`)。`fallback` はテンプレート不使用時の `sandbox.config.json` の `qemu` 値 |
| POST | `/api/vm-templates` | テンプレート作成 (`{ name, cpus, memoryMiB, diskGiB, bootTimeoutSec, cloudConfig }`)。範囲外・YAML エラー・許可外キーは 400、名前重複は 409 |
| PUT / DELETE | `/api/vm-templates/:id` | テンプレートの更新 / 削除 (既定だった場合は既定も解除)。存在しなければ 404 |
| PUT | `/api/vm-templates-default` | `{ id }` で既定テンプレートを設定 (`null` で解除) |
| GET | `/api/vms` | 稼働中の qemu VM 一覧 (`{ sessionId, cwd, app, customLabel, templateId, templateName, cpus, memoryMiB, diskGiB, startedAt, diskUsedBytes }`) |
| DELETE | `/api/vms/:sessionId` | その VM を停止する (セッション終了、overlay 破棄)。204、VM が無ければ 404 |
| GET | `/api/approvals?status=pending` | 承認待ち破壊的操作一覧。ブラウザのグローバルバナーが数秒間隔でポーリング |
| POST | `/api/approvals/:id/decision` | `{ decision: 'approved' \| 'rejected' }` で承認待ち操作を承認/却下する。5 分未応答のリクエストはサーバー側で expired (拒否扱い) になる |
| GET | `/api/notify-settings` | 通知ブリッジの設定 (`settings`)、GUI が描画に使う語彙 (`choices`)、このホストで実際に到達可能なチャネル (`channelsAvailable`)、Web Push の公開鍵 (`vapidPublicKey`)、購読中の端末一覧 (`pushSubscriptions`、endpoint は含まない)、可観測カウンタ (`stats`) |
| PUT | `/api/notify-settings` | 通知ブリッジ設定の部分更新。未知のキー・範囲外の数値・未知の app/channel/level は 400 で名指し。設定ファイルが壊れている場合は 500 で内容を保持 |
| POST | `/api/notify-settings/test` | 設定中のチャネルへテスト通知を1件送り、チャネルごとの結果を返す (`{ delivered, channels }`) |
| POST | `/api/push/subscriptions` | PWA 通知の購読登録 (`{ endpoint, keys: { p256dh, auth }, label? }`)。https 必須・私有/ループバックアドレスは拒否。同じ endpoint の再登録は上書き |
| DELETE | `/api/push/subscriptions/:id` | 購読を削除 (その端末には届かなくなる) |
| GET | `/api/auth/mode` | `{ mode: 'none' \| 'token' \| 'passkey' }` — 現在の `CCSERVER_AUTH_MODE`。認証不要 (`token` モードのみ、他の `/api` と同様にトークン必須) |
| GET | `/api/auth/session` | セッション Cookie の有効性確認専用 (200/401 のみが意味を持つ)。`passkey` モード限定 |
| POST | `/api/auth/login-token` | `{ token }` — `node server/cli/issue-login-token.js` が発行したワンタイムトークンを検証し、セッション Cookie を発行する (`passkey` モード限定、use-once)。`--allow-passkey-registration` 付きで発行したトークンなら、そのセッションはパスキーを1つ登録できる |
| POST | `/api/auth/webauthn/stepup-options` / `stepup-verify` | セッションのステップアップ: 登録済みパスキーでのユーザー検証付き認証 (要セッション、`passkey` モード限定)。以後 5 分間、パスキー登録と修正前GPG Vaultの削除が可能になる |
| POST | `/api/auth/webauthn/register-options` / `register-verify` | パスキー登録 (要セッション + 5 分以内のステップアップ、またはトークン由来の登録権限。満たさなければ 403 `PASSKEY_REGISTRATION_NOT_ALLOWED`。[認証ガイド](/ccserver/guides/auth/) フロー2、`passkey` モード限定) |
| POST | `/api/auth/webauthn/authenticate-options` / `authenticate-verify` | パスキー認証 (未ログインで許可、フロー3、`passkey` モード限定) |
| GET | `/api/auth/webauthn/credentials` | 登録済みパスキー一覧 (要セッション、`{ id, label, createdAt, lastUsedAt }[]`、`passkey` モード限定) |

`GET /api/dirs` のレスポンス例:

```json
{
  "current": "/home/user",
  "parent": "/home",
  "dirs": [
    { "name": "projects", "path": "/home/user/projects" }
  ],
  "files": [
    { "name": "notes.txt", "path": "/home/user/notes.txt", "size": 123, "mtime": 1730000000000 }
  ]
}
```

## `WebSocket /ws/terminal`

JSON メッセージでターミナル I/O とセッション管理 (アタッチ・予約プロンプト・自動承認) を中継。

1 セッションにつき同時接続は 1 クライアントまでです。後から `attach` したクライアントが既存の接続 (コード `4001`、`detached` メッセージ付き) を引き継ぎます。PTY のサイズは接続中のクライアントの `cols`/`rows` に追従します。

| 方向 | type | フィールド | 説明 |
|------|------|-----------|------|
| → | `init` | `cwd`, `cols`, `rows`, `claudeSessionId?`, `shell?`, `sandbox?`, `sandboxOpts?`, `app?`, `resume?` | 新規セッションを起動 (`app`: `"claude"` (既定)、`"opencode"`、`shell: true` で素のシェル、`resume: true` で opencode の最終セッションに再開) |
| → | `attach` | `sessionId`, `cols?`, `rows?` | 既存セッションに接続 (出力バッファを `replay` で再送)。既存クライアントがあれば引き継いで切断する |
| → | `input` | `data` | キーボード入力 |
| → | `resize` | `cols`, `rows` | PTY のサイズ変更 |
| → | `ping` | – | 疎通確認 (`pong` が返る) |
| → | `set_auto_yes` / `get_auto_yes` | `enabled?` | 確認プロンプトの自動承認 ON/OFF・状態取得 |
| → | `schedule_prompt` | `time` (`"HH:MM"`) か `at` (epoch ms), `text` | 予約プロンプトを設定 |
| → | `cancel_schedule` / `get_schedule` | – | 予約の解除・現在状態の取得 |
| ← | `session` | `sessionId`, `cwd`, `cols`, `rows`, `isReconnect` | スポーン/接続完了 |
| ← | `detached` | `reason` | 他のクライアントが接続してこの接続が引き継がれた |
| ← | `output` | `data` | ターミナル出力 |
| ← | `replay` | `data` | `attach` 時、切断中に貯まった出力バッファを再送 (複数回届く) |
| ← | `exit` | `exitCode`, `signal`, `claudeSessionId` | プロセス終了 |
| ← | `auto_yes_state` | `enabled`, `log` | 自動承認の状態変化・ログ |
| ← | `schedule_state` | `scheduled`, `serverTz`, `serverNow`, `error?` | 予約プロンプトの現在状態 (サーバー時刻/TZ 付き) |
| ← | `error` | `message`, `code` | エラー通知 (`SESSION_NOT_FOUND` は自動再接続、それ以外はターミナルにメッセージを表示) |
| ← | `pong` | – | `ping` への応答 |
