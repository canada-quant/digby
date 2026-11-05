#!/usr/bin/env bash
# Pure checks for set-model-pick-mode.js (no database): argument parsing + refusal of an unknown mode.
set -euo pipefail
cd "$(dirname "$0")"
node -e "
const { parseArgs } = require('./set-model-pick-mode.js');
const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) { console.error('FAIL', m, JSON.stringify(a)); process.exit(1); } };
eq(parseArgs([]), { apply: false, mode: null, valid: true }, 'dry run');
eq(parseArgs(['--apply', 'act']), { apply: true, mode: 'act', valid: true }, 'apply act');
eq(parseArgs(['--apply', 'shadow']).valid, true, 'apply shadow');
eq(parseArgs(['--apply', 'bogus']).valid, false, 'unknown mode refused');
eq(parseArgs(['--apply']).valid, false, 'missing mode refused');
"
echo "set-model-pick-mode.test.sh: ok"
