#!/usr/bin/env bash
# sandbox-egress-guard.sh — coding sandboxes must not reach the VPC or IMDS.
#
# WHY (owner security fix 2026-09-24): coding session / dev containers run
# MODEL-WRITTEN code on the default docker `bridge` network. Their traffic
# leaves the box NATed from the host's ENI, which sits in the shared app
# security group — so every intra-SG rule (Redis 7856, MCP 8201-8206, SSH 22,
# the RDS endpoint) and the instance metadata service were reachable from a
# sandbox. Probed live from the shared dev container on box C: Redis on A
# answered `+PONG` with no password and IMDS returned the instance-role
# credential list (which unlock the DB secret store).
#
# WHAT: an idempotent iptables chain DIGBY-SANDBOX-EGRESS, jumped to from the
# top of DOCKER-USER (the hook Docker reserves for operators and never flushes):
#   allow  bridge → VPC resolver :53 (docker copies the host's upstream DNS)
#   reject bridge → 169.254.169.254 (IMDS; IMDSv2 hop-limit 1 is the 2nd lock)
#   reject bridge → the VPC CIDR (peers' published ports, RDS, SSH, ALB)
# plus an INPUT-side chain DIGBY-SANDBOX-INPUT for the box's OWN host
# services: traffic from the bridge interface (docker0) to the host is not
# forwarded, so DOCKER-USER never sees it — a sandbox could still reach
# sshd on 172.17.0.1:22 / <host-ip>:22, a published Redis, MCP or Adminer
# port. Those host ports are rejected from docker0 (SENSITIVE_HOST_PORTS).
# Everything else (internet, tailnet, docker DNS) is untouched. App containers
# live on the compose network (crossmodel_admin-network), not `bridge`, so
# they are NOT governed by this chain.
#
# HOW: run as root on every box after docker is up. Re-run freely (flush +
# rebuild). `--install-unit` also writes a systemd oneshot that re-applies it
# after every reboot (iptables rules are not persisted otherwise). deploy
# scripts call it on every wave. Kill switch: SANDBOX_EGRESS_GUARD_DISABLED=1
# removes the chain and exits 0.
#
# Test harness: sandbox-egress-guard.test.sh (IPT/DOCKER shims — no root).
set -euo pipefail

CHAIN=DIGBY-SANDBOX-EGRESS
INCHAIN=DIGBY-SANDBOX-INPUT
BRIDGE_IF=${DIGBY_BRIDGE_IF:-docker0}
# Host ports a sandbox must never reach on its own box: ssh, docker proxy,
# redis (compose + published), retired postgres, adminer, backend/frontend
# colours, relay peers, MCP servers, postgres.
SENSITIVE_HOST_PORTS=${DIGBY_SENSITIVE_HOST_PORTS:-22,2375,6379,7856,9384,9521,4001:4002,8248:8249,4301:4302,8200:8206,5432}
IPT=${IPT:-iptables}
DOCKER=${DOCKER:-docker}
VPC_CIDR=${DIGBY_VPC_CIDR:-10.60.0.0/16}
IMDS=169.254.169.254/32
UNIT=/etc/systemd/system/digby-sandbox-egress-guard.service
SELF=$(readlink -f "${BASH_SOURCE[0]}")

log() { echo "sandbox-egress-guard: $*"; }

bridge_subnets() {
  # Every IPv4 subnet of the default bridge (normally one, 172.17.0.0/16).
  $DOCKER network inspect bridge --format '{{range .IPAM.Config}}{{.Subnet}}{{"\n"}}{{end}}' 2>/dev/null | grep -E '^[0-9]+\.' || true
}

resolver_ips() {
  # The upstream resolvers docker hands to bridge containers (host resolved's
  # uplinks; falls back to the VPC base+2 address). SANDBOX_EGRESS_DNS (space/
  # comma-separated IPv4s) pins them explicitly — the test harness sets it so
  # the pins do not depend on the runner's own resolvers (deploy #2188 failed
  # the "DNS udp allow present" pin on a GitHub runner whose resolved uplink
  # replaced the VPC base+2 fallback the pin expects).
  local ips
  if [ -n "${SANDBOX_EGRESS_DNS:-}" ]; then
    echo "$SANDBOX_EGRESS_DNS" | tr ' ,' '\n\n' | grep -E '^[0-9]+\.' | sort -u
    return
  fi
  ips=$( (resolvectl status 2>/dev/null | awk '/DNS Servers:/{for(i=3;i<=NF;i++)print $i}'; grep -E '^nameserver' /run/systemd/resolve/resolv.conf 2>/dev/null | awk '{print $2}') | grep -E '^[0-9]+\.' | sort -u )
  if [ -z "$ips" ]; then
    local base; base=${VPC_CIDR%/*}
    ips=$(echo "$base" | awk -F. '{printf "%s.%s.%s.%d\n",$1,$2,$3,$4+2}')
  fi
  echo "$ips"
}

remove_chain() {
  while $IPT -C DOCKER-USER -j "$CHAIN" 2>/dev/null; do $IPT -D DOCKER-USER -j "$CHAIN"; done
  $IPT -F "$CHAIN" 2>/dev/null || true
  $IPT -X "$CHAIN" 2>/dev/null || true
  while $IPT -C INPUT -j "$INCHAIN" 2>/dev/null; do $IPT -D INPUT -j "$INCHAIN"; done
  $IPT -F "$INCHAIN" 2>/dev/null || true
  $IPT -X "$INCHAIN" 2>/dev/null || true
}

if [ "${SANDBOX_EGRESS_GUARD_DISABLED:-0}" = "1" ]; then
  remove_chain
  log "DISABLED by env — chain removed"
  exit 0
fi

subnets=$(bridge_subnets)
if [ -z "$subnets" ]; then
  log "no IPv4 subnet on the docker bridge network — nothing to guard (docker down?)"
  exit 0
fi

# Build the chain fresh, then swap the jump in atomically enough for our purpose.
$IPT -N "$CHAIN" 2>/dev/null || $IPT -F "$CHAIN"
for net in $subnets; do
  for dns in $(resolver_ips); do
    $IPT -A "$CHAIN" -s "$net" -d "$dns/32" -p udp --dport 53 -j RETURN
    $IPT -A "$CHAIN" -s "$net" -d "$dns/32" -p tcp --dport 53 -j RETURN
  done
  $IPT -A "$CHAIN" -s "$net" -d "$IMDS" -j REJECT --reject-with icmp-port-unreachable
  $IPT -A "$CHAIN" -s "$net" -d "$VPC_CIDR" -j REJECT --reject-with icmp-port-unreachable
done
$IPT -A "$CHAIN" -j RETURN
$IPT -C DOCKER-USER -j "$CHAIN" 2>/dev/null || $IPT -I DOCKER-USER 1 -j "$CHAIN"

# Host-side: sandbox → this box's own sensitive ports (INPUT path).
$IPT -N "$INCHAIN" 2>/dev/null || $IPT -F "$INCHAIN"
$IPT -A "$INCHAIN" -i "$BRIDGE_IF" -p tcp -m multiport --dports "$SENSITIVE_HOST_PORTS" -j REJECT --reject-with tcp-reset
$IPT -A "$INCHAIN" -j RETURN
$IPT -C INPUT -j "$INCHAIN" 2>/dev/null || $IPT -I INPUT 1 -j "$INCHAIN"
log "applied: bridge=$(echo $subnets | tr '\n' ' ') vpc=$VPC_CIDR dns=$(resolver_ips | tr '\n' ' ') host-ports-rejected-from-$BRIDGE_IF=$SENSITIVE_HOST_PORTS"

if [ "${1:-}" = "--install-unit" ]; then
  cat > "$UNIT" <<UNIT
[Unit]
Description=Digby sandbox egress guard (coding sandboxes must not reach the VPC or IMDS)
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
ExecStart=/usr/bin/env bash $SELF
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
UNIT
  systemctl daemon-reload
  systemctl enable digby-sandbox-egress-guard.service >/dev/null 2>&1 || true
  log "systemd unit installed + enabled ($UNIT → $SELF)"
fi
