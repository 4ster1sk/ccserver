# QEMU サンドボックスと netbroker の実装

qemu バックエンド (`sandbox.config.json` の `"backend": "qemu"`、または起動メニューの
「VM (QEMU)」) の仕組みと、その VM のネットワークを担う Go 製ブローカー
`ccs-netbroker` との連携をまとめた開発者向けメモ。

- ユーザー向けの説明は `README.md`「VM サンドボックス (QEMU) を使う場合」と
  `docs-site/src/content/docs/sandbox/configuration.md` にある。
- 常駐VM (`persistent`) の詳細と残作業は [qemu-persistent-vm.md](qemu-persistent-vm.md)。
- ブローカー本体の仕様 (ポリシー、MITM、DLP、admin API の詳細) は別リポジトリ
  [ccserver-netbroker](https://git.tomadoi.com/4sterisk/ccserver-netbroker) の README。

## 全体像

```
ccserver (Node)
 ├─ ccs-netbroker            セッション (常駐VMなら VM) ごとに1つ。VM のネットワーク全部
 │    ├─ vnet.sock           ← QEMU の NIC (-netdev stream)
 │    ├─ ssh.sock            → ゲストの sshd:22 への中継
 │    ├─ a.sock              admin API (enforce/open、許可リスト、動作モード)
 │    └─ 10.0.2.100:<port>   → ホストのサービスソケット (git broker など)
 └─ node-pty
      └─ sandbox-qemu-launcher.cjs <plan.json>     pty の子 (bwrap の代わりの位置)
           ├─ virtiofsd × 共有の数                 HOME / プロジェクト / rt / エージェント
           ├─ bwrap --die-with-parent -- qemu-system-x86_64   (QEMU 自体を閉じ込める)
           └─ ssh -tt (ProxyCommand: ccs-netbroker pipe ssh.sock)
                └─ ゲスト: cd <cwd> && exec env ... <agent or shell>
```

- VM の外に出る経路はブローカーだけ。QEMU にはホストのネットワークが一切無い
  (slirp も tap も使わない)。
- 隔離のオン/オフは、ブローカーのライブ状態 (`state`: `enforce` / `open`) の切り替え。
  VM の作り直しは要らない。
- bwrap バックエンドにはネットワーク隔離が無い (常に open egress)。seatbelt と
  bwrap 用の旧ネットワークブローカーは撤去済みで、復活させない。

## ファイル

| ファイル | 役割 |
|---|---|
| `server/ws/sandbox-qemu.js` | 計画だけを行う (純粋関数中心)。argv・cloud-init・run ディレクトリを作る。プロセスの寿命は持たない |
| `server/ws/sandbox-qemu-launcher.cjs` | pty の子。virtiofsd と QEMU を起動し、ブート完了を待って `ssh -tt` する。終了時に片付け |
| `server/ws/sandbox-qemu-boot.cjs` | ブート進捗の確認 (シリアルの READY/FAIL、sshd のバナー)。launcher と常駐VMプールで共有 |
| `server/ws/sandbox-qemu-remote.cjs` | ssh のリモートコマンドの組み立てとクォート、ゲストへ転送する env、ゲスト内 bwrap の引数 |
| `server/ws/netbrokerClient.js` | ブローカーの起動・監査ログの中継・admin API クライアント |
| `server/ws/sandbox.js` | `loadSandboxConfig` (`backend` / `qemu` / `network.*`)、`buildQemuSpawn` / `buildPooledQemuSpawn` |
| `server/ws/qemuVmPool.js` / `qemuShares.js` / `qemuQmp.js` | 常駐VM、virtiofs のホットプラグ、QMP クライアント |
| `server/ws/qemuAgents.js` | VM 内で動かすエージェント (claude / opencode / codex) の共有と認証の注入 |
| `server/vmTemplates.js` / `server/routes/vmTemplates.js` | VM テンプレート (リソースと追加 cloud-config)、エージェント認証、常駐VMの設定の API |
| `server/vmAgentCredentials.js` | VM 用エージェント認証情報の保存 (settings DB) |
| `server/routes/vms.js` | 稼働中 VM の一覧と停止 (`GET /api/vms`、`DELETE /api/vms/:sessionId`、`DELETE /api/vm-pool/:vmId`) |
| `server/cli/qemu-image-build.js` | ゴールデンイメージの構築 |
| `server/cli/netbroker-fetch.js` / `server/netbroker.version.json` | ブローカーの取得と版の固定 |
| `client/src/components/VmSection.jsx` / `NetworkIsolationSection.jsx` | 設定画面 (QEMU VM タブ、ネットワーク隔離) |

## ホストの前提 (`qemuStatus`)

`qemuStatus()` が上から順に確認し、最初に引っかかった理由とヒントを返す。
起動メニューの方式選択 (`backendStatus`) と、起動拒否のメッセージに使う。

1. Linux であること
2. `/usr/bin/qemu-system-x86_64` と `/usr/bin/qemu-img`
3. virtiofsd (`/usr/libexec/virtiofsd` か `/usr/lib/qemu/virtiofsd`)
4. `/usr/bin/bwrap` (QEMU 自体を閉じ込めるため)
5. `/dev/kvm` の読み書き。`CCSERVER_QEMU_ALLOW_TCG=1` なら KVM 無しの TCG を許す (テスト用、約10倍遅い)
6. ゴールデンイメージがあること (`images/current.json`)

ブローカーのバイナリが無い場合は `qemuStatus` ではなく、起動時に
`startGoNetworkBroker` が `npm run fetch:netbroker` を促すエラーを投げる。

選んだ方式が使えないとき、別の方式やサンドボックス無しに黙って切り替えない
(`resolveSandboxBackend`)。

## ゴールデンイメージ

`node server/cli/qemu-image-build.js [--force]` で作る。置き場所は
`qemuRoot()` (`~/.local/share/ccserver-sandbox/qemu`、`CCSERVER_SANDBOX_QEMU_ROOT` で変更可)。

1. Debian 13 genericcloud (`BASE_IMAGE`) を `cache/` にダウンロードし、
   Debian の `SHA512SUMS` で検証する。
2. ビルド専用の cloud-init (`buildGoldenUserData`) で1回だけ起動する。
   このときだけ QEMU の `-netdev user` で外に出る。
   - `GOLDEN_PACKAGES` を入れる (git, nodejs, nftables, gnupg, bubblewrap など)。
   - cloud-init のデータソースを NoCloud に絞る。
   - sshd: 鍵は `/etc/ssh/ccserver-keys/%u` (HOME の外。HOME は共有なので自分で
     ssh 許可を足せないようにする)、パスワード認証と root ログインは無効。
   - GRUB とカーネルのログを静かにする (シリアルへの出力は1バイトごとに VM exit になり、
     ブートが数秒遅くなる)。
   - 勝手に通信するタイマー (apt-daily など) を mask する。
   - ホスト鍵と machine-id を消し、シリアルに `CCSERVER-GOLDEN-IMAGE-OK` を出して電源を切る。
3. `qemu-img convert` で `images/golden-<version>.qcow2` に平坦化し、
   `images/current.json` を差し替える。

`version` はベースイメージの SHA512 とビルド用 user-data のハッシュ。レシピを
変えると版が変わるので、古いイメージを黙って使い続けることはない。常駐VMでは
この版も `configDigest` に入る。

## 使い捨て VM の起動の流れ

`buildSandboxSpawn` → (`resolveSandboxBackend === 'qemu'`) → `buildQemuSpawn`。
テンプレートかエージェントが `persistent` なら `buildPooledQemuSpawn` へ分かれる
(常駐VMは [qemu-persistent-vm.md](qemu-persistent-vm.md))。

1. **テンプレートの解決**: `resolveVmTemplate(vmTemplateId)`。削除済み・壊れた
   テンプレートは、ブローカーを起動する前に起動を拒否する。テンプレートが無ければ
   `sandbox.config.json` の `qemu` の値を使う。
2. **使えない機能の警告**: 旧方式の `gpg` (ホストの gpg-agent 転送)、`tools.rtk`、
   `tools.code-review-graph` は VM では使えないので、警告して外す。
3. **エージェントの準備** (`qemuAgentLaunch`): ホストのインストールを読み取り専用で共有する
   場所を決め、認証情報の注入設定 (`inject`) とゲストに渡すプレースホルダを作る。
   注入できない設定ならここで拒否する。`~/.claude.json` を VM 用に整える
   (`prepareVmClaudeJson`)。
4. **ホストサービスの起動**: git broker と commit guard。`buildGuestRuntime` で、
   VM に渡すファイル・リンク・サービス・env を決める (後述)。
5. **ブローカーの起動** (`startGoNetworkBroker`): 必ず `state: 'open'` で起動する。
   許可リストには注入先のホストを足す。ポリシーが不正ならここで起動を拒否する。
6. **計画** (`prepareQemuSession` → `prepareVm`): run ディレクトリを作り、`plan.json` を書く。
7. 失敗したら、それまでに起動したもの (ブローカー、git broker、commit guard) を
   止めて消してから例外を投げる。
8. pty で `node sandbox-qemu-launcher.cjs <plan.json>` を起動する。

### run ディレクトリ

`<qemuRoot>/run/<uuid>/` (0700)。セッション終了で消す。

| パス | 中身 |
|---|---|
| `plan.json` | launcher への指示 (0600) |
| `overlay.qcow2` | ゴールデンイメージを backing にした使い捨ての rootfs (`diskGiB` の疎ファイル) |
| `seed/` | cloud-init NoCloud の `meta-data` / `user-data` / `network-config`。QEMU の vvfat でそのままディスクとして見せる (ISO は作らない) |
| `id_ed25519` | セッションのログイン鍵 |
| `host_ed25519` | ゲストのホスト鍵 (ホスト側で生成して cloud-init で渡す) |
| `admin_ed25519` | ホットプラグ用 `ccs-admin` の鍵 |
| `known_hosts` | `ccs-vm <ホスト鍵>` だけ。`StrictHostKeyChecking=yes` |
| `fs<N>.sock` | virtiofsd のソケット |
| `rt/` | ゲストに読み取り専用で見せる補助ファイル (後述) |
| `home/` | 永続 HOME を使わないときの使い捨て HOME |
| `qmp.sock` / `console.log` / `qemu.log` / `virtiofsd-<N>.log` | QMP、シリアル、ログ |

### launcher (`sandbox-qemu-launcher.cjs`)

1. 共有ごとに virtiofsd を起動し、ソケットを待つ (5秒)。
2. QEMU を起動する (bwrap 経由)。
3. `console.log` を見て `CCSERVER-READY-<token>` を待つ。`CCSERVER-FAIL-<token> <what>` が
   出たらそれを理由に失敗する (FAIL を優先)。上限は `bootTimeoutSec`。
4. ブローカーの `ssh.sock` で sshd のバナー (`SSH-2.0-`) を待つ (15秒)。
5. `ssh -tt` を pty を継承して起動する。ウィンドウサイズとシグナルは ssh が運ぶ。
6. ssh か QEMU が終わるか、SIGTERM/SIGHUP/SIGINT を受けたら、ssh → QEMU
   (SIGTERM、3秒後 SIGKILL) → virtiofsd の順に止めて run ディレクトリを消す。
   rootfs は捨てるので、ゲストのシャットダウンは待たない。

失敗時はシリアルの末尾 25 行をターミナルに出す。

### cloud-init (`buildSessionUserData`)

YAML の代わりに JSON を書く (JSON は YAML として正しく、ユーザー由来の文字列を
自前でクォートしなくて済む)。

- **bootcmd** (1つのシェルスクリプト、順序を固定):
  - ホストと同じ uid/gid のユーザーを作る (virtiofs の所有者を合わせるため)。
    同じ id を持つイメージ側のアカウントは先に消す。uid/gid は passwd ではなく
    実際の `getuid()` / `getegid()` (virtiofsd はその id でしかファイルを作れない)。
  - `ccs-admin` を作る (virtiofs のホットプラグ用。[qemu-persistent-vm.md](qemu-persistent-vm.md) の「ディレクトリの受け渡し」)。
  - virtiofs をマウントする。HOME が先、プロジェクトが後 (プロジェクトは HOME の下にあることが多い)。
  - `cwd` があること、`buildGuestRuntime` のリンクを確認する。
  - テンプレートの bootcmd は ccserver の後に足す。
  - cloud-init の users / mounts モジュールは使わない (順序がリリースで変わり、
    永続 HOME のマウント前に HOME を作ってしまうため)。
- **write_files**: ログイン鍵、`ccs-admin` 関連、ホストサービスの systemd ユニット、テンプレートの分。
- **ssh_keys**: ホスト側で作ったホスト鍵。
- **ca_certs**: ブローカーの MITM CA (有効時)。
- **runcmd**: 1つのスクリプトに、ホストサービスのユニット起動、テンプレートの
  パッケージ導入の確認、テンプレートの runcmd を並べ、最後に READY を出す。
  cloud-init は runcmd の失敗後も先へ進むので、どれかが失敗したら READY に届かない
  ようにしている。
- **timezone**: ホストのタイムゾーン。

`network-config` は静的設定 (DHCP しない): `10.0.2.15/24`、ゲートウェイ `10.0.2.2`、
DNS `10.0.2.3`。

### QEMU の起動引数と閉じ込め

`buildQemuArgs`:

- `q35`、KVM なら `-cpu host`。メモリは `memory-backend-memfd,share=on`
  (vhost-user-fs に必要)。
- rootfs は `cache=unsafe` (捨てるので耐障害性は不要)。seed は vvfat の読み取り専用ディスク。
- NIC は `-netdev stream,addr.type=unix,addr.path=<vnet.sock>` だけ。
- `-device VGA` を付ける (`-nodefaults` で表示アダプタが無いと、Debian のクラウドイメージは
  GRUB の直後に再起動を繰り返す)。表示は `-display none`。
- `-sandbox on,obsolete=deny,elevateprivileges=deny,spawn=deny,resourcecontrol=deny`
  (QEMU がネットワークを持たないので exec は不要)。
- 起動時の共有ごとに `vhost-user-fs-pci`。ホットプラグ用の空の `pcie-root-port` を
  スロット 0x10 から 8 ファンクションずつ並べる (使い捨て VM は 8 本、常駐VMは 32 本)。

`buildQemuConfinement`: QEMU はゲストが触るデバイスを C で解釈するので、乗っ取られた
場合に備えて bwrap に入れる。見えるのは `/usr` (ro)、`/dev/kvm`、ゴールデンイメージ (ro)、
run ディレクトリ、`vnet.sock` だけ。`--unshare-all` と `--die-with-parent` なので、
launcher が SIGKILL されても QEMU は残らない。

### ファイル共有 (virtiofs)

起動時の共有は次のとおり (`prepareVm`)。

| タグ | ホスト | ゲスト | |
|---|---|---|---|
| `home` | 永続 HOME (`persistentHomeDir`)、または `run/<id>/home` | ホストと同じ `$HOME` | rw |
| `proj` | プロジェクト | ホストと同じパス | rw |
| `agent` | エージェントのインストール先 | `/opt/ccs-agent/<app>` | ro |
| `rt` | `run/<id>/rt` | `/ccserver-sandbox` | ro |

virtiofsd は `--sandbox=namespace --cache=auto --announce-submounts` で動かす。
`sandbox.config.json` の `binds` はまだ VM に渡していない。

### ssh

`buildGuestSshArgs`。ホストに TCP ポートは開けない。

- `ProxyCommand=ccs-netbroker pipe <ssh.sock>` で、ブローカーがゲストの 22 番へ中継する。
- `HostKeyAlias=ccs-vm`、`StrictHostKeyChecking=yes`、`-F /dev/null`、
  `IdentityAgent=none`、`ForwardAgent=no`。

リモートコマンドは `sandbox-qemu-remote.cjs` の `buildRemoteCommand` で作る
(`cd <cwd> && exec env K=V ... <argv>`)。ホストの `$SHELL` がイメージに無いシェルの
場合は `bash -l -i` にフォールバックする。

ゲストへ渡す env:

- 静的なもの (`plan.remote.env`): `LANG=C.UTF-8`、ホストサービスの env、
  `sandbox.config.json` の `env`、`GIT_CONFIG_*`、MITM 有効時は CA バンドルの env
  (`NODE_EXTRA_CA_CERTS` / `SSL_CERT_FILE` / `REQUESTS_CA_BUNDLE` / `CURL_CA_BUNDLE`)。
- launcher が実行時に足すもの (`forwardedEnv`): `COLORTERM` / `FORCE_COLOR` / `NO_COLOR` と、
  `CLAUDE_CODE_*` / `CCSERVER_*` / `CCSANDBOX_*`。ただし名前に `TOKEN` / `SECRET` /
  `PASSWORD` / `API_KEY` / `CREDENTIAL` を含むものは送らない。

`GIT_CONFIG_*` は `composeGitConfigEnv` で ccserver の分を先に、運用者の分を後に
番号を振り直す (運用者が値を上書きはできるが、`GIT_CONFIG_COUNT` で ccserver の
`core.hooksPath` などを消すことはできない)。

### ホストサービス (`buildGuestRuntime`)

bwrap では決まったパスにホストのソケットや補助スクリプトを bind している。VM でも
同じパスを作り直し、補助スクリプト (`sandbox-*.cjs`) をそのまま動かす。
ゲストに ccserver のソフトウェアは常駐させない。

- **ソケット**: ブローカーの `services` に登録し、ゲストからは
  `10.0.2.100:<port>` で届く (ネットワークポリシーの対象外)。ゲストでは
  systemd のソケットユニット (`ccs-svc-<name>.socket`) が決まったパスで待ち受け、
  標準の `systemd-socket-proxyd` (DynamicUser) が中継する。

  | name | port | ゲストのパス |
  |---|---|---|
  | `git-broker` | 7001 | `/ccserver-sandbox-git-broker.sock` |
  | `gpg-agent` | 7010 | `/run/ccserver/gnupg-vault/S.gpg-agent` |
  | `gpg-agent-ssh` | 7011 | `/run/ccserver/gnupg-vault/S.gpg-agent.ssh` |
  | `ssh-agent` | 7012 | `/run/ccserver/ssh-agent.sock` (gpgVault が無いときだけ) |
  | `mcp-notify` / `mcp-usage` | 7020 / 7021 | `/ccserver-sandbox-<kind>.d/sock` |

  `services` に入れるのは ccserver 自身のソケットだけ。`sandbox.config.json` 由来の
  ものは入れない。
- **ファイル**: リポジトリのファイルを直接見せず、`run/<id>/rt/` にコピーしてから
  `/ccserver-sandbox` に ro で共有する。bootcmd で決まったパス (`/ccserver-sandbox-*`、
  `/usr/local/bin/gh`、`/usr/local/bin/ssh`) に symlink を張る。git broker のトークンは
  env ではなく 0600 のファイルで渡す (env はホストの ssh のコマンドラインに載り、
  同じユーザーの全プロセスから見えるため)。
- **GPG vault**: 公開情報 (`pubring.kbx` / `trustdb.gpg` / `gpg.conf`) だけを
  `/run/ccserver/gnupg-vault` にコピーし、署名はソケット越しにホストの vault が行う。
  秘密鍵は VM に入らない。

### テンプレートの cloud-config

`validateTemplateCloudConfig` で、トップレベルキーを `packages` / `package_update` /
`package_upgrade` / `apt` / `locale` / `bootcmd` / `write_files` / `runcmd` に限る。
`write_files` で `/etc/ssh/`、`/etc/cloud/`、`/etc/systemd/system/ccs-svc-`、
`/ccserver-sandbox*`、`/run/ccserver/`、`ccs-share` の補助スクリプトと sudoers に書くことは拒否する。
保存時と起動時の両方で検証する。

マージの仕方 (`templateUserDataParts`):

- パッケージ系と `locale` はトップレベルに置き、ccserver のキーを後から重ねる
  (上書きはできない)。
- bootcmd と write_files は ccserver の分の後に足す。
- runcmd とパッケージ導入の確認 (`dpkg-query`) は、READY の前のスクリプトに入れる。
  失敗すると起動失敗になる。

## netbroker (`ccs-netbroker`)

### 配布と取得

- 本体は別リポジトリ (Go)。ccserver には持たず、Gitea の generic package から取得する。
- `server/netbroker.version.json` に `version`・`baseUrl`・アセットごとの `sha256` を固定する。
- `npm run fetch:netbroker` (`server/cli/netbroker-fetch.js`) は
  `ccs-netbroker-<platform>-<goarch>` を `.netbroker/bin/ccs-netbroker` に置く。
  SHA256 が合わなければ失敗する。既に一致していればダウンロードしない。
- 版を上げるときは `version` と `sha256` を書き換えてから取得し直す。
- ローカルビルドを使うときは `CCSERVER_NETBROKER_BIN_DIR` にディレクトリを指定する。
- ネットワーク隔離の新機能はブローカー側に入れる。

### 起動 (`startGoNetworkBroker`)

使い捨て VM はセッションごと、常駐VMは VM ごとに1つ起動する。

1. `hostRuntimeDir()` の下に `ccs-nb-<短いID>/` (0700) を作る。UNIX ソケットの
   パス長制限 (約108バイト) のため、名前を短くしている。
2. `config.json` (0600) を書く。

   ```jsonc
   {
     "session": "<uuid>",
     "mode": "enforce",          // 動作モード: enforce | audit (network.mode)
     "state": "open",            // ライブ状態: enforce | open (🌐 で切り替える)
     "allowedHosts": [...],      // 許可リスト + 注入先のホスト
     "deniedHosts": [...],
     "listen": { "vnet": ".../vnet.sock", "guestSsh": ".../ssh.sock", "admin": ".../a.sock" },
     "services": [{ "name": "git-broker", "addr": "10.0.2.100:7001", "unix": "<host socket>" }],
     "mitm": { "enabled": true, "caCertPath": ".../ca.pem" },
     "rules": ..., "dlp": ..., "inject": [...], "log": ...   // network.* をそのまま
   }
   ```

3. `ccs-netbroker --config <path> --check` を同期で実行し、設定を検証する。
   失敗したら stderr をそのままエラーにして起動を拒否する (fail closed)。
   この後の待機はイベントループを止めるので、先に検証して理由を拾えるようにしている。
4. 本体を起動し、`a.sock` ができるまで最大3秒待つ (`Atomics.wait` で同期的に。
   `buildSandboxSpawn` の呼び出し側の都合)。admin ソケットは最後に bind されるので、
   これがあれば全部の待ち受けができている。
5. MITM が有効なら `ca.pem` を読み、ゲストの `ca_certs` に入れる。

戻り値は `{ proc, dir, vnetSock, guestSshSock, adminSock, caCert, caPem, mode, state }`。

秘密 (注入する認証情報) は設定ファイルに書かない。`inject` の各項目は `valueFromEnv` で
環境変数名だけを指し、値はブローカーのプロセスの env (`brokerEnv`) で渡す。

### 仮想ネットワーク (vnet)

ブローカーが VM のネットワーク全体をユーザーランドで動かす。

| アドレス | |
|---|---|
| `10.0.2.2` | ゲートウェイ (ブローカー) |
| `10.0.2.3` | DNS (ブローカー) |
| `10.0.2.15` | ゲスト (MAC `52:54:00:12:34:56`) |
| `10.0.2.100` | ホストサービス (`services`、ポリシー対象外) |

ゲストが何に接続しても、終端はブローカーになる。ゲストの中でリダイレクトや中継は
していない。

### ポリシーの設定 (`sandbox.config.json` の `network`)

- `allowedHosts` / `deniedHosts` / `mode` は `normalizeNetworkSettings` で解釈する
  (設定画面と共通)。
- `mitm` / `rules` / `dlp` / `inject` / `log` は qemu 専用で、検証せずにそのまま渡す
  (`networkAdvanced`)。検証はブローカーが行い、不正なら起動を拒否する。
- MITM は明示的に `network.mitm.enabled: false` にしない限り有効。無効だとブローカーは
  TLS の SNI しか見られず、同じ CDN 上の許可された SNI を使った domain fronting を
  防げない。rules と DLP も効かない。
- エージェント認証の注入は MITM が必須。無効なら、認証が設定されている起動を拒否する。

### 2つの「モード」

| | 値 | 意味 | 変え方 |
|---|---|---|---|
| `state` (ライブ状態) | `enforce` / `open` | 許可リストを適用するか | セッションの 🌐 ボタン → `POST /mode` |
| `mode` (動作モード) | `enforce` / `audit` | 違反を拒否するか、記録だけか | 設定画面の保存 → `POST /opmode` |

起動時の `state` は常に `open`。

### admin API (`a.sock`、HTTP over UNIX)

| | body | ccserver 側 |
|---|---|---|
| `POST /mode` | `{ "mode": "enforce" \| "open" }` | `setGoBrokerMode` |
| `POST /opmode` | `{ "mode": "enforce" \| "audit" }` | `setGoBrokerOpMode` |
| `POST /allowlist` | `{ "hosts": [...], "deniedHosts": [...] }` | `setGoBrokerLists` |

タイムアウトは3秒で、200 以外は失敗として扱う。

### ライブ制御

- セッションには `networkBrokerAdminSock` / `networkIsolateArmed` / `networkIsolateMode` を持たせる。
  `armed` は起動時に決まり、セッションの間は変わらない。
- 🌐 ボタン: 使い捨て VM は `setSessionBrokerMode`。常駐VMは
  `setPooledVmNetworkMode` → `qemuVmPool.setNetworkMode` で VM 全体に効き、同じ VM の
  全セッションに `network_isolation_state` (`scope: 'vm'`) を送る。
- 設定画面で許可リストや動作モードを保存したとき (`pushNetworkPolicyToArmedSessions`):
  - 使い捨て VM: セッションごとにリストと動作モードを送る。そのとき起動時に足した
    注入先ホスト (`networkExtraAllowedHosts`) は残す。
  - 常駐VM: `qemuVmPool.setListsAll` / `setOpModeAll` で VM ごとに送る。
  - 1つ失敗しても他は続ける。

### 監査ログ

ブローカーの stdout は JSON Lines。`relayAuditLine` が、拒否 (`verdict: deny`)・
DLP の検出・admin 操作・ブローカー自身のイベント・エラーだけを
`[netbroker <session先頭8文字>] ...` としてサーバーログに出す。許可された通信は出さない。
stderr はそのまま流す。

## エージェントと認証情報

詳細は [qemu-persistent-vm.md](qemu-persistent-vm.md) の「エージェントと認証」(使い捨て VM と共通)。
要点だけ書く。

- エージェント本体はイメージに入れず、ホストのインストールを `/opt/ccs-agent/<app>` に
  ro で共有する。HOME そのものや認証情報のディレクトリを含む共有は拒否する。
- ホストの `~/.claude` などの設定ディレクトリは共有しない (VM から hooks を書き換えて
  ホストでコードを動かせないようにする)。
- 秘密は VM に入れない。ゲストにはプレースホルダ (`CLAUDE_CODE_OAUTH_TOKEN` など) を渡し、
  ブローカーの `inject` が API ホストへのリクエストのヘッダを本物に差し替える。
- 注入先のホストは、その起動の許可リストに自動で足す。

## 設定

`sandbox.config.json`:

```jsonc
{
  "backend": "qemu",               // 既定の方式。CCSERVER_SANDBOX_BACKEND が優先
  "qemu": {
    "memoryMiB": 4096,             // 512..262144
    "cpus": 2,                     // 1..64
    "diskGiB": 32,                 // 4..2048 (overlay の上限)
    "bootTimeoutSec": 120,         // 10..1800
    "persistent": false            // 常駐VMで共有する
  },
  "network": {
    "mode": "enforce", "allowedHosts": [], "deniedHosts": [],
    "mitm": {}, "rules": [], "dlp": {}, "inject": [], "log": {}
  }
}
```

範囲外の値は既定値になる (`QEMU_RESOURCE_LIMITS`)。VM テンプレート (settings DB) を選んだ
場合は、`qemu` の値の代わりにテンプレートの値を使う。テンプレートは起動時にしか
読まないので、編集・削除しても稼働中の VM には影響しない。

API (`server/routes/vmTemplates.js`、`server/routes/vms.js`):

- `GET/POST /api/vm-templates`、`PUT/DELETE /api/vm-templates/:id`、`PUT /api/vm-templates-default`
- `PUT /api/vm-agent-auth` (エージェント認証の登録。API は設定済みかどうかだけを返す)
- `PUT /api/vm-pool-settings` (常駐VMのアイドル停止時間)
- `GET /api/vms`、`DELETE /api/vms/:sessionId`、`DELETE /api/vm-pool/:vmId`

## 片付け

- 使い捨て VM: launcher が QEMU と virtiofsd を止めて run ディレクトリを消す。
  `sessionManager` の `releaseSandboxArtifacts` も run ディレクトリ (`qemuRunDir`)、
  ブローカー (`sandboxNetworkBrokerProc` / `Dir`)、git broker、commit guard を片付ける
  (launcher が消し損ねたときの再試行を兼ねる)。
- QEMU は bwrap の `--die-with-parent` の下で動くので、launcher やサーバーが落ちても残らない。
- 常駐VM: セッションの終了ではリースを返すだけ (`qemuPoolLease.release()`)。VM は
  アイドル停止か、graceful shutdown の `qemuVmPool.stopAll()` で止まる。
- サーバーが異常終了すると run ディレクトリが残る。起動時に掃除する処理はまだ無い。

## 環境変数

| 変数 | |
|---|---|
| `CCSERVER_SANDBOX_BACKEND` | 既定の方式 (`qemu` / それ以外は bwrap)。設定ファイルより優先 |
| `CCSERVER_SANDBOX_QEMU_ROOT` | イメージと run ディレクトリの置き場所 |
| `CCSERVER_QEMU_ALLOW_TCG` | KVM 無しでの起動を許す (テスト用) |
| `CCSERVER_NETBROKER_BIN_DIR` | `ccs-netbroker` の置き場所 |
| `CCSERVER_QEMU_POOL_IDLE_SEC` | 常駐VMのアイドル停止時間を秒で上書き (テスト用) |

## テスト

- `server/ws/sandbox-qemu.test.js`: user-data、QEMU 引数、閉じ込め、テンプレート検証、`buildGuestRuntime` などの純粋関数
- `server/ws/sandbox-qemu-spawn.test.js`: `buildQemuSpawn` / `buildPooledQemuSpawn` (ブローカーや計画は差し替え)
- `server/ws/netbrokerClient.test.js`: ブローカーの起動と admin API
- `server/ws/qemuVmPool.test.js` / `qemuShares.test.js` / `qemuAgents.test.js`
- `server/vmTemplates.test.js` / `server/routes/vmTemplates.test.js` / `server/vmAgentCredentials.test.js`

実機での確認には KVM、ゴールデンイメージ、`ccs-netbroker` が要る。
