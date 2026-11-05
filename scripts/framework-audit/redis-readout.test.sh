#!/usr/bin/env bash
# redis-readout.test.sh — pins for the evict flat-check section of redis-readout.sh
# (FO f115 bake, 31st f64: the cross-firing evicted_keys flat-comparison baked as a
# computed verdict instead of a by-eye state-file comparison).
# No network: REDIS_CLI is overridden with a shim serving canned INFO output; the
# baseline lives in a temp file. Pins: seed (no_baseline → baseline seeded), flat,
# ok (small delta, baseline refreshed), escalate (bar crossed, baseline KEPT so the
# delta stays meaningful), unavailable (no_data), kill switch (section skipped).
set -u
cd "$(dirname "$0")"
SBX=$(mktemp -d); trap 'rm -rf "$SBX"' EXIT
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ok: $1"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL: $1"; }

run_readout() { # run_readout <evicted> [extra env]
  local evicted="$1"; shift
  REDIS_CLI="bash $SBX/redis-shim.sh $evicted" \
  REDIS_EVICT_BASELINE="$SBX/baseline" \
  bash ./redis-readout.sh > "$SBX/out" 2>"$SBX/err"
}
grep_out() { grep -F "$1" "$SBX/out" >/dev/null; }
base_is() { [ "$(cat "$SBX/baseline" 2>/dev/null)" = "$1" ]; }

cat > "$SBX/redis-shim.sh" <<'SHIM'
#!/usr/bin/env bash
# serves INFO for any subcommand; $1 = the evicted_keys value to report
ev="$1"
case "$3" in
  memory) printf 'used_memory_human:60M\r\nmaxmemory_human:256M\r\nmaxmemory_policy:allkeys-lru\r\n';;
  stats)  printf 'evicted_keys:%s\r\nexpired_keys:29031\r\nkeyspace_hits:1\r\nkeyspace_misses:2\r\n' "$ev";;
  server) printf 'uptime_in_seconds:100\r\n';;
  *) : ;;
esac
SHIM
chmod +x "$SBX/redis-shim.sh"

echo "seed: no baseline -> no_baseline, seeded"
rm -f "$SBX/baseline"
run_readout 109
if grep_out "evicted_now:109 baseline:none delta:- verdict:no_baseline (seeded 109)" && base_is 109; then ok seed; else bad seed; cat "$SBX/out"; fi

echo "flat: delta <= 0"
run_readout 109
if grep_out "evicted_now:109 baseline:109 delta:0 verdict:flat (bar 20)" && base_is 109; then ok flat; else bad flat; cat "$SBX/out"; fi

echo "ok: small positive delta refreshes the baseline"
run_readout 114
if grep_out "evicted_now:114 baseline:109 delta:5 verdict:ok (bar 20)" && base_is 114; then ok ok-refresh; else bad ok-refresh; cat "$SBX/out"; fi

echo "escalate: delta >= bar keeps the old baseline"
run_readout 140
if grep_out "evicted_now:140 baseline:114 delta:26 verdict:escalate (bar 20)" && base_is 114; then ok escalate-keeps-baseline; else bad escalate-keeps-baseline; cat "$SBX/out"; fi

echo "no_data: shim serves no stats line"
REDIS_CLI="bash $SBX/redis-shim.sh ''" REDIS_EVICT_BASELINE="$SBX/baseline" \
  bash ./redis-readout.sh > "$SBX/out" 2>/dev/null
if grep_out "evicted_now:unavailable verdict:no_data"; then ok no_data; else bad no_data; cat "$SBX/out"; fi

echo "kill switch: EVICT_FLAT_CHECK_DISABLED=1 skips the section"
rm -f "$SBX/baseline"
EVICT_FLAT_CHECK_DISABLED=1 REDIS_CLI="bash $SBX/redis-shim.sh 109" \
  REDIS_EVICT_BASELINE="$SBX/baseline" bash ./redis-readout.sh > "$SBX/out" 2>/dev/null
if ! grep_out "evict flat-check" && [ ! -e "$SBX/baseline" ]; then ok kill-switch; else bad kill-switch; cat "$SBX/out"; fi

echo "pre-existing sections still print"
run_readout 109
if grep_out "=== memory" && grep_out "=== stats" && grep_out "=== keyspace" && grep_out "=== uptime_s"; then ok legacy-sections; else bad legacy-sections; cat "$SBX/out"; fi

echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
