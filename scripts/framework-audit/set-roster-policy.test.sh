#!/usr/bin/env bash
# Pure checks for set-roster-policy.js (no database): field=value parsing + refusals (roster 2026-10-06, Team C).
set -euo pipefail
cd "$(dirname "$0")"
node -e "
const { parseArgs } = require('./set-roster-policy.js');
const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) { console.error('FAIL', m, JSON.stringify(a)); process.exit(1); } };
eq(parseArgs([]), { apply: false, set: {}, idFields: [], errors: [] }, 'dry run');
eq(parseArgs(['--apply', 'autoPickPolicy=open_only']).set, { autoPickPolicy: 'open_only' }, 'policy');
eq(parseArgs(['--apply', 'rolePick=act', 'quickWebCap=shadow', 'costPerUsd=0.5']).set, { rolePick: 'act', quickWebCap: 'shadow', costPerUsd: 0.5 }, 'several fields');
const c = parseArgs(['--apply', 'rolePickCanaryUserIds=a, b,a']);
eq(c.set, { rolePickCanaryUserIds: ['a', 'b'] }, 'canary ids deduped');
eq(c.idFields, ['rolePickCanaryUserIds'], 'id fields checked against users');
eq(parseArgs(['--apply', 'quickWebCapCanaryUserIds=']).set, { quickWebCapCanaryUserIds: [] }, 'an empty list clears');
eq(parseArgs(['--apply', 'autoPickPolicy=frontier']).errors.length, 1, 'bad policy refused');
eq(parseArgs(['--apply', 'costPerUsd=99']).errors.length, 1, 'cost weight capped');
eq(parseArgs(['--apply', 'costPerUsd=']).errors.length, 1, 'empty cost refused');
eq(parseArgs(['--apply', 'modelPick=act']).errors.length, 1, 'a field this script does not own is refused');
eq(parseArgs(['--apply', 'rolePick']).errors.length, 1, 'missing = refused');
eq(parseArgs(['--apply']).errors.length, 1, 'apply with nothing refused');
"
echo "set-roster-policy.test.sh: ok"
