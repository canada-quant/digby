#!/usr/bin/env bash
# Regression test — migrate-lock-recovery.sh (lane-lifecycle third review,
# 2026-10-22; fourth review the same day). A migration that loses a lock wait
# (Postgres 55P03) is recorded as FAILED by `prisma migrate deploy` and every
# later deploy then refuses with P3009 — a permanent pipeline wedge. The helper
# resolves exactly an ATOMIC in-place lock-retry migration's lost wait (P3018 +
# 55P03 + "[digby-lock-retry]", the file carrying "-- digby-lock-retry: atomic")
# as rolled back and retries ONCE; a retry that loses too is resolved AGAIN so
# the next deploy re-attempts; a P3009 an earlier deploy left is recovered only
# when the read-only probe says every failed row is such a lost wait; every other
# failure fails at once; MIGRATE_LOCK_RECOVERY_DISABLED=1|true|on runs migrate
# deploy once. Verified end to end against Prisma CLI 7.10 + Postgres 16 when
# written (the fake below replays the CLI's real P3018 / P3009 output; the real
# run: a 20 s ACCESS SHARE holder applied after it released with 0 reader stalls
# over 150 probes; a 40 s holder against a 6 s budget lost twice, was resolved
# twice and the next run applied; a switch-on P3009 was recovered via the probe;
# a 1/0 migration's P3009 was never resolved). Fifth review (2026-10-22): a loss that
# only WAITED behind a long holder ("(0 lock requests") is resolved without a retry;
# an ineligible P3009 points at the killed-mid-wait runbook; the migration's holder
# classification is privilege-independent, names this database, budget <= 120 s
# (verified on Postgres 16 as an unprivileged owner role + the real helper on Prisma 7.10).
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
failures=0
ok()  { echo "PASS: $1"; }
bad() { echo "FAIL: $1"; failures=$((failures + 1)); }
check() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (want [$2] got [$3])"; fi; }

bash -n "$ROOT/scripts/deploy/migrate-lock-recovery.sh" && ok "bash -n" || bad "bash -n"
SB="$(mktemp -d)"; trap 'rm -rf "$SB"' EXIT
MIGDIR="$SB/migrations"; mkdir -p "$MIGDIR/20261021120000_chat_display_parent" "$MIGDIR/20261030000000_plain"
printf -- '-- digby-lock-retry: atomic — the DO block is the only statement\nDO $$ BEGIN NULL; END $$;\n' > "$MIGDIR/20261021120000_chat_display_parent/migration.sql"
printf 'SET lock_timeout = %s;\nALTER TABLE "x" ADD COLUMN "y" TEXT;\n' "'1s'" > "$MIGDIR/20261030000000_plain/migration.sql"

# fake `npx prisma`: logs each call; `migrate deploy` prints $SB/msg.<n> (n = 1, 2, …) and fails while
# $SB/left > 0; `db execute` answers $SB/probe_rc with $SB/probe_out.
cat > "$SB/fakeprisma" <<'FAKE'
#!/usr/bin/env bash
d="$(dirname "$0")"
echo "$*" >> "$d/calls"
if [ "$1 $2" = "migrate deploy" ]; then
  n=$(( $(cat "$d/n" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$d/n"
  left=$(cat "$d/left")
  if [ "$left" -gt 0 ]; then echo $((left - 1)) > "$d/left"; if [ -f "$d/msg.$n" ]; then cat "$d/msg.$n"; else cat "$d/msg"; fi; exit 1; fi
  echo "All migrations have been successfully applied."; exit 0
fi
if [ "$1 $2" = "migrate resolve" ]; then exit "$(cat "$d/resolve_rc" 2>/dev/null || echo 0)"; fi
if [ "$1 $2" = "db execute" ]; then cat "$d/probe_out" 2>/dev/null; exit "$(cat "$d/probe_rc" 2>/dev/null || echo 0)"; fi
exit 9
FAKE
chmod +x "$SB/fakeprisma"

LOCK_MSG='Applying migration `20261021120000_chat_display_parent`
Error: P3018

A migration failed to apply. New migrations cannot be applied before the error is recovered from.

Migration name: 20261021120000_chat_display_parent

Database error code: 55P03

Database error:
ERROR: [digby-lock-retry] crossmodel_chats: the ADD COLUMN lock was not acquired in 240 s (3 lock requests of <= 1.5 s, 110 waits behind a long transaction) — nothing was changed; lock holders: pid 4809 (pg_dump, client backend, active, AccessShareLock, open 412 s)'
# fifth review: the loop never requested the lock — it only waited behind a long holder (pg_dump)
WAITONLY_LOCK_MSG="${LOCK_MSG/(3 lock requests of <= 1.5 s, 110 waits/(0 lock requests of <= 1.5 s, 58 waits}"
BARE_LOCK_MSG='Error: P3018

Migration name: 20261030000000_plain

Database error code: 55P03

Database error:
ERROR: canceling statement due to lock timeout'
UNMARKED_LOCK_MSG='Error: P3018

Migration name: 20261021120000_chat_display_parent

Database error code: 55P03

Database error:
ERROR: canceling statement due to lock timeout'
OTHER_MSG='Error: P3018

Migration name: 20261021120000_chat_display_parent

Database error code: 42P07

Database error:
ERROR: relation "x" already exists'
P3009_MSG='Error: P3009

migrate found failed migrations in the target database, new migrations will not be applied. Read more about how to resolve migration issues in a production database: https://pris.ly/d/migrate-resolve
The `20261021120000_chat_display_parent` migration started at 2026-10-22 01:40:11.011544 UTC failed'
P3009_PLAIN_MSG='Error: P3009

migrate found failed migrations in the target database, new migrations will not be applied.
The `20261030000000_plain` migration started at 2026-10-22 01:40:11.011544 UTC failed'
PROBE_ELIGIBLE='Error: ERROR: digby-lock-retry-probe: eligible'

setup() { # $1 = deploy failures before success, $2 = failure message (every failing deploy)
  rm -f "$SB"/calls "$SB"/resolve_rc "$SB"/n "$SB"/msg.* "$SB"/probe_rc "$SB"/probe_out
  echo "$1" > "$SB/left"; printf '%s\n' "$2" > "$SB/msg"
}
go() { # runs the helper as deploy-blue-green.sh does (set -euo pipefail, migrations dir + probe file set)
  ( set -euo pipefail; . "$ROOT/scripts/deploy/migrate-lock-recovery.sh"
    export MIGRATE_LOCK_MIGRATIONS_DIR="$MIGDIR" MIGRATE_LOCK_PROBE_FILE=prisma/lock-recovery-probe.sql
    migrate_deploy_with_lock_recovery "$SB/fakeprisma" ) >"$SB/out" 2>&1
  echo $?
}
run() { setup "$1" "$2"; go; }
calls() { tr '\n' '|' < "$SB/calls" 2>/dev/null; }
DEPLOY='migrate deploy|'
RESOLVE='migrate resolve --rolled-back 20261021120000_chat_display_parent|'
PROBE='db execute --file prisma/lock-recovery-probe.sql|'

check "clean deploy → one call, exit 0" 0 "$(run 0 '')"
check "  …calls" "$DEPLOY" "$(calls)"
check "a lost lock wait of the atomic lock-retry migration → resolved rolled back, retried once, succeeds" 0 "$(run 1 "$LOCK_MSG")"
check "  …calls" "$DEPLOY$RESOLVE$DEPLOY" "$(calls)"
grep -q 'lost a lock wait' "$SB/out" && ok "  …logged" || bad "  …not logged"
grep -q 'pg_dump, client backend' "$SB/out" && ok "  …the lock holders the migration named reach the deploy log" || bad "  …holders not in the log"
check "fourth review: the retry loses its lock wait TOO → fails, and the row is resolved AGAIN (the next deploy re-attempts — never a P3009 wedge)" 1 "$(run 2 "$LOCK_MSG")"
check "  …calls" "$DEPLOY$RESOLVE$DEPLOY$RESOLVE" "$(calls)"
grep -q 'lost its lock wait AGAIN' "$SB/out" && ok "  …logged" || bad "  …second loss not logged"
check "  …then the next deploy (lock free) just applies" 0 "$(run 0 '')"
check "fifth review: a lost wait behind a LONG holder only (0 lock requests) → resolved, NO retry (it would wait behind the same holder — two full waits ate the deploy budget), fails" 1 "$(run 1 "$WAITONLY_LOCK_MSG")"
check "  …calls" "$DEPLOY$RESOLVE" "$(calls)"
grep -q 'WITHOUT a retry' "$SB/out" && ok "  …logged" || bad "  …wait-only loss not logged"
check "  …a failing resolve there returns its exit code" 3 "$(setup 1 "$WAITONLY_LOCK_MSG"; echo 3 > "$SB/resolve_rc"; go)"
check "fifth review: a retry-worthy loss names >0 requests (the wait-only test is not a prefix match of 10, 20 …)" 0 "$(run 1 "${LOCK_MSG/(3 lock requests/(10 lock requests}")"
check "  …calls" "$DEPLOY$RESOLVE$DEPLOY" "$(calls)"
check "fourth review: a 55P03 WITHOUT the [digby-lock-retry] marker (a bare lock_timeout — statements before it may be committed) → fails at once, never resolved" 1 "$(run 1 "$UNMARKED_LOCK_MSG")"
check "  …calls" "$DEPLOY" "$(calls)"
check "fourth review: a bare-lock_timeout migration's 55P03 → fails at once" 1 "$(run 1 "$BARE_LOCK_MSG")"
check "  …calls" "$DEPLOY" "$(calls)"
check "fourth review: the marker in the output but the migration file NOT declared atomic → fails at once" 1 "$(setup 1 "${LOCK_MSG//20261021120000_chat_display_parent/20261030000000_plain}"; go)"
check "  …calls" "$DEPLOY" "$(calls)"
check "P3018 with another DB error → fails at once, never resolved" 1 "$(run 1 "$OTHER_MSG")"
check "  …calls" "$DEPLOY" "$(calls)"
check "fourth review: P3009 an earlier deploy left, the probe says every failed row is a lost lock wait → resolved, retried, succeeds" 0 "$(setup 1 "$P3009_MSG"; echo 1 > "$SB/probe_rc"; printf '%s\n' "$PROBE_ELIGIBLE" > "$SB/probe_out"; go)"
check "  …calls" "$DEPLOY$PROBE$RESOLVE$DEPLOY" "$(calls)"
grep -q 'P3009: an earlier deploy' "$SB/out" && ok "  …logged" || bad "  …P3009 recovery not logged"
check "fourth review: P3009 recovered, then its retry loses the lock again → resolved again, fails" 1 "$(setup 2 "$P3009_MSG"; printf '%s\n' "$LOCK_MSG" > "$SB/msg.2"; echo 1 > "$SB/probe_rc"; printf '%s\n' "$PROBE_ELIGIBLE" > "$SB/probe_out"; go)"
check "  …calls" "$DEPLOY$PROBE$RESOLVE$DEPLOY$RESOLVE" "$(calls)"
check "P3009 the probe does NOT call eligible (another failure, a row still running, or a deploy KILLED mid-wait — logs NULL) → fails at once" 1 "$(run 1 "$P3009_MSG")"
check "  …calls" "$DEPLOY$PROBE" "$(calls)"
grep -q 'killed mid-wait' "$SB/out" && ok "  …fifth review: the log points at the killed-deploy runbook (never claims an automatic recovery)" || bad "  …no killed-deploy pointer"
check "P3009 whose probe errors for another reason (no token) → fails at once" 1 "$(setup 1 "$P3009_MSG"; echo 1 > "$SB/probe_rc"; echo 'Error: file not found' > "$SB/probe_out"; go)"
check "  …calls" "$DEPLOY$PROBE" "$(calls)"
check "P3009 naming a migration that is not declared atomic → fails at once (no probe)" 1 "$(setup 1 "$P3009_PLAIN_MSG"; echo 1 > "$SB/probe_rc"; printf '%s\n' "$PROBE_ELIGIBLE" > "$SB/probe_out"; go)"
check "  …calls" "$DEPLOY" "$(calls)"
check "a failing resolve returns its exit code and never re-deploys" 3 "$(setup 1 "$LOCK_MSG"; echo 3 > "$SB/resolve_rc"; go)"
check "  …calls" "$DEPLOY$RESOLVE" "$(calls)"
for v in 1 true TRUE ' on '; do
  check "MIGRATE_LOCK_RECOVERY_DISABLED='$v' → one deploy even on a lost lock wait" 1 "$(setup 1 "$LOCK_MSG"; MIGRATE_LOCK_RECOVERY_DISABLED="$v" go)"
  check "  …calls" "$DEPLOY" "$(calls)"
done
check "MIGRATE_LOCK_RECOVERY_DISABLED=0 → recovery on" 0 "$(setup 1 "$LOCK_MSG"; MIGRATE_LOCK_RECOVERY_DISABLED=0 go)"

# wiring
grep -q 'scripts/deploy/migrate-lock-recovery.sh' "$ROOT/deploy-blue-green.sh" && ok "wiring: blue-green sources the helper" || bad "wiring: blue-green does not source the helper"
grep -q 'migrate_deploy_with_lock_recovery sudo BG_COLOR=' "$ROOT/deploy-blue-green.sh" && ok "wiring: the migrate step is wrapped" || bad "wiring: migrate step not wrapped"
check "wiring: no unwrapped migrate deploy left in blue-green" 0 "$(grep -c 'npx prisma migrate deploy' "$ROOT/deploy-blue-green.sh")"
grep -q 'export MIGRATE_LOCK_MIGRATIONS_DIR="${COMPOSE_DIR}/backend/prisma/migrations"' "$ROOT/deploy-blue-green.sh" && ok "wiring: blue-green names the migrations dir (the atomic check runs in prod)" || bad "wiring: no migrations dir"
grep -q 'export MIGRATE_LOCK_PROBE_FILE="prisma/lock-recovery-probe.sql"' "$ROOT/deploy-blue-green.sh" && ok "wiring: blue-green names the probe file (in the backend image: COPY prisma ./prisma/)" || bad "wiring: no probe file"
DY="$ROOT/.github/workflows/deploy.yml"
grep -q 'MIGRATE_LOCK_RECOVERY_DISABLED: \${{ vars.MIGRATE_LOCK_RECOVERY_DISABLED }}' "$DY" && ok "wiring (fourth review): deploy.yml maps the repo Variable into the Blue-green step" || bad "wiring: deploy.yml does not map MIGRATE_LOCK_RECOVERY_DISABLED"
grep 'printf .set -e' "$DY" | grep -Eq 'export [^\\]* ?MIGRATE_LOCK_RECOVERY_DISABLED=%q' && ok "wiring (fourth review): the stdin script exports it to the box" || bad "wiring: the stdin script does not export MIGRATE_LOCK_RECOVERY_DISABLED"
check "wiring: the printf has one value per %q" "$(grep -o '%q' <<<"$(grep 'printf .set -e' "$DY")" | wc -l | tr -d ' ')" "$(sed -n '/printf .set -e/,/ssh -i/p' "$DY" | sed '1d' | grep -o '"\$[A-Z_]*"\|"\${{ vars\.[A-Z_]* }}"' | wc -l | tr -d ' ')"
PROBE_SQL="$ROOT/backend/prisma/lock-recovery-probe.sql"
[ -f "$PROBE_SQL" ] && ok "the probe file exists" || bad "the probe file is missing"
grep -qF "RAISE EXCEPTION 'digby-lock-retry-probe: eligible'" "$PROBE_SQL" && ok "the probe raises the helper's token" || bad "the probe does not raise the token"
grep -qF "'[digby-lock-retry]'" "$PROBE_SQL" && ok "the probe requires the loop's marker on every failed row" || bad "the probe does not check the marker"

# migrations: the display-parent migration retries its own lock in place, bounded and short per request
MIG="$ROOT/backend/prisma/migrations/20261021120000_chat_display_parent/migration.sql"
grep -q 'EXCEPTION WHEN lock_not_available' "$MIG" && ok "migration: lock_not_available retried in place" || bad "migration: no in-place retry"
grep -q "SET LOCAL lock_timeout = '250ms'" "$MIG" && ok "migration (fourth review): each plain request waits ≤ 250 ms" || bad "migration: per-request wait not 250 ms"
grep -q 'pg_stat_clear_snapshot()' "$MIG" && ok "migration: re-reads pg_stat_activity every pass" || bad "migration: stale pg_stat_activity"
grep -q 'clock_timestamp() + budget' "$MIG" && ok "migration: bounded by a clock budget" || bad "migration: no clock budget"
grep -qF "MESSAGE = format('[digby-lock-retry]" "$MIG" && ok "migration: the exhausted loop raises the helper's marker" || bad "migration: no marker in the RAISE"
grep -Eq "^SET lock_timeout" "$MIG" && bad "migration: a bare session lock_timeout is back" || ok "migration: no bare session lock_timeout"
# fifth review: the loop's budget fits the deploy's per-host bound (the helper carries at most two loops)
bud="$(sed -n "s/^ *budget constant interval := interval '\([0-9]*\) seconds';.*$/\1/p" "$MIG")"
[ -n "$bud" ] && [ "$bud" -le 120 ] && ok "migration (fifth review): budget ${bud} s <= 120 s" || bad "migration: budget [${bud}] is not <= 120 s"
# fifth review: privilege-independent holder classification (prod migrates as the app role, no pg_read_all_stats)
grep -q 'a.pid IS NOT NULL AND a.usesysid IS NULL' "$MIG" && ok "migration (fifth review): an autovacuum is a holder with NO user (usesysid NULL — visible to every role)" || bad "migration: autovacuum still read from backend_type"
grep -q 'a.usesysid IS NOT NULL AND a.state IS NULL' "$MIG" && ok "migration (fifth review): a session whose details are hidden is waited out, never queued against" || bad "migration: hidden sessions not treated as long holders"
grep -q 'age(c.relfrozenxid)' "$MIG" && ok "migration (fifth review): an anti-wraparound autovacuum is known by the table's freeze age when its query is hidden" || bad "migration: no freeze-age check"
grep -q 'refused_pids' "$MIG" && ok "migration (fifth review): an autovacuum a 1.5 s request lost against is never queued against again" || bad "migration: no refused-autovacuum memory"
grep -q "backend_type IS DISTINCT FROM 'autovacuum worker'\|backend_type = 'autovacuum worker'" "$MIG" && bad "migration: the classification still reads backend_type (NULL for an unprivileged role)" || ok "migration: the classification never reads backend_type"
# fifth review: pg_locks is cluster-wide — every read is restricted to this database (a TEMPLATE copy keeps the OIDs)
check "migration (fifth review): both pg_locks reads name this database" 2 "$(grep -c 'l.database = (SELECT d.oid FROM pg_database d WHERE d.datname = current_database())' "$MIG")"
# every migration that declares itself atomic is comments + exactly ONE DO block (Prisma does not wrap a file in a transaction)
for f in "$ROOT"/backend/prisma/migrations/*/migration.sql; do
  grep -qF -- '-- digby-lock-retry: atomic' "$f" || continue
  body="$(grep -v '^[[:space:]]*--' "$f" | grep -v '^[[:space:]]*$')"
  first="$(printf '%s\n' "$body" | head -n 1)"; last="$(printf '%s\n' "$body" | tail -n 1)"
  dos="$(printf '%s\n' "$body" | grep -c '^DO \$\$')"
  if [ "$first" = 'DO $$' ] && [ "$last" = 'END $$;' ] && [ "$dos" = 1 ] && [ "$(printf '%s\n' "$body" | grep -c '\$\$;')" = 1 ]; then
    ok "atomic lint: $(basename "$(dirname "$f")") is one DO block"
  else
    bad "atomic lint: $(basename "$(dirname "$f")") declares digby-lock-retry: atomic but is not exactly one DO block"
  fi
done

echo
if [ "$failures" -eq 0 ]; then echo "migrate-lock-recovery tests: all passed"; else echo "migrate-lock-recovery tests: $failures failed" >&2; exit 1; fi
