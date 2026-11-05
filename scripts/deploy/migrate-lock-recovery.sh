#!/usr/bin/env bash
# migrate-lock-recovery.sh — sourced by deploy-blue-green.sh (lane-lifecycle third
# review 2026-10-22; fourth review the same day). `prisma migrate deploy` records a
# migration that FAILED as failed in _prisma_migrations, and every later
# `migrate deploy` then refuses with P3009 — even after main is reset and the
# migration file is gone — until someone runs
# `prisma migrate resolve --rolled-back <name>` on box A.
#
# A LOST LOCK WAIT is recoverable only when the migration provably applied
# nothing. Prisma 7 does NOT run a migration file as one transaction (statements
# before a failing one stay committed), so a bare 55P03 proves nothing. Recovery
# needs ALL of:
#   * P3018 + "Database error code: 55P03" + "[digby-lock-retry]" — the RAISE
#     text of the in-place lock-retry DO loop (the pattern in
#     backend/prisma/migrations/20261021120000_chat_display_parent), and
#   * the migration file carries the line "-- digby-lock-retry: atomic" (the DO
#     block is its ONLY statement; migrate-lock-recovery.test.sh lints every file
#     that claims it) — checked when MIGRATE_LOCK_MIGRATIONS_DIR is set
#     (deploy-blue-green.sh sets it to the repo's migrations dir).
#
#   migrate_deploy_with_lock_recovery <prisma command prefix…>
#     runs  <prefix> migrate deploy
#     lost lock wait (above)  → <prefix> migrate resolve --rolled-back <name>,
#                               then ONE more <prefix> migrate deploy —
#       except when the loop only WAITED behind a long lock holder ("(0 lock
#       requests" in the RAISE — pg_dump, an idle-in-transaction session, an
#       anti-wraparound autovacuum): the retry would wait behind the same holder
#       for its whole budget, so the row is resolved and the deploy fails at once
#       (fifth review 2026-10-22: two full waits ate the per-host deploy budget);
#       the NEXT deploy re-attempts.
#     P3009 (an EARLIER deploy left the row failed — a resolve that failed, or
#       the switch on) → asks the database whether EVERY unresolved failed
#       migration row's logs carry "[digby-lock-retry]" (<prefix> db execute
#       --file $MIGRATE_LOCK_PROBE_FILE, which raises "digby-lock-retry-probe:
#       eligible"); only then resolves each named migration as rolled back and
#       runs the ONE retry. NOT a deploy KILLED mid-wait: its row carries no logs
#       (the probe cannot prove it applied nothing — the orphaned server session
#       may still have added the column), so the deploy fails with a pointer to
#       the manual runbook (fifth review).
#     the retry loses its lock wait too → resolves it AGAIN before returning the
#       failure, so the database is left retryable: the NEXT deploy re-attempts
#       instead of answering P3009 (the fourth-review wedge).
#     any other failure returns at once with migrate deploy's exit code
#     (manual recovery: docs/REMOTE_OPS.md "A migration failed: P3009 / P3018").
#
# MIGRATE_LOCK_RECOVERY_DISABLED=1 | true | on runs migrate deploy once (the
# pre-2026-10-22 step) — a repo Variable forwarded by deploy.yml's Blue-green
# step, or a line in box A's /opt/crossmodel-local/deploy-flags.env.
# Pinned by scripts/deploy/migrate-lock-recovery.test.sh.

MIGRATE_LOCK_RETRY_MARKER='[digby-lock-retry]'
MIGRATE_LOCK_ATOMIC_MARKER='-- digby-lock-retry: atomic'
MIGRATE_LOCK_PROBE_TOKEN='digby-lock-retry-probe: eligible'
# The RAISE of a loop that never requested the lock (it only waited behind a long holder).
MIGRATE_LOCK_WAIT_ONLY_RE='\(0 lock requests '

migrate_lock_recovery_disabled() {
  case "$(printf '%s' "${MIGRATE_LOCK_RECOVERY_DISABLED:-}" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')" in
    1|true|on) return 0 ;;
  esac
  return 1
}

# The migration declares itself atomic (only checked when the dir is known).
_mlr_atomic() {
  [ -z "${MIGRATE_LOCK_MIGRATIONS_DIR:-}" ] && return 0
  grep -qF -- "$MIGRATE_LOCK_ATOMIC_MARKER" "${MIGRATE_LOCK_MIGRATIONS_DIR}/$1/migration.sql" 2>/dev/null
}

# $1 = a migrate deploy output file → prints the migration name when it is a lost
# lock wait of an atomic lock-retry migration; returns 1 otherwise.
_mlr_lost_lock_name() {
  local f="$1" name
  grep -q 'P3018' "$f" || return 1
  grep -Eq 'Database error code: *55P03' "$f" || return 1
  grep -qF -- "$MIGRATE_LOCK_RETRY_MARKER" "$f" || return 1
  name="$(sed -n 's/^Migration name: *\([0-9A-Za-z_.-]*\).*$/\1/p' "$f" | head -n 1)"
  [ -n "$name" ] || return 1
  _mlr_atomic "$name" || return 1
  printf '%s\n' "$name"
}

# $1 = output file, rest = the prisma prefix → runs migrate deploy; returns its exit code.
_mlr_deploy() {
  local f="$1" rc
  shift
  set +e
  "$@" migrate deploy 2>&1 | tee "$f"
  rc=${PIPESTATUS[0]}
  set -e
  return "$rc"
}

# $1 = name, rest = prefix → migrate resolve --rolled-back; returns its exit code.
_mlr_resolve() {
  local name="$1" rc
  shift
  set +e
  "$@" migrate resolve --rolled-back "$name"
  rc=$?
  set -e
  if [ "$rc" -ne 0 ]; then echo "❌ migrate resolve --rolled-back ${name} failed (exit ${rc}) — see docs/REMOTE_OPS.md"; fi
  return "$rc"
}

# rest = prefix → 0 when EVERY unresolved failed migration row is a lost lock wait.
_mlr_probe_eligible() {
  local f rc
  f="$(mktemp)"
  set +e
  "$@" db execute --file "${MIGRATE_LOCK_PROBE_FILE:-prisma/lock-recovery-probe.sql}" >"$f" 2>&1
  rc=$?
  set -e
  if [ "$rc" -ne 0 ] && grep -qF -- "$MIGRATE_LOCK_PROBE_TOKEN" "$f"; then rm -f "$f"; return 0; fi
  rm -f "$f"
  return 1
}

migrate_deploy_with_lock_recovery() {
  local out rc name names n
  out="$(mktemp)"
  _mlr_deploy "$out" "$@" && rc=0 || rc=$?
  if [ "$rc" -eq 0 ] || migrate_lock_recovery_disabled; then rm -f "$out"; return "$rc"; fi
  if name="$(_mlr_lost_lock_name "$out")"; then
    if grep -Eq "$MIGRATE_LOCK_WAIT_ONLY_RE" "$out"; then
      echo "❌ migration ${name} lost its lock wait behind a LONG lock holder only (0 lock requests — the holders are named in the error above); marking it rolled back WITHOUT a retry (the retry would wait behind the same holder); this deploy fails and the NEXT deploy re-attempts it."
      _mlr_resolve "$name" "$@" || { rc=$?; rm -f "$out"; return "$rc"; }
      rm -f "$out"
      return "$rc"
    fi
    echo "⚠️  migration ${name} lost a lock wait (55P03, ${MIGRATE_LOCK_RETRY_MARKER} — the in-place retry loop raised; nothing was applied); marking it rolled back and retrying migrate deploy ONCE"
    _mlr_resolve "$name" "$@" || { rc=$?; rm -f "$out"; return "$rc"; }
  elif grep -q 'P3009' "$out"; then
    names="$(sed -n 's/^.*The `\([0-9A-Za-z_.-]*\)` migration started at.*$/\1/p' "$out")"
    if [ -z "$names" ]; then rm -f "$out"; return "$rc"; fi
    for n in $names; do _mlr_atomic "$n" || { rm -f "$out"; return "$rc"; }; done
    if ! _mlr_probe_eligible "$@"; then
      echo "❌ P3009 on lock-retry migration(s) $(printf '%s ' $names)whose failure the probe could not prove was a lost lock wait — a deploy KILLED mid-wait leaves its row with no logs (and its orphaned server session may still have applied it). Not resolved automatically: see docs/REMOTE_OPS.md \"A migration failed: P3009 / P3018\" (killed mid-wait)."
      rm -f "$out"
      return "$rc"
    fi
    echo "⚠️  P3009: an earlier deploy left lost-lock-wait migration(s) failed ($(printf '%s ' $names)) — nothing was applied (${MIGRATE_LOCK_RETRY_MARKER}); marking them rolled back and retrying migrate deploy ONCE"
    for n in $names; do _mlr_resolve "$n" "$@" || { rc=$?; rm -f "$out"; return "$rc"; }; done
  else
    rm -f "$out"
    return "$rc"
  fi
  _mlr_deploy "$out" "$@" && rc=0 || rc=$?
  if [ "$rc" -ne 0 ] && name="$(_mlr_lost_lock_name "$out")"; then
    echo "❌ migration ${name} lost its lock wait AGAIN — marking it rolled back so the NEXT deploy re-attempts it (never a P3009 wedge); this deploy fails. The lock holders are named in the error above."
    _mlr_resolve "$name" "$@" || true
  fi
  rm -f "$out"
  return "$rc"
}
