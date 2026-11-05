#!/usr/bin/env bash
# sandbox-egress-guard.test.sh — shim-driven pins for sandbox-egress-guard.sh
# (owner security fix 2026-09-24). No root, no docker: IPT/DOCKER are PATH
# shims that record calls. Pins: DNS allow rules precede the rejects; IMDS and
# the VPC CIDR are rejected for every bridge subnet; the DOCKER-USER jump is
# inserted at position 1 exactly once (idempotent re-run); the kill switch
# removes the chain; no bridge subnet = no-op.
set -u
cd "$(dirname "$0")"
SBX=$(mktemp -d); trap 'rm -rf "$SBX"' EXIT
PASS=0; FAIL=0
ok(){ PASS=$((PASS+1)); echo "  ok: $1"; }
bad(){ FAIL=$((FAIL+1)); echo "  FAIL: $1"; }
check(){ if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (want [$2] got [$3])"; fi; }

cat > "$SBX/ipt" <<'S'
#!/usr/bin/env bash
echo "$*" >> "$IPT_LOG"
# -C (check) answers "absent" unless the log already holds the matching -I/-A
# -N (new chain) fails when the chain already exists and was not deleted since
if [ "$1" = "-N" ]; then
  n=$(grep -c -- "^-N $2\$" "$IPT_LOG" 2>/dev/null); n=${n:-0}; x=$(grep -c -- "^-X $2\$" "$IPT_LOG" 2>/dev/null); x=${x:-0}
  [ "$n" -gt "$((x+1))" ] && exit 1
  exit 0
fi
if [ "$1" = "-C" ]; then
  chain=$2; shift 2; rest="$*"
  grep -qE -- "^(-I $chain( [0-9]+)? |-A $chain )$rest\$" "$IPT_LOG" 2>/dev/null && exit 0
  exit 1
fi
exit 0
S
cat > "$SBX/dock" <<'S'
#!/usr/bin/env bash
printf '%s' "${BRIDGE_SUBNETS-172.17.0.0/16
}"
S
chmod +x "$SBX/ipt" "$SBX/dock"
run(){ export IPT_LOG="$SBX/log"; : > "$IPT_LOG"; IPT="$SBX/ipt" DOCKER="$SBX/dock" SANDBOX_EGRESS_DNS=10.0.0.20 DIGBY_VPC_CIDR=10.60.0.0/16 "$@" ./sandbox-egress-guard.sh >"$SBX/out" 2>&1; echo $?; }

echo "1. default bridge → chain built, DNS allowed first, IMDS + VPC rejected, jump inserted once"
rc=$(run env BRIDGE_SUBNETS="172.17.0.0/16")
check "exit 0" 0 "$rc"
check "DNS udp allow present" 1 "$(grep -c -- '-A DIGBY-SANDBOX-EGRESS -s 172.17.0.0/16 -d 10.0.0.20/32 -p udp --dport 53 -j RETURN' "$SBX/log")"
check "IMDS reject present" 1 "$(grep -c -- '-s 172.17.0.0/16 -d 169.254.169.254/32 -j REJECT' "$SBX/log")"
check "VPC reject present" 1 "$(grep -c -- '-s 172.17.0.0/16 -d 10.60.0.0/16 -j REJECT' "$SBX/log")"
dns_line=$(grep -n -- '--dport 53' "$SBX/log" | head -1 | cut -d: -f1); rej_line=$(grep -n -- '-j REJECT' "$SBX/log" | head -1 | cut -d: -f1)
[ "$dns_line" -lt "$rej_line" ] && ok "DNS allow precedes the first reject" || bad "DNS allow must precede rejects ($dns_line vs $rej_line)"
check "jump inserted at DOCKER-USER position 1" 1 "$(grep -c -- '-I DOCKER-USER 1 -j DIGBY-SANDBOX-EGRESS' "$SBX/log")"
check "host-side INPUT chain rejects sandbox → sensitive host ports (ssh, redis, mcp…)" 1 "$(grep -c -- '-A DIGBY-SANDBOX-INPUT -i docker0 -p tcp -m multiport --dports 22,2375,6379,7856,9384,9521,4001:4002,8248:8249,4301:4302,8200:8206,5432 -j REJECT' "$SBX/log")"
check "INPUT jump inserted at position 1" 1 "$(grep -c -- '-I INPUT 1 -j DIGBY-SANDBOX-INPUT' "$SBX/log")"

echo "1b. re-run on a box that already has the chain → flush + rebuild, jump NOT inserted twice"
export IPT_LOG="$SBX/log"; IPT="$SBX/ipt" DOCKER="$SBX/dock" SANDBOX_EGRESS_DNS=10.0.0.20 DIGBY_VPC_CIDR=10.60.0.0/16 BRIDGE_SUBNETS="172.17.0.0/16" ./sandbox-egress-guard.sh >/dev/null 2>&1
check "second run exits 0" 0 "$?"
check "exactly one DOCKER-USER jump across both runs" 1 "$(grep -c -- '-I DOCKER-USER 1 -j DIGBY-SANDBOX-EGRESS' "$SBX/log")"
check "chain flushed on the second run" 1 "$(grep -c -- '^-F DIGBY-SANDBOX-EGRESS$' "$SBX/log")"

echo "2. two bridge subnets → both guarded"
rc=$(run env BRIDGE_SUBNETS="172.17.0.0/16
172.18.0.0/16")
check "exit 0" 0 "$rc"
check "second subnet VPC reject" 1 "$(grep -c -- '-s 172.18.0.0/16 -d 10.60.0.0/16 -j REJECT' "$SBX/log")"

echo "3. kill switch removes the chain and exits 0"
rc=$(run env SANDBOX_EGRESS_GUARD_DISABLED=1)
check "exit 0" 0 "$rc"
check "chain deleted" 1 "$(grep -c -- '-X DIGBY-SANDBOX-EGRESS' "$SBX/log")"
check "input chain deleted too" 1 "$(grep -c -- '-X DIGBY-SANDBOX-INPUT' "$SBX/log")"
check "no rules added" 0 "$(grep -c -- '-A DIGBY-SANDBOX-EGRESS' "$SBX/log")"

echo "4. no bridge subnet → no-op"
rc=$(run env BRIDGE_SUBNETS="")
check "exit 0" 0 "$rc"
check "no iptables writes" 0 "$(grep -c -- '-A \|-I ' "$SBX/log")"

echo; echo "passed=$PASS failed=$FAIL"; [ "$FAIL" = 0 ]
