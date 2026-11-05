#!/usr/bin/env bash
# turn-plan-scripts.test.sh — the dynamic-roster ops scripts (2026-10-03): the offline
# replay, the live readout and the canary writer. No network, no /app/dist: syntax,
# the pure helpers, and the privacy contract (the replay's per-row tuples are numbers
# and lane names only — no message text, no ids).
set -u
cd "$(dirname "$0")"
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ok: $1"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL: $1"; }

echo "== syntax =="
for f in replay-turn-plan.js turn-plan-readout.js set-turn-plan-canary.js; do
  if node --check "$f" 2>/dev/null; then ok "node --check $f"; else bad "node --check $f"; fi
done

echo "== replay helpers =="
node -e '
const m = require("./replay-turn-plan.js");
const fail = (x) => { console.error(x); process.exit(1); };
if (m.parseLane("thinking it over…\nLANE: Checked") !== "checked") fail("parseLane last LANE line");
if (m.parseLane("LANE: quick | standard") !== "quick") fail("parseLane first option on the LANE line");
if (m.parseLane("no idea") !== null) fail("parseLane null");
const w = m.wilson(8, 8); if (!w || w[0] !== 1 || w[1] < 0.67 || w[1] > 0.69) fail("wilson 8/8 lower bound ≈ 0.676: " + JSON.stringify(w));
if (m.wilson(0, 0) !== null) fail("wilson n=0");
if (!/LANE: quick \| standard \| checked \| research/.test(m.JUDGE)) fail("judge rubric asks for the LANE line");
const lm = {}; const c = m.stubTelemetry(lm); lm.recordLoopMetric({}); lm.recordLoopMetrics([{}, {}]); if (c.rows !== 3) fail("telemetry stub counts rows");
' && ok "parseLane / wilson / judge rubric / telemetry stub" || bad "replay helpers"

echo "== replay v3 (2026-10-20): the lookup-ceiling grid dimension =="
node -e '
const m = require("./replay-turn-plan.js");
const fail = (x) => { console.error(x); process.exit(1); };
if (JSON.stringify(m.LOOKUP_CEILINGS) !== JSON.stringify([0.6, 0.65, 0.7, 0.75, 0.8])) fail("LOOKUP_CEILINGS pinned: " + JSON.stringify(m.LOOKUP_CEILINGS));
// A stand-in for the production rule: a pure lookup (cls.lookup) is held to lookupStakesCeiling when the guards carry one above the base.
const elig = (cls, ctx, g) => {
  const relax = typeof g.lookupStakesCeiling === "number" && g.lookupStakesCeiling > g.stakesCeiling && cls.lookup;
  const ceil = relax ? g.lookupStakesCeiling : g.stakesCeiling;
  if (cls.p < g.threshold || cls.stakes >= ceil) return { ok: false, why: "x" };
  return relax && cls.stakes >= g.stakesCeiling ? { ok: true, why: "y", lookupStakes: true } : { ok: true, why: "y" };
};
const rows = [
  { cls: { p: 0.95, stakes: 0.62, lookup: true }, chars: 30, preset: "single_thinking", code: false, judge: "quick" },
  { cls: { p: 0.95, stakes: 0.81, lookup: true }, chars: 30, preset: "single_thinking", code: false, judge: "checked" },
  { cls: { p: 0.95, stakes: 0.3, lookup: false }, chars: 30, preset: "single_thinking", code: false, judge: "quick" },
];
const g = m.guardGrid(rows, elig);
if (g.length !== 288) fail("6 taus x 5 stakes x 3 contested x (off + every lookup ceiling above the base) = 288 cells: " + g.length);
if (g.filter((c) => c.lCeil === "off").length !== 90) fail("every (tau, stakes, contested) cell has an off row");
if (g.some((c) => c.lCeil !== "off" && !(c.lCeil > c.sCeil))) fail("a lookup cell only above its base ceiling");
const off = g.find((c) => c.tau === 0.8 && c.sCeil === 0.6 && c.cCeil === 0.5 && c.lCeil === "off");
const on = g.find((c) => c.tau === 0.8 && c.sCeil === 0.6 && c.cCeil === 0.5 && c.lCeil === 0.75);
if (!off || off.n !== 1 || off.relaxed !== 0) fail("off = the base rule only: " + JSON.stringify(off));
if (!on || on.n !== 2 || on.relaxed !== 1 || on.relaxedUnsafe !== 0 || on.unsafe !== 0) fail("0.75 admits the 0.62 lookup, not the 0.81 one: " + JSON.stringify(on));
const hi = g.find((c) => c.tau === 0.8 && c.sCeil === 0.5 && c.cCeil === 0.5 && c.lCeil === 0.8);
if (!hi || hi.relaxed !== 1) fail("relaxed counts only rows the base would refuse: " + JSON.stringify(hi));
' && ok "guardGrid: off row per cell, lookup cells above the base, relaxed / relaxedUnsafe" || bad "replay v3 lookup grid"
if grep -q "segment: 'replay', challengers: false" replay-turn-plan.js; then ok "the replay ask is segment replay, challengers off"; else bad "replay decide() must pass segment replay + challengers false"; fi

echo "== replay privacy: per-row tuples carry no text or ids =="
if grep -q "quickRowsLegend: \['jevLane', 'pQuick', 'stakes', 'contested', 'web', 'multi', 'chars', 'judgeLane', 'ranAs', 'ttftS', 'escalated', 'codeIntent'\]" replay-turn-plan.js; then ok "legend is numeric + lane names only"; else bad "quickRows legend changed — re-check it carries no content"; fi
if grep -nE "quickRows:.*(content|message|chatId|userId|createdAt)" replay-turn-plan.js >/dev/null; then bad "quickRows maps a content / id field"; else ok "quickRows maps no content / id field"; fi

echo "== readout + canary helpers =="
node -e '
const r = require("./turn-plan-readout.js"); const c = require("./set-turn-plan-canary.js");
const fail = (x) => { console.error(x); process.exit(1); };
if (r.pct([5, 1, 3], 0.5) !== 3 || r.pct([], 0.5) !== null) fail("pct");
const a = c.parseArgs(["--apply", "a,b", "b", "c"]); if (!a.apply || a.clear || a.ids.join() !== "a,b,c") fail("parseArgs dedupes: " + JSON.stringify(a));
const d = c.parseArgs([]); if (d.apply || d.ids.length) fail("dry run by default");
const z = c.parseArgs(["--apply", "--clear"]); if (!z.clear || z.ids.length) fail("--clear");
' && ok "pct / parseArgs (dry run by default, dedupe, --clear)" || bad "readout + canary helpers"

echo "== roster 2026-10-06 B-1: backfill-turn-plan-hygiene.js =="
if node --check backfill-turn-plan-hygiene.js 2>/dev/null; then ok "node --check backfill-turn-plan-hygiene.js"; else bad "node --check backfill-turn-plan-hygiene.js"; fi
node -e '
const m = require("./backfill-turn-plan-hygiene.js");
const fail = (x) => { console.error(x); process.exit(1); };
const a = m.parseArgs([]); if (a.apply || a.revert) fail("dry run by default");
const b = m.parseArgs(["--apply", "--revert"]); if (!b.apply || !b.revert) fail("--apply --revert");
const rows = [
  { class: "supervisor", excl: "", src: "", predicted: "standard", ran: "checked" },
  { class: "counterfactual", excl: "", src: "", predicted: "standard", ran: "checked" },
  { class: "counterfactual", excl: "true", src: "tpl1006_backfill", predicted: "quick", ran: "checked" },
  { class: "ran_as_predicted", excl: "", src: "", predicted: "quick", ran: "quick" },
  { class: "unknown", excl: "", src: "", predicted: "quick", ran: null },
];
const s = m.summarize(rows);
if (s.wouldStamp !== 2) fail("wouldStamp counts supervisor + counterfactual rows not yet excluded: " + JSON.stringify(s));
if (s.counterfactualPredictedToRan["standard→checked"] !== 1 || s.counterfactualPredictedToRan["quick→checked"] !== 1) fail("lane pairs: " + JSON.stringify(s));
const sql = m.classifiedSql("o");
if (!sql.includes("isProjectSupervisor") || !sql.includes("predictedLane") || !sql.includes("turn_plan")) fail("classifies supervisor + counterfactual turn_plan rows");
if (/UPDATE|DELETE|INSERT/i.test(sql)) fail("the classifier SELECT writes nothing");
' && ok "parseArgs / summarize / classifier is a pure SELECT" || bad "backfill-turn-plan-hygiene helpers"

echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" = 0 ]
