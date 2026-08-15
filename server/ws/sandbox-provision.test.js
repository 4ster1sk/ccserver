// Tool provisioning (rtk / code-review-graph) for sandboxed sessions:
//   - resolveTools merges sandbox.config.json's `tools` (server fallback, off
//     unless enabled there) with the client's per-session sandboxOpts.tools --
//     the launch menu defaults these tools to ON per directory (see
//     DirectoryBrowser), and that choice overrides the fallback. True enables
//     a pinned default spec; the object form can override version/url/sha256.
//   - buildSandboxSpawn, when any tool is enabled, ro-binds the provisioner at
//     /ccserver-sandbox-provision.sh and passes the tool specs via env. With no
//     tool enabled nothing is added.
//
// Isolated via CCSERVER_SANDBOX_CONFIG and CCSERVER_SANDBOX_HOME_ROOT (no real
// bwrap/pty involved -- buildSandboxSpawn only assembles the argv).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { buildSandboxSpawn, buildMinimalSandboxSpawn, resolveTools } from './sandbox.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROVISION_PATH = '/ccserver-sandbox-provision.sh';
const PROVISION_SCRIPT = join(__dirname, 'sandbox-provision.sh');

let cfgPath;
let tmpRoot;

function writeConfig(json) {
  writeFileSync(cfgPath, JSON.stringify(json));
}

before(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'ccserver-provision-'));
  cfgPath = join(tmpRoot, 'sandbox.config.json');
  process.env.CCSERVER_SANDBOX_CONFIG = cfgPath;
  process.env.CCSERVER_SANDBOX_HOME_ROOT = join(tmpRoot, 'home');
});

after(() => {
  delete process.env.CCSERVER_SANDBOX_CONFIG;
  delete process.env.CCSERVER_SANDBOX_HOME_ROOT;
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

// Pull the provision-related env out of a buildSandboxSpawn argv.
function provisionEnv(args) {
  const out = {};
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === '--setenv' && args[i + 1].startsWith('CCSANDBOX_')) {
      out[args[i + 1]] = args[i + 2];
    }
  }
  return out;
}

test('resolveTools defaults to off when the config has no tools', () => {
  writeConfig({ docker: false, gitBroker: false });
  const tools = resolveTools();
  assert.equal(tools.rtk, false);
  assert.equal(tools.codeReviewGraph, false);
  assert.equal(tools.rtkSpec, null);
  assert.equal(tools.crgSpec, null);
});

test('resolveTools: config "rtk": true enables rtk with the pinned default spec', () => {
  writeConfig({ docker: false, gitBroker: false, tools: { rtk: true } });
  const tools = resolveTools();
  assert.equal(tools.rtk, true);
  assert.equal(tools.codeReviewGraph, false);
  assert.ok(tools.rtkSpec.version.length > 0, 'pinned version present');
  assert.ok(tools.rtkSpec.url.startsWith('https://github.com/rtk-ai/rtk/releases/'), 'release URL');
  assert.equal(tools.rtkSpec.sha256.length, 64, 'pinned sha256 present');
});

test('resolveTools: object form overrides version/url/sha256', () => {
  writeConfig({ docker: false, gitBroker: false, tools: { 'code-review-graph': { enabled: true, version: '9.9.9' } } });
  const tools = resolveTools();
  assert.equal(tools.codeReviewGraph, true);
  assert.equal(tools.crgSpec.version, '9.9.9');
});

test('resolveTools: per-session sandboxOpts.tools overrides the config default', () => {
  writeConfig({ docker: false, gitBroker: false, tools: { rtk: false } });
  const tools = resolveTools({ tools: { rtk: true, codeReviewGraph: false } });
  assert.equal(tools.rtk, true, 'session opts turn a config-disabled tool on');
  const off = resolveTools({ tools: { rtk: false } });
  writeConfig({ docker: false, gitBroker: false, tools: { rtk: true } });
  assert.equal(resolveTools({ tools: { rtk: false } }).rtk, false, 'session opts turn a config-enabled tool off');
  assert.equal(off.codeReviewGraph, false);
});

test('buildSandboxSpawn binds the provisioner + sets env when a tool is enabled', () => {
  writeConfig({ docker: false, gitBroker: false, tools: { rtk: true, 'code-review-graph': true } });
  const spawn = buildSandboxSpawn({ cwd: join(tmpRoot, 'proj'), targetCommand: ['claude'], app: 'claude', sandboxOpts: null });
  const args = spawn.args;
  const provisionBind = args.findIndex((v, i) => v === '--ro-bind' && args[i + 1].endsWith('sandbox-provision.sh') && args[i + 2] === PROVISION_PATH);
  assert.ok(provisionBind > 0, 'provisioner ro-bound at the fixed path');
  const env = provisionEnv(args);
  assert.equal(env.CCSANDBOX_PROVISION_RTK, '1');
  assert.equal(env.CCSANDBOX_PROVISION_CRG, '1');
  assert.ok(env.CCSANDBOX_RTK_VERSION.length > 0);
  assert.ok(env.CCSANDBOX_RTK_URL.startsWith('https://'));
  assert.equal(env.CCSANDBOX_CRG_VERSION, '2.3.7');
});

test('buildSandboxSpawn adds no provision bind/env when tools are off', () => {
  writeConfig({ docker: false, gitBroker: false });
  const spawn = buildSandboxSpawn({ cwd: join(tmpRoot, 'proj2'), targetCommand: ['claude'], app: 'claude', sandboxOpts: null });
  assert.ok(!spawn.args.includes(PROVISION_PATH), 'no provisioner bind');
  assert.equal(provisionEnv(spawn.args).CCSANDBOX_PROVISION_RTK, undefined);
});

test('buildSandboxSpawn respects per-session sandboxOpts.tools over the config', () => {
  writeConfig({ docker: false, gitBroker: false });
  const spawn = buildSandboxSpawn({
    cwd: join(tmpRoot, 'proj3'), targetCommand: ['claude'], app: 'claude',
    sandboxOpts: { tools: { rtk: true, codeReviewGraph: false } },
  });
  const env = provisionEnv(spawn.args);
  assert.equal(env.CCSANDBOX_PROVISION_RTK, '1');
  assert.equal(env.CCSANDBOX_PROVISION_CRG, '0');
});

test('buildMinimalSandboxSpawn (usage capture) never provisions tools', () => {
  writeConfig({ docker: false, gitBroker: false, tools: { rtk: true } });
  const spawn = buildMinimalSandboxSpawn({ cwd: join(tmpRoot, 'proj4'), targetCommand: ['claude'] });
  assert.ok(!spawn.args.includes(PROVISION_PATH), 'throwaway sandbox stays lean');
  assert.equal(provisionEnv(spawn.args).CCSANDBOX_PROVISION_RTK, undefined);
});

// ---------------------------------------------------------------------------
// Shell-level tests: run sandbox-provision.sh itself inside a stubbed HOME with
// a fake `python3` on PATH. There is no real venv/bwrap here -- the fake
// python3 materializes the $venv/bin/pip and $venv/bin/code-review-graph shims
// (the latter records its argv to a file and exits 0 / CRG_BUILD_EXIT), so we
// can verify the graph build step, the marker semantics, and the status lines
// the CLI shows while installing.
// ---------------------------------------------------------------------------

// Create a fake `python3` that handles `-m venv <path>` by writing the pip and
// code-review-graph shims the provisioner expects under the venv bin dir.
function makeFakePython3(binDir) {
  mkdirSync(binDir, { recursive: true });
  const py = join(binDir, 'python3');
  writeFileSync(py, `#!/usr/bin/env bash
if [ "$1" = "-m" ] && [ "$2" = "venv" ]; then
  venv="$3"
  mkdir -p "$venv/bin"
  printf '#!/usr/bin/env bash\\nexit 0\\n' > "$venv/bin/pip"
  chmod +x "$venv/bin/pip"
  cat > "$venv/bin/code-review-graph" <<'SHIM'
#!/usr/bin/env bash
echo "$@" >> "\${CRG_BUILD_LOG:-/dev/null}"
exit "\${CRG_BUILD_EXIT:-0}"
SHIM
  chmod +x "$venv/bin/code-review-graph"
  exit 0
fi
echo "fake python3: unknown args: $*" >&2
exit 1
`);
  chmodSync(py, 0o755);
}

function runCrgProvisioner({ home, cwd, buildLog, buildExit = 0 }) {
  const binDir = join(tmpRoot, 'fakebin');
  makeFakePython3(binDir);
  mkdirSync(cwd, { recursive: true });
  return spawnSync('bash', [PROVISION_SCRIPT], {
    cwd,
    env: {
      HOME: home,
      PATH: `${binDir}:${process.env.PATH}`,
      CCSANDBOX_PROVISION_RTK: '0',
      CCSANDBOX_PROVISION_CRG: '1',
      CCSANDBOX_CRG_VERSION: '9.9.9',
      CRG_BUILD_LOG: buildLog,
      CRG_BUILD_EXIT: String(buildExit),
    },
    encoding: 'utf8',
  });
}

function provisionLog(home) {
  return join(home, '.local', 'share', 'ccserver-tools', 'provision.log');
}

test('provisioner runs `code-review-graph build --repo "$PWD"` after install and only marks once both succeed', () => {
  const home = join(tmpRoot, 'crg-home-ok');
  const repo = join(tmpRoot, 'crg-repo-ok');
  const buildLog = join(tmpRoot, 'crg-build-ok.log');
  const marker = join(home, '.local', 'share', 'ccserver-tools', 'markers', 'code-review-graph-9.9.9');
  const res = runCrgProvisioner({ home, cwd: repo, buildLog });

  assert.equal(res.status, 0, `provisioner exited 0 (stderr: ${res.stderr})`);
  const calls = readFileSync(buildLog, 'utf8').trim().split('\n');
  assert.equal(calls.length, 1, 'build invoked exactly once');
  assert.equal(calls[0], `build --repo ${repo} --quiet`);
  assert.ok(existsSync(marker), 'marker written after install + build both succeed');
  assert.match(res.stdout, /code-review-graph をインストール中…/);
  assert.match(res.stdout, /code-review-graph のグラフを構築中…/);
  assert.match(res.stdout, /code-review-graph 導入完了/);
});

test('provisioner: marker is not written when the graph build fails (retried next launch)', () => {
  const home = join(tmpRoot, 'crg-home-fail');
  const repo = join(tmpRoot, 'crg-repo-fail');
  const buildLog = join(tmpRoot, 'crg-build-fail.log');
  const marker = join(home, '.local', 'share', 'ccserver-tools', 'markers', 'code-review-graph-9.9.9');
  const res = runCrgProvisioner({ home, cwd: repo, buildLog, buildExit: 7 });

  assert.equal(res.status, 1, 'provisioner reports failure via exit code');
  assert.ok(!existsSync(marker), 'no marker on build failure, so the next launch retries');
  assert.match(readFileSync(provisionLog(home), 'utf8'), /graph build failed/);
});

test('provisioner: a matching marker short-circuits before any install/build work', () => {
  const home = join(tmpRoot, 'crg-home-skip');
  const repo = join(tmpRoot, 'crg-repo-skip');
  const buildLog = join(tmpRoot, 'crg-build-skip.log');
  const markers = join(home, '.local', 'share', 'ccserver-tools', 'markers');
  mkdirSync(markers, { recursive: true });
  writeFileSync(join(markers, 'code-review-graph-9.9.9'), '');
  const res = runCrgProvisioner({ home, cwd: repo, buildLog });

  assert.equal(res.status, 0);
  assert.ok(!existsSync(buildLog), 'build never invoked when the marker matches');
  assert.ok(!/インストール中/.test(res.stdout), 'no install status lines on the fast path');
});

// ---------------------------------------------------------------------------
// rtk shell tests: a fake `curl` on PATH hands the provisioner a real tarball
// containing an `rtk` shim (records its argv, emulates the opencode plugin
// install, exits 0 / RTK_INIT_EXIT), so we can verify the `rtk init -g
// --opencode --no-patch` step and the marker semantics end to end.
// ---------------------------------------------------------------------------

// Build a real gzipped tarball holding an executable `rtk` shim, and plant a
// fake `curl` on PATH that writes it wherever download() asks.
function makeFakeRtkDownload(binDir, tarballPath) {
  mkdirSync(binDir, { recursive: true });
  const srcDir = join(tmpRoot, 'rtk-src');
  mkdirSync(join(srcDir, 'rtk'), { recursive: true });
  writeFileSync(join(srcDir, 'rtk', 'rtk'), `#!/usr/bin/env bash
echo "$@" >> "\${RTK_INIT_LOG:-/dev/null}"
if [ "$1" = "init" ]; then
  if [ "\${RTK_INIT_EXIT:-0}" != "0" ]; then exit "\${RTK_INIT_EXIT}"; fi
  mkdir -p "$HOME/.config/opencode/plugins"
  printf '// fake rtk plugin\\n' > "$HOME/.config/opencode/plugins/rtk.ts"
  exit 0
fi
exit 0
`);
  chmodSync(join(srcDir, 'rtk', 'rtk'), 0o755);
  const tar = spawnSync('tar', ['-czf', tarballPath, '-C', srcDir, 'rtk'], { encoding: 'utf8' });
  if (tar.status !== 0) throw new Error(`tar failed: ${tar.stderr}`);

  const curl = join(binDir, 'curl');
  writeFileSync(curl, `#!/usr/bin/env bash
dest=""
prev=""
for a in "$@"; do
  if [ "$prev" = "-o" ]; then dest="$a"; fi
  prev="$a"
done
cp ${tarballPath} "$dest"
exit 0
`);
  chmodSync(curl, 0o755);
}

function runRtkProvisioner({ home, cwd, initLog, initExit = 0 }) {
  const binDir = join(tmpRoot, 'rtkfakebin');
  const tarball = join(tmpRoot, 'rtk-fake.tar.gz');
  makeFakeRtkDownload(binDir, tarball);
  mkdirSync(cwd, { recursive: true });
  return spawnSync('bash', [PROVISION_SCRIPT], {
    cwd,
    env: {
      HOME: home,
      PATH: `${binDir}:${process.env.PATH}`,
      CCSANDBOX_PROVISION_RTK: '1',
      CCSANDBOX_PROVISION_CRG: '0',
      CCSANDBOX_RTK_VERSION: 'v9.9.9',
      CCSANDBOX_RTK_URL: 'https://example.invalid/rtk.tar.gz',
      CCSANDBOX_RTK_SHA256: '',
      RTK_INIT_LOG: initLog,
      RTK_INIT_EXIT: String(initExit),
    },
    encoding: 'utf8',
  });
}

test('provisioner installs the opencode plugin via `rtk init -g --opencode --no-patch` after the rtk binary', () => {
  const home = join(tmpRoot, 'rtk-home-ok');
  const cwd = join(tmpRoot, 'rtk-repo-ok');
  const initLog = join(tmpRoot, 'rtk-init-ok.log');
  const marker = join(home, '.local', 'share', 'ccserver-tools', 'markers', 'rtk-v9.9.9');
  const res = runRtkProvisioner({ home, cwd, initLog });

  assert.equal(res.status, 0, `provisioner exited 0 (stderr: ${res.stderr})`);
  assert.ok(existsSync(join(home, '.local', 'bin', 'rtk')), 'rtk binary installed on the sandbox PATH');
  const calls = readFileSync(initLog, 'utf8').trim().split('\n');
  assert.equal(calls.length, 2, 'telemetry disabled once, then init invoked once');
  assert.equal(calls[0], 'telemetry disable', 'telemetry disabled so the pty never blocks on the [y/N] prompt');
  assert.equal(calls[1], 'init -g --opencode --no-patch');
  assert.ok(existsSync(join(home, '.config', 'opencode', 'plugins', 'rtk.ts')), 'opencode plugin installed');
  assert.ok(existsSync(marker), 'marker written after binary + plugin install succeed');
  assert.match(res.stdout, /rtk をインストール中…/);
  assert.match(res.stdout, /opencode プラグインを設定中…/);
  assert.match(res.stdout, /rtk 導入完了/);
});

test('provisioner: rtk marker is not written when the opencode plugin init fails (retried next launch)', () => {
  const home = join(tmpRoot, 'rtk-home-fail');
  const cwd = join(tmpRoot, 'rtk-repo-fail');
  const initLog = join(tmpRoot, 'rtk-init-fail.log');
  const marker = join(home, '.local', 'share', 'ccserver-tools', 'markers', 'rtk-v9.9.9');
  const res = runRtkProvisioner({ home, cwd, initLog, initExit: 3 });

  assert.equal(res.status, 1, 'provisioner reports failure via exit code');
  assert.ok(!existsSync(marker), 'no marker on plugin init failure, so the next launch retries');
  assert.match(readFileSync(provisionLog(home), 'utf8'), /opencode plugin init failed/);
});
