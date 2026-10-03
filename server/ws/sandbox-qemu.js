// QEMU sandbox backend (see README "QEMU sandbox"): each session runs in its
// own KVM virtual machine instead of a bwrap namespace.
//
//   - rootfs: a throwaway qcow2 overlay on a prebuilt "golden" Debian image
//     (server/cli/qemu-image-build.js), discarded when the session ends
//   - first-boot setup: cloud-init NoCloud, its seed served straight from a
//     host directory via QEMU's built-in vvfat driver (no ISO tooling needed)
//   - files: virtiofs shares for the project dir and the persistent HOME
//     (same host paths as the bwrap backend, see persistentHomeDir)
//   - terminal: the pty child is sandbox-qemu-launcher.cjs, which boots the
//     VM and then runs `ssh -tt` over a per-session key, reaching sshd
//     through the broker (no host port), so resize and signals behave like
//     any ssh session
//   - network: the NIC is attached (-netdev stream) to the per-session Go
//     broker, which runs the VM's entire network in userspace (ccserver-netbroker
//     vnet) and applies policy to every connection. There is no other path
//     out; isolation on/off is the broker's live enforce/open state
//
// This file is pure planning: it computes argv / cloud-init documents and
// writes the run dir. Process lifetime lives in the launcher and in
// sessionManager's teardown.

import { accessSync, chmodSync, constants as fsConstants, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { homedir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import remote from './sandbox-qemu-remote.cjs';
import { hotplugPortIds, HOTPLUG_TAG_PREFIX } from './qemuShares.js';
import { guestAgentDir, VM_AGENT_APPS } from './qemuAgents.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const QEMU_SYSTEM = '/usr/bin/qemu-system-x86_64';
export const QEMU_IMG = '/usr/bin/qemu-img';
export const BWRAP_BIN = '/usr/bin/bwrap';
const VIRTIOFSD_CANDIDATES = ['/usr/libexec/virtiofsd', '/usr/lib/qemu/virtiofsd'];
export const LAUNCHER_SCRIPT = join(__dirname, 'sandbox-qemu-launcher.cjs');

// Debian 13 genericcloud (cloud kernel: virtio + virtiofs, small and quick
// to boot). The checksum comes from Debian's signed-over-HTTPS SHA512SUMS.
export const BASE_IMAGE = Object.freeze({
  name: 'debian-13-genericcloud-amd64.qcow2',
  url: 'https://cloud.debian.org/images/cloud/trixie/latest/debian-13-genericcloud-amd64.qcow2',
  sumsUrl: 'https://cloud.debian.org/images/cloud/trixie/latest/SHA512SUMS',
});

// Packages baked into the golden image. Anything an agent installs at
// runtime is lost with the overlay; persistent tooling goes in HOME.
export const GOLDEN_PACKAGES = Object.freeze([
  'git', 'nodejs', 'nftables', 'ca-certificates', 'curl', 'jq', 'ripgrep',
  'python3', 'python3-venv', 'unzip', 'less', 'bash-completion', 'procps', 'zsh',
  // gpg for commits signed through the GPG vault relay (no keys in the VM).
  'gnupg',
  // Sessions sharing a persistent VM are confined from each other by bwrap
  // inside the guest (see qemuVmPool.js).
  'bubblewrap',
]);

// Per-VM resource bounds and defaults, shared by sandbox.config.json's
// `qemu` key (loadSandboxConfig) and the VM templates (vmTemplates.js).
export const QEMU_RESOURCE_LIMITS = Object.freeze({
  memoryMiB: Object.freeze({ min: 512, max: 262144, def: 4096 }),
  cpus: Object.freeze({ min: 1, max: 64, def: 2 }),
  diskGiB: Object.freeze({ min: 4, max: 2048, def: 32 }),
  bootTimeoutSec: Object.freeze({ min: 10, max: 1800, def: 120 }),
});

// The broker's virtual network (ccserver-netbroker vnet): .2 gateway, .3 DNS, .15 guest.
export const VNET_DNS = '10.0.2.3';
export const GUEST_MAC = '52:54:00:12:34:56';

export function qemuRoot() {
  return process.env.CCSERVER_SANDBOX_QEMU_ROOT || join(homedir(), '.local', 'share', 'ccserver-sandbox', 'qemu');
}

export function virtiofsdPath() {
  return VIRTIOFSD_CANDIDATES.find((p) => existsSync(p)) || null;
}

// TCG (no KVM) is only for tests: it works but boots ~10x slower.
function tcgAllowed() {
  return /^(1|true|yes|on)$/i.test(process.env.CCSERVER_QEMU_ALLOW_TCG || '');
}

function kvmUsable() {
  try {
    accessSync('/dev/kvm', fsConstants.R_OK | fsConstants.W_OK);
    return true;
  } catch {
    return false;
  }
}

// { ok, reason, hint } for the qemu backend on this host.
export function qemuStatus() {
  if (process.platform !== 'linux') {
    return { ok: false, reason: 'the qemu sandbox is Linux-only', hint: 'Use backend "bwrap" or launch without the sandbox.' };
  }
  if (!existsSync(QEMU_SYSTEM) || !existsSync(QEMU_IMG)) {
    return { ok: false, reason: 'qemu-system-x86_64 / qemu-img are not installed', hint: 'apt install qemu-system-x86 qemu-utils' };
  }
  if (!virtiofsdPath()) {
    return { ok: false, reason: 'virtiofsd is not installed', hint: 'apt install virtiofsd' };
  }
  if (!existsSync(BWRAP_BIN)) {
    return { ok: false, reason: 'bwrap is not installed (QEMU itself runs confined in it)', hint: 'apt install bubblewrap' };
  }
  if (!kvmUsable() && !tcgAllowed()) {
    return { ok: false, reason: '/dev/kvm is not accessible to the ccserver user', hint: 'Add the user to the kvm group (usermod -aG kvm <user>) and restart ccserver.' };
  }
  if (!currentGolden()) {
    return { ok: false, reason: 'no golden VM image has been built yet', hint: 'Run: node server/cli/qemu-image-build.js' };
  }
  return { ok: true, reason: null, hint: null };
}

export function qemuAvailable() {
  return qemuStatus().ok;
}

// --- golden image ------------------------------------------------------------

export function goldenDir() {
  return join(qemuRoot(), 'images');
}

// The image sessions boot from: images/current.json -> { version, file }.
export function currentGolden() {
  try {
    const meta = JSON.parse(readFileSync(join(goldenDir(), 'current.json'), 'utf-8'));
    const path = join(goldenDir(), meta.file);
    if (typeof meta.file !== 'string' || meta.file.includes('/') || !existsSync(path)) return null;
    return { ...meta, path };
  } catch {
    return null;
  }
}

function cloudConfig(obj) {
  // JSON is valid YAML: no hand-rolled quoting of user-controlled strings.
  return `#cloud-config\n${JSON.stringify(obj, null, 2)}\n`;
}

export const GOLDEN_OK_MARKER = 'CCSERVER-GOLDEN-IMAGE-OK';

// user-data for the one-off image build boot (network open, then poweroff).
export function buildGoldenUserData() {
  return cloudConfig({
    // No distro default user ("debian", uid 1000): it would collide with the
    // host uid each session recreates (see buildSessionUserData).
    users: [],
    package_update: true,
    package_upgrade: true,
    packages: [...GOLDEN_PACKAGES],
    write_files: [
      {
        // Session seeds only ever come from NoCloud; probing the other
        // datasources costs seconds on every boot.
        path: '/etc/cloud/cloud.cfg.d/90-ccserver.cfg',
        content: 'datasource_list: [ NoCloud, None ]\n',
      },
      {
        // Keys live outside HOME: HOME is a virtiofs mount of the persistent
        // project home, which must not be able to grant itself ssh access.
        path: '/etc/ssh/sshd_config.d/90-ccserver.conf',
        content: [
          'AuthorizedKeysFile /etc/ssh/ccserver-keys/%u',
          'PasswordAuthentication no',
          'KbdInteractiveAuthentication no',
          'PermitRootLogin no',
          'UseDNS no',
          '',
        ].join('\n'),
      },
      {
        // Boot speed: the cloud image logs the whole kernel boot (plus
        // earlyprintk) to the emulated serial port, one VM exit per byte --
        // seconds per boot. Keep ttyS0 as the console (cloud-init markers go
        // there) but quiet, and skip GRUB's menu/timeout.
        path: '/etc/default/grub.d/99-ccserver.cfg',
        content: [
          'GRUB_CMDLINE_LINUX="console=ttyS0,115200 quiet loglevel=3 systemd.show_status=error"',
          'GRUB_CMDLINE_LINUX_DEFAULT=""',
          'GRUB_TIMEOUT=0',
          'GRUB_TIMEOUT_STYLE=hidden',
          'GRUB_TERMINAL=console',
          '',
        ].join('\n'),
      },
    ],
    runcmd: [
      // Nothing in a session VM may reach out on its own schedule.
      ['systemctl', 'mask', 'apt-daily.timer', 'apt-daily-upgrade.timer', 'unattended-upgrades.service',
        'man-db.timer', 'e2scrub_all.timer', 'fstrim.timer', 'systemd-networkd-wait-online.service'],
      ['update-grub'],
      ['sh', '-c', 'apt-get clean && rm -rf /var/lib/apt/lists/*'],
      ['sh', '-c', 'rm -f /etc/ssh/ssh_host_* && truncate -s 0 /etc/machine-id'],
      ['sh', '-c', `echo ${GOLDEN_OK_MARKER} > /dev/ttyS0`],
    ],
    power_state: { mode: 'poweroff', timeout: 60, condition: true },
  });
}

// Version id of a golden image: changes whenever the base image or the
// build recipe changes, so a stale image is never silently reused.
export function goldenVersion(baseSha512) {
  return createHash('sha256').update(baseSha512).update('\0').update(buildGoldenUserData()).digest('hex').slice(0, 12);
}

// --- per-session plan --------------------------------------------------------

// Remote command quoting lives in a CJS module shared with the launcher.
export const { shellQuote, buildRemoteCommand, forwardedEnv } = remote;

export const READY_PREFIX = 'CCSERVER-READY-';

// Guest side of share hot-plug (qemuShares.js). The host runs
// `ssh ccs-admin@ccs-vm` with a key only it holds and writes one request
// line to its stdin; sshd forces that key onto ccs-share-ssh, which hands
// stdin to ccs-share as root. The
// helper can do nothing but mount a hot-plugged virtiofs tag on an absolute
// path, or unmount such a mount, so the boot-time shares (HOME, project,
// runtime) can never be unmounted through it.
export const GUEST_ADMIN_USER = 'ccs-admin';
export const GUEST_SHARE_HELPER = '/usr/local/sbin/ccs-share';
const GUEST_SHARE_SSH_HELPER = '/usr/local/sbin/ccs-share-ssh';
const GUEST_SHARE_SUDOERS = '/etc/sudoers.d/ccs-share';

export function buildGuestShareHelper() {
  return `#!/bin/bash
# Reads one request line from stdin:
#   mount <tag> <ro|rw> <absolute path>
#   umount <absolute path>
set -u
IFS= read -r line || exit 2
read -r op rest <<<"$line"
valid_path() {
  case "$1" in
    /*) ;;
    *) return 1 ;;
  esac
  case "/$1/" in
    */../*|*/./*) return 1 ;;
  esac
  return 0
}
case "$op" in
  mount)
    read -r tag mode path <<<"$rest"
    [[ "$tag" =~ ^${HOTPLUG_TAG_PREFIX}[0-9]+$ ]] || { echo "bad tag" >&2; exit 2; }
    [[ "$mode" == ro || "$mode" == rw ]] || { echo "bad mode" >&2; exit 2; }
    valid_path "$path" || { echo "bad path" >&2; exit 2; }
    cur=$(findmnt -n -o SOURCE --mountpoint "$path" 2>/dev/null | tail -n 1)
    [ "$cur" = "$tag" ] && exit 0
    mkdir -p -- "$path" || exit 1
    opts=""; [ "$mode" = ro ] && opts="-o ro"
    # The device may still be probing right after device_add.
    for i in $(seq 1 50); do
      mount -t virtiofs $opts -- "$tag" "$path" 2>/dev/null && exit 0
      sleep 0.1
    done
    mount -t virtiofs $opts -- "$tag" "$path"
    ;;
  umount)
    path=$rest
    valid_path "$path" || { echo "bad path" >&2; exit 2; }
    src=$(findmnt -n -o FSTYPE,SOURCE --mountpoint "$path" 2>/dev/null | tail -n 1)
    [ -z "$src" ] && exit 0
    [[ "$src" =~ ^virtiofs[[:space:]]+${HOTPLUG_TAG_PREFIX}[0-9]+$ ]] || { echo "not a hot-plugged share" >&2; exit 2; }
    for i in 1 2 3 4 5; do
      umount -- "$path" 2>/dev/null && exit 0
      sleep 0.5
    done
    # Still busy: detach it from the tree now; the last user closes it.
    umount -l -- "$path"
    ;;
  *)
    echo "unknown request" >&2; exit 2 ;;
esac
`;
}

// user-data pieces that install the admin channel (see GUEST_ADMIN_USER).
function guestAdminUserData(adminPubKey, fail) {
  return {
    bootLines: [
      `id -u ${GUEST_ADMIN_USER} >/dev/null 2>&1 || useradd -r -M -d / -s /bin/sh ${GUEST_ADMIN_USER} || { ${fail('useradd:admin')}; }`,
    ],
    writeFiles: [
      {
        path: `/etc/ssh/ccserver-keys/${GUEST_ADMIN_USER}`,
        content: `restrict,command="${GUEST_SHARE_SSH_HELPER}" ${adminPubKey.trim()}\n`,
        permissions: '0644',
      },
      {
        path: GUEST_SHARE_SSH_HELPER,
        // The request arrives on stdin; any command line is ignored.
        content: `#!/bin/sh\nexec sudo -n ${GUEST_SHARE_HELPER}\n`,
        permissions: '0755',
      },
      { path: GUEST_SHARE_HELPER, content: buildGuestShareHelper(), permissions: '0755' },
      {
        path: GUEST_SHARE_SUDOERS,
        content: `${GUEST_ADMIN_USER} ALL=(root) NOPASSWD: ${GUEST_SHARE_HELPER}\n`,
        permissions: '0440',
      },
    ],
  };
}
export const FAIL_PREFIX = 'CCSERVER-FAIL-';
// Printed first thing in bootcmd: the kernel is up and the session's setup
// (users, mounts, runtime, template steps) has begun. Only progress
// reporting reads it (the chat view's "VM 起動中…" -> "VM セットアップ中…").
export const SETUP_PREFIX = 'CCSERVER-SETUP-';

// Session user-data. Mounting and user creation happen in bootcmd (the
// earliest stage, in a fixed order we control) instead of cloud-init's
// users/mounts modules, whose relative ordering varies across releases and
// which would otherwise create HOME before the persistent HOME is mounted.
//
// runLines are shell lines run (as root, late in boot) before the READY
// marker, all in ONE script: cloud-init keeps going after a failed runcmd
// item, so READY must be unreachable once any setup step has failed.
// caCerts are PEM certificates to trust system-wide (the session MITM CA).
// bootLines are shell lines run (as root) right after the mounts, each
// failing the boot like the mounts do.
//
// template is a VM template's cloud-config, already checked by
// validateTemplateCloudConfig (see mergeTemplateCloudConfig), or null.
export function buildSessionUserData({ user, uid, gid, home, cwd, shares, sshPubKey, hostKey, readyToken, timezone, bootLines = [], runLines = [], writeFiles = [], caCerts = [], adminPubKey = null, template = null }) {
  const fail = (what) => `echo ${FAIL_PREFIX}${readyToken} ${what} > /dev/ttyS0; exit 1`;
  const tpl = templateUserDataParts(template);
  const admin = adminPubKey ? guestAdminUserData(adminPubKey, fail) : { bootLines: [], writeFiles: [] };
  const mounts = shares
    .filter((s) => s.guestPath)
    .map((s) => `mkdir -p ${shellQuote(s.guestPath)} && mount -t virtiofs ${s.readonly ? '-o ro ' : ''}${shellQuote(s.tag)} ${shellQuote(s.guestPath)} || { ${fail(`mount:${s.tag}`)}; }`);
  return cloudConfig({
    ...tpl.passthrough,
    users: [],
    disable_root: true,
    ssh_pwauth: false,
    ...(timezone ? { timezone } : {}),
    ssh_keys: {
      ed25519_private: hostKey.privateKey,
      ed25519_public: hostKey.publicKey,
    },
    // ed25519 is supplied above, so nothing is generated (an empty list
    // is a schema error).
    ssh_genkeytypes: ['ed25519'],
    ...(caCerts.length ? { ca_certs: { trusted: caCerts } } : {}),
    bootcmd: [
      ['sh', '-c', [
        'set -u',
        `echo ${SETUP_PREFIX}${readyToken} > /dev/ttyS0`,
        // The host uid/gid must map 1:1 so virtiofs ownership matches; an
        // image account already holding either id is removed first.
        `o=$(getent passwd ${uid} | cut -d: -f1); [ -n "$o" ] && [ "$o" != ${shellQuote(user)} ] && userdel "$o"`,
        `o=$(getent group ${gid} | cut -d: -f1); [ -n "$o" ] && [ "$o" != ${shellQuote(user)} ] && groupdel "$o"`,
        `getent group ${gid} >/dev/null || groupadd -g ${gid} ${shellQuote(user)} || { ${fail('groupadd')}; }`,
        `id -u ${shellQuote(user)} >/dev/null 2>&1 || useradd -M -u ${uid} -g ${gid} -d ${shellQuote(home)} -s /bin/bash ${shellQuote(user)} || { ${fail('useradd')}; }`,
        // After the session user, so its system uid cannot take the host's.
        ...admin.bootLines,
        ...mounts,
        ...(cwd ? [`test -d ${shellQuote(cwd)} || { ${fail('cwd')}; }`] : []),
        ...bootLines.map((l) => `${l.cmd} || { ${fail(l.what)}; }`),
      ].join('\n')],
      // The template's own bootcmd runs after ccserver's (user, mounts).
      ...tpl.bootcmd,
    ],
    write_files: [
      {
        path: `/etc/ssh/ccserver-keys/${user}`,
        content: `${sshPubKey.trim()}\n`,
        permissions: '0644',
      },
      ...admin.writeFiles,
      ...writeFiles,
      ...tpl.writeFiles,
    ],
    runcmd: [
      ['sh', '-c', [
        ...[...runLines, ...tpl.runLines].map((l) => `${l.cmd} || { ${fail(l.what)}; }`),
        `echo ${READY_PREFIX}${readyToken} > /dev/ttyS0`,
      ].join('\n')],
    ],
  });
}

// ---- VM template cloud-config ---------------------------------------------
//
// A VM template (vmTemplates.js) carries extra cloud-config the operator
// writes in the Settings GUI. Only these top-level keys are accepted; the
// rest (users, ssh keys, ca_certs, power_state, network, ...) belong to
// ccserver's session setup and are refused rather than silently dropped.
export const TEMPLATE_CLOUD_CONFIG_KEYS = Object.freeze([
  'packages', 'package_update', 'package_upgrade', 'apt', 'locale',
  'bootcmd', 'write_files', 'runcmd',
]);

// write_files may not touch what ccserver's own setup owns: sshd's key and
// config files, cloud-init's config, the host-service units and the helper
// paths buildGuestRuntime links.
const TEMPLATE_FORBIDDEN_WRITE_PREFIXES = ['/etc/ssh/', '/etc/cloud/', '/etc/systemd/system/ccs-svc-', '/ccserver-sandbox', '/run/ccserver/', GUEST_SHARE_HELPER, GUEST_SHARE_SUDOERS];

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isCommand(v) {
  return (typeof v === 'string' && v.trim() !== '')
    || (Array.isArray(v) && v.length > 0 && v.every((a) => typeof a === 'string' || typeof a === 'number'));
}

// Package names as the guest's dpkg knows them: "name", "name=version" or
// ["name", "version"].
function packageName(p) {
  const raw = Array.isArray(p) ? p[0] : p;
  return typeof raw === 'string' ? raw.split('=')[0].trim() : '';
}

// Checks a parsed cloud-config object (null/undefined = no template config).
// Returns { ok: true, value } with only the accepted keys, or
// { ok: false, errors: [message] }.
export function validateTemplateCloudConfig(obj) {
  if (obj === null || obj === undefined) return { ok: true, value: {} };
  if (!isPlainObject(obj)) return { ok: false, errors: ['cloud-config must be a mapping (key: value)'] };
  const errors = [];
  for (const k of Object.keys(obj)) {
    if (!TEMPLATE_CLOUD_CONFIG_KEYS.includes(k)) {
      errors.push(`"${k}" is not allowed (allowed: ${TEMPLATE_CLOUD_CONFIG_KEYS.join(', ')})`);
    }
  }
  for (const k of ['package_update', 'package_upgrade']) {
    if (obj[k] !== undefined && typeof obj[k] !== 'boolean') errors.push(`${k} must be true or false`);
  }
  if (obj.locale !== undefined && (typeof obj.locale !== 'string' || !/^[A-Za-z0-9_.@-]+$/.test(obj.locale))) {
    errors.push('locale must be a locale name such as en_US.UTF-8');
  }
  if (obj.apt !== undefined && !isPlainObject(obj.apt)) errors.push('apt must be a mapping');
  if (obj.packages !== undefined) {
    if (!Array.isArray(obj.packages)) errors.push('packages must be a list');
    else {
      obj.packages.forEach((p, i) => {
        const name = packageName(p);
        const okShape = typeof p === 'string' || (Array.isArray(p) && p.length === 2 && p.every((x) => typeof x === 'string'));
        if (!okShape || !/^[a-z0-9][a-z0-9+.-]*$/.test(name)) errors.push(`packages[${i}] is not a package name`);
      });
    }
  }
  for (const k of ['bootcmd', 'runcmd']) {
    if (obj[k] === undefined) continue;
    if (!Array.isArray(obj[k])) { errors.push(`${k} must be a list`); continue; }
    obj[k].forEach((c, i) => {
      if (!isCommand(c)) errors.push(`${k}[${i}] must be a command string or a list of arguments`);
    });
  }
  if (obj.write_files !== undefined) {
    if (!Array.isArray(obj.write_files)) errors.push('write_files must be a list');
    else {
      obj.write_files.forEach((f, i) => {
        if (!isPlainObject(f) || typeof f.path !== 'string') { errors.push(`write_files[${i}] needs a path`); return; }
        const p = f.path;
        if (!p.startsWith('/') || p.split('/').includes('..')) { errors.push(`write_files[${i}].path must be an absolute path without ".."`); return; }
        const norm = p.replace(/\/{2,}/g, '/');
        if (TEMPLATE_FORBIDDEN_WRITE_PREFIXES.some((pre) => norm === pre.replace(/\/$/, '') || norm.startsWith(pre))) {
          errors.push(`write_files[${i}].path ${p} is reserved by ccserver`);
        }
      });
    }
  }
  if (errors.length) return { ok: false, errors };
  const value = {};
  for (const k of TEMPLATE_CLOUD_CONFIG_KEYS) if (obj[k] !== undefined) value[k] = obj[k];
  return { ok: true, value };
}

// How a validated template config enters the session user-data (pure):
//   passthrough: packages / package_update / package_upgrade / apt / locale,
//                as top-level keys (ccserver's own keys are spread after
//                them, so they can never be overridden)
//   bootcmd:     appended after ccserver's bootcmd
//   writeFiles:  appended after ccserver's write_files
//   runLines:    runcmd, run inside the READY script so a failing command
//                fails the boot instead of being skipped (cloud-init keeps
//                going after a failed runcmd item); package installs are
//                checked there too, since a failed install does not stop
//                cloud-init either
function templateUserDataParts(template) {
  const t = template || {};
  const passthrough = {};
  for (const k of ['packages', 'package_update', 'package_upgrade', 'apt', 'locale']) {
    if (t[k] !== undefined) passthrough[k] = t[k];
  }
  const asShell = (c) => (Array.isArray(c) ? c.map((a) => shellQuote(String(a))).join(' ') : `sh -c ${shellQuote(c)}`);
  const runLines = [
    ...(t.packages || []).map((p) => {
      const name = packageName(p);
      return { what: `template-package:${name}`, cmd: `dpkg-query -W -f='\${Status}' ${shellQuote(name)} 2>/dev/null | grep -q 'ok installed'` };
    }),
    ...(t.runcmd || []).map((c, i) => ({ what: `template-runcmd:${i}`, cmd: asShell(c) })),
  ];
  return { passthrough, bootcmd: t.bootcmd || [], writeFiles: t.write_files || [], runLines };
}

// ---- Host services and helper files inside the VM ------------------------
//
// The bwrap backend binds ccserver's host sockets (git broker, GPG vault
// relay, ssh-agent, MCP bridges) and helper scripts at fixed in-sandbox
// paths. In the VM the same paths are recreated so the helpers
// (sandbox-*.cjs) run unchanged:
//
//   - host sockets: the broker exposes each at SERVICE_IP:<port>, outside
//     network policy (ccserver-netbroker README "サービスアドレス"); in the guest
//     a systemd socket unit listens on the fixed path and the stock
//     systemd-socket-proxyd relays each connection there. No ccserver
//     software runs resident in the guest.
//   - files: copied into the run dir's rt/ (never the repo files
//     themselves) and shared read-only (virtiofsd --readonly + mount -o ro)
//     at GUEST_RT_DIR; bootcmd symlinks the fixed paths onto it.

export const SERVICE_IP = '10.0.2.100';
export const GUEST_RT_DIR = '/ccserver-sandbox';

// opencode chat mode inside a VM: the bridge and password file (in the rt
// share, see buildGuestRuntime) and the relay socket the bridge listens on,
// which the session's ssh forwards to a host socket (-L, see
// buildGuestSshArgs). The socket dir is the guest user's own: the bridge
// creates it, sshd (as that user) connects to it.
const GUEST_CHAT_BRIDGE_NAME = 'chat-bridge.cjs';
const GUEST_CHAT_PASSWORD_NAME = 'chat-password';
export const GUEST_CHAT_BRIDGE = `${GUEST_RT_DIR}/${GUEST_CHAT_BRIDGE_NAME}`;
export const GUEST_CHAT_PASSWORD = `${GUEST_RT_DIR}/${GUEST_CHAT_PASSWORD_NAME}`;
export const GUEST_CHAT_SOCK = '/tmp/ccserver-chat/oc.sock';
export const GUEST_GNUPG_DIR = '/run/ccserver/gnupg-vault';
export const GUEST_SSH_AGENT_SOCK = '/run/ccserver/ssh-agent.sock';
export const SERVICE_PORTS = Object.freeze({
  'git-broker': 7001,
  'gpg-agent': 7010,
  'gpg-agent-ssh': 7011,
  'ssh-agent': 7012,
  'mcp-notify': 7020,
  'mcp-usage': 7021,
  'mcp-reviewer': 7023,
});
const GUEST_REAL_SSH = '/usr/bin/ssh';
const GUEST_SSH_WRAPPER = '/usr/local/bin/ssh';
const MCP_SOCKETS = [
  ['notify', 'CCSANDBOX_NOTIFY_MCP_SOCK'],
  ['usage', 'CCSANDBOX_USAGE_MCP_SOCK'],
  ['reviewer', 'CCSANDBOX_REVIEWER_MCP_SOCK'],
];

// What to bring into the VM, from buildQemuSpawn's started brokers. Pure:
// the returned spec is materialized by prepareQemuSession.
//
//   scripts:      host paths of the helper files ({ credHelper, ghWrapper,
//                 sshWrapper, mcpBridge, commitMsgHook, gitconfig,
//                 knownHostsDefault, sshConfig, knownHostsUser|null })
//   gitBroker:    startGitBroker()'s { sockPath, allowlistPath, token } or null
//   commitGuard:  startCommitGuard()'s { configPath } or null
//   gpgVault:     { homeDir, fingerprint, nameReal, nameEmail, sockets:
//                 { agent, agentSsh } (the relay's fixed paths) } or null
//   sshAgentSock: host ssh-agent socket or null (ignored with gpgVault)
//   mcp:          { notify, usage, reviewer } host socket paths
//
// Returns { files: [{ src | data, dest, mode }] (dest relative to rt/),
// links: [[guestPath, target]], services: [{ name, addr, unix, guestPath }],
// gnupgFiles: [names], env, gitConfig: [[key, value]] }.
//   chat:         { bridge, passwordFile } host paths for an opencode chat
//                 launch (opencode-chat-bridge.cjs), or null
export function buildGuestRuntime({ scripts, gitBroker = null, commitGuard = null, gpgVault = null, sshAgentSock = null, mcp = {}, chat = null }) {
  const rt = (name) => `${GUEST_RT_DIR}/${name}`;
  const files = [];
  const links = [];
  const services = [];
  const env = {};
  const gitConfig = [];
  const gnupgFiles = [];
  const service = (name, unix, guestPath) => {
    services.push({ name, addr: `${SERVICE_IP}:${SERVICE_PORTS[name]}`, unix, guestPath });
  };
  const needNode = gitBroker || commitGuard || chat || MCP_SOCKETS.some(([k]) => mcp[k]);
  // Wrapper shebangs are #!/ccserver-sandbox-node; the guest's own node runs them.
  if (needNode) links.push(['/ccserver-sandbox-node', '/usr/bin/node']);

  if (gitBroker) {
    files.push(
      { src: scripts.credHelper, dest: 'git-credential-helper.cjs', mode: 0o755 },
      { src: scripts.ghWrapper, dest: 'gh-wrapper.cjs', mode: 0o755 },
      { src: scripts.sshWrapper, dest: 'ssh-wrapper.cjs', mode: 0o755 },
      { src: scripts.gitconfig, dest: 'gitconfig', mode: 0o644 },
      { src: gitBroker.allowlistPath, dest: 'git-allowlist.json', mode: 0o644 },
      { src: scripts.knownHostsDefault, dest: 'known-hosts-default', mode: 0o644 },
      { src: scripts.sshConfig, dest: 'ssh-config', mode: 0o644 },
      // Read from a file, not the env: the env is part of the host-side ssh
      // command line, visible to every process of the same host user.
      { data: `${gitBroker.token || ''}\n`, dest: 'git-broker-token', mode: 0o600 },
      // An empty file when the host has none: the pinned ssh config names both.
      scripts.knownHostsUser
        ? { src: scripts.knownHostsUser, dest: 'known-hosts-user', mode: 0o644 }
        : { data: '', dest: 'known-hosts-user', mode: 0o644 },
    );
    links.push(
      ['/ccserver-sandbox-git-credential-helper.cjs', rt('git-credential-helper.cjs')],
      ['/ccserver-sandbox-git-allowlist.json', rt('git-allowlist.json')],
      ['/ccserver-sandbox-known-hosts-user', rt('known-hosts-user')],
      ['/ccserver-sandbox-known-hosts-default', rt('known-hosts-default')],
      ['/ccserver-sandbox-ssh-config', rt('ssh-config')],
      // The image has no gh; /usr/local/bin precedes /usr/bin on PATH, so
      // plain `ssh` resolves to the gate too (as in bwrap, where the wrapper
      // is bound over the real binary).
      ['/usr/local/bin/gh', rt('gh-wrapper.cjs')],
      [GUEST_SSH_WRAPPER, rt('ssh-wrapper.cjs')],
    );
    service('git-broker', gitBroker.sockPath, '/ccserver-sandbox-git-broker.sock');
    Object.assign(env, {
      // ~/.gitconfig is the persistent (guest-writable) HOME's: point git
      // at ours instead of overwriting it (bwrap ro-binds over it).
      GIT_CONFIG_GLOBAL: rt('gitconfig'),
      GIT_CONFIG_NOSYSTEM: '1',
      CCSANDBOX_GIT_BROKER_SOCK: '/ccserver-sandbox-git-broker.sock',
      CCSANDBOX_GIT_ALLOWLIST: '/ccserver-sandbox-git-allowlist.json',
      CCSANDBOX_GIT_BROKER_TOKEN_FILE: rt('git-broker-token'),
      CCSANDBOX_REAL_SSH: GUEST_REAL_SSH,
      GIT_SSH_COMMAND: GUEST_SSH_WRAPPER,
      CCSANDBOX_SSH_CONFIG: '/ccserver-sandbox-ssh-config',
    });
  }

  if (commitGuard) {
    files.push(
      { src: scripts.commitMsgHook, dest: 'git-hooks/commit-msg', mode: 0o755 },
      { src: commitGuard.configPath, dest: 'commit-guard.json', mode: 0o644 },
    );
    links.push(
      ['/ccserver-sandbox-git-hooks', rt('git-hooks')],
      ['/ccserver-sandbox-commit-guard.json', rt('commit-guard.json')],
    );
    env.CCSANDBOX_COMMIT_GUARD_CONFIG = '/ccserver-sandbox-commit-guard.json';
    gitConfig.push(['core.hooksPath', '/ccserver-sandbox-git-hooks']);
  }

  if (gpgVault) {
    // Public metadata only (never the vault's homeDir): copied into the
    // guest's tmpfs GNUPGHOME at boot so gpg can keep its lock files there.
    for (const name of ['pubring.kbx', 'trustdb.gpg', 'gpg.conf']) {
      const src = join(gpgVault.homeDir, name);
      if (!existsSync(src)) continue;
      files.push({ src, dest: `gnupg/${name}`, mode: 0o644 });
      gnupgFiles.push(name);
    }
    service('gpg-agent', gpgVault.sockets.agent, `${GUEST_GNUPG_DIR}/S.gpg-agent`);
    service('gpg-agent-ssh', gpgVault.sockets.agentSsh, `${GUEST_GNUPG_DIR}/S.gpg-agent.ssh`);
    env.GNUPGHOME = GUEST_GNUPG_DIR;
    env.SSH_AUTH_SOCK = `${GUEST_GNUPG_DIR}/S.gpg-agent.ssh`;
    gitConfig.push(
      ['user.signingkey', gpgVault.fingerprint],
      ['commit.gpgsign', 'true'],
      ['gpg.program', 'gpg'],
      ['user.name', gpgVault.nameReal],
      ['user.email', gpgVault.nameEmail],
    );
  } else if (sshAgentSock) {
    service('ssh-agent', sshAgentSock, GUEST_SSH_AGENT_SOCK);
    env.SSH_AUTH_SOCK = GUEST_SSH_AGENT_SOCK;
  }

  let anyMcp = false;
  for (const [kind, envName] of MCP_SOCKETS) {
    if (!mcp[kind]) continue;
    anyMcp = true;
    const guestPath = `/ccserver-sandbox-${kind}.d/sock`;
    service(`mcp-${kind}`, mcp[kind], guestPath);
    env[envName] = guestPath;
  }
  if (anyMcp) {
    files.push({ src: scripts.mcpBridge, dest: 'mcp-bridge.cjs', mode: 0o755 });
    links.push(['/ccserver-sandbox-mcp-bridge', rt('mcp-bridge.cjs')]);
  }

  // opencode chat mode: the bridge runs from the read-only rt share and
  // reads the server password from it (a file, never the ssh command line).
  if (chat) {
    files.push(
      { src: chat.bridge, dest: GUEST_CHAT_BRIDGE_NAME, mode: 0o755 },
      { src: chat.passwordFile, dest: GUEST_CHAT_PASSWORD_NAME, mode: 0o600 },
    );
  }
  return { files, links, services, gnupgFiles, env, gitConfig };
}

// GIT_CONFIG_COUNT/KEY_n/VALUE_n for ccserver's own entries plus any the
// operator put in sandbox.config.json env. ccserver's come first and the
// operator's are renumbered after them: git applies them in order, so the
// operator can still override a value, but can no longer erase ccserver's
// entries (e.g. the commit-msg guard's core.hooksPath) by setting
// GIT_CONFIG_COUNT. Returns the env without the operator's GIT_CONFIG_*
// keys, the merged GIT_CONFIG_* vars, and warnings.
export function composeGitConfigEnv(entries, env = {}) {
  const rest = {};
  const user = [];
  const count = Number.parseInt(env.GIT_CONFIG_COUNT, 10);
  for (const [k, v] of Object.entries(env)) {
    if (k === 'GIT_CONFIG_COUNT' || /^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(k)) continue;
    rest[k] = v;
  }
  if (Number.isInteger(count) && count > 0) {
    for (let i = 0; i < count; i++) {
      const key = env[`GIT_CONFIG_KEY_${i}`];
      if (typeof key !== 'string' || !key) continue;
      user.push([key, String(env[`GIT_CONFIG_VALUE_${i}`] ?? '')]);
    }
  }
  const warnings = [];
  const ours = new Set(entries.map(([k]) => k.toLowerCase()));
  for (const [k] of user) {
    if (k.toLowerCase() === 'core.hookspath' && ours.has('core.hookspath')) {
      warnings.push('sandbox.config.json env overrides core.hooksPath: the commit-message guard hook will not run');
    }
  }
  const all = [...entries, ...user];
  const gitEnv = {};
  if (all.length) {
    gitEnv.GIT_CONFIG_COUNT = String(all.length);
    all.forEach(([k, v], i) => {
      gitEnv[`GIT_CONFIG_KEY_${i}`] = k;
      gitEnv[`GIT_CONFIG_VALUE_${i}`] = String(v);
    });
  }
  return { env: rest, gitEnv, warnings };
}

// Guest-side half of buildGuestRuntime: user-data pieces (pure).
export function buildGuestRuntimeUserData(runtime, { uid, gid }) {
  const q = shellQuote;
  const bootLines = [];
  for (const [link, target] of runtime.links) {
    bootLines.push({ what: `link:${link}`, cmd: `mkdir -p ${q(dirname(link))} && ln -sfn ${q(target)} ${q(link)}` });
  }
  if (runtime.services.some((s) => s.guestPath.startsWith(`${GUEST_GNUPG_DIR}/`)) || runtime.gnupgFiles.length) {
    bootLines.push({ what: 'gnupg', cmd: `install -d -o ${uid} -g ${gid} -m 0700 ${q(GUEST_GNUPG_DIR)}` });
    for (const name of runtime.gnupgFiles) {
      bootLines.push({ what: `gnupg:${name}`, cmd: `install -o ${uid} -g ${gid} -m 0600 ${q(`${GUEST_RT_DIR}/gnupg/${name}`)} ${q(`${GUEST_GNUPG_DIR}/${name}`)}` });
    }
  }
  const writeFiles = [];
  const units = [];
  for (const s of runtime.services) {
    const unit = `ccs-svc-${s.name}`;
    units.push(`${unit}.socket`);
    writeFiles.push(
      {
        path: `/etc/systemd/system/${unit}.socket`,
        permissions: '0644',
        content: [
          '[Socket]',
          `ListenStream=${s.guestPath}`,
          `SocketUser=${uid}`,
          `SocketGroup=${gid}`,
          'SocketMode=0600',
          'DirectoryMode=0755',
          'Accept=no',
          '',
        ].join('\n'),
      },
      {
        path: `/etc/systemd/system/${unit}.service`,
        permissions: '0644',
        content: [
          '[Unit]',
          `Requires=${unit}.socket`,
          `After=${unit}.socket`,
          '[Service]',
          `ExecStart=/usr/lib/systemd/systemd-socket-proxyd ${s.addr}`,
          'DynamicUser=yes',
          'PrivateTmp=yes',
          'NoNewPrivileges=yes',
          '',
        ].join('\n'),
      },
    );
  }
  const runLines = units.length
    ? [{ what: 'services', cmd: `systemctl daemon-reload && systemctl start ${units.join(' ')}` }]
    : [];
  return { bootLines, writeFiles, runLines };
}

// Host-side half: copies the runtime files into runDir/rt (0700 dir).
function materializeGuestRuntime(runtime, rtDir) {
  mkdirSync(rtDir, { recursive: true, mode: 0o700 });
  for (const f of runtime.files) {
    const dest = join(rtDir, f.dest);
    mkdirSync(dirname(dest), { recursive: true, mode: 0o755 });
    if (f.src !== undefined) copyFileSync(f.src, dest);
    else writeFileSync(dest, f.data);
    chmodSync(dest, f.mode);
  }
  // virtiofs exposes host modes as-is. The share holds nothing secret except
  // the 0600 token file, so the root is world-traversable like the bwrap
  // binds it replaces (the host run dir above it stays 0700).
  chmodSync(rtDir, 0o755);
}

// NoCloud network-config: static addressing on the broker's virtual
// network (ccserver-netbroker vnet owns 10.0.2.2 and 10.0.2.3). Nothing in the guest
// redirects or relays anything: whatever the guest connects to terminates in
// the broker, which applies policy. Static also skips DHCP at boot.
export function buildNetworkConfig() {
  return `${JSON.stringify({
    version: 2,
    ethernets: {
      ccs0: {
        match: { name: 'en*' },
        dhcp4: false,
        dhcp6: false,
        addresses: ['10.0.2.15/24'],
        routes: [{ to: 'default', via: '10.0.2.2' }],
        nameservers: { addresses: [VNET_DNS] },
      },
    },
  }, null, 2)}\n`;
}

// Where the guest finds a CA bundle that includes the session MITM CA once
// cloud-init's ca_certs module has run update-ca-certificates. Runtimes that
// ignore the system store are pointed at it explicitly.
export const GUEST_CA_BUNDLE = '/etc/ssl/certs/ca-certificates.crt';
export const MITM_CA_ENV = Object.freeze({
  NODE_EXTRA_CA_CERTS: GUEST_CA_BUNDLE,
  SSL_CERT_FILE: GUEST_CA_BUNDLE,
  REQUESTS_CA_BUNDLE: GUEST_CA_BUNDLE,
  CURL_CA_BUNDLE: GUEST_CA_BUNDLE,
});

export function buildVirtiofsdArgs({ socketPath, sharedDir, readonly = false }) {
  return [
    `--socket-path=${socketPath}`,
    `--shared-dir=${sharedDir}`,
    '--sandbox=namespace',
    '--cache=auto',
    '--announce-submounts',
    ...(readonly ? ['--readonly'] : []),
  ];
}

// QEMU option values are comma-separated; a literal comma must be doubled.
function qemuOptEscape(s) {
  return String(s).replace(/,/g, ',,');
}

// QEMU parses guest-controlled device traffic in C; if a bug there were
// exploited, the attacker would hold whatever QEMU can reach. So QEMU runs
// inside bwrap seeing only what it needs: /usr (ro), /dev/kvm, the golden
// image (ro), this session's run dir and the broker's vnet socket. No HOME,
// no other projects, no network namespace (QEMU itself never networks),
// and --die-with-parent + its own pid namespace mean the launcher's death
// always takes QEMU with it.
export function buildQemuConfinement({ runDir, goldenPath, vnetSock }) {
  return [
    '--die-with-parent',
    '--new-session',
    '--unshare-all',
    '--ro-bind', '/usr', '/usr',
    '--symlink', 'usr/bin', '/bin',
    '--symlink', 'usr/sbin', '/sbin',
    '--symlink', 'usr/lib', '/lib',
    '--symlink', 'usr/lib64', '/lib64',
    '--ro-bind-try', '/etc/ld.so.cache', '/etc/ld.so.cache',
    '--proc', '/proc',
    '--dev', '/dev',
    '--dev-bind', '/dev/kvm', '/dev/kvm',
    '--tmpfs', '/tmp',
    '--ro-bind', goldenPath, goldenPath,
    '--bind', runDir, runDir,
    '--bind', vnetSock, vnetSock,
  ];
}

// pcie.0 slots from here on hold the hot-plug root ports; the devices
// buildQemuArgs adds before them are auto-assigned the low slots.
const HOTPLUG_FIRST_SLOT = 0x10;

export function buildQemuArgs({ name, memoryMiB, cpus, overlay, seedDir, shares, vnetSock, consoleLog, qmpSocket, hotplugPorts = [], kvm = true }) {
  // The NIC's only peer is the broker's userspace network stack: no slirp,
  // no host networking inside QEMU at all.
  const netdev = `stream,id=n0,server=off,addr.type=unix,addr.path=${qemuOptEscape(vnetSock)}`;
  const args = [
    '-name', `ccs-${name}`,
    '-nodefaults', '-no-user-config',
    '-machine', `q35,accel=${kvm ? 'kvm' : 'tcg'}`,
    '-cpu', kvm ? 'host' : 'max',
    '-smp', String(cpus),
    '-m', `${memoryMiB}M`,
    // vhost-user-fs requires guest RAM to be a shareable fd.
    '-object', `memory-backend-memfd,id=mem,size=${memoryMiB}M,share=on`,
    '-numa', 'node,memdev=mem',
    // The rootfs is disposable, so host-crash durability buys nothing.
    '-drive', `file=${overlay},if=virtio,format=qcow2,cache=unsafe,discard=unmap`,
    '-drive', `if=virtio,format=raw,readonly=on,file.driver=vvfat,file.dir=${seedDir},file.label=CIDATA`,
    '-device', 'virtio-rng-pci',
    // Debian's cloud image reboot-loops right after GRUB when the VM has no
    // display adapter at all (-nodefaults removes it). Nothing is ever shown.
    '-device', 'VGA',
    '-netdev', netdev,
    '-device', `virtio-net-pci,netdev=n0,mac=${GUEST_MAC}`,
    '-display', 'none',
    '-serial', `file:${consoleLog}`,
    '-qmp', `unix:${qmpSocket},server=on,wait=off`,
    // seccomp for the emulator itself: QEMU never needs to exec anything
    // now that networking lives in the broker.
    '-sandbox', 'on,obsolete=deny,elevateprivileges=deny,spawn=deny,resourcecontrol=deny',
  ];
  shares.forEach((s, i) => {
    args.push('-chardev', `socket,id=fs${i},path=${s.socketPath}`);
    args.push('-device', `vhost-user-fs-pci,chardev=fs${i},tag=${s.tag}`);
  });
  // Empty root ports for shares attached later over QMP (qemuShares.js):
  // q35's root bus takes no hot-plugged devices. Packed eight to a slot as
  // functions of one multifunction device (as libvirt does): pcie.0 has
  // only 32 slots and the devices above already use several.
  hotplugPorts.forEach((id, i) => {
    const slot = HOTPLUG_FIRST_SLOT + Math.floor(i / 8);
    const fn = i % 8;
    args.push('-device', `pcie-root-port,id=${id},chassis=${i + 1},addr=0x${slot.toString(16)}.0x${fn}${fn === 0 ? ',multifunction=on' : ''}`);
  });
  return args;
}

// Root ports reserved for hot-plugged shares on every VM.
export const DEFAULT_HOTPLUG_SLOTS = 8;

// ssh into the guest through the broker's VM network: no host TCP port
// exists. tty: a session terminal (-tt) rather than a one-shot command.
//
// forwards: [[hostSocket, guestSocket]] unix-socket forwards (-L) for the
// session login (opencode chat mode's relay socket). Each host socket is
// created 0600 and replaced if stale.
export function buildGuestSshArgs({ keyPath, knownHosts, network, user, tty, forwards = [] }) {
  return [
    ...(tty ? ['-tt'] : ['-T']), '-q',
    ...forwards.flatMap(([host, guest]) => ['-L', `${host}:${guest}`]),
    ...(forwards.length ? ['-o', 'StreamLocalBindUnlink=yes', '-o', 'StreamLocalBindMask=0177', '-o', 'ExitOnForwardFailure=yes'] : []),
    '-i', keyPath,
    '-o', `ProxyCommand=${shellQuote(network.pipeBin)} pipe ${shellQuote(network.guestSshSock)}`,
    '-o', 'IdentitiesOnly=yes',
    '-o', 'IdentityAgent=none',
    '-o', 'HostKeyAlias=ccs-vm',
    '-o', `UserKnownHostsFile=${knownHosts}`,
    '-o', 'StrictHostKeyChecking=yes',
    '-o', 'GlobalKnownHostsFile=/dev/null',
    '-o', 'ForwardAgent=no',
    '-o', 'ForwardX11=no',
    '-o', 'ServerAliveInterval=30',
    '-o', 'LogLevel=ERROR',
    ...(tty ? [] : ['-o', 'BatchMode=yes']),
    '-F', '/dev/null',
    `${user}@ccs-vm`,
  ];
}

function generateSshKeyPair(dir, name, comment) {
  const path = join(dir, name);
  execFileSync('/usr/bin/ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', comment, '-f', path], { stdio: 'ignore' });
  return { privateKey: readFileSync(path, 'utf-8'), publicKey: readFileSync(`${path}.pub`, 'utf-8').trim(), path };
}

// Creates the per-session run dir (overlay, seed, keys) and returns the
// launcher plan. Throws on any setup failure; the caller removes runDir.
//
//   homeHostPath: the persistent HOME to mount at $HOME, or null for a
//                 fresh one inside the run dir (removed with it)
//   env:          static guest env (sandbox.config.json env); the launcher
//                 adds the terminal/agent subset of the pty env at run time
//   extraShares:  [{ tag, hostPath, guestPath, readonly }]
//   runtime:      buildGuestRuntime()'s spec (host services and helper
//                 files), or null for none
//   network:      the started Go broker: { vnetSock, guestSshSock,
//                 pipeBin, caPem }. Required: the VM's only network is the
//                 broker's (ccserver-netbroker vnet); "no isolation" is the broker's
//                 live open state, never a host-connected netdev.
//   templateCloudConfig: the VM template's validated cloud-config (see
//                 validateTemplateCloudConfig), or null
//   sshForwards:  [[hostSocket, guestSocket]] for the session ssh (see
//                 buildGuestSshArgs), or none

export function prepareQemuSession(opts) {
  return prepareVm({ ...opts, pooled: false });
}

// A persistent VM shared by many sessions (qemuVmPool.js): no boot-time
// project/HOME shares (each session hot-plugs its own) and no session
// command (each session logs in over ssh). The guest user's own home stays
// a plain directory on the rootfs; sessions bind their HOME over it inside
// bwrap.
export function prepareQemuPoolVm({ network, env = {}, memoryMiB, cpus, diskGiB, bootTimeoutSec, templateCloudConfig = null, hotplugSlots = POOL_HOTPLUG_SLOTS }) {
  return prepareVm({ cwd: null, argv: null, env, network, memoryMiB, cpus, diskGiB, bootTimeoutSec, templateCloudConfig, hotplugSlots, pooled: true });
}

// Two shares per session (project + HOME).
export const POOL_HOTPLUG_SLOTS = 32;

function prepareVm({ cwd, argv, fallbackArgv = null, env = {}, homeHostPath = null, extraShares = [], runtime = null, network, memoryMiB = 4096, cpus = 2, diskGiB = 32, bootTimeoutSec = 120, templateCloudConfig = null, hotplugSlots = DEFAULT_HOTPLUG_SLOTS, pooled, sshForwards = [] }) {
  if (!network?.vnetSock || !network?.guestSshSock) throw new Error('prepareQemuSession: a network broker is required');
  const golden = currentGolden();
  if (!golden) throw new Error('no golden VM image (run server/cli/qemu-image-build.js)');
  const vfsd = virtiofsdPath();
  if (!vfsd) throw new Error('virtiofsd is not installed');
  const id = randomUUID();
  const runDir = join(qemuRoot(), 'run', id);
  const seedDir = join(runDir, 'seed');
  mkdirSync(seedDir, { recursive: true, mode: 0o700 });

  const u = userInfo();
  const home = homedir();
  const shares = [];
  let runtimeUserData = { bootLines: [], writeFiles: [], runLines: [] };
  if (pooled) {
    runtimeUserData.bootLines.push({ what: 'home', cmd: `install -d -o ${process.getuid()} -g ${process.getegid()} -m 0700 ${shellQuote(home)}` });
    // Mount points for the sessions' agent installs (qemuAgents.js): the
    // guest bwrap binds over them, and cannot create them under a ro /opt.
    runtimeUserData.bootLines.push({ what: 'agent-dirs', cmd: `mkdir -p ${VM_AGENT_APPS.map((a) => shellQuote(guestAgentDir(a))).join(' ')}` });
  } else {
    let homeDir = homeHostPath;
    if (!homeDir) {
      homeDir = join(runDir, 'home');
      mkdirSync(homeDir, { mode: 0o700 });
    }
    // HOME first: the project (usually somewhere under HOME) mounts on top.
    shares.push(
      { tag: 'home', hostPath: homeDir, guestPath: home },
      { tag: 'proj', hostPath: cwd, guestPath: cwd },
      ...extraShares,
    );
  }
  if (runtime) {
    const rtDir = join(runDir, 'rt');
    materializeGuestRuntime(runtime, rtDir);
    shares.push({ tag: 'rt', hostPath: rtDir, guestPath: GUEST_RT_DIR, readonly: true });
    runtimeUserData = buildGuestRuntimeUserData(runtime, { uid: process.getuid(), gid: process.getegid() });
  }
  const git = composeGitConfigEnv(runtime?.gitConfig || [], env);
  for (const w of git.warnings) console.warn(`[sandbox] qemu backend: ${w}`);
  // ccserver's own env first, the operator's (sandbox.config.json env) over
  // it as in bwrap -- except GIT_CONFIG_*, merged by composeGitConfigEnv.
  const guestEnv = { LANG: 'C.UTF-8', ...(runtime?.env || {}), ...git.env, ...git.gitEnv };
  const caCerts = [];
  if (network.caPem) {
    caCerts.push(network.caPem);
    Object.assign(guestEnv, MITM_CA_ENV);
  }
  const clientKey = generateSshKeyPair(runDir, 'id_ed25519', `ccserver-${id}`);
  const hostKey = generateSshKeyPair(runDir, 'host_ed25519', `ccs-vm-${id}`);
  const adminKey = generateSshKeyPair(runDir, 'admin_ed25519', `ccserver-admin-${id}`);
  const hotplugPorts = hotplugPortIds(hotplugSlots);
  const knownHosts = join(runDir, 'known_hosts');
  writeFileSync(knownHosts, `ccs-vm ${hostKey.publicKey}\n`, { mode: 0o600 });

  const fsShares = shares.map((s, i) => ({ ...s, socketPath: join(runDir, `fs${i}.sock`) }));
  const readyToken = randomUUID().replace(/-/g, '');
  let timezone = null;
  try { timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || null; } catch { /* leave guest on UTC */ }
  writeFileSync(join(seedDir, 'meta-data'), `instance-id: ccs-${id}\nlocal-hostname: ccs-${id.slice(0, 8)}\n`);
  writeFileSync(join(seedDir, 'network-config'), buildNetworkConfig());
  writeFileSync(join(seedDir, 'user-data'), buildSessionUserData({
    // The ids virtiofsd actually runs with (an unprivileged virtiofsd can only
    // create files as its own uid/egid; anything else is EINVAL), not the
    // passwd entry: under `sg kvm` or a service with another primary group
    // the two differ.
    user: u.username, uid: process.getuid(), gid: process.getegid(), home, cwd, shares: fsShares,
    sshPubKey: clientKey.publicKey, hostKey, readyToken, timezone,
    caCerts, ...runtimeUserData, adminPubKey: adminKey.publicKey, template: templateCloudConfig,
  }), { mode: 0o600 });

  const overlay = join(runDir, 'overlay.qcow2');
  execFileSync(QEMU_IMG, ['create', '-q', '-f', 'qcow2', '-F', 'qcow2', '-b', golden.path, overlay, `${diskGiB}G`], { stdio: 'ignore' });

  const kvm = kvmUsable();
  const plan = {
    id,
    runDir,
    consoleLog: join(runDir, 'console.log'),
    qmpSocket: join(runDir, 'qmp.sock'),
    readyToken,
    guestSshSock: network.guestSshSock,
    readyPrefix: READY_PREFIX,
    failPrefix: FAIL_PREFIX,
    setupPrefix: SETUP_PREFIX,
    bootTimeoutMs: bootTimeoutSec * 1000,
    virtiofsd: fsShares.map((s) => ({ bin: vfsd, args: buildVirtiofsdArgs({ socketPath: s.socketPath, sharedDir: s.hostPath, readonly: s.readonly }), socketPath: s.socketPath })),
    qemu: { bin: BWRAP_BIN, args: null },
    ssh: {
      bin: '/usr/bin/ssh',
      args: buildGuestSshArgs({ keyPath: clientKey.path, knownHosts, network, user: u.username, tty: true, forwards: sshForwards }),
    },
    // Share hot-plug (qemuShares.js): free root ports, the virtiofsd binary
    // and the forced-command admin login (see GUEST_ADMIN_USER).
    hotplug: {
      ports: hotplugPorts,
      virtiofsd: vfsd,
      admin: { bin: '/usr/bin/ssh', args: buildGuestSshArgs({ keyPath: adminKey.path, knownHosts, network, user: GUEST_ADMIN_USER, tty: false }) },
    },
    // Completed by the launcher (see sandbox-qemu-remote.cjs).
    remote: pooled ? { env: guestEnv } : { cwd, argv, fallbackArgv, env: guestEnv },
  };
  const qemuArgs = buildQemuArgs({
    name: id, memoryMiB, cpus, overlay, seedDir, shares: fsShares, vnetSock: network.vnetSock,
    consoleLog: plan.consoleLog, qmpSocket: plan.qmpSocket, hotplugPorts, kvm,
  });
  plan.qemu.args = [
    ...buildQemuConfinement({ runDir, goldenPath: golden.path, vnetSock: network.vnetSock }),
    '--', QEMU_SYSTEM, ...qemuArgs,
  ];
  const planPath = join(runDir, 'plan.json');
  writeFileSync(planPath, JSON.stringify(plan), { mode: 0o600 });
  return { ...plan, planPath };
}
