// サンドボックス起動フラグ (sshAgent / commitSigning / rtk / code-review-graph) の
// グローバル既定値。Settings > 一般から変更でき、localStorage に永続化される。
// ディレクトリ別記憶 (ccserver-sandbox-opts:<path>) が無い場合の
// フォールバックとしてのみ使われ、既存の記憶は上書きしない。

export const SANDBOX_DEFAULT_SSH_AGENT_KEY = 'ccserver-default-sandbox-ssh-agent';
export const SANDBOX_DEFAULT_COMMIT_SIGNING_KEY = 'ccserver-default-sandbox-commit-signing';
export const SANDBOX_DEFAULT_RTK_KEY = 'ccserver-default-sandbox-rtk';
export const SANDBOX_DEFAULT_CRG_KEY = 'ccserver-default-sandbox-code-review-graph';

// すべて既定オフ。ツール導入は初回コスト (ダウンロード・pip) がかかるため
// 明示のオプトインとする。commitSigning (ホスト側でのコミット署名) は
// 起動のたびに承認を求め、署名鍵が未設定だと起動自体が失敗するため既定オフ。
export const SANDBOX_DEFAULTS = {
  sshAgent: false,
  commitSigning: false,
  rtk: false,
  codeReviewGraph: false,
};

function loadFlag(key, defaultValue) {
  try {
    const v = localStorage.getItem(key);
    if (v === null) return defaultValue;
    return v === '1';
  } catch {
    return defaultValue;
  }
}

export function loadSandboxDefaults() {
  return {
    sshAgent: loadFlag(SANDBOX_DEFAULT_SSH_AGENT_KEY, SANDBOX_DEFAULTS.sshAgent),
    commitSigning: loadFlag(SANDBOX_DEFAULT_COMMIT_SIGNING_KEY, SANDBOX_DEFAULTS.commitSigning),
    rtk: loadFlag(SANDBOX_DEFAULT_RTK_KEY, SANDBOX_DEFAULTS.rtk),
    codeReviewGraph: loadFlag(SANDBOX_DEFAULT_CRG_KEY, SANDBOX_DEFAULTS.codeReviewGraph),
  };
}

export function saveSandboxDefaults(next) {
  try {
    localStorage.setItem(SANDBOX_DEFAULT_SSH_AGENT_KEY, next.sshAgent ? '1' : '0');
    localStorage.setItem(SANDBOX_DEFAULT_COMMIT_SIGNING_KEY, next.commitSigning ? '1' : '0');
    localStorage.setItem(SANDBOX_DEFAULT_RTK_KEY, next.rtk ? '1' : '0');
    localStorage.setItem(SANDBOX_DEFAULT_CRG_KEY, next.codeReviewGraph ? '1' : '0');
  } catch {
    // ignore (private mode etc.)
  }
}

// グローバル既定値 (flat) から per-launch sandboxOpts 形状へ変換する。
export function defaultSandboxOpts(defaults = SANDBOX_DEFAULTS) {
  return {
    sshAgent: !!defaults.sshAgent,
    commitSigning: !!defaults.commitSigning,
    tools: {
      rtk: !!defaults.rtk,
      codeReviewGraph: !!defaults.codeReviewGraph,
    },
    // QEMU VM テンプレート (backend "qemu" のみ)。null = サーバー側の既定テンプレート。
    vmTemplateId: null,
    // サンドボックス方式 ('bwrap' | 'qemu')。null = サーバー既定 (sandbox.config.json の backend)。
    backend: null,
  };
}
