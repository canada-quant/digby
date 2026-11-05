#!/usr/bin/env bash
# build-retry.sh — sourced by deploy-blue-green.sh and deploy-coding-worker.sh.
#
# 2026-10-19: the 2026-10-18 18:37 PT deploy failed mid-build on a Docker Hub
# 502 and nothing retried — the wave died on a transient registry error. A
# build that fails with a TRANSIENT registry/network signature is retried
# (up to BUILD_RETRY_ATTEMPTS, default 3, with a growing pause); any other
# failure (a real compile/Dockerfile error) fails at once, exactly as before.
# BUILD_RETRY_DISABLED=1 runs the command once.
#
# 2026-10-20: the frontend build fetches its Google fonts (next/font/google,
# app/layout.tsx) on every deploy — no Next cache by design (Dockerfile) — and
# one fonts.gstatic.com blip on box A failed the #1817 wave (run 39371197292:
# 15 × "Can't resolve '@vercel/turbopack-next/internal/font/google/font'")
# while the wave before it compiled the same layout fine. A font-fetch
# failure is transient too ("Failed to fetch … from Google Fonts" is the
# webpack wording of the same thing).
#
# Usage: build_with_retry <command> [args...]
#   The command's combined output streams to stdout (callers keep their own
#   `| tail` etc. outside if they want) and is also captured for the check.

BUILD_RETRY_TRANSIENT_RE='(50[234] (Bad Gateway|Service Unavailable|Gateway Time-?out)|status (code )?50[234]|TLS handshake timeout|i/o timeout|connection reset by peer|toomanyrequests|429 Too Many Requests|unexpected EOF|failed to do request|net/http: request canceled|Client\.Timeout exceeded|temporary failure in name resolution|no such host|turbopack-next/internal/font/google/font|Failed to fetch .* from Google Fonts)'

# Pure: does this build output look like a transient registry/network error?
build_output_is_transient() { # $1 = file with the build output
  grep -qiE "$BUILD_RETRY_TRANSIENT_RE" "$1" 2>/dev/null
}

build_with_retry() {
  local attempts="${BUILD_RETRY_ATTEMPTS:-3}" n=1 rc out
  case "$attempts" in ''|*[!0-9]*) attempts=3 ;; esac
  [ "${BUILD_RETRY_DISABLED:-0}" = "1" ] && attempts=1
  out=$(mktemp)
  while :; do
    set +e
    "$@" 2>&1 | tee "$out"
    rc=${PIPESTATUS[0]}
    set -e
    if [ "$rc" -eq 0 ]; then rm -f "$out"; return 0; fi
    if [ "$n" -ge "$attempts" ] || ! build_output_is_transient "$out"; then
      rm -f "$out"
      return "$rc"
    fi
    local unit="${BUILD_RETRY_SLEEP_UNIT:-20}"
    case "$unit" in ''|*[!0-9]*) unit=20 ;; esac
    echo "build-retry: attempt $n failed on a transient registry/network error — retrying in $((unit * n))s (attempt $((n + 1)) of $attempts)" >&2
    sleep "$((unit * n))"
    n=$((n + 1))
  done
}
