#!/usr/bin/env bash
# playbook-saa16-arm.test.sh — harness for the SAA16-ARM one-shot in playbook.sh.
#
# WHY THIS EXISTS: the block runs ONCE on a live production box, gated on a /var/tmp
# marker, and its whole job is to write ONE line into the box-local env-overrides file.
# A typo in the VALUE is the dangerous failure and it is silent: the switch is
# TRI-STATE (platform/async-tool-calls.ts asyncToolCallsMode) —
#   'apply' / 'rewrite'  → ARMED      (what this block must stage)
#   '1' / 'true' / 'on' → OFF        (the KILL SWITCH — arms nothing)
#   unset / junk        → 'observe'  (shadow; applied:false, hands nothing off)
# so staging '1' would look like success in the run log while making the Phase-3b gate
# permanently unobservable, and staging junk would leave it in observe. Neither is
# catchable from CI by reading the diff. This harness executes the block exactly as it
# runs on the box, against a sandboxed overrides file, and asserts the write.
#
# It ALSO pins the fleet-settle gate (owner rule: never run a prod one-shot mid-wave),
# on all three legs: settled → arm; unsettled but locally quiet → arm via the bounded
# fallback; unsettled and a deploy script running → DEFER without consuming the marker.
#
# Same shape as playbook-ll1e16.test.sh: extract the block verbatim from playbook.sh,
# dedent it, sandbox every host path, and run it. No network, no docker, no real sudo.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")" || exit 1
PLAYBOOK="./playbook.sh"
[ -f "$PLAYBOOK" ] || { echo "FATAL: $PLAYBOOK missing"; exit 1; }

FAILED=0
ck() { # label, actual, expected
  if [ "$2" = "$3" ]; then printf '  ok   %-46s %s\n' "$1" "$2"
  else printf '  FAIL %-46s got=%s want=%s\n' "$1" "$2" "$3"; FAILED=$((FAILED+1)); fi
}

# ── extract the block exactly as it runs on the box ────────────────────────────────
# The END of the range is the `# ── /SAA16-ARM ──` close marker, NOT the
# `== END SAA16-ARM ==` echo: the marker consume (`sudo touch "$MARKER_SAA16ARM"`) sits
# after that echo, so ending the range on the echo silently drops it — the block would
# then re-fire forever, which looks like a passing test right up until it re-stages on a
# live box. The close marker is unambiguous and always the last line of the block.
BLOCK="$(sed -n '/# ── ONE-SHOT (2026-11-04saa16-arm, coding-c)/,/── \/SAA16-ARM ──/p' "$PLAYBOOK")"
if [ -z "$BLOCK" ]; then echo "FATAL: SAA16-ARM block not found in playbook.sh"; exit 1; fi
printf '%s\n' "$BLOCK" | grep -q 'ASYNC_TOOL_CALLS_DISABLED=apply' \
  || { echo "FATAL: block no longer stages the ARMING value 'apply'"; exit 1; }

# The block must live INSIDE the coding-c role branch — box C is the coding plane
# (workspace volume, docker-proxy, worker). Arming on a web box would change the
# CHAT loop, which this todo does not charter.
CC_LINE=$(grep -n 'if \[ "\$ROLE" = "coding-c" \]' "$PLAYBOOK" | cut -d: -f1 | head -1)
CC_END=$(grep -n 'coding-c-section done' "$PLAYBOOK" | cut -d: -f1 | head -1)
ARM_LINE=$(grep -n '# ── ONE-SHOT (2026-11-04saa16-arm, coding-c)' "$PLAYBOOK" | cut -d: -f1 | head -1)
[ -n "$CC_LINE" ] && [ -n "$ARM_LINE" ] && [ "$ARM_LINE" -gt "$CC_LINE" ] \
  || { echo "FATAL: SAA16-ARM is not inside the coding-c branch"; exit 1; }
[ -n "$CC_END" ] && [ "$ARM_LINE" -lt "$CC_END" ] \
  || { echo "FATAL: SAA16-ARM sits past the coding-c section end"; exit 1; }
echo "-- placement: inside coding-c (branch $CC_LINE, block $ARM_LINE, end $CC_END)"

SBX=$(mktemp -d); trap 'rm -rf "$SBX"' EXIT
mkdir -p "$SBX/bin"
# sudo → pass-through; docker/hostname/date/pgrep → deterministic stubs.
cat > "$SBX/bin/sudo" <<'EOS'
#!/usr/bin/env bash
exec "$@"
EOS
cat > "$SBX/bin/docker" <<'EOS'
#!/usr/bin/env bash
# `docker ps --format '{{.Names}}'` lists one worker; `docker exec <c> sh -c ...` echoes
# the LIVE value the sandbox's folded env carries (SANDBOX_LIVE controls it).
if [ "$1" = "ps" ]; then echo "admin-worker-green"; exit 0; fi
if [ "$1" = "exec" ]; then echo "ASYNC_TOOL_CALLS_DISABLED=${SANDBOX_LIVE:-<unset>}"; exit 0; fi
exit 0
EOS
printf '#!/usr/bin/env bash\necho sandbox-c\n' > "$SBX/bin/hostname"
# pgrep stub: exit 0 (a deploy script IS running) when SANDBOX_DEPLOY_RUNNING=1.
cat > "$SBX/bin/pgrep" <<'EOS'
#!/usr/bin/env bash
[ "${SANDBOX_DEPLOY_RUNNING:-0}" = "1" ] && exit 0
exit 1
EOS
chmod +x "$SBX/bin/"*

# Rewrite the block's host paths to sandbox paths and run it.
mklogic() {
  {
    echo '#!/usr/bin/env bash'
    echo 'set -uo pipefail'
    printf '%s\n' "$BLOCK" | sed 's/^  //'
    # NOTE: NO closing `fi` is appended. The extract range now ends at the
    # `# ── /SAA16-ARM ──` close marker, which sits AFTER both `fi`s, so the block is
    # already balanced; appending one more makes the extracted script fail to parse
    # ("syntax error near unexpected token `fi'"). This is the mirror-image of the bug
    # this harness shipped its first draft with (a range ending on the sentinel ECHO
    # truncated the marker-consume line and needed the synthesized `fi`).
  } | sed "s#/var/tmp/.digby-saa16-arm#$SBX/marker#g" \
    | sed "s#F=/opt/crossmodel-local/env-overrides.env#F=$SBX/overrides.env#" \
    | sed "s#/opt/crossmodel-local/env-overrides.env#$SBX/overrides.env#g" \
    | sed "s#/opt/crossmodel/.env#$SBX/folded.env#g"
}
LOGIC="$SBX/logic.sh"; mklogic > "$LOGIC"
bash -n "$LOGIC" || { echo "FATAL: extracted block does not parse"; exit 1; }

# SAA16_QUIET_WAIT_SECS is forced small so the fallback poll can never sleep for minutes
# inside CI. SANDBOX_LIVE / SANDBOX_DEPLOY_RUNNING / LL1E16_SETTLED are the three inputs.
runblock() {
  PATH="$SBX/bin:$PATH" \
  SAA16_QUIET_WAIT_SECS="${SAA16_QUIET_WAIT_SECS:-0}" \
  SAA16_QUIET_SECS="${SAA16_QUIET_SECS:-0}" \
  LL1E16_SETTLED="${LL1E16_SETTLED:-}" \
  SANDBOX_LIVE="${SANDBOX_LIVE:-}" \
  SANDBOX_DEPLOY_RUNNING="${SANDBOX_DEPLOY_RUNNING:-0}" \
  bash "$LOGIC"
}
reset_sbx() { rm -f "$SBX/marker"; : > "$SBX/overrides.env"; : > "$SBX/folded.env"; }

echo "-- A: settled fleet → stages the ARMING value, consumes the marker"
reset_sbx
OUT=$(LL1E16_SETTLED=1 runblock 2>&1); echo "$OUT" | sed 's/^/     /'
ck 'A: overrides carries =apply'          "$(grep -h '^ASYNC_TOOL_CALLS_DISABLED=' "$SBX/overrides.env")"  'ASYNC_TOOL_CALLS_DISABLED=apply'
ck 'A: value is NOT the kill switch'      "$(grep -c '^ASYNC_TOOL_CALLS_DISABLED=1$' "$SBX/overrides.env")" '0'
ck 'A: marker consumed'                   "$([ -f "$SBX/marker" ] && echo yes || echo no)" 'yes'
ck 'A: printed the live worker value'     "$(echo "$OUT" | grep -c 'live admin-worker-green')" '1'
ck 'A: reports fold PENDING'              "$(echo "$OUT" | grep -c 'fold is still PENDING')" '1'

echo "-- B: marker present → block SKIPPED (never re-writes a staged key)"
printf 'ASYNC_TOOL_CALLS_DISABLED=apply\n' > "$SBX/overrides.env"
OUT=$(LL1E16_SETTLED=1 runblock 2>&1)
ck 'B: no re-run'                         "$(echo "$OUT" | grep -c 'SAA16-ARM host=')" '0'
ck 'B: file untouched'                    "$(grep -h '^ASYNC_TOOL_CALLS_DISABLED=' "$SBX/overrides.env")" 'ASYNC_TOOL_CALLS_DISABLED=apply'

echo "-- C: an existing KILL-SWITCH line is REPLACED, not appended (sed-update path)"
reset_sbx
printf 'ASYNC_TOOL_CALLS_DISABLED=1\nOTHER_KEY=keepme\n' > "$SBX/overrides.env"
LL1E16_SETTLED=1 runblock >/dev/null 2>&1
ck 'C: replaced in place'                 "$(grep -h '^ASYNC_TOOL_CALLS_DISABLED=' "$SBX/overrides.env")" 'ASYNC_TOOL_CALLS_DISABLED=apply'
ck 'C: exactly one such line'             "$(grep -c '^ASYNC_TOOL_CALLS_DISABLED=' "$SBX/overrides.env")" '1'
ck 'C: neighbouring key preserved'        "$(grep -h '^OTHER_KEY=' "$SBX/overrides.env")" 'OTHER_KEY=keepme'

echo "-- D: an already-armed worker reports the value (fold DONE, not pending)"
reset_sbx
OUT=$(LL1E16_SETTLED=1 SANDBOX_LIVE=apply runblock 2>&1)
# Assert the LIVE-WORKER line specifically: a bare grep for the value matches three
# lines (staged / overrides / live) and would pass even if the worker still read
# <unset>, which is the one fact this check exists to establish.
ck 'D: live line shows apply'             "$(echo "$OUT" | grep 'live admin-worker-green' | grep -c 'ASYNC_TOOL_CALLS_DISABLED=apply')" '1'
ck 'D: live line not <unset>'             "$(echo "$OUT" | grep 'live admin-worker-green' | grep -c '<unset>')" '0'

echo "-- E: UNSETTLED → DEFER without consuming the marker (owner settle rule honoured)"
reset_sbx
OUT=$(LL1E16_SETTLED=0 runblock 2>&1); echo "$OUT" | sed 's/^/     /'
ck 'E: nothing staged'                    "$(grep -c '^ASYNC_TOOL_CALLS_DISABLED=' "$SBX/overrides.env")" '0'
ck 'E: marker NOT consumed'               "$([ -f "$SBX/marker" ] && echo yes || echo no)" 'no'
ck 'E: named the owner rule'              "$(echo "$OUT" | grep -c 'not a measurement')" '1'
ck 'E: told us how to re-fire'            "$(echo "$OUT" | grep -c 'workflow_dispatch')" '1'
ck 'E: no settle=1 arm path taken'        "$(echo "$OUT" | grep -c 'SETTLED: deploy view')" '0'

echo "-- F: UNSET default (bare shell on the box) is CLOSED, fail-closed → DEFER"
reset_sbx
OUT=$(runblock 2>&1)
ck 'F: nothing staged'                    "$(grep -c '^ASYNC_TOOL_CALLS_DISABLED=' "$SBX/overrides.env")" '0'
ck 'F: marker NOT consumed'               "$([ -f "$SBX/marker" ] && echo yes || echo no)" 'no'
ck 'F: DEFERRED emitted'                  "$(echo "$OUT" | grep -c 'DEFERRED:')" '4'

echo "-- G: a DEFERRED run leaves the marker free, so a later settled run ARMS"
reset_sbx
LL1E16_SETTLED=0 runblock >/dev/null 2>&1
ck 'G: still unarmed after defer'         "$([ -f "$SBX/marker" ] && echo yes || echo no)" 'no'
LL1E16_SETTLED=1 runblock >/dev/null 2>&1
ck 'G: arms on the later settled run'     "$(grep -h '^ASYNC_TOOL_CALLS_DISABLED=' "$SBX/overrides.env")" 'ASYNC_TOOL_CALLS_DISABLED=apply'
ck 'G: marker consumed then'              "$([ -f "$SBX/marker" ] && echo yes || echo no)" 'yes'

if [ "$FAILED" -ne 0 ]; then echo "FAILED: $FAILED check(s)"; exit 1; fi
echo "ALL PASS"