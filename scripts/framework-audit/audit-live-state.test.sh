#!/bin/bash
# audit-live-state.test.sh — F153 regression (2026-10-17): the probe's tail
# guard keeps the audit under the box transport's ~64 KiB silent-truncation
# ceiling, emits defect_rollup / defect_rollup_graded FIRST, and prints an
# __AUDIT_END__ sentinel. Before the fix, f152's audit was 61,413 B (complete)
# and f153's crossed the ceiling: the box-side parked file was 65,537 B, cut
# mid-JSON, losing exactly the two rollup sections the firing reads first.
#
# Runs the REAL probe with a stubbed prisma (Module._load patch — no DB, no
# box) in two scenarios: quiet (every query returns []) and fat (every query
# returns 40 x ~250 B rows, forcing the trimmer).
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
probe="$here/audit-live-state.js"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT

cat > "$tmp/stub-empty.js" <<'JS'
const M = require('module');
const orig = M._load;
M._load = function (request, ...rest) {
  if (request === '/app/dist/config/database') {
    return { default: { $queryRawUnsafe: async () => [] } };
  }
  return orig.call(this, request, ...rest);
};
JS

cat > "$tmp/stub-fat.js" <<'JS'
const M = require('module');
const orig = M._load;
const row = { msg: 'x'.repeat(220), source: 'stub', n: 40, last: '2026-10-17T00:00:00.000Z', chat: 'deadbeef', title: 'fat-row' };
M._load = function (request, ...rest) {
  if (request === '/app/dist/config/database') {
    return { default: { $queryRawUnsafe: async () => Array.from({ length: 40 }, () => ({ ...row })) } };
  }
  return orig.call(this, request, ...rest);
};
JS

check_common () { # $1 = probe-output file, $2 = label
  local out_file="$1" label="$2"
  grep -q '^__AUDIT_END__ bytes=' "$out_file" || { echo "FAIL[$label]: __AUDIT_END__ sentinel missing"; exit 1; }
  node -e '
    const fs = require("fs");
    const raw = fs.readFileSync(process.argv[1], "utf8");
    const end = raw.lastIndexOf("\n__AUDIT_END__");
    if (end < 0) { console.error("FAIL[" + process.argv[2] + "]: sentinel line not found"); process.exit(1); }
    const j = JSON.parse(raw.slice(0, end));
    const keys = Object.keys(j);
    if (keys[0] !== "defect_rollup") { console.error("FAIL[" + process.argv[2] + "]: first key is " + keys[0] + ", want defect_rollup"); process.exit(1); }
    if (keys[1] !== "defect_rollup_graded") { console.error("FAIL[" + process.argv[2] + "]: second key is " + keys[1] + ", want defect_rollup_graded"); process.exit(1); }
    // The trimmer invariant: everything OUTSIDE the never-trim set fits the
    // 60000 B budget (never-trim sections are tiny by design in real audits —
    // jwt 2 rows, box_health 4 — and are exempt on purpose).
    const NEVER = ["jwt_spike_watch_4h", "box_health", "backup_fleet", "auth_login_failures_4h", "auth_login_failures_by_email_4h", "schedules_trouble", "schedules_enabled"];
    const neverBytes = NEVER.reduce((s, k) => s + (j[k] ? Buffer.byteLength(JSON.stringify(j[k], null, 1)) : 0), 0);
    const bytes = Buffer.byteLength(raw.slice(0, end));
    const trimmableBytes = bytes - neverBytes;
    if (trimmableBytes > 60000) { console.error("FAIL[" + process.argv[2] + "]: trimmable payload " + trimmableBytes + " > 60000 budget (total " + bytes + ", never-trim " + neverBytes + ")"); process.exit(1); }
    console.log(process.argv[2] + ": parse OK, rollups first, trimmableBytes=" + trimmableBytes + (j._trimmed ? ", trimmed=" + Object.keys(j._trimmed).length + " section(s)" : ""));
  ' "$out_file" "$label"
}

echo "case 1: quiet DB (all queries empty)"
node -r "$tmp/stub-empty.js" "$probe" 2026-10-17T10:00:00Z > "$tmp/empty.out" 2>"$tmp/empty.err"
check_common "$tmp/empty.out" "quiet-DB"
grep -q '^audit_bytes=' "$tmp/empty.err" && echo "quiet-DB: stderr byte log present ($(head -c 80 "$tmp/empty.err"))"

echo "case 2: fat DB (40 x ~250 B rows per query — trimmer must engage)"
node -r "$tmp/stub-fat.js" "$probe" 2026-10-17T10:00:00Z > "$tmp/fat.out" 2>"$tmp/fat.err"
check_common "$tmp/fat.out" "fat-DB"
node -e '
  const fs = require("fs");
  const raw = fs.readFileSync(process.argv[1], "utf8");
  const j = JSON.parse(raw.slice(0, raw.lastIndexOf("\n__AUDIT_END__")));
  if (!j._trimmed || !Object.keys(j._trimmed).length) { console.error("FAIL[fat-DB]: trimmer not exercised (_trimmed missing)"); process.exit(1); }
  for (const [k, t] of Object.entries(j._trimmed)) {
    if (typeof t.kept !== "number" || typeof t.dropped !== "number" || t.dropped < 1) {
      console.error("FAIL[fat-DB]: bad _trimmed entry for " + k + ": " + JSON.stringify(t)); process.exit(1);
    }
  }
  console.log("fat-DB: trimmer exercised, _trimmed well-formed (" + Object.keys(j._trimmed).length + " sections)");
' "$tmp/fat.out"

echo "case 3: escalated-tail rollup (f161 bake — an ESCALATE condition at the alphabetical tail must survive the tail trimmer)"
cat > "$tmp/stub-escalate.js" <<'JS'
const M = require('module');
const orig = M._load;
const pad = 'x'.repeat(200);
M._load = function (request, ...rest) {
  if (request === '/app/dist/config/database') {
    return { default: { $queryRawUnsafe: async (sql) => {
      const s = String(sql);
      // The defect_rollup conditions query is the only one with this rung.
      if (s.includes('merge_gate_failure_dangling_24h')) {
        const rows = [];
        for (let i = 0; i < 300; i++) rows.push({ cond: 'aa_ok_' + String(i).padStart(3, '0'), n: 0, verdict: 'ok', pad });
        for (let i = 0; i < 10; i++) rows.push({ cond: 'zz_escalated_' + i, n: 5, verdict: 'ESCALATE', pad });
        return rows; // SQL's ORDER BY cond would put the ESCALATE rows at the tail
      }
      return [];
    } } };
  }
  return orig.call(this, request, ...rest);
};
JS
node -r "$tmp/stub-escalate.js" "$probe" 2026-10-17T10:00:00Z > "$tmp/esc.out" 2>"$tmp/esc.err"
check_common "$tmp/esc.out" "escalate-tail"
node -e '
  const fs = require("fs");
  const raw = fs.readFileSync(process.argv[1], "utf8");
  const j = JSON.parse(raw.slice(0, raw.lastIndexOf("\n__AUDIT_END__")));
  const kept = j.defect_rollup.conditions;
  const keptEsc = kept.filter((c) => c.verdict === "ESCALATE");
  if (keptEsc.length !== 10) { console.error("FAIL[escalate-tail]: kept ESCALATE rows " + keptEsc.length + ", want 10 — the tail trimmer cut an escalated condition"); process.exit(1); }
  if (kept[0].verdict !== "ESCALATE") { console.error("FAIL[escalate-tail]: first kept condition is " + kept[0].cond + " (" + kept[0].verdict + "), want an ESCALATE row at the head"); process.exit(1); }
  if (!j._trimmed || !j._trimmed.defect_rollup) { console.error("FAIL[escalate-tail]: trimmer not exercised on defect_rollup"); process.exit(1); }
  const names = j.defect_rollup.overall.escalated;
  if (!names || names.length !== 10 || !names.every((n) => keptEsc.some((c) => c.cond === n))) { console.error("FAIL[escalate-tail]: overall.escalated names a row missing from conditions"); process.exit(1); }
  console.log("escalate-tail: all 10 ESCALATE rows survived the trim at the head (kept " + kept.length + ", dropped " + j._trimmed.defect_rollup.dropped + ")");
' "$tmp/esc.out"

echo "audit-live-state.test.sh: ALL PASS"

echo "case 4: stale-hook verdict arms — scheduled:future present + three-site parity (f81/f172/f174 drift pin)"
cat > "$tmp/arm-parity.js" <<'JS'
const src = require("fs").readFileSync(process.argv[2], "utf8");
const blocks = (src.match(/CASE WHEN[\s\S]*?END AS verdict/g) || []).filter((b) => b.includes("parked:triage"));
if (blocks.length !== 3) { console.error("FAIL[arm-parity]: found " + blocks.length + " stale-hook verdict chains, want 3"); process.exit(1); }
const chains = blocks.map((b) => Array.from(b.matchAll(/(?:THEN|ELSE)\s+'([A-Za-z_:]+)'/g), (m) => m[1]));
const want = JSON.stringify(["ok", "parked:triage", "busy:park", "busy:target", "scheduled:future", "debounce", "ESCALATE"]);
chains.forEach((c, i) => {
  if (JSON.stringify(c) !== want) { console.error("FAIL[arm-parity]: chain " + i + " is " + JSON.stringify(c) + ", want " + want); process.exit(1); }
});
console.log("arm-parity: 3 sites, identical chains, order " + chains[0].join(" -> "));
JS
node "$tmp/arm-parity.js" "$probe"

echo "case 5: burst-family degrade-absorbed rung — f210 FP subclass pin (a caller-side degrade storm must never read ESCALATE)"
cat > "$tmp/burst-degraded.js" <<'JS'
const src = require("fs").readFileSync(process.argv[2], "utf8");
// The burst section is ONE long line — slice THAT line so no neighbour CASE bleeds in.
const line = src.split("\n").find((l) => l.includes("await sec('errors_burst_family_4h'"));
if (!line) { console.error("FAIL[burst-degraded]: errors_burst_family_4h section line not found"); process.exit(1); }
// The FILTER that counts caller-side degrade-absorbed rows must be in the family subquery.
const filter = "COUNT(*) FILTER (WHERE message ~ 'caller degrades to (no-retrieval|in-scope retrieval)' OR message ~ 'keyword leg still runs')::int AS degraded_n";
if (!line.includes(filter)) { console.error("FAIL[burst-degraded]: degraded_n FILTER missing from errors_burst_family_4h"); process.exit(1); }
// The burst CASE chain: failed_runs ESCALATE stays ABOVE every absorbed rung; absorbed:degraded is STRICT-equality and sits after the failover rungs, before ELSE ESCALATE.
const chain = Array.from(line.matchAll(/(?:THEN|ELSE)\s+'([A-Za-z_:]+)'/g), (m) => m[1]);
const want = JSON.stringify(["ok", "ESCALATE", "absorbed:failover", "absorbed:failover", "absorbed:degraded", "ESCALATE"]);
if (JSON.stringify(chain) !== want) { console.error("FAIL[burst-degraded]: chain is " + JSON.stringify(chain) + ", want " + want); process.exit(1); }
if (!line.includes("WHEN t.degraded_n = t.family_n THEN 'absorbed:degraded'")) { console.error("FAIL[burst-degraded]: rung is not strict-equality"); process.exit(1); }
// degraded_n must be surfaced in the outer SELECT (the firing reads composition without a follow-up probe).
if (!line.includes("t.src AS source, t.family_n, t.degraded_n,")) { console.error("FAIL[burst-degraded]: degraded_n not surfaced in the outer SELECT"); process.exit(1); }
console.log("burst-degraded: FILTER present, chain " + chain.join(" -> "));
JS
node "$tmp/burst-degraded.js" "$probe"
