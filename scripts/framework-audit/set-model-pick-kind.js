#!/usr/bin/env node
/**
 * set-model-pick-kind.js — the KIND-AWARE model pick mode (2026-10-20, task-aware pick; backend platform/turn-plan.ts
 * modelPickKindMode + platform/model-pick.ts `kind`; owner: "make sure the decision model is … choosing the best models
 * for the job"). The turn's job type (decision purpose task_kind — writing / code / analysis / lookup / advice /
 * planning / explain) keys the pick's QUALITY on the bench's (model, kind) buckets.
 *
 *   off    — no kind-aware pick is computed (today's (model, lane) pick only; the kind is still recorded);
 *   shadow — (the default when unset) the (model, lane) pick acts exactly as before; the kind-aware pick is RECORDED
 *            beside it (metadata.depth.turnPlan.modelPick.kindPick);
 *   act    — on a turn with a usable kind the kind-aware pick REPLACES the (model, lane) pick; it then acts under the
 *            `modelPick` mode / canary rules exactly like today's pick (set-model-pick-mode.js) — modelPickKind act
 *            under modelPick shadow acts for the turn_plan canary users only.
 *
 * Runs INSIDE the backend container (prodq.sh copies it to /tmp and runs it from /app):
 *   bash /opt/crossmodel/scripts/framework-audit/prodq.sh set-model-pick-kind.js                # dry run: print the row
 *   bash /opt/crossmodel/scripts/framework-audit/prodq.sh set-model-pick-kind.js --apply act    # set the mode
 *
 * WRITES (only with --apply) the `modelPickKind` field (+ its updatedAt / updatedBy stamps) of the context-store row
 * ['instance','turn-plan'] / 'config' — modelPick, the canary list and every other field are kept. Backends pick it up
 * within their 30 s cache. MODEL_PICK_KIND_DISABLED=1 (env) overrides any stored mode to off; MODEL_EVIDENCE_KIND_DISABLED=1
 * makes every kind-aware pick fall back to (model, lane) evidence; TASK_KIND_DISABLED=1 stops the kind ask itself.
 * Exit 0 ok, 2 usage, 3 runtime modules unavailable.
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

/** The next stored row (pure): only modelPickKind + its stamps change. */
function nextRow(before, mode, now, by) {
  return { ...(before && typeof before === 'object' ? before : {}), modelPickKind: mode, modelPickKindUpdatedAt: now, modelPickKindUpdatedBy: by };
}

/** What the backends run (pure over the row + env): the stored mode, absent ⇒ shadow, the env kill switch ⇒ off. */
function effective(row, env) {
  const e = env || {};
  const r = row && typeof row === 'object' ? row : {};
  const off = ['1', 'true', 'on'].includes(String(e.MODEL_PICK_KIND_DISABLED || '').trim().toLowerCase());
  const stored = MODES.includes(r.modelPickKind) ? r.modelPickKind : null;
  return {
    modelPickKind: off ? 'off (MODEL_PICK_KIND_DISABLED=1)' : stored || 'shadow (default)',
    modelPick: MODES.includes(r.modelPick) ? r.modelPick : 'shadow (default)',
  };
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
    console.log(JSON.stringify({ dryRun: true, current: before, effective: effective(before, process.env) }));
    return;
  }
  const next = nextRow(before, mode, new Date().toISOString(), 'set-model-pick-kind');
  await store.storePut(NS, KEY, next);
  console.log(JSON.stringify({ applied: true, before, after: next, effective: effective(next, process.env) }));
  try { await prisma.$disconnect(); } catch { /* ignore */ }
}

if (require.main === module) {
  main().catch((err) => { console.log(JSON.stringify({ error: String(err && err.message || err).slice(0, 300) })); process.exit(1); });
}

module.exports = { parseArgs, nextRow, effective, MODES };
