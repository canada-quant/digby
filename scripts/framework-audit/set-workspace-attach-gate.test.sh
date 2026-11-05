#!/usr/bin/env bash
# Pure checks for set-workspace-attach-gate.js (no database): argument parsing, refusals, that only the workspaceAttachGate
# fields change, and the effective mode (absent ⇒ shadow, the env kill switch ⇒ off).
set -euo pipefail
cd "$(dirname "$0")"
node -e "
const { parseArgs, nextRow, effective, MODES } = require('./set-workspace-attach-gate.js');
const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) { console.error('FAIL', m, JSON.stringify(a)); process.exit(1); } };
eq(MODES, ['off', 'shadow', 'act'], 'modes');
eq(parseArgs([]), { apply: false, mode: null, valid: true }, 'dry run');
eq(parseArgs(['--apply', 'act']), { apply: true, mode: 'act', valid: true }, 'apply act');
eq(parseArgs(['--apply', 'shadow']).valid, true, 'apply shadow');
eq(parseArgs(['--apply', 'off']).valid, true, 'apply off');
eq(parseArgs(['--apply', 'bogus']).valid, false, 'unknown mode refused');
eq(parseArgs(['--apply']).valid, false, 'missing mode refused');
const before = { actCanaryUserIds: ['x'], modelPick: 'act', modelPickKind: 'shadow', modelPickUpdatedBy: 'set-model-pick-mode' };
const next = nextRow(before, 'act', 'T', 'test');
eq([next.actCanaryUserIds, next.modelPick, next.modelPickKind, next.modelPickUpdatedBy], [['x'], 'act', 'shadow', 'set-model-pick-mode'], 'every other field kept');
eq([next.workspaceAttachGate, next.workspaceAttachGateUpdatedAt, next.workspaceAttachGateUpdatedBy], ['act', 'T', 'test'], 'gate fields written');
eq(Object.keys(before).length + 3, Object.keys(next).length, 'only the three gate fields added');
eq(nextRow(null, 'off', 'T', 't'), { workspaceAttachGate: 'off', workspaceAttachGateUpdatedAt: 'T', workspaceAttachGateUpdatedBy: 't' }, 'no row yet');
eq(effective({}, {}), { workspaceAttachGate: 'shadow (default)' }, 'default');
eq(effective(null, {}).workspaceAttachGate, 'shadow (default)', 'no row');
eq(effective({ workspaceAttachGate: 'act' }, {}).workspaceAttachGate, 'act', 'stored');
eq(effective({ workspaceAttachGate: 'bogus' }, {}).workspaceAttachGate, 'shadow (default)', 'unknown stored value reads as the default');
eq(effective({ workspaceAttachGate: 'act' }, { WORKSPACE_ATTACH_KIND_GATE_DISABLED: '1' }).workspaceAttachGate, 'off (WORKSPACE_ATTACH_KIND_GATE_DISABLED=1)', 'env kill switch');
"
echo "set-workspace-attach-gate.test.sh: ok"
