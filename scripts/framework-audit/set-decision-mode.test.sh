#!/usr/bin/env bash
# Offline checks for set-decision-mode.js (owner-override decision-gate mode changes, 2026-10-04):
# argument parsing only — the script itself needs the backend container (/app/dist).
set -euo pipefail
cd "$(dirname "$0")"
node -e '
const { parseArgs } = require("./set-decision-mode.js");
const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) { console.error("FAIL " + m + ": " + JSON.stringify(a)); process.exit(1); } };
eq(parseArgs(["turn_plan"]), { apply: false, override: "", purpose: "turn_plan", mode: "" }, "dry run");
eq(parseArgs(["--apply", "turn_plan", "act", "--owner-override", "owner 2026-10-04: why"]), { apply: true, override: "owner 2026-10-04: why", purpose: "turn_plan", mode: "act" }, "apply with override");
eq(parseArgs(["--apply", "--owner-override", "x", "turn_plan", "shadow"]), { apply: true, override: "x", purpose: "turn_plan", mode: "shadow" }, "override before positionals");
console.log("set-decision-mode.test.sh: ok");
'
