#!/usr/bin/env node
/**
 * set-roster-policy.js — the dynamic roster's MODEL-ACCESS switches (roster 2026-10-06, Team C; backend
 * platform/roster-policy.ts is the reader). Owner 2026-10-06: "access to any and all models".
 *
 *   autoPickPolicy=all|open_only          which models AUTOMATIC picks (lead pick, role picks, Auto pools) may choose.
 *                                         Default (unset) = open_only. HARD RULE since 2026-10-06 (late, owner: "pickers
 *                                         should never choose frontier"): a stored `all` is IGNORED by every picker
 *                                         unless the backend runs with the env opt-in AUTO_PICK_FRONTIER_ENABLED=1 —
 *                                         frontier models are consulted only by the reflection council.
 *   costPerUsd=<number 0..20>             quality points one USD of a turn's estimated spend costs in the pick (default 1;
 *                                         0 = price ignored).
 *   rolePick=off|shadow|act               the Quick / checker / colleague picks (default shadow = recorded only).
 *   rolePickCanaryUserIds=<id,id|empty>   users whose turns ACT on the role picks while rolePick is shadow.
 *   quickWebCap=off|shadow|act            the Quick lane's harness web budget (1 search + 1 page read; default shadow).
 *   quickWebCapCanaryUserIds=<id,id|empty> users whose Quick turns run the budget in act while quickWebCap is shadow.
 *
 * Runs INSIDE the backend container (prodq.sh copies it to /tmp and runs it from /app):
 *   bash /opt/crossmodel/scripts/framework-audit/prodq.sh set-roster-policy.js                                   # dry run
 *   bash /opt/crossmodel/scripts/framework-audit/prodq.sh set-roster-policy.js --apply rolePickCanaryUserIds=<id>
 *   bash /opt/crossmodel/scripts/framework-audit/prodq.sh set-roster-policy.js --apply rolePick=act quickWebCap=act
 *
 * WRITES (only with --apply) the named fields of the context-store row ['instance','turn-plan'] / 'config' — every
 * other field (the turn_plan act canary, the model-pick mode, other teams' fields) is kept. Every canary id must be an
 * existing users.id (a miss refuses the whole write). Backends pick the change up within their 30 s cache. Env kill
 * switches override the store: AUTO_PICK_FRONTIER_DISABLED, MODEL_PICK_COST_DISABLED, ROLE_PICK_DISABLED,
 * QUICK_LANE_WEB_CAP_DISABLED. Prints before / after as JSON (no secrets in this row). Exit 0 ok, 2 usage / refused,
 * 3 runtime modules unavailable.
 */
'use strict';

const NS = ['instance', 'turn-plan'];
const KEY = 'config';
const MODES = ['off', 'shadow', 'act'];
const FIELDS = {
  autoPickPolicy: (v) => (['all', 'open_only'].includes(v) ? { ok: true, value: v } : { ok: false, why: 'all | open_only' }),
  costPerUsd: (v) => {
    const n = Number(v);
    return v !== '' && Number.isFinite(n) && n >= 0 && n <= 20 ? { ok: true, value: n } : { ok: false, why: 'a number 0..20' };
  },
  rolePick: (v) => (MODES.includes(v) ? { ok: true, value: v } : { ok: false, why: MODES.join(' | ') }),
  quickWebCap: (v) => (MODES.includes(v) ? { ok: true, value: v } : { ok: false, why: MODES.join(' | ') }),
  rolePickCanaryUserIds: (v) => ({ ok: true, value: [...new Set(String(v).split(',').map((s) => s.trim()).filter(Boolean))], ids: true }),
  quickWebCapCanaryUserIds: (v) => ({ ok: true, value: [...new Set(String(v).split(',').map((s) => s.trim()).filter(Boolean))], ids: true }),
};

/** argv → { apply, set: {field: value}, idFields: [...], errors: [...] }. Pure. */
function parseArgs(argv) {
  const apply = argv.includes('--apply');
  const set = {};
  const idFields = [];
  const errors = [];
  for (const a of argv.filter((x) => !x.startsWith('--'))) {
    const i = a.indexOf('=');
    if (i <= 0) { errors.push(`expected field=value, got ${JSON.stringify(a)}`); continue; }
    const field = a.slice(0, i);
    const raw = a.slice(i + 1).trim();
    const check = FIELDS[field];
    if (!check) { errors.push(`unknown field ${JSON.stringify(field)} (fields: ${Object.keys(FIELDS).join(', ')})`); continue; }
    const r = check(raw);
    if (!r.ok) { errors.push(`${field}: expected ${r.why}`); continue; }
    set[field] = r.value;
    if (r.ids) idFields.push(field);
  }
  if (apply && !Object.keys(set).length && !errors.length) errors.push('usage: --apply field=value [field=value …]');
  return { apply, set, idFields, errors };
}

async function main() {
  const { apply, set, idFields, errors } = parseArgs(process.argv.slice(2));
  if (errors.length) {
    console.log(JSON.stringify({ error: errors.join('; ') }));
    process.exit(2);
  }
  let store, prisma, policy;
  try {
    store = require('/app/dist/modules/crossmodel/memory/context-store');
    prisma = require('/app/dist/config/database').default;
    try { policy = require('/app/dist/modules/crossmodel/platform/roster-policy'); } catch { policy = null; }
  } catch (err) {
    console.log(JSON.stringify({ error: `runtime modules unavailable (${err && err.message})` }));
    process.exit(3);
  }
  const before = (await store.storeGet(NS, KEY)) || null;
  const effective = (row) => {
    if (!policy) return null;
    const p = policy.applyRosterKillSwitches(policy.normalizeRosterPolicy(row), process.env);
    return { ...p, rolePickCanaryUserIds: [...p.rolePickCanaryUserIds], quickWebCapCanaryUserIds: [...p.quickWebCapCanaryUserIds] };
  };
  if (!apply) {
    console.log(JSON.stringify({ dryRun: true, current: before, effective: effective(before) }));
    return;
  }
  const ids = [...new Set(idFields.flatMap((f) => set[f]))];
  if (ids.length) {
    const found = await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true } });
    const have = new Set(found.map((u) => u.id));
    const missing = ids.filter((id) => !have.has(id));
    if (missing.length) {
      console.log(JSON.stringify({ error: `unknown user id(s): ${missing.join(', ')} — nothing written` }));
      process.exit(2);
    }
  }
  const next = { ...(before && typeof before === 'object' ? before : {}), ...set, rosterPolicyUpdatedAt: new Date().toISOString(), rosterPolicyUpdatedBy: 'set-roster-policy' };
  await store.storePut(NS, KEY, next);
  console.log(JSON.stringify({ applied: true, fields: Object.keys(set), before, after: next, effective: effective(next) }));
  try { await prisma.$disconnect(); } catch { /* ignore */ }
}

if (require.main === module) {
  main().catch((err) => { console.log(JSON.stringify({ error: String((err && err.message) || err).slice(0, 300) })); process.exit(1); });
}

module.exports = { parseArgs, FIELDS };
