#!/usr/bin/env bash
# Runs INSIDE the bwrap sandbox, before the target command, when the server
# enabled tool provisioning (sandbox.config.json "tools" and/or the client's
# per-session sandboxOpts.tools toggle -- the same opt-in flow as gpg/sshAgent).
# Installs the tools into the sandbox HOME so nothing has to be pre-installed
# on the host OS.
#
# Tools:
#   rtk               - "Rust Token Killer" CLI proxy (static binary) from
#                       GitHub releases, pinned version + sha256, placed at
#                       $HOME/.local/bin/rtk (first entry on the sandbox PATH).
#   code-review-graph - pip-installed MCP + CLI, in a per-project venv at
#                       $HOME/.local/share/crg-venv with console-script shims
#                       symlinked into $HOME/.local/bin. The bare
#                       `code-review-graph` then resolves on the sandbox PATH,
#                       so the .claude settings hooks and the MCP config that
#                       ccserver injects (see mcpConfig.js) both find it.
#
# Idempotent: each tool records
# $HOME/.local/share/ccserver-tools/markers/<tool>-<version>. When the marker
# matches, installation is skipped; a persistent per-project HOME therefore
# only pays the install cost once (or again after a "new"/wipe launch, which
# deletes the HOME). Failures are logged to
# $HOME/.local/share/ccserver-tools/provision.log and the script exits non-zero
# so the entrypoint can echo a hint -- the session still launches.
#
# Environment (set via bwrap --setenv in sandbox.js):
#   CCSANDBOX_PROVISION_RTK   "1" to install rtk
#   CCSANDBOX_PROVISION_CRG   "1" to install code-review-graph
#   CCSANDBOX_RTK_VERSION     pinned tag (e.g. v0.45.0)
#   CCSANDBOX_RTK_URL         release tarball URL (arch-matched by the server)
#   CCSANDBOX_RTK_SHA256      optional tarball sha256 (empty = skip the check)
#   CCSANDBOX_CRG_VERSION     pinned pip version (e.g. 2.3.7)
set -u

TOOLS_DIR="$HOME/.local/share/ccserver-tools"
MARKERS_DIR="$TOOLS_DIR/markers"
LOG="$TOOLS_DIR/provision.log"
mkdir -p "$MARKERS_DIR" 2>/dev/null || true

log() { printf '[sandbox-provision] %s\n' "$*" >>"$LOG" 2>/dev/null || true; }

download() { # <url> <dest>
  local url="$1" dest="$2"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --retry 2 --connect-timeout 15 "$url" -o "$dest" || return 1
  elif command -v wget >/dev/null 2>&1; then
    wget -q --timeout=30 -O "$dest" "$url" || return 1
  elif command -v python3 >/dev/null 2>&1; then
    python3 - "$url" "$dest" <<'PYEOF' || return 1
import sys, urllib.request
urllib.request.urlretrieve(sys.argv[1], sys.argv[2])
PYEOF
  else
    return 1
  fi
}

verify_sha256() { # <file> <expected>; ok when expected is empty
  local file="$1" expected="$2"
  if [ -z "$expected" ]; then
    log "sha256 not pinned; skipping checksum for $(basename "$file")"
    return 0
  fi
  local actual
  actual="$(sha256sum "$file" 2>/dev/null | awk '{print $1}')" || return 1
  [ "$actual" = "$expected" ]
}

install_rtk() {
  local ver="${CCSANDBOX_RTK_VERSION:-}"
  [ -n "$ver" ] || { log "rtk: no CCSANDBOX_RTK_VERSION"; return 0; }
  local marker="$MARKERS_DIR/rtk-$ver"
  [ -f "$marker" ] && return 0
  local url="${CCSANDBOX_RTK_URL:-}" sha="${CCSANDBOX_RTK_SHA256:-}"
  [ -n "$url" ] || { log "rtk: no CCSANDBOX_RTK_URL"; return 1; }
  local tmp
  tmp="$(mktemp -d "$TOOLS_DIR/rtk.XXXXXX")" || return 1
  local archive="$tmp/rtk.tar.gz"
  if ! download "$url" "$archive" || ! verify_sha256 "$archive" "$sha"; then
    log "rtk: download or checksum failed ($url)"
    rm -rf "$tmp"; return 1
  fi
  # --no-same-owner: the release tarball carries the build uid/gid (e.g. 1001),
  # which does not exist in the sandbox's user namespace (bwrap --unshare-user
  # maps only uid 0). Without it tar chowns fail with "Cannot change ownership"
  # and the extract reports failure despite writing the file.
  if ! tar --no-same-owner -xzf "$archive" -C "$tmp"; then
    log "rtk: extract failed"; rm -rf "$tmp"; return 1
  fi
  local bin
  bin="$(find "$tmp" -maxdepth 2 -type f -name rtk -perm -u+x | head -n 1)"
  if [ -z "$bin" ]; then
    log "rtk: no executable rtk in archive"; rm -rf "$tmp"; return 1
  fi
  mkdir -p "$HOME/.local/bin"
  if ! cp "$bin" "$HOME/.local/bin/rtk" || ! chmod +x "$HOME/.local/bin/rtk"; then
    log "rtk: install to $HOME/.local/bin/rtk failed"; rm -rf "$tmp"; return 1
  fi
  rm -rf "$tmp"
  touch "$marker"
  log "rtk $ver installed -> $HOME/.local/bin/rtk"
}

install_crg() {
  local ver="${CCSANDBOX_CRG_VERSION:-}"
  [ -n "$ver" ] || { log "crg: no CCSANDBOX_CRG_VERSION"; return 0; }
  local marker="$MARKERS_DIR/code-review-graph-$ver"
  [ -f "$marker" ] && return 0
  if ! command -v python3 >/dev/null 2>&1; then
    log "crg: python3 missing in sandbox"; return 1
  fi
  local venv="$HOME/.local/share/crg-venv"
  if ! python3 -m venv "$venv"; then
    log "crg: venv create failed ($venv)"; return 1
  fi
  if ! "$venv/bin/pip" install --disable-pip-version-check --no-cache-dir "code-review-graph==$ver" >>"$LOG" 2>&1; then
    log "crg: pip install code-review-graph==$ver failed (see $LOG)"
    return 1
  fi
  mkdir -p "$HOME/.local/bin"
  for entry in code-review-graph crg-daemon; do
    if [ -x "$venv/bin/$entry" ]; then
      ln -sf "$venv/bin/$entry" "$HOME/.local/bin/$entry"
    fi
  done
  touch "$marker"
  log "code-review-graph $ver installed -> $venv (+ $HOME/.local/bin shims)"
}

log "starting provision (rtk=${CCSANDBOX_PROVISION_RTK:-0} crg=${CCSANDBOX_PROVISION_CRG:-0})"
rc=0
if [ "${CCSANDBOX_PROVISION_RTK:-0}" = "1" ]; then install_rtk || rc=1; fi
if [ "${CCSANDBOX_PROVISION_CRG:-0}" = "1" ]; then install_crg || rc=1; fi
log "provision done (rc=$rc)"
exit "$rc"
