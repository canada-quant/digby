#!/bin/bash
# box-readout.sh — READ-ONLY host readout for any box: containers, backend health, disk, memory, recent kernel errors.
# Usage: bash /opt/crossmodel/scripts/framework-audit/box-readout.sh
set -uo pipefail
echo "=== uptime"; uptime
echo "=== containers"; sudo docker ps --format "{{.Names}}\t{{.Status}}" | sort
echo "=== backend health"; for p in 4001 4002; do echo -n "$p: "; curl -s -m 8 "http://localhost:$p/api/health" | cut -c1-160; echo; done
echo "=== mem/disk"; free -m | head -2; df -h / | tail -1
echo "=== recent kernel/system errors (this boot)"; sudo journalctl -b -p 3 --no-pager 2>/dev/null | tail -15 | cut -c1-200 || true
echo "=== OOM traces (this boot)"
# Exit-status contract: 0 = the readout RAN, not "no OOM found". With `set -o pipefail`,
# a zero-match grep (the HEALTHY case — no OOM traces) exits 1 and made every clean box
# report "remote status: Failed", indistinguishable from a broken probe (Framework
# Operator run 1, 2026-09-21: the reach-proof on a healthy A came back Failed for
# exactly this reason). The OOM verdict is read from stdout, never from the exit code.
sudo journalctl -b --no-pager 2>/dev/null | grep -iE "out of memory|oom-kill|killed process" | tail -5 | cut -c1-200 || true
exit 0
