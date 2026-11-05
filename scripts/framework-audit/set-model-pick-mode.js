#!/usr/bin/env node
/**
 * set-model-pick-mode.js — the per-turn MODEL PICK mode (2026-10-04, backend platform/model-pick.ts; owner: "shouldn't
 * the decision model decide any model it wants for the specific task").
 *
 *   off    — no pick is computed;
 *   shadow — (the default when unset) every standard / checked human turn RECORDS the model the decision would use
 *            (metadata.depth.turnPlan.modelPick); only the turn_plan CANARY users' turns act on it;
 *   act    — the pick leads every eligible human turn (the seat finishes a turn the picked model fails).
 *
 * Runs INSIDE the backend container (prodq.sh copies it to /tmp and runs it from /app):
 *   bash /opt/crossmodel/scripts/framework-audit/prodq.sh set-model-pick-mode.js                # dry run: print the row
 *   bash /opt/crossmodel/scripts/framework-audit/prodq.sh set-model-pick-mode.js --apply act    # set the mode
 *
 * WRITES (only with --apply) the `modelPick` field of the context-store row ['instance','turn-plan'] / 'config' — the
 * canary list and every other field are kept. Backends pick it up within their 30 s cache. AUTO_MODEL_PICK_DISABLED=1
 * (env) overrides any stored mode to off. Exit 0 ok, 2 usage, 3 runtime modules unavailable.
 */
'use strict';

const NS = ['instance', 'turn-plan'];
const KEY = 'config';
const MODES = ['off', 'shadow', 'act'];

function parseArgs(argv) {
  const apply = argv.includes('--apply');
  const mode = argv.filter((a) => !a.startsWith('--'))[0] || null;
  return { apply, mode, valid: !apply || MODES.includes(mode) };
}

async function main() {
  const { apply, mode, valid } = parseArgs(process.argv.slice(2));
  if (!valid) {
    console.log(JSON.stringify({ error: `usage: --apply <${MODES.join('|')}>` }));
    process.exit(2);
  }
  let store, prisma;
  try {
    store = require('/app/dist/modules/crossmodel/memory/context-store');
    prisma = require('/app/dist/config/database').default;
  } catch (err) {
    console.log(JSON.stringify({ error: `runtime modules unavailable (${err && err.message})` }));
    process.exit(3);
  }
  const before = (await store.storeGet(NS, KEY)) || null;
  if (!apply) {
    console.log(JSON.stringify({ dryRun: true, current: before, effectiveMode: (before && before.modelPick) || 'shadow (default)' }));
    return;
  }
  const next = { ...(before && typeof before === 'object' ? before : {}), modelPick: mode, modelPickUpdatedAt: new Date().toISOString(), modelPickUpdatedBy: 'set-model-pick-mode' };
  await store.storePut(NS, KEY, next);
  console.log(JSON.stringify({ applied: true, before, after: next }));
  try { await prisma.$disconnect(); } catch { /* ignore */ }
}

if (require.main === module) {
  main().catch((err) => { console.log(JSON.stringify({ error: String(err && err.message || err).slice(0, 300) })); process.exit(1); });
}

module.exports = { parseArgs, MODES };
