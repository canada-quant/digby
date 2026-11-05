#!/usr/bin/env bash
# tool-diet-scripts.test.sh — the build 2026-10-08 A2 ops script (set-tool-diet.js, the chat tool-groups store flag).
# No network, no /app/dist: syntax + the pure helpers (dry run by default, other fields kept, defaults).
set -u
cd "$(dirname "$0")"
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ok: $1"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL: $1"; }

echo "== syntax =="
if node --check set-tool-diet.js 2>/dev/null; then ok "node --check set-tool-diet.js"; else bad "node --check set-tool-diet.js"; fi

echo "== set-tool-diet helpers =="
node -e '
const m = require("./set-tool-diet.js");
const fail = (x) => { console.error(x); process.exit(1); };
const d = m.parseArgs([]); if (d.apply || !d.valid || d.mode) fail("dry run by default: " + JSON.stringify(d));
const a = m.parseArgs(["--apply", "--chat-tool-groups", "act"]); if (!a.valid || a.mode !== "act") fail("mode parse: " + JSON.stringify(a));
if (m.parseArgs(["--apply", "--chat-tool-groups", "bogus"]).valid) fail("unknown mode refused");
if (m.parseArgs(["--apply"]).valid) fail("nothing to apply refused");
if (m.parseArgs(["--apply", "--canary-clear", "--canary-default"]).valid) fail("two canary ops refused");
const c = m.parseArgs(["--apply", "--canary", "a,b,a"]); if (!c.valid || c.canary.join() !== "a,b") fail("canary dedupes: " + JSON.stringify(c));
const before = { other: 1, canaryUserIds: ["y"] };
const n1 = m.nextRow(before, a, "T"); if (n1.other !== 1 || n1.chatToolGroups !== "act" || n1.canaryUserIds[0] !== "y" || n1.updatedAt !== "T") fail("other fields kept: " + JSON.stringify(n1));
const n2 = m.nextRow(before, m.parseArgs(["--apply", "--canary-default"]), "T"); if ("canaryUserIds" in n2) fail("canary-default removes the field");
const n3 = m.nextRow(before, m.parseArgs(["--apply", "--canary-clear"]), "T"); if (n3.canaryUserIds.length !== 0) fail("canary-clear = []");
const e = m.effective({}); if (e.chatToolGroups !== "shadow" || !String(e.canary[0]).startsWith(m.OWNER)) fail("defaults: shadow + the owner canary " + JSON.stringify(e));
' && ok "parseArgs / nextRow / effective" || bad "set-tool-diet helpers"

echo "== build 2026-10-08 A2b lane flags =="
node -e '
const m = require("./set-tool-diet.js");
const fail = (x) => { console.error(x); process.exit(1); };
const l = m.parseArgs(["--apply", "--lane-tool-sets", "act"]); if (!l.valid || l.laneMode !== "act" || l.mode) fail("lane mode parse: " + JSON.stringify(l));
if (m.parseArgs(["--apply", "--lane-tool-sets", "bogus"]).valid) fail("unknown lane mode refused");
const w = m.parseArgs(["--apply", "--lane-web-drop-below", "0"]); if (!w.valid || w.webDropBelow !== 0) fail("0 is a valid threshold: " + JSON.stringify(w));
for (const bad of ["1.5", "-0.1", "x", ""]) if (m.parseArgs(["--apply", "--lane-web-drop-below", bad]).valid) fail("threshold refused: " + bad);
const before = { chatToolGroups: "act", other: 1 };
const n = m.nextRow(before, m.parseArgs(["--apply", "--lane-tool-sets", "off", "--lane-web-drop-below", "0.03"]), "T");
if (n.laneToolSets !== "off" || n.laneWebDropBelow !== 0.03 || n.chatToolGroups !== "act" || n.other !== 1) fail("lane fields set, others kept: " + JSON.stringify(n));
const e = m.effective({}); if (e.laneToolSets !== "shadow" || e.laneWebDropBelow !== 0.05) fail("lane defaults: shadow / 0.05 " + JSON.stringify(e));
' && ok "lane flags parse / nextRow / effective" || bad "set-tool-diet lane flags"

echo "tool-diet-scripts.test.sh: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
