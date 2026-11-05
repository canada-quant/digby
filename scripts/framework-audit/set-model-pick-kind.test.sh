#!/usr/bin/env bash
# Pure checks for set-model-pick-kind.js (no database): argument parsing, refusals, that only the modelPickKind fields
# change, and the effective mode (absent ⇒ shadow, the env kill switch ⇒ off).
set -euo pipefail
cd "$(dirname "$0")"
node -e "
const { parseArgs, nextRow, effective, MODES } = require('./set-model-pick-kind.js');
const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) { console.error('FAIL', m, JSON.stringify(a)); process.exit(1); } };
eq(MODES, ['off', 'shadow', 'act'], 'modes');
eq(parseArgs([]), { apply: false, mode: null, valid: true }, 'dry run');
eq(parseArgs(['--apply', 'act']), { apply: true, mode: 'act', valid: true }, 'apply act');
eq(parseArgs(['--apply', 'shadow']).valid, true, 'apply shadow');
eq(parseArgs(['--apply', 'off']).valid, true, 'apply off');
eq(parseArgs(['--apply', 'bogus']).valid, false, 'unknown mode refused');
eq(parseArgs(['--apply']).valid, false, 'missing mode refused');
const before = { actCanaryUserIds: ['x'], modelPick: 'act', sessionRoster: 'shadow', modelPickUpdatedBy: 'set-model-pick-mode' };
const next = nextRow(before, 'act', 'T', 'test');
eq([next.actCanaryUserIds, next.modelPick, next.sessionRoster, next.modelPickUpdatedBy], [['x'], 'act', 'shadow', 'set-model-pick-mode'], 'every other field kept');
eq([next.modelPickKind, next.modelPickKindUpdatedAt, next.modelPickKindUpdatedBy], ['act', 'T', 'test'], 'kind fields written');
eq(Object.keys(before).length + 3, Object.keys(next).length, 'only the three kind fields added');
eq(nextRow(null, 'off', 'T', 't'), { modelPickKind: 'off', modelPickKindUpdatedAt: 'T', modelPickKindUpdatedBy: 't' }, 'no row yet');
eq(effective({}, {}), { modelPickKind: 'shadow (default)', modelPick: 'shadow (default)' }, 'defaults');
eq(effective(null, {}).modelPickKind, 'shadow (default)', 'no row');
eq(effective({ modelPickKind: 'act', modelPick: 'act' }, {}), { modelPickKind: 'act', modelPick: 'act' }, 'stored');
eq(effective({ modelPickKind: 'bogus' }, {}).modelPickKind, 'shadow (default)', 'unknown stored value reads as the default');
eq(effective({ modelPickKind: 'act' }, { MODEL_PICK_KIND_DISABLED: '1' }).modelPickKind, 'off (MODEL_PICK_KIND_DISABLED=1)', 'env kill switch');
"
echo "set-model-pick-kind.test.sh: ok"
