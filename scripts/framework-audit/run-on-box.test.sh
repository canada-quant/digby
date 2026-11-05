#!/usr/bin/env bash
# run-on-box.test.sh — harness for run-on-box.sh (the Framework Operator's SSM runner).
# A PATH-injected `aws` shim records every call and serves canned SSM answers; no network.
# The shim is STATEFUL: send-commands are classified (wrapped trailer / byte-range page
# fetch / cleanup / legacy verbatim) and their StandardOutputContent is staged in
# $SSM_DIR/last_out for the following get-command-invocation calls.
# Pins: box letter → instance id, command JSON encoding, stdout passthrough on Success,
# OUTPUT PAGING (multi-page byte-exact reassembly past the ~24 KB SSM cap, byte ranges
# never cut -c, cleanup of the parked temp files, rc/stderr relay on remote failure,
# trailer-missing fail-open, ROB_PAGING_DISABLED legacy path), usage errors.
set -u
cd "$(dirname "$0")"
SBX=$(mktemp -d); trap 'rm -rf "$SBX"' EXIT
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ok: $1"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL: $1"; }
mkdir -p "$SBX/bin" "$SBX/ssm"
cat > "$SBX/bin/aws" <<'SHIM'
#!/usr/bin/env bash
echo "$@" >> "$AWS_LOG"
case "$*" in
  *send-command*)
    if printf '%s' "$*" | grep -q "__ROB_PAGE_END__"; then
      # byte-range page fetch: tail -c +N '<park>' | head -c C; printf sentinel
      f="$(printf '%s' "$*" | grep -o "/tmp/rob-[^']*" | head -1)"
      n="$(printf '%s' "$*" | sed -n 's/.*tail -c +\([0-9]*\).*/\1/p')"
      c="$(printf '%s' "$*" | sed -n 's/.*head -c \([0-9]*\).*/\1/p')"
      src="$SSM_DIR/stdout.bin"; case "$f" in *.err) src="$SSM_DIR/stderr.bin" ;; esac
      dd if="$src" bs=1 skip=$((n-1)) count="$c" 2>/dev/null > "$SSM_DIR/last_out"
      printf '__ROB_PAGE_END__' >> "$SSM_DIR/last_out"
    elif printf '%s' "$*" | grep -q "__ROB_RC__"; then
      if [ -n "${SSM_RAW_TRAILER:-}" ]; then
        printf '%s' "$SSM_RAW_TRAILER" > "$SSM_DIR/last_out"
      else
        rc="$(cat "$SSM_DIR/rc" 2>/dev/null || echo 0)"
        ob="$(wc -c < "$SSM_DIR/stdout.bin" 2>/dev/null || echo 0)"
        eb="$(wc -c < "$SSM_DIR/stderr.bin" 2>/dev/null || echo 0)"
        printf '__ROB_RC__ %s\n__ROB_OUT__ %s\n__ROB_ERR__ %s\n' "$rc" "$ob" "$eb" > "$SSM_DIR/last_out"
      fi
    elif printf '%s' "$*" | grep -q "framework-audit-cleanup"; then
      : > "$SSM_DIR/last_out"
    else
      printf '%s\n' "${SSM_STDOUT:-ok}" > "$SSM_DIR/last_out"
    fi
    echo "cmd-$$" ;;
  *get-command-invocation*"--query Status"*) echo "${SSM_STATUS:-Success}" ;;
  *get-command-invocation*"--query StandardOutputContent"*) cat "$SSM_DIR/last_out" ;;
  *get-command-invocation*"--query StandardErrorContent"*) printf '%s\n' "${SSM_STDERR:-remote boom}" ;;
  *"sts get-caller-identity"*)
    if [ -n "${SSM_STS_ERR:-}" ]; then printf '%s\n' "$SSM_STS_ERR" >&2; exit 254; fi
    echo "arn:aws:iam::123456789012:role/digby-fake" ;;
  *) echo "unexpected aws call: $*" >&2; exit 9 ;;
esac
SHIM
chmod +x "$SBX/bin/aws"
export PATH="$SBX/bin:$PATH" AWS_LOG="$SBX/aws.log" SSM_DIR="$SBX/ssm"
stage() { # stage <rc> <stdout-file> [stderr-file]
  printf '%s' "$1" > "$SSM_DIR/rc"
  cp "$2" "$SSM_DIR/stdout.bin"
  if [ -n "${3:-}" ]; then cp "$3" "$SSM_DIR/stderr.bin"; else : > "$SSM_DIR/stderr.bin"; fi
}

echo "run-on-box.sh (paged output)"
printf '{"runs":1}' > "$SBX/small.out"
stage 0 "$SBX/small.out"
: > "$AWS_LOG"
out=$(./run-on-box.sh A 'bash /opt/crossmodel/scripts/framework-audit/prodq.sh audit-live-state.js 2026-09-21T00:00:00Z' 2>"$SBX/err"); rc=$?
[ "$rc" = 0 ] && ok "success exit 0" || bad "success exit was $rc"
[ "$out" = '{"runs":1}' ] && ok "stdout passthrough (single page)" || bad "stdout was: $out"
grep -q -- '--instance-ids i-0123456789abcdef0' "$AWS_LOG" && ok "box A → example-ca-primary instance id" || bad "instance id for A missing"
grep -q -- '--document-name AWS-RunShellScript' "$AWS_LOG" && ok "AWS-RunShellScript document" || bad "document missing"
grep -q "prodq.sh audit-live-state.js 2026-09-21T00:00:00Z ) > '/tmp/rob-" "$AWS_LOG" && ok "command embedded verbatim in the paging subshell wrapper" || bad "command not embedded verbatim: $(grep send-command "$AWS_LOG" | head -1)"
grep -q '"executionTimeout": \["240"\]' "$AWS_LOG" && ok "default executionTimeout 240 s" || bad "executionTimeout missing"
grep -q 'tail -c +' "$AWS_LOG" && ok "pages fetched with byte ranges (tail -c +N)" || bad "no tail -c byte-range fetch in log"
grep -q 'framework-audit-cleanup' "$AWS_LOG" && ok "parked temp files cleaned up" || bad "cleanup command missing"

: > "$AWS_LOG"
./run-on-box.sh C 'bash /opt/crossmodel/scripts/framework-audit/box-readout.sh' >/dev/null 2>&1
grep -q -- '--instance-ids i-0123456789abcdef0' "$AWS_LOG" && ok "box C → coding box" || bad "instance id for C wrong"
: > "$AWS_LOG"
./run-on-box.sh b 'uptime' >/dev/null 2>&1
grep -q -- '--instance-ids i-0123456789abcdef0' "$AWS_LOG" && ok "box b (lowercase) → app-b" || bad "instance id for B wrong"

# Multi-page reassembly (firing 6 regression): audit-live-state.js prints ~29 KB, one
# GetCommandInvocation returns ~24 KB, and the lane harness caps at the same order — the
# single-shot fetch came back cut mid-JSON. Pin: output larger than one page is reassembled
# BYTE-EXACTLY across pages. The payload is many short lines so a per-LINE slicer (cut -c)
# would return empty for every page past the first — exactly the trap firing 6 hit.
BIG="$SBX/big.out"
: > "$BIG"
for i in $(seq 1 500); do printf 'row %04d %s\n' "$i" "$(printf 'x%.0s' $(seq 1 80))" >> "$BIG"; done
bign=$(wc -c < "$BIG"); [ "$bign" -gt 40000 ] && ok "big payload staged (${bign}B > 24KB cap)" || bad "payload too small: $bign"
stage 0 "$BIG"
: > "$AWS_LOG"
ROB_CHUNK=17000 ./run-on-box.sh A 'bash probe-big' > "$SBX/got.out" 2>"$SBX/err"; rc=$?
[ "$rc" = 0 ] && ok "multi-page run exits 0" || bad "multi-page exit was $rc ($(head -2 "$SBX/err"))"
cat "$BIG" > "$SBX/want.out"; printf '\n' >> "$SBX/want.out"
cmp -s "$SBX/want.out" "$SBX/got.out" && ok "output reassembled byte-exactly across pages" || bad "reassembled output differs from payload ($(wc -c < "$SBX/got.out") vs ${bign}B)"
! grep -q '__ROB_' "$SBX/got.out" && ok "no ROB sentinels leak into output" || bad "sentinel leaked into output"
pages=$(grep -c "__ROB_PAGE_END__" "$AWS_LOG" || true)
want_pages=$(( (bign + 16999) / 17000 ))
[ "$pages" = "$want_pages" ] && ok "fetched $pages pages (chunk 17000, ${bign}B)" || bad "page count was $pages, wanted $want_pages"

# Remote failure: partial stdout is still paged out, remote rc + stderr relayed, exit 4.
printf 'partial-json-so-far' > "$SBX/fail.out"
printf 'exit 3: probe not found' > "$SBX/fail.err"
stage 3 "$SBX/fail.out" "$SBX/fail.err"
out=$(./run-on-box.sh A 'bash x.sh' 2>"$SBX/err"); rc=$?
[ "$rc" = 4 ] && ok "remote rc≠0 → exit 4" || bad "remote-failure exit was $rc"
[ "$out" = 'partial-json-so-far' ] && ok "partial stdout still printed on remote failure" || bad "partial stdout lost: $out"
grep -q 'remote status: Failed (rc 3)' "$SBX/err" && grep -q 'probe not found' "$SBX/err" && ok "remote rc + stderr relayed" || bad "failure relay missing: $(cat "$SBX/err")"

# SSM-level failure on the wrapped invocation: raw output printed, exit 4.
stage 0 "$SBX/small.out"
out=$(SSM_STATUS=Failed SSM_RAW_TRAILER='partial' SSM_STDERR='exit 3: probe not found' ./run-on-box.sh A 'bash x.sh' 2>"$SBX/err"); rc=$?
[ "$rc" = 4 ] && ok "Failed invocation → exit 4" || bad "Failed exit was $rc"
grep -q 'remote status: Failed' "$SBX/err" && grep -q 'probe not found' "$SBX/err" && ok "remote status + stderr relayed" || bad "stderr relay missing: $(cat "$SBX/err")"
[ "$out" = 'partial' ] && ok "partial stdout still printed on SSM failure" || bad "partial stdout lost"

# Trailer missing (exotic command swallowed the markers): fail OPEN on the raw output.
stage 0 "$SBX/small.out"
out=$(SSM_RAW_TRAILER='weird no markers here' ./run-on-box.sh A 'bash exotic.sh' 2>"$SBX/err"); rc=$?
[ "$rc" = 0 ] && ok "trailer-missing → fail-open exit 0" || bad "trailer-missing exit was $rc"
[ "$out" = 'weird no markers here' ] && ok "trailer-missing → raw output printed" || bad "raw fallback output was: $out"

# Legacy single-shot path (kill switch): verbatim command, single fetch, no wrapper.
: > "$AWS_LOG"
out=$(ROB_PAGING_DISABLED=1 SSM_STDOUT='{"runs":1}' ./run-on-box.sh A 'bash /opt/crossmodel/scripts/framework-audit/prodq.sh audit-live-state.js 2026-09-21T00:00:00Z' 2>/dev/null); rc=$?
[ "$rc" = 0 ] && [ "$out" = '{"runs":1}' ] && ok "ROB_PAGING_DISABLED=1 → verbatim passthrough" || bad "legacy path broken (rc $rc, out $out)"
grep -q '"commands": \["bash /opt/crossmodel/scripts/framework-audit/prodq.sh audit-live-state.js 2026-09-21T00:00:00Z"\]' "$AWS_LOG" && ok "legacy path sends the bare command JSON" || bad "legacy command encoding wrong"

./run-on-box.sh Z 'uptime' >/dev/null 2>"$SBX/err"; [ $? = 2 ] && grep -q 'unknown box' "$SBX/err" && ok "unknown box → usage exit 2" || bad "unknown box handling"
./run-on-box.sh A >/dev/null 2>"$SBX/err"; [ $? = 2 ] && ok "missing command → usage exit 2" || bad "missing command handling"

echo "run-on-box.sh (static pins)"
bash -n ./run-on-box.sh && ok "run-on-box.sh parses" || bad "run-on-box.sh syntax"
grep -q 'cut -c' ./run-on-box.sh && bad "cut -c must never appear (per-LINE slicing returns empty past line 1)" || ok "no cut -c in the runner"
grep -q "ROB_PAGING_DISABLED" ./run-on-box.sh && ok "paging kill switch present" || bad "ROB_PAGING_DISABLED missing"

echo "prodq.sh (static)"
bash -n ./prodq.sh && ok "prodq.sh parses" || bad "prodq.sh syntax"
grep -q "grep -E '^admin-backend-(blue|green)\$'" ./prodq.sh && ok "prodq targets the live admin-backend colour" || bad "prodq container selection changed"
bash -n ./redis-readout.sh && bash -n ./box-readout.sh && ok "readouts parse" || bad "readout syntax"
grep -qE 'redis-cli (DEL|FLUSH|SET |CONFIG SET)' ./redis-readout.sh && bad "redis-readout must stay read-only" || ok "redis-readout is read-only"

echo "box-readout.sh (exit-status contract)"
# Run 1 regression (2026-09-21): `set -o pipefail` + a trailing `journalctl | grep` pipeline
# made a CLEAN box (zero OOM traces — the healthy case) exit 1, so run-on-box.sh relayed
# "remote status: Failed" for a healthy box and the operator's reach-proof looked broken.
# The exit code must mean "the readout RAN", never "no OOM found".
RBX=$(mktemp -d)
mkdir -p "$RBX/bin"
cat > "$RBX/bin/journalctl" <<'SHIM'
#!/usr/bin/env bash
# healthy boot: priority-3 errors empty, no OOM traces anywhere
exit 0
SHIM
cat > "$RBX/bin/curl" <<'SHIM'
#!/usr/bin/env bash
echo '{"status":"healthy","db":"connected","redis":"connected"}'
SHIM
cat > "$RBX/bin/uptime" <<'SHIM'
#!/usr/bin/env bash
echo " 22:00:00 up 1 day, 0 users, load average: 1.00"
SHIM
cat > "$RBX/bin/free" <<'SHIM'
#!/usr/bin/env bash
echo "               total        used        free"
echo "Mem:            7820        3063         241"
SHIM
cat > "$RBX/bin/df" <<'SHIM'
#!/usr/bin/env bash
echo "/dev/root       969G  154G  816G  16% /"
SHIM
cat > "$RBX/bin/docker" <<'SHIM'
#!/usr/bin/env bash
echo "admin-backend-blue	Up 5 minutes (healthy)"
SHIM
cat > "$RBX/bin/sudo" <<'SHIM'
#!/usr/bin/env bash
# `sudo CMD ARGS…` reaches this script with CMD as $1 — drop nothing, exec the rest.
exec "$@"
SHIM
chmod +x "$RBX/bin/"*
out=$(PATH="$RBX/bin:$PATH" bash ./box-readout.sh 2>"$SBX/err"); rc=$?
[ "$rc" = 0 ] && ok "clean box (zero OOM traces) exits 0" || bad "clean box exit was $rc: $(head -1 "$SBX/err")"
# An OOM trace must SURFACE in stdout, not change the exit contract.
# journalctl is called twice: `-b -p 3 --no-pager` (err section) and `-b --no-pager` (OOM grep).
cat > "$RBX/bin/journalctl" <<'SHIM'
#!/usr/bin/env bash
if [ "${2:-}" = "-p" ]; then echo "Sep 21 22:00:00 host kernel: TCP: out of memory"; exit 0; fi
echo "Sep 21 21:00:00 host kernel: Out of memory: Killed process 1234 (node)"
SHIM
chmod +x "$RBX/bin/journalctl"
out=$(PATH="$RBX/bin:$PATH" bash ./box-readout.sh 2>/dev/null); rc=$?
[ "$rc" = 0 ] && ok "box WITH an OOM trace still exits 0" || bad "oom-present exit was $rc"
echo "$out" | grep -q "Killed process 1234" && ok "OOM trace surfaces in stdout" || bad "OOM trace missing from output"

echo "audit-live-state.js (runs section)"
# Run 1 regression (2026-09-21): runs_running_now selected status IN ('running','queued')
# but never OUTPUT status, so never-claimed 'queued' rows (queue-behind-busy shape: no
# worker, no heartbeat, no startedAt) displayed as phantom 'running' rows and the operator
# hunted a run-row leak that did not exist. Pin: the row-level status column is selected
# (plus the not-before lease), and the trigger column reads a key agent_runs.input
# actually carries ('origin' — 'triggerKind' is a run_journal_entries field that is
# always NULL on agent_runs).
node --check ./audit-live-state.js && ok "audit-live-state.js parses" || bad "audit-live-state.js syntax"
LINE=$(grep -o "await sec('runs_running_now'.*" ./audit-live-state.js)
echo "$LINE" | grep -q "AS run, r.status, LEFT" && ok "runs rows carry their status column" || bad "status column missing from runs_running_now"
echo "$LINE" | grep -q '"leaseExpiresAt" AS lease' && ok "runs rows carry the not-before lease" || bad "lease column missing from runs_running_now"
echo "$LINE" | grep -q "input->>'origin'" && ok "trigger column reads input origin" || bad "trigger column not reading input->>origin"

echo "audit-live-state.js (multi-tenant attribution, 2026-09-22 firing 2)"
# The owner_questions_open count was unscoped: two open rows belonging to ANOTHER
# platform user (RIO staff, usr 076d2832) read as this fleet's pending owner cards
# and cost a full box probe to disprove; errors_4h likewise aggregated by message
# alone so "Invalid credentials" (public /api/auth/login 401s, source error-handler)
# could not be classified without a second probe. Pin both attributions.
OQ=$(grep -o "await sec('owner_questions_open'.*" ./audit-live-state.js)
echo "$OQ" | grep -q 'LEFT("userId"::text,8) AS usr' && ok "owner questions attributed by user" || bad "owner_questions_open not user-attributed"
ER=$(grep -o "await sec('errors_4h'.*" ./audit-live-state.js)
echo "$ER" | grep -q 'AS msg, source,' && ok "error rows carry their source" || bad "errors_4h missing source column"
# 18th f64 bake (firing 84): the absorbed arm — a transient-provider burst the
# seat failover absorbed (spike n + HTTP code + matching seat_fallback code +
# ZERO failed runs) prints absorbed:failover instead of bare ESCALATE; any
# failed run keeps ESCALATE. Pin all three correlates, in the outer CASE.
echo "$ER" | grep -q "THEN 'absorbed:failover'" && ok "errors_4h absorbed:failover arm present" || bad "errors_4h missing absorbed:failover arm"
echo "$ER" | grep -q "f.failed_runs = 0" && ok "absorbed arm requires zero failed runs" || bad "absorbed arm lost the zero-failed-runs correlate"
echo "$ER" | grep -q "kind='seat_fallback'" && ok "absorbed arm correlates seat_fallback codes" || bad "absorbed arm lost the seat_fallback correlate"
echo "$ER" | grep -q "WHEN t.n > 30 THEN 'ESCALATE'" && ok "ESCALATE stays the default spike verdict" || bad "ESCALATE default arm lost"

echo "audit-live-state.js (crosscheck_late window, 2026-09-22 firing 5)"
# Firing 5 regression: crosscheck_late was the ONLY history-aggregating section with
# NO time filter — every windowed neighbour carries now() - interval '…' (4h/24h/30min),
# so the section presented LIFETIME totals inside a windowed audit. Live proof: the
# unwindowed read said reconcile_failed n=20, but the rows accumulate since 2026-09-19
# (279 rows over 4 days); the true 24h count was 8. That cost a full triage leg chasing
# a "regression" with no window to compare against, and worse: identical lifetime totals
# firing-over-firing would MASK a real reconcile_failed spike. Pin: the section carries
# a 24h window (reconciliations span the prior day's late checkers — same window class
# as deploy_interrupt_24h / runs_interrupted_24h).
XC=$(grep -o "await sec('crosscheck_late'.*" ./audit-live-state.js)
echo "$XC" | grep -q "interval '24 hours'" && ok "crosscheck_late windowed to 24h" || bad "crosscheck_late missing 24h window"
echo "$XC" | grep -q "kind='crosscheck_late_reconcile'" && ok "crosscheck_late still keyed on the metric kind" || bad "crosscheck_late kind filter lost"

echo "audit-live-state.js (box_health backup fields, 2026-09-23 firing 10b)"
# Firing-10b regression: the box_health section read meta->'backup'->>'ageHours' but the
# writer (infra-watch.service.ts BackupState) stores ageH — backup_h was silently NULL on
# EVERY audit since c787c1353 shipped the section, so the standing audit could never see
# backup state (a forever-NULL column is indistinguishable from "not recorded"; the
# firing-8 budgetTokens class, twice). Pin: the section reads the writer's literal field
# names — ageH, count, newestAt — and never 'ageHours'.
BH=$(grep -o "await sec('box_health'.*" ./audit-live-state.js)
echo "$BH" | grep -q "backup'->>'ageH'" && ok "box_health reads the writer's ageH field" || bad "box_health not reading ageH (writer's literal field)"
echo "$BH" | grep -q "backup'->>'count'" && ok "box_health carries backup count" || bad "box_health missing backup count"
echo "$BH" | grep -q "backup'->>'newestAt'" && ok "box_health carries backup newestAt" || bad "box_health missing backup newestAt"
echo "$BH" | grep -q "ageHours" && bad "box_health still references the nonexistent ageHours field" || ok "no ageHours reference remains"

echo "audit-live-state.js (backup_fleet producer verdict, 2026-09-23 firing 13)"
# Firing-13 regression: box_health shows EVERY host's backup age with no producer
# context, so box-b's BY-DESIGN ~140h reading (docs/BACKUPS.md: "the nightly pg_dump
# timer + role wiring live on A only; B's timer is stopped+disabled") re-derived as a
# suspected-stale backup every single firing — firing 13 spent a full triage leg on it.
# The alert side has been producer-only since 8caf95b45 (ticket cc1ca2bf); the readout
# never said so. Pin: a backup_fleet section exists, reads the writer's OWN env knob
# (BACKUP_PRODUCER_HOSTS) for the producer set, and carries the four-state verdict
# vocabulary (lapse/unknown/missing/stale/ok) that mirrors classifyBackupAge.
BF=$(grep -c "await sec('backup_fleet'" ./audit-live-state.js)
[ "$BF" -ge 1 ] && ok "backup_fleet section exists" || bad "backup_fleet section missing"
BFS=$(sed -n "/await sec('backup_fleet'/,/^  });$/p" ./audit-live-state.js)
echo "$BFS" | grep -q "BACKUP_PRODUCER_HOSTS" && ok "producers read the writer's BACKUP_PRODUCER_HOSTS knob" || bad "backup_fleet hardcodes producers (will drift from the writer)"
echo "$BFS" | grep -q "'box-a'" && ok "box-a default matches the writer" || bad "backup_fleet default producer set mismatched"
for state in lapse unknown missing stale ok; do
  echo "$BFS" | grep -q "state: '$state'" && ok "verdict vocabulary carries '$state'" || bad "verdict state '$state' missing"
done
echo "$BFS" | grep -q "BY DESIGN" && ok "readout states non-producer hosts are by-design" || bad "backup_fleet does not carry the by-design note"
echo "$BFS" | grep -qE "require\(.*/infra-watch" && bad "backup_fleet imports infra-watch (crashes prodq exit — ClientClosedError, firing-13 precheck)" || ok "backup_fleet is dependency-free (no infra-watch import)"
# Firing-13 live catch (first post-wave probe): the section read the plain NEWEST
# box_health row per host, but web mounts /backups and the worker does not — the two
# stamp within ~1s every sweep, so whenever the worker's row landed second its
# mountless reading shadowed web's and the verdict flapped to 'unknown' with a
# false "no reading in 24h" note. Pin: backup fields must come from the newest
# BACKUP-BEARING row (the writer's producerBackupLastSeenAt semantics) while
# heartbeat stays a full-window MAX (a producer with no backup row stays visible).
echo "$BFS" | grep -q "(meta->'backup') IS NOT NULL" && ok "backup fields read the newest BACKUP-BEARING row (no worker-row shadow flap)" || bad "backup_fleet reads the plain newest row — mountless worker row shadows web's reading"
echo "$BFS" | grep -q "MAX(\"createdAt\")" && ok "heartbeat stays a full-window MAX (producer with no backup row stays visible)" || bad "backup_fleet heartbeat lost the full-window MAX"

echo "audit-live-state.js (run_lock_paired_now, 2026-09-26 firing 28)"
# Firing-26/firing-28 regression: redis lock counts and DB running-row counts taken
# as SEPARATE run-on-box calls straddle run churn and read like a lock leak (3-vs-5,
# then 6-vs-7) — each firing re-derived the paired-read proof by hand. Pin: a
# run_lock_paired_now section exists, reads BOTH sides in ONE process, matches by
# sessionId, and flags a session only when it stays unmatched across BOTH reads
# (churn settles in 2s; a leak persists). It must use its own raw redis client (the
# app singleton's winston console transport prints '✅ Redis connected' to stdout and
# corrupts the probe's JSON) with SCAN, never KEYS, and must never import
# infra-watch.service (ClientClosedError exit crash, firing-13).
RLP=$(grep -c "await sec('run_lock_paired_now'" ./audit-live-state.js)
[ "$RLP" -ge 1 ] && ok "run_lock_paired_now section exists" || bad "run_lock_paired_now section missing"
RLPS=$(sed -n "/await sec('run_lock_paired_now'/,/^  });$/p" ./audit-live-state.js)
echo "$RLPS" | grep -q "createClient" && echo "$RLPS" | grep -q "process.env.REDIS_URL" && ok "raw client from process.env.REDIS_URL (not the app singleton)" || bad "run_lock_paired_now must build its own client from process.env.REDIS_URL"
echo "$RLPS" | grep -qF "require('/app/node_modules/redis')" && ok "redis required by ABSOLUTE path (prodq runs probes from /tmp — bare 'redis' cannot resolve there)" || bad "run_lock_paired_now must require('/app/node_modules/redis') — the live pre-commit check caught the bare require failing"
echo "$RLPS" | grep -qE "require\(.*/config/redis|require\('redis'\)" && echo "$RLPS" | grep -q "require('/app/dist/config/redis')" && bad "run_lock_paired_now requires the app redis singleton (logger noise corrupts JSON)" || ok "no app redis singleton import"
echo "$RLPS" | grep -q "scanIterator" && ok "keys enumerated with SCAN (scanIterator)" || bad "run_lock_paired_now must SCAN, not KEYS"
echo "$RLPS" | grep -qE "\bkeys\(" && bad "run_lock_paired_now uses the KEYS command (blocking on prod)" || ok "no blocking KEYS command"
echo "$RLPS" | grep -q "second.keys.has(r.sess) && !first.keys.has(r.sess)" && ok "a session flags only when unmatched across BOTH reads (churn-proof)" || bad "run_lock_paired_now single-read flagging (re-introduces the race)"
echo "$RLPS" | grep -q "setTimeout(r, 2000)" && ok "re-read delayed (churn settles)" || bad "run_lock_paired_now missing the delayed re-read"
echo "$RLPS" | grep -q "orphan_locks" && ok "orphan lock side surfaced (lock with no running row)" || bad "run_lock_paired_now missing orphan_locks"
echo "$RLPS" | grep -qE "require\(.*/infra-watch" && bad "run_lock_paired_now imports infra-watch (crashes prodq exit — ClientClosedError, firing-13)" || ok "run_lock_paired_now is dependency-free (no infra-watch import)"

echo "audit-live-state.js (steer-watch sections, 2026-09-24 firing 14)"
# Owner steer on 3a68aec8 (00:37Z): (a) every JSON extractor now passes contentOnly:true so an
# exhausted-thinking call yields '' + the non-reasoning fallback answers — a parse_error whose
# meta.detail starts with PROSE (not '{') means a provider leg returned reasoning-as-answer
# AGAIN and the report must name leg/finishReason; (b) get_chat_messages `before` accepts the
# 8-char citation prefix — the 30/7d 'Invalid before cursor' refusals should be ~0, and any
# survivor must be classified by the refusal's own vocabulary (other_chat / not_found /
# ambiguous — ambiguous means 8-char prefixes collide inside one big chat => widen to 12;
# legacy_plain = the pre-3a68aec8 bare message, expected only in pre-landing rows).
# Pin both sections so the watch never depends on an ad-hoc tmp probe again.
PD=$(grep -c "await sec('memory_extraction_prose_detail_24h'" ./audit-live-state.js)
[ "$PD" = 1 ] && ok "memory_extraction_prose_detail_24h section exists" || bad "prose-detail section missing ($PD)"
PDS=$(sed -n "/await sec('memory_extraction_prose_detail_24h'/,/^  }));$/p" ./audit-live-state.js)
echo "$PDS" | grep -q "LEFT(TRIM(meta->>'detail'), 1) <> '{'" && ok "prose = detail_head not starting with '{' (post-TRIM)" || bad "prose classifier not anchored on the non-'{' first char"
for f in "meta->>'leg'" "meta->>'finishReason'" "meta->>'source'"; do
  echo "$PDS" | grep -qF "$f" && ok "prose rows carry $f (names the provider leg)" || bad "prose rows missing $f"
done
echo "$PDS" | grep -q "outcome'='parse_error'" && ok "prose watch reads parse_error rows only" || bad "prose watch lost the parse_error filter"
CR=$(grep -c "await sec('cursor_refusal_causes_24h'" ./audit-live-state.js)
[ "$CR" = 1 ] && ok "cursor_refusal_causes_24h section exists" || bad "cursor-refusal section missing ($CR)"
CRS=$(sed -n "/await sec('cursor_refusal_causes_24h'/,/^  }));$/p" ./audit-live-state.js)
for cause in other_chat not_found ambiguous legacy_plain unclassified; do
  echo "$CRS" | grep -q "'$cause'" && ok "cursor refusal vocabulary carries '$cause'" || bad "cursor cause '$cause' missing"
done
echo "$CRS" | grep -q "LIKE '%get_chat_messages failed: Invalid before cursor%'" && ok "cursor watch scoped to the exact refusal class" || bad "cursor watch lost the message-class scope"
echo "$CRS" | grep -q "LEFT(MAX(message), 200)" && ok "cursor watch samples the refusal text (owner asked for quoted samples)" || bad "cursor watch carries no sample text"

echo "audit-live-state.js (session-history sync standing watch, 2026-09-24 firing 15)"
# Owner steer 1d068e81 made the 10-minute session-history sync SKIP a repo whose
# mirror is gone (counted `no mirror N`, warned once per repo per process) instead
# of failing every session with `spawn git ENOENT` forever. Pin BOTH observables as
# standing sections so the watch is never a tmp docker-logs probe again: the sweep's
# own verdict from cron_jobs.lastStatus, and its warn classes from app_error_logs.
SHS=$(grep -c "await sec('session_history_sync_4h'" ./audit-live-state.js)
[ "$SHS" = 1 ] && ok "session_history_sync_4h section exists" || bad "sync verdict section missing ($SHS)"
SHSS=$(sed -n "/await sec('session_history_sync_4h'/,/^  }));$/p" ./audit-live-state.js)
for f in "LEFT(\"lastStatus\", 200)" "FROM cron_jobs" "id = 'session-history-sync'" "min_since_fire"; do
  echo "$SHSS" | grep -qF "$f" && ok "sync verdict reads $f" || bad "sync verdict section lost: $f"
done
SHW=$(grep -c "await sec('session_history_sync_warns_24h'" ./audit-live-state.js)
[ "$SHW" = 1 ] && ok "session_history_sync_warns_24h section exists" || bad "sync warn-class section missing ($SHW)"
SHWS=$(sed -n "/await sec('session_history_sync_warns_24h'/,/^  }));$/p" ./audit-live-state.js)
for cls in enoent_mirror mirror_missing_warn other; do
  echo "$SHWS" | grep -q "'$cls'" && ok "warn classes carry '$cls'" || bad "warn class '$cls' missing"
done
echo "$SHWS" | grep -q "LIKE '%session history sync%'" && ok "warn watch scoped to the sweep's own lines" || bad "warn watch lost its message scope"
# f107 bake (27th f64): the section must carry the computed verdict column —
# the two bars this firing adjudicated by hand (storm_active 'other' class,
# repeat_warn quarantine dedupe gap) so no future firing re-derives them.
for f in "AS verdict" "storm_active" "repeat_warn" "LAG(\"createdAt\")" "min_gap_min"; do
  echo "$SHWS" | grep -qF "$f" && ok "f107 verdict bake carries $f" || bad "f107 verdict bake lost: $f"
done

echo "audit-live-state.js (hook sibling-drain standing watch, 2026-09-24 firing 14/16)"
# Owner steer on 72a01d94: a WILDCARD hook firing must carry every enabled sibling
# hook's pending rows for the same target (cap 100, child-result templates excluded)
# so a multi-hook supervisor (Fleet: 12 hooks) is woken ONCE with the full digest —
# prod showed 7 run_completed rows on the 1-h-debounce per-source hook 34144716
# busy-parked 77 min behind the wildcard's wakes. The verify contract is four
# observables over the following 6 h: hook_sibling_drain rows appear on wakes
# whenever siblings had pending rows; the per-target pending oldest age falls to
# minutes; wake_delivered/day does NOT rise; nothing stuck in delivering. Pin both
# sections so the watch is never a tmp probe again (the 7dd046dd doctrine).
HSD=$(grep -c "await sec('hook_sibling_drain_24h'" ./audit-live-state.js)
[ "$HSD" = 1 ] && ok "hook_sibling_drain_24h section exists" || bad "sibling-drain section missing ($HSD)"
HSDS=$(sed -n "/await sec('hook_sibling_drain_24h'/,/^  }));$/p" ./audit-live-state.js)
for f in "kind='hook_sibling_drain'" "meta->>'siblingHooks'" "value AS rows_drained"; do
  echo "$HSDS" | grep -qF "$f" && ok "sibling-drain watch reads $f" || bad "sibling-drain section lost: $f"
done
HPT=$(grep -c "await sec('hook_pending_by_target_24h'" ./audit-live-state.js)
[ "$HPT" = 1 ] && ok "hook_pending_by_target_24h section exists" || bad "hook-park section missing ($HPT)"
HPTS=$(sed -n "/await sec('hook_pending_by_target_24h'/,/^  }));$/p" ./audit-live-state.js)
for f in "he.status='pending'" "oldest_age_min" "COUNT(DISTINCT he.\"hookId\")::int AS hooks_involved"; do
  echo "$HPTS" | grep -qF "$f" && ok "hook-park watch reads $f" || bad "hook-park section lost: $f"
done
echo "$HPTS" | grep -q "interval '30 minutes'" && ok "hook-park watch flags >30 min parks (the steer's failure test)" || bad "hook-park watch lost the 30-min park threshold"

echo "audit-live-state.js (wake queue-rider standing watch, 2026-09-24 firing 18)"
# Owner steer on c8d39c6d: queued agent report-ups on a PLAIN chat ride the next
# hook/schedule wake as a bounded rider (<=8,000 chars, [QUEUED WHILE BUSY header,
# rows deleted only after the run STARTS) so they stop costing one supervisor turn
# each. metric wake_queue_rider {origin, chars, remaining, hookId|scheduleId}.
# Verify contract: riders on BOTH wake paths, chars within bound, remaining
# announced, every rider paired with a wake_delivered row — a rider metric with no
# wake row, or a rider-free wake on a chat whose queue was non-empty at fire time,
# is the rider-missing-when-queued defect class. Pin both sections (7dd046dd
# doctrine) so the watch never needs an ad-hoc tmp probe again.
WQR=$(grep -c "await sec('wake_queue_rider_24h'" ./audit-live-state.js)
[ "$WQR" = 1 ] && ok "wake_queue_rider_24h section exists" || bad "rider section missing ($WQR)"
WQRS=$(sed -n "/await sec('wake_queue_rider_24h'/,/^  }));$/p" ./audit-live-state.js)
for f in "kind='wake_queue_rider'" "meta->>'origin' = 'hook'" "meta->>'origin' = 'schedule'" "meta->>'remaining'" "meta->>'chars'"; do
  echo "$WQRS" | grep -qF "$f" && ok "rider watch reads $f" || bad "rider section lost: $f"
done
echo "$WQRS" | grep -qF "COUNT(*) FILTER (WHERE" && ok "rider watch splits wake paths via FILTER" || bad "rider watch lost the per-origin split"
RWM=$(grep -c "await sec('rider_wakes_vs_metrics_4h'" ./audit-live-state.js)
[ "$RWM" = 1 ] && ok "rider_wakes_vs_metrics_4h section exists" || bad "rider-pairing section missing ($RWM)"
RWMS=$(sed -n "/await sec('rider_wakes_vs_metrics_4h'/,/^  }));$/p" ./audit-live-state.js)
for f in "kind='wake_delivered'" "missing_wake_rows" "LATERAL" "m.meta->>'origin' = 'hook'"; do
  echo "$RWMS" | grep -qF "$f" && ok "rider pairing reads $f" || bad "rider-pairing section lost: $f"
done

echo "audit-live-state.js (hook lag + wake size + memory retention are STANDING — hardening loop iteration 8, 2026-09-24)"
for sname in hook_lag_by_target_4h hook_oldest_pending_now wake_prompt_size_vs_clip_24h memory_scope_evictions_24h i8_retention_check i9_hit_aware_check p22p05_strip_check i10_hardening_check citation_retry_outcomes_7d steer_a1_check steer_46b_check i11_clock_check; do
  n=$(grep -c "await sec('$sname'" ./audit-live-state.js)
  [ "$n" = 1 ] && ok "$sname section exists" || bad "$sname section missing ($n)"
done
P22=$(sed -n "/22P05 strip check/,/^  }));$/p" ./audit-live-state.js)
for f in "pg_unsafe_stripped" "unsupported Unicode escape" "final transcript persist failed" "PG_UNSAFE_STRIP_DISABLED"; do
  echo "$P22" | grep -qF "$f" && ok "22P05 check reads $f" || bad "22P05 section lost: $f"
done
I10=$(sed -n "/iteration 10 (owner steer 2026-09-25/,/^  }));$/p" ./audit-live-state.js)
for f in "claim_txn_errors_by_hour_24h" "Unable to start a transaction" "mirror_missing_warns_24h" "local_mirror_selfheal" "\"repoProvider\"='local'" "COMPACTION_FIRST_USER_CLIP_EXEMPT_DISABLED" "RUN_CLAIM_TXN_MAX_WAIT_MS" "LOCAL_MIRROR_SELFHEAL_DISABLED"; do
  echo "$I10" | grep -qF "$f" && ok "i10 hardening check reads $f" || bad "i10 hardening section lost: $f"
done
CIT=$(sed -n "/Citation-class action-verifier second pass/,/^  }));$/p" ./audit-live-state.js)
for f in "citation_retry_outcomes_7d" "citationRetry" "still_dirty" "avg_retry_ms" "(pass1-only)"; do
  echo "$CIT" | grep -qF "$f" && ok "citation retry section reads $f" || bad "citation-retry section lost: $f"
done
A1=$(sed -n "/Owner steer a1f2021a/,/^  }));$/p" ./audit-live-state.js)
for f in "dgw_token_beyond_24h" "dgw_[A-Za-z0-9_-]{20,}" "create_chat_webhook" "stage_upload_receipts_24h" "ownerBrowser"; do
  echo "$A1" | grep -qF "$f" && ok "steer a1 check reads $f" || bad "steer-a1 section lost: $f"
done
S46=$(sed -n "/Owner steer 46bddc66/,/^  }));$/p" ./audit-live-state.js)
for f in "resolution_failures_24h" "startCodingSession target resolution failed" "reprovision_errors_24h" "No such remote" "with_full_project_id"; do
  echo "$S46" | grep -qF "$f" && ok "steer 46b check reads $f" || bad "steer-46b section lost: $f"
done
I11=$(sed -n "/Hardening loop iteration 11/,/^  }));$/p" ./audit-live-state.js)
for f in "clock_strikes_by_hour_24h" "reject_back_with_clockhits_24h" "clockHits" "clockhits_exempt_leak_24h" "future_dated_strikes_24h" "future-clock strike"; do
  echo "$I11" | grep -qF "$f" && ok "i11 clock check reads $f" || bad "i11-clock section lost: $f"
done
I8=$(sed -n "/Iteration-8 retention spot-check/,/^  }));$/p" ./audit-live-state.js)
for f in "source_cap_spotcheck" "rows_older_24h" "rows_deleted" "reason'='hard_ceiling'" "source='compaction'" "percentile_cont(0.9)" "FROM digby_memory" "SESSION_SCOPE_DYNAMIC_CAP_DISABLED"; do
  echo "$I8" | grep -qF "$f" && ok "i8 retention check reads $f" || bad "i8 retention section lost: $f"
done
I9=$(sed -n "/Iteration-9 hit-aware eviction spot-checks/,/^  }));$/p" ./audit-live-state.js)
for f in "column_name='last_hit_at'" "column_present" "stamped_by_hour" "meta->>'hitAware'" "older_kept_with_hit" "UPDATE digby_memory SET last_hit_at" "MEM_HIT_AWARE_EVICTION_DISABLED"; do
  echo "$I9" | grep -qF "$f" && ok "i9 hit-aware check reads $f" || bad "i9 hit-aware section lost: $f"
done
echo "$I9" | grep -qF "COUNT(*) FILTER (WHERE" && ok "i9 keep-set split via FILTER" || bad "i9 keep-set lost the FILTER split"
HL=$(sed -n "/await sec('hook_lag_by_target_4h'/,/^  }));$/p" ./audit-live-state.js)
for f in "percentile_cont(0.5)" "percentile_cont(0.9)" "e.status='delivered'" "h.\"targetChatId\""; do
  echo "$HL" | grep -qF "$f" && ok "hook lag reads $f" || bad "hook lag section lost: $f"
done
WS=$(sed -n "/await sec('wake_prompt_size_vs_clip_24h'/,/^  }));$/p" ./audit-live-state.js)
echo "$WS" | grep -qF "length(content) > 14000" && ok "wake size section keys on the 14,000 clip" || bad "wake size section lost the clip bound"
ME=$(sed -n "/await sec('memory_scope_evictions_24h'/,/^  }));$/p" ./audit-live-state.js)
echo "$ME" | grep -qF "meta->>'reason'" && ok "eviction section reads reason" || bad "eviction section lost reason"

echo "run-on-box.sh (output paging, 2026-09-23 firing 6)"
# Firing 6 regression: audit-live-state.js prints ~29 KB but one GetCommandInvocation
# returns at most ~24 KB of StandardOutputContent (and the lane harness caps a command's
# output at the same order), so the single-shot fetch came back CUT MID-JSON — and the
# naive hand retry, a per-LINE character slicer, silently returned NOTHING for every
# range past the first line (pretty-printed JSON lines are all short). Pin: the runner
# parks output in box-side temp files behind a __ROB_RC__/__ROB_OUT__/__ROB_ERR__ trailer
# and reassembles pages BYTE-EXACTLY with `tail -c +N | head -c C`; a per-LINE slicer
# must never appear in the runner; the paging kill switch exists.
PAGER=$(grep -c "tail -c +" ./run-on-box.sh)
[ "$PAGER" -ge 2 ] && ok "pages fetched with byte ranges (tail -c +N, $PAGER sites)" || bad "no byte-range paging in the runner"
grep -qE "(^|[^-])cut -c" ./run-on-box.sh && bad "a per-LINE slicer must never appear in the runner" || ok "no per-LINE slicer in the runner"
grep -q "ROB_PAGING_DISABLED" ./run-on-box.sh && grep -q "ROB_PAGING_DISABLED" ./run-on-box.test.sh && ok "paging kill switch pinned both sides" || bad "ROB_PAGING_DISABLED pin missing"

echo "run-on-box.sh (subshell wrapper, 2026-09-23 firing 6 live catch)"
# The prodq idiom ENDS WITH ITS OWN `exit $rc`. Under the first-cut BRACE-group wrapper
# `( { cmd ; } > park … )` that exit killed the remote shell BEFORE the trailer printf —
# the runner fell open with zero output (caught live on the distill-verdict probe). The
# wrapper must run the command in a SUBSHELL so `exit` ends the subshell only. Pin BOTH
# statically (the wrapped= line opens with `( `) and FUNCTIONALLY: execute the exact
# wrapper string the runner sent, against a command that exits 7, and require the trailer.
grep -q '^wrapped="( ' ./run-on-box.sh && ok "wrapper opens a subshell (not a brace group)" || bad "wrapped= must start with ( — a brace group lets the command's exit kill the trailer"
stage 0 /dev/null
: > "$AWS_LOG"
./run-on-box.sh A "bash -c 'echo partial; exit 7'" >/dev/null 2>&1 || true
sent="$(python3 - "$AWS_LOG" <<'PY'
import sys, re, json
lines = [l for l in open(sys.argv[1]) if 'send-command' in l and '__ROB_RC__' in l]
m = re.search(r'\{"commands": .*?"executionTimeout": \["240"\]\}', lines[-1])
print(json.loads(m.group(0))['commands'][0])
PY
)"
[ -n "$sent" ] && ok "wrapped command captured from the SSM send log" || bad "could not capture the wrapped command from $AWS_LOG"
trailer_out="$(bash -c "$sent" 2>/dev/null)"; rm -f /tmp/rob-*.out /tmp/rob-*.err
printf '%s\n' "$trailer_out" | grep -q '__ROB_RC__ 7' && ok "command with its own exit still yields the trailer (subshell)" || bad "trailer lost to the command's exit: $(printf '%s' "$trailer_out" | head -c 80)"
printf '%s\n' "$trailer_out" | grep -q '__ROB_OUT__ 8' && ok "parked stdout byte-counted through the exit (partial\\n = 8 B)" || bad "parked output not counted: $trailer_out"

# ── STS preflight (FO firing 120 bake) ──────────────────────────────────────
# The 2026-10-11 live trap: a dead sandbox credential surfaced as a bare
# UnrecognizedClientException from the GetCommandInvocation poll. The preflight
# must (a) name the credential class + refresh path and exit 5 BEFORE any SSM
# call, (b) fail OPEN on every non-credential error, (c) be bypassable, and
# (d) make no aws call when off (kill switch / no aws binary).
echo "STS preflight (f120 bake)"
stage 0 "$SBX/small.out"; : > "$AWS_LOG"
out=$(./run-on-box.sh A 'uptime' 2>"$SBX/sts-err"); rc=$?
[ "$rc" = 0 ] && ok "preflight healthy: exit 0, SSM path unchanged" || bad "healthy credential still fails: rc=$rc"
grep -q 'sts get-caller-identity' "$AWS_LOG" && ok "preflight calls sts get-caller-identity first" || bad "no sts call in log"
grep -q 'send-command' "$AWS_LOG" && ok "healthy path proceeds to SSM send-command" || bad "SSM never reached on healthy credential"

SSM_STS_ERR='aws: [ERROR]: An error occurred (InvalidClientTokenId) when calling the GetCallerIdentity operation: The security token included in the request is invalid.'
: > "$AWS_LOG"
out=$(SSM_STS_ERR="$SSM_STS_ERR" ./run-on-box.sh A 'uptime' 2>"$SBX/sts-err"); rc=$?
[ "$rc" = 5 ] && ok "dead credential: exit 5 (not the generic 4)" || bad "dead-credential exit was $rc"
grep -q 'CREDENTIAL REJECTED' "$SBX/sts-err" && ok "dead credential named as credential class" || bad "credential-class line missing: $(head -c 100 "$SBX/sts-err")"
grep -q 'Account → Coding → Providers → AWS' "$SBX/sts-err" && ok "refresh instruction printed (owner action path)" || bad "refresh instruction missing"
grep -q 'NOT an SSM permission issue' "$SBX/sts-err" && ok "misdiagnosis warning printed" || bad "misdiagnosis warning missing"
if grep -q 'send-command' "$AWS_LOG"; then bad "SSM command SENT despite dead credential"; else ok "no SSM command sent (fail-fast before SSM)"; fi

SSM_STS_ERR='aws: [ERROR]: An error occurred (ThrottlingException) when calling the GetCallerIdentity operation: Rate exceeded'
stage 0 "$SBX/small.out"; : > "$AWS_LOG"
out=$(SSM_STS_ERR="$SSM_STS_ERR" ./run-on-box.sh A 'uptime' 2>"$SBX/sts-err"); rc=$?
[ "$rc" = 0 ] && ok "non-credential STS error: FAILOPEN (exit 0, SSM proceeds)" || bad "non-credential error blocked the run: rc=$rc"
grep -q 'fail-open' "$SBX/sts-err" && ok "fail-open notice printed to stderr" || bad "fail-open notice missing"
grep -q 'send-command' "$AWS_LOG" && ok "fail-open reaches SSM send-command" || bad "fail-open never reached SSM"

SSM_STS_ERR='aws: [ERROR]: An error occurred (InvalidClientTokenId) when calling the GetCallerIdentity operation: The security token included in the request is invalid.'
: > "$AWS_LOG"
out=$(RUN_ON_BOX_SKIP_STS_PREFLIGHT=1 ./run-on-box.sh A 'uptime' 2>/dev/null); rc=$?
[ "$rc" = 0 ] && ok "kill switch bypasses the preflight entirely" || bad "kill switch did not bypass: rc=$rc"
if grep -q 'sts get-caller-identity' "$AWS_LOG"; then bad "sts called despite kill switch"; else ok "kill switch makes no sts call"; fi
unset SSM_STS_ERR

echo "passed=$PASS failed=$FAIL"
[ "$FAIL" = 0 ]
