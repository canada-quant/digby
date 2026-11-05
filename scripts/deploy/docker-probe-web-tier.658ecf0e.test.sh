#!/usr/bin/env bash
# docker-probe-web-tier.658ecf0e.test.sh — ticket 658ecf0e: the box A/B backends have no Docker daemon by design
# (DOCKER_HOST names box C's dead 2375 proxy), and without CODING_CONTAINER_PROBE_DISABLED=1 every new backend
# container logged one "coding container: Docker not available" warn — 26 a day in prod (LVC1021B, 2026-10-21), all
# `docker info` exits, clustered on deploy waves. Pins: the A/B .env template written by deploy.yml carries the flag;
# box C's .env is never written by that step (its rsync excludes .env); the flag is forwarded to the backend and the
# worker; the runtime honours it (dockerProbeSkipReason).
set -u
cd "$(dirname "$0")/../.."
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ok: $1"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL: $1"; }
tmpl=$(python3 - <<'PY'
d=open('.github/workflows/deploy.yml').read()
i=d.index("cat > /opt/crossmodel/.env << 'ENVEOF'"); j=d.index('ENVEOF', i+40)
print(d[i:j])
PY
)
printf '%s\n' "$tmpl" | grep -qx '          CODING_CONTAINER_PROBE_DISABLED=1' && ok "the A/B .env template sets CODING_CONTAINER_PROBE_DISABLED=1" || bad "flag missing from the A/B .env template"
printf '%s\n' "$tmpl" | grep -v '^\s*#' | grep -q '"' && bad "a double quote inside the template would break the ssh \"…\" wrapper" || ok "no double quote inside the ssh-quoted template"
grep -q "for EC2_HOST in \$HOSTS" .github/workflows/deploy.yml && ok "the template is written to the EC2_HOSTS set (A/B)" || bad "host loop not found"
grep -q -- "--exclude '.env'" .github/workflows/deploy.yml && ok "box C's rsync excludes .env (C keeps its own, probe stays on)" || bad "box C .env exclusion not found"
n=$(grep -c 'CODING_CONTAINER_PROBE_DISABLED=\${CODING_CONTAINER_PROBE_DISABLED:-}' docker-compose.app.yml)
[ "$n" -ge 2 ] && ok "forwarded to backend and worker ($n)" || bad "forwarded $n times (want >= 2)"
grep -q "CODING_CONTAINER_PROBE_DISABLED === '1'" backend/src/modules/crossmodel/coding/container.service.ts && ok "dockerProbeSkipReason honours the flag" || bad "runtime check not found"
echo "docker-probe-web-tier.658ecf0e.test.sh: $PASS passed, $FAIL failed"
[ "$FAIL" = 0 ]
