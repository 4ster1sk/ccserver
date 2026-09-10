#!/bin/bash
# seatbelt-procargs2-check.sh — can any Seatbelt rule block a same-UID
# KERN_PROCARGS2 (numeric-MIB) argv+env read on this macOS?
#
# FINDING (macOS 14.8.5 arm64, and the macos-latest CI runner): NO. The
# numeric MIB {CTL_KERN, KERN_PROCARGS2, pid} is not a Seatbelt-mediated
# operation -- (deny default) for sysctl-read and every
# (deny sysctl-read|sysctl*|system-info|process-info*) rule tried have zero
# effect. A sandboxed agent can read another same-UID process's full argv AND
# environment (secrets included). bwrap's --unshare-pid closes this; Seatbelt
# cannot. See server/ws/sandbox-seatbelt.js's sysctl block and docs-site
# sandbox/overview.md "Known limitations".
#
# Keep this script to RE-CHECK on future macOS releases: if section 3 ever
# shows a `DENIED` for one of the candidate rules, that rule can go back into
# the profile and the exec test's t.skip() can become an assertion again.
#
# Run:  bash scripts/seatbelt-procargs2-check.sh
# Nothing here needs sudo (section 5 offers an optional sudo one-liner).

set -u
WORK=$(mktemp -d /tmp/pa2.XXXXXX); cd "$WORK" || exit 1

echo "==================== environment ===================="
sw_vers 2>/dev/null || true
echo "arch: $(uname -m)   sandbox-exec: $(command -v sandbox-exec || echo MISSING)"
echo "workdir: $WORK"

# ---------------------------------------------------------------------------
# 1. probe binary
# ---------------------------------------------------------------------------
cat > probe.c <<'EOF'
#include <sys/sysctl.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static int numeric(int pid){
  int mib[3] = { CTL_KERN, KERN_PROCARGS2, pid };
  size_t sz = 0;
  if (sysctl(mib, 3, NULL, &sz, NULL, 0) != 0) { fprintf(stderr, "[numeric size errno=%d %s]\n", errno, strerror(errno)); return -1; }
  char *b = calloc(1, sz + 1);
  if (sysctl(mib, 3, b, &sz, NULL, 0) != 0)   { fprintf(stderr, "[numeric read errno=%d %s]\n", errno, strerror(errno)); free(b); return -1; }
  fwrite(b, 1, sz, stdout); putchar('\n');
  free(b);
  return (int)sz;
}
/* kern.proc.pid.<n> — the process-info path some tools use instead */
static int kernproc(int pid){
  int mib[4] = { CTL_KERN, KERN_PROC, KERN_PROC_PID, pid };
  struct kinfo_proc kp; size_t sz = sizeof kp;
  if (sysctl(mib, 4, &kp, &sz, NULL, 0) != 0) { fprintf(stderr, "[kernproc errno=%d %s]\n", errno, strerror(errno)); return -1; }
  return (int)sz;
}
int main(int argc, char **argv){
  int pid = argc > 1 ? atoi(argv[1]) : getpid();
  const char *m = argc > 2 ? argv[2] : "numeric";
  int r = !strcmp(m, "kernproc") ? kernproc(pid) : numeric(pid);
  printf("RESULT %s\n", r < 0 ? "DENIED" : "READABLE");
  return r < 0 ? 3 : 0;
}
EOF
cc -O0 -o probe probe.c || { echo "cc failed — install Xcode CLT (xcode-select --install)"; exit 1; }

# ---------------------------------------------------------------------------
# 2. victim: a same-UID sleeper with a secret marker in its environment
#    (exactly the cross-session leak shape: a peer session / the ccserver
#    server holding CCSERVER_TOKEN)
# ---------------------------------------------------------------------------
MARK="PA2_SECRET_$RANDOM$RANDOM$RANDOM"
env "$MARK=leak-me" /bin/sh -c 'exec sleep 600' &
VPID=$!
sleep 0.3
echo "victim pid=$VPID   marker=$MARK"

verdict(){ # probe combined stdout+stderr on stdin -> one word
  local o; o=$(cat)
  if   grep -q "RESULT READABLE" <<<"$o" && grep -q "$MARK" <<<"$o"; then echo "LEAKS  (marker readable)  <<<"
  elif grep -q "RESULT READABLE" <<<"$o";                            then echo "READABLE (size only, marker not seen)"
  elif grep -q "RESULT DENIED"   <<<"$o";                            then echo "DENIED  (blocked - good)"
  elif grep -q "sandbox_apply"   <<<"$o";                            then echo "PROFILE REJECTED: $(tr '\n' ' ' <<<"$o")"
  elif [ -z "$o" ];                                                  then echo "NO OUTPUT (process failed to start?)"
  else echo "OTHER: $(tr '\n' ' ' <<<"$o" | head -c 240)"
  fi
}
run(){ /usr/bin/sandbox-exec -f "$1" "$WORK/probe" "$VPID" "${2:-numeric}" 2>&1 | verdict; }
mk(){ printf '%s\n' "$2" > "$1.sb"; }

echo
echo "==================== baseline (no sandbox) ===================="
printf '%-42s -> ' "numeric MIB, victim pid"; "$WORK/probe" "$VPID" numeric   2>&1 | verdict
printf '%-42s -> ' "kern.proc.pid, victim pid";"$WORK/probe" "$VPID" kernproc 2>&1 | verdict

# ---------------------------------------------------------------------------
# 3. candidate rules — allow-everything base, deny one thing, see what bites
# ---------------------------------------------------------------------------
echo
echo "==================== candidate deny rules ===================="
mk a1_allow_all        '(version 1)(allow default)'
mk a2_deny_sysctl_read '(version 1)(allow default)(deny sysctl-read)'
mk a3_deny_sysctl_star '(version 1)(allow default)(deny sysctl*)'
mk a4_deny_read_star   '(version 1)(allow default)(deny sysctl-read*)'
mk a5_deny_name        '(version 1)(allow default)(deny sysctl-read (sysctl-name "kern.procargs2"))'
mk a6_deny_name_prefix '(version 1)(allow default)(deny sysctl-read (sysctl-name-prefix "kern.procargs"))'
mk a7_deny_name_regex  '(version 1)(allow default)(deny sysctl-read (sysctl-name-regex #"procargs"))'
mk a8_deny_system_info '(version 1)(allow default)(deny system-info)'
mk a9_deny_proc_info   '(version 1)(allow default)(deny process-info*)'
mk a10_deny_sysctl_write_too '(version 1)(allow default)(deny sysctl-read)(deny sysctl-write)'

for p in a1_allow_all a2_deny_sysctl_read a3_deny_sysctl_star a4_deny_read_star \
         a5_deny_name a6_deny_name_prefix a7_deny_name_regex a8_deny_system_info \
         a9_deny_proc_info a10_deny_sysctl_write_too; do
  printf '%-42s -> ' "$p"; run "$p.sb"
done

# ---------------------------------------------------------------------------
# 4. realistic deny-default shapes (must still let a linked binary start)
# ---------------------------------------------------------------------------
echo
echo "==================== deny-default shapes ===================="
# b1: deny-default, allow just enough to run + the toolchain sysctls, NO procargs
printf '%s\n' \
 '(version 1)' \
 '(deny default)' \
 '(allow process-exec process-fork signal (target self))' \
 '(allow file-read* file-read-metadata file-ioctl)' \
 '(allow mach-lookup)' \
 '(allow sysctl-read (sysctl-name-prefix "hw.") (sysctl-name-prefix "machdep.") (sysctl-name-prefix "kern.os") (sysctl-name "kern.osversion" "kern.version" "kern.hostname" "kern.ostype" "kern.osrelease" "kern.usrstack64" "kern.argmax"))' \
 > b1_denydefault_no_procargs.sb

# b2: same as b1 but ALSO an explicit belt-and-suspenders name+prefix deny
printf '%s\n' \
 '(version 1)' \
 '(deny default)' \
 '(allow process-exec process-fork signal (target self))' \
 '(allow file-read* file-read-metadata file-ioctl)' \
 '(allow mach-lookup)' \
 '(allow sysctl-read (sysctl-name-prefix "hw.") (sysctl-name-prefix "machdep.") (sysctl-name-prefix "kern.os") (sysctl-name "kern.osversion" "kern.version" "kern.hostname" "kern.ostype" "kern.osrelease" "kern.usrstack64" "kern.argmax"))' \
 '(deny sysctl-read (sysctl-name "kern.procargs") (sysctl-name "kern.procargs2") (sysctl-name-prefix "kern.procargs"))' \
 > b2_denydefault_plus_explicit.sb

# b3: the actual profile the repo generates right now (needs node + the repo)
REPO="${CCSERVER_REPO:-$HOME/Dev/ccserver}"
if [ -f "$REPO/server/ws/sandbox-seatbelt.js" ] && command -v node >/dev/null; then
  node -e '
    import("file://'"$REPO"'/server/ws/sandbox-seatbelt.js").then(m=>{
      process.stdout.write(m.buildSeatbeltProfileText({
        readRegexes:["^/usr(/.*)?$","^/System(/.*)?$","^/Library(/.*)?$","^/private(/.*)?$","^/var(/.*)?$","^/opt(/.*)?$","^/bin(/.*)?$"],
        readLiterals:["/"],
      }));
    });
  ' > b3_repo_current.sb 2>/dev/null && echo "(b3 = repo's current buildSeatbeltProfileText output)" \
    || { echo "(b3 skipped: node import failed)"; rm -f b3_repo_current.sb; }
else
  echo "(b3 skipped: set CCSERVER_REPO to the checkout with node available)"
fi

for p in b1_denydefault_no_procargs b2_denydefault_plus_explicit b3_repo_current; do
  [ -f "$p.sb" ] || continue
  printf '%-42s -> ' "$p"; run "$p.sb"
done

# ---------------------------------------------------------------------------
# 5. TRACE — what operation/filter does the numeric-MIB read generate?
# ---------------------------------------------------------------------------
echo
echo "==================== trace ===================="
printf '%s\n' '(version 1)(allow default)(trace "'"$WORK"'/trace.out")' > trace.sb
/usr/bin/sandbox-exec -f trace.sb "$WORK/probe" "$VPID" numeric >/dev/null 2>&1
if [ -s trace.out ]; then
  echo "--- trace.out lines mentioning sysctl / proc / system-info ---"
  grep -in 'sysctl\|proc-info\|process-info\|system-info\|procargs\|proc\b' trace.out \
    || echo "(NONE — the numeric-MIB read is not a mediated sandbox operation on this OS)"
else
  echo "(trace produced no file — trace unsupported here?)"
fi

# ---------------------------------------------------------------------------
# 6. violation log (optional, needs a second terminal for the live stream)
# ---------------------------------------------------------------------------
echo
echo "==================== violation log ===================="
/usr/bin/sandbox-exec -f a2_deny_sysctl_read.sb "$WORK/probe" "$VPID" numeric >/dev/null 2>&1
log show --last 45s --style compact \
  --predicate 'process == "probe" OR eventMessage CONTAINS[c] "procargs" OR eventMessage CONTAINS[c] "sysctl"' 2>/dev/null \
  | grep -i 'probe\|procargs\|sysctl\|deny\|violation' | tail -25 \
  || echo "(nothing; for a live view run in another terminal:  sudo log stream --style compact --predicate 'sender == \"Sandbox\"' )"

# ---------------------------------------------------------------------------
kill "$VPID" 2>/dev/null
echo
echo "==================== done ===================="
echo "workdir kept: $WORK   (rm -rf \"$WORK\" when finished)"
