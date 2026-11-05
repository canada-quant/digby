#!/usr/bin/env bash
# lane-depth-scripts.test.sh — the roster 2026-10-06 Team A ops scripts: the lane-depth flag writer and the
# minimum-sufficient-lane replay. No network, no /app/dist: syntax, the pure helpers, and the privacy contract
# (the replay prints aggregates only — no message text, no ids).
set -u
cd "$(dirname "$0")"
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ok: $1"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL: $1"; }

echo "== syntax =="
for f in set-lane-depth.js replay-min-lane.js; do
  if node --check "$f" 2>/dev/null; then ok "node --check $f"; else bad "node --check $f"; fi
done

echo "== set-lane-depth helpers =="
node -e '
const m = require("./set-lane-depth.js");
const fail = (x) => { console.error(x); process.exit(1); };
const d = m.parseArgs([]); if (d.apply || !d.valid || Object.keys(d.modes).length) fail("dry run by default: " + JSON.stringify(d));
const a = m.parseArgs(["--apply", "--checker", "act", "--fail-open", "off"]);
if (!a.valid || a.modes.laneChecker !== "act" || a.modes.laneFailOpen !== "off" || a.modes.laneResearch) fail("modes parse: " + JSON.stringify(a));
if (m.parseArgs(["--apply", "--research", "bogus"]).valid) fail("unknown mode refused");
if (m.parseArgs(["--apply"]).valid) fail("nothing to apply refused");
if (m.parseArgs(["--apply", "--canary-clear", "--canary-default"]).valid) fail("two canary ops refused");
const c = m.parseArgs(["--apply", "--canary", "a,b,a"]); if (!c.valid || c.canary.join() !== "a,b") fail("canary dedupes: " + JSON.stringify(c));
const before = { actCanaryUserIds: ["x"], modelPick: "act", laneCanaryUserIds: ["y"] };
const n1 = m.nextRow(before, a, "T"); if (n1.modelPick !== "act" || n1.actCanaryUserIds[0] !== "x" || n1.laneChecker !== "act" || n1.laneCanaryUserIds[0] !== "y" || n1.laneUpdatedAt !== "T") fail("other fields kept: " + JSON.stringify(n1));
const n2 = m.nextRow(before, m.parseArgs(["--apply", "--canary-default"]), "T"); if ("laneCanaryUserIds" in n2) fail("canary-default removes the field");
const n3 = m.nextRow(before, m.parseArgs(["--apply", "--canary-clear"]), "T"); if (n3.laneCanaryUserIds.length !== 0) fail("canary-clear = []");
const e = m.effective({}); if (e.checker !== "shadow" || e.research !== "shadow" || e.failOpen !== "shadow" || !String(e.canary[0]).startsWith(m.OWNER)) fail("defaults: shadow + the owner canary " + JSON.stringify(e));
' && ok "parseArgs / nextRow / effective" || bad "set-lane-depth helpers"

echo "== replay-min-lane helpers =="
node -e '
const m = require("./replay-min-lane.js");
const fail = (x) => { console.error(x); process.exit(1); };
const cls = m.clsFromRecord({ laneProbs: { quick: 0.1, standard: 0.6, checked: 0.3, research: 0 }, traits: { stakes: 0.2, contested: 0.1, breadth: 2 } });
if (!cls || cls.lane !== "standard" || Math.abs(cls.laneConfidence - 0.6) > 1e-9 || cls.stakes !== 0.2 || cls.breadth !== 2) fail("clsFromRecord: " + JSON.stringify(cls));
if (m.clsFromRecord(null) !== null || m.clsFromRecord({ laneProbs: {} }) !== null) fail("clsFromRecord null");
// a stand-in decision (drop when stakes < ceiling) — the grid only counts what the production function returns
const dec = (c, g) => ({ spawnChecker: !((c.stakes ?? 0) < g.stakesCeiling) });
const rows = [
  { cls: { stakes: 0.1 }, judge: "standard", material: "nothing_material" },
  { cls: { stakes: 0.2 }, judge: "quick", material: null },
  { cls: { stakes: 0.3 }, judge: "checked", material: "material" },
  { cls: null, judge: "standard" },
];
const g = m.checkerGrid(rows, dec);
const cell = g.find((x) => x.stakes === 0.5 && x.lower === 0.8 && x.contested === 0.5);
if (!cell || cell.n !== 3 || cell.judged !== 3 || cell.unsafe !== 1 || cell.materialLabelled !== 2 || cell.materialContradicted !== 1) fail("checkerGrid cell: " + JSON.stringify(cell));
const rec = m.recommendChecker([{ lower: 0.8, stakes: 0.6, contested: 0.5, n: 10, precision: [0.9, 0.8, 0.95], unsafe: 0, materialLabelled: 0, materialContradicted: 0 }, { lower: 0.6, stakes: 1, contested: 1, n: 40, precision: [0.6, 0.5, 0.7], unsafe: 5, materialLabelled: 0, materialContradicted: 0 }], null);
if (!rec || rec.n !== 10) fail("recommendChecker picks the safe cell: " + JSON.stringify(rec));
const rdec = (c, o) => ({ route: c.r >= o.guards.threshold ? "research" : "not_research" });
const rg = m.researchGrid([{ cls: { r: 0.55 }, judge: "research" }, { cls: { r: 0.35 }, judge: "research" }, { cls: { r: 0.45 }, judge: "standard" }], rdec);
const r5 = rg.find((x) => x.threshold === 0.5 && x.explicitFloor === 0.2); if (!r5 || r5.n !== 1 || r5.missedJudgedResearch !== 1) fail("researchGrid: " + JSON.stringify(r5));
const t = m.table([{ a: "quick", b: "standard" }, { a: null, b: "quick" }], "a", "b"); if (t.quick.standard !== 1 || t.none.quick !== 1) fail("table");
' && ok "clsFromRecord / grids / recommendations / table" || bad "replay-min-lane helpers"

echo "== replay privacy: aggregates only =="
if grep -nE "console\.log\(JSON\.stringify\(\{[^}]*(content|message|chatId|userId|createdAt)" replay-min-lane.js | grep -v "error:" >/dev/null; then bad "the printed object maps a content / id field"; else ok "the printed object maps no content / id field"; fi
# The printed result block (from the console.log to the telemetry counter) names no row content / id field.
if sed -n '/console.log(JSON.stringify({$/,/telemetryRowsSuppressed/p' replay-min-lane.js | grep -nE "\b(content|acontent|chatId|userId|createdAt)\b" >/dev/null; then bad "the result block maps a content / id field"; else ok "the result block maps no content / id field"; fi
if grep -q "segment: 'replay'" replay-min-lane.js; then ok "re-asks are the non-human replay segment"; else bad "re-ask segment"; fi

echo "lane-depth-scripts.test.sh: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
