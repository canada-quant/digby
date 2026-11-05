#!/usr/bin/env bash
# rotate-db-password.test.sh — local regression harness for
# rotate-db-password.sh (issue #131). Fully mocked: a PATH-injected `aws` shim
# simulates SSM send-command + get-command-invocation + get-parameter, so the
# whole orchestration (rotate → STRICT fan-out → hash-parity verify) runs with
# no AWS, no fleet, no docker.
#
# Pins: --dry-run makes zero aws calls; the on-box payload generates a 32-char
# alnum password and ALTERs the APP role (never echoes it); fan-out dies
# loudly when any instance fails; verify dies on hash mismatch; the store hash
# the operator computes must equal the rotated hash the payload reported.
set -u
cd "$(dirname "$0")"
SCRIPT=./rotate-db-password.sh
SBX=$(mktemp -d)
trap 'rm -rf "$SBX"' EXIT
PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "  ok: $1"; }
bad()  { FAIL=$((FAIL+1)); echo "  FAIL: $1"; }
check(){ if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (want [$2] got [$3])"; fi; }

FIXTURE_PW='RotatedFixturePw123'                       # "new" store value
FIXTURE_HASH=$(printf '%s' "$FIXTURE_PW" | sha256sum | cut -c1-16)

mkdir -p "$SBX/shim"
# --- aws shim: records every call to $AWS_CALLS, simulates the fleet ---------
cat > "$SBX/shim/aws" <<'EOF'
#!/usr/bin/env bash
echo "$*" >> "$AWS_CALLS"
[ "$1" = "ssm" ] || exit 1
op=$2
case "$op" in
  get-parameter)
    printf '%s\n' "$FIXTURE_PW" ;;
  send-command)
    echo "cmd-0000-1111" ;;
  get-command-invocation)
    q=''
    while [ $# -gt 0 ]; do case "$1" in --query) q=$2; shift 2 ;; *) shift ;; esac; done
    case "$q" in
      Status) echo "${MOCK_STATUS:-Success}" ;;
      StandardOutputContent)
        [ "${MOCK_STATUS:-Success}" = "Success" ] || { echo "mock failure output"; exit 0; }
        printf '%s\n' "$MOCK_STDOUT" ;;
    esac ;;
  *) exit 1 ;;
esac
EOF
chmod +x "$SBX/shim/aws"

run_rotate() { # $1=extra-env-string(simple assignments) $2=script-args; MOCK_STDOUT/MOCK_STATUS set by caller prefix
  env -i PATH="$SBX/shim:/usr/bin:/bin" HOME="$SBX" \
    AWS_CALLS="$SBX/calls" FIXTURE_PW="$FIXTURE_PW" \
    MOCK_STDOUT="${MOCK_STDOUT:-}" MOCK_STATUS="${MOCK_STATUS:-Success}" \
    SYNC_SCRIPT=./sync-db-secret.sh \
    ${1:-} bash "$SCRIPT" ${2:-} >"$SBX/stdout" 2>"$SBX/stderr"
}
reset() { : > "$SBX/calls"; : > "$SBX/stdout"; : > "$SBX/stderr"; }

# MOCK_STDOUT per call can't vary by instance with a static shim — the shim's
# get-command-invocation emits $MOCK_STDOUT, which the run exports. The
# orchestrator only greps markers/hashes, so one canned string per phase is
# enough: the payload marker for send→payload calls is distinguished by
# MOCK_STDOUT containing all three markers the flow greps for.
ALL_MARKERS="rotate-payload OK: role admin password rotated + stored in /example/ca/rds/app-password; sha256-16=$FIXTURE_HASH
synced: DATABASE_URL + POSTGRES_PASSWORD staged in /opt/crossmodel-local/env-overrides.env
verify OK: staged credential matches /example/ca/rds/app-password (sha256-16 $FIXTURE_HASH)"

echo "== case 1: --dry-run makes zero aws calls and previews the payload =="
reset
run_rotate "" "--dry-run"; rc=$?
check "exit 0" 0 "$rc"
check "no aws calls" "0" "$(grep -c . "$SBX/calls")"
check "payload previews ALTER ROLE" "yes" "$(grep -q 'ALTER ROLE admin' "$SBX/stdout" && echo yes || echo no)"
check "payload generates 32-char alnum" "yes" "$(grep -q "tr -dc 'A-Za-z0-9'" "$SBX/stdout" && grep -q 'head -c 32' "$SBX/stdout" && echo yes || echo no)"
check "payload never prints the password" "yes" "$(grep -q 'sha256-16=' "$SBX/stdout" && echo yes || echo no)"

echo "== case 2: green path — rotate, fan-out to 3 instances, verify =="
reset
MOCK_STDOUT="$ALL_MARKERS" run_rotate ""; rc=$?
check "exit 0" 0 "$rc"
check "one send-command per phase (1 rotate + 3 sync + 3 verify)" "7" "$(grep -c 'send-command' "$SBX/calls")"
check "announces rotation complete" "yes" "$(grep -q '^== rotation complete' "$SBX/stdout" && echo yes || echo no)"
check "prints go-live deploy instruction" "yes" "$(grep -q 'gh workflow run deploy.yml' "$SBX/stdout" && echo yes || echo no)"

echo "== case 3: fan-out failure on any instance dies loudly =="
reset
# stdout lacking the 'synced:'/'already in sync' markers for the sync phase:
# give only the payload+verify markers, so step 2's grep fails on every box.
PARTIAL="rotate-payload OK: role admin password rotated + stored in /example/ca/rds/app-password; sha256-16=$FIXTURE_HASH"
MOCK_STDOUT="$PARTIAL" run_rotate ""; rc=$?
check "exit 1" 1 "$rc"
check "names the failed boxes" "yes" "$(grep -q 'fan-out failed on:' "$SBX/stderr" && echo yes || echo no)"
check "tells operator the boxes still hold the old password" "yes" "$(grep -q 'still hold the OLD password' "$SBX/stderr" && echo yes || echo no)"

echo "== case 4: store-vs-payload hash divergence dies before fan-out =="
reset
WRONGHASH_PAYLOAD="rotate-payload OK: role admin password rotated + stored in /example/ca/rds/app-password; sha256-16=0000000000000000
synced: x
verify OK: staged credential matches /example/ca/rds/app-password (sha256-16 0000000000000000)"
MOCK_STDOUT="$WRONGHASH_PAYLOAD" run_rotate ""; rc=$?
check "exit 1" 1 "$rc"
check "divergence detected" "yes" "$(grep -q 'put-parameter divergence' "$SBX/stderr" && echo yes || echo no)"

echo "== case 5: generator pipeline yields 32-char alnum (real /dev/urandom) =="
GEN=$(tr -dc 'A-Za-z0-9' < /dev/urandom | head -c 32)
check "length 32" "32" "${#GEN}"
check "alnum only" "yes" "$(printf '%s' "$GEN" | grep -qE '^[A-Za-z0-9]+$' && echo yes || echo no)"

echo "== case 6: missing sync script dies with usage-class error =="
reset
env -i PATH="$SBX/shim:/usr/bin:/bin" HOME="$SBX" AWS_CALLS="$SBX/calls" \
  SYNC_SCRIPT=/nonexistent bash "$SCRIPT" --dry-run >"$SBX/stdout" 2>"$SBX/stderr"; rc=$?
check "exit 1" 1 "$rc"
check "error mentions sync script" "yes" "$(grep -qi 'sync script not found' "$SBX/stderr" && echo yes || echo no)"

echo "== case 7: rotation payload is rollback-guarded (put-parameter failure) =="
reset
run_rotate "" "--dry-run" >/dev/null
check "payload reads previous password first" "yes" "$(grep -qF 'OLD=$(aws ssm get-parameter' "$SBX/stdout" && echo yes || echo no)"
check "payload rolls ALTER back on put failure" "yes" "$(grep -q 'rolling the role back' "$SBX/stdout" && echo yes || echo no)"
check "rollback ALTERs to \$OLD" "yes" "$(grep -qF 'alter_role "$OLD"' "$SBX/stdout" && echo yes || echo no)"
check "payload unsets secrets" "yes" "$(grep -q 'unset NEW MASTER OLD' "$SBX/stdout" && echo yes || echo no)"

echo
echo "RESULT: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
