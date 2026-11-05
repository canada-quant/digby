#!/usr/bin/env bash
# xmcp-gate-order.e3cb31c3.test.sh — structural pin for the x-mcp rebuild-gate
# race fix (ticket e3cb31c3, 2026-09-22).
#
# The race: the blue-green step wrote the wave's OWN sha into the on-box
# /opt/crossmodel-local/deployed-sha marker ~45 min before the "Detect x-mcp
# changes" gate read that marker as its BEFORE → compare/SHA...SHA → empty
# file list → CHANGED=false on EVERY wave → x-mcp never rebuilt (f609ec35's
# x-mcp read-path fix sat undelivered while the backend ran the fixed sha —
# verified from deploy run 35772650169's log bytes).
#
# The fix moves the marker write to AFTER the "Ensure x-mcp is running" step,
# so the gate reads the PREVIOUS successful wave's marker. This test fails if:
#   - the marker write migrates back ahead of (or into) the blue-green step,
#   - the write is duplicated or lost,
#   - the gate stops reading the on-box marker,
#   - the gate no longer runs before the x-mcp delivery step.
# Pure text structure — no AWS, docker, or root needed.
set -u
cd "$(dirname "$0")"
YML=../../.github/workflows/deploy.yml
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ok: $1"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL: $1"; }
check(){ if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (want [$2] got [$3])"; fi; }

if [ ! -f "$YML" ]; then
  bad "deploy.yml not found at $YML"
  echo "xmcp-gate-order.e3cb31c3: $PASS passed, $FAIL failed"
  exit 1
fi

line_of() { grep -nF -- "$1" "$YML" | head -1 | cut -d: -f1; }

BLUEGREEN_LINE=$(line_of '- name: Blue-green deploy')
PARITY_LINE=$(line_of '- name: Cross-box asset parity gate')
GATE_LINE=$(line_of '- name: Detect x-mcp changes in this push')
ENSURE_LINE=$(line_of '- name: Ensure x-mcp is running')
MARKER_STEP_LINE=$(line_of '- name: Record deployed-sha marker')

# The marker write command (echo github.sha > /tmp/deployed-sha.*) must exist
# EXACTLY once — the single post-delivery write site.
WRITE_COUNT=$(grep -cF '> /tmp/deployed-sha.' "$YML")
WRITE_LINE=$(grep -nF '> /tmp/deployed-sha.' "$YML" | head -1 | cut -d: -f1)
# The gate's BEFORE read of the on-box marker must exist exactly once.
READ_COUNT=$(grep -cF 'cat /opt/crossmodel-local/deployed-sha' "$YML")

check "marker write command exists exactly once" "1" "$WRITE_COUNT"
check "gate marker read exists exactly once" "1" "$READ_COUNT"

for v in BLUEGREEN_LINE GATE_LINE ENSURE_LINE WRITE_LINE; do
  eval "val=\$$v"
  case "$val" in ''|*[!0-9]*) bad "$v resolved (got [$val])";; *) ok "$v resolved ($val)";; esac
done

# THE fix: the marker write happens AFTER x-mcp delivery, which happens AFTER
# the gate decision — so the gate reads the PREVIOUS wave's marker.
if [ -n "$GATE_LINE" ] && [ -n "$ENSURE_LINE" ] && [ -n "$WRITE_LINE" ]; then
  [ "$GATE_LINE" -lt "$ENSURE_LINE" ] \
    && ok "gate step ($GATE_LINE) runs before x-mcp delivery ($ENSURE_LINE)" \
    || bad "gate step ($GATE_LINE) must run before x-mcp delivery ($ENSURE_LINE)"
  [ "$WRITE_LINE" -gt "$ENSURE_LINE" ] \
    && ok "marker write ($WRITE_LINE) lands AFTER x-mcp delivery ($ENSURE_LINE) — race fixed" \
    || bad "marker write ($WRITE_LINE) must land AFTER x-mcp delivery ($ENSURE_LINE) — the e3cb31c3 race"
fi

# The blue-green block must NOT touch the marker — a mid-wave write is the race.
if [ -n "$BLUEGREEN_LINE" ] && [ -n "$PARITY_LINE" ]; then
  BG_TOUCHES=$(sed -n "${BLUEGREEN_LINE},${PARITY_LINE}p" "$YML" | grep -cF 'deployed-sha' || true)
  # The pointer comment naming the marker is allowed; a WRITE is not.
  BG_WRITES=$(sed -n "${BLUEGREEN_LINE},${PARITY_LINE}p" "$YML" | grep -cF '> /tmp/deployed-sha.' || true)
  check "blue-green block contains no marker WRITE" "0" "$BG_WRITES"
fi

# The named marker step, if present, must be the step containing the write.
if [ -n "$MARKER_STEP_LINE" ] && [ -n "$WRITE_LINE" ]; then
  NEXT_STEP=$(awk -v l="$MARKER_STEP_LINE" 'NR>l && /- name: /{print NR; exit}' "$YML")
  if [ -n "$NEXT_STEP" ]; then
    INSIDE=$(sed -n "${MARKER_STEP_LINE},${NEXT_STEP}p" "$YML" | grep -cF '> /tmp/deployed-sha.' || true)
    check "write lives inside the Record deployed-sha marker step" "1" "$INSIDE"
  fi
fi

echo "xmcp-gate-order.e3cb31c3: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
