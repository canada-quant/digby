#!/usr/bin/env bash
# apply-env-overrides.test.sh — scripted repro of the root-owned
# env-overrides.env permission state (ticket 18787730, acceptance 1).
#
# Simulates the three read scenarios with PATH-injected shims (no real root
# needed): plain-readable, root-owned (plain cat fails, sudo -n cat works),
# and fully-unreadable (both fail → step must die LOUDLY, not silently).
# Also pins the secrecy contract: fixture secret values never reach stdout.
set -u
cd "$(dirname "$0")"
SCRIPT=./apply-env-overrides.sh
SBX=$(mktemp -d)
trap 'rm -rf "$SBX"' EXIT
PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "  ok: $1"; }
bad()  { FAIL=$((FAIL+1)); echo "  FAIL: $1"; }
check(){ if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (want [$2] got [$3])"; fi; }

# --- sandbox fixture -------------------------------------------------------
mkdir -p "$SBX/shim"
cat > "$SBX/env" <<'EOF'
EXISTING_KEY=old_value
OTHER_KEY=keepme
EOF
cat > "$SBX/overrides.env" <<'EOF'
# comment line

EXISTING_KEY=new_value
FRESH_KEY=fresh_secret_xyz
EOF

real_cat=$(command -v cat)
# Shim: cat fails on the "protected" file when PROTECT=1, works otherwise.
cat > "$SBX/shim/cat" <<EOF
#!/usr/bin/env bash
if [ "\${PROTECT:-0}" = "1" ] && [ "\$1" = "$SBX/overrides.env" ]; then
  echo "cat: \$1: Permission denied" >&2; exit 1
fi
exec "$real_cat" "\$@"
EOF
# Shim: sudo -n <cmd> runs cmd only when SUDO_OK=1 (and PROTECT=1 still reads).
cat > "$SBX/shim/sudo" <<EOF
#!/usr/bin/env bash
[ "\$1" = "-n" ] && shift
if [ "\${SUDO_OK:-0}" != "1" ]; then
  echo "sudo: a password is required" >&2; exit 1
fi
if [ "\$1" = "test" ]; then shift; exec /usr/bin/test "\$@"; fi
if [ "\$1" = "cat" ]; then shift; PROTECT=0 exec "$real_cat" "\$@"; fi
exit 1
EOF
chmod +x "$SBX/shim/cat" "$SBX/shim/sudo"

run_step() { # PROTECT=$1 SUDO_OK=$2
  PROTECT="$1" SUDO_OK="$2" PATH="$SBX/shim:$PATH" \
    OVERRIDES_FILE="$SBX/overrides.env" ENV_FILE="$SBX/env" \
    bash "$SCRIPT" 2>"$SBX/stderr" >"$SBX/stdout"
}

reset_env() {
  printf 'EXISTING_KEY=old_value\nOTHER_KEY=keepme\n' > "$SBX/env"
}

# The count lines alone (the 2026-10-19 divergence report adds ::warning:: /
# redundant lines — pinned by their own case at the end).
counts() { grep -v -e '^::warning::' -e '^box-local env overrides identical' "$SBX/stdout"; }

echo "== case 1: readable overrides apply (baseline) =="
reset_env; run_step 0 1; rc=$?
check "exit 0" 0 "$rc"
check "count-only output" "applied 2 env override(s)" "$(counts)"
check "existing key replaced" "new_value" "$(grep '^EXISTING_KEY=' "$SBX/env" | cut -d= -f2)"
check "fresh key appended" "fresh_secret_xyz" "$(grep '^FRESH_KEY=' "$SBX/env" | cut -d= -f2)"
check "unrelated key preserved" "keepme" "$(grep '^OTHER_KEY=' "$SBX/env" | cut -d= -f2)"
if grep -q "fresh_secret_xyz\|new_value" "$SBX/stdout"; then bad "secrecy: value leaked to stdout"; else ok "secrecy: no values on stdout"; fi

echo "== case 2: ROOT-OWNED overrides (plain read denied, sudo works) — the incident =="
reset_env; run_step 1 1; rc=$?
check "exit 0 despite root-owned file" 0 "$rc"
check "still applied via sudo fallback" "applied 2 env override(s)" "$(counts)"
check "value landed" "fresh_secret_xyz" "$(grep '^FRESH_KEY=' "$SBX/env" | cut -d= -f2)"

echo "== case 3: fully unreadable (plain AND sudo denied) — must fail LOUDLY =="
reset_env; run_step 1 0; rc=$?
if [ "$rc" -ne 0 ]; then ok "non-zero exit ($rc)"; else bad "expected non-zero exit"; fi
if grep -q "unreadable" "$SBX/stderr" && grep -q "chown ubuntu:ubuntu" "$SBX/stderr"; then
  ok "actionable error on stderr"
else
  bad "missing actionable error (got: $(cat "$SBX/stderr"))"
fi
check "no silent partial apply" "old_value" "$(grep '^EXISTING_KEY=' "$SBX/env" | cut -d= -f2)"

echo "== case 4: absent file — clean skip (documented contract) =="
rm -f "$SBX/overrides.env"; reset_env; run_step 0 0; rc=$?
check "exit 0" 0 "$rc"
check "skip message" "no box-local env overrides" "$(cat "$SBX/stdout")"

echo "== case 5: review regressions (PR #308 findings) =="
# 5a: no trailing newline — the final line must still apply (old loop dropped it)
printf 'EXISTING_KEY=old_value\nOTHER_KEY=keepme\n' > "$SBX/env"
printf 'FIRST_KEY=one\nLAST_KEY=two' > "$SBX/overrides.env"
run_step 0 1; rc=$?
check "exit 0 (no trailing newline)" 0 "$rc"
check "newline-less final line counted" "applied 2 env override(s)" "$(cat "$SBX/stdout")"
check "LAST_KEY landed" "two" "$(grep '^LAST_KEY=' "$SBX/env" | cut -d= -f2)"

# 5b: backslashes in values survive literally (\n \t \1 are NOT reinterpreted by sed)
reset_env
printf 'BS_KEY=path\\nseg\\tend\\1x\n' > "$SBX/overrides.env"
run_step 0 1; rc=$?
check "exit 0 (backslash value)" 0 "$rc"
check "backslashes preserved verbatim" 'BS_KEY=path\nseg\tend\1x' "$(grep '^BS_KEY=' "$SBX/env")"

# 5c: regex-metachar key (A.B) is refused LOUDLY — never rewrites AXB=/A_B=
printf 'AXB=original\nA_B=original2\n' > "$SBX/env"
printf 'A.B=injected\n' > "$SBX/overrides.env"
run_step 0 1; rc=$?
if [ "$rc" -ne 0 ]; then ok "metachar key -> non-zero exit ($rc)"; else bad "metachar key accepted (rc=0)"; fi
if grep -q "invalid env key" "$SBX/stderr"; then ok "actionable key error on stderr"; else bad "missing key error (got: $(cat "$SBX/stderr"))"; fi
check "unrelated AXB= untouched" "original" "$(grep '^AXB=' "$SBX/env" | cut -d= -f2)"
check "unrelated A_B= untouched" "original2" "$(grep '^A_B=' "$SBX/env" | cut -d= -f2)"

# 6: deploy-managed seat secrets file (2026-09-25, box C): folded in FIRST,
# box-local overrides still win; absent file is silent (web boxes).
printf 'EXISTING_KEY=old_value\n' > "$SBX/env"
printf 'EXISTING_KEY=from_secret\nTYPESAFE_API_KEY=ts_secret_value\n' > "$SBX/secrets.env"
printf 'EXISTING_KEY=new_value\n' > "$SBX/overrides.env"
PROTECT=0 SUDO_OK=1 PATH="$SBX/shim:$PATH" SECRETS_FILE="$SBX/secrets.env" OVERRIDES_FILE="$SBX/overrides.env" ENV_FILE="$SBX/env" \
  bash "$SCRIPT" 2>"$SBX/stderr" >"$SBX/stdout"; rc=$?
check "secrets: exit 0" 0 "$rc"
check "secrets: seat key appended from the secrets file" "ts_secret_value" "$(grep '^TYPESAFE_API_KEY=' "$SBX/env" | cut -d= -f2)"
check "secrets: box-local override still wins" "new_value" "$(grep '^EXISTING_KEY=' "$SBX/env" | cut -d= -f2)"
check "secrets: two count-only lines" "applied 2 deploy-managed seat secret(s)|applied 1 env override(s)" "$(counts | paste -sd'|')"
if grep -q "ts_secret_value" "$SBX/stdout"; then bad "secrecy: seat secret leaked to stdout"; else ok "secrecy: seat secret never on stdout"; fi
rm -f "$SBX/secrets.env"
run_step 0 1; rc=$?
check "secrets absent: silent, overrides message unchanged" "applied 1 env override(s)" "$(counts)"

# 7: one-time purge of model-provider key overrides (2026-10-12 credential
# rotation). Stale key lines leave the overrides file once per box, the
# rotated secret wins, other overrides survive, a marker stops a second purge
# (a key staged through env_override afterwards is honoured), values never echo.
rm -f "$SBX"/.override-purge-*
printf 'MOONSHOT_API_KEY=new_rotated_secret\nOTHER_KEY=keepme\n' > "$SBX/env"
printf 'MOONSHOT_API_KEY=stale_leaked_key\nZAI_API_KEY=stale_zai_key\nREDIS_URL=redis://box-a\n' > "$SBX/overrides.env"
run_step 0 1; rc=$?
check "purge: exit 0" 0 "$rc"
check "purge: count-only lines" "purged 2 stale model-key override line(s) (2026-10-12-model-keys)|applied 1 env override(s)" "$(counts | paste -sd'|')"
check "purge: rotated secret wins in .env" "new_rotated_secret" "$(grep '^MOONSHOT_API_KEY=' "$SBX/env" | cut -d= -f2)"
check "purge: stale ZAI key never applied" "" "$(grep '^ZAI_API_KEY=' "$SBX/env")"
check "purge: non-key override kept in file" "REDIS_URL=redis://box-a" "$(cat "$SBX/overrides.env")"
check "purge: marker written" "yes" "$([ -e "$SBX/.override-purge-2026-10-12-model-keys" ] && echo yes || echo no)"
if grep -q "stale_leaked_key\|stale_zai_key\|new_rotated_secret" "$SBX/stdout" "$SBX/stderr"; then bad "purge: secrecy (value echoed)"; else ok "purge: secrecy (no values echoed)"; fi
printf 'MOONSHOT_API_KEY=staged_after_purge\n' > "$SBX/overrides.env"
run_step 0 1; rc=$?
check "purge: second run honours a later-staged key" "staged_after_purge" "$(grep '^MOONSHOT_API_KEY=' "$SBX/env" | cut -d= -f2)"
check "purge: second run prints no purge line" "applied 1 env override(s)" "$(counts)"
rm -f "$SBX"/.override-purge-*


# 8: one-time purge #2 (2026-10-20) of overrides the GitHub secrets own.
# Authoritative keys (CODING_EGRESS_SECRET) leave the overrides file once the
# deployed env carries a non-empty value; match-only keys (the Google set)
# leave ONLY when identical to the deployed value — a differing box copy (the
# live value while the secret catches up) is kept and named; a key with no
# secret value is kept; anything kept retries next deploy; the kill switch
# skips it; values never echo.
echo "== case: secret-owned override purge (2026-10-20) =="
rm -f "$SBX"/.override-purge-*
touch "$SBX/.override-purge-2026-10-12-model-keys"   # isolate from purge #1
sorun() { PROTECT=0 SUDO_OK=1 PATH="$SBX/shim:$PATH" SECRETS_FILE="${1:-$SBX/none.env}" OVERRIDES_FILE="$SBX/overrides.env" ENV_FILE="$SBX/env" bash "$SCRIPT" 2>"$SBX/stderr" >"$SBX/stdout"; }
printf 'CODING_EGRESS_SECRET=from_github_secret_aa\nGOOGLE_OAUTH_CLIENT_ID=typo_in_secret_bb\nGOOGLE_TOKEN_ENCRYPTION_KEY=same_key_ii\nOTHER_KEY=keepme\n' > "$SBX/env"
printf 'CODING_EGRESS_SECRET=box_a_stale_pepper_cc\nGOOGLE_OAUTH_CLIENT_ID=live_client_dd\nGOOGLE_TOKEN_ENCRYPTION_KEY=same_key_ii\nGOOGLE_MCP_API_KEY=no_secret_yet_ee\nREDIS_URL=redis://box-a\n' > "$SBX/overrides.env"
sorun; rc=$?
check "secret-owned: exit 0" 0 "$rc"
check "secret-owned: drops the authoritative key + the identical match-only key" "1" "$(grep -c '^purged 2 box-local override line(s) the GitHub secrets own (2026-10-20-secret-owned): CODING_EGRESS_SECRET GOOGLE_TOKEN_ENCRYPTION_KEY$' "$SBX/stdout")"
check "secret-owned: names the key kept for want of a secret" "1" "$(grep -c '^kept box-local override(s) with no deployed secret value yet (2026-10-20-secret-owned): GOOGLE_MCP_API_KEY$' "$SBX/stdout")"
check "secret-owned: names the match-only key that differs" "1" "$(grep -c 'that differ from the GitHub secret.*(2026-10-20-secret-owned): GOOGLE_OAUTH_CLIENT_ID$' "$SBX/stdout")"
check "secret-owned: the GitHub value wins for the authoritative key" "from_github_secret_aa" "$(grep '^CODING_EGRESS_SECRET=' "$SBX/env" | cut -d= -f2)"
check "secret-owned: a differing match-only box value stays live" "live_client_dd" "$(grep '^GOOGLE_OAUTH_CLIENT_ID=' "$SBX/env" | cut -d= -f2)"
check "secret-owned: kept key still applied" "no_secret_yet_ee" "$(grep '^GOOGLE_MCP_API_KEY=' "$SBX/env" | cut -d= -f2)"
check "secret-owned: file keeps the kept keys + unrelated lines" "GOOGLE_OAUTH_CLIENT_ID=live_client_dd|GOOGLE_MCP_API_KEY=no_secret_yet_ee|REDIS_URL=redis://box-a" "$(paste -sd'|' "$SBX/overrides.env")"
check "secret-owned: no marker while a key is kept (retries next deploy)" "no" "$([ -e "$SBX/.override-purge-2026-10-20-secret-owned" ] && echo yes || echo no)"
if grep -q "from_github_secret_aa\|box_a_stale_pepper_cc\|typo_in_secret_bb\|live_client_dd\|same_key_ii\|no_secret_yet_ee" "$SBX/stdout" "$SBX/stderr"; then bad "secret-owned: secrecy (value echoed)"; else ok "secret-owned: secrecy (no values echoed)"; fi
# The owner fixes the secret and adds the missing one: both clear, the marker lands.
printf 'GOOGLE_OAUTH_CLIENT_ID=live_client_dd\nGOOGLE_MCP_API_KEY=no_secret_yet_ee\nOTHER_KEY=keepme\n' > "$SBX/env"
sorun; rc=$?
check "secret-owned: retry drops keys once the secret matches / exists" "1" "$(grep -c '^purged 2 box-local override line(s) the GitHub secrets own (2026-10-20-secret-owned): GOOGLE_OAUTH_CLIENT_ID GOOGLE_MCP_API_KEY$' "$SBX/stdout")"
check "secret-owned: marker written once nothing is kept" "yes" "$([ -e "$SBX/.override-purge-2026-10-20-secret-owned" ] && echo yes || echo no)"
# The coding box: the secret lives in env-secrets.env, not .env.
rm -f "$SBX/.override-purge-2026-10-20-secret-owned"
printf 'OTHER_KEY=keepme\n' > "$SBX/env"
printf 'CODING_EGRESS_SECRET=coding_box_secret_gg\n' > "$SBX/secrets.env"
printf 'CODING_EGRESS_SECRET=stale_on_c_hh\n' > "$SBX/overrides.env"
sorun "$SBX/secrets.env"; rc=$?
check "secret-owned: coding box — the secrets-file value counts" "coding_box_secret_gg" "$(grep '^CODING_EGRESS_SECRET=' "$SBX/env" | cut -d= -f2)"
rm -f "$SBX/secrets.env" "$SBX/.override-purge-2026-10-20-secret-owned"
# Kill switch: nothing purged, the override still wins.
printf 'CODING_EGRESS_SECRET=from_github_secret_aa\n' > "$SBX/env"
printf 'CODING_EGRESS_SECRET=box_a_stale_pepper_cc\n' > "$SBX/overrides.env"
SECRET_OWNED_OVERRIDE_PURGE_DISABLED=1 sorun; rc=$?
check "secret-owned: kill switch keeps the override" "box_a_stale_pepper_cc" "$(grep '^CODING_EGRESS_SECRET=' "$SBX/env" | cut -d= -f2)"
check "secret-owned: kill switch prints no purge line" "0" "$(grep -c 'secret-owned' "$SBX/stdout")"
rm -f "$SBX"/.override-purge-*

echo "== case: divergence report (2026-10-19) — names diverging keys, never values =="
printf 'EXISTING_KEY=old_value\nOTHER_KEY=keepme\n' > "$SBX/env"
printf 'EXISTING_KEY=pinned_value_zz\nOTHER_KEY=keepme\nNEW_ONLY_KEY=fresh_only_qq\n' > "$SBX/overrides.env"
PROTECT=0 SUDO_OK=1 PATH="$SBX/shim:$PATH" SECRETS_FILE="$SBX/none.env" OVERRIDES_FILE="$SBX/overrides.env" ENV_FILE="$SBX/env" \
  bash "$SCRIPT" 2>"$SBX/stderr" >"$SBX/stdout"; rc=$?
check "divergence: exit 0" 0 "$rc"
check "divergence: one ::warning:: naming exactly the diverging key" "1" "$(grep -c '^::warning::.*BEAT the GitHub secrets for: EXISTING_KEY —' "$SBX/stdout")"
check "divergence: identical override reported redundant" "1" "$(grep -c 'redundant, safe to delete): OTHER_KEY$' "$SBX/stdout")"
if grep -q 'NEW_ONLY_KEY' "$SBX/stdout"; then bad "divergence: a key absent from the deployed env is not a divergence"; else ok "divergence: a key absent from the deployed env is not reported"; fi
if grep -q "pinned_value_zz\|old_value\|fresh_only_qq\|keepme" "$SBX/stdout" "$SBX/stderr"; then bad "divergence: secrecy (value echoed)"; else ok "divergence: secrecy (no values echoed)"; fi
check "divergence: override still applied" "pinned_value_zz" "$(grep '^EXISTING_KEY=' "$SBX/env" | cut -d= -f2)"

echo
echo "RESULT: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
