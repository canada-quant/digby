#!/bin/bash
# redis-readout.sh — READ-ONLY Redis readout on the box that hosts admin-redis-prod (box A).
# Memory/eviction stats, key counts by namespace, worktree-snapshot sizes, live run locks.
# Usage: bash /opt/crossmodel/scripts/framework-audit/redis-readout.sh
set -uo pipefail
# Env knobs (override for tests; defaults are the production values):
#   REDIS_CLI              — the redis-cli invocation (default: the prod container)
#   REDIS_EVICT_BASELINE   — baseline file path (default: /var/tmp/redis-evict-baseline)
#   EVICT_DELTA_ESCALATE   — evictions-since-last-firing bar (default: 20)
R="${REDIS_CLI:-sudo docker exec admin-redis-prod redis-cli}"
BASELINE="${REDIS_EVICT_BASELINE:-/var/tmp/redis-evict-baseline}"
EVICT_DELTA_ESCALATE="${EVICT_DELTA_ESCALATE:-20}"
echo "=== memory"; $R INFO memory | grep -E "^(used_memory_human|used_memory_peak_human|maxmemory_human|maxmemory_policy|mem_fragmentation_ratio)" | tr -d "\r"
echo "=== stats"; $R INFO stats | grep -E "^(evicted_keys|expired_keys|keyspace_hits|keyspace_misses)" | tr -d "\r"
# evict flat-check (FO f115 bake, 31st f64): the operator used to compare evicted_keys
# against the previous firing's state-file number BY EYE every 4 h; the comparison now
# bakes here. The baseline is seeded on first run and refreshed every non-escalate run
# (escalate KEEPS the old baseline so the delta stays meaningful until it is adjudicated).
# Kill switch: EVICT_FLAT_CHECK_DISABLED=1 restores the pre-f115 readout (section skipped).
if [ -z "${EVICT_FLAT_CHECK_DISABLED:-}" ]; then
  echo "=== evict flat-check"
  ev_now="$($R INFO stats | grep -E '^evicted_keys:' | tr -dc '0-9')"
  if [ -z "$ev_now" ]; then
    echo "evicted_now:unavailable verdict:no_data"
  else
    ev_base="$(tr -dc '0-9' < "$BASELINE" 2>/dev/null || true)"
    if [ -z "$ev_base" ]; then
      echo "$ev_now" > "$BASELINE" 2>/dev/null || true
      echo "evicted_now:$ev_now baseline:none delta:- verdict:no_baseline (seeded $ev_now)"
    else
      ev_delta=$((ev_now - ev_base))
      if   [ "$ev_delta" -le 0 ]; then verdict="flat"
      elif [ "$ev_delta" -lt "$EVICT_DELTA_ESCALATE" ]; then verdict="ok"
      else verdict="escalate"; fi
      echo "evicted_now:$ev_now baseline:$ev_base delta:$ev_delta verdict:$verdict (bar $EVICT_DELTA_ESCALATE)"
      if [ "$verdict" != "escalate" ]; then echo "$ev_now" > "$BASELINE" 2>/dev/null || true; fi
    fi
  fi
fi
echo "=== keyspace"; $R INFO keyspace | grep db0 | tr -d "\r"
echo "=== uptime_s"; $R INFO server | grep uptime_in_seconds | tr -d "\r"
echo "=== wt-snap keys"; $R --scan --pattern "cm:wt-snap:*" | wc -l
echo "=== wt-snap sizes (top 5 KB) + TTL days"; for k in $($R --scan --pattern "cm:wt-snap:*" | head -400); do echo "$(( $($R STRLEN "$k") / 1024 )) $(( $($R TTL "$k") / 86400 )) $k"; done | sort -rn | head -5
echo "=== run lock keys"; $R --scan --pattern "coding:session:run:*" | wc -l; $R --scan --pattern "coding:session:run:*" | head -20 | while read -r k; do echo "$k ttl=$($R TTL "$k")"; done
echo "=== namespaces (count)"; $R --scan | sed -E "s/[0-9a-f-]{36}.*//; s/:[0-9]+$//" | sort | uniq -c | sort -rn | head -12
