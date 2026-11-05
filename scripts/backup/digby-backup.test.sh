#!/usr/bin/env bash
# digby-backup.test.sh — local regression harness for scripts/backup/digby-backup.sh
# (FO firing 21, 2026-09-25). Fully mocked: a PATH-injected `docker` shim fakes
# `docker exec` (backend DATABASE_URL) and `docker run pg_dump` (records every
# invocation's args, fails the first N attempts on demand, REJECTS --network
# bridge the way the on-box sandbox egress guard does), plus a `df` shim with
# endless disk. No AWS, no root, no real containers.
#
# Pins the 2026-09-25 incident class:
#   1. the dump container runs with --network host (the sandbox egress guard
#      rejects default-bridge → VPC, which killed the 08:31Z nightly silently);
#   2. a failed run writes backup-status.json status:"failed" (infra-watch's
#      immediate-alert marker) and exits non-zero;
#   3. a success writes status:"ok" + the dump;
#   4. transient failures retry (attempt 2 of PG_DUMP_RETRIES succeeds);
#   5. the .env fallback leg passes the password via -e PGPASSWORD only —
#      it never reaches the script's own log lines.
set -u
cd "$(dirname "$0")/.."
SCRIPT=./backup/digby-backup.sh
SBX=$(mktemp -d)
trap 'rm -rf "$SBX"' EXIT
PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "  ok: $1"; }
bad()  { FAIL=$((FAIL+1)); echo "  FAIL: $1"; }
check(){ if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (want [$2] got [$3])"; fi; }

export BACKUP_DIR="$SBX/bk"
export BACKUP_ENV_FILE="$SBX/fake.env"
export BACKUP_CONF="$SBX/backup.conf"          # absent — no S3 leg
export PG_DUMP_RETRIES=2
export PG_DUMP_RETRY_SLEEP=0
export MOCK_BE_URL='postgresql://fake-user:fake-pass@rds.example/admin_db'
export FIXTURE_PW='FixturePwDoNotEcho123'
DOCKER_CALLS="$SBX/docker-calls.txt"
RUNS_FILE="$SBX/docker-runs.txt"
export DOCKER_CALLS RUNS_FILE
mkdir -p "$BACKUP_DIR"
printf 'POSTGRES_PASSWORD=%s\nOTHER=1\n' "$FIXTURE_PW" > "$BACKUP_ENV_FILE"

mkdir -p "$SBX/shim"
# --- docker shim (the run-counter is FILE-based: each invocation is its own process) ---
cat > "$SBX/shim/docker" <<EOF
#!/usr/bin/env bash
echo "docker \$*" >> "\$DOCKER_CALLS"
case "\$1 \$2" in
  "ps "*) [ "\${MOCK_PS_HAS_PG:-0}" = "1" ] && echo "abc123 digby-postgres  Up"; exit 0 ;;   # c75b5f34 F6: the selfhost leg's container check
  "exec "*)
    [ "\${MOCK_NO_BACKEND:-0}" = "1" ] && exit 1
    case "\$2" in
      digby-postgres) [ "\${MOCK_PG_DUMP_FAIL:-0}" = "1" ] && exit 1; printf 'DUMPDATA-selfhost'; exit 0 ;;
    esac
    printf '%s' "\$MOCK_BE_URL"; exit 0 ;;             # backend DATABASE_URL
  "run "*)
    has_host=0; prevarg=""
    for a in "\$@"; do
      case "\$prevarg" in --network) [ "\$a" = "host" ] && has_host=1 ;; esac
      prevarg="\$a"
    done
    # egress-guard simulation: no host network → VPC/RDS is REJECTed on the box
    if [ "\$has_host" = "0" ]; then
      echo "pg_dump: error: connection to server at \"rds.example\" port 5432 failed: Connection refused" >&2
      exit 1
    fi
    n=\$(( \$(wc -l < "\$RUNS_FILE" 2>/dev/null || echo 0) + 1 )); echo run >> "\$RUNS_FILE"
    if [ "\$n" -le "\${MOCK_FAIL_FIRST:-0}" ]; then
      echo "pg_dump: error: transient refusal (mock attempt \$n)" >&2; exit 1
    fi
    printf 'DUMPDATA-%s' "\$n"; exit 0 ;;
  *) echo "mock docker: unsupported: \$*" >&2; exit 1 ;;
esac
EOF
chmod +x "$SBX/shim/docker"
# --- df shim: df --output=avail -m / → header + one number -----------------------
printf '#!/usr/bin/env bash\necho Avail\necho 899999\n' > "$SBX/shim/df"
chmod +x "$SBX/shim/df"

run_script() { rm -f "$RUNS_FILE" "$DOCKER_CALLS"; PATH="$SBX/shim:$PATH" bash "$SCRIPT" > "$SBX/out.log" 2>&1; echo $?; }
status_json() { python3 -c "import json; d=json.load(open('$BACKUP_DIR/backup-status.json')); print(d.get('$1',''))" 2>/dev/null || echo PARSE_ERR; }

# ── 1. success: --network host dump + status ok ───────────────────────────────
rm -f "$BACKUP_DIR"/*; unset MOCK_FAIL_FIRST MOCK_NO_BACKEND 2>/dev/null || true
rc=$(run_script)
check "1 success run exits 0" "0" "$rc"
check "1 dump file written" "1" "$(ls "$BACKUP_DIR" | grep -c '^admin_db-.*\.dump$')"
check "1 status marker ok" "ok" "$(status_json status)"
check "1 dump container used --network host (egress-guard compat)" "1" "$(grep -c -- '--network host' "$DOCKER_CALLS")"
check "1 no bridge invocation" "0" "$(grep -c -- '--network bridge' "$DOCKER_CALLS")"

# ── 2. the 2026-09-25 class: RDS unreachable → failed marker + non-zero exit ──
rm -f "$BACKUP_DIR"/*; export MOCK_FAIL_FIRST=99
rc=$(run_script)
check "2 all-attempts-fail run exits non-zero" "nonzero" "$([ "$rc" = "0" ] && echo zero || echo nonzero)"
check "2 status marker failed" "failed" "$(status_json status)"
check "2 marker carries an error note" "yes" "$([ -n "$(status_json error)" ] && echo yes || echo no)"
check "2 no dump file on failure" "0" "$(ls "$BACKUP_DIR" | grep -c '^admin_db-.*\.dump$')"
check "2 both legs retried (2 legs x 2 attempts = 4 pg_dump attempts)" "4" "$(grep -c 'pg_dump FAILED.*attempt [0-9]*/' "$SBX/out.log")"
unset MOCK_FAIL_FIRST

# ── 3. transient: attempt 1 fails, attempt 2 rides it out ─────────────────────
rm -f "$BACKUP_DIR"/*; export MOCK_FAIL_FIRST=1
rc=$(run_script)
check "3 transient refusal recovered (retry)" "0" "$rc"
check "3 succeeded on attempt 2" "ok" "$(status_json status)"
check "3 log names the winning attempt" "1" "$(grep -c 'succeeded on attempt 2' "$SBX/out.log")"
unset MOCK_FAIL_FIRST

# ── 4. .env fallback leg: password reaches docker via -e PGPASSWORD ONLY ─────
rm -f "$BACKUP_DIR"/*; export MOCK_NO_BACKEND=1
rc=$(run_script)
check "4 .env fallback run exits 0" "0" "$rc"
check "4 PGPASSWORD passed to the container" "1" "$(grep -c -- "-e PGPASSWORD=$FIXTURE_PW" "$DOCKER_CALLS")"
check "4 password NEVER echoed to the script log" "0" "$(grep -c "$FIXTURE_PW" "$SBX/out.log")"
unset MOCK_NO_BACKEND

# ── 5. isolation boundary (c75b5f34, review F6): the SELFHOST dump legs ─────
# The selfhost leg runs on a NON-prod instance whose own digby-postgres
# container exists: pg_dump executes INSIDE it (docker exec), no --network
# host container, no DATABASE_URL read from any backend container.
rm -f "$BACKUP_DIR"/*
rc=$(DIGBY_INSTANCE=selfhost MOCK_PS_HAS_PG=1 run_script)
check "5 selfhost leg (DIGBY_INSTANCE!=prod + digby-postgres container) exits 0" "0" "$rc"
check "5 dump written via the digby-postgres container" "1" "$(ls "$BACKUP_DIR" | grep -c '^admin_db-.*\.dump$')"
check "5 pg_dump ran INSIDE digby-postgres (docker exec leg)" "1" "$(grep -c 'exec digby-postgres pg_dump -U admin -d admin_db' "$DOCKER_CALLS")"
check "5 status marker ok" "ok" "$(status_json status)"

# PROD instance never takes the selfhost leg even when such a container exists
# (a prod box could run an unrelated digby-postgres container).
rm -f "$BACKUP_DIR"/*
rc=$(MOCK_PS_HAS_PG=1 run_script)
check "5 PROD instance skips the selfhost leg (prod container names only)" "0" "$(grep -c 'exec digby-postgres' "$DOCKER_CALLS")"
check "5 prod run still succeeds via its own legs" "0" "$rc"

# ── 6. DETECTOR-RECALL REPLAY (437896fb): the systemd budget must stay ≥7200s
# The 2026-10-24 08:31Z nightly was SIGTERM'd at exactly +30min —
# digby-backup.service carried TimeoutStartSec=1800 while the dump had grown
# to ~30min (the 2026-10-23 nightly ran 08:34:49Z→09:02:27Z, ~27.5 min —
# only ~2.5 min of margin under the old budget).
# Pins every REPO copy of the unit: deploy/digby-backup.service plus BOTH
# playbook heredoc bodies (the 2026-07-29b installer and the BK1024 one-shot).
# Review round 1 (B1): the grep is scoped to the UNIT TEXT — heredoc bodies
# extracted from the playbook, never the whole file — so prose comments
# elsewhere in the playbook (e.g. the fix note above BK1024) can never
# satisfy it, and the value must be >= 7200, so ANY regression (1800, 3600,
# …) fails, not just the literal old kill budget. A box rebuilt from a stale
# heredoc would otherwise silently re-break the nightly.
HEREDOCS=$SBX/bk-heredocs.txt
awk '/<<[[:space:]]*.?SVCEOF.?/{inb=1; next} inb && /^SVCEOF[[:space:]]*$/{inb=0; print "BODY"; next} inb' \
  ../scripts/ec2-ops/playbook.sh > "$HEREDOCS"
n_bodies=$(grep -c '^BODY$' "$HEREDOCS")
# sed captures the FIRST numeric value and drops any trailing text, so a
# legitimate inline comment (`TimeoutStartSec=7200  # 2h`) still parses.
body_vals=$(grep '^[[:space:]]*TimeoutStartSec=' "$HEREDOCS" | sed -E 's/^[[:space:]]*TimeoutStartSec=[[:space:]]*([0-9]+).*/\1/')
deploy_val=$(sed -n -E 's/^[[:space:]]*TimeoutStartSec=[[:space:]]*([0-9]+).*/\1/p' ../deploy/digby-backup.service | head -1)
copies_total=1; copies_ok=0   # 1 = the deploy unit; heredoc bodies counted below
[ -n "$deploy_val" ] && [ "$deploy_val" -ge 7200 ] && copies_ok=$((copies_ok+1))
for v in $body_vals; do
  copies_total=$((copies_total+1))
  [ "$v" -ge 7200 ] && copies_ok=$((copies_ok+1))
done
# >= 2 bodies (a future legitimate third installer copy is not a false-red —
# copies_ok==copies_total is what actually pins every copy).
[ "$n_bodies" -ge 2 ] && ok "6 at least two backup-unit heredoc bodies found (installers)" || bad "6 at least two backup-unit heredoc bodies found (installers) (want >=2 got [$n_bodies])"
check "6 all unit copies carry TimeoutStartSec >= 7200 (any regression fails)" "$copies_total" "$copies_ok"

# ── 7. orphaned-partial reclamation (cf047f4a, 2026-10-24): a run killed ──────
# mid-dump (systemd TimeoutStartSec, 437896fb — the 2026-10-24 08:31Z nightly
# was killed at exactly +30 min) leaves admin_db-<ts>.dump.tmp behind, and
# NOTHING in the script ever matched *.tmp — the 7.5 G orphan stranded on /
# since 09:01Z. The NEXT run must reclaim stale partials (older than
# ORPHAN_TMP_MAX_HOURS by mtime — default 6 h) but never touch one a CONCURRENT
# run is still writing: the fresh-mtime partial must survive UNTOUCHED (D3 —
# this assertion is what fails the silent over-delete mutant). The stale
# fixture is BACKDATED to the incident's real shape: a partial frozen 7 h ago
# (default gate = 6 h). The clamped override (D4) is exercised in 7b.
rm -f "$BACKUP_DIR"/*; unset MOCK_FAIL_FIRST MOCK_NO_BACKEND 2>/dev/null || true
stale="$BACKUP_DIR/admin_db-20261024-083117.dump.tmp"; printf 'PARTIAL-JUNK' > "$stale"; touch -d '7 hours ago' "$stale"
fresh="$BACKUP_DIR/admin_db-20261024-161025.dump.tmp"; printf 'LIVE-RUN-PARTIAL' > "$fresh"
rc=$(run_script)
check "7 stale orphan reclaimed on the next run" "0" "$(ls "$BACKUP_DIR" | grep -c 'admin_db-20261024-083117.dump.tmp')"
check "7 reclamation logged" "1" "$(grep -c 'reclaiming orphaned partial dump' "$SBX/out.log")"
check "7 run still exits 0 with reclamation" "0" "$rc"
check "7 successful dump still written" "1" "$(ls "$BACKUP_DIR" | grep -c '^admin_db-.*\.dump$')"
check "7 status marker ok" "ok" "$(status_json status)"
check "7 fresh partial (live run's) survives UNTOUCHED" "1" "$(ls "$BACKUP_DIR" | grep -c "$(basename "$fresh")")"
rm -f "$fresh"                      # the "fresh" fixture belongs to no real run

# ── 7b. D4 clamp: a fractional override falls back to the 6 h default, never ──
# to "-mmin +0" (which would match — and delete — a partial written seconds
# ago: a live run's partial). "0.5" is the exact incident shape: dispatch-1's
# truncating arithmetic turned it into orphan_min=0.
rm -f "$BACKUP_DIR"/*; export ORPHAN_TMP_MAX_HOURS=0.5
stale2="$BACKUP_DIR/admin_db-20261025-023000.dump.tmp"; printf 'PARTIAL-JUNK' > "$stale2"; touch -d '7 hours ago' "$stale2"
fresh2="$BACKUP_DIR/admin_db-20261025-032500.dump.tmp"; printf 'LIVE-RUN-PARTIAL' > "$fresh2"
rc=$(run_script)
check "7b fractional override still reclaims the 7h-old orphan" "0" "$(ls "$BACKUP_DIR" | grep -c 'admin_db-20261025-023000.dump.tmp')"
check "7b fractional override never deletes a fresh partial (clamp, not truncate)" "1" "$(ls "$BACKUP_DIR" | grep -c "$(basename "$fresh2")")"
check "7b run exits 0" "0" "$rc"
unset ORPHAN_TMP_MAX_HOURS
rm -f "$fresh2"

# ── 7c. non-numeric override: same clamp — no crash, fresh partial survives. ──
rm -f "$BACKUP_DIR"/*; export ORPHAN_TMP_MAX_HOURS="six hours"
fresh3="$BACKUP_DIR/admin_db-20261025-033000.dump.tmp"; printf 'LIVE-RUN-PARTIAL' > "$fresh3"
rc=$(run_script)
check "7c non-numeric override clamps to default (fresh partial survives)" "1" "$(ls "$BACKUP_DIR" | grep -c "$(basename "$fresh3")")"
check "7c run exits 0 (no arithmetic crash)" "0" "$rc"
unset ORPHAN_TMP_MAX_HOURS
rm -f "$fresh3"

# ── 7d. F-8a/F-8b edges (adversarial review 2026-10-25): an int64-overflow ───
# override must clamp to the default BEFORE any arithmetic (a 16+-digit value
# wraps bash int64 negative — a negative -mmin matches a partial written
# seconds ago, the over-delete class); a leading-zero value is DECIMAL ("08" =
# 8 h), never an octal parse error that silently kills the sweep; a >24 h
# value clamps to the 24 h bound.
rm -f "$BACKUP_DIR"/*; export ORPHAN_TMP_MAX_HOURS=9223372036854775807
stale4="$BACKUP_DIR/admin_db-20261025-000000.dump.tmp"; printf 'PARTIAL-JUNK' > "$stale4"; touch -d '7 hours ago' "$stale4"
fresh4="$BACKUP_DIR/admin_db-20261025-040500.dump.tmp"; printf 'LIVE-RUN-PARTIAL' > "$fresh4"
rc=$(run_script)
check "7d int64-overflow override clamps (7h stale still reclaimed)" "0" "$(ls "$BACKUP_DIR" | grep -c 'admin_db-20261025-000000.dump.tmp')"
check "7d int64-overflow override never over-deletes a fresh partial" "1" "$(ls "$BACKUP_DIR" | grep -c "$(basename "$fresh4")")"
check "7d overflow run exits 0" "0" "$rc"
unset ORPHAN_TMP_MAX_HOURS; rm -f "$fresh4"

rm -f "$BACKUP_DIR"/*; export ORPHAN_TMP_MAX_HOURS=08
stale5="$BACKUP_DIR/admin_db-20261025-010000.dump.tmp"; printf 'PARTIAL-JUNK' > "$stale5"; touch -d '9 hours ago' "$stale5"
fresh5="$BACKUP_DIR/admin_db-20261025-040600.dump.tmp"; printf 'LIVE-RUN-PARTIAL' > "$fresh5"
rc=$(run_script)
check "7d leading-zero value is DECIMAL 8h (9h stale reclaimed, no octal error)" "0" "$(ls "$BACKUP_DIR" | grep -c 'admin_db-20261025-010000.dump.tmp')"
check "7d leading-zero value keeps the fresh partial" "1" "$(ls "$BACKUP_DIR" | grep -c "$(basename "$fresh5")")"
check "7d '08' run exits 0 (sweep alive, no unbound-var death)" "0" "$rc"
unset ORPHAN_TMP_MAX_HOURS; rm -f "$fresh5"

rm -f "$BACKUP_DIR"/*; export ORPHAN_TMP_MAX_HOURS=100
stale6="$BACKUP_DIR/admin_db-20261024-000000.dump.tmp"; printf 'PARTIAL-JUNK' > "$stale6"; touch -d '25 hours ago' "$stale6"
fresh6="$BACKUP_DIR/admin_db-20261025-040700.dump.tmp"; printf 'LIVE-RUN-PARTIAL' > "$fresh6"
rc=$(run_script)
check "7d >24h override clamps to 24h (25h stale reclaimed)" "0" "$(ls "$BACKUP_DIR" | grep -c 'admin_db-20261024-000000.dump.tmp')"
check "7d clamped-24h keeps the fresh partial" "1" "$(ls "$BACKUP_DIR" | grep -c "$(basename "$fresh6")")"
unset ORPHAN_TMP_MAX_HOURS; rm -f "$fresh6"

echo "=== $PASS passed, $FAIL failed ==="
[ "$FAIL" = "0" ]
