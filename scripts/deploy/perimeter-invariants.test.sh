#!/usr/bin/env bash
# perimeter-invariants.test.sh — CI guard for the 2026-09-24 owner security
# fixes. Fails the shell-test gate (ci.yml) when a hole comes back:
#   1. no repo compose file publishes the Docker socket proxy (2375) on a host
#      port (a coding sandbox on box C could exec into A/B through it);
#   2. every workflow that runs ssh/scp/rsync brackets it with the ssh-gate
#      composite action — an `open` step AND an always-run `close` step —
#      because port 22 is closed to the internet;
#   3. the ssh-gate action still authorizes AND revokes (not one without the
#      other) and only ever touches port 22;
#   4. the docker-socket-proxy service in the base compose has no `ports:`.
set -u
cd "$(dirname "$0")/../.."
PASS=0; FAIL=0
ok(){ PASS=$((PASS+1)); echo "  ok: $1"; }
bad(){ FAIL=$((FAIL+1)); echo "  FAIL: $1"; }

echo "1. no compose file publishes 2375 on a host port"
for f in docker-compose*.yml; do
  if grep -E '^\s*-\s*"?([0-9.]+:)?2375:2375"?' "$f" >/dev/null; then bad "$f publishes 2375 on the host"; else ok "$f: 2375 not published"; fi
done

echo "2. every ssh/scp/rsync workflow uses the ssh-gate open + always-close"
for wf in .github/workflows/*.yml; do
  if grep -qE '(^|[^a-zA-Z-])(ssh|scp|rsync) ' "$wf"; then
    grep -q "uses: ./.github/actions/ssh-gate" "$wf" && ok "$wf uses the ssh-gate action" || bad "$wf runs ssh without the ssh-gate action"
    grep -q "mode: open" "$wf" && ok "$wf has an open step" || bad "$wf lacks 'mode: open'"
    grep -q "mode: close" "$wf" && ok "$wf has a close step" || bad "$wf lacks 'mode: close'"
    grep -qE "if: always\(\)" "$wf" && ok "$wf closes in an always-step" || bad "$wf close is not if: always()"
    grep -q "id-token: write" "$wf" && ok "$wf grants id-token: write (OIDC)" || bad "$wf lacks id-token: write"
  fi
done

echo "3. the ssh-gate action authorizes AND revokes, port 22 only"
A=.github/actions/ssh-gate/action.yml
[ -f "$A" ] && ok "action exists" || bad "action missing"
grep -q "authorize-security-group-ingress" "$A" && ok "action authorizes" || bad "action lost authorize"
grep -q "revoke-security-group-ingress" "$A" && ok "action revokes" || bad "action lost revoke"
grep -q '"FromPort\\":22' "$A" && grep -q '"ToPort\\":22' "$A" && ok "action opens port 22 only" || bad "action port changed"
grep -q "0.0.0.0/0" "$A" && bad "action must never open 0.0.0.0/0" || ok "action never opens the world"

echo "4. base compose docker-socket-proxy service has no ports:"
BLOCK=$(awk '/^  docker-socket-proxy:/{f=1;next} /^  [a-zA-Z0-9_-]+:/{if(f)exit} f' docker-compose.base.yml)
echo "$BLOCK" | grep -qE '^\s*ports:' && bad "docker-socket-proxy publishes ports" || ok "docker-socket-proxy has no ports:"

echo; echo "passed=$PASS failed=$FAIL"; [ "$FAIL" = 0 ]
