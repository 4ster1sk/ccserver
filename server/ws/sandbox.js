// Builds the command line to launch Claude Code (or a shell) inside a
// filesystem sandbox, so it cannot read adjacent projects. When docker is
// enabled, a rootless dockerd is started *inside* the sandbox so that
// containers/volumes stay confined to the exposed paths.
//
// Architecture (docker on):
//   rootlesskit (outer, provides subuid userns + slirp4netns networking)
//     -> bwrap (inner, no --unshare-user, restricts the filesystem)
//        -> sandbox-entrypoint.sh
//           -> dockerd (background) + target command (claude/shell)
//
// Architecture (docker off): plain bwrap (--unshare-user) -> entrypoint -> target.
//
// The ordering matters: bwrap creating the user namespace would break
// newuidmap (no subuid mapping -> single uid), so rootlesskit must be the
// outer layer. See memory: sandbox-dind-recipe.
//
import { homedir } from 'node:os';
import { chmodSync, closeSync, copyFileSync, constants as fsConstants, existsSync, fchmodSync, fstatSync, ftruncateSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { chmod as chmodP, readdir as readdirP, rm as rmP, stat as statP } from 'node:fs/promises';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startGitBroker, hostRuntimeDir, ensureHostRuntimeDir } from './git-broker.js';
import { buildGuardConfig } from './commitGuard.js';
import * as gpgVaultAgent from './gpgVaultAgent.js';
import * as gpgVaultRelay from './gpgVaultRelay.js';
import { isBlockedCredentialBind, agentConfigDirs } from './sandbox-paths.js';
import { normalizeNetworkSettings } from './networkAllowlist.js';
import { recordSandboxHome as recordSandboxHomeDb, listSandboxRowsBySlug, forgetSandboxHome } from './projects.js';
import { APPS } from './appLaunch.js';
import { normalizeBrowseRoots, isContained } from '../pathPolicy.js';
import { resolvePath, PATH_IDS } from '../paths.js';
import { isRegularFile, readRegularFileText } from './regularFile.js';
import { normalizeBridgeSettings } from './notifyBridgeSettings.js';
import { qemuStatus, prepareQemuSession, buildGuestRuntime, currentGolden, LAUNCHER_SCRIPT as QEMU_LAUNCHER, QEMU_RESOURCE_LIMITS, GUEST_CHAT_BRIDGE, GUEST_CHAT_PASSWORD, GUEST_CHAT_SOCK, GUEST_CHAT_BRIDGE_NAME, GUEST_CHAT_PASSWORD_NAME } from './sandbox-qemu.js';
import { qemuVmPool as defaultQemuVmPool, poolKey } from './qemuVmPool.js';
import { startGoNetworkBroker, netbrokerBin } from './netbrokerClient.js';
import { resolveVmTemplate } from '../vmTemplates.js';
import { getVmAgentCredentials } from '../vmAgentCredentials.js';
import { resolveVmAgentInstall, credentialPaths, guestAgentDir, vmAgentArgv, vmAgentEnv, buildVmAgentAuth, readOpencodeHostProviders, resolveOpencodeProviders, VmAgentError } from './qemuAgents.js';

const execFileAsync = promisify(execFile);

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENTRYPOINT = join(__dirname, 'sandbox-entrypoint.sh');
const PROVISION_SCRIPT = join(__dirname, 'sandbox-provision.sh');
const GH_WRAPPER_SCRIPT = join(__dirname, 'sandbox-gh-wrapper.cjs');
const CRED_HELPER_SCRIPT = join(__dirname, 'sandbox-git-credential-helper.cjs');
const SSH_WRAPPER_SCRIPT = join(__dirname, 'sandbox-ssh-wrapper.cjs');
const COMMIT_MSG_HOOK_SCRIPT = join(__dirname, 'sandbox-commit-msg-hook.cjs');
const GENERATED_GITCONFIG = join(__dirname, 'sandbox-gitconfig');
const DEFAULT_KNOWN_HOSTS = join(__dirname, 'sandbox-known-hosts');
const SSH_CONFIG_FILE = join(__dirname, 'sandbox-ssh-config');

const BWRAP = '/usr/bin/bwrap';
const ROOTLESSKIT = '/usr/bin/rootlesskit';
const BASH = '/usr/bin/bash';

const IS_MACOS = process.platform === 'darwin';

// Fixed in-sandbox paths for the git-broker machinery (see buildBwrapArgs).
const SANDBOX_NODE_PATH = '/ccserver-sandbox-node';
const SANDBOX_CRED_HELPER_PATH = '/ccserver-sandbox-git-credential-helper.cjs';
const SANDBOX_ALLOWLIST_PATH = '/ccserver-sandbox-git-allowlist.json';
const SANDBOX_BROKER_SOCK_PATH = '/ccserver-sandbox-git-broker.sock';
const SANDBOX_REAL_SSH_PATH = '/ccserver-sandbox-real-ssh';
const SANDBOX_SSH_CONFIG_PATH = '/ccserver-sandbox-ssh-config';
const SANDBOX_KNOWN_HOSTS_USER_PATH = '/ccserver-sandbox-known-hosts-user';
const SANDBOX_KNOWN_HOSTS_DEFAULT_PATH = '/ccserver-sandbox-known-hosts-default';

// Fixed in-sandbox paths for the commit-message guard (see commitGuard.js /
// sandbox-commit-msg-hook.cjs / loadSandboxConfig's commitMessageGuard).
// core.hooksPath is pointed at SANDBOX_COMMIT_GUARD_HOOKS_DIR via the
// GIT_CONFIG_COUNT/KEY/VALUE env mechanism (see buildBwrapArgs) rather than
// by overwriting ~/.gitconfig -- unlike gitBroker's credential.helper, this
// feature has its own independent enable flag and must keep working even
// when gitBroker is off, without clobbering an agent-written ~/.gitconfig
// in a persistent HOME.
const SANDBOX_COMMIT_GUARD_HOOKS_DIR = '/ccserver-sandbox-git-hooks';
const SANDBOX_COMMIT_GUARD_HOOK_PATH = `${SANDBOX_COMMIT_GUARD_HOOKS_DIR}/commit-msg`;
const SANDBOX_COMMIT_GUARD_CONFIG_PATH = '/ccserver-sandbox-commit-guard.json';

// Fixed in-sandbox path for the MCP bridge wrapper (see mcpConfig.js),
// which the agent CLIs run via --mcp-config / OPENCODE_CONFIG_CONTENT. The
// process-global notify socket (ccserver-notify, see notify.js) is bound at a
// second fixed path the same wrapper reaches when invoked with the 'notify'
// argument. The process-global usage socket (ccserver-usage, see
// usageMcp.js) is bound at a third fixed path, reached with the 'usage'
// argument.
//
// Issue #143 problem 1: each socket names a file inside its own
// dedicated `.d` directory rather than sitting directly under sandbox root.
// buildBwrapArgs binds dirname(hostSocketPath) onto dirname(this constant) --
// a DIRECTORY bind, immune to the host socket file being replaced underneath
// it across a server本体 restart (see mcpBroker.js's header comment) -- so
// each of these needs a dedicated parent directory to bind onto that holds
// nothing else (sandbox root itself is not an option: binding a directory
// there would shadow the whole sandbox filesystem built by every earlier
// bind in this function).
const SANDBOX_NOTIFY_SOCK_PATH = '/ccserver-sandbox-notify.d/sock';
const SANDBOX_USAGE_SOCK_PATH = '/ccserver-sandbox-usage.d/sock';
const SANDBOX_MCP_BRIDGE_PATH = '/ccserver-sandbox-mcp-bridge';
const MCP_BRIDGE_SCRIPT = join(__dirname, 'sandbox-mcp-wrapper.cjs');

// Chat mode (see opencode-chat-bridge.cjs / claude-chat-bridge.cjs): the
// app's bridge script, and a per-session host dir holding the server
// password file and the relay socket the bridge creates. A directory bind
// (like the MCP sockets above), so the socket the bridge creates inside is
// the host's file too. CHAT_BRIDGE_SCRIPT is opencode's; a Claude Code
// session brings its own bundled bridge (`chat.bridgeScript`, see
// opencodeChat.js's prepareChatDir).
export const CHAT_BRIDGE_SCRIPT = join(__dirname, 'opencode-chat-bridge.cjs');
const SANDBOX_CHAT_BRIDGE_PATH = '/ccserver-sandbox-chat-bridge.cjs';
const SANDBOX_CHAT_DIR = '/ccserver-sandbox-chat.d';
export const CHAT_SOCK_NAME = 'oc.sock';
export const CHAT_PASSWORD_NAME = 'password';

// The bridge invocation wrapped around the agent command (`agentArgv`) for
// a chat launch: `node`, the bridge script and the socket/password paths as
// the bridge itself sees them, plus the bridge's own flags (`bridgeArgs`,
// e.g. Claude Code's --resume-last).
export function chatBridgeArgv({ node, script, sock, passwordFile, bridgeArgs = [] }, agentArgv) {
  return [node, script, '--sock', sock, '--password-file', passwordFile, ...bridgeArgs, '--', ...agentArgv];
}

function chatBridgeOf(chat) {
  return chat?.bridgeScript || CHAT_BRIDGE_SCRIPT;
}

// Fixed in-sandbox path for the tool-provisioning script (see resolveTools /
// sandbox-provision.sh): bound read-only at launch when any opt-in tool is
// enabled, executed by the entrypoint before the target command.
const SANDBOX_PROVISION_PATH = '/ccserver-sandbox-provision.sh';

// Pinned defaults for the opt-in tools provisioned into the sandbox HOME at
// launch (see resolveTools / sandbox-provision.sh). The host OS never needs
// them installed; sandbox.config.json's "tools" (or the client's per-session
// sandboxOpts.tools) enables them, and the object form can override any of
// these fields (version / url / sha256).
const RTK_VERSION = 'v0.45.0';
const RTK_ASSET = { x64: 'x86_64-unknown-linux-musl', arm64: 'aarch64-unknown-linux-gnu' }[process.arch] || null;
// Unknown arches (armv7, riscv64, ...) resolve to no spec: provisioning skips
// rtk instead of installing an unrunnable binary with a skipped checksum.
const RTK_DEFAULT = RTK_ASSET ? {
  version: RTK_VERSION,
  url: `https://github.com/rtk-ai/rtk/releases/download/${RTK_VERSION}/rtk-${RTK_ASSET}.tar.gz`,
  // sha256 of the x86_64 musl tarball (the arch ccserver runs on in practice).
  // Empty on other arches: the provisioner warns on the terminal, logs, and
  // skips the checksum, and the config object form can pin one explicitly.
  sha256: process.arch === 'x64' ? 'c4c036fbf181fc55ef329786c8c17e0d427972b053b825944d968a6aafef1ba4' : '',
} : null;
const CRG_DEFAULT = { version: '2.3.7' };

const HOME = homedir();
// Host runtime dir (commit-guard state, rootlesskit state dirs). darwin-aware
// via git-broker.js: macOS has no /run/user, so without XDG_RUNTIME_DIR this
// falls back to a short /tmp base there (NOT the per-user tmpdir: broker
// socket names appended to /var/folders/... would exceed darwin's 104-byte
// sockaddr_un.sun_path limit and every bind would fail).
const XDG_RUNTIME_DIR = hostRuntimeDir();

// RootlessKit's state dir (holds the API socket dockerd connects to) lives
// under the runtime dir on the host; bwrap binds it in so dockerd can reach it.
// It MUST be unique per launch: rootlesskit flocks <state-dir>/lock, so a shared
// path lets a still-running (or slowly-torn-down) sandbox block the next one
// with "another RootlessKit is running with the same state directory". A fresh
// dir per session also means a leaked sandbox never blocks a new launch.
function newStateDir() {
  return join(XDG_RUNTIME_DIR, `dockerd-rootless-${randomUUID()}`);
}

// Where per-project docker data-roots (images/layers) live, so they persist
// across sessions of the same project. Overridable via
// CCSERVER_SANDBOX_DIND_ROOT for tests/alternate layouts.
function dindRoot() {
  return resolvePath(PATH_IDS.dind);
}

// Where each project's persistent writable HOME lives (see buildBwrapArgs).
// Bound at HOME inside the sandbox so tools/caches installed by a previous
// session of the same project survive a relaunch. Overridable via
// CCSERVER_SANDBOX_HOME_ROOT for tests/alternate layouts.
export function sandboxHomeRoot() {
  return resolvePath(PATH_IDS.sandboxHome);
}

// Whether any on-disk remnant of a failed deletion is still present for this
// slug. Lets the settings page retire a synthesized error row once the user
// has cleaned the leftovers up manually (the failure message itself tells
// them to run `sudo rm -rf`), instead of showing it until restart.
export function sandboxRemnantsExist(name) {
  return existsSync(join(sandboxHomeRoot(), name)) || existsSync(join(dindRoot(), name));
}

// The lock file a rootless dockerd holds (flock, see sandbox-entrypoint.sh's
// $DATA_ROOT/.ccserver-dockerd.lock) for the whole daemon lifetime. Its
// presence on the host tells us whether a daemon -- possibly leaked from an
// old session -- is still using a data-root.
const DOCKERD_LOCK_NAME = '.ccserver-dockerd.lock';

// Written by sandbox-entrypoint.sh the instant its background dockerd wins
// the DOCKERD_LOCK_NAME flock, containing that launch's CCSANDBOX_DOCKERD_TAG
// (see buildBwrapArgs). Lets dockerdStatus() below identify WHICH session
// currently holds a project's data-root -- flock itself only exposes
// held/free, not the holder's identity. Stale (not cleared) once written: a
// session that exits never erases its tag, so after it's gone the file still
// names it until some *future* launch wins the flock and overwrites it. A
// mismatched tag therefore does NOT by itself mean "held by another live
// session" -- it can equally mean "held by nobody, this is just leftover
// history" (a session mid-startup, before it has raced for the flock, would
// otherwise misread that as a hard, non-retriable conflict). Callers must
// pair this with dindLockHeld() to tell the two apart (see
// sessionManager.dockerAvailability, the only consumer).
const DOCKERD_STATUS_NAME = '.ccserver-dockerd.status';

// The entrypoint writes one tag (a directory basename) plus a newline -- 54
// bytes in practice. 4096 is ~75x that, so no legitimate status file can hit
// it, while a planted one is still bounded.
const DOCKERD_STATUS_MAX_BYTES = 4096;

// flock -n exits instantly on a regular file. Anything slower means the file
// stopped being one between the isRegularFile check and the exec, so the
// child is killed rather than waited on.
const FLOCK_TIMEOUT_MS = 5000;

// True when a (live or leaked) dockerd currently holds the data-root lock for
// this sandbox slug. Deletion must be refused then: the daemon's live overlay
// mounts defeat every removal strategy (EBUSY) and deleting under a running
// daemon would corrupt the data-root. flock(1) is the same util-linux binary
// the entrypoint uses; -n makes it exit non-zero immediately when the lock is
// held. A missing flock (ENOENT) must NOT hard-block deletion, so only a
// non-ENOENT failure counts as "held". Stays synchronous on purpose: flock -n
// exits instantly, dockerAvailability() consumes it as a plain boolean, and
// the settings-page DELETE route imports it for its immediate 409 pre-check.
export function dindLockHeld(name) {
  const lock = join(dindRoot(), name, DOCKERD_LOCK_NAME);
  // Not existsSync: this data-root is --bind mounted READ-WRITE into the
  // sandbox (buildBwrapArgs, at ~/.local/share/docker), so the session can
  // delete this lock file and drop a FIFO in its place. existsSync says
  // "yes" to a FIFO, and flock(1) would then block in open(2) waiting for a
  // writer that never comes -- with execFileSync that is the HOST's event
  // loop stopped, past the point where SIGTERM is handled (issue #212).
  // isRegularFile answers without blocking.
  if (!isRegularFile(lock)) return false;
  try {
    // ...and a timeout anyway, because the check above is on a path: the
    // session can swap the file between it and the exec. The check keeps the
    // normal case honest, the timeout bounds the race.
    execFileSync('flock', ['-n', lock, 'true'], { stdio: 'ignore', timeout: FLOCK_TIMEOUT_MS });
    return false;
  } catch (err) {
    return err.code !== 'ENOENT';
  }
}

// cwd-keyed wrapper around dindLockHeld(), for callers outside this module
// that only ever address data-roots by cwd (mirrors dockerdStatus() below).
export function dockerdLockHeld(cwd) {
  return dindLockHeld(slugify(cwd));
}

// The CCSANDBOX_DOCKERD_TAG of whichever launch most recently won this
// project's dockerd flock (see DOCKERD_STATUS_NAME), or null before any
// session has ever started dockerd for this cwd. `cwd` must be the exact
// same string a session was launched with -- this mirrors buildBwrapArgs'
// `slugify(cwd)` (no resolve()) exactly, so the read path always matches
// that session's own write path (see sessionManager.dockerAvailability, the
// only consumer).
export function dockerdStatus(cwd) {
  const path = join(dindRoot(), slugify(cwd), DOCKERD_STATUS_NAME);
  try {
    // Not readFileSync, for the same reason as dindLockHeld above: this file
    // lives in the data-root the sandbox has READ-WRITE, so the session that
    // is supposed to write its tag here can write a FIFO instead and stop
    // the host in the next dockerAvailability() call. Unlike the state JSON
    // this PR's other readers handle, THIS one is reachable from inside the
    // sandbox -- the config and state dirs are not bind-mounted, this is.
    // A tag is a few dozen bytes; the cap is generous for that and still
    // bounds a planted file.
    return readRegularFileText(path, { maxBytes: DOCKERD_STATUS_MAX_BYTES }).trim() || null;
  } catch {
    return null; // absent, or not a regular file -- both read as "no tag yet"
  }
}

// Recursively remove a directory tree, escalating through successively more
// privileged strategies when a plain rmSync hits a permission error. Returns
// null on success, or an error message when every strategy failed (the caller
// turns that into a clean HTTP error instead of an opaque EACCES 500).
function removeTree(path) {
  // NOTE: keep in lockstep with removeTreeAsync below until buildSandboxSpawn
  // goes async and one of the two twins can be deleted.
  if (!existsSync(path)) return null;
  const tryRemove = (fn) => {
    try {
      fn();
      if (!existsSync(path)) return true;
    } catch {
      // fall through to the next strategy
    }
    return false;
  };
  if (tryRemove(() => rmSync(path, { recursive: true, force: true }))) return null;
  // The offending dirs may be OURS but locked down (mode 000). As owner,
  // chmod -R u+rwx fixes listing with no namespace dance; cheap retry.
  if (tryRemove(() => {
    chmodSync(path, 0o700);
    execFileSync('chmod', ['-R', 'u+rwx', path], { stdio: 'ignore' });
    rmSync(path, { recursive: true, force: true });
  })) return null;
  if (tryRemove(() => removeTreeViaRootlesskit(path))) return null;
  if (tryRemove(() => removeTreeViaSudo(path))) return null;
  return `permission denied removing ${path}; run manually: sudo rm -rf "${path}"`;
}

// The persistent docker data-root is written by a rootless dockerd running
// inside a user namespace, so files created by container processes as a
// non-root uid are owned on the host by a subuid (e.g. 100000+ for the ast
// user) -- uids the ccserver process can neither read nor delete. containerd's
// overlayfs snapshot dirs
// (…/io.containerd.snapshotter.v1.overlayfs/snapshots/<id>/…) are exactly
// where those subuid-owned files land, which is why deleting a data-root used
// to fail with "EACCES: permission denied, scandir …/work/work". A fresh
// rootlesskit --net=none userns uses the SAME subuid mapping the sandbox used,
// so there the files are owned by mapped (non-root) uids that userns-root's
// capabilities make deletable.
function removeTreeViaRootlesskit(path) {
  if (!existsSync(ROOTLESSKIT)) return;
  const stateDir = join(XDG_RUNTIME_DIR, `ccserver-dind-cleanup-${randomUUID()}`);
  mkdirSync(stateDir, { recursive: true });
  try {
    execFileSync(ROOTLESSKIT, [
      `--state-dir=${stateDir}`,
      '--net=none',
      '--disable-host-loopback',
      'rm', '-rf', path,
    ], { stdio: 'ignore', timeout: 120_000 });
  } finally {
    try { rmSync(stateDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

// Last resort for trees owned by a real root OUTSIDE the userns mapping (e.g.
// a data-root created by a server that once ran as root): passwordless sudo.
// Only ever runs when plain removal failed and sudo -n is actually configured.
function removeTreeViaSudo(path) {
  try {
    execFileSync('sudo', ['-n', 'true'], { stdio: 'ignore' });
    execFileSync('sudo', ['-n', 'rm', '-rf', path], { stdio: 'ignore', timeout: 120_000 });
  } catch {
    // no passwordless sudo, or sudo itself failed
  }
}

// Async twin of removeTree for the settings-page DELETE route: deleting a
// multi-GB docker data-root takes minutes, and the sync version froze the
// event loop (and with it every WS session and HTTP request) for that whole
// time. Same escalation order and semantics as removeTree, just non-blocking.
async function removeTreeAsync(path) {
  // NOTE: keep in lockstep with the sync removeTree above.
  if (!existsSync(path)) return null;
  const tryRemove = async (fn) => {
    try {
      await fn();
      if (!existsSync(path)) return true;
    } catch {
      // fall through to the next strategy
    }
    return false;
  };
  if (await tryRemove(() => rmP(path, { recursive: true, force: true }))) return null;
  if (await tryRemove(async () => {
    await chmodP(path, 0o700);
    await execFileAsync('chmod', ['-R', 'u+rwx', path], { stdio: 'ignore' });
    await rmP(path, { recursive: true, force: true });
  })) return null;
  if (await tryRemove(() => removeTreeViaRootlesskitAsync(path))) return null;
  if (await tryRemove(() => removeTreeViaSudoAsync(path))) return null;
  return `permission denied removing ${path}; run manually: sudo rm -rf "${path}"`;
}

async function removeTreeViaRootlesskitAsync(path) {
  if (!existsSync(ROOTLESSKIT)) return;
  const stateDir = join(XDG_RUNTIME_DIR, `ccserver-dind-cleanup-${randomUUID()}`);
  mkdirSync(stateDir, { recursive: true });
  try {
    await execFileAsync(ROOTLESSKIT, [
      `--state-dir=${stateDir}`,
      '--net=none',
      '--disable-host-loopback',
      'rm', '-rf', path,
    ], { stdio: 'ignore', timeout: 120_000 });
  } finally {
    try { await rmP(stateDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

async function removeTreeViaSudoAsync(path) {
  try {
    await execFileAsync('sudo', ['-n', 'true'], { stdio: 'ignore' });
    await execFileAsync('sudo', ['-n', 'rm', '-rf', path], { stdio: 'ignore', timeout: 120_000 });
  } catch {
    // no passwordless sudo, or sudo itself failed
  }
}

// Deterministic per-project path of the persistent HOME. resolve() normalizes
// spelling variants (trailing slash, "..", ...) so they all map to one dir,
// for legacy path compatibility.
export function persistentHomeDir(cwd) {
  return join(sandboxHomeRoot(), slugify(resolve(cwd)));
}

// Public status for the reuse dialog: whether persistent HOME is enabled at
// all (sandbox.config.json's persistentHome) and whether a previous sandbox
// already left state for this cwd.
export function sandboxHomeStatus(cwd) {
  const enabled = loadSandboxConfig().persistentHome;
  const path = persistentHomeDir(cwd);
  let exists = false;
  try { exists = statSync(path).isDirectory(); } catch { /* not there yet */ }
  return { enabled, exists, path };
}

// Sidecar index mapping a home dir's slug back to the project path it was
// created for has moved into SQLite (DB v2, see ws/projects.js) -- the old
// homeIndex.json is imported once by the v2 migration and retired to
// `.index.json.migrated`. The disk walk below stays the source of truth for
// what actually exists; the sandboxes table enriches each row with the real
// project path, label, git remote and usage timestamps.

// Remember which project a persistent HOME belongs to (settings-page labels).
// Best-effort by contract (a bookkeeping failure must never fail a launch);
// the SQLite details live in ws/projects.js. Sync (single-threaded) so
// concurrent launches can't race.
function recordSandboxHome(cwd, createdBy = null) {
  recordSandboxHomeDb(cwd, { createdBy });
}

// Enumerate the persistent sandbox homes for the settings page:
//   { name (slug), path, cwd (real project path when known), projectId,
//     projectLabel (user-editable display name; null falls back to
//     basename(cwd) client-side), gitRemote, lastUsedAt, createdBy }
export function listSandboxHomes() {
  const root = sandboxHomeRoot();
  const rows = listSandboxRowsBySlug();
  const entries = [];
  let names = [];
  try { names = readdirSync(root); } catch { return []; }
  for (const name of names) {
    const path = join(root, name);
    let isDir = false;
    try { isDir = statSync(path).isDirectory(); } catch { /* not a dir */ }
    if (!isDir) continue;
    const row = rows.get(name);
    entries.push({
      name,
      path,
      cwd: typeof row?.cwd === 'string' ? row.cwd : null,
      projectId: row?.project_id ?? null,
      projectLabel: row?.project_label ?? null,
      gitRemote: row?.git_remote ?? null,
      lastUsedAt: typeof row?.last_used_at === 'number' ? row.last_used_at : null,
      createdBy: row?.created_by ?? null,
    });
  }
  return entries;
}

// Memoized du results, keyed by home path: the settings page's refresh button
// can be hit repeatedly and du over a big docker data-root takes seconds.
const SANDBOX_SIZE_TTL_MS = 60_000;
const sizeCache = new Map(); // path -> { size, fetchedAt }

export function clearSandboxSizeCache() {
  sizeCache.clear();
}

async function measureSandboxHomeSize(path) {
  try {
    const { stdout } = await execFileAsync('du', ['-sb', path], { encoding: 'utf-8', timeout: 30_000 });
    const m = /^\s*(\d+)/.exec(stdout);
    if (m) return Number(m[1]);
  } catch { /* fall through to the stat walk */ }
  let total = 0;
  const walk = async (p) => {
    let st;
    try { st = await statP(p); } catch { return; }
    if (st.isDirectory()) {
      let children;
      try { children = await readdirP(p); } catch { return; }
      for (const c of children) await walk(join(p, c));
    } else {
      total += st.size;
    }
  };
  await walk(path);
  return total;
}

// Apparent size in bytes of a sandbox home (du -sb; recursive stat fallback),
// memoized for SANDBOX_SIZE_TTL_MS. Async + cached because this used to run
// execFileSync('du') directly in the route handler and froze the whole server
// (every WS session included) for as long as du took.
export async function sandboxHomeSize(path) {
  const hit = sizeCache.get(path);
  if (hit && Date.now() - hit.fetchedAt < SANDBOX_SIZE_TTL_MS) return hit.size;
  const size = await measureSandboxHomeSize(path);
  sizeCache.set(path, { size, fetchedAt: Date.now() });
  return size;
}

// Slugs with a settings-page deletion currently running. Lives here rather
// than in the route so both consumers can see it: the DELETE route guards
// against duplicate kicks (two concurrent rm -rf escalations over the same
// trees), and buildSandboxSpawn refuses to launch a session into a HOME that
// is being removed underneath it.
const deletionsInFlight = new Set();

export function isSandboxDeleteInFlight(name) {
  return deletionsInFlight.has(name);
}

export function beginSandboxDelete(name) {
  deletionsInFlight.add(name);
}

export function endSandboxDelete(name) {
  deletionsInFlight.delete(name);
}

// Snapshot of the slugs currently being deleted, for the settings page to
// synthesize "削除中" rows whose HOME has already been removed.
export function sandboxDeletesInFlight() {
  return [...deletionsInFlight];
}

// Delete a sandbox: its persistent HOME plus the matching docker data-root
// (both keyed by the same slug). Name must be a bare slug (no separators) so
// the caller can never escape the roots. The in-use guard lives in the route
// (see sessionManager.sandboxHomeInUsePath). Removal is permission-tolerant:
// containerd overlayfs snapshot dirs can be owned by subuid-mapped uids the
// server can't read (see removeTreeAsync), and a still-running dockerd must
// block the whole delete rather than corrupt its data-root (dindLockHeld).
export async function deleteSandboxHome(name) {
  if (!/^[A-Za-z0-9_]+$/.test(name)) {
    return { ok: false, error: 'invalid-sandbox-name' };
  }
  if (dindLockHeld(name)) {
    return { ok: false, error: 'docker-daemon-in-use' };
  }
  const homeErr = await removeTreeAsync(join(sandboxHomeRoot(), name));
  const dindErr = await removeTreeAsync(join(dindRoot(), name));
  if (homeErr || dindErr) {
    // Keep the index entry on partial failure so the settings page still
    // shows the sandbox and the user can retry.
    return { ok: false, error: homeErr || dindErr };
  }
  forgetSandboxHome(name);
  sizeCache.delete(join(sandboxHomeRoot(), name));
  return { ok: true };
}

// PATH set inside the sandbox at runtime (see buildBwrapArgs' --setenv PATH
// below). Resolving the bare "claude" command for install-dir detection must
// search this PATH, not the host ccserver process's own PATH: a personal PATH
// shim ahead of it there (e.g. a ~/.dotfiles/bin/claude wrapper that nests its
// own bwrap sandbox around /usr/bin/claude) is never on the sandboxed PATH, so
// resolving against the host PATH makes claudeInstallDir follow a wrapper the
// sandbox will never actually invoke -- silently missing the real install dir
// and leaving the sandboxed launch to fail with exit 127.
export const SANDBOX_PATH = `${join(HOME, '.local', 'bin')}:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`;

function expandHome(p) {
  if (p === '~') return HOME;
  if (p.startsWith('~/')) return join(HOME, p.slice(2));
  return p;
}

function slugify(p) {
  return p.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'root';
}

// Parse a booleanish value (actual boolean, or the recognized word forms
// 1/true/on/yes vs 0/false/off/no, case-insensitive) -- or undefined when it
// doesn't match either. Shared by resolveFlag below so a config-file value
// gets the same vocabulary an env var already did; this only widens what a
// FILE value can express -- an unrecognized value still falls back the same
// way it always has, one level further down resolveFlag's chain.
function parseBoolish(v) {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const s = v.trim().toLowerCase();
    if (['1', 'true', 'on', 'yes'].includes(s)) return true;
    if (['0', 'false', 'off', 'no'].includes(s)) return false;
  }
  return undefined;
}

// Resolve a booleanish flag from an env override + a config-file value with
// a default. Env wins when it is a recognized boolean word; an unrecognized
// or empty env value falls back to the config file, which now accepts the
// same word forms (not just a strict boolean) -- so e.g. a quoted
// `"opencodeGoUsage": "false"` in the config file is honored instead of
// silently falling back to the default as if unset.
function resolveFlag(envVal, fileVal, def) {
  const fromEnv = parseBoolish(envVal);
  if (fromEnv !== undefined) return fromEnv;
  const fromFile = parseBoolish(fileVal);
  if (fromFile !== undefined) return fromFile;
  return def;
}

// Every agent CLI the launch pickers know about (see resolveApp/installedApps
// below, and issue #105's hiddenApps). Self-review: this used to redefine the
// same literal appLaunch.js's APPS already exports, risking drift the next
// time an app is added -- re-exported under this module's existing name
// instead, so existing importers (sandbox-config.test.js,
// startup-hidden-apps.test.js) don't need to change. A defensive copy, not
// the same array object: appLaunch.js's dispatch tables (isValidApp/
// resolveApp) hold the original APPS binding, and an in-place mutation of
// one (e.g. re-sorting APP_IDS for picker display order) must never corrupt
// the other's shared state.
export const APP_IDS = [...APPS];

// One-shot latch for the removed-Vikunja-key notice below: loadSandboxConfig
// re-reads the file on every call (every session launch, every notify), so the
// warning has to be per-process rather than per-read.
let warnedVikunjaConfig = false;

// Test seam (review finding #4): the latch above is module state with no way
// back, so a test that runs after anything else has already tripped it can
// neither observe the warning nor assert it fires only once. Same shape as
// another module-state reset seam.
export function _resetVikunjaWarningForTests() {
  warnedVikunjaConfig = false;
}

// Same latch + seam for the retired allowUnsandboxedAgents key.
let warnedAllowUnsandboxedAgents = false;
export function _resetAllowUnsandboxedAgentsWarningForTests() {
  warnedAllowUnsandboxedAgents = false;
}

// Load the optional sandbox config. Path from the registry (issue #201):
// CCSERVER_SANDBOX_CONFIG, else $XDG_CONFIG_HOME/ccserver/sandbox.config.json,
// falling back to the pre-#201 in-tree server/sandbox.config.json while that
// is the only copy present. Shape:
//   { "docker": true, "binds": [ { "src": "~/.ssh", "mode": "ro" }, ... ] }
export function loadSandboxConfig() {
  const configPath = resolvePath(PATH_IDS.sandboxConfig);
  let raw = {};
  // A missing file is legitimate (every setting has a default). A file that
  // exists but cannot be read/parsed is NOT: silently proceeding would run
  // the server with every setting defaulted -- including a security setting
  // the operator had set (browseRoots, forceSandbox). configError is
  // surfaced to index.js (refuses to boot) and folded into
  // browseRootsInvalid below (runtime enforcement fails closed).
  let configError = null;
  let configText = null;
  try {
    // followSymlinks, and ONLY here among the files regularFile.js reads.
    //
    // The line that matters: sandbox.config.json belongs to the OPERATOR,
    // every other file that reader handles belongs to the SERVER. Since the
    // #201 XDG split moved this one out of the checkout, keeping it under
    // version control is the operator's own business, and symlinking it in
    // from a dotfiles repo is the obvious way to do that. O_NOFOLLOW would
    // turn that setup into a refusal to boot. The server's own state files
    // have no such workflow -- nobody symlinks saved-groups.json -- so they
    // keep O_NOFOLLOW.
    //
    // Nothing #212 cares about is given up. The FIFO block is stopped by
    // O_NONBLOCK plus the fstat isFile() check, not by O_NOFOLLOW: measured,
    // a symlink pointing at a FIFO is still refused in under a millisecond.
    // O_NOFOLLOW only governs symlinks to regular files, and against an
    // attacker who can already write this 0700 directory it buys nothing
    // anyway: the flag does stop their symlink, but it does not stop them
    // planting a regular file with the same contents, which is strictly
    // easier. It narrows the method, not the outcome.
    configText = readRegularFileText(configPath, { followSymlinks: true });
  } catch (err) {
    if (err.code !== 'ENOENT') configError = err.message;
  }
  if (configText !== null) {
    try {
      raw = JSON.parse(configText);
    } catch (err) {
      configError = err.message;
      raw = {};
    }
  }
  const docker = raw.docker !== false; // default on
  // Keep a persistent writable HOME per project (~/.local/share/ccserver-
  // sandbox/home/<project>, see persistentHomeDir) so tools/caches installed
  // inside the sandbox survive a session relaunch; the client offers a reuse
  // dialog and "new" wipes it. false restores the legacy fresh-tmpfs-HOME.
  const persistentHome = raw.persistentHome !== false; // default on
  const gpg = raw.gpg === true;        // forward gpg-agent + ~/.gnupg (opt-in)
  // Forward the host's ssh-agent socket (opt-in, like gpg). Not needed for
  // HTTPS git (gitBroker handles that entirely host-side, see below) or for
  // commit signing (that's the gpg flag above); this only matters for SSH git
  // remotes or running `ssh` directly inside the sandbox. Off by default
  // because a forwarded agent is real standing access to the host's keys for
  // the whole sandboxed process, not just git -- see the docker+gitBroker
  // bypass warning below for how much a live agent socket widens the hole.
  const sshAgent = raw.sshAgent === true;
  // GPG vault (plan: gpg-agent-vault): forward the MANAGED vault agent's
  // sockets (server/ws/gpgVaultAgent.js) instead of the host's own
  // already-unlocked gpg-agent/ssh-agent. Off by default like gpg/sshAgent
  // above -- buildSandboxSpawn refuses this launch loudly (not silently) if
  // the vault is locked or was never set up (passkey-mode-only feature).
  const gpgVault = raw.gpgVault === true;
  // Lock-policy hardening knob for the vault's auto-lock sweep (see
  // gpgVaultAgent.js's startAutoLockSweep) -- deliberately read there, not
  // returned from here: it's read independently of a per-launch spawn, at
  // lock-policy-decision time, so folding it into this per-launch config
  // object would be misleading about when it's actually consulted.
  // Repo-scoped git credential broker: HTTPS credential helper + SSH gate,
  // both checked against the session cwd's own repo + submodules, and gh
  // CLI disabled (its API calls can't be repo-scoped without TLS
  // termination). Default on -- this replaces the old raw ~/.ssh /
  // ~/.config/gh exposure, which is blocked unconditionally regardless of
  // this flag (see the extraBinds filter below).
  const gitBroker = raw.gitBroker !== false;
  // Blocks a `git commit` inside the sandbox whose message matches a
  // pattern that must never land in real history -- built in: a
  // Claude-Session: trailer or a claude.ai/code/session_ URL, either of
  // which would hand out live access to the conversation that produced the
  // commit (see commitGuard.js). Independent of gitBroker above: this is
  // about what a local commit records, not about network credential scope,
  // so it stays effective even with gitBroker:false, and vice versa. Default
  // on (secure-by-default, same posture as gitBroker). blockedPatterns lets
  // the operator opt additional trailers into being blocked too (e.g.
  // `Co-Authored-By: Claude ... noreply@anthropic.com`) -- none of those are
  // built in, since plenty of workflows want them kept.
  const rawCommitGuard = (raw.commitMessageGuard && typeof raw.commitMessageGuard === 'object') ? raw.commitMessageGuard : {};
  const commitMessageGuard = {
    enabled: rawCommitGuard.enabled !== false,
    blockedPatterns: Array.isArray(rawCommitGuard.blockedPatterns)
      ? rawCommitGuard.blockedPatterns.filter((p) => typeof p === 'string' && p)
      : [],
  };
  // What the operator literally wrote. The EFFECTIVE value is computed below,
  // after browseRoots is known, because browseRoots implies this -- read that
  // one, not this.
  const forceSandboxExplicit = raw.forceSandbox === true;
  // ccserver-notify (see notify.js): the Discord webhook the notify MCP tool
  // delivers to, plus the initial subscription seed (https webhook URLs only --
  // a non-https URL is dropped, never trusted as a delivery target). The
  // optional env override CCSERVER_DISCORD_WEBHOOK wins over the config file,
  // so the webhook URL never has to live in a file at all.
  const rawNotify = (raw.notify && typeof raw.notify === 'object') ? raw.notify : {};
  let discordWebhook = null;
  for (const candidate of [process.env.CCSERVER_DISCORD_WEBHOOK, rawNotify.discordWebhook]) {
    if (typeof candidate === 'string' && candidate.startsWith('https://')) {
      discordWebhook = candidate;
      break;
    }
  }
  const subscriptions = Array.isArray(rawNotify.subscriptions)
    ? rawNotify.subscriptions
      .filter((s) => s && typeof s === 'object' && typeof s.url === 'string' && s.url.startsWith('https://'))
      .map((s) => ({ url: s.url, name: typeof s.name === 'string' && s.name.length > 0 ? s.name : null }))
    : [];
  // Attribution overrides for ccserver-notify payloads (see notify.js):
  // notify.hostname pins the "_from:" host when the OS hostname is opaque or
  // several hosts share a webhook (CCSERVER_HOSTNAME env wins over both, set
  // in loadNotifyConfig); notify.attribution === false strips the footer
  // entirely (default on).
  const notifyHostname = typeof rawNotify.hostname === 'string' && rawNotify.hostname.length > 0 ? rawNotify.hostname : null;
  const notifyAttribution = rawNotify.attribution !== false;
  // A `notify.vikunja` block left over from the removed Vikunja channel is
  // deliberately NOT parsed and NOT an error: an existing deployment's
  // sandbox.config.json must keep booting untouched. Say so once per process
  // so the operator knows the key is inert now (see the follow-up issue --
  // Vikunja is being re-cut as its own MCP server).
  //
  // The condition covers two shapes the old feature actually shipped with:
  //   - a `notify.vikunja` block of ANY type (review finding #5: `!= null`
  //     rather than a typeof check, so a `"vikunja": true` leftover is
  //     flagged for cleanup too -- it is inert either way),
  //   - a CCSERVER_VIKUNJA_* environment variable with no config block at all
  //     (review finding #2). That was not an edge case: the old docs
  //     *recommended* passing the secret apiToken via the environment, and
  //     baseUrl/projectId had env overrides too, so "env only, nothing in the
  //     config file" was a fully supported setup -- and the one that would
  //     otherwise be switched off in total silence.
  //
  // CCSERVER_VIKUNJA_TASKS_PATH is excluded: it is not connection config. It
  // only relocates the `.saved-vikunja-tasks.json` state file -- which the
  // notify guide tells operators they may keep for the re-cut server -- so a
  // host that set only that one never had a Vikunja delivery target, and
  // saying it lost one would be wrong. It is also a registry entry after
  // issue #201, which means testEnvDefaults.js sets it in every test process
  // to keep the suite off real host paths; treating it as "Vikunja is
  // configured" would fire this warning on every single run.
  const VIKUNJA_STATE_PATH_ENV = 'CCSERVER_VIKUNJA_TASKS_PATH';
  const hasLegacyVikunjaEnv = Object.keys(process.env)
    .some((k) => k.startsWith('CCSERVER_VIKUNJA_') && k !== VIKUNJA_STATE_PATH_ENV);
  if ((rawNotify.vikunja != null || hasLegacyVikunjaEnv) && !warnedVikunjaConfig) {
    warnedVikunjaConfig = true;
    const where = rawNotify.vikunja != null
      ? (hasLegacyVikunjaEnv
        ? '"notify.vikunja" and the CCSERVER_VIKUNJA_* environment variables are set but no longer do anything'
        : '"notify.vikunja" is set but no longer does anything')
      : 'the CCSERVER_VIKUNJA_* environment variables are set but no longer do anything';
    console.warn(
      `[config] ${where}: the Vikunja channel was removed from `
      + 'ccserver-notify and is being re-cut as a separate MCP server (issue #207). It is ignored, and it no '
      + 'longer counts as a notify delivery target -- if it was your only one, the notify MCP tool is now '
      + 'disabled entirely. Remove it to silence this.',
    );
  }
  const binds = Array.isArray(raw.binds) ? raw.binds : [];
  const env = (raw.env && typeof raw.env === 'object') ? raw.env : {};
  // Tools provisioned into the sandbox HOME at launch (rtk / code-review-graph).
  // This is the server-wide fallback (off unless enabled here); the client's
  // launch menu defaults them to ON per session/directory and its per-session
  // sandboxOpts.tools overrides this. See resolveTools.
  const tools = (raw.tools && typeof raw.tools === 'object' && !Array.isArray(raw.tools)) ? raw.tools : {};
  // How to launch claude. Overridable because the install location is
  // environment-specific (see resolveClaude). Env var wins over the config file.
  const claudeBin = process.env.CCSERVER_CLAUDE_BIN || (typeof raw.claudeBin === 'string' ? raw.claudeBin : null);
  // Which agent a new session launches when the client doesn't request one.
  // See appLaunch.js's APPS; anything else (including unset) falls back to
  // claude -- see loadSandboxConfig()'s defaultApp below.
  const defaultApp = raw.defaultApp === 'opencode' || raw.defaultApp === 'codex' ? raw.defaultApp : 'claude';
  // Show the client's top-bar Usage button (Claude Code /usage spend). Off
  // for setups that don't want it; the client also hides the button on its
  // own when claude is not installed (the capture would never succeed).
  const showUsage = raw.showUsage !== false;
  // OpenCode Go usage tab (GET /api/usage?app=opencode, backed by
  // server/opencodeUsage.js). An opencode CLI install alone says nothing
  // about a Go subscription, so this is a separate toggle: false hides the
  // tab entirely (no key is read, no request is sent). Default on -- when on,
  // visibility is still auto-gated on the Go API key actually existing
  // (~/.local/share/opencode/auth.json's "opencode-go" entry, see
  // opencodeGoAvailable()) and on the subscription being valid (a 403
  // surfaces as an in-popover "no subscription" message, not a silent hide).
  // Env var CCSERVER_OPENCODE_GO_USAGE wins over the config file (0/false/
  // off/no = off, 1/true/on/yes = on).
  const opencodeGoUsage = resolveFlag(process.env.CCSERVER_OPENCODE_GO_USAGE, raw.opencodeGoUsage, true);
  // The Usage MCP is exposed to every Claude session, so keep it opt-in
  // independently of the UI's showUsage setting.
  const usageMcp = raw.usageMcp === true;
  // Issue #198: the broker's privacy-preserving local aggregate is off unless
  // the operator explicitly enables it and names a local state file. Keeping
  // the path out of every report row avoids ever recording a project path.
  // The path must be ABSOLUTE: a relative one would resolve against whatever
  // cwd ccserver happened to be started from (usually the repo checkout) --
  // i.e. exactly the sandbox-writable tree the aggregate has to stay out of,
  // where a session could forge or suppress counts. index.js additionally
  // refuses to boot when this file falls inside browseRoots.
  const rawGhUsageRecording = (raw.ghUsageRecording && typeof raw.ghUsageRecording === 'object') ? raw.ghUsageRecording : {};
  const ghUsageFile = typeof rawGhUsageRecording.file === 'string' && isAbsolute(rawGhUsageRecording.file) ? rawGhUsageRecording.file : null;
  const ghUsageRecording = {
    enabled: rawGhUsageRecording.enabled === true && ghUsageFile !== null,
    file: ghUsageFile,
  };
  // Launch options to hide from every picker (issue #105): apps the operator
  // hasn't contracted for. Server-side install detection alone can't tell
  // "not installed" apart from "installed but not contracted", so this is a
  // manual allowlist-style exclusion. Unknown entries are silently dropped
  // (a typo degrades to "no effect" rather than refusing to boot -- see
  // selectableAppIds() below for the one case that DOES refuse to boot).
  const hiddenApps = Array.isArray(raw.hiddenApps)
    ? [...new Set(raw.hiddenApps.filter((a) => APP_IDS.includes(a)))]
    : [];
  // browseRoots (issue #189): restricts /api/files, /api/dirs and
  // /ws/terminal session cwds to these directories (and their subtrees).
  // [] (default) preserves the pre-#189 host-wide behavior.
  const browseRoots = normalizeBrowseRoots(raw.browseRoots);
  // Present-but-unusable (non-array, or every entry dropped) must NOT
  // silently collapse to [] ("unrestricted"): that would turn a typo like
  // "browseRoots": "/srv/repos" into a host-wide downgrade. An unparseable
  // config file is treated the same way (we cannot know what browseRoots
  // said). An explicit [] stays valid -- it is the documented
  // "unrestricted" spelling. Partial drops (e.g. ["/srv", 42]) still
  // restrict by the valid entries, so they are fail-safe, not invalid.
  const browseRootsPresent = raw.browseRoots !== undefined && raw.browseRoots !== null;
  const browseRootsEmptyArray = Array.isArray(raw.browseRoots) && raw.browseRoots.length === 0;
  const browseRootsInvalid = configError !== null
    || (browseRootsPresent && !browseRootsEmptyArray && browseRoots.length === 0);
  // THE effective "every session must be sandboxed" flag, decided once, here.
  //
  // browseRoots implies it. browseRoots only narrows what the WEB UI may
  // browse and launch into -- it does not confine a process once started. An
  // unsandboxed agent is a coding agent: it runs shell commands, so `cd` and
  // `cat` walk straight out of the roots. So "browseRoots is set" and "a
  // session may run unsandboxed" were never compatible; the config merely let
  // an operator ask for a containment the implementation could not give.
  //
  // Collapsing it to one value here is the point. The old arrangement derived
  // this judgement separately in createSession (mustSandboxShell /
  // mustSandboxAgent) and in the Web UI (which looked only at the explicit
  // forceSandbox) -- and the UI's copy was the incomplete one, so it offered
  // an unsandboxed launch the server then overrode, and then displayed the
  // running session as unsandboxed (issue #251). Everything downstream now
  // reads this single field.
  // browseRootsInvalid is included deliberately: a browseRoots the operator
  // wrote but spelled wrong normalizes to [], and without this a BROKEN
  // restriction would read as NO restriction. Sessions already fail closed on
  // it (createSession refuses them outright), but usage.js/codexUsage.js only
  // consult forceSandbox -- so leaving it out would let the usage capture
  // direct-launch an agent on the host on exactly the config the operator
  // meant to lock down. Fail closed, consistently.
  const forceSandbox = forceSandboxExplicit || browseRoots.length > 0 || browseRootsInvalid;
  // Which of the two causes is in effect -- for WORDING ONLY (refusal text,
  // UI notes). Never branch policy on it: that is what forceSandbox is for.
  const forceSandboxReason = !forceSandbox ? null : (forceSandboxExplicit ? 'config' : 'browseRoots');

  // allowUnsandboxedAgents (retired). It used to let an agent run unsandboxed
  // while browseRoots was set. It never delivered what its name promised --
  // see above -- so it is ignored rather than honoured. Warned about, not
  // silently dropped: a host that still sets it is a host whose operator
  // believes agents run unsandboxed there, and they now do not. Same
  // once-per-process shape as the retired notify.vikunja key above.
  if (raw.allowUnsandboxedAgents !== undefined && !warnedAllowUnsandboxedAgents) {
    warnedAllowUnsandboxedAgents = true;
    console.warn(
      '[config] "allowUnsandboxedAgents" has been retired and is ignored. It allowed an agent to run '
      + 'outside the sandbox while "browseRoots" was set, but an agent that can run shell commands simply '
      + 'walks out of those roots, so the setting promised a containment it never provided. '
      + (browseRoots.length > 0
        ? 'Because "browseRoots" is set, agent sessions are now always sandboxed.'
        : '"browseRoots" is not set here, so nothing changes for this host.')
      + ' Remove the key to silence this.',
    );
  }
  // Network isolation (qemu backend, Go broker): the broker always starts
  // 'open' and the running-session toggle flips it to enforce. Parse is
  // shared with getNetworkSettings() (networkAllowlist.js, what the Settings
  // GUI shows/saves) via normalizeNetworkSettings so the two structurally
  // cannot drift apart -- see that function's header comment.
  const network = normalizeNetworkSettings(raw.network);
  // qemu-only network policy (Go broker, see the ccserver-netbroker README): HTTPS
  // interception, HTTP rules, DLP, credential injection, request logging.
  // Passed through verbatim -- the broker validates them and refuses to
  // start on any error, which fails the launch (fail closed).
  const rawNet = (raw.network && typeof raw.network === 'object' && !Array.isArray(raw.network)) ? raw.network : {};
  const networkAdvanced = {};
  for (const k of ['mitm', 'rules', 'dlp', 'inject', 'log']) {
    if (rawNet[k] !== undefined) networkAdvanced[k] = rawNet[k];
  }
  // Linux isolation backend: 'bwrap' (default, namespaces) or 'qemu' (a KVM
  // VM per session, see sandbox-qemu.js). Anything else falls back to bwrap.
  // CCSERVER_SANDBOX_BACKEND wins over the file.
  const backendRaw = process.env.CCSERVER_SANDBOX_BACKEND || raw.backend;
  const backend = backendRaw === 'qemu' ? 'qemu' : 'bwrap';
  const qemuRaw = (raw.qemu && typeof raw.qemu === 'object' && !Array.isArray(raw.qemu)) ? raw.qemu : {};
  const qemu = {};
  for (const [k, { min, max, def }] of Object.entries(QEMU_RESOURCE_LIMITS)) {
    const v = qemuRaw[k];
    qemu[k] = Number.isInteger(v) && v >= min && v <= max ? v : def;
  }
  // Sessions share one persistent VM (qemuVmPool.js) instead of each
  // booting its own. A VM template's own flag wins over this.
  qemu.persistent = qemuRaw.persistent === true;
  return {
    docker, persistentHome, gpg, sshAgent, gpgVault, gitBroker, commitMessageGuard, forceSandbox, forceSandboxReason, binds, env, tools, claudeBin, defaultApp, showUsage, opencodeGoUsage, usageMcp, ghUsageRecording, hiddenApps, browseRoots, browseRootsInvalid, configError, network, networkAdvanced, backend, qemu,
    notify: {
      discordWebhook, subscriptions, hostname: notifyHostname, attribution: notifyAttribution,
      // Agent notification bridge (plan-notify-bridge). Parsed by the same
      // normalizer the Settings GUI's read/write boundary uses, so the two
      // structurally cannot disagree about what the file says -- exactly the
      // arrangement `network` above has with normalizeNetworkSettings.
      bridge: normalizeBridgeSettings(rawNotify.bridge),
    },
    configPath,
  };
}

// Which tools to provision into the sandbox HOME, and their pinned specs.
// sandbox.config.json's "tools" supplies the server-wide fallback (off unless
// enabled there); the client's per-session sandboxOpts.tools -- which the launch
// menu defaults to OFF (opt-in), remembered per directory
// (see DirectoryBrowser) -- overrides it. Returns { rtk, codeReviewGraph,
// rtkSpec, crgSpec } where rtkSpec/crgSpec are the { version, url, sha256, ... }
// payloads for sandbox-provision.sh (null when the tool is disabled).
export function resolveTools(sandboxOpts = null, cfgTools = null) {
  // cfgTools threads through an already-loaded config (createSession /
  // buildSandboxSpawn read sandbox.config.json once per launch) instead of
  // re-reading + re-parsing it here on every call.
  const cfg = cfgTools ?? loadSandboxConfig().tools;
  const per = (sandboxOpts && sandboxOpts.tools && typeof sandboxOpts.tools === 'object') ? sandboxOpts.tools : {};
  const resolve = (jsKey, cfgKeys, def) => {
    // Per-session values are client-controlled toggles: booleans only. The
    // object form (version/url/sha256 overrides) is operator-only and read
    // solely from sandbox.config.json below -- accepting it from the client
    // would let any WS caller point the provisioner at an arbitrary URL
    // (with an empty sha256 skipping the checksum) or an arbitrary pip
    // version.
    // A null def means this host arch has no pinned binary (see RTK_DEFAULT):
    // toggles resolve to disabled unless the operator pins an explicit url
    // in the object form below.
    if (per[jsKey] !== undefined) return per[jsKey] === true ? (def && { ...def }) : null;
    const v = cfgKeys.map((k) => cfg[k]).find((x) => x !== undefined);
    if (v === true) return def && { ...def };
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      if (v.enabled === false) return null;
      const { enabled, ...overrides } = v;
      if (!def && !overrides.url) return null;
      return { ...(def || {}), ...overrides };
    }
    return null;
  };
  const rtkSpec = resolve('rtk', ['rtk'], RTK_DEFAULT);
  const crgSpec = resolve('codeReviewGraph', ['code-review-graph', 'codeReviewGraph'], CRG_DEFAULT);
  return { rtk: !!rtkSpec, codeReviewGraph: !!crgSpec, rtkSpec, crgSpec };
}

// Which opt-in tools can actually be provisioned on this host, keyed by the
// same ids resolveTools() uses. Exposed via GET /dirs/home so the launch /
// settings UIs can render the toggles disabled-with-an-explanation (mirrors
// availableApps for agent CLIs) instead of offering a checkbox the server
// silently ignores. The tools are provisioned by bwrap's mount-bound
// provisioner only (the qemu VM never gets them), so this is bwrap's answer
// whatever the default backend is; the launch UI greys them out for a VM.
export function sandboxToolsAvailable() {
  const ok = sandboxAvailable('bwrap');
  return { rtk: ok, codeReviewGraph: ok };
}

// Locate an executable named `cmd` on the given PATH (or return it as-is if
// it already looks like a path). Mirrors `command -v` without spawning a
// shell. Defaults to the sandbox's own runtime PATH (see SANDBOX_PATH) since
// that -- not the host ccserver process's PATH -- is what actually resolves
// the command once launched.
function which(cmd, pathEnv = SANDBOX_PATH) {
  if (!cmd) return null;
  // A path-form command (e.g. a configured claudeBin like "/usr/bin/claude")
  // must still exist and be executable on the host -- a stale config pointing
  // at a removed CLI would otherwise read as "found" and defeat the
  // availability detection that greys it out client-side.
  if (cmd.includes('/')) {
    try {
      const st = statSync(cmd);
      if (st.isFile() && (st.mode & 0o111)) return cmd;
    } catch { /* not here */ }
    return null;
  }
  for (const dir of (pathEnv || '').split(':')) {
    if (!dir) continue;
    const p = join(dir, cmd);
    try {
      const st = statSync(p);
      if (st.isFile() && (st.mode & 0o111)) return p;
    } catch { /* not here */ }
  }
  return null;
}

// Given the host path of an agent launcher, return the directory that must be
// exposed read-only inside the sandbox for it to actually run — or null if it
// already lives under an always-exposed tree.
//
// Distro/system installs often put a tiny shell wrapper on PATH (e.g.
// /usr/bin/claude) that execs the real, self-contained binary from elsewhere
// (e.g. /opt/claude-code/bin/claude). The sandbox binds /usr but not /opt, so
// the wrapper runs while its target is missing -> exit 127 ("No such file or
// directory"). We follow the wrapper to the real binary and bind its tree.
function appInstallDir(onHost) {
  let real = onHost;
  try { real = realpathSync(onHost); } catch { /* keep as given */ }

  // A small text file on PATH is almost certainly a shell wrapper; follow the
  // absolute path it execs to reach the real binary.
  try {
    const st = statSync(real);
    if (st.isFile() && st.size < 64 * 1024) {
      const text = readFileSync(real, 'utf-8');
      if (text.startsWith('#!')) {
        const m = text.match(/\bexec\s+"?(\/[^\s"']+)"?/);
        if (m) { try { real = realpathSync(m[1]); } catch { real = m[1]; } }
      }
    }
  } catch { /* binary / unreadable: not a wrapper */ }

  // Already reachable inside the sandbox? Nothing extra to bind.
  const exposed = ['/usr/', '/bin/', '/lib/', '/lib64/', '/etc/'];
  if (exposed.some((p) => real.startsWith(p))) return null;
  if (real.startsWith(`${join(HOME, '.local')}/`)) return null; // ~/.local/bin is bound

  // Bind the install root: the parent of a trailing bin/ (so sibling assets
  // come along), else the directory holding the binary.
  let dir = dirname(real);
  if (dir.endsWith('/bin')) dir = dirname(dir);
  return dir;
}

// Locate an agent CLI even when the server runs under a bare PATH that misses
// the install (e.g. systemd's default PATH lacks nvm's bin and ~/.local/bin):
// PATH first (bare name works inside the sandbox too), then the server
// process's own bin dir (node itself came from nvm), ~/.local/bin, and any
// app-specific extras. Returns { command, path } where `command` is the bare
// name when PATH resolves it, else an absolute path — or null if not found.
function resolveAgentCommand(cmd, extraDirs = []) {
  const onPath = which(cmd);
  if (onPath) return { command: cmd, path: onPath };

  const candidates = [
    dirname(process.execPath),
    join(HOME, '.local', 'bin'),
    '/opt/homebrew/bin',              // Homebrew (macOS Apple Silicon)
    '/home/linuxbrew/.linuxbrew/bin', // Linuxbrew
    ...extraDirs,
  ];
  for (const dir of candidates) {
    const p = join(dir, cmd);
    try {
      const st = statSync(p);
      if (st.isFile() && (st.mode & 0o111)) return { command: p, path: p };
    } catch { /* not here */ }
  }
  return null;
}

// Resolve how launches should invoke an agent CLI, plus the host path (if any)
// that must be exposed read-only in the sandbox for that invocation to work.
//   command     - argv[0] to run inside the sandbox
//   hostCommand - absolute host path of the same binary (when found), for
//                 NON-sandboxed host spawns. Never null when found is true.
//   installDir  - extra ro-bind so the resolved binary is present, or null
//   found       - whether the CLI actually resolved somewhere searchable. When
//                 false, `command` is only a fallback bare name that will fail
//                 at spawn time (execvp ENOENT) -- callers should refuse the
//                 launch up front instead (see sessionManager's not-installed
//                 error and installedApps()).
//
// claude: "claude" (so the sandbox's PATH resolves it) unless overridden via
//   CCSERVER_CLAUDE_BIN / "claudeBin" in the sandbox config.
// opencode: the resolved absolute path. Its install (e.g. an nvm bin dir) is
//   typically NOT on the sandbox PATH, so the absolute path + installDir bind
//   is required for it to run inside the sandbox.
// codex: like claude, a bare name first (~/.local/bin is searched as a
//   fallback); falls back to an absolute path for installs PATH can't see.
//
// Why two spellings: `command` is resolved against SANDBOX_PATH, which can
// see installs the server process's own PATH cannot (e.g. ~/.local/bin
// missing from a GUI/systemd-launched server's PATH). Spawning that bare
// name on the HOST then dies immediately with exit 1 and no output, while
// shells (absolute /bin/bash) survive -- so host spawns must use
// `hostCommand` instead (see sessionManager's non-sandbox branch). Sandbox
// launches keep `command`: their own PATH resolves it identically.
export function resolveApp(app, configuredBin = loadSandboxConfig().claudeBin) {
  if (app === 'opencode') {
    const r = resolveAgentCommand('opencode', [join(HOME, '.opencode', 'bin')]);
    if (r) {
      let real = r.path;
      try { real = realpathSync(r.path); } catch { /* keep as given */ }
      return { command: real, hostCommand: real, installDir: appInstallDir(real), found: true };
    }
    return { command: process.platform === 'win32' ? 'opencode.exe' : 'opencode', hostCommand: null, installDir: null, found: false };
  }
  if (app === 'codex') {
    const r = resolveAgentCommand('codex', [join(HOME, '.local', 'bin')]);
    if (r) return { command: r.command, hostCommand: r.path, installDir: appInstallDir(r.path), found: true };
    return { command: process.platform === 'win32' ? 'codex.exe' : 'codex', hostCommand: null, installDir: null, found: false };
  }
  const command = configuredBin || (process.platform === 'win32' ? 'claude.exe' : 'claude');
  const r = resolveAgentCommand(command);
  // Keep the bare name when PATH resolves it (the sandbox PATH can too); use
  // an absolute path for installs PATH can't see (e.g. systemd).
  if (r) return { command: r.command, hostCommand: r.path, installDir: appInstallDir(r.path), found: true };
  return { command, hostCommand: null, installDir: null, found: false };
}

// Whether the resolved opencode binary at `hostCommand` accepts --standalone
// (added in opencode 2.0.0 alongside the machine-wide "managed background
// service" singleton it opts out of -- see appLaunch.js's appStandaloneArgs
// comment for why that flag matters to ccserver). Older opencode CLIs (1.x)
// reject unknown flags outright (`yargs` strict mode: prints usage, exits 1,
// never launches) -- verified against a cached opencode 1.18.29 binary --
// so this must be checked per-install rather than assumed. `--version`
// output has changed shape across releases ("1.18.29" vs "opencode v2.0.12"),
// hence the loose regex instead of an exact parse. Spawning `--version` is
// ~0.2-1s on this host, too slow to pay on every session launch, so results
// are cached by resolved path + mtime (an in-place upgrade, e.g. via
// pacman/npm to the same path, changes mtime and is picked up without a
// ccserver restart).
const opencodeStandaloneCache = new Map(); // hostCommand -> { mtimeMs, supported }
export function opencodeSupportsStandalone(hostCommand) {
  if (!hostCommand) return false;
  let mtimeMs;
  try { mtimeMs = statSync(hostCommand).mtimeMs; } catch { return false; }
  const cached = opencodeStandaloneCache.get(hostCommand);
  if (cached && cached.mtimeMs === mtimeMs) return cached.supported;
  let supported = false;
  try {
    const out = execFileSync(hostCommand, ['--version'], { encoding: 'utf8', timeout: 5000 });
    const match = out.match(/(\d+)\.\d+\.\d+/);
    supported = !!match && Number(match[1]) >= 2;
  } catch { /* unreadable/unexpected output -- assume unsupported, stay safe */ }
  opencodeStandaloneCache.set(hostCommand, { mtimeMs, supported });
  return supported;
}

// Which agent CLIs are actually launchable on this host, keyed by app id.
// Exposed via GET /dirs/home so the client can grey out (and the server can
// refuse) launches of uninstalled apps. A few statSync calls per request --
// recomputed every call, no caching needed. claude respects the claudeBin
// override (resolveApp does), so a configured but missing path reads false.
export function installedApps() {
  return {
    claude: resolveApp('claude').found,
    opencode: resolveApp('opencode').found,
    codex: resolveApp('codex').found,
  };
}

// Whether the installed opencode can run in chat mode (opencode >= 2, see
// appLaunch.js's appSupportsChat). Cached per binary like the probe itself.
export function opencodeChatAvailable() {
  const r = resolveApp('opencode');
  return !!r.found && opencodeSupportsStandalone(r.hostCommand);
}

// The app ids actually offered by the launch pickers: installed on this host
// AND not hidden via sandbox.config.json's hiddenApps (issue #105). Used by
// the server-startup guard (index.js) to refuse to boot when hiddenApps has
// hidden every installed CLI -- a silently empty picker across all 5 launch
// screens would otherwise ship with no way to start a session at all.
export function selectableAppIds() {
  const installed = installedApps();
  const { hiddenApps } = loadSandboxConfig();
  return APP_IDS.filter((app) => installed[app] && !hiddenApps.includes(app));
}

// Whether `app` has been hidden via sandbox.config.json's hiddenApps (issue
// #105). Every enforcement site that guards a real spawn against a hidden
// app (createSession, the claude/codex usage captures) shares this instead
// of re-deriving `loadSandboxConfig().hiddenApps.includes(...)` separately,
// so the check itself can't drift between them even though each site's
// error message and return shape stays its own.
export function isAppHidden(app) {
  return !!app && loadSandboxConfig().hiddenApps.includes(app);
}

// Backwards-compatible alias used by the claude-only /usage capture.
export function resolveClaude(configuredBin = loadSandboxConfig().claudeBin) {
  return resolveApp('claude', configuredBin);
}

// Swap a leading bare `claude`/`opencode`/`codex` in a
// target command for the resolved launcher, leaving non-agent targets (e.g. a
// shell) untouched. Absolute commands (e.g. resolved opencode paths) pass
// through as-is.
function withClaude(targetCommand, command) {
  if (targetCommand[0] === 'claude' || targetCommand[0] === 'claude.exe'
    || targetCommand[0] === 'opencode' || targetCommand[0] === 'opencode.exe'
    || targetCommand[0] === 'codex' || targetCommand[0] === 'codex.exe') {
    return [command, ...targetCommand.slice(1)];
  }
  return targetCommand;
}

// The host's gpg socket directory (e.g. /run/user/UID/gnupg), where the live
// gpg-agent / keyboxd sockets live.
function hostGpgSocketDir() {
  try {
    return execFileSync('gpgconf', ['--list-dirs', 'socketdir'], {
      timeout: 2000, encoding: 'utf-8',
    }).trim() || null;
  } catch {
    return null;
  }
}

function sshAddStatus(sock) {
  // ssh-add -l exit codes: 0 = identities listed, 1 = agent reachable but
  // empty, 2 = cannot connect.
  try {
    execFileSync('ssh-add', ['-l'], {
      env: { ...process.env, SSH_AUTH_SOCK: sock },
      timeout: 2000,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return 0;
  } catch (err) {
    return typeof err.status === 'number' ? err.status : 2;
  }
}

// Discover a usable SSH agent socket owned by the current user. ccserver runs
// as a service, so its own SSH_AUTH_SOCK usually points at an empty systemd
// agent; the useful keys live in a forwarded agent whose path (typically under
// /tmp) changes per login. Scan the likely spots and prefer a socket that
// actually has identities loaded.
export function discoverSshAuthSock() {
  if (typeof process.getuid !== 'function') return null;
  const uid = process.getuid();
  const candidates = [];

  // Forwarded agents: /tmp/ssh-XXXX/agent.NNN
  try {
    for (const d of readdirSync('/tmp')) {
      if (!d.startsWith('ssh-')) continue;
      const dir = join('/tmp', d);
      try {
        for (const f of readdirSync(dir)) {
          if (f.startsWith('agent.')) candidates.push(join(dir, f));
        }
      } catch { /* unreadable dir */ }
    }
  } catch { /* ignore */ }

  // Well-known runtime sockets.
  for (const p of [
    join(XDG_RUNTIME_DIR, 'openssh_agent'),
    join(XDG_RUNTIME_DIR, 'ssh-agent.socket'),
    join(XDG_RUNTIME_DIR, 'keyring', 'ssh'),
    join(XDG_RUNTIME_DIR, 'gcr', 'ssh'),
  ]) candidates.push(p);

  // macOS agents live outside the Linux runtime conventions above: 1Password
  // and Secretive expose fixed-path sockets under ~/Library, and the system
  // ssh-agent listens under a per-boot launchd dir. Missing paths are
  // skipped by the stat gate below, so pushing them unconditionally here is
  // harmless on hosts without these agents.
  if (process.platform === 'darwin') {
    try {
      const home = homedir();
      candidates.push(
        join(home, 'Library', 'Group Containers', '2BUA8C4S2C.com.1password', 't', 'agent.sock'),
        join(home, 'Library', 'Containers', 'com.maxgoedjen.secretive.Secretive', 'Data', 'socket.ssh'),
      );
    } catch { /* homedir unavailable -- skip */ }
    try {
      for (const d of readdirSync('/private/tmp')) {
        if (!d.startsWith('com.apple.launchd.')) continue;
        candidates.push(join('/private/tmp', d, 'Listeners'));
      }
    } catch { /* no launchd dir visible */ }
  }

  // ccserver's own env, if any (often the empty agent — lowest priority).
  if (process.env.SSH_AUTH_SOCK) candidates.push(process.env.SSH_AUTH_SOCK);

  // Keep sockets owned by us; dedupe preserving order.
  const seen = new Set();
  const socks = [];
  for (const p of candidates) {
    if (seen.has(p)) continue;
    seen.add(p);
    try {
      const st = statSync(p);
      if (st.isSocket() && st.uid === uid) socks.push(p);
    } catch { /* missing */ }
  }
  if (socks.length === 0) return null;

  // Prefer a socket with identities loaded; else the first reachable one.
  let firstReachable = null;
  for (const sock of socks) {
    const status = sshAddStatus(sock);
    if (status === 0) return sock;
    if (status === 1 && !firstReachable) firstReachable = sock;
  }
  return firstReachable || socks[0];
}

// Check that the tools needed for the docker-enabled sandbox are present.
export function dockerSandboxAvailable() {
  if (process.platform !== 'linux') return false;
  return [BWRAP, ROOTLESSKIT, '/usr/bin/slirp4netns', '/usr/bin/newuidmap']
    .every((p) => existsSync(p));
}

// The Linux backend the operator configured (sandbox.config.json backend):
// the default for launches that do not pick one.
function linuxBackendChoice() {
  return loadSandboxConfig().backend;
}

// The Linux backend one launch uses: sandboxOpts.backend ('bwrap' | 'qemu',
// picked in the launch options) or, absent / anything else, the configured
// default. A picked backend is never swapped for another one: when it cannot
// run here, the launch is refused (see sessionManager's sandbox guards).
export function resolveSandboxBackend(sandboxOpts = null) {
  const picked = sandboxOpts?.backend;
  return picked === 'bwrap' || picked === 'qemu' ? picked : linuxBackendChoice();
}

// Whether `backend` (default: the configured one) can sandbox a launch here.
export function sandboxAvailable(backend = linuxBackendChoice()) {
  if (process.platform !== 'linux') return false;
  if (backend === 'qemu') return qemuStatus().ok;
  return existsSync(BWRAP);
}

// Which isolation backend a sandboxed launch would use on this host by
// default: 'bwrap' / 'qemu' (Linux, per sandbox.config.json backend), or 'none'.
export function sandboxBackend() {
  const backend = linuxBackendChoice();
  return sandboxAvailable(backend) ? backend : 'none';
}

// Per-backend availability for the launch options' backend picker
// (/api/dirs/home's sandboxBackends).
export function backendStatus() {
  const linux = process.platform === 'linux';
  const qemu = linux ? qemuStatus() : { ok: false, reason: 'the qemu sandbox is Linux-only', hint: null };
  return {
    default: linuxBackendChoice(),
    bwrap: linux && existsSync(BWRAP)
      ? { ok: true, reason: null }
      : { ok: false, reason: linux ? 'bwrap (bubblewrap) is not installed' : 'the sandbox is Linux-only' },
    qemu: { ok: qemu.ok, reason: qemu.reason, hint: qemu.hint },
  };
}

// Platform-aware refusal text shared by sessionManager's three sandbox
// guards, so the install hint can't drift between them.
export function sandboxUnavailableReason(backend = linuxBackendChoice()) {
  if (process.platform === 'win32') {
    return {
      reason: 'the sandbox is Linux-only',
      hint: 'Launch without the sandbox.',
    };
  }
  if (IS_MACOS) {
    return {
      reason: 'sandbox support is unavailable on macOS',
      hint: 'Launch without the sandbox.',
    };
  }
  if (backend === 'qemu') {
    const st = qemuStatus();
    return { reason: `the qemu sandbox is unavailable: ${st.reason}`, hint: `${st.hint} Or pick bwrap, or launch without the sandbox.` };
  }
  return {
    reason: 'bwrap is not available on this host',
    hint: 'Install bwrap (bubblewrap) or launch without the sandbox.',
  };
}

export function forceSandboxUnavailableReason(backend = linuxBackendChoice()) {
  // Keeps the historical Linux/Windows suffix byte-identical.
  if (IS_MACOS) {
    return {
      reason: 'sandbox support is unavailable on macOS',
      hint: 'Disable forceSandbox.',
    };
  }
  if (process.platform === 'win32') {
    return {
      reason: 'the sandbox is Linux-only',
      hint: 'Install bwrap (bubblewrap) or disable forceSandbox.',
    };
  }
  if (backend === 'qemu') {
    const st = qemuStatus();
    return { reason: `the qemu sandbox is unavailable: ${st.reason}`, hint: `${st.hint} Or pick bwrap, or disable forceSandbox.` };
  }
  return {
    reason: 'bwrap is not available on this host',
    hint: 'Install bwrap (bubblewrap) or disable forceSandbox.',
  };
}

// Writes this launch's commit-message guard config (built-in patterns +
// sandbox.config.json's commitMessageGuard.blockedPatterns, see
// commitGuard.js) to a fresh runtime-dir JSON file that
// sandbox-commit-msg-hook.cjs ro-binds and reads. Unlike startGitBroker,
// there's no live process/socket to keep running -- once the file exists on
// disk, setup is done -- so this is a plain sync write, not a spawn+probe.
// Returns null on any failure (fail-open: the caller then skips wiring the
// commit-msg hook into bwrap entirely rather than fail the whole session
// launch over a guard that only ever adds an extra local commit check).
function startCommitGuard(blockedPatterns) {
  const dir = join(XDG_RUNTIME_DIR, `ccserver-commit-guard-${randomUUID()}`);
  try {
    // darwin: the base may be a hostile other-UID dir under sticky /tmp --
    // same fail-closed verification as startGitBroker (git-broker.js). A
    // throw here lands in the catch below (guard disabled), never writes
    // the config into a directory a hostile local user owns.
    ensureHostRuntimeDir();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const configPath = join(dir, 'commit-guard.json');
    writeFileSync(configPath, JSON.stringify(buildGuardConfig(blockedPatterns)));
    return { dir, configPath };
  } catch (e) {
    console.warn(`[sandbox] failed to set up commit-message guard: ${e.message}`);
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* nothing to clean up */ }
    return null;
  }
}

// Build the bwrap arguments (everything after the `bwrap` executable, up to
// but not including the trailing `-- <cmd...>`).
//   homeDir - host path of the persistent per-project HOME to bind at HOME
//             (see persistentHomeDir), or null for a fresh tmpfs HOME.
//   app     - which agent is being launched (used for CLI-specific sandbox setup)
//   tools   - resolved opt-in tool specs (see resolveTools), or null when no
//             tool is enabled. Binds the provisioner and hands it the specs
//             via env (see the tail of this function).
//   commitGuard - { dir, configPath } from startCommitGuard(), or null when
//             the commit-message guard is disabled/unavailable for this launch.
//   usesRootlesskit - true when this launch is wrapped in rootlesskit (for a
//             nested dockerd), so bwrap must NOT also create its own user
//             namespace (rootlesskit's outer userns already provides one).
//   gpgVault - { fingerprint, nameReal, nameEmail } from
//             gpgVaultAgent.getPublicIdentity(), or null (plan:
//             gpg-agent-vault). Lock-independent -- no homeDir/sockets, see
//             getPublicIdentity()'s own comment (issue #185); the public
//             pubring/trustdb/gpg.conf files below are bound from
//             gpgVaultRelay's fixed relay dir instead of a per-launch
//             homeDir for the same reason. Resolved once by the caller
//             (buildSandboxSpawn), not fetched in here -- mirrors
//             gitBroker/commitGuard, which are also
//             caller-resolved objects.
function buildBwrapArgs({ cwd, docker, usesRootlesskit = docker, gpg, gpgVault = null, extraBinds, extraEnv, authSock, stateDir, claudeDir, gitBroker, commitGuard, notifySocketPath, usageSocketPath, homeDir = null, app = null, tools = null, chat = null }) {
  const args = [
    '--die-with-parent',
    // Own PID namespace so the whole sandbox tree is reaped as a unit. Without
    // it, the background dockerd is NOT a tracked --die-with-parent child: when
    // bwrap dies its descendants merely reparent (to systemd) and dockerd leaks,
    // keeping data-root/socket locks and blocking the next launch. With a pidns,
    // bwrap installs a reaper as pid 1 (reaps zombies from docker/containerd),
    // and the kernel SIGKILLs everything in the namespace once it exits.
    '--unshare-pid',
    // Read-only system
    '--ro-bind', '/usr', '/usr',
    '--symlink', 'usr/bin', '/bin',
    '--symlink', 'usr/sbin', '/sbin',
    '--symlink', 'usr/lib', '/lib',
    '--symlink', 'usr/lib64', '/lib64',
    '--ro-bind', '/etc', '/etc',
    '--ro-bind', '/sys', '/sys',
    '--proc', '/proc',
    '--dev', '/dev',
  ];

  // /tmp: with a persistent per-project HOME the project's /tmp persists too,
  // so tooling an agent installs into /tmp (e.g. an extracted Node runtime)
  // survives relaunches instead of being wiped every session. It lives under
  // the persistent home dir, so the reuse/wipe/delete flows for the HOME
  // govern it as well. With a fresh tmpfs HOME (persistentHome off, or the
  // minimal throwaway /usage sandbox) /tmp stays a plain tmpfs.
  if (homeDir) {
    const tmpDir = join(homeDir, '.ccserver-tmp');
    mkdirSync(tmpDir, { recursive: true });
    args.push('--bind', tmpDir, '/tmp');
  } else {
    args.push('--tmpfs', '/tmp');
  }

  // HOME: either the persistent per-project dir (writable, survives relaunches)
  // or a fresh tmpfs. Only the config below is exposed on top either way.
  if (homeDir) {
    args.push('--bind', homeDir, HOME);
  } else {
    args.push('--tmpfs', HOME);
  }

  // Always give the sandbox its own private, writable /run (a fresh tmpfs).
  // We deliberately do NOT reuse the host's /run: rootlesskit's older approach
  // of copying-up /run replaced live agent sockets (gpg) with dead copies. By
  // keeping /run private here and binding only what's needed, live host
  // sockets under /run stay reachable as bind sources (see gpg forwarding).
  args.push('--tmpfs', '/run', '--dir', XDG_RUNTIME_DIR);
  if (usesRootlesskit) {
    // rootlesskit (outer) provides the user namespace -- for a nested
    // dockerd its state dir holds the API socket dockerd needs.
    args.push('--bind', stateDir, stateDir);
  } else {
    // No outer rootlesskit: bwrap creates the user namespace itself.
    args.push('--unshare-user');
  }

  // The project directory (read-write).
  args.push('--bind', cwd, cwd);

  // ccserver-notify: the same wrapper script, reached with the 'notify' argv
  // so it reads CCSANDBOX_NOTIFY_MCP_SOCK (bound here) instead of
  // CCSANDBOX_NOTIFY_MCP_SOCK. Directory bind, same reasoning as the
  // other process-wide sockets.
  if (notifySocketPath) {
    args.push('--bind-try', dirname(notifySocketPath), dirname(SANDBOX_NOTIFY_SOCK_PATH));
    args.push('--setenv', 'CCSANDBOX_NOTIFY_MCP_SOCK', SANDBOX_NOTIFY_SOCK_PATH);
  }

  // ccserver-usage: same wrapper script again, reached with the 'usage' argv
  // so it reads CCSANDBOX_USAGE_MCP_SOCK (bound here) instead. Independent of
  // notify -- a claude session may have any combination of these sockets
  // bound. Directory bind, same reasoning as
  // above.
  if (usageSocketPath) {
    args.push('--bind-try', dirname(usageSocketPath), dirname(SANDBOX_USAGE_SOCK_PATH));
    args.push('--setenv', 'CCSANDBOX_USAGE_MCP_SOCK', SANDBOX_USAGE_SOCK_PATH);
  }

  // The bridge wrapper is shared by the notify and usage sockets
  // and its node shebang lives at
  // SANDBOX_NODE_PATH (ro-bound with the git-broker branch below).
  if (notifySocketPath || usageSocketPath) {
    args.push('--ro-bind', MCP_BRIDGE_SCRIPT, SANDBOX_MCP_BRIDGE_PATH);
  }

  // Chat mode: the bridge (run by SANDBOX_NODE_PATH, bound below) and its
  // per-session dir, writable so the bridge can create the relay socket and
  // remove the password file once read.
  if (chat) {
    args.push('--ro-bind', chatBridgeOf(chat), SANDBOX_CHAT_BRIDGE_PATH);
    args.push('--bind', chat.hostDir, SANDBOX_CHAT_DIR);
  }

  // Agent CLI configuration + install dirs (claude + opencode + codex),
  // writable so sessions/auth state survive across sandbox launches and
  // conversations can be resumed. ~/.local/bin is exposed so the user's own
  // tools resolve. opencode's XDG state dir (~/.local/state/opencode) holds
  // TUI-selected state (model.json, kv.json, session.json); without it the
  // Resolved from the shared agentConfigDirs() list in sandbox-paths.js.
  const appBindSrcs = agentConfigDirs(HOME);
  // Ensure the state/config homes a sandboxed CLI writes to exist so the rw
  // bind below applies even on a fresh host. Same subset as before: login /
  // cache dirs that may legitimately be absent (~/.claude etc., ~/.codex)
  // stay uncreated when missing.
  for (const src of appBindSrcs.filter((p) => p.endsWith(join('.local', 'state', 'opencode')))) {
    mkdirSync(src, { recursive: true });
  }
  const appBinds = appBindSrcs.map((src) => [src, 'rw']);
  for (const [src, mode] of appBinds) {
    if (existsSync(src)) {
      args.push(mode === 'ro' ? '--ro-bind' : '--bind', src, src);
    }
  }

  // ~/.local/bin handling. With the legacy tmpfs HOME it is ro-bound at its
  // real path so the user's own tools resolve. With a persistent HOME that ro
  // bind would sit ON TOP of the persistent home's own writable .local/bin,
  // silently blocking agent-installed tools (pip/npm --user console scripts)
  // from ever persisting. Instead the host bin is exposed at a secondary path
  // (…/.local/bin-host) appended to PATH, so both the persistent home's
  // agent-installed tools AND the host user's tools resolve.
  const hostLocalBin = join(HOME, '.local', 'bin');
  let sandboxPath = SANDBOX_PATH;
  if (homeDir) {
    const hostBinDest = join(HOME, '.local', 'bin-host');
    mkdirSync(join(homeDir, '.local', 'bin-host'), { recursive: true });
    args.push('--ro-bind-try', hostLocalBin, hostBinDest);
    sandboxPath = `${SANDBOX_PATH}:${hostBinDest}`;
  } else if (existsSync(hostLocalBin)) {
    args.push('--ro-bind', hostLocalBin, hostLocalBin);
  }

  // The agent install itself, when it lives outside the exposed trees (e.g.
  // /opt/claude-code reached via a /usr/bin/claude wrapper, or an opencode
  // binary under nvm). See appInstallDir.
  if (claudeDir && existsSync(claudeDir)) {
    args.push('--ro-bind', claudeDir, claudeDir);
  }

  // Persistent per-project docker data-root, mounted at the default location.
  if (docker) {
    const dataRoot = join(dindRoot(), slugify(cwd));
    mkdirSync(dataRoot, { recursive: true });
    args.push('--bind', dataRoot, join(HOME, '.local', 'share', 'docker'));
  }

  // Forward the SSH agent socket. Its path is dynamic (per login / forwarded
  // agent), so we take it from the server's environment rather than config.
  // It typically lives under /tmp, which rootlesskit does not copy-up, so the
  // live socket is reachable even with docker enabled.
  if (authSock && existsSync(authSock)) {
    args.push('--bind-try', authSock, authSock);
    args.push('--setenv', 'SSH_AUTH_SOCK', authSock);
  }

  // gpg-agent forwarding: bind ~/.gnupg (keys/keybox) plus the live host
  // agent/keyboxd sockets so signing uses the host agent (which holds the
  // token). Inside rootlesskit we run as uid 0, so gpg looks for its sockets
  // in ~/.gnupg; without rootlesskit (uid unchanged) it uses the runtime dir.
  if (gpg) {
    const gnupgHome = join(HOME, '.gnupg');
    if (existsSync(gnupgHome)) args.push('--bind', gnupgHome, gnupgHome);
    const hostSockDir = hostGpgSocketDir();
    if (hostSockDir) {
      const targetDir = docker ? gnupgHome : join(XDG_RUNTIME_DIR, 'gnupg');
      for (const name of ['S.gpg-agent', 'S.gpg-agent.extra', 'S.keyboxd', 'S.dirmngr']) {
        const src = join(hostSockDir, name);
        if (existsSync(src)) args.push('--bind-try', src, join(targetDir, name));
      }
    }
  }

  // GPG vault (plan: gpg-agent-vault): forward the MANAGED vault agent's
  // sockets instead -- a different, newer mechanism from the `gpg` block
  // above (which forwards the HOST's own already-unlocked gpg-agent). Its
  // own target dir (~/.gnupg-vault under docker, XDG_RUNTIME_DIR/gnupg-vault
  // otherwise) is deliberately distinct from `gnupgHome`/`gnupg` above so the
  // two mechanisms cannot collide on-path even if both are enabled at once
  // (buildSandboxSpawn warns when that happens). Security-critical: only
  // individual PUBLIC files (pubring.kbx/trustdb.gpg/gpg.conf) and the
  // relay's sockets are ever bound here -- never the whole homeDir -- so
  // private-keys-v1.d/, openpgp-revocs.d/, and sshcontrol stay unreachable
  // from the sandbox by construction. That alone is NOT sufficient (audit
  // F1): a socket onto the agent's main socket would still hand out the
  // secret key via KEYWRAP_KEY/EXPORT_KEY. The relay sockets bound here
  // reach only the agent's restricted extra socket, through a protocol
  // allowlist (gpgVaultRelay.js / gpgVaultRelayFilter.js).
  // gpgVault is the caller-resolved object (see this function's own header
  // comment) -- reused as-is by the git-identity injection further down.
  if (gpgVault) {
    const vault = gpgVault;
    const targetDir = docker ? join(HOME, '.gnupg-vault') : join(XDG_RUNTIME_DIR, 'gnupg-vault');
    args.push('--dir', targetDir);
    // Public metadata files, bound from gpgVaultRelay's fixed relay dir
    // (same source used by sandbox-paths.js).
    // rather than this launch's own homeDir: gpgVault is now lock-
    // independent (issue #185, getPublicIdentity()) and so no longer carries
    // a homeDir at all. Using --ro-bind-try (not --ro-bind) matters more
    // than before: a vault that has never been unlocked yet has nothing in
    // the relay dir, and the bind is simply skipped -- gpg then runs against
    // an empty GNUPGHOME, which is harmless (no secret key material is ever
    // placed there either way).
    for (const file of ['pubring.kbx', 'trustdb.gpg', 'gpg.conf']) {
      const src = join(gpgVaultRelay.getRelayDir(), file);
      args.push('--ro-bind-try', src, join(targetDir, file));
    }
    // Sockets bind from gpgVaultRelay.js's FIXED, generation-independent
    // paths -- never vault.sockets (this launch's own ephemeral generation)
    // directly. See gpgVaultRelay.js's header: this is what lets an
    // already-running sandbox keep working across a later lock+re-unlock
    // without a restart.
    const relaySockets = gpgVaultRelay.getRelaySocketPaths();
    for (const src of Object.values(relaySockets)) {
      args.push('--bind-try', src, join(targetDir, basename(src)));
    }
    // Without rootlesskit the sandbox keeps the host uid and has /run/user/<uid>
    // (XDG_RUNTIME_DIR above), so GnuPG looks for the agent socket of this
    // non-default GNUPGHOME under /run/user/<uid>/gnupg/d.<hash>/, NOT in
    // GNUPGHOME. The bind above alone would leave gpg unable to reach the relay:
    // it starts an empty agent of its own inside the sandbox and signing fails
    // with "No secret key" (see gnupgRunUserAgentSocket). Under rootlesskit the
    // uid is 0, /run/user/0 does not exist, and the GNUPGHOME bind is the one
    // GnuPG uses -- left exactly as it was.
    if (!usesRootlesskit) {
      args.push('--bind-try', relaySockets.agent, gpgVaultRelay.gnupgRunUserAgentSocket(targetDir, process.getuid()));
    }
    args.push('--setenv', 'GNUPGHOME', targetDir);
    // Unlike authSock above (bind source==dest, a live host path), the
    // vault's ssh socket lands at a different in-sandbox path, so
    // SSH_AUTH_SOCK must point at the bind TARGET here.
    args.push('--setenv', 'SSH_AUTH_SOCK', join(targetDir, basename(relaySockets.agentSsh)));
  }

  // gh: replace wherever it resolves (host PATH or common install paths)
  // with a wrapper that relays to the git-broker instead of running for
  // real inside the sandbox (see sandbox-gh-wrapper.cjs / ghAllowlist.js).
  // gh's own API calls go straight to api.github.com over TLS, so they
  // can't be scoped by inspecting network traffic the way HTTPS/SSH git
  // access is below; instead the broker executes a safelisted subset of gh
  // subcommands itself, on the host, after checking the target repo against
  // the same allow-list.
  //
  // git broker: repo-scoped HTTPS credential helper + SSH gate + gh
  // passthrough, all over one socket. Computed once at session start from
  // the cwd's own remotes + checked-out submodules (see gitAllowlist.js);
  // gitBroker is the {sockPath, allowlistPath} bag returned by
  // startGitBroker(), or null when disabled/unavailable.
  // The helper/wrapper scripts are Node scripts (shebang points at this
  // fixed path); bind the actual node binary here rather than assume
  // /usr/bin/node exists, mirroring how resolveApp follows the real
  // agent binary instead of assuming a host layout. Shared between the
  // git-broker machinery, MCP bridge wrapper, and commit-msg hook. The
  // commit-msg hook (below) is a Node script bound at a fixed
  // shebang path, so it needs this bind as well.
  if (gitBroker || commitGuard || notifySocketPath || usageSocketPath || chat) {
    const nodeBin = realpathSync(process.execPath);
    args.push('--ro-bind', nodeBin, SANDBOX_NODE_PATH);
  }

  if (gitBroker) {
    const ghCandidates = new Set(
      [which('gh'), '/usr/bin/gh', '/usr/local/bin/gh', '/opt/homebrew/bin/gh', join(HOME, '.local', 'bin', 'gh')].filter(Boolean),
    );
    for (const ghPath of ghCandidates) {
      if (existsSync(ghPath)) args.push('--ro-bind', GH_WRAPPER_SCRIPT, ghPath);
    }

    args.push('--ro-bind', CRED_HELPER_SCRIPT, SANDBOX_CRED_HELPER_PATH);
    args.push('--ro-bind', gitBroker.allowlistPath, SANDBOX_ALLOWLIST_PATH);
    args.push('--bind-try', gitBroker.sockPath, SANDBOX_BROKER_SOCK_PATH);

    const realSsh = which('ssh');
    if (realSsh && existsSync(realSsh)) {
      args.push('--ro-bind', realpathSync(realSsh), SANDBOX_REAL_SSH_PATH);
      // Overrides the earlier whole-/usr ro-bind (bwrap: last bind for a
      // given destination wins), so every ssh invocation inside the
      // sandbox -- not just git's -- passes through the wrapper first.
      args.push('--ro-bind', SSH_WRAPPER_SCRIPT, realSsh);
      args.push('--setenv', 'CCSANDBOX_REAL_SSH', SANDBOX_REAL_SSH_PATH);
      // realSsh (e.g. /usr/bin/ssh) is the path git will invoke; inside the
      // sandbox that path now resolves to the wrapper (bound above), so
      // pointing GIT_SSH_COMMAND at it routes git's ssh calls through the
      // gate even if something clears the ssh binary override.
      args.push('--setenv', 'GIT_SSH_COMMAND', realSsh);

      // Pin the wrapper's own `ssh -F` to a config that skips system/user
      // ssh config (see sandbox-ssh-config for why: root-owned files under
      // /etc/ssh map to nobody in bwrap's user namespace, so OpenSSH
      // refuses to Include them -- "Bad owner or permissions") and points
      // known_hosts at a bound-in file instead of the never-exposed
      // ~/.ssh. The host's own ~/.ssh/known_hosts isn't a secret (just
      // public host keys), so it's bound too, ahead of the pinned default,
      // for any host beyond the ones we pin.
      const userKnownHosts = join(HOME, '.ssh', 'known_hosts');
      if (existsSync(userKnownHosts)) {
        args.push('--ro-bind', userKnownHosts, SANDBOX_KNOWN_HOSTS_USER_PATH);
      }
      args.push('--ro-bind', DEFAULT_KNOWN_HOSTS, SANDBOX_KNOWN_HOSTS_DEFAULT_PATH);
      args.push('--ro-bind', SSH_CONFIG_FILE, SANDBOX_SSH_CONFIG_PATH);
      args.push('--setenv', 'CCSANDBOX_SSH_CONFIG', SANDBOX_SSH_CONFIG_PATH);
    }

    // Generated gitconfig points credential.helper at our script and forces
    // useHttpPath (see sandbox-gitconfig for why). Bound over HOME/.gitconfig
    // (a fresh tmpfs normally, or the persistent home's -- an agent-written
    // one is shadowed on purpose so the broker's credential helper can't be
    // overridden by a config that would leak credentials).
    args.push('--ro-bind', GENERATED_GITCONFIG, join(HOME, '.gitconfig'));

    args.push(
      // /etc is ro-bound wholesale above, so a host /etc/gitconfig with its
      // own credential.helper would otherwise still apply inside the
      // sandbox, alongside (or instead of) ours.
      '--setenv', 'GIT_CONFIG_NOSYSTEM', '1',
      '--setenv', 'CCSANDBOX_GIT_BROKER_SOCK', SANDBOX_BROKER_SOCK_PATH,
      '--setenv', 'CCSANDBOX_GIT_ALLOWLIST', SANDBOX_ALLOWLIST_PATH,
    );
    // Per-session broker connection token (git-broker.js). bwrap binds the
    // socket per-session so this is defense-in-depth here, but the broker
    // requires it unconditionally now -- so both backends must supply it.
    if (gitBroker.token) args.push('--setenv', 'CCSANDBOX_GIT_BROKER_TOKEN', gitBroker.token);
  }

  // Commit-message guard: an independently-toggled commit-msg hook (see
  // commitGuard.js / sandbox-commit-msg-hook.cjs) that blocks a `git commit`
  // whose message matches a blocked pattern (built-in: a Claude-Session:
  // trailer or a claude.ai/code/session_ URL -- see loadSandboxConfig's
  // commitMessageGuard). Unlike gitBroker above, this only concerns what a
  // LOCAL commit records -- no network/credential scope involved -- so it's
  // wired independently and stays active even when gitBroker is disabled.
  //
  // core.hooksPath (commit-guard, below) and user.signingkey/commit.gpgsign/
  // gpg.program/user.name/user.email (GPG vault, below) are set via the
  // GIT_CONFIG_COUNT/KEY/VALUE env mechanism (git 2.31+) instead of
  // overwriting ~/.gitconfig the way GENERATED_GITCONFIG does above:
  // gitBroker's ro-bind is safe to always apply (it replaces a file this
  // feature already fully owns, credential.helper), but doing the same thing
  // here would newly clobber an agent-written ~/.gitconfig (e.g. user.name/
  // user.email set inside a persistent HOME) that these features have no
  // business touching. Both features push into the same gitConfigEntries
  // list and share ONE GIT_CONFIG_COUNT -- a future feature reusing this
  // mechanism must do the same (push here) rather than add a second,
  // colliding GIT_CONFIG_COUNT block.
  const gitConfigEntries = [];

  // Commit-message guard: an independently-toggled commit-msg hook (see
  // commitGuard.js / sandbox-commit-msg-hook.cjs) that blocks a `git commit`
  // whose message matches a blocked pattern (built-in: a Claude-Session:
  // trailer or a claude.ai/code/session_ URL -- see loadSandboxConfig's
  // commitMessageGuard). Unlike gitBroker above, this only concerns what a
  // LOCAL commit records -- no network/credential scope involved -- so it's
  // wired independently and stays active even when gitBroker is disabled.
  if (commitGuard) {
    args.push('--ro-bind', COMMIT_MSG_HOOK_SCRIPT, SANDBOX_COMMIT_GUARD_HOOK_PATH);
    args.push('--ro-bind', commitGuard.configPath, SANDBOX_COMMIT_GUARD_CONFIG_PATH);
    args.push('--setenv', 'CCSANDBOX_COMMIT_GUARD_CONFIG', SANDBOX_COMMIT_GUARD_CONFIG_PATH);
    gitConfigEntries.push(['core.hooksPath', SANDBOX_COMMIT_GUARD_HOOKS_DIR]);
  }

  // GPG vault (plan: gpg-agent-vault): signs commits with the vault's key
  // and sets the committer identity to the SAME name/email used as the
  // key's own UID (see db.js v8's migration comment for why -- an unset
  // user.name/user.email would break `git commit` outright in an ephemeral
  // sandbox HOME, and a mismatched identity would be a confusing signed
  // commit whose author doesn't match the signing key). gpg.program is left
  // as the bare command name -- it resolves via the sandbox's own PATH to
  // /usr/bin/gpg (already ro-bound via /usr).
  if (gpgVault) {
    const vault = gpgVault;
    gitConfigEntries.push(
      ['user.signingkey', vault.fingerprint],
      ['commit.gpgsign', 'true'],
      ['gpg.program', 'gpg'],
      ['user.name', vault.nameReal],
      ['user.email', vault.nameEmail],
    );
  }

  if (gitConfigEntries.length > 0) {
    args.push('--setenv', 'GIT_CONFIG_COUNT', String(gitConfigEntries.length));
    gitConfigEntries.forEach(([key, value], i) => {
      args.push('--setenv', `GIT_CONFIG_KEY_${i}`, key, '--setenv', `GIT_CONFIG_VALUE_${i}`, value);
    });
  }

  // User-configured extra binds (ssh keys, custom config, etc.). Use *-try
  // so a missing source is skipped rather than aborting the launch.
  //
  // Raw ~/.ssh (private keys) and ~/.config/gh (gh token) are always blocked
  // here, unconditionally (even if gitBroker is off) -- see
  // isBlockedCredentialBind (shared helper in sandbox-paths.js).
  for (const b of extraBinds) {
    if (!b || !b.src) continue;
    // resolve() collapses `..` first: without it `~/.config/../.ssh` slips
    // past the prefix check and bwrap then binds the resolved ~/.ssh anyway.
    const src = resolve(expandHome(String(b.src)));
    if (isBlockedCredentialBind(src, HOME)) {
      console.warn(`[sandbox] ignoring configured bind of ${src}: raw ssh keys / gh config are no longer exposed to the sandbox (see the git broker)`);
      continue;
    }
    const dest = b.dest ? expandHome(String(b.dest)) : src;
    const flag = b.mode === 'rw' ? '--bind-try' : '--ro-bind-try';
    args.push(flag, src, dest);
  }

  // Environment.
  args.push(
    '--setenv', 'HOME', HOME,
    '--setenv', 'XDG_RUNTIME_DIR', XDG_RUNTIME_DIR,
    '--setenv', 'PATH', sandboxPath,
    '--setenv', 'CCSANDBOX_DOCKER', docker ? '1' : '0',
  );
  if (docker) {
    args.push(
      '--setenv', 'DOCKER_HOST', `unix://${XDG_RUNTIME_DIR}/docker.sock`,
      '--setenv', 'CCSANDBOX_DOCKER_DATAROOT', join(HOME, '.local', 'share', 'docker'),
      // The unique per-launch stateDir basename, reused as-is (see
      // newStateDir()) rather than minting a second UUID. The entrypoint
      // writes this into the data-root's status file iff it wins the dockerd
      // flock, so the host side can later tell "docker is available to ME"
      // apart from "in use by another session" (dockerdStatus/
      // dockerAvailability).
      '--setenv', 'CCSANDBOX_DOCKERD_TAG', basename(stateDir),
    );
  }

  // User-configured environment (e.g. SSH_AUTH_SOCK, GPG_TTY). Applied last so
  // it can override the defaults above.
  for (const [k, v] of Object.entries(extraEnv || {})) {
    if (typeof k === 'string' && k) {
      args.push('--setenv', k, expandHome(String(v)));
    }
  }

  args.push('--chdir', cwd);
  // Expose the entrypoint script read-only at a fixed path.
  args.push('--ro-bind', ENTRYPOINT, '/ccserver-sandbox-entrypoint.sh');

  // Opt-in tool provisioning: bind the provisioner read-only at a fixed path
  // and hand it the tool specs via env (see resolveTools / sandbox-provision.sh).
  // It installs into $HOME/.local inside the sandbox (persistent per-project
  // home or fresh tmpfs) before the target command runs, so nothing needs to be
  // pre-installed on the host OS. The provisioner only needs python3 (already
  // bound via /usr) and writes solely under the sandbox's own HOME.
  if (tools && (tools.rtk || tools.codeReviewGraph)) {
    args.push('--ro-bind', PROVISION_SCRIPT, SANDBOX_PROVISION_PATH);
    args.push(
      '--setenv', 'CCSANDBOX_PROVISION_RTK', tools.rtk ? '1' : '0',
      '--setenv', 'CCSANDBOX_PROVISION_CRG', tools.codeReviewGraph ? '1' : '0',
      '--setenv', 'CCSANDBOX_RTK_VERSION', tools.rtkSpec?.version || '',
      '--setenv', 'CCSANDBOX_RTK_URL', tools.rtkSpec?.url || '',
      '--setenv', 'CCSANDBOX_RTK_SHA256', tools.rtkSpec?.sha256 || '',
      '--setenv', 'CCSANDBOX_CRG_VERSION', tools.crgSpec?.version || '',
    );
  }

  return args;
}

export function buildMinimalSandboxSpawn({ cwd, targetCommand, app = 'claude' }) {
  const { command, installDir } = resolveApp(app);
  const bwrapArgs = buildBwrapArgs({
    cwd,
    docker: false,
    gpg: false,
    extraBinds: [],
    extraEnv: {},
    authSock: null,
    stateDir: null,
    claudeDir: installDir,
    gitBroker: null,
    commitGuard: null,
    notifySocketPath: null,
    usageSocketPath: null,
    // The /usage capture is a throwaway read: it must not create (or depend
    // on) a persistent per-project HOME.
    homeDir: null,
  });
  const innerCmd = [BASH, '/ccserver-sandbox-entrypoint.sh', ...withClaude(targetCommand, command)];
  return {
    command: BWRAP,
    args: [...bwrapArgs, '--', ...innerCmd],
    docker: false,
    stateDir: null,
    gitBrokerProc: null,
    gitBrokerDir: null,
    commitGuardDir: null,
  };
}

// Returns { command, args } for pty.spawn, wrapping the given target command
// (e.g. ['claude', '--resume', id] or ['/bin/bash']) in the sandbox.
//   app         - selects which agent the install-dir resolution applies to.
//   sandboxOpts - optional per-launch override for the opt-in flags
//                 ({ gpg, sshAgent }, either key omittable). Lets a caller
//                 (the client, via the launch UI) pick these per session/
//                 directory instead of only through the shared config file;
//                 an omitted key falls back to loadSandboxConfig()'s value.
//   notifySocketPath - host path of the process-global ccserver-notify socket
//                 to bind into the sandbox at a fixed path. null when the
//                 session gets no notify MCP injection.
//   usageSocketPath - host path of the process-global ccserver-usage socket
//                 to bind into the sandbox at a fixed path. null when the
//                 session gets no usage MCP injection.
//   reuseSandboxHome - false to start a *fresh* persistent HOME for this
//                 launch: the previous per-project HOME is wiped (via the same
//                 escalated removeTree as deleteSandboxHome) and recreated
//                 empty. True (default) keeps it. Only meaningful when
//                 persistentHome is enabled in the config; the caller
//                 (sessionManager) guards against wiping a HOME that another
//                 live sandboxed session is still using.
//   sandboxHomeCreatedBy - optional attribution stored on the sandbox HOME's
//                 bookkeeping row ('user' | ...). Display only; never an
//                 authorization input.
// `deps.dockerSandboxAvailable` lets tests simulate a host with/without the
// rootlesskit/slirp4netns/newuidmap tooling.

// The agent install a qemu launch shares read-only into the VM
// (qemuAgents.js): { hostDir, relBin, guestDir, argv, env }, or null when
// the target is not an agent (a shell). Throws when the agent is not
// installed on the host in a way the VM can use.
function resolveQemuAgent(app, targetCommand) {
  if (!APP_IDS.includes(app)) return null;
  const r = resolveApp(app);
  if (![app, `${app}.exe`, r.command, r.hostCommand].includes(targetCommand[0])) return null;
  try {
    const { hostDir, relBin } = resolveVmAgentInstall(r.hostCommand, {
      home: HOME, protectedPaths: credentialPaths(HOME, agentConfigDirs(HOME)),
    });
    return { hostDir, relBin, guestDir: guestAgentDir(app), argv: vmAgentArgv(app, relBin, targetCommand.slice(1)), env: vmAgentEnv(app) };
  } catch (e) {
    if (e instanceof VmAgentError) throw new Error(`${app} cannot run in the VM: ${e.message}`);
    throw e;
  }
}

// The VM's claude reads its config from the persistent HOME's own
// ~/.claude.json: a VM does not get the host's agent config (qemuAgents.js).
// Prepared here before a VM launch, for two cases:
//
//   - A bwrap session binds the host's ~/.claude.json over the persistent
//     HOME (see buildBwrapArgs); when the HOME had none, bwrap leaves an
//     empty, read-only (0444) file there as the mount point. claude in the
//     VM refuses to start on it ("JSON Parse error: Unexpected EOF") and
//     could not save to it either: it is made 0600 and given content.
//   - skipOnboarding (claude with the VM token set, see buildVmAgentAuth):
//     without hasCompletedOnboarding, claude runs its first-run setup and
//     asks for a login method even though the broker supplies the token.
//     The flag is added, every other key kept.
//
// Never unlinks or renames the file (a live bwrap session of the same project
// may have it as a mount point): it is rewritten in place. Never follows a
// symlink and only touches a regular file of ours (the sandbox controls
// HOME's contents); the write reopen must be the same, unchanged inode.
// Unparseable JSON is left to claude's own backup/recovery.
// Returns what it did ('created' | 'repaired' | 'onboarding') or null.
const CLAUDE_JSON_MAX_BYTES = 16 * 1024 * 1024;
export function prepareVmClaudeJson(homeDir, { skipOnboarding = false } = {}) {
  if (!homeDir) return null;
  const path = join(homeDir, '.claude.json');
  const flags = fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK;
  const onboarded = (obj) => ({ ...obj, hasCompletedOnboarding: true });
  let fd;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | flags);
  } catch (e) {
    if (e.code !== 'ENOENT' || !skipOnboarding) return null; // a symlink, unreadable, or nothing to do
    try {
      const cfd = openSync(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | flags, 0o600);
      try { writeSync(cfd, `${JSON.stringify(onboarded({}), null, 2)}\n`); } finally { closeSync(cfd); }
      return 'created';
    } catch {
      return null; // raced with claude creating it: leave theirs
    }
  }
  let st;
  let next;
  try {
    st = fstatSync(fd);
    if (!st.isFile() || st.uid !== process.getuid() || st.size > CLAUDE_JSON_MAX_BYTES) return null;
    if (st.size === 0) {
      next = skipOnboarding ? onboarded({}) : {};
    } else {
      if (!skipOnboarding) return null;
      let obj;
      try { obj = JSON.parse(readFileSync(fd, 'utf-8')); } catch { return null; }
      if (!obj || typeof obj !== 'object' || Array.isArray(obj) || obj.hasCompletedOnboarding === true) return null;
      next = onboarded(obj);
    }
    if ((st.mode & 0o200) === 0) fchmodSync(fd, 0o600);
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
  let wfd;
  try {
    wfd = openSync(path, fsConstants.O_WRONLY | flags);
  } catch {
    return null;
  }
  try {
    const wst = fstatSync(wfd);
    if (wst.ino !== st.ino || wst.dev !== st.dev || !wst.isFile() || wst.size !== st.size || wst.mtimeMs !== st.mtimeMs) return null;
    ftruncateSync(wfd, 0);
    writeSync(wfd, st.size === 0 && !skipOnboarding ? '{}\n' : `${JSON.stringify(next, null, 2)}\n`, 0);
    return st.size === 0 ? 'repaired' : 'onboarding';
  } catch {
    return null;
  } finally {
    closeSync(wfd);
  }
}

function opencodeHostConfigDir() {
  return join(process.env.XDG_CONFIG_HOME || join(HOME, '.config'), 'opencode');
}

// The network side of the VM agent credentials (independent of the app):
// the broker's credential inject (merged into `advanced`), its env, the
// credentials' digest, and the inject hosts the allow-list lacks.
//
// The opencode keys' API hosts come from the host's opencode config (its
// provider section, read at each launch) or qemuAgents.js's built-in table.
// A provider that resolves to neither is left out (`skipped`, the launch
// warns): a stale opencode key must not stop every VM launch.
function vmAgentNetwork({ networkAdvanced, netCfg }, deps) {
  const {
    getVmAgentCredentials: getVmAgentCredentialsFn = getVmAgentCredentials,
    readOpencodeHostProviders: readOpencodeHostProvidersFn = () => readOpencodeHostProviders(opencodeHostConfigDir()),
  } = deps;
  const credentials = getVmAgentCredentialsFn();
  const providerIds = Object.keys(credentials.opencodeApiKeys || {});
  const { providers: opencodeProviders, skipped } = providerIds.length
    ? resolveOpencodeProviders({ hostProviders: readOpencodeHostProvidersFn(), providerIds })
    : { providers: [], skipped: [] };
  const auth = buildVmAgentAuth({ credentials, opencodeProviders, advanced: networkAdvanced });
  return {
    auth,
    skipped,
    advanced: { ...networkAdvanced, inject: auth.inject },
    brokerEnv: auth.brokerEnv,
    authDigest: auth.digest,
    extraAllowedHosts: auth.hosts.filter((h) => !netCfg.allowedHosts.includes(h)),
    injectHosts: auth.hosts,
  };
}

// OPENCODE_CONFIG_CONTENT (mcpConfig.js's MCP section, or none) with
// ccserver's provider entries added over any of the same id.
function withOpencodeProviders(content, provider) {
  let cfg = {};
  if (content) {
    try { cfg = JSON.parse(content); } catch { cfg = {}; }
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) cfg = {};
  }
  const prior = cfg.provider && typeof cfg.provider === 'object' && !Array.isArray(cfg.provider) ? cfg.provider : {};
  return JSON.stringify({ $schema: 'https://opencode.ai/config.json', ...cfg, provider: { ...prior, ...provider } });
}

// What a qemu launch adds for the agent, shared by both VM kinds: the
// agent install, the broker's credential inject (merged into `advanced`),
// the guest env, and the allow-list with the inject hosts added.
function qemuAgentLaunch({ app, targetCommand, extraEnv, networkAdvanced, netCfg }, deps) {
  const { resolveQemuAgent: resolveQemuAgentFn = resolveQemuAgent } = deps;
  const agent = resolveQemuAgentFn(app, targetCommand);
  const { auth, skipped, ...agentNet } = vmAgentNetwork({ networkAdvanced, netCfg }, deps);
  for (const { id, reason } of skipped) {
    console.warn(`[sandbox] qemu backend: the opencode key for ${id} is not injected: ${reason}.`);
  }
  // The host ssh-agent path means nothing in the guest: buildGuestRuntime
  // sets the guest's own SSH_AUTH_SOCK. ccserver's own values over the
  // operator's env: a placeholder must not be replaced by a real secret.
  const guestEnv = { ...extraEnv, ...(agent ? agent.env : {}), ...auth.guestEnv };
  delete guestEnv.SSH_AUTH_SOCK;
  if (app === 'opencode' && auth.opencodeConfig) {
    guestEnv.OPENCODE_CONFIG_CONTENT = withOpencodeProviders(guestEnv.OPENCODE_CONFIG_CONTENT, auth.opencodeConfig.provider);
  }
  return {
    agent,
    argv: agent ? agent.argv : targetCommand,
    guestEnv,
    // The broker injects claude's token (the guest has the placeholder).
    claudeToken: !!auth.guestEnv.CLAUDE_CODE_OAUTH_TOKEN,
    ...agentNet,
  };
}

// A persistent VM's broker policy, resources and pool key. The key is the
// template alone: one persistent VM per template, so a settings edit never
// boots a second VM next to a running one. What a running VM can take live
// is applied to it when a launch joins (qemuVmPool.js attach): the operating
// mode (opMode) and the allow/deny lists (lists; the inject hosts,
// extraAllowedHosts, are added to the allow list per VM). Everything else
// -- resources, cloud-config, golden image, the broker's advanced policy and
// injected credentials -- is fixed at boot; configDigest hashes it, and a
// launch whose digest differs still joins but marks the VM stale (applied
// once the VM is stopped and booted again). Shared by the launch
// (buildPooledQemuSpawn) and the launch dialog's "would this join a running
// VM" check (qemuLaunchPoolKey), so the two can never disagree.
function pooledVmKey({ vmTemplate, qemuCfg, netCfg, agentNet }) {
  const net = {
    mode: netCfg.mode,
    state: 'open',
    allowedHosts: [...netCfg.allowedHosts, ...agentNet.extraAllowedHosts],
    deniedHosts: netCfg.deniedHosts,
    advanced: agentNet.advanced,
  };
  const vm = {
    memoryMiB: qemuCfg.memoryMiB,
    cpus: qemuCfg.cpus,
    diskGiB: qemuCfg.diskGiB,
    bootTimeoutSec: qemuCfg.bootTimeoutSec,
    templateCloudConfig: vmTemplate ? vmTemplate.cloudConfig : null,
  };
  const templateId = vmTemplate ? vmTemplate.template.id : null;
  const { mode: opMode, allowedHosts, deniedHosts, ...netFixed } = net;
  const { bootTimeoutSec, ...vmFixed } = vm;
  const key = poolKey({ template: templateId });
  const configDigest = poolKey({
    template: templateId,
    vm: vmFixed,
    net: netFixed,
    auth: agentNet.authDigest,
    golden: currentGolden()?.version || null,
  });
  return {
    key,
    configDigest,
    net,
    vm,
    opMode,
    lists: { allowedHosts: netCfg.allowedHosts, deniedHosts: netCfg.deniedHosts },
    // All of them, not just the ones the allow list lacks now: a later
    // list without one must still get it added (qemuVmPool.js withExtra).
    extraAllowedHosts: agentNet.injectHosts,
  };
}

// The pool key a qemu launch with these sandboxOpts would join, or null
// when it boots a VM of its own (a non-persistent template) or cannot be
// determined (deleted template, bad credentials config -- the launch itself
// fails then). Side-effect free: nothing is started.
export function qemuLaunchPoolKey(sandboxOpts = null, deps = {}) {
  const { resolveVmTemplate: resolveVmTemplateFn = resolveVmTemplate } = deps;
  try {
    const vmTemplate = resolveVmTemplateFn(sandboxOpts?.vmTemplateId ?? null);
    const { qemu: qemuConfigDefaults, networkAdvanced, network: netCfg } = loadSandboxConfig();
    const qemuCfg = vmTemplate ? vmTemplate.template : qemuConfigDefaults;
    if (!qemuCfg.persistent) return null;
    const agentNet = vmAgentNetwork({ networkAdvanced, netCfg }, deps);
    return pooledVmKey({ vmTemplate, qemuCfg, netCfg, agentNet }).key;
  } catch {
    return null;
  }
}

// The qemu branch of buildSandboxSpawn. Returns the same handle shape as the
// bwrap branch plus qemuRunDir for sessionManager's teardown.
//
// Host services reach the VM the way bwrap binds them, only over the
// broker's service addresses (see buildGuestRuntime in sandbox-qemu.js):
// the git broker, commit-msg guard, GPG vault relay, ssh-agent (opt-in) and
// the MCP bridge sockets. Start order and cleanup mirror the bwrap branch:
// anything started before a later step throws is stopped and removed.
//
// Not available in the VM (warned, launched without): the legacy `gpg`
// host-agent forwarding (it would hand the VM the host's whole keyring --
// gpgVault replaces it), docker, tools.
//
// vmTemplateId (sandboxOpts.vmTemplateId) picks the VM template (see
// vmTemplates.js): its resources and cloud-config. null means the default
// template, or sandbox.config.json's qemu values when there is none.
async function buildQemuSpawn({ cwd, targetCommand, app, homeDir, netCfg, extraEnv, gpg, sshAgent, gpgVault, gpgVaultInfo, tools, gitBrokerEnabled, commitMessageGuard, ghUsageRecording, notifySocketPath, usageSocketPath, vmTemplateId = null, chat = null }, deps = {}) {
  const {
    startGitBroker: startGitBrokerFn = startGitBroker,
    startCommitGuard: startCommitGuardFn = startCommitGuard,
    startGoNetworkBroker: startGoNetworkBrokerFn = startGoNetworkBroker,
    prepareQemuSession: prepareQemuSessionFn = prepareQemuSession,
    resolveVmTemplate: resolveVmTemplateFn = resolveVmTemplate,
  } = deps;
  // Before any broker starts: a deleted or broken template refuses the launch.
  const vmTemplate = resolveVmTemplateFn(vmTemplateId);
  const unsupported = [
    gpg && 'gpg', tools?.rtk && 'tools.rtk', tools?.codeReviewGraph && 'tools.code-review-graph',
  ].filter(Boolean);
  if (unsupported.length) {
    console.warn(`[sandbox] qemu backend: ${unsupported.join(', ')} not available inside the VM; launching without them.`);
  }
  const { qemu: qemuConfigDefaults, networkAdvanced } = loadSandboxConfig();
  const qemuCfg = vmTemplate ? vmTemplate.template : qemuConfigDefaults;
  // Before any broker starts: an agent the VM cannot run, or credentials
  // that cannot be injected, refuse the launch.
  const agentLaunch = qemuAgentLaunch({ app, targetCommand, extraEnv, networkAdvanced, netCfg }, deps);
  const claudeJson = prepareVmClaudeJson(homeDir, { skipOnboarding: app === 'claude' && agentLaunch.claudeToken });
  if (claudeJson) {
    const what = { created: 'created it with hasCompletedOnboarding', repaired: 'replaced the empty bwrap mount-point stub', onboarding: 'added hasCompletedOnboarding' }[claudeJson];
    console.warn(`[sandbox] qemu backend: ${join(homeDir, '.claude.json')}: ${what}`);
  }
  if (qemuCfg.persistent) {
    return await buildPooledQemuSpawn({
      cwd, targetCommand, homeDir, netCfg, gpgVault, sshAgent,
      gitBrokerEnabled, notifySocketPath, usageSocketPath, vmTemplate, qemuCfg, agentLaunch, chat,
    }, deps);
  }
  const sshAgentSock = sshAgent && !gpgVault ? (extraEnv.SSH_AUTH_SOCK || discoverSshAuthSock()) : null;
  if (sshAgent && !gpgVault && !sshAgentSock) {
    console.warn('[sandbox] qemu backend: sshAgent is enabled but no host ssh-agent socket was found; launching without it.');
  }
  const { agent, guestEnv } = agentLaunch;

  let gitBroker = null;
  let commitGuard = null;
  let broker = null;
  const cleanup = () => {
    if (broker) {
      try { broker.proc.kill('SIGTERM'); } catch { /* already dead */ }
      try { rmSync(broker.dir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
    if (gitBroker) {
      try { gitBroker.proc.kill('SIGTERM'); } catch { /* already dead */ }
      try { rmSync(gitBroker.dir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
    if (commitGuard) { try { rmSync(commitGuard.dir, { recursive: true, force: true }); } catch { /* best effort */ } }
  };
  let plan;
  try {
    // Same broker inputs as the bwrap branch (see there).
    gitBroker = gitBrokerEnabled
      ? await startGitBrokerFn({ cwd, app, blockedPatterns: commitMessageGuard.enabled ? commitMessageGuard.blockedPatterns : null, ghUsageRecording })
      : null;
    commitGuard = commitMessageGuard.enabled ? startCommitGuardFn(commitMessageGuard.blockedPatterns) : null;
    const userKnownHosts = join(HOME, '.ssh', 'known_hosts');
    const runtime = buildGuestRuntime({
      scripts: {
        credHelper: CRED_HELPER_SCRIPT,
        ghWrapper: GH_WRAPPER_SCRIPT,
        sshWrapper: SSH_WRAPPER_SCRIPT,
        mcpBridge: MCP_BRIDGE_SCRIPT,
        commitMsgHook: COMMIT_MSG_HOOK_SCRIPT,
        gitconfig: GENERATED_GITCONFIG,
        knownHostsDefault: DEFAULT_KNOWN_HOSTS,
        sshConfig: SSH_CONFIG_FILE,
        knownHostsUser: existsSync(userKnownHosts) ? userKnownHosts : null,
      },
      gitBroker,
      commitGuard,
      // The relay's FIXED socket paths, as bwrap binds (see gpgVaultRelay.js).
      gpgVault: gpgVaultInfo ? { ...gpgVaultInfo, sockets: gpgVaultRelay.getRelaySocketPaths() } : null,
      sshAgentSock,
      mcp: { notify: notifySocketPath, usage: usageSocketPath },
      chat: chat ? { bridge: chatBridgeOf(chat), passwordFile: join(chat.hostDir, CHAT_PASSWORD_NAME) } : null,
    });
    // The per-session Go broker (ccserver-netbroker) runs the VM's entire network
    // (QEMU's NIC is attached to it). It always starts 'open'; the
    // running-session toggle flips it to enforce. A policy error refuses the
    // launch before anything boots.
    broker = startGoNetworkBrokerFn({
      session: randomUUID(),
      mode: netCfg.mode,
      state: 'open',
      allowedHosts: [...netCfg.allowedHosts, ...agentLaunch.extraAllowedHosts],
      deniedHosts: netCfg.deniedHosts,
      advanced: agentLaunch.advanced,
      services: runtime.services.map(({ name, addr, unix }) => ({ name, addr, unix })),
      env: agentLaunch.brokerEnv,
    });
    plan = prepareQemuSessionFn({
      cwd,
      // An agent runs from its read-only share (qemuAgents.js). A shell
      // session whose host $SHELL the image lacks falls back to bash rather
      // than failing.
      argv: chat ? chatBridgeArgv({
        node: '/usr/bin/node',
        script: GUEST_CHAT_BRIDGE,
        sock: GUEST_CHAT_SOCK,
        passwordFile: GUEST_CHAT_PASSWORD,
        bridgeArgs: chat.bridgeArgs,
      }, agentLaunch.argv) : agentLaunch.argv,
      fallbackArgv: agent || APP_IDS.includes(targetCommand[0]) ? null : ['bash', '-l', '-i'],
      env: guestEnv,
      homeHostPath: homeDir,
      sshForwards: chat ? [[join(chat.hostDir, CHAT_SOCK_NAME), GUEST_CHAT_SOCK]] : [],
      extraShares: agent ? [{ tag: 'agent', hostPath: agent.hostDir, guestPath: agent.guestDir, readonly: true }] : [],
      runtime,
      network: {
        vnetSock: broker.vnetSock,
        guestSshSock: broker.guestSshSock,
        pipeBin: netbrokerBin(),
        caPem: broker.caPem,
      },
      memoryMiB: qemuCfg.memoryMiB,
      cpus: qemuCfg.cpus,
      diskGiB: qemuCfg.diskGiB,
      bootTimeoutSec: qemuCfg.bootTimeoutSec,
      templateCloudConfig: vmTemplate ? vmTemplate.cloudConfig : null,
    });
  } catch (e) {
    cleanup();
    throw e;
  }
  return {
    command: process.execPath,
    args: [QEMU_LAUNCHER, plan.planPath],
    docker: false,
    gpgVaultActive: !!gpgVaultInfo,
    stateDir: null,
    gitBrokerProc: gitBroker ? gitBroker.proc : null,
    gitBrokerDir: gitBroker ? gitBroker.dir : null,
    commitGuardDir: commitGuard ? commitGuard.dir : null,
    sandboxNetworkBrokerProc: broker.proc,
    sandboxNetworkBrokerDir: broker.dir,
    networkBrokerAdminSock: broker.adminSock,
    networkIsolateArmed: true,
    networkIsolateMode: broker.state,
    networkExtraAllowedHosts: agentLaunch.extraAllowedHosts,
    qemuRunDir: plan.runDir,
    // What the Settings GUI's running-VM list shows (routes/vms.js).
    qemuVm: {
      templateId: vmTemplate ? vmTemplate.template.id : null,
      templateName: vmTemplate ? vmTemplate.template.name : null,
      memoryMiB: qemuCfg.memoryMiB,
      cpus: qemuCfg.cpus,
      diskGiB: qemuCfg.diskGiB,
      startedAt: Date.now(),
    },
  };
}

// A session of a persistent VM (qemuVmPool.js). The VM's network broker is
// started by the pool with this launch's policy, which is part of the pool
// key: a launch only ever joins a VM booted with exactly its own policy.
//
// chat (chat mode): the bridge and password go to the VM in a
// read-only share of their own (chat.hostDir/vm, removed with the chat dir)
// that the session's guest bwrap binds at GUEST_RT_DIR, where a per-session
// VM has them; the pool forwards the relay socket (qemuVmPool.js attach).
async function buildPooledQemuSpawn({ cwd, targetCommand, homeDir, netCfg, gpgVault, sshAgent, gitBrokerEnabled, notifySocketPath, usageSocketPath, vmTemplate, qemuCfg, agentLaunch, chat = null }, deps = {}) {
  const {
    startGoNetworkBroker: startGoNetworkBrokerFn = startGoNetworkBroker,
    qemuVmPool = defaultQemuVmPool,
  } = deps;
  // An explicitly requested signing key must never silently disappear.
  if (gpgVault) {
    throw new Error('gpgVault is not available in a persistent (shared) VM yet -- turn it off for this launch or use a template without "persistent".');
  }
  const missing = [
    gitBrokerEnabled && 'gitBroker', sshAgent && 'sshAgent',
    (notifySocketPath || usageSocketPath) && 'MCP sockets',
  ].filter(Boolean);
  if (missing.length) {
    console.warn(`[sandbox] persistent VM: ${missing.join(', ')} not available yet; launching without them.`);
  }
  const { key, configDigest, net, vm, opMode, lists, extraAllowedHosts } = pooledVmKey({ vmTemplate, qemuCfg, netCfg, agentNet: agentLaunch });
  const { agent, guestEnv } = agentLaunch;
  let chatFilesDir = null;
  if (chat) {
    chatFilesDir = join(chat.hostDir, 'vm');
    mkdirSync(chatFilesDir, { recursive: true, mode: 0o700 });
    copyFileSync(chatBridgeOf(chat), join(chatFilesDir, GUEST_CHAT_BRIDGE_NAME));
    chmodSync(join(chatFilesDir, GUEST_CHAT_BRIDGE_NAME), 0o755);
    copyFileSync(join(chat.hostDir, CHAT_PASSWORD_NAME), join(chatFilesDir, GUEST_CHAT_PASSWORD_NAME));
    chmodSync(join(chatFilesDir, GUEST_CHAT_PASSWORD_NAME), 0o600);
  }
  const lease = await qemuVmPool.attach({
    key,
    opMode,
    lists,
    configDigest,
    extraAllowedHosts,
    spec: {
      startBroker: () => ({
        ...startGoNetworkBrokerFn({ session: randomUUID(), ...net, services: [], env: agentLaunch.brokerEnv }),
        pipeBin: netbrokerBin(),
      }),
      vm,
    },
    info: {
      templateId: vmTemplate ? vmTemplate.template.id : null,
      templateName: vmTemplate ? vmTemplate.template.name : null,
      memoryMiB: qemuCfg.memoryMiB,
      cpus: qemuCfg.cpus,
      diskGiB: qemuCfg.diskGiB,
    },
    session: {
      cwd,
      home: HOME,
      homeHostPath: homeDir,
      argv: chat ? chatBridgeArgv({
        node: '/usr/bin/node',
        script: GUEST_CHAT_BRIDGE,
        sock: GUEST_CHAT_SOCK,
        passwordFile: GUEST_CHAT_PASSWORD,
        bridgeArgs: chat.bridgeArgs,
      }, agentLaunch.argv) : agentLaunch.argv,
      fallbackArgv: agent || APP_IDS.includes(targetCommand[0]) ? null : ['bash', '-l', '-i'],
      env: guestEnv,
      agent: agent ? { hostDir: agent.hostDir, guestDir: agent.guestDir } : null,
      chat: chat ? { filesHostDir: chatFilesDir, hostSock: join(chat.hostDir, CHAT_SOCK_NAME) } : null,
    },
  });
  return {
    command: process.execPath,
    args: [QEMU_LAUNCHER, lease.planPath],
    docker: false,
    gpgVaultActive: false,
    stateDir: null,
    // The running-session toggle flips the whole VM's broker
    // (setPooledVmNetworkMode in sessionManager.js); a joining session shows
    // whatever mode the VM is in now. No networkExtraAllowedHosts: the
    // Settings GUI pushes the lists and the operating mode per VM instead
    // (qemuVmPool.setListsAll / setOpModeAll), adding each VM's own.
    networkBrokerAdminSock: lease.vm.network?.adminSock ?? null,
    networkIsolateArmed: !!lease.vm.network,
    networkIsolateMode: lease.vm.network?.mode ?? null,
    qemuPoolLease: lease,
    qemuVm: { ...lease.vm.info, pooled: true, vmId: lease.vm.id, startedAt: lease.vm.startedAt },
  };
}

// chat: { hostDir, bridgeScript?, bridgeArgs? } for a chat launch (see
// CHAT_BRIDGE_SCRIPT): targetCommand is then the agent in its chat form
// (`opencode serve ...` / `claude ...`), run under the app's chat bridge.
export async function buildSandboxSpawn({ cwd, targetCommand, app, sandboxOpts, notifySocketPath = null, usageSocketPath = null, reuseSandboxHome = true, sandboxHomeCreatedBy = null, chat = null }, deps = {}) {
  const { dockerSandboxAvailable: dockerSandboxAvailableFn = dockerSandboxAvailable } = deps || {};
  // Normalize the app id up front: a nullish `app` resolves to 'claude' in
  // resolveApp(), so every later `app === 'claude'` / `app === 'opencode'`
  // check must see the same value.
  app = app || 'claude';
  // Defense in depth behind sessionManager's cwd='/' refusal: a sandbox
  // with the filesystem root as projectDir grants the whole filesystem.
  // Refuse it here so the launch stays fail-closed.
  if (resolve(cwd) === '/') {
    throw new Error('Cannot build a sandbox for the filesystem root (/) -- the project rule would grant the whole filesystem. Choose a working directory first.');
  }
  const { docker: cfgDocker, persistentHome, gpg: cfgGpg, sshAgent: cfgSshAgent, gpgVault: cfgGpgVault, gitBroker: gitBrokerEnabled, commitMessageGuard, ghUsageRecording, network: netCfg, binds, env, tools: cfgTools, claudeBin, browseRoots, browseRootsInvalid } = loadSandboxConfig();
  // Defense in depth behind sessionManager's browseRoots cwd check (issue
  // #189): same reasoning as the '/' guard just above.
  if (browseRootsInvalid) {
    throw new Error('Cannot build a sandbox: sandbox.config.json\'s "browseRoots" is invalid, so the allowed working directories cannot be determined.');
  }
  if (browseRoots.length > 0 && !isContained(resolve(cwd), browseRoots)) {
    throw new Error('Cannot build a sandbox: working directory is outside the allowed browseRoots.');
  }
  const docker = cfgDocker && dockerSandboxAvailableFn();
  // Network isolation is qemu-only (see buildQemuSpawn below): the Go broker
  // always starts 'open'. The bwrap backend launches with open egress and
  // starts no broker.
  const gpg = sandboxOpts?.gpg ?? cfgGpg;
  const sshAgent = sandboxOpts?.sshAgent ?? cfgSshAgent;
  const gpgVault = sandboxOpts?.gpgVault ?? cfgGpgVault;
  // Opt-in tool provisioning (rtk / code-review-graph), merged like gpg/sshAgent
  // from the config default + the client's per-session sandboxOpts.tools.
  // Thread cfgTools through instead of re-reading the config file.
  const tools = resolveTools(sandboxOpts, cfgTools);

  // GPG vault (plan: gpg-agent-vault): fail loudly and early, before any
  // broker starts (gitBroker/commitGuard below all leak a live
  // child process + runtime dir if a LATER step throws -- see their own
  // cleanup blocks -- so refusing here, first, needs none of that dance).
  // A missing/legacy vault must never silently degrade to "no GPG" -- this
  // session explicitly asked to sign/push with a specific key, and launching without
  // it would be a silent downgrade of what the caller requested. These two
  // are recoverable only by operator action (set up / recreate the vault),
  // so they still hard-fail the launch.
  if (gpgVault && !gpgVaultAgent.vaultExists()) {
    throw new Error('gpgVault was requested but no GPG vault has been set up yet -- set one up from Settings first.');
  }
  if (gpgVault && gpgVaultAgent.isLegacyVault()) {
    // Security audit F1.4: pre-fix vaults are disabled for good.
    throw new Error(
      'gpgVault was requested but the GPG vault was created before the security fix and has been disabled '
      + '(its secret key may have leaked) -- delete and recreate it from Settings.',
    );
  }
  // A vault that is merely LOCKED at this exact instant is NOT treated as
  // "no GPG" either, but it is also not a launch-time hard failure any more
  // (issue #185): gpgVaultRelay.js already tolerates lock/unlock cycles for
  // an already-running sandbox (its sockets resolve the current agent fresh
  // per connection), so gating the launch itself on isUnlocked() just
  // rejects a race that resolves itself moments later. The launch proceeds
  // with gpgVault still enabled; signing/SSH push will fail (relay refuses
  // the connection, "agent unavailable" to gpg/ssh) until the vault is
  // unlocked, and this is logged so a locked launch is never silently
  // unnoticed.
  if (gpgVault && !gpgVaultAgent.isUnlocked()) {
    console.warn(
      '[sandbox] gpgVault was requested but the vault is currently locked -- launching anyway; '
      + 'signing/SSH push will fail until it is unlocked from Settings.',
    );
  }
  // gpgVault uses its own target path (~/.gnupg-vault / XDG_RUNTIME_DIR/
  // gnupg-vault, see buildBwrapArgs) specifically so it cannot collide
  // on-path with the legacy gpg/sshAgent host-forwarding flags -- but having
  // both active is still almost certainly a mistake (two different agents
  // both offering SSH auth, whichever bind runs last inside buildBwrapArgs
  // wins on SSH_AUTH_SOCK), so warn instead of silently accepting it, same
  // posture as the docker+gitBroker+sshAgent warning below.
  if (gpgVault && (gpg || sshAgent)) {
    console.warn(
      '[sandbox] gpgVault is enabled alongside the legacy gpg/sshAgent host-forwarding flags for the same '
      + 'launch -- gpgVault wins for SSH_AUTH_SOCK. Turn off gpg/sshAgent for this launch if that is not intended.',
    );
  }
  // Resolved once here (like gitBroker/commitGuard below) and
  // passed down as a plain object -- null when not requested -- rather than
  // having buildBwrapArgs each independently reach into
  // gpgVaultAgent.js. Lock-independent (issue #185): getPublicIdentity()
  // only ever returns fingerprint/nameReal/nameEmail (never homeDir/
  // sockets), which is why it is safe to call even while the vault above is
  // locked -- the vaultExists() check above guarantees it returns non-null
  // when gpgVault is true.
  const gpgVaultInfo = gpgVault ? gpgVaultAgent.getPublicIdentity() : null;
  // Must exist before buildBwrapArgs bind its FIXED
  // socket paths below (see gpgVaultRelay.js's header for why sandboxes bind
  // those instead of gpgVaultInfo.sockets directly). Idempotent/lazy: a
  // no-op on every launch after the first gpgVault:true one this server run.
  if (gpgVault) gpgVaultRelay.ensureStarted();

  // ssh-agent forwarding is opt-in (see loadSandboxConfig). When on, an
  // explicit env.SSH_AUTH_SOCK in the config wins; otherwise auto-discover.
  const authSock = sshAgent ? (env.SSH_AUTH_SOCK || discoverSshAuthSock()) : null;

  // Unique per launch (docker needs rootlesskit's own state dir); returned
  // so the caller can remove it on teardown. See newStateDir().
  const stateDir = docker ? newStateDir() : null;

  // Persistent per-project HOME. reuseSandboxHome=false wipes the previous
  // one first so the launch starts from a clean environment; the caller
  // (sessionManager) has already refused the wipe when another live sandboxed
  // session is still using this HOME (see sandboxHomeConflict).
  let homeDir = null;
  if (persistentHome) {
    homeDir = persistentHomeDir(cwd);
    // A settings-page deletion may be mid-flight on this HOME (its rm -rf
    // runs in the background for minutes). Booting a session here would
    // re-create and bind-mount a HOME the deleter is still walking -- close
    // the TOCTOU by refusing the launch.
    if (isSandboxDeleteInFlight(basename(homeDir))) {
      throw new Error(`a deletion of this sandbox HOME is in progress; retry the launch once it finishes (${homeDir})`);
    }
    if (!reuseSandboxHome) {
      // "新規作成" must start from a clean HOME. A plain rmSync silently
      // fails on subuid-owned files (a nested dockerd wrote to the /tmp-bound
      // .ccserver-tmp) and the --bind below would then expose the stale
      // content as if it were fresh. Use the same escalated removal as
      // deleteSandboxHome, and refuse the launch rather than boot into a
      // stale HOME (e.g. a planted .bashrc) if it still cannot be wiped.
      const wipeErr = removeTree(homeDir);
      if (wipeErr) {
        throw new Error(`failed to wipe the previous sandbox HOME (${wipeErr}); refusing a "fresh" launch over stale state`);
      }
    }
    mkdirSync(homeDir, { recursive: true });
    // Remember which project this HOME belongs to (settings-page labels).
    recordSandboxHome(cwd, sandboxHomeCreatedBy);
  }

  // QEMU backend (sandbox.config.json backend: "qemu"): the session runs in a
  // KVM VM (see sandbox-qemu.js). Branches off before any bwrap broker
  // starts; buildQemuSpawn starts (and on failure cleans up) its own.
  // sandboxOpts.backend picks it per launch; the config sets the default.
  if (resolveSandboxBackend(sandboxOpts) === 'qemu') {
    return await buildQemuSpawn({
      cwd, targetCommand, app, homeDir, netCfg, extraEnv: env, gpg, sshAgent, gpgVault, gpgVaultInfo, tools,
      gitBrokerEnabled, commitMessageGuard, ghUsageRecording, notifySocketPath, usageSocketPath,
      vmTemplateId: sandboxOpts?.vmTemplateId ?? null, chat,
    }, deps);
  }

  // Computes the repo/submodule allow-list once and spawns the host-side
  // broker for this launch; see git-broker.js. The caller (sessionManager)
  // holds onto gitBrokerProc/gitBrokerDir to tear them down alongside the
  // sandboxed pty. blockedPatterns wires the same commitMessageGuard config
  // into the broker's gh-exec path (plan8: a `gh pr create/edit/comment/
  // review` title/body is checked the same way a git commit message is) --
  // null when commitMessageGuard is disabled, which the broker treats as
  // "no PR-body check", matching pre-plan8 behavior exactly.
  const gitBroker = gitBrokerEnabled
    ? await startGitBroker({ cwd, app, blockedPatterns: commitMessageGuard.enabled ? commitMessageGuard.blockedPatterns : null, ghUsageRecording })
    : null;

  // Commit-message guard (see commitGuard.js / startCommitGuard above):
  // independent of gitBroker -- this is a local-commit-content check, not a
  // network credential scope, so it's toggled by its own config flag and
  // wired into buildBwrapArgs separately below.
  const commitGuard = commitMessageGuard.enabled ? startCommitGuard(commitMessageGuard.blockedPatterns) : null;

  // The git broker only gates /usr/bin/ssh and gh as seen by bwrap's own
  // filesystem. When docker is also on, code inside the sandbox can run its
  // own containers via the nested dockerd (see sandbox-entrypoint.sh); those
  // containers get their own image filesystem and do NOT inherit the ssh/gh
  // wrapper binds. This only turns into a live-credential bypass when
  // ssh-agent forwarding is also on (authSock set): a nested container can
  // then mount the forwarded socket (bound at a fixed, discoverable path)
  // directly, reaching the real ssh binary with the real forwarded agent,
  // unscoped. sshAgent defaults to off precisely to keep this door shut; see
  // README "Known limitations" before turning it on alongside docker.
  if (docker && gitBroker && authSock) {
    console.warn(
      '[sandbox] docker + gitBroker + sshAgent are all enabled: a process inside the sandbox '
      + 'can use `docker run` to bypass the git credential broker entirely (nested containers '
      + "don't inherit the ssh wrapper and can mount the forwarded ssh-agent socket "
      + 'directly). See README "Known limitations" before relying on gitBroker as a hard boundary.',
    );
  }

  const { command, installDir } = resolveApp(app, claudeBin);

  // buildBwrapArgs can throw (invalid bind/env input). gitBroker/commitGuard
  // were already started above and their handles never reach the caller if we
  // throw here, so clean them up first or the live broker processes and their
  // runtime dirs leak.
  let bwrapArgs;
  let innerCmd;
  try {
    bwrapArgs = buildBwrapArgs({ cwd, docker, usesRootlesskit: docker, gpg, gpgVault: gpgVaultInfo, extraBinds: binds, extraEnv: env, authSock, stateDir, claudeDir: installDir, gitBroker, commitGuard, notifySocketPath, usageSocketPath, homeDir, app, tools, chat });
    const agentCmd = withClaude(targetCommand, command);
    innerCmd = [BASH, '/ccserver-sandbox-entrypoint.sh', ...(chat ? chatBridgeArgv({
      node: SANDBOX_NODE_PATH,
      script: SANDBOX_CHAT_BRIDGE_PATH,
      sock: `${SANDBOX_CHAT_DIR}/${CHAT_SOCK_NAME}`,
      passwordFile: `${SANDBOX_CHAT_DIR}/${CHAT_PASSWORD_NAME}`,
      bridgeArgs: chat.bridgeArgs,
    }, agentCmd) : agentCmd)];
  } catch (err) {
    if (gitBroker) { try { gitBroker.proc.kill('SIGTERM'); } catch { /* already dead */ } }
    if (gitBroker) { try { rmSync(gitBroker.dir, { recursive: true, force: true }); } catch { /* best effort */ } }
    if (commitGuard) { try { rmSync(commitGuard.dir, { recursive: true, force: true }); } catch { /* best effort */ } }
    throw err;
  }

  const gitBrokerFields = {
    // Effective gpgVault flag for this launch.
    gpgVaultActive: gpgVault,
    gitBrokerProc: gitBroker ? gitBroker.proc : null,
    gitBrokerDir: gitBroker ? gitBroker.dir : null,
    // No proc for the commit guard (see startCommitGuard) -- just a runtime
    // dir to remove on teardown, same as gitBrokerDir but with no process to kill.
    commitGuardDir: commitGuard ? commitGuard.dir : null,
    // Network isolation is qemu-only: the bwrap backend never arms it.
    sandboxNetworkBrokerProc: null,
    sandboxNetworkBrokerDir: null,
    networkBrokerAdminSock: null,
    networkIsolateArmed: false,
    networkIsolateMode: null,
  };

  if (docker) {
    // A nested-dockerd launch (docker:true) takes rootlesskit wrapping for a
    // private netns (stateDir was minted above for exactly this).
    // --disable-host-loopback stays: there is no broker for it to reach, and
    // no reason to widen its access to the host loopback.
    return {
      command: ROOTLESSKIT,
      args: [
        `--state-dir=${stateDir}`,
        '--net=slirp4netns',
        '--mtu=65520',
        '--slirp4netns-sandbox=auto',
        '--slirp4netns-seccomp=auto',
        '--disable-host-loopback',
        '--port-driver=builtin',
        // Only /etc is copied-up (for resolv.conf). We intentionally do NOT
        // copy-up /run so live host sockets there remain usable as bind
        // sources; bwrap gives the sandbox its own private /run instead.
        '--copy-up=/etc',
        '--propagation=rslave',
        BWRAP,
        ...bwrapArgs,
        '--',
        ...innerCmd,
      ],
      docker,
      stateDir,
      ...gitBrokerFields,
    };
  }

  return {
    command: BWRAP,
    args: [...bwrapArgs, '--', ...innerCmd],
    docker,
    stateDir,
    ...gitBrokerFields,
  };
}
