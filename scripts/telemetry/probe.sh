#!/usr/bin/env bash
# probe.sh — read-only production telemetry for the nightly self-improvement loop.
#
# Runs a fixed aggregate suite (agent_runs, error-log message patterns,
# message_feedback, user_feature_requests) against the prod DB using the
# backend container's own Prisma client, delivered via AWS SSM.
#
# Safety contract (do not weaken):
#   - READ-ONLY: the embedded suite only reads. Custom scripts (-s) are the
#     caller's responsibility — keep them read-only too.
#   - NO SECRETS: AWS creds come from the caller's environment; nothing is
#     printed except aggregate query results.
#   - NO PII: the standard suite returns counts and normalized message
#     PATTERNS only — emails, long unbroken tokens/keys, dashed uuids and
#     numbers are masked before aggregation. Short free-text fragments of an
#     error message can survive masking; output goes only to the operator,
#     who already holds prod DB access. If you extend it, keep
#     aggregates/patterns only (never select message bodies wholesale).
#
# Usage:
#   scripts/telemetry/probe.sh                 # standard nightly suite
#   scripts/telemetry/probe.sh -s local.js     # run a custom node script (Prisma client available as `p`)
#   REGION=ca-central-1 INSTANCE_ID=i-xxx scripts/telemetry/probe.sh
#
# Why this exists (nightly self-audit finding, 2026-08-04): every nightly run
# used to re-derive the SSM access path from scratch — instance id, container
# name, Prisma model names, and the quoting pattern (nested shell quoting
# through SSM JSON parameters breaks on parentheses/quotes; base64-wrapping
# the whole remote script is the reliable pattern). That re-discovery burned
# 3-5 tool calls per night. This script is the durable version.

set -euo pipefail

REGION="${REGION:-ca-central-1}"
INSTANCE_ID="${INSTANCE_ID:-}"
INSTANCE_TAG="${INSTANCE_TAG:-example-ca-node*}"
CUSTOM_SCRIPT=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    -s|--script) [[ $# -ge 2 ]] || { echo "-s/--script needs a file argument" >&2; exit 2; }; CUSTOM_SCRIPT="$2"; shift 2 ;;
    -h|--help) sed -n '2,31p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

for bin in aws base64; do
  command -v "$bin" >/dev/null || { echo "missing dependency: $bin" >&2; exit 2; }
done

# --- The standard nightly aggregate suite (read-only, patterns only). -------
read -r -d '' STANDARD_SUITE <<'NODE' || true
// Prisma 7: the client connects through a driver adapter (no url in the
// schema) — a bare `new PrismaClient()` throws PrismaClientInitializationError
// (found 2026-08-30: the suite had been silently broken on prod since the
// Prisma 7 bump). Mirrors backend/src/config/database.ts.
const { PrismaClient } = require("@prisma/client");
const { PrismaPg } = require("@prisma/adapter-pg");
const adapter = new PrismaPg({
  connectionString: process.env.DATABASE_URL,
  ssl: /sslmode=disable/.test(process.env.DATABASE_URL || "") ? false : { rejectUnauthorized: false },
});
const p = new PrismaClient({ adapter });
const since = new Date(Date.now() - 48 * 3600e3);
const week = new Date(Date.now() - 7 * 864e5);
(async () => {
  const runs = await p.agentRun.groupBy({ by: ["status"], where: { createdAt: { gte: since } }, _count: true });
  const errRows = await p.appErrorLog.findMany({ where: { createdAt: { gte: since }, level: "error" }, select: { message: true }, take: 8000, orderBy: { createdAt: "desc" } });
  const agg = {};
  for (const r of errRows) {
    const m = (r.message || "")
      .replace(/\b\S+@\S+\.\S+\b/g, "<email>")        // emails
      .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/g, "<id>") // dashed uuids
      .replace(/\b[A-Za-z0-9_-]{20,}\b/g, "<tok>")    // long unbroken tokens/keys/hex (jwt, api keys, cuids)
      .replace(/\d+/g, "<n>")                          // numbers
      .slice(0, 70);
    agg[m] = (agg[m] || 0) + 1;
  }
  const errTop = Object.entries(agg).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([pat, n]) => ({ pat, n }));
  const fb = await p.messageFeedback.groupBy({ by: ["type", "reason"], where: { createdAt: { gte: week } }, _count: true });
  const fr = await p.userFeatureRequest.groupBy({ by: ["status"], _count: true });
  console.log("RESULT:" + JSON.stringify({
    runs48h: runs.map(r => ({ s: r.status, n: r._count })),
    errlog48hTotal: errRows.length,
    errTop,
    feedback7d: fb.map(f => ({ t: f.type, r: f.reason, n: f._count })),
    featureRequestsByStatus: fr.map(f => ({ s: f.status, n: f._count })),
  }));
  await p.$disconnect();
})().catch(e => { console.log("ERR", e.message.split("\n").pop()); process.exit(1); });
NODE

if [[ -n "$CUSTOM_SCRIPT" ]]; then
  [[ -f "$CUSTOM_SCRIPT" ]] || { echo "no such file: $CUSTOM_SCRIPT" >&2; exit 2; }
  NODE_SRC="$(cat "$CUSTOM_SCRIPT")"
else
  NODE_SRC="$STANDARD_SUITE"
fi

# --- Discover the prod app host (running, tagged example-ca-node*). -----------
if [[ -z "$INSTANCE_ID" ]]; then
  INSTANCE_ID=$(aws ec2 describe-instances --region "$REGION" \
    --filters "Name=tag:Name,Values=$INSTANCE_TAG" "Name=instance-state-name,Values=running" \
    --query 'Reservations[].Instances[].InstanceId' --output text | awk '{print $1}')
fi
[[ -n "$INSTANCE_ID" && "$INSTANCE_ID" != "None" ]] || { echo "no running instance matching tag $INSTANCE_TAG in $REGION" >&2; exit 1; }
echo "target: $INSTANCE_ID ($REGION)" >&2

# --- Build the remote script and base64-wrap it (SSM-quoting-proof). --------
# Nested quoting through SSM's JSON parameters mangles parentheses/quotes;
# shipping the whole remote script as one base64 blob avoids every layer.
NODE_B64=$(printf '%s' "$NODE_SRC" | base64 | tr -d '\n')
REMOTE="CID=\$(docker ps --format '{{.Names}}' | grep -E 'backend' | head -1)
echo $NODE_B64 | base64 -d > /tmp/nightly-probe.js
docker cp /tmp/nightly-probe.js \$CID:/app/nightly-probe.js
docker exec -w /app \$CID node nightly-probe.js
RC=\$?
docker exec \$CID rm -f /app/nightly-probe.js >/dev/null 2>&1 || true
rm -f /tmp/nightly-probe.js
exit \$RC"
OUTER_B64=$(printf '%s' "$REMOTE" | base64 | tr -d '\n')

CMD_ID=$(aws ssm send-command --region "$REGION" --instance-ids "$INSTANCE_ID" \
  --document-name "AWS-RunShellScript" --timeout-seconds 300 \
  --parameters "commands=[\"echo $OUTER_B64 | base64 -d | bash\"],executionTimeout=[\"300\"]" \
  --query 'Command.CommandId' --output text)
echo "ssm command: $CMD_ID" >&2

# --- Poll to terminal status. -------------------------------------------------
STATUS="InProgress"
for _ in $(seq 1 40); do
  sleep 4
  STATUS=$(aws ssm get-command-invocation --region "$REGION" --command-id "$CMD_ID" \
    --instance-id "$INSTANCE_ID" --query 'Status' --output text 2>/dev/null || echo "Pending")
  case "$STATUS" in Success|Failed|Cancelled|TimedOut) break ;; esac
done

OUT=$(aws ssm get-command-invocation --region "$REGION" --command-id "$CMD_ID" \
  --instance-id "$INSTANCE_ID" --query 'StandardOutputContent' --output text)
if [[ "$STATUS" != "Success" ]]; then
  ERR=$(aws ssm get-command-invocation --region "$REGION" --command-id "$CMD_ID" \
    --instance-id "$INSTANCE_ID" --query 'StandardErrorContent' --output text)
  echo "probe failed (status=$STATUS)" >&2
  echo "$OUT" >&2; echo "$ERR" >&2
  exit 1
fi
echo "$OUT"
