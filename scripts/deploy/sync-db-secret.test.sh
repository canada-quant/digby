#!/usr/bin/env bash
# sync-db-secret.test.sh — local regression harness for sync-db-secret.sh
# (issue #131). PATH-injected shims fake `aws` (SSM get-parameter) and `sudo`
# (ticket-18787730 root-owned file scenarios); no AWS, root, or network needed.
#
# Pins: RFC-3986 userinfo encoding, endpoint resolution order (store param →
# staged URL), merge semantics (no clobber of unrelated keys), idempotence,
# STRICT vs warn-only failure paths, MODE=verify hash parity, and the OUTPUT
# CONTRACT (secret values — raw or encoded — never reach stdout/stderr).
set -u
cd "$(dirname "$0")"
SCRIPT=./sync-db-secret.sh
SBX=$(mktemp -d)
trap 'rm -rf "$SBX"' EXIT
PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "  ok: $1"; }
bad()  { FAIL=$((FAIL+1)); echo "  FAIL: $1"; }
check(){ if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (want [$2] got [$3])"; fi; }

# --- independent reference encoder (assertion side only) --------------------
ref_urlencode() {
  local s=$1 i c h o=''
  for (( i=0; i<${#s}; i++ )); do
    c=${s:i:1}
    case "$c" in
      [a-zA-Z0-9._~-]) o+="$c" ;;
      *) printf -v h '%%%02X' "'$c"; o+="$h" ;;
    esac
  done
  printf '%s' "$o"
}

PW_FIX='Sup3r@Secret!x%:+ /~.-_Zz09'   # exercises every encoding class
ENC_FIX=$(LC_ALL=C ref_urlencode "$PW_FIX")

# --- shims -------------------------------------------------------------------
mkdir -p "$SBX/shim"
real_cat=$(command -v cat); real_install=$(command -v install); real_test=$(command -v test)

cat > "$SBX/shim/aws" <<'EOF'
#!/usr/bin/env bash
# fake aws: only `ssm get-parameter --name N ...`. FIXTURE_AWS_FAIL=1 → error.
[ "${FIXTURE_AWS_FAIL:-0}" = "1" ] && { echo "aws: could not reach ssm" >&2; exit 1; }
[ "$1 $2" = "ssm get-parameter" ] || { echo "aws-shim: unsupported: $*" >&2; exit 1; }
name=''
while [ $# -gt 0 ]; do case "$1" in --name) name=$2; shift 2 ;; *) shift ;; esac; done
case "$name" in
  /example/ca/rds/app-password) [ "${FIXTURE_PW+set}" = "set" ] && printf '%s\n' "$FIXTURE_PW" || exit 1 ;;
  /example/ca/rds/endpoint)     [ "${FIXTURE_EP+set}" = "set" ] && printf '%s\n' "$FIXTURE_EP" || exit 1 ;;
  *) exit 1 ;;
esac
EOF

# cat shim: PROTECT=1 denies the protected overrides file (root-owned sim).
cat > "$SBX/shim/cat" <<EOF
#!/usr/bin/env bash
if [ "\${PROTECT:-0}" = "1" ] && [ "\$1" = "$SBX/overrides.env" ]; then
  echo "cat: \$1: Permission denied" >&2; exit 1
fi
exec "$real_cat" "\$@"
EOF

# install shim: PROTECT=1 denies writing the protected file as the plain user.
cat > "$SBX/shim/install" <<EOF
#!/usr/bin/env bash
for a in "\$@"; do last=\$a; done
if [ "\${PROTECT:-0}" = "1" ] && [ "\$last" = "$SBX/overrides.env" ]; then
  echo "install: cannot create regular file '\$last': Permission denied" >&2; exit 1
fi
exec "$real_install" "\$@"
EOF

# fake 'sudo tee' — simulates root writing to an unwritable file (a rootless
# sandbox can't really escalate: as the owner we chmod +w, write, restore).
cat > "$SBX/shim/faketee" <<'EOF'
#!/usr/bin/env bash
f=$1
tmp=$(mktemp); cat > "$tmp"
chmod u+w "$f" 2>/dev/null || true
cat "$tmp" > "$f"
chmod a-w "$f" 2>/dev/null || true
rm -f "$tmp"
EOF

# fake docker: 'info' → OK (enables the VALIDATE live-auth path); 'run … psql'
# → authenticate the PGPASSWORD from -e against FIXTURE_PW (rejects everything
# when MOCK_DOCKER_AUTH_FAIL=1, simulating a bogus store value;
# MOCK_DOCKER_UNAVAIL=1 simulates the check being UNAVAILABLE — connection
# refused, the firing-37 prod signature on box A/C). MOCK_DOCKER_BRIDGE_BLOCKED=1
# simulates box A's default docker bridge (no route to RDS — 2026-10-22 probe
# PGD1022: bridge "no response", host network "accepting connections"): a run
# without --network host times out.
cat > "$SBX/shim/docker" <<'EOF'
#!/usr/bin/env bash
case "$1" in
  info) exit 0 ;;
  run)
    if [ "${MOCK_DOCKER_BRIDGE_BLOCKED:-0}" = "1" ]; then
      net=''; prev=''
      for a in "$@"; do
        case "$prev" in --network) net=$a ;; esac
        case "$a" in --network=*) net=${a#--network=} ;; esac
        prev=$a
      done
      [ "$net" = "host" ] || { echo "psql: error: connection to server at \"db.example.com\" (10.0.0.1), port 5432 failed: timeout expired" >&2; exit 2; }
    fi
    [ "${MOCK_DOCKER_AUTH_FAIL:-0}" = "1" ] && { echo "psql: FATAL: password authentication failed" >&2; exit 1; }
    [ "${MOCK_DOCKER_UNAVAIL:-0}" = "1" ] && { echo "psql: error: connection to server at \"db.example.com\" (10.0.0.1), port 5432 failed: Connection refused" >&2; exit 1; }
    pw=''; prev=''
    for a in "$@"; do
      case "$prev" in -e) case "$a" in PGPASSWORD=*) pw=${a#PGPASSWORD=} ;; esac ;; esac
      prev=$a
    done
    [ "$pw" = "$FIXTURE_PW" ] || { echo "psql: FATAL: password authentication failed" >&2; exit 1; }
    echo 1; exit 0 ;;
  *) exit 1 ;;
esac
EOF

# sudo shim: runs only when SUDO_OK=1; strips protection (acts as root).
cat > "$SBX/shim/sudo" <<EOF
#!/usr/bin/env bash
[ "\$1" = "-n" ] && shift
if [ "\${SUDO_OK:-0}" != "1" ]; then
  echo "sudo: a password is required" >&2; exit 1
fi
case "\$1" in
  test) shift; exec "$real_test" "\$@" ;;
  cat) shift; PROTECT=0 exec "$real_cat" "\$@" ;;
  install) shift; PROTECT=0 exec "$real_install" "\$@" ;;
  mkdir) shift; PROTECT=0 exec /bin/mkdir "\$@" ;;
  tee) shift; PROTECT=0 exec "$SBX/shim/faketee" "\$@" ;;
  docker) shift; PROTECT=0 exec "$SBX/shim/docker" "\$@" ;;
  *) echo "sudo-shim: unsupported: \$1" >&2; exit 1 ;;
esac
EOF
chmod +x "$SBX/shim/"*

run_sync() { # $1=extra-env-string (simple assignments) → rc; stdout in $SBX/stdout, stderr in $SBX/stderr.
  # FXPW/FXEP (caller prefix) override the store fixtures — required for
  # values with newlines, which cannot survive $1 word-splitting.
  [ -n "${FXEP+x}" ] && FIXTURE_EP=$FXEP
  env -i PATH="$SBX/shim:/usr/bin:/bin" HOME="$SBX" \
    OVERRIDES_FILE="$SBX/overrides.env" \
    FIXTURE_PW="${FXPW:-$PW_FIX}" ${FIXTURE_EP+FIXTURE_EP="$FIXTURE_EP"} \
    $1 bash "$SCRIPT" >"$SBX/stdout" 2>"$SBX/stderr"
}

reset() { rm -f "$SBX/overrides.env"; : > "$SBX/stdout"; : > "$SBX/stderr"; unset FIXTURE_EP FXEP FXPW; PROTECT=0; SUDO_OK=1; FIXTURE_AWS_FAIL=0; }

echo "== case 1: happy path — endpoint param, special-char password encoded =="
reset
FIXTURE_EP='db.example.com:5432/admin_db?sslmode=require'
printf 'OTHER_KEY=keepme\n' > "$SBX/overrides.env"
run_sync ""; rc=$?
check "exit 0" 0 "$rc"
check "stdout announces sync" "yes" "$(grep -q '^synced:' "$SBX/stdout" && echo yes || echo no)"
check "DATABASE_URL staged encoded" \
  "DATABASE_URL=postgresql://admin:$ENC_FIX@db.example.com:5432/admin_db?sslmode=require" \
  "$(grep '^DATABASE_URL=' "$SBX/overrides.env")"
check "POSTGRES_PASSWORD staged raw" "POSTGRES_PASSWORD=$PW_FIX" "$(grep '^POSTGRES_PASSWORD=' "$SBX/overrides.env")"
check "unrelated key preserved" "keepme" "$(grep '^OTHER_KEY=' "$SBX/overrides.env" | cut -d= -f2)"
check "raw secret never in stdout" "absent" "$(grep -qF "$PW_FIX" "$SBX/stdout" && echo PRESENT || echo absent)"
check "encoded secret never in stdout" "absent" "$(grep -qF "$ENC_FIX" "$SBX/stdout" && echo PRESENT || echo absent)"
check "raw secret never in stderr" "absent" "$(grep -qF "$PW_FIX" "$SBX/stderr" && echo PRESENT || echo absent)"
check "hash line present" "yes" "$(grep -q 'pw-sha256-16=' "$SBX/stdout" && echo yes || echo no)"

echo "== case 2: idempotent — second run is a no-op =="
run_sync ""; rc=$?
check "exit 0" 0 "$rc"
check "reports already in sync" "yes" "$(grep -q '^already in sync:' "$SBX/stdout" && echo yes || echo no)"

echo "== case 3: no endpoint param — derived from staged URL, query preserved =="
reset
printf 'DATABASE_URL=postgresql://admin:oldpw@db-old.internal:5544/admin_db?sslmode=verify-full&application_name=digby\n' > "$SBX/overrides.env"
run_sync ""; rc=$?
check "exit 0" 0 "$rc"
check "endpoint + query preserved" \
  "DATABASE_URL=postgresql://admin:$ENC_FIX@db-old.internal:5544/admin_db?sslmode=verify-full&application_name=digby" \
  "$(grep '^DATABASE_URL=' "$SBX/overrides.env")"

echo "== case 4: endpoint param overrides staged URL host =="
reset
FIXTURE_EP='db-new:5433/otherdb'
printf 'DATABASE_URL=postgresql://admin:oldpw@db-old:5432/admin_db\n' > "$SBX/overrides.env"
run_sync ""; rc=$?
check "exit 0" 0 "$rc"
check "param endpoint staged" \
  "DATABASE_URL=postgresql://admin:$ENC_FIX@db-new:5433/otherdb" \
  "$(grep '^DATABASE_URL=' "$SBX/overrides.env")"

echo "== case 5: store unreachable — non-strict warns, exit 0, file untouched =="
reset
FIXTURE_AWS_FAIL=1
printf 'DATABASE_URL=postgresql://admin:oldpw@db-old:5432/admin_db\n' > "$SBX/overrides.env"
run_sync "FIXTURE_AWS_FAIL=1"; rc=$?
check "exit 0" 0 "$rc"
check "warning printed" "yes" "$(grep -q '^WARNING(sync-db-secret)' "$SBX/stderr" && echo yes || echo no)"
check "file untouched" "DATABASE_URL=postgresql://admin:oldpw@db-old:5432/admin_db" "$(grep '^DATABASE_URL=' "$SBX/overrides.env")"

echo "== case 6: store unreachable — STRICT exits 1, file untouched =="
run_sync "FIXTURE_AWS_FAIL=1 STRICT=1"; rc=$?
check "exit 1" 1 "$rc"
check "error printed" "yes" "$(grep -q '^ERROR(sync-db-secret)' "$SBX/stderr" && echo yes || echo no)"
check "file untouched" "DATABASE_URL=postgresql://admin:oldpw@db-old:5432/admin_db" "$(grep '^DATABASE_URL=' "$SBX/overrides.env")"

echo "== case 7: no endpoint anywhere — non-strict warns; STRICT dies =="
reset
run_sync ""; rc=$?
check "non-strict exit 0" 0 "$rc"
check "warns about missing endpoint" "yes" "$(grep -qi 'endpoint' "$SBX/stderr" && echo yes || echo no)"
run_sync "STRICT=1"; rc=$?
check "strict exit 1" 1 "$rc"

echo "== case 8: MODE=verify — parity then mismatch after tamper =="
reset
FIXTURE_EP='db.example.com:5432/admin_db'
printf 'OTHER_KEY=keepme\n' > "$SBX/overrides.env"
run_sync "" >/dev/null; rc=$?
check "setup sync ok" 0 "$rc"
run_sync "MODE=verify"; rc=$?
check "verify exit 0" 0 "$rc"
check "verify OK line" "yes" "$(grep -q '^verify OK:' "$SBX/stdout" && echo yes || echo no)"
sed -i 's|^DATABASE_URL=.*|DATABASE_URL=postgresql://admin:tampered@db.example.com:5432/admin_db|' "$SBX/overrides.env"
run_sync "MODE=verify"; rc=$?
check "verify mismatch exit 1" 1 "$rc"
check "mismatch reported" "yes" "$(grep -q '^verify MISMATCH' "$SBX/stderr" && echo yes || echo no)"

echo "== case 9: root-owned overrides file — sudo install path =="
reset
FIXTURE_EP='db.example.com:5432/admin_db'
printf 'DATABASE_URL=postgresql://admin:oldpw@db-old:5432/admin_db\n' > "$SBX/overrides.env"
chmod 600 "$SBX/overrides.env"
run_sync "PROTECT=1 SUDO_OK=1"; rc=$?
check "exit 0" 0 "$rc"
check "staged despite protection" \
  "DATABASE_URL=postgresql://admin:$ENC_FIX@db.example.com:5432/admin_db" \
  "$(grep '^DATABASE_URL=' "$SBX/overrides.env")"

echo "== case 9b: genuinely non-writable file — sudo tee path; denied without sudo =="
reset
FIXTURE_EP='db.example.com:5432/admin_db'
printf 'DATABASE_URL=postgresql://admin:oldpw@db-old:5432/admin_db\n' > "$SBX/overrides.env"
chmod 444 "$SBX/overrides.env"
run_sync "SUDO_OK=1"; rc=$?
check "exit 0 via sudo tee" 0 "$rc"
check "staged via sudo tee" \
  "DATABASE_URL=postgresql://admin:$ENC_FIX@db.example.com:5432/admin_db" \
  "$(grep '^DATABASE_URL=' "$SBX/overrides.env")"
check "mode preserved (444)" "444" "$(stat -c %a "$SBX/overrides.env")"
chmod u+w "$SBX/overrides.env"
printf 'DATABASE_URL=postgresql://admin:oldpw@db-old:5432/admin_db\n' > "$SBX/overrides.env"
chmod 444 "$SBX/overrides.env"
run_sync "SUDO_OK=0"; rc=$?
check "non-strict warn exit 0 without sudo" 0 "$rc"
check "file untouched without sudo" "DATABASE_URL=postgresql://admin:oldpw@db-old:5432/admin_db" "$(grep '^DATABASE_URL=' "$SBX/overrides.env")"
run_sync "SUDO_OK=0 STRICT=1"; rc=$?
check "STRICT exit 1 without sudo" 1 "$rc"

echo "== case 10: fresh box — no overrides file at all =="
reset
FIXTURE_EP='db.example.com:5432/admin_db'
run_sync ""; rc=$?
check "exit 0" 0 "$rc"
check "file created mode 600" "600" "$(stat -c %a "$SBX/overrides.env")"
check "DATABASE_URL staged" \
  "DATABASE_URL=postgresql://admin:$ENC_FIX@db.example.com:5432/admin_db" \
  "$(grep '^DATABASE_URL=' "$SBX/overrides.env")"

echo "== case 11: newline in store password rejected (env-injection guard) =="
reset
FIXTURE_EP='db.example.com:5432/admin_db'
printf 'DATABASE_URL=postgresql://admin:oldpw@db-old:5432/admin_db\n' > "$SBX/overrides.env"
NL_PW=$(printf 'line1pw\nJWT_SECRET=injected')
FXPW="$NL_PW" run_sync ""; rc=$?
check "non-strict exit 0" 0 "$rc"
check "newline warning" "yes" "$(grep -qi 'single-line' "$SBX/stderr" && echo yes || echo no)"
check "file untouched" "DATABASE_URL=postgresql://admin:oldpw@db-old:5432/admin_db" "$(grep '^DATABASE_URL=' "$SBX/overrides.env")"
check "no injected key staged" "absent" "$(grep -q '^JWT_SECRET=' "$SBX/overrides.env" && echo PRESENT || echo absent)"
FXPW="$NL_PW" run_sync "STRICT=1"; rc=$?
check "STRICT exit 1" 1 "$rc"

echo "== case 12: newline in endpoint param rejected =="
reset
NL_EP=$(printf 'db.example.com:5432/admin_db\nEXTRA=line')
FXEP="$NL_EP" run_sync ""; rc=$?
check "non-strict exit 0" 0 "$rc"
check "newline warning" "yes" "$(grep -qi 'single-line' "$SBX/stderr" && echo yes || echo no)"
check "no overrides file created" "absent" "$([ -e "$SBX/overrides.env" ] && echo PRESENT || echo absent)"

echo "== case 13: last-@ parsing — legacy raw-@ URL endpoint fallback + verify =="
reset
LEG_PW='Leg@cyPass'
LEG_ENC='Leg%40cyPass'
printf 'DATABASE_URL=postgresql://admin:Leg@cyPass@realhost.example.com:5432/admin_db\n' > "$SBX/overrides.env"
FXPW="$LEG_PW" run_sync ""; rc=$?   # no FIXTURE_EP → derive from staged URL
check "exit 0" 0 "$rc"
check "endpoint derived after LAST @, password re-encoded" \
  "DATABASE_URL=postgresql://admin:$LEG_ENC@realhost.example.com:5432/admin_db" \
  "$(grep '^DATABASE_URL=' "$SBX/overrides.env")"
printf 'DATABASE_URL=postgresql://admin:Leg@cyPass@realhost.example.com:5432/admin_db\n' > "$SBX/overrides.env"
FXPW="$LEG_PW" run_sync "MODE=verify"; rc=$?
check "verify raw-@ staged URL exit 0" 0 "$rc"

echo "== case 14: VALIDATE live-auth guard — bogus store value REFUSED =="
reset
FIXTURE_EP='db.example.com:5432/admin_db'
printf 'DATABASE_URL=postgresql://admin:oldpw@db-old:5432/admin_db\n' > "$SBX/overrides.env"
run_sync "MOCK_DOCKER_AUTH_FAIL=1 SUDO_OK=1"; rc=$?
check "non-strict refusal exit 0" 0 "$rc"
check "REJECTED warning" "yes" "$(grep -qi 'REJECTED' "$SBX/stderr" && echo yes || echo no)"
check "rejected even though it names the check" "yes" "$(grep -qi 'live.auth check' "$SBX/stderr" && echo yes || echo no)"
check "file untouched" "DATABASE_URL=postgresql://admin:oldpw@db-old:5432/admin_db" "$(grep '^DATABASE_URL=' "$SBX/overrides.env")"
run_sync "MOCK_DOCKER_AUTH_FAIL=1 SUDO_OK=1 STRICT=1"; rc=$?
check "STRICT refusal exit 1" 1 "$rc"
run_sync "MOCK_DOCKER_AUTH_FAIL=1 SUDO_OK=1 VALIDATE=0"; rc=$?
check "VALIDATE=0 bypass stages" "yes" "$(grep -qF "DATABASE_URL=postgresql://admin:$ENC_FIX@db.example.com:5432/admin_db" "$SBX/overrides.env" && echo yes || echo no)"

echo "== case 15: FO firing 37 — check UNAVAILABLE but already in sync = quiet no-op =="
reset
FIXTURE_EP='db.example.com:5432/admin_db'
run_sync "SUDO_OK=1" >/dev/null; rc=$?   # stage the good credential
check "setup sync ok" 0 "$rc"
run_sync "MOCK_DOCKER_UNAVAIL=1 SUDO_OK=1"; rc=$?
check "unavailable+in-sync exit 0" 0 "$rc"
check "already in sync reported" "yes" "$(grep -q '^already in sync:' "$SBX/stdout" && echo yes || echo no)"
check "NO warning on the chronic path" "absent" "$(grep -q 'WARNING(sync-db-secret)' "$SBX/stderr" && echo PRESENT || echo absent)"
run_sync "MOCK_DOCKER_UNAVAIL=1 SUDO_OK=1 STRICT=1"; rc=$?
check "unavailable+in-sync STRICT also exit 0 (parity proven by idempotence)" 0 "$rc"

echo "== case 16: check UNAVAILABLE and NOT in sync = refuses to stage the new value =="
reset
FIXTURE_EP='db.example.com:5432/admin_db'
printf 'DATABASE_URL=postgresql://admin:oldpw@db-old:5432/admin_db\n' > "$SBX/overrides.env"
run_sync "MOCK_DOCKER_UNAVAIL=1 SUDO_OK=1"; rc=$?
check "unavailable+dirty exit 0 (non-strict)" 0 "$rc"
check "UNAVAILABLE warning" "yes" "$(grep -qi 'UNAVAILABLE' "$SBX/stderr" && echo yes || echo no)"
check "file untouched" "DATABASE_URL=postgresql://admin:oldpw@db-old:5432/admin_db" "$(grep '^DATABASE_URL=' "$SBX/overrides.env")"
run_sync "MOCK_DOCKER_UNAVAIL=1 SUDO_OK=1 STRICT=1"; rc=$?
check "unavailable+dirty STRICT exit 1" 1 "$rc"
check "refusal names refused-vs-unavailable" "yes" "$(grep -qi 'UNAVAILABLE' "$SBX/stderr" && echo yes || echo no)"

echo "== case 17: box A's default bridge cannot reach RDS — the check runs on the host network =="
reset
FIXTURE_EP='db.example.com:5432/admin_db'
printf 'DATABASE_URL=postgresql://admin:oldpw@db-old:5432/admin_db\n' > "$SBX/overrides.env"
run_sync "MOCK_DOCKER_BRIDGE_BLOCKED=1 SUDO_OK=1 STRICT=1"; rc=$?
check "bridge-blocked box still validates (exit 0)" 0 "$rc"
check "validated line printed" "yes" "$(grep -q 'validated: store credential authenticates' "$SBX/stdout" && echo yes || echo no)"
check "new credential staged" "yes" "$(grep -qF "DATABASE_URL=postgresql://admin:$ENC_FIX@db.example.com:5432/admin_db" "$SBX/overrides.env" && echo yes || echo no)"
reset
FIXTURE_EP='db.example.com:5432/admin_db'
printf 'DATABASE_URL=postgresql://admin:oldpw@db-old:5432/admin_db\n' > "$SBX/overrides.env"
run_sync "MOCK_DOCKER_BRIDGE_BLOCKED=1 SUDO_OK=1 PSQL_DOCKER_NETWORK=bridge"; rc=$?
check "PSQL_DOCKER_NETWORK=bridge restores the bridge run (UNAVAILABLE, non-strict exit 0)" 0 "$rc"
check "bridge override reports UNAVAILABLE" "yes" "$(grep -qi 'UNAVAILABLE' "$SBX/stderr" && echo yes || echo no)"

echo
echo "RESULT: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
