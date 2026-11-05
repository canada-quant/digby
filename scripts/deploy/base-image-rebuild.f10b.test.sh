#!/usr/bin/env bash
# base-image-rebuild.f10b.test.sh — structural pin for the base build-context
# image rebuild check in deploy-blue-green.sh (Framework Operator firing 10b,
# 2026-09-23; caught live by the owner-steered 32d0ebc8 verification).
#
# The bug: seven base services are BUILD-context images (docker-compose.base.yml:
# google-mcp github-mcp x-mcp slack-mcp asana-mcp digby-mcp brightdata-mcp), but
# the deploy pipeline only ever RAN them — `compose up -d` never rebuilds a
# build: image, and deploy.yml's ensure step only checks the container is up.
# So 32d0ebc8's google-mcp write tools shipped, the wave went green, and prod
# kept serving the 2026-06-17 image (missing slides.js entirely while the
# rsync'd on-box source had it). Same class on the other six (image dates
# 2025-12-16 .. 2026-06-17 measured live).
#
# This test fails if deploy-blue-green.sh loses ANY of:
#   - the seven-service BASE_BUILD_SERVICES list,
#   - the /var/tmp stamp directory (must stay OUTSIDE the rsync root, or the
#     --delete rsync wipes the stamps every wave = permanent rebuild storm),
#   - the rebuild-on-content-hash-changed decision (old != new → build),
#   - stamping ONLY on build success (no stamp for a failed build),
#   - the --force-recreate after a rebuild (a rebuilt image alone changes nothing),
#   - the FAILED_BASE → exit 1 gate (new code must never ride a stale image —
#     the 9da289ea rule),
#   - the BASE_REBUILD_DISABLED=1 kill switch,
#   - the context_of lookup reading docker-compose.base.yml (brightdata-mcp
#     builds from ./mcp-gateway — a wrong-context hash would never change).
# It also verifies the seven services really ARE build: services in the compose
# file (the list must not drift).
# Pure text structure — no AWS, docker, or root needed.
# Run from anywhere: bash scripts/deploy/base-image-rebuild.f10b.test.sh

set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DEPLOY="$ROOT/deploy-blue-green.sh"
COMPOSE="$ROOT/docker-compose.base.yml"

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ok: $1"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL: $1"; }

for f in "$DEPLOY" "$COMPOSE"; do
    [ -f "$f" ] || { echo "base-image-rebuild.f10b: missing file $f"; exit 1; }
done

echo "base-image-rebuild.f10b (deploy-blue-green.sh base image rebuild)"

# 1. The service list — all seven build-context base services.
LIST=$(sed -n 's/^BASE_BUILD_SERVICES="\(.*\)"$/\1/p' "$DEPLOY" | head -1)
[ -n "$LIST" ] || LIST="__missing__"
for svc in google-mcp github-mcp x-mcp slack-mcp asana-mcp digby-mcp brightdata-mcp; do
    case " $LIST " in *" $svc "*) ok "BASE_BUILD_SERVICES includes $svc";; *) bad "BASE_BUILD_SERVICES missing $svc (got: $LIST)";; esac
done

# 2. Every listed service really is a build: service in the compose file —
#    the list must not drift from docker-compose.base.yml.
for svc in $LIST; do
    [ "$svc" = "__missing__" ] && continue
    if awk -v svc="  $svc:" '$0 == svc {in_svc=1; next} /^  [a-z0-9-]+:$/ {in_svc=0} in_svc && $1 == "build:" {found=1; exit} END {exit !found}' "$COMPOSE"; then
        ok "$svc is a build: service in docker-compose.base.yml"
    else
        bad "$svc listed in BASE_BUILD_SERVICES but has no build: block in the compose — list drifted"
    fi
done

# 3. Stamp dir must be /var/tmp (outside the rsync root /opt/crossmodel).
grep -q 'STAMP_DIR=/var/tmp/.digby-base-img-stamps' "$DEPLOY" \
    && ok "stamp dir is /var/tmp/.digby-base-img-stamps (outside the rsync root)" \
    || bad "stamp dir line missing/changed — must stay OUTSIDE /opt/crossmodel (rsync --delete would wipe it)"

# 4. Rebuild decision: hash change → build; stamp written only on success.
grep -q 'if \[ "$OLD" = "$HASH" \]; then' "$DEPLOY" \
    && ok "unchanged-context short-circuit present (OLD == HASH → skip)" \
    || bad "unchanged-context short-circuit lost — every wave would rebuild everything"
grep -A2 'docker compose -f "$BASE_COMPOSE" build "$SVC"; then' "$DEPLOY" | grep -q 'tee "$STAMP"' \
    && ok "stamp written only after a successful build" \
    || bad "stamp no longer gated on build success — a failed build would be remembered as built"

# 5. Recreate after rebuild (a rebuilt image alone changes nothing).
grep -q 'up -d --no-deps --force-recreate "$SVC"' "$DEPLOY" \
    && ok "container force-recreated after image rebuild" \
    || bad "force-recreate after rebuild lost — the stale container would keep running the old image"

# 6. Failure gate: build failure must fail the deploy (9da289ea rule).
grep -q 'FAILED_BASE=1' "$DEPLOY" \
    && ok "build/recreate failure sets FAILED_BASE" \
    || bad "FAILED_BASE accumulator lost"
grep -q '\[ -n "$FAILED_BASE" \] && { log "❌ base image rebuild failed — aborting before color switch"; exit 1; }' "$DEPLOY" \
    && ok "FAILED_BASE exits 1 before the color switch" \
    || bad "FAILED_BASE no longer aborts the deploy — new code could ride a stale image"

# 7. Kill switch + rebuild bound.
grep -q 'BASE_REBUILD_DISABLED:-0' "$DEPLOY" \
    && ok "BASE_REBUILD_DISABLED kill switch present (default 0)" \
    || bad "BASE_REBUILD_DISABLED kill switch lost"
grep -q 'BASE_REBUILD_MAX="\${BASE_REBUILD_MAX:-2}"' "$DEPLOY" \
    && ok "BASE_REBUILD_MAX bound present (default 2)" \
    || bad "BASE_REBUILD_MAX default-2 bound lost — an unbounded 7× bootstrap could blow the 3300s script timeout (2700 before T2d 2026-10-17)"
grep -q 'if \[ "$REBUILT" -ge "$BASE_REBUILD_MAX" \]; then' "$DEPLOY" \
    && ok "per-wave rebuild bound enforced (REBUILT >= MAX → defer)" \
    || bad "rebuild bound not enforced — every changed service rebuilds in one wave"
grep -A1 'if \[ "$REBUILT" -ge "$BASE_REBUILD_MAX" \]; then' "$DEPLOY" | grep -q 'NEXT wave rebuilds it' \
    && ok "deferred service keeps its stamp unset (next wave rebuilds — a queue, not a skip)" \
    || bad "deferred service would be skipped forever, not queued"
grep -q 'REBUILT=$((REBUILT + 1))' "$DEPLOY" \
    && ok "rebuild counter incremented only after a successful build + stamp" \
    || bad "REBUILT counter increment lost"

# 8. context_of reads the compose file (brightdata-mcp → ./mcp-gateway).
grep -q 'context_of()' "$DEPLOY" \
    && ok "context_of() helper present" \
    || bad "context_of() helper lost — the hash would be computed against the wrong dir"
grep -q '\$BASE_COMPOSE' "$DEPLOY" \
    && ok "context lookup reads \$BASE_COMPOSE" \
    || bad "context lookup no longer reads the compose file"

echo "base-image-rebuild.f10b: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
exit 0
