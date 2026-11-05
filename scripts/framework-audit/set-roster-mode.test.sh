#!/usr/bin/env bash
# Pure checks for set-roster-mode.js (no database): argument parsing, refusals, and that only the roster fields change.
set -euo pipefail
cd "$(dirname "$0")"
node -e "
const { parseArgs, nextRow, effective } = require('./set-roster-mode.js');
const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) { console.error('FAIL', m, JSON.stringify(a)); process.exit(1); } };
eq(parseArgs([]).valid, true, 'dry run');
eq(parseArgs(['--apply']).valid, false, 'apply with nothing refused');
const a = parseArgs(['--apply', '--session-roster', 'act', '--call-in', 'canary', '--canary', 'u1, u2,u1']);
eq([a.valid, a.sessionRoster, a.callIn, a.canary], [true, 'act', 'canary', ['u1', 'u2']], 'combined flags');
eq(parseArgs(['--apply', '--session-roster', 'canary']).valid, false, 'canary is not a session-roster mode');
eq(parseArgs(['--apply', '--call-in', 'shadow']).valid, false, 'shadow is not a call-in mode');
eq(parseArgs(['--apply', '--canary']).valid, false, 'empty canary refused');
eq(parseArgs(['--apply', '--canary', 'u1', '--canary-clear']).valid, false, 'canary + clear refused');
const before = { actCanaryUserIds: ['x'], modelPick: 'act', sessionRoster: 'shadow' };
const next = nextRow(before, parseArgs(['--apply', '--call-in', 'act']), 'T', 'test');
eq([next.actCanaryUserIds, next.modelPick, next.sessionRoster, next.callIn, next.rosterUpdatedBy], [['x'], 'act', 'shadow', 'act', 'test'], 'only roster fields change');
eq(nextRow(before, parseArgs(['--apply', '--canary-clear']), 'T', 't').rosterCanaryUserIds, [], 'clear');
eq(effective({}), { sessionRoster: 'shadow (default)', callIn: 'canary (default)', rosterCanaryUserIds: [] }, 'defaults');
"
echo "set-roster-mode.test.sh: ok"
