#!/usr/bin/env bash
# deploy-auth-smoke.sh — authenticated smoke gate for blue-green deploys.
#
# Closes the blind spot that let the 2026-07-23 /coding/* 502 outage ship
# through green deploys: the gate only curled /health + frontend 200 and never
# made an AUTHENTICATED request. That outage class was duplicate
# `set-cookie: cm_access=` headers (stacked router.use(authenticate) with
# append-style res.cookie) pushing response headers past nginx's
# proxy_buffer_size → 502 on authenticated /api/crossmodel/coding/* routes.
#
# Subcommands:
#   new     <base_url> <token_file>  Log in as the CANONICAL agent test user
#                                    (registers it once if missing), save the
#                                    access token (chmod 600), run checks.
#   recheck <base_url> <token_file>  Reuse the saved token, run the checks.
#
# Credentials ($SMOKE_CANON_EMAIL / $SMOKE_CANON_PASSWORD) resolve in order:
#   1. Environment — CI passes the SMOKE_CANON_EMAIL / SMOKE_CANON_PASSWORD
#      GitHub repo secrets over ssh stdin (.github/workflows/deploy.yml).
#   2. Box-local /opt/crossmodel-local/deploy-flags.env — for manual deploys on
#      the EC2 box, add the two vars there once (the file already carries deploy
#      flags, lives outside the rsync --delete root, and is never committed).
# If NEITHER source is set, the authenticated checks are SKIPPED with a loud
# warning and only the unauthenticated 401 probe gates the deploy — deploys are
# NOT blocked, so this change can merge before the secrets exist. Set
# SMOKE_REQUIRE_CREDS=1 to turn missing credentials back into a hard failure
# once the secrets are in place.
#
# Auto-register safety: when login fails, the register-once fallback runs ONLY
# with SMOKE_ALLOW_REGISTER=1 (bootstrap of a fresh environment). By default a
# failed login fails the smoke — a typo'd credential must not mint an account.
#
# Checks (both modes, in order):
#   1. Unauthenticated GET <base_url>/api/crossmodel/coding/projects → HTTP 401
#      (guards protected routes accidentally becoming public).
#   2. Authenticated   GET (Authorization: Bearer <token>)           → HTTP 200
#      AND exactly ONE `set-cookie: cm_access=` response header, counted
#      case-insensitively (guards the duplicate-cookie nginx-overflow class).
#
# Deliberately jq-free (JSON parsed with sed); `curl --max-time 15` throughout.
# The token is NEVER printed (no set -x anywhere in this script).
#
# Register schema (backend/src/modules/auth/auth.validation.ts registerSchema):
#   { email: string(email), password: string(min 8), firstName?, lastName? }
# Success shape (auth.controller.ts register): HTTP 201, body
#   {"success":true,"data":{"user":{...},"accessToken":"<jwt>"},"message":...}
# Register is rate-limited 20 per 15 min per IP (app.ts authRateLimit) — we do
# exactly ONE attempt and never retry-loop.

set -euo pipefail

CURL_MAX_TIME=15
PROJECTS_PATH='/api/crossmodel/coding/projects'

# Optional: pin connections to a specific IP while keeping SNI/Host from the
# base URL (deploy-blue-green.sh sets SMOKE_RESOLVE_IP=$PUBLIC_CHECK_IP so
# post-flip checks verify the box just deployed, not whatever DNS points at).
RESOLVE_ARGS=()
build_resolve_args() {
    local base_url="$1"
    [ -n "${SMOKE_RESOLVE_IP:-}" ] || return 0
    local scheme host port
    scheme=$(printf '%s' "$base_url" | sed -E 's|^([a-zA-Z]+)://.*|\1|')
    host=$(printf '%s' "$base_url" | sed -E 's|^[a-zA-Z]+://([^:/]+).*|\1|')
    if [ "$scheme" = "http" ]; then port=80; else port=443; fi
    RESOLVE_ARGS=(--resolve "$host:$port:$SMOKE_RESOLVE_IP")
}

fail() {
    echo "❌ SMOKE FAILED: $*" >&2
    exit 1
}

usage() {
    echo "usage: $0 {new|recheck} <base_url> <token_file>" >&2
    exit 2
}

# run_unauth_check <base_url> — the credential-free half of the gate. Runs even
# when smoke creds are absent, so a degraded deploy still verifies protected
# routes did not become public.
run_unauth_check() {
    local base_url="$1"
    local url="${base_url%/}${PROJECTS_PATH}"
    local code

    echo "🔍 smoke 1/2: unauthenticated GET $url (expect HTTP 401)"
    if ! code=$(curl -sS ${RESOLVE_ARGS[@]+"${RESOLVE_ARGS[@]}"} -o /dev/null -w '%{http_code}' --max-time "$CURL_MAX_TIME" "$url"); then
        fail "unauthenticated probe: curl could not reach $url"
    fi
    [ "$code" = "401" ] || fail "unauthenticated GET $url → HTTP $code, expected 401 (protected route may have become public)"
    echo "   ✔ HTTP 401 as expected"
}

# run_checks <base_url> <token> — the token is passed in-memory only, never echoed.
run_checks() {
    local base_url="$1"
    local token="$2"
    local url="${base_url%/}${PROJECTS_PATH}"
    local code
    local hfile
    local cookie_count

    run_unauth_check "$base_url"

    echo "🔍 smoke 2/2: authenticated GET $url (expect HTTP 200 + exactly one cm_access Set-Cookie)"
    hfile=$(mktemp)
    if ! code=$(curl -sS ${RESOLVE_ARGS[@]+"${RESOLVE_ARGS[@]}"} -D "$hfile" -o /dev/null -w '%{http_code}' --max-time "$CURL_MAX_TIME" \
            -H "Authorization: Bearer $token" "$url"); then
        rm -f "$hfile"
        fail "authenticated probe: curl could not reach $url"
    fi
    if [ "$code" != "200" ]; then
        rm -f "$hfile"
        fail "authenticated GET $url → HTTP $code, expected 200 (authenticated path broken on this stack)"
    fi
    # Count cm_access Set-Cookie lines case-insensitively: HTTP/1.1 direct-to-backend
    # emits 'Set-Cookie:', HTTP/2 through nginx emits 'set-cookie:'.
    cookie_count=$(grep -ci '^set-cookie:[[:space:]]*cm_access=' "$hfile" || true)
    rm -f "$hfile"
    [ "$cookie_count" = "1" ] || fail "authenticated GET $url → $cookie_count 'set-cookie: cm_access=' headers, expected exactly 1 (duplicate-cookie class overflows nginx proxy buffers → 502)"
    echo "   ✔ HTTP 200 with exactly one cm_access Set-Cookie header"
}

# Canonical agent test account (documented in AGENTS.md + memory-bank). The
# deploy smoke gate LOGS IN as this user instead of registering a fresh
# throwaway per deploy — register-per-deploy left ~57 deploy-smoke-*@example.com
# rows in prod within 8 days (cleaned 2026-08-08 via ec2-ops one-shot).
#
# Credentials come from the environment or the box-local flags file — they were
# previously hardcoded here, which put a live production login in the tracked
# repo (audit finding, 2026-08-13). See the header for the resolution order.
CANON_EMAIL="${SMOKE_CANON_EMAIL:-}"
CANON_PASSWORD="${SMOKE_CANON_PASSWORD:-}"

# Box-local fallback for manual deploys: /opt/crossmodel-local lives outside the
# repo and the deploy rsync --delete root, so credentials there survive deploys
# and never enter git history. (Overridable for tests.)
LOCAL_FLAGS_FILE="${SMOKE_LOCAL_FLAGS_FILE:-/opt/crossmodel-local/deploy-flags.env}"
if { [ -z "$CANON_EMAIL" ] || [ -z "$CANON_PASSWORD" ]; } && [ -r "$LOCAL_FLAGS_FILE" ]; then
    # shellcheck disable=SC1090
    . "$LOCAL_FLAGS_FILE"
    CANON_EMAIL="${CANON_EMAIL:-${SMOKE_CANON_EMAIL:-}}"
    CANON_PASSWORD="${CANON_PASSWORD:-${SMOKE_CANON_PASSWORD:-}}"
fi

creds_available() {
    [ -n "$CANON_EMAIL" ] && [ -n "$CANON_PASSWORD" ]
}

# Loud, greppable degraded-mode banner. The deploy proceeds on the 401 probe
# alone rather than bricking on missing secrets; SMOKE_REQUIRE_CREDS=1 restores
# the hard failure once the secrets exist.
skip_auth_checks() {
    if [ "${SMOKE_REQUIRE_CREDS:-0}" = "1" ]; then
        fail "canonical smoke credentials not set and SMOKE_REQUIRE_CREDS=1 — set SMOKE_CANON_EMAIL / SMOKE_CANON_PASSWORD (CI: GitHub repo secrets consumed by .github/workflows/deploy.yml; manual: /opt/crossmodel-local/deploy-flags.env)"
    fi
    echo "⚠️  SMOKE DEGRADED: SMOKE_CANON_EMAIL / SMOKE_CANON_PASSWORD not set." >&2
    echo "⚠️  The unauthenticated 401 probe ran, but the authenticated 200 +" >&2
    echo "⚠️  single-cm_access-cookie check WAS SKIPPED (the 2026-07-23 502 class" >&2
    echo "⚠️  is unguarded until credentials are configured)." >&2
    echo "⚠️  Fix: create the SMOKE_CANON_EMAIL / SMOKE_CANON_PASSWORD repo secrets" >&2
    echo "⚠️  (CI) and/or add both vars to /opt/crossmodel-local/deploy-flags.env" >&2
    echo "⚠️  (manual box deploys). Then optionally set SMOKE_REQUIRE_CREDS=1." >&2
}

# ensure_canonical_token <base_url> <token_file> — log in as the canonical
# account; register it once if missing (idempotent: a 400 'already exists'
# race just falls through to a fresh login). Saves the access token to
# <token_file> with mode 600; the token is never written to stdout/stderr.
ensure_canonical_token() {
    local base_url="$1"
    local token_file="$2"
    local login_url="${base_url%/}/api/auth/login"
    local register_url="${base_url%/}/api/auth/register"
    local body
    local bfile
    local code
    local token

    body="{\"email\":\"${CANON_EMAIL}\",\"password\":\"${CANON_PASSWORD}\"}"
    echo "🔍 logging in canonical smoke user ($CANON_EMAIL)"
    bfile=$(mktemp)
    if ! code=$(curl -sS ${RESOLVE_ARGS[@]+"${RESOLVE_ARGS[@]}"} -o "$bfile" -w '%{http_code}' --max-time "$CURL_MAX_TIME" \
            -H 'Content-Type: application/json' -d "$body" "$login_url"); then
        rm -f "$bfile"
        fail "login: curl could not reach $login_url"
    fi
    if [ "$code" != "200" ]; then
        # Auto-register is OPT-IN: with operator-supplied credentials, a typo'd
        # email/password would otherwise silently MINT a junk prod account here
        # (the register-once fallback exists only for bootstrapping a fresh
        # environment). Default = fail loudly on bad credentials.
        if [ "${SMOKE_ALLOW_REGISTER:-0}" != "1" ]; then
            rm -f "$bfile"
            fail "canonical login → HTTP $code — refusing to auto-register (likely a credential typo; verify SMOKE_CANON_EMAIL / SMOKE_CANON_PASSWORD, or set SMOKE_ALLOW_REGISTER=1 only when bootstrapping a fresh environment)"
        fi
        echo "   canonical login → HTTP $code — registering the account once (idempotent)"
        rm -f "$bfile"
        bfile=$(mktemp)
        if ! code=$(curl -sS ${RESOLVE_ARGS[@]+"${RESOLVE_ARGS[@]}"} -o "$bfile" -w '%{http_code}' --max-time "$CURL_MAX_TIME" \
                -H 'Content-Type: application/json' \
                -d "{\"email\":\"${CANON_EMAIL}\",\"password\":\"${CANON_PASSWORD}\",\"firstName\":\"Claude\",\"lastName\":\"Bot\"}" \
                "$register_url"); then
            rm -f "$bfile"
            fail "register: curl could not reach $register_url"
        fi
        if [ "$code" != "201" ]; then
            if ! { [ "$code" = "400" ] && grep -qi 'already exists' "$bfile"; }; then
                echo "   register response (HTTP $code): $(cat "$bfile")" >&2
                rm -f "$bfile"
                fail "register POST $register_url → HTTP $code, expected 201 or 400-already-exists (register is rate-limited 20/15min/IP — NOT retrying)"
            fi
            # already-exists race: fall through to a fresh login
            rm -f "$bfile"
            bfile=$(mktemp)
            if ! code=$(curl -sS ${RESOLVE_ARGS[@]+"${RESOLVE_ARGS[@]}"} -o "$bfile" -w '%{http_code}' --max-time "$CURL_MAX_TIME" \
                    -H 'Content-Type: application/json' -d "$body" "$login_url"); then
                rm -f "$bfile"
                fail "login (post-register race): curl could not reach $login_url"
            fi
            if [ "$code" != "200" ]; then
                echo "   login response (HTTP $code): $(cat "$bfile")" >&2
                rm -f "$bfile"
                fail "canonical login still HTTP $code after register race"
            fi
        fi
    fi
    # res.json is compact; tolerate whitespace anyway. Single "accessToken" key in body.
    token=$(sed -n 's/.*"accessToken"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$bfile" | head -n 1)
    rm -f "$bfile"
    [ -n "$token" ] || fail "canonical auth returned HTTP $code but body had no data.accessToken"
    ( umask 177; printf '%s' "$token" > "$token_file" )
    chmod 600 "$token_file" 2>/dev/null || true
    echo "   ✔ canonical login OK; access token saved to $token_file (chmod 600)"
}

main() {
    [ "$#" -eq 3 ] || usage
    local mode="$1"
    local base_url="$2"
    local token_file="$3"
    build_resolve_args "$base_url"

    case "$mode" in
        new)
            if creds_available; then
                ensure_canonical_token "$base_url" "$token_file"
                run_checks "$base_url" "$(cat "$token_file")"
            else
                run_unauth_check "$base_url"
                skip_auth_checks
                echo "✅ smoke passed DEGRADED — unauthenticated probe only ($base_url)"
                return 0
            fi
            ;;
        recheck)
            if [ -s "$token_file" ]; then
                run_checks "$base_url" "$(cat "$token_file")"
            elif ! creds_available; then
                # `new` ran credential-less and saved no token — stay consistent
                # for the post-flip recheck instead of failing the deploy.
                run_unauth_check "$base_url"
                skip_auth_checks
                echo "✅ smoke passed DEGRADED — unauthenticated probe only ($base_url)"
                return 0
            else
                fail "token file missing or empty: $token_file (creds are set — the pre-flip 'new' phase should have saved a token)"
            fi
            ;;
        *)
            usage
            ;;
    esac
    echo "✅ authenticated smoke passed ($base_url)"
}

main "$@"
