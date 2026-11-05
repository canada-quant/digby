#!/usr/bin/env bash
# Regression test — build-retry.sh (2026-10-19): a Docker Hub 502 mid-build
# killed a deploy wave with no retry. Transient registry/network failures
# retry; real build failures fail at once; BUILD_RETRY_DISABLED=1 runs once.
# Wiring: both deploy scripts source it and wrap their builds; box C prunes
# BuildKit cache like A/B.
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
failures=0
ok()  { echo "PASS: $1"; }
bad() { echo "FAIL: $1"; failures=$((failures + 1)); }
check() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (want [$2] got [$3])"; fi; }

bash -n "$ROOT/scripts/deploy/build-retry.sh" && ok "bash -n" || bad "bash -n"
SB="$(mktemp -d)"; trap 'rm -rf "$SB"' EXIT
export BUILD_RETRY_SLEEP_UNIT=0

# fake build: fails with the message in $SB/msg until $SB/left reaches 0
cat > "$SB/fakebuild" <<'EOF'
#!/usr/bin/env bash
d="$(dirname "$0")"
echo x >> "$d/calls"
left=$(cat "$d/left")
if [ "$left" -gt 0 ]; then echo $((left - 1)) > "$d/left"; cat "$d/msg"; exit 17; fi
echo "built ok"
EOF
chmod +x "$SB/fakebuild"

run() { # $1 = failures before success, $2 = failure message
  rm -f "$SB/calls"; echo "$1" > "$SB/left"; printf '%s\n' "$2" > "$SB/msg"
  ( set -euo pipefail; . "$ROOT/scripts/deploy/build-retry.sh"; build_with_retry "$SB/fakebuild" ) >"$SB/out" 2>&1
  echo $?
}
calls() { wc -l < "$SB/calls" 2>/dev/null | tr -d ' '; }

check "Docker Hub 502 once → retried, succeeds" 0 "$(run 1 'failed to fetch: unexpected status from GET request to https://registry-1.docker.io/v2/: 502 Bad Gateway')"
check "  …two calls" 2 "$(calls)"
check "TLS handshake timeout twice → succeeds on the 3rd" 0 "$(run 2 'net/http: TLS handshake timeout')"
check "  …three calls" 3 "$(calls)"
check "transient 3 times → gives up with the build's exit code" 17 "$(run 3 'toomanyrequests: You have reached your pull rate limit')"
check "  …three calls (BUILD_RETRY_ATTEMPTS default)" 3 "$(calls)"
# 2026-10-20 (run 39371197292): a Google-fonts fetch blip during the frontend build
check "next/font Google fetch failure (Turbopack) once → retried, succeeds" 0 "$(run 1 "#26 110.8 Error: Module not found: Can't resolve '@vercel/turbopack-next/internal/font/google/font'")"
check "  …two calls" 2 "$(calls)"
check "next/font Google fetch failure (webpack wording) once → retried" 0 "$(run 1 'Failed to fetch `Geist` from Google Fonts.')"
check "a real Turbopack module-not-found fails at once" 17 "$(run 1 "Error: Module not found: Can't resolve '@/components/Missing'")"
check "  …one call" 1 "$(calls)"
check "a real build error fails at once" 17 "$(run 1 'error TS2345: Argument of type string is not assignable')"
check "  …one call" 1 "$(calls)"
check "BUILD_RETRY_DISABLED=1 → one call even on a 502" 17 "$(BUILD_RETRY_DISABLED=1 run 1 '502 Bad Gateway')"
check "  …one call" 1 "$(calls)"

# wiring
grep -q 'build_with_retry sudo BG_COLOR=' "$ROOT/deploy-blue-green.sh" && ok "wiring: blue-green build wrapped" || bad "wiring: blue-green build not wrapped"
grep -q 'scripts/deploy/build-retry.sh' "$ROOT/deploy-blue-green.sh" && ok "wiring: blue-green sources the helper" || bad "wiring: blue-green does not source the helper"
n=$(grep -c 'build_with_retry docker compose' "$ROOT/scripts/deploy/deploy-coding-worker.sh")
check "wiring: all three box C worker builds wrapped" 3 "$n"
check "wiring: no unwrapped box C build left" "$n" "$(grep -c 'docker-compose.app.yml build worker' "$ROOT/scripts/deploy/deploy-coding-worker.sh")"
grep -q 'docker builder prune -f --keep-storage "${BUILDER_CACHE_KEEP:-40GB}"' "$ROOT/scripts/deploy/deploy-coding-worker.sh" \
  && ok "wiring: box C prunes BuildKit cache (size-bounded)" || bad "wiring: box C BuildKit prune missing"

echo
if [ "$failures" -eq 0 ]; then echo "build-retry tests: all passed"; else echo "build-retry tests: $failures failed" >&2; exit 1; fi
