#!/usr/bin/env node
/**
 * set-lane-depth.js — the LANE DEPTH store flags (roster 2026-10-06 Team A; backend platform/lane-depth.ts):
 *   laneChecker   A-2  the turn plan's lane sets the Double Checker (standard ⇒ none, checked ⇒ one, from the checker pool)
 *   laneResearch  A-3  a confident research lane routes to the council at the controller; keyword Level 3 is retired
 *   laneFailOpen  A-4  no usable turn plan ⇒ "standard on the seat" instead of the keyword preset
 * Each is 'off' | 'shadow' | 'act' (absent ⇒ shadow): off = nobody acts; shadow = only the lane CANARY acts (everyone
 * else records the would-act on loop_metrics lane_depth / lane_research); act = every eligible human turn.
 *   laneCanaryUserIds — the per-feature canary (absent ⇒ the owner 83e4fbf9-…; [] ⇒ nobody).
 *
 * Runs INSIDE the backend container (prodq.sh copies it to /tmp and runs it from /app):
 *   bash /opt/crossmodel/scripts/framework-audit/prodq.sh set-lane-depth.js                                  # dry run
 *   bash /opt/crossmodel/scripts/framework-audit/prodq.sh set-lane-depth.js --apply --checker act
 *   bash /opt/crossmodel/scripts/framework-audit/prodq.sh set-lane-depth.js --apply --research shadow --fail-open off
 *   bash /opt/crossmodel/scripts/framework-audit/prodq.sh set-lane-depth.js --apply --canary <id,id>         # ids must exist
 *   bash /opt/crossmodel/scripts/framework-audit/prodq.sh set-lane-depth.js --apply --canary-clear           # nobody
 *   bash /opt/crossmodel/scripts/framework-audit/prodq.sh set-lane-depth.js --apply --canary-default         # the owner again
 *
 * WRITES (only with --apply) the lane fields of the context-store row ['instance','turn-plan'] / 'config' — the Quick
 * canary (actCanaryUserIds), modelPick and every other field are kept. Backends pick it up within their 30 s cache.
 * Env kill switches override any stored mode (LANE_DEPTH_DISABLED / LANE_CHECKER_DISABLED / LANE_RESEARCH_ROUTING_DISABLED
 * / LANE_FAIL_OPEN_DISABLED). Exit 0 ok, 2 usage / refused, 3 runtime modules unavailable.
 */
'use strict';

const NS = ['instance', 'turn-plan'];
const KEY = 'config';
const MODES = ['off', 'shadow', 'act'];
const FLAGS = { '--checker': 'laneChecker', '--research': 'laneResearch', '--fail-open': 'laneFailOpen' };
const OWNER = '83e4fbf9-e18c-42f1-9bf7-7a99caf9d9c4';

function parseArgs(argv) {
  const out = { apply: argv.includes('--apply'), modes: {}, canary: null, canaryClear: argv.includes('--canary-clear'), canaryDefault: argv.includes('--canary-default'), valid: true, error: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (FLAGS[a]) {
      const v = argv[i + 1];
      if (!MODES.includes(v)) { out.valid = false; out.error = `${a} needs one of ${MODES.join('|')}`; }
      else out.modes[FLAGS[a]] = v;
      i++;
    } else if (a === '--canary') {
      const v = argv[i + 1] || '';
      out.canary = [...new Set(v.split(',').map((s) => s.trim()).filter(Boolean))];
      if (!out.canary.length) { out.valid = false; out.error = '--canary needs <id,id>'; }
      i++;
    }
  }
  const canaryOps = (out.canary ? 1 : 0) + (out.canaryClear ? 1 : 0) + (out.canaryDefault ? 1 : 0);
  if (canaryOps > 1) { out.valid = false; out.error = 'pick ONE of --canary / --canary-clear / --canary-default'; }
  if (out.apply && out.valid && !Object.keys(out.modes).length && !canaryOps) { out.valid = false; out.error = 'nothing to apply'; }
  return out;
}

/** The row after the requested change (pure). */
function nextRow(before, args, now = new Date().toISOString()) {
  const next = { ...(before && typeof before === 'object' ? before : {}), ...args.modes };
  if (args.canary) next.laneCanaryUserIds = args.canary;
  if (args.canaryClear) next.laneCanaryUserIds = [];
  if (args.canaryDefault) delete next.laneCanaryUserIds;
  next.laneUpdatedAt = now;
  next.laneUpdatedBy = 'set-lane-depth';
  return next;
}

/** What the backends will read from a row (pure; the lane-depth.ts defaults). */
function effective(row) {
  const r = row && typeof row === 'object' ? row : {};
  const m = (v) => (MODES.includes(v) ? v : 'shadow');
  return {
    checker: m(r.laneChecker), research: m(r.laneResearch), failOpen: m(r.laneFailOpen),
    canary: Array.isArray(r.laneCanaryUserIds) ? r.laneCanaryUserIds : [`${OWNER} (default)`],
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.valid) {
    console.log(JSON.stringify({ error: args.error }));
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
  if (!args.apply) {
    console.log(JSON.stringify({ dryRun: true, current: before, effective: effective(before) }));
    return;
  }
  if (args.canary) {
    const found = await prisma.user.findMany({ where: { id: { in: args.canary } }, select: { id: true } });
    const have = new Set(found.map((u) => u.id));
    const missing = args.canary.filter((id) => !have.has(id));
    if (missing.length) {
      console.log(JSON.stringify({ error: `unknown user id(s): ${missing.join(', ')} — nothing written` }));
      process.exit(2);
    }
  }
  const next = nextRow(before, args);
  await store.storePut(NS, KEY, next);
  console.log(JSON.stringify({ applied: true, before, after: next, effective: effective(next) }));
  try { await prisma.$disconnect(); } catch { /* ignore */ }
}

if (require.main === module) {
  main().catch((err) => { console.log(JSON.stringify({ error: String(err && err.message || err).slice(0, 300) })); process.exit(1); });
}

module.exports = { parseArgs, nextRow, effective, MODES, OWNER };
