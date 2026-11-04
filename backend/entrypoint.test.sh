#!/usr/bin/env bash
# entrypoint.test.sh — pins the 2026-09-01 deploy-stall fix in ./entrypoint.sh:
# the recursive ownership repair must NEVER block container boot. (Prod probe
# 2026-09-01, ec2-ops run 33513802564: crossmodel_coding_workspaces holds
# 2,911,179 files — a 4m06s metadata walk. The synchronous chown -R put every
# boot on a knife-edge against the ~330s docker-unhealthy budget; deploy run
# 33505472300 failed the blue-green health gate 3× while the walk chewed the
# boot budget.)
#
# PATH-injected shims, no real root needed (the apply-env-overrides.test.sh
# idiom): chown logs every call and sleeps FAKE_R_DELAY seconds on the
# recursive call (the simulated slow walk); su-exec logs and exits 0.
# Run from anywhere: bash backend/entrypoint.test.sh
set -u
cd "$(dirname "$0")"
ENTRYPOINT=./entrypoint.sh
N=0; FAILS=0
say() { N=$((N+1)); if [ "$2" = ok ]; then echo "ok $N - $1"; else echo "not ok $N - $1"; FAILS=$((FAILS+1)); fi; }

new_sandbox() {
  SBX=$(mktemp -d)
  mkdir -p "$SBX/ws/sub" "$SBX/env" "$SBX/bin"
  touch "$SBX/ws/file1" "$SBX/ws/sub/file2" "$SBX/env/e1"
  CHOWN_LOG="$SBX/chown.log"; : > "$CHOWN_LOG"
  SU_EXEC_LOG="$SBX/suexec.log"; : > "$SU_EXEC_LOG"
  cat > "$SBX/bin/chown" <<'EOF'
#!/usr/bin/env sh
echo "chown $*" >> "$CHOWN_LOG"
case " $* " in *" -R "*) sleep "${FAKE_R_DELAY:-3}" ;; esac
exit 0
EOF
  cat > "$SBX/bin/su-exec" <<'EOF'
#!/usr/bin/env sh
echo "su-exec $*" >> "$SU_EXEC_LOG"
exit 0
EOF
  chmod +x "$SBX/bin/chown" "$SBX/bin/su-exec"
}

run_entrypoint() {
  CHOWN_LOG="$CHOWN_LOG" SU_EXEC_LOG="$SU_EXEC_LOG" \
  CODING_WORKSPACE_ROOT="$SBX/ws" CODING_ENV_ROOT="$SBX/env" \
  PATH="$SBX/bin:$PATH" FAKE_R_DELAY="${FAKE_R_DELAY:-3}" \
    sh "$ENTRYPOINT" node server.js >/dev/null 2>&1
}

r_count() { grep -c 'chown -R' "$CHOWN_LOG" 2>/dev/null || true; }
MARKER() { echo "$SBX/env/.ownership-repair-at"; }
LOCK() { echo "$SBX/env/.ownership-repair.lock"; }

# --- Cases 1-3-5-4 (one sandbox): fast boot, background repair, marker gates --
new_sandbox
FAKE_R_DELAY=3
t0=$SECONDS
run_entrypoint
dt=$((SECONDS-t0))
[ "$dt" -lt 3 ] && say "boot returns immediately while the simulated walk sleeps 3s (took ${dt}s)" ok || say "boot blocked on the recursive walk (took ${dt}s)" bad
[ "$(head -1 "$CHOWN_LOG")" = "chown nodejs:nodejs $SBX/ws $SBX/env" ] && say "synchronous chown is NON-recursive on both roots" ok || say "synchronous chown wrong/absent: $(head -1 "$CHOWN_LOG")" bad
grep -q "su-exec nodejs node server.js" "$SU_EXEC_LOG" && say "handoff to su-exec preserved" ok || say "su-exec handoff missing" bad
sleep 4
[ "$(r_count)" = "1" ] && say "background repair ran exactly one recursive chown over both roots" ok || say "background repair count wrong: $(r_count)" bad
[ -f "$(MARKER)" ] && say "repair freshness marker written" ok || say "freshness marker missing" bad

t0=$SECONDS
run_entrypoint
dt=$((SECONDS-t0))
sleep 1
[ "$(r_count)" = "1" ] && [ "$dt" -lt 3 ] && say "fresh marker skips the re-walk (boot still fast)" ok || say "fresh-marker skip failed (r=$(r_count), dt=${dt}s)" bad

touch -d '2 hours ago' "$(MARKER)"
run_entrypoint
sleep 4
[ "$(r_count)" = "2" ] && say "stale marker (>60min) re-runs the background repair" ok || say "stale-marker re-walk failed (r=$(r_count))" bad

rm -f "$(MARKER)"
exec 9>"$(LOCK)"; flock -n 9 || { echo "TEST SETUP FAIL: could not hold the repair lock"; exit 1; }
run_entrypoint
sleep 2
[ "$(r_count)" = "2" ] && say "a held flock skips the walk (boot-wave serialization)" ok || say "flock serialization failed (r=$(r_count))" bad
flock -u 9; exec 9>&-
run_entrypoint
sleep 4
[ "$(r_count)" = "3" ] && say "released lock lets the next boot repair again" ok || say "post-release repair failed (r=$(r_count))" bad
rm -rf "$SBX"

# --- Case: no flock on the image -> unlocked background fallback still repairs -
new_sandbox
MINBIN="$SBX/minbin"; mkdir -p "$MINBIN"
for t in env sh date mkdir find touch sleep; do ln -s "$(command -v "$t")" "$MINBIN/$t"; done
FAKE_R_DELAY=1
CHOWN_LOG="$CHOWN_LOG" SU_EXEC_LOG="$SU_EXEC_LOG" \
CODING_WORKSPACE_ROOT="$SBX/ws" CODING_ENV_ROOT="$SBX/env" \
PATH="$SBX/bin:$MINBIN" FAKE_R_DELAY=1 \
  sh "$ENTRYPOINT" node server.js >/dev/null 2>&1
sleep 2
[ "$(r_count)" = "1" ] && say "no flock available: repair still runs, unlocked, in background" ok || say "no-flock fallback failed (r=$(r_count))" bad
[ -f "$(MARKER)" ] && say "fallback also writes the freshness marker" ok || say "fallback marker missing" bad
rm -rf "$SBX"

echo
if [ "$FAILS" -eq 0 ]; then echo "PASS — $N/$N assertions"; else echo "FAIL — $FAILS of $N assertions failed"; exit 1; fi
