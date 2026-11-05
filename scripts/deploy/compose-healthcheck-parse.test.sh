#!/usr/bin/env bash
# Regression test — compose healthcheck expressions must PARSE (ea3ad8a8).
#
# The class this pins: docker-compose.base.yml's browser-service healthcheck
# shipped with a trailing stray `}` inside the `node -e` expression
# (2026-10-17, found by the ea3ad8a8 E2E box probe — docker marked the
# container unhealthy with FailingStreak 50 / "SyntaxError: Unexpected token
# '}'" while the service itself was genuinely healthy, /health 200). No CI
# surface ever executes a compose healthcheck, so only a parse guard catches
# this class before deploy.
#
# Invariants:
#   A. Every `test: ["CMD", "node", "-e", "<expr>"]` healthcheck in every
#      docker-compose*.yml parses as JavaScript (node --check — syntax only,
#      never executed).
#   B. The extractor itself is guarded: zero expressions found = FAIL (a
#      regex drift must be loud, not silently green).
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

fail=0
n=0
for f in "$root"/docker-compose*.yml; do
  [ -f "$f" ] || continue
  # Every node -e healthcheck expression in flow-sequence style:
  #   test: ["CMD", "node", "-e", "<expr>"]
  # (expressions in this repo contain no double quotes — pinned by the
  # extractor shape itself; a future expression needing one must extend this
  # guard, not bypass it.)
  grep -oE 'test: \["CMD", *"node", *"-e", *"[^"]*"\]' "$f" \
    | sed -E 's/^test: \["CMD", *"node", *"-e", *"(.*)"\]$/\1/' \
    > "$tmp/exprs.txt" || true
  while IFS= read -r expr; do
    [ -n "$expr" ] || continue
    n=$((n+1))
    printf '%s\n' "$expr" > "$tmp/expr.js"
    if ! node --check "$tmp/expr.js" 2> "$tmp/err.txt"; then
      echo "FAIL: $(basename "$f") node -e healthcheck does not parse:"
      echo "      $expr"
      sed 's/^/      /' "$tmp/err.txt"
      fail=1
    fi
  done < "$tmp/exprs.txt"
done

if [ "$n" -eq 0 ]; then
  echo "FAIL: no node -e healthcheck expressions found — extractor regex drift?"
  exit 1
fi

if [ "$fail" -ne 0 ]; then
  echo "compose-healthcheck-parse: $n expressions checked, AT LEAST ONE BROKEN"
  exit 1
fi
echo "compose-healthcheck-parse: $n expressions OK"
