# 常駐VM (qemu persistent VM) の設計と残作業

qemu バックエンドの「常駐VMで共有する」(VM テンプレートの `persistent`、
テンプレート無しなら `sandbox.config.json` の `qemu.persistent`) の仕組みと、
後回しにした作業の設計メモ。実装は `server/ws/qemuVmPool.js` /
`server/ws/qemuShares.js` / `server/ws/qemuQmp.js` / `server/ws/qemuAgents.js`。
qemu バックエンドと netbroker の全体は [qemu-sandbox.md](qemu-sandbox.md)。

## いまの仕組み

### VM の単位と寿命

- プールキーはテンプレートの id だけ (テンプレートなしの既定設定は1つ)。テンプレートごとに
  VM を1台起動し、そのテンプレートのセッションで共有する。設定を変えても、起動中の VM の横に
  2台目は起動しない。
- 起動中の VM にライブで揃えるもの: 動作モード (`mode`) と `allowedHosts` / `deniedHosts`。
  相乗りする起動は、VM をその起動の値に揃えてから合流する。ブローカーが受け付けなければ
  合流しない。設定画面で保存したときも、全 VM に送る (`setOpModeAll` / `setListsAll`)。
  注入先のホストは、VM ごとに許可リストへ足し続ける。
- 起動時に決まるもの (リソース、cloud-config、advanced、注入する認証情報、ゴールデンイメージの版):
  これらのハッシュ (`configDigest`) が VM と違う起動も、そのまま合流する。そのとき VM に
  `stale` を立て、設定画面の VM 一覧に「設定変更あり」と出す。VM を停止すると、次の起動から
  新しい設定になる。
- 同じキーで同時に起動しても、ブートは1回だけ (`vm.ready` を共有する)。
- 最後のセッションが離れるとアイドルになる。設定画面の「常駐VM」のアイドル停止
  時間 (既定 120 分、settings `qemu.poolIdleStopMinutes`) が経つと停止する。
  - 時間の設定を変えると、アイドル中の VM はアイドルになった時刻から数え直す。
- QEMU は bwrap `--die-with-parent` の下で動くので、サーバーと一緒に終了する。
  graceful shutdown では `qemuVmPool.stopAll()` で run ディレクトリも消す。

### ディレクトリの受け渡し (virtiofs ホットプラグ)

1. ホストのディレクトリごとに virtiofsd を起動する。ソケットは VM の run
   ディレクトリ内に置く (QEMU の bwrap から見えるのはそこだけ)。
2. QMP で `chardev-add` と `device_add vhost-user-fs-pci,bus=<空きroot port>` を行う。
3. ゲストで `mount -t virtiofs` する。

外すときは逆順に umount → `device_del` → `DEVICE_DELETED` 待ち →
`chardev-remove` → virtiofsd 停止。

- 参照カウントはゲストのマウント先 (= ホストパスから作る `/ccs/s/<hash>`) 単位で、
  同じパスへの操作は直列化している。
- ゲストがデバイスを外さない場合は、umount だけで済ませて root port を退役させる。
- q35 のルートバスにはホットプラグできない。そこで空の `pcie-root-port` を
  pcie.0 のスロット 0x10 以降に、1スロット8ファンクションで並べておく。
  - 常駐 VM は 32 本 (1セッションあたりプロジェクトと HOME で2本)。
  - 使い捨て VM は 8 本。
- ゲストの mount と umount は、ホストだけが鍵を持つ `ccs-admin` の ssh から行う。
  - 鍵は sshd でゲストの `ccs-share` に固定されている (`restrict,command=`)。
  - sudo の許可もこの補助スクリプトだけ。
  - 扱えるのはホットプラグしたタグ (`ccshpN`) だけで、起動時の共有は外せない。

### セッションの隔離 (ゲスト内 bwrap)

- セッションごとに ssh を1本張り、ゲストで bwrap を起動する (ランチャーの attach モード)。
- bwrap のルートは、次のものだけで組み立てる。
  - システムのディレクトリ (`/usr` `/etc` `/opt` は読み取り専用)
  - 自分のプロジェクト
  - 自分の HOME
- `/ccs` や、他のセッションの共有は見えない。pid / ipc / uts / cgroup は分ける。
- ゲストのユーザーは全セッションで同じ uid。

### エージェント (claude / opencode / codex) と認証 (使い捨て VM と共通)

実装は `server/ws/qemuAgents.js`。

- **本体**: ゴールデンイメージには入れない。ホストのインストール先を読み取り専用で共有する。
  - 共有先は `/opt/ccs-agent/<app>`。argv[0] はその中の実行ファイルの絶対パスにする。
  - 共有するディレクトリは、実行ファイル (シェルラッパーなら exec 先) の場所で決まる。
    - npm で入れたものは `node_modules` ごと。
    - それ以外は実行ファイルのディレクトリ。末尾が `bin/` ならその親。
    - claude はネイティブ版なら `~/.local/share/claude/versions/` ごと共有する。
      ホストが更新しても、同じ共有のまま次の起動から新しい版が動く。
  - HOME そのものや、認証情報のディレクトリ (`agentConfigDirs`・`~/.ssh` など) を
    含むディレクトリは共有しない。その場合は起動を拒否する。
  - VM 内では自己更新を止める (claude: `DISABLE_AUTOUPDATER`、opencode:
    `OPENCODE_DISABLE_AUTOUPDATE`、codex: `-c check_for_update_on_startup=false`)。
  - 使い捨て VM は起動時の共有、常駐 VM はセッションごとのホットプラグで渡す。
    常駐 VM では同じ版を使うセッション同士で1スロットを共有し、ゲスト内 bwrap が `--ro-bind` する。
- **設定ディレクトリ**: bwrap と違って、ホストの `~/.claude` などは共有しない。
  VM から `settings.json` の hooks を書き換えられると、ホストでコードが動いてしまうため。
  会話履歴や設定は、プロジェクトごとの永続 HOME に VM 側で別に持つ。
- **認証**: 秘密は VM に入れない。
  - ゲストに渡すのはプレースホルダだけ。ブローカーの `inject` が、API ホストへのリクエストで
    本物のヘッダに差し替える (MITM が必須なので、`network.mitm.enabled: false` なら起動を拒否する)。
  - 秘密を持つのはブローカーの子プロセスの env だけ。設定 JSON、VM のプラン、
    cloud-init、ゲストの env には出ない。
  - ランチャーは、名前に TOKEN / SECRET / API_KEY などを含む変数をゲストへ転送しない。
  - 注入先のホストは、その起動の許可リストに自動で足す。設定画面から許可リストを
    ライブで差し替えたときも残す (`networkExtraAllowedHosts`)。
  - 常駐 VM では、注入する値のダイジェストを `configDigest` に入れる。値を変えた後の起動は
    起動中の VM に合流し、VM に「設定変更あり」が付く。新しい値は VM を停止して起動し直すと効く。
  - 保存先は settings DB で、API は設定済みかどうか (opencode はプロバイダ ID の一覧) だけを返す。
    登録は設定画面の「エージェントの認証」から行う。
  - claude: `claude setup-token` の値 (1年有効で、値が変わらない)。
  - opencode: プロバイダ ID ごとの API キー。
    - 接続先とヘッダは起動のたびに決める。まずホストの opencode 設定
      (`~/.config/opencode` の `config.json` / `opencode.json` / `opencode.jsonc` の provider 節) を見て、
      無ければ組み込みの表 (opencode, opencode-go, openrouter, deepseek, anthropic, openai) を使う。
    - ヘッダは npm パッケージで決まる。openai-compatible / openai / openrouter は `Authorization: Bearer`、
      anthropic は `x-api-key`。baseURL は https に限る。
    - 決められないプロバイダのキーは注入しない (警告を出して起動は続ける)。
    - VM の opencode には、そのプロバイダの定義だけを `OPENCODE_CONFIG_CONTENT` で渡す
      (サンドボックス設定の `env` にある同名の変数とはマージする)。apiKey はプレースホルダにし、
      `options.headers` と `{env:...}` / `{file:...}` を含む値は落とす。
    - 同じホストの同じヘッダに別の値を注入することになる場合は、起動を拒否する
      (opencode と opencode-go が同じキーなら 1 つにまとめる)。
    - ダイジェストには、キーに加えて接続先とゲストに渡す定義も入れる。
- **まだ無いもの**:
  - opencode の OAuth 型のプロバイダ (トークンが入れ替わる)。
  - codex。API キー方式は claude と同じ形で入れられる。ChatGPT ログインはトークンが入れ替わるので、
    ブローカーに注入値をライブで差し替える admin API (`POST /inject`) が要る。
    リフレッシュはホスト側 (ccserver) で行い、結果をホストの `auth.json` に書き戻す。
  - claude のサブスクの OAuth (`.credentials.json`) も、同じ仕組みが入れば扱える。

## 常駐 VM では使えないもの (後回し)

いまは次のように扱っている (`buildPooledQemuSpawn`, `server/ws/sandbox.js`)。

| 機能 | いまの扱い |
|---|---|
| git broker / commit guard / コミット署名 | **対応済み**。セッションごとに起動し、セッションの ssh で渡す (下記「1.」) |
| ssh-agent 転送 | 起動しない (警告して起動) |
| MCP ソケット (notify / usage) | 渡さない (警告して起動) |
| セッション中のネットワーク切替 (🌐) | VM 単位で出す。押すと同じ VM の全セッションに効く。後から相乗りしたセッションは、VM の今の状態を引き継ぐ |
| 許可リスト変更のライブ反映 | しない。キーが変わるので、次の起動は新しい VM になる |
| 動作モード (enforce/audit) 変更のライブ反映 | する。設定の保存で全 VM のブローカーへ送る (`qemuVmPool.setOpModeAll`)。相乗りする起動は、VM のモードを自分のモードに合わせてから入り、合わせられなければ起動を拒否する |
| `sandbox.config.json` の `binds` | 未対応 (使い捨て VM でも未対応) |

### 1. セッションごとのホストサービス (実装済み)

使い捨て VM では、ホストのソケットを netbroker の `services` (`10.0.2.100:<port>`) に
登録し、補助ファイルを起動時の rt 共有で渡している。常駐 VM ではセッションが VM の起動後に
来るので、セッションごとに次のように渡す (`buildPooledQemuSpawn` / `qemuVmPool.attach`)。

- **ブローカー**: git broker (コミット署名の中継を含む) と commit guard を、使い捨て VM と
  同じ処理でセッションごとに起動する。戻り値の `gitBrokerProc` / `gitBrokerDir` /
  `commitGuardDir` は既存の後始末がそのまま片付ける。
- **補助ファイル**: `buildGuestRuntime` の結果をセッション専用のホストディレクトリ
  (`<hostRuntimeDir>/ccs-prt-<uuid>`) に書き出し、読み取り専用でホットプラグして、
  そのセッションの bwrap の中だけで `/ccserver-sandbox` に bind する。ほかのセッションの
  bwrap からは見えない。セッションの終了 (lease の release) で消す。チャットモードの
  ブリッジとパスワードも同じディレクトリに入る。
- **ソケット**: セッションの ssh ログインのリモート転送 (`-R <ゲストのパス>:<ホストのソケット>`)
  で渡す。ゲスト側のパスは `/tmp/ccs-svc-<token>-<name>.sock` とセッションごとに一意にし、
  bwrap の中で決まったパス (`/ccserver-sandbox-git-broker.sock`) に bind する。
  一意なので古いソケットを消す必要がなく、sshd の設定変更 (`StreamLocalBindUnlink`) も
  要らない。sshd が作るソケットは `StreamLocalBindMask` の既定 (0177) で本人専用になる。
  転送ソケットができる前に bwrap が走らないよう、リモートコマンドの前段で数秒まで待つ。
- **決まったパスへのリンク**: ルート直下の `/ccserver-sandbox-*` は bwrap の `--symlink`
  でセッションごとに作る。`/usr/local/bin/gh` と `/usr/local/bin/ssh` は `/usr` が
  読み取り専用なので、常駐 VM の起動時に `/ccserver-sandbox/gh-wrapper.cjs` などへの
  固定 symlink を張る (`POOL_FIXED_LINKS`)。git broker の無いセッションや VM の
  ターミナルではリンク先が無く、PATH の検索は `/usr/bin/ssh` に進む。
- **env と git 設定**: `runtime.env` を attach プランの env に入れ、git 設定は
  `composeGitConfigEnv` で ccserver の分を先、VM の env (運用者の分) を後ろに並べる。

**テスト**: `qemuVmPool.test.js` (転送・bind・symlink・env の組み立て)、
`sandbox-qemu-spawn.test.js` (ブローカーの起動、失敗時の後始末、署名)。
実機 E2E (2 セッションが別々のトークンを使い、互いのソケットが見えないこと) は未実施。

### 2. セッション中のネットワーク切替

ブローカーは VM に1つで、ゲストの IP も全セッション共通 (`10.0.2.15`) なので、
セッション単位の enforce/open はブローカー側では区別できない。

- 案A (実装済み): 切替を VM 単位にする。各セッションの右上の 🌐 ボタンで切り替える
  (`setPooledVmNetworkMode`, `sessionManager.js`)。
  - 同じ VM の全セッションに効き、全セッションのボタン表示も変わる。
    ツールチップで、同じ VM の全セッションに効くことを伝える。
  - 後から相乗りしたセッションは、VM の今の状態を引き継ぐ
    (開放中の VM に、隔離で始める起動が入ることもある)。
- 案B: ゲスト内でセッションごとにネットワーク名前空間と veth を作り、送信元で
  ポリシーを分ける。ゲスト側の root 処理とブローカーの対応が要り、重い。
- 許可リストの変更 (`pushNetworkPolicyToArmedSessions`, `sessionManager.js`) は、常駐 VM の
  ブローカーにも流す (実装済み、`qemuVmPool.setListsAll`)。

### 3. その他

- **残骸の掃除**: サーバーが異常終了すると、`~/.local/share/ccserver-sandbox/qemu/run/`
  の下に run ディレクトリが残る (使い捨て VM も同じ)。起動時に、プロセスの居ない
  ものを消す処理を入れる。
- **スロット切れ**: 常駐 VM 1台あたり、約16セッション (プロジェクトと HOME で2スロットずつ)。
  - 同じディレクトリのセッションはスロットを共有する。
  - 使い切ると起動は「no free hot-plug slot」で失敗する。退役したスロットも戻らない。
  - VM を分けるか、使い切った VM を次の起動では避ける仕組みを検討する。
- **`binds` の受け渡し**: `sandbox.config.json` の `binds` を、同じホットプラグと
  bwrap の bind で常駐 VM に渡せる。使い捨て VM にも同じ形で入れられる。
- **同じ uid による制約**: セッション同士は同じ uid で、ネットワーク名前空間も共有する。
  - ファイルとプロセスは bwrap で見えないが、抽象 UNIX ソケットや、ゲストの
    ループバックで待ち受けるポートには届く。
  - VM 単位の隔離と比べると弱いことを、ユーザー向けの説明に書く。
- **ユーザー向けドキュメント**: `docs-site/src/content/docs/sandbox/` に、常駐 VM の
  使い方と制約を足す。
