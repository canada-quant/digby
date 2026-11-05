#!/usr/bin/env node
/**
 * set-turn-plan-canary.js — the turn_plan act CANARY allowlist (dynamic roster,
 * 2026-10-03 hardening; docs/DYNAMIC_ROSTER_PLAN_2026-10-03.md).
 *
 * Listed users' eligible turns take the QUICK lane while the turn_plan purpose
 * is still SHADOW (platform/turn-plan.ts turnPlanCanaryIncludes) — the act path
 * is verified end to end on a canary before the fleet-wide flip.
 *
 * Runs INSIDE the backend container (prodq.sh copies it to /tmp and runs it from /app):
 *   bash /opt/crossmodel/scripts/framework-audit/prodq.sh set-turn-plan-canary.js                 # dry run: print the list
 *   bash /opt/crossmodel/scripts/framework-audit/prodq.sh set-turn-plan-canary.js --apply <id,id>  # replace the list
 *   bash /opt/crossmodel/scripts/framework-audit/prodq.sh set-turn-plan-canary.js --apply --clear  # empty it
 *
 * WRITES (only with --apply) ONE context-store row ['instance','turn-plan'] / 'config':
 * { actCanaryUserIds, updatedAt, updatedBy: 'set-turn-plan-canary' }. Every id must be an
 * existing users.id (checked first; a miss refuses the whole write). Prints before / after as
 * JSON. The running backends pick the list up within their 30 s cache. Exit 0 ok, 2 usage /
 * refused, 3 runtime modules unavailable.
 */
'use strict';

const NS = ['instance', 'turn-plan'];
const KEY = 'config';

function parseArgs(argv) {
  const apply = argv.includes('--apply');
  const clear = argv.includes('--clear');
  const ids = argv.filter((a) => !a.startsWith('--')).join(',').split(',').map((s) => s.trim()).filter(Boolean);
  return { apply, clear, ids: [...new Set(ids)] };
}

async function main() {
  const { apply, clear, ids } = parseArgs(process.argv.slice(2));
  let prisma, store;
  try {
    prisma = require('/app/dist/config/database').default;
    store = require('/app/dist/modules/crossmodel/memory/context-store');
  } catch (err) {
    console.log(JSON.stringify({ error: `runtime modules unavailable (${err && err.message})` }));
    process.exit(3);
  }
  const before = (await store.storeGet(NS, KEY)) || null;
  if (!apply) {
    console.log(JSON.stringify({ dryRun: true, current: before }));
    return;
  }
  if (!clear && !ids.length) {
    console.log(JSON.stringify({ error: 'usage: --apply <id,id> | --apply --clear' }));
    process.exit(2);
  }
  if (!clear) {
    const found = await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true } });
    const have = new Set(found.map((u) => u.id));
    const missing = ids.filter((id) => !have.has(id));
    if (missing.length) {
      console.log(JSON.stringify({ error: `unknown user id(s): ${missing.join(', ')} — nothing written` }));
      process.exit(2);
    }
  }
  const next = { ...(before && typeof before === 'object' ? before : {}), actCanaryUserIds: clear ? [] : ids, updatedAt: new Date().toISOString(), updatedBy: 'set-turn-plan-canary' };
  await store.storePut(NS, KEY, next);
  console.log(JSON.stringify({ applied: true, before, after: next }));
  try { await prisma.$disconnect(); } catch { /* ignore */ }
}

if (require.main === module) {
  main().catch((err) => { console.log(JSON.stringify({ error: String(err && err.message || err).slice(0, 300) })); process.exit(1); });
}

module.exports = { parseArgs };
