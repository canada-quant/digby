#!/usr/bin/env bash
# backtest-auto-route.test.sh — harness for the patience-plan §4.5 replay probe.
# No network, no /app/dist: `node --check`, the --dry-run (synthetic corpus + stubbed Prisma +
# stubbed decide) and a --merge of the dry-run's own jsonl. Pins: exit 0, one JSON report,
# scored + skipped == corpus rows, the verdict table names every §4.6 metric, and the report
# never carries message text, a user id or a chat id (the synthetic corpus plants markers).
set -u
cd "$(dirname "$0")"
SBX=$(mktemp -d); trap 'rm -rf "$SBX"' EXIT
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ok: $1"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL: $1"; }
PROBE=backtest-auto-route.js

echo "== syntax =="
if node --check "$PROBE" 2>"$SBX/check.err"; then ok "node --check"; else bad "node --check: $(head -c 200 "$SBX/check.err")"; fi

echo "== dry run =="
node "$PROBE" --dry-run --out-dir "$SBX/out" >"$SBX/dry.json" 2>"$SBX/dry.err"; rc=$?
[ "$rc" = 0 ] && ok "exit 0" || bad "exit $rc: $(head -c 300 "$SBX/dry.err")"
node -e '
const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
const fail = (m) => { console.error(m); process.exit(1); };
if (r.probe !== "backtest-auto-route") fail("probe name");
if (!Array.isArray(r.verdicts) || r.verdicts.length < 17) fail("verdict table short: " + (r.verdicts || []).length);
const skipped = Object.values(r.rows.skipped).reduce((s, v) => s + v, 0);
if (r.rows.scored + skipped !== r.dryRun.corpusRows) fail(`scored ${r.rows.scored} + skipped ${skipped} != corpus ${r.dryRun.corpusRows}`);
if (r.dryRun.batches.length < 2 || !r.dryRun.batches[r.dryRun.batches.length - 1].done) fail("batches did not finish");
for (const m of ["Telemetry coverage","Decision error rate","Decision latency p95","Coverage at threshold","Agreement with heuristic","Non-inferiority vs heuristic on U","L3 recall","Over-escalation (gate L3 where U = L1)","Under-escalation (gate L1 where U = L3)","Calibration","L3 promotion under act","Cost (measured)","Former-L1 cohort latency","Guest segment","Post-1b re-check"]) {
  if (!r.verdicts.some(v => v.metric === m)) fail("missing verdict: " + m);
}
for (const v of r.verdicts) if (!["pass","fail","n/a","diagnostic","reported"].includes(v.verdict)) fail("bad verdict value " + v.verdict);
if (!r.confusion.U_x_gateAt || !r.confusion.U_x_H || !r.confusion.H_x_gateAt) fail("confusion matrices missing");
if (typeof r.nonInferiority.lower95Pp !== "number") fail("non-inferiority bound missing");
if (typeof r.escalation.overEscalation.wilson95[1] !== "number") fail("wilson bound missing");
if (typeof r.calibration.vsU.eceTopLabel !== "number") fail("ece missing");
if (typeof r.decision.latencyMs.p95 !== "number") fail("latency missing");
if (typeof r.shift.researchIntentShare !== "number") fail("shift metric missing");
if (r.users.distinctAll < 2) fail("distinct users missing");
if (!r.rows.createdAt.min || !r.rows.createdAt.max) fail("createdAt bounds missing");
console.log(`  report ok: scored=${r.rows.scored} batches=${r.dryRun.batches.length} verdicts=${r.verdicts.length}`);
' "$SBX/dry.json" && ok "report shape + arithmetic" || bad "report shape + arithmetic"
if grep -q "SYNTHETIC-PRIVATE-MARKER" "$SBX/dry.json"; then bad "message text leaked"; else ok "no message text in the report"; fi
if grep -q '"user-' "$SBX/dry.json"; then bad "user id leaked"; else ok "no user id in the report"; fi
if grep -q '"chat-0' "$SBX/dry.json"; then bad "chat id leaked"; else ok "no chat id in the report"; fi
if grep -q '"content"' "$SBX/dry.json"; then bad "content key present"; else ok "no content key in the report"; fi

echo "== merge =="
node "$PROBE" --merge "$SBX/out/dry-run.jsonl" >"$SBX/merge.json" 2>"$SBX/merge.err"; rc=$?
[ "$rc" = 0 ] && ok "merge exit 0" || bad "merge exit $rc: $(head -c 300 "$SBX/merge.err")"
node -e '
const a = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
const b = JSON.parse(require("fs").readFileSync(process.argv[2], "utf8"));
if (a.rows.scored !== b.rows.scored) { console.error("scored differs"); process.exit(1); }
if (JSON.stringify(a.confusion) !== JSON.stringify(b.confusion)) { console.error("confusion differs"); process.exit(1); }
if (a.nonInferiority.lower95Pp !== b.nonInferiority.lower95Pp) { console.error("bound differs"); process.exit(1); }
if (!b.source || b.source.batches < 2) { console.error("merge source missing"); process.exit(1); }
' "$SBX/dry.json" "$SBX/merge.json" && ok "merge reproduces the dry-run report" || bad "merge reproduces the dry-run report"

echo "== usage =="
node "$PROBE" --bogus >/dev/null 2>"$SBX/usage.err"; rc=$?
[ "$rc" = 2 ] && ok "unknown flag exits 2" || bad "unknown flag exit $rc"
node "$PROBE" 30 jev >/dev/null 2>"$SBX/live.err"; rc=$?
[ "$rc" = 3 ] && ok "no /app/dist exits 3" || bad "no /app/dist exit $rc: $(head -c 200 "$SBX/live.err")"

echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" = 0 ]
