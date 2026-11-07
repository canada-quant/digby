#!/bin/sh
# Anonymous denial probe for the PUBLIC MCP surface — todo 924725a4 (2026-11-06).
#
# WHAT THIS PROVES
#   That the internet-facing MCP gateway refuses an ANONYMOUS caller at the
#   listener, rather than relying on an upstream to fail later. This is the
#   owner-named security deliverable: "mcp.digby must show NO public
#   unauthenticated listener".
#
# WHY A PROBE AND NOT JUST THE CONFIG TEST
#   backend/scripts/mcp-surface.test.ts pins the CONFIGURATION (no public bind
#   without a shared-key gate, auth-proxy fails closed). Config is necessary but
#   not sufficient: a proxy, SG rule or DNS change can expose a listener that the
#   composer file never mentions. This script is the OUT-OF-BAND check — it
#   speaks only HTTP, sends no credentials, and must be run against the real
#   deployed host.
#
# WHAT IS ACCEPTED
#   401 / 403  = the listener authenticated and refused. GOOD.
#   404/405/000 = no listener on that path (also not an unauth surface). OK.
#   2xx        = an anonymous JSON-RPC call SUCCEEDED. FAIL — this is the bug.
#   5xx        = inconclusive: it did not authenticate anything. Reported as
#                WARN, never as PASS, so a broken gateway cannot look secure.
#
# USAGE
#   sh scripts/mcp/probe-public-mcp-surface.sh                    # mcp.digby.ai
#   sh scripts/mcp/probe-public-mcp-surface.sh https://mcp.example.com
#   sh scripts/mcp/probe-public-mcp-surface.sh --json             # CI-friendly
#
# EXIT: 0 = every probed path denied anonymous access; 1 = at least one 2xx or
#       an inconclusive 5xx; 2 = usage/environment error (no curl).
set -u

BASE_URL="https://mcp.digby.ai"
JSON=0
for arg in "$@"; do
  case "$arg" in
    --json) JSON=1 ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    http://*|https://*) BASE_URL="$arg" ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

command -v curl >/dev/null 2>&1 || { echo "curl is required" >&2; exit 2; }

# Paths that would expose MCP tools if reachable without a key. /health is
# deliberately NOT probed as a failure: it is an unauthenticated liveness
# endpoint BY DESIGN (docker healthcheck + ALB target group), and treating it
# as a leak would make the probe cry wolf until someone removed a needed probe.
PATHS="/mcp /browser/mcp"

# An anonymous tools/list — the cheapest call that proves an attacker could
# enumerate and then drive tools. Sent with no Authorization header at all.
BODY='{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'

fail=0
warn=0
printf 'Anonymous MCP denial probe → %s\n' "$BASE_URL"
printf '%-16s %-6s %s\n' PATH CODE VERDICT

for p in $PATHS; do
  code=$(curl -s -o /dev/null -w '%{http_code}' -m 15 \
    -X POST "$BASE_URL$p" \
    -H 'Content-Type: application/json' \
    -H 'Accept: application/json, text/event-stream' \
    --data "$BODY" 2>/dev/null)
  [ -n "$code" ] || code=000

  case "$code" in
    401|403) verdict="DENIED (good)" ;;
    000|404|405) verdict="no listener (ok)" ;;
    2??) verdict="EXPOSED — anonymous call succeeded"; fail=1 ;;
    5??) verdict="INCONCLUSIVE — did not authenticate (treated as fail)"; fail=1 ;;
    *) verdict="unexpected"; warn=1 ;;
  esac
  printf '%-16s %-6s %s\n' "$p" "$code" "$verdict"
done

if [ "$JSON" = "1" ]; then
  printf '{"baseUrl":"%s","fail":%s,"warn":%s}\n' "$BASE_URL" "$fail" "$warn"
fi

if [ "$fail" = "1" ]; then
  echo "RESULT: FAIL — the public MCP surface answered an anonymous caller." >&2
  exit 1
fi
echo "RESULT: PASS — anonymous callers are denied at the listener."
[ "$warn" = "0" ] || echo "NOTE: $warn path(s) returned an unexpected status; review above." >&2
exit 0