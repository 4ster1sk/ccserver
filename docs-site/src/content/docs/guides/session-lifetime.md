---
title: セッションの寿命
description: セッションが破棄されるまでの時間と終了理由の調べ方
---

## セッションの寿命

**どの端末からも接続されていない**状態が一定時間続くと、セッションは破棄されます (PTY を kill)。既定は 12 時間です。

PTY が既に終了しているセッションは、終了コードを後から確認できるよう別枠で 5 分間だけ残ります。

いずれも環境変数で変更できます。

| 環境変数 | 既定 | 説明 |
|----------|------|------|
| `CCSERVER_SESSION_TIMEOUT_MS` | `43200000` (12時間) | 接続ゼロのセッションを破棄するまでの時間。`0` 以下で**破棄しない** (明示的な終了操作か PTY 自身の終了まで生き続ける) |
| `CCSERVER_SESSION_EXITED_TIMEOUT_MS` | `300000` (5分) | PTY 終了後にセッションを保持する時間。プロセスが既に無いため無効化はできず、`0` 以下を指定しても 1 秒にクランプされます |

systemd で常駐させている場合はユニットファイルに書きます ([systemd でバックグラウンド実行](/ccserver/deployment/systemd/))。

```ini
# 例: 接続が無くてもセッションを維持し続ける
Environment=CCSERVER_SESSION_TIMEOUT_MS=0
```

数値として解釈できない値を指定した場合は、警告をログに出したうえで既定値を使います (タイプミスで破棄が無効化される事故を防ぐため)。

上限は `2147483647` (約24.8日) です。これは Node の `setTimeout` が扱える最大値で、これを超える値を指定すると警告を出したうえで上限にクランプします。**「破棄させたくない」という意図で巨大な値を指定しないでください** — その用途には `0` を使います (`setTimeout` は上限超えの遅延を黙って 1ms として扱うため、クランプが無ければ意図と正反対の即時破棄になります)。

## 接続の扱い

1 つのセッションに接続できるクライアントは常に 1 つだけです。後から同じセッションに接続した端末が既存の接続を引き継ぎ、引き継がれた側のターミナルには「Session taken over by another client」と表示されます。

## セッションの終了理由を調べる

セッションの PTY 終了・破棄はログに記録されます。「気づいたらセッションが終わっていて resume が必要になった」場合は、まずここを確認してください。

```bash
journalctl --user -u ccserver | grep '\[session\]'
```

```
[session] <id> pty exited (code=1, signal=none, app=claude, cwd=/srv/proj, connected=false, uptime=3600000ms)
[session] <id> client detached; destroying in 43200000ms
[session] <id> destroyed (reason=idle-timeout, app=claude, cwd=/srv/proj, uptime=10800000ms, ptyExited=false, connected=false)
```

`pty exited` があれば、セッションを終わらせたのは ccserver ではなく**起動していた CLI 自身**です (`code` が終了コード)。`destroyed` の `reason` は、どの経路がセッションを片付けたかを示します。

| reason | 意味 |
|--------|------|
| `idle-timeout` | 接続ゼロのまま `CCSERVER_SESSION_TIMEOUT_MS` を超過 |
| `exited-timeout` | PTY 終了後、`CCSERVER_SESSION_EXITED_TIMEOUT_MS` を超過 |
| `request` | UI / REST API からの明示的な終了 |
| `shutdown` | サーバー停止 (`systemctl restart` を含む) |
| `reviewer` | [コードレビュー](/ccserver/guides/reviewer/)ジョブの後片付け |

`shutdown` が並んでいる場合はサーバー自身が再起動しています。`systemctl status ccserver` の `NRestarts` と `journalctl -u ccserver | grep Started` で、手動再起動かクラッシュ由来かを切り分けられます。
