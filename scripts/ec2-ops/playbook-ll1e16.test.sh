#!/usr/bin/env bash
# playbook-ll1e16.test.sh — pins the GATING LOGIC of the LL1E16-1103 prod one-shot block
# (scripts/ec2-ops/playbook.sh, above the `==ONE-SHOT-INSERT-POINT-PROD==` sentinel).
#
# WHY THIS EXISTS: the block runs on a live production box, once, gated on a marker, and its whole
# job is to decide whether a WRITE (CREATE INDEX CONCURRENTLY on the write-hot `activities` table)
# is allowed to fire. A wrong gate either (a) builds when the index is already there, (b) fires a
# build off a NON-READING (prodq.sh printing "no admin-backend container is running"), or (c) burns
# the marker on a partial run so the sequence never re-fires. None of those are catchable from CI by
# static means, so the block is EXTRACTED and EXECUTED here against a stubbed prodq.sh.
#
# The extraction is deliberate: the logic is tested exactly as it will run on the box (same greps,
# same rc handling, same marker idiom), so an edit to the block that breaks a gate fails HERE.
#
# The JSON shapes stubbed below are the scripts' REAL shapes, not invented:
#   ll1-activities-index.js  → out() = JSON.stringify(o)          COMPACT  → `"existing":null`
#   session-topology-migrate → console.log(JSON.stringify(r, f, 2)) PRETTY   → `"dryRun": true`
# A compact-only grep for the E16 report silently never matches — that regression is case A.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
PLAYBOOK="$REPO/scripts/ec2-ops/playbook.sh"
PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "  ok   $1"; }
bad()  { FAIL=$((FAIL+1)); echo "  FAIL $1"; }
ck()   { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (want '$3' got '$2')"; fi; }
has()  { if printf '%s' "$1" | grep -qF "$2"; then ok "$3"; else bad "$3"; fi; }
hasnt(){ if printf '%s' "$1" | grep -qF "$2"; then bad "$3"; else ok "$3"; fi; }
# has_outside <text> <needle> <label> — the needle must appear on a line that is NOT the block's
# raw `LL1-MEASURE|` echo. USE THIS, not a bare `has`, for anything the block both ECHOES and
# EXTRACTS: the echo prints the whole JSON report (with the escaped SQL) before the extraction
# runs, so a plain `has` can be satisfied by the echo alone while the extraction prints NOTHING.
# That is the exact bug this file exists for, so a plain `has` here would re-introduce it.
# Pair it with a `has ... 'LL1-MEASURE|'` control: if the block ever stopped echoing, the filter
# would have nothing to exclude and this assertion would silently stop discriminating.
has_outside() {
  if printf '%s' "$1" | grep -v 'LL1-MEASURE|' | grep -qF "$2"; then ok "$3"; else bad "$3"; fi
}

[ -f "$PLAYBOOK" ] || { echo "FATAL: $PLAYBOOK missing"; exit 1; }

# ── extract the block exactly as it runs on the box ────────────────────────────────
# range: first line naming LL1E16-1103 → the END sentinel, then the outer `fi` that closes it.
BLOCK="$(sed -n '/# ── ONE-SHOT (2026-11-03, prod): LL1E16-1103/,/== END LL1E16-1103 ==/p' "$PLAYBOOK")"
if [ -z "$BLOCK" ]; then echo "FATAL: LL1E16-1103 block not found in playbook.sh"; exit 1; fi
printf '%s\n' "$BLOCK" | grep -q 'oq_8aef3962' || { echo "FATAL: block lost its owner-go citation"; exit 1; }
# dedent the 2-space playbook body indent, close the outer if, sandbox the two host paths.
LOGIC="$(mktemp)"; trap 'rm -f "$LOGIC"' EXIT
{
  echo '#!/usr/bin/env bash'
  echo 'set -uo pipefail'
  printf '%s\n' "$BLOCK" | sed 's/^  //'
  echo 'fi'
} \
  | sed 's#/var/tmp/.digby-ll1e16-1103#"$SANDBOX_MARKER"#' \
  | sed 's#LL1E16_DIR=/opt/crossmodel/scripts/framework-audit#LL1E16_DIR="$SANDBOX_PROBE"#' \
  | sed 's#cat /opt/crossmodel/.deploy-sha#cat "$SANDBOX_SHA"#' \
  | sed 's#sudo touch "$MARKER_LL1E16"#touch "$MARKER_LL1E16"#' > "$LOGIC"
bash -n "$LOGIC" || { echo "FATAL: extracted block does not parse"; exit 1; }

mkprobe() {
  local d="$1"; rm -rf "$d"; mkdir -p "$d"
  : > "$d/ll1-activities-index.js"; : > "$d/session-topology-migrate.js"
  cat > "$d/prodq.sh" <<'EOS'
#!/usr/bin/env bash
probe="$1"; shift || true
case "$probe:$*" in
  ll1-activities-index.js:)
    case "${STUB_MODE:-absent}" in
      absent)      echo '{"table":"activities","index":"activities_userId_action_createdAt_idx","dryRun":true,"apply":false,"rows":123456,"sizeBytes":73400320,"estimateSeconds":4,"existing":null,"otherIndexes":["activities_userId_createdAt_idx"]}'; exit 0 ;;
      present)     echo '{"table":"activities","index":"activities_userId_action_createdAt_idx","dryRun":true,"apply":false,"rows":10,"sizeBytes":10,"estimateSeconds":3,"existing":{"name":"activities_userId_action_createdAt_idx","valid":true},"otherIndexes":[],"skipped":"already_present"}'; exit 0 ;;
      invalid)     echo '{"table":"activities","index":"activities_userId_action_createdAt_idx","existing":{"name":"activities_userId_action_createdAt_idx","valid":false},"refused":"invalid_index_present","next":"DROP INDEX CONCURRENTLY IF EXISTS \"activities_userId_action_createdAt_idx\";"}'; exit 1 ;;
      nocontainer) echo 'no admin-backend container is running' >&2; exit 3 ;;
    esac ;;
  ll1-activities-index.js:--apply)
    if [ "${STUB_MODE:-absent}" = "absent" ]; then
      echo '{"table":"activities","dryRun":false,"apply":true,"existing":null,"built":true,"elapsedMs":4211,"valid":true}'; exit 0
    fi
    echo '{"table":"activities","skipped":"already_present"}'; exit 0 ;;
  session-topology-migrate.js:*)
    printf '{\n  "script": "session-topology-migrate",\n  "action": "forward",\n  "apply": false,\n  "dryRun": true,\n  "lanes": 37,\n  "charterBound": 4,\n  "wouldUpdate": 12,\n  "topology": {}\n}\n'; exit 0 ;;
esac
echo "stub: unhandled $probe $*" >&2; exit 9
EOS
  chmod +x "$d/prodq.sh"
}

# run_case <mode> [drop_probe=0|1] [fake_deploy=0|1] [settled=<unset|VALUE>] — sets OUT and MARKERED
#
# SETTLE GATE DEFAULT: the block's owner-required fleet-wide gate is FAIL-CLOSED (unset = 0 = shut),
# so every case that asserts "the one-shots RUN" must opt in with settled=1. That default is the
# point of the gate, not an inconvenience: a case that forgets it goes RED instead of silently
# proving a path that production can no longer take. Cases I/J/K pin the gate itself.
#
# settled=unset passes NO LL1E16_SETTLED at all, which is the bare-shell-on-the-box shape.
run_case() {
  local SBX; SBX="$(mktemp -d)"
  mkprobe "$SBX/probe"
  [ "${2:-0}" = "1" ] && rm -f "$SBX/probe/ll1-activities-index.js"
  echo "25e56f8b0a" > "$SBX/sha"
  local FAKEPID=""
  if [ "${3:-0}" = "1" ]; then
    mkdir -p "$SBX/bin"
    printf '#!/bin/sh\nsleep 30\n' > "$SBX/bin/deploy-blue-green.sh"; chmod +x "$SBX/bin/deploy-blue-green.sh"
    "$SBX/bin/deploy-blue-green.sh" & FAKEPID=$!
  fi
  local SETTLE_ENV=("LL1E16_SETTLED=1")
  case "${4:-1}" in
    unset) SETTLE_ENV=() ;;                       # env var absent entirely
    *)     SETTLE_ENV=("LL1E16_SETTLED=${4:-1}") ;;
  esac
  OUT=$(env -u LL1E16_SETTLED SBX="$SBX" STUB_MODE="${1:-absent}" SANDBOX_PROBE="$SBX/probe" \
        SANDBOX_MARKER="$SBX/marker" SANDBOX_SHA="$SBX/sha" PATH="${SBX}/bin:$PATH" \
        "${SETTLE_ENV[@]}" bash "$LOGIC" 2>&1)
  [ -n "$FAKEPID" ] && { kill "$FAKEPID" 2>/dev/null; wait "$FAKEPID" 2>/dev/null; }
  MARKERED=$([ -f "$SBX/marker" ] && echo yes || echo no)
  rm -rf "$SBX"
}

echo "== LL1E16-1103 block gating =="

echo "-- A: index ABSENT → measure, apply, E16, marker consumed"
run_case absent 0 0
has  "$OUT" 'LL1_TARGET=absent'                 'A: measure reports absent'
has  "$OUT" 'CREATE INDEX CONCURRENTLY'         'A: apply leg ran'
has  "$OUT" '"built":true'                      'A: build confirmed'
has  "$OUT" 'elapsedMs'                         'A: actual elapsed reported'
has  "$OUT" 'dryRun": true'                     'A: E16 PRETTY json captured (spaced grep)'
has  "$OUT" 'LL1_FINAL=built'                   'A: LL1 final = built'
ck   'A: marker consumed' "$MARKERED" 'yes'

echo "-- B: index PRESENT → apply SKIPPED, E16 runs, marker consumed"
run_case present 0 0
has  "$OUT" 'LL1_TARGET=present'                'B: measure reports present'
has  "$OUT" 'APPLY SKIPPED'                     'B: apply skipped'
hasnt "$OUT" 'LL1-APPLY|'                       'B: no apply output at all'
has  "$OUT" 'LL1_FINAL=present'                 'B: LL1 final = present'
ck   'B: marker consumed' "$MARKERED" 'yes'

echo "-- C: INVALID index → refuses, E16 STILL runs (independence), marker NOT consumed"
run_case invalid 0 0
has  "$OUT" 'INVALID index'                     'C: names the invalid index'
has  "$OUT" 'dryRun": true'                     'C: E16 ran despite the LL-1 refusal'
has  "$OUT" 'LL1_FINAL=failed'                  'C: LL1 final = failed'
ck   'C: marker NOT consumed' "$MARKERED" 'no'
# ── C is the case that EXERCISED the DROP-extraction bug, and it used to pass VACUOUSLY ────────
# The block echoes the whole measure report (`LL1-MEASURE| {…"next":"DROP INDEX CONCURRENTLY…
# \"activities…\";"}`) BEFORE extracting, so a bare `DROP INDEX CONCURRENTLY` grep is satisfied by
# the ECHO even when the extraction prints NOTHING. That is exactly what happened: the extractor's
# char class excluded `"` and `\`, so it stopped dead at the first backslash of the JSON-ESCAPED
# SQL and emitted an empty line — the operator's next step was BLANK on the only path needing it —
# while this case stayed green. Pinned now on the UNESCAPED quote, which the echo cannot supply:
# the echo carries `\"activities…`, only the extracted line carries `"activities…`.
# Verified by MUTATION (restore the old char class → these two go RED), not by a green run.
DROP_WANT='IF EXISTS "activities_userId_action_createdAt_idx";'
has   "$OUT" "$DROP_WANT"                       'C: prints the EXTRACTED DROP (unescaped quote — echo cannot satisfy)'
has      "$OUT" 'LL1-MEASURE|'                  'C: control — the raw report IS echoed (has_outside has something to exclude)'
has_outside "$OUT" "$DROP_WANT"                 'C: DROP printed on a NON-echo line (the echo cannot satisfy this)'

echo "-- D: no backend container → no false absent, NO build"
run_case nocontainer 0 0
has  "$OUT" 'MEASURE FAILED'                    'D: measure flagged failed'
hasnt "$OUT" 'LL1-APPLY|'                       'D: no build fired off a non-reading'
ck   'D: marker NOT consumed' "$MARKERED" 'no'

echo "-- E: probe file missing → defers and NAMES it, nothing runs"
run_case absent 1 0
has  "$OUT" 'DEFERRED: missing'                 'E: names the missing file'
hasnt "$OUT" 'LL1-MEASURE|'                     'E: no measure ran'
ck   'E: marker NOT consumed' "$MARKERED" 'no'

echo "-- F: deploy running → WAITS for a quiet window, then proceeds (NOT an instant defer)"
# The deploy stub sleeps 30s; the wait bound is generous so the window opens and the run completes.
# settled=1 is REQUIRED here: the fleet-wide gate is authoritative and shut by default (cases I/J),
# so only a settled fleet may reach the LOCAL per-host wait this case is about.
run_case absent 0 1 1
has  "$OUT" 'WAITING: a deploy script is running' 'F: waits instead of deferring on first check'
has  "$OUT" 'WINDOW OPEN'                       'F: quiet window detected after the deploy ended'
has  "$OUT" 'LL1_TARGET=absent'                 'F: measure then runs (reading is post-wave)'
ck   'F: marker consumed' "$MARKERED" 'yes'

echo "-- H: deploy never quiets → gives up bounded, marker NOT consumed"
# A deploy stub that outlives the whole wait bound; a 1 s wait/quiet makes it fast.
SBX="$(mktemp -d)"; mkprobe "$SBX/probe"; echo x > "$SBX/sha"
mkdir -p "$SBX/bin"
printf '#!/bin/sh\nsleep 120\n' > "$SBX/bin/deploy-blue-green.sh"; chmod +x "$SBX/bin/deploy-blue-green.sh"
"$SBX/bin/deploy-blue-green.sh" & FAKEPID=$!
OUT=$(SBX="$SBX" STUB_MODE=absent SANDBOX_PROBE="$SBX/probe" SANDBOX_MARKER="$SBX/marker" SANDBOX_SHA="$SBX/sha" \
      LL1E16_SETTLED=1 LL1E16_WAIT_SECS=0 LL1E16_QUIET_SECS=45 PATH="$SBX/bin:$PATH" bash "$LOGIC" 2>&1)
kill "$FAKEPID" 2>/dev/null; wait "$FAKEPID" 2>/dev/null
MARKERED=$([ -f "$SBX/marker" ] && echo yes || echo no); rm -rf "$SBX"
has   "$OUT" 'DEFERRED: no 45s quiet window'    'H: names the give-up bound'
hasnt "$OUT" 'LL1-MEASURE|'                     'H: no measure fired into a busy box'
ck    'H: marker NOT consumed' "$MARKERED" 'no'

echo "-- G: marker present → no-op (idempotent)"
SBX="$(mktemp -d)"; mkprobe "$SBX/probe"; echo x > "$SBX/sha"; touch "$SBX/marker"
OUT=$(SBX="$SBX" STUB_MODE=absent SANDBOX_PROBE="$SBX/probe" SANDBOX_MARKER="$SBX/marker" SANDBOX_SHA="$SBX/sha" bash "$LOGIC" 2>&1)
hasnt "$OUT" 'LL1-MEASURE|'                     'G: nothing runs when marker present'
rm -rf "$SBX"

# ── THE OWNER-REQUIRED FLEET-WIDE SETTLE GATE (cases I/J/K/L) ──────────────────────────────────
# Owner's words (oq_8aef3962, 2026-11-03): "before ANY prod one-shot, re-read the deploy view and
# require shaEvidence.settled — never run the LL-1 measure or the E16 dry run mid-wave (a reading
# taken against a half-deployed fleet is not a measurement)."
# The box cannot read the deploy view (no GitHub token) and pgrep is PER-HOST (box A quiet while
# a wave still rolls box B — the real 00:29Z failure), so the RUNNER computes settled-ness and
# passes LL1E16_SETTLED. The gate MUST fail closed: any caller that does not explicitly say
# "settled" — a bare shell, a future workflow edit, a renamed output — must NOT run the writes.
echo "-- I: LL1E16_SETTLED UNSET (bare shell on the box) → CLOSED, nothing runs, marker intact"
run_case absent 0 0 unset
has   "$OUT" "DEFERRED: LL1E16_SETTLED='0'"     'I: defaults to 0 when the var is absent (fail-closed)'
has   "$OUT" 'NOT settled'                      'I: states the gate reason'
hasnt "$OUT" 'LL1-MEASURE|'                     'I: NO measure ran mid-wave'
hasnt "$OUT" 'LL1-APPLY|'                       'I: NO apply ran'
hasnt "$OUT" 'E16-DRYRUN|'                      'I: NO E16 dry run'
# Control, and it must be hasnt: the open-gate confirmation line belongs to the settled path only
# (case K asserts it APPEARS there). A `has` here would assert the opposite of the case's premise.
hasnt "$OUT" 'SETTLED: fleet deploy-settle probe' 'I: does NOT claim settled when the gate is shut'
ck    'I: marker NOT consumed' "$MARKERED" 'no'

echo "-- J: LL1E16_SETTLED=0 (wave in flight) → CLOSED, nothing runs, marker intact"
run_case absent 0 0 0
has   "$OUT" "DEFERRED: LL1E16_SETTLED='0'"     'J: an explicit 0 also closes the gate'
hasnt "$OUT" 'LL1-MEASURE|'                     'J: NO measure ran'
hasnt "$OUT" 'E16-DRYRUN|'                      'J: NO E16 dry run'
ck    'J: marker NOT consumed' "$MARKERED" 'no'
# A non-"1" value must NOT open it: this is the rename/typo class ('true', 'yes', '1 ').
for v in yes true '1 '; do
  run_case absent 0 0 "$v"
  hasnt "$OUT" 'LL1-MEASURE|'                   "J: settled='$v' does NOT open the gate (only the literal 1 does)"
done

echo "-- K: LL1E16_SETTLED=1 (settled) → the FULL sequence runs"
run_case absent 0 0 1
has   "$OUT" 'SETTLED: fleet deploy-settle probe' 'K: prints the settled confirmation'
has   "$OUT" 'LL1_TARGET=absent'                'K: measure ran'
has   "$OUT" 'CREATE INDEX CONCURRENTLY'        'K: apply leg ran'
has   "$OUT" 'E16-DRYRUN|'                      'K: E16 dry run ran'
ck    'K: marker consumed' "$MARKERED" 'yes'

echo "-- L: gate CLOSED + a deploy running → does NOT burn the quiet-window wait"
# The gate is authoritative, so a closed block must return AT ONCE rather than poll 480 s for a
# window it cannot use (and must not stack a misleading 'no quiet window' deferral on the real
# reason). LL1E16_WAIT_SECS is large here on purpose: if the wait were (wrongly) entered, this
# case would hang for minutes instead of passing in seconds.
SBX="$(mktemp -d)"; mkprobe "$SBX/probe"; echo x > "$SBX/sha"
mkdir -p "$SBX/bin"
printf '#!/bin/sh\nsleep 120\n' > "$SBX/bin/deploy-blue-green.sh"; chmod +x "$SBX/bin/deploy-blue-green.sh"
"$SBX/bin/deploy-blue-green.sh" & FAKEPID=$!
L_START=$SECONDS
OUT=$(env -u LL1E16_SETTLED SBX="$SBX" STUB_MODE=absent SANDBOX_PROBE="$SBX/probe" SANDBOX_MARKER="$SBX/marker" \
      SANDBOX_SHA="$SBX/sha" LL1E16_WAIT_SECS=480 PATH="$SBX/bin:$PATH" bash "$LOGIC" 2>&1)
L_TOOK=$((SECONDS - L_START))
kill "$FAKEPID" 2>/dev/null; wait "$FAKEPID" 2>/dev/null
MARKERED=$([ -f "$SBX/marker" ] && echo yes || echo no); rm -rf "$SBX"
hasnt "$OUT" 'WAITING: a deploy script is running' 'L: never enters the quiet-window poll when the gate is shut'
hasnt "$OUT" 'no 45s quiet window'              'L: does NOT stack a misleading give-up deferral'
ck    'L: returns immediately (<20s, no 480s poll)' "$([ "$L_TOOK" -lt 20 ] && echo fast || echo slow)" 'fast'
ck    'L: marker NOT consumed' "$MARKERED" 'no'

echo
echo "passed=$PASS failed=$FAIL"
[ "$FAIL" = "0" ]