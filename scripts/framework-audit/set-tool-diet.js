#!/usr/bin/env node
/**
 * set-tool-diet.js — the TOOL DIET store flags (build 2026-10-08 A2-2; backend coding/tool-diet.ts):
 *   chatToolGroups  progressive tool disclosure on signed-in HUMAN plain-chat turns (core + hinted groups +
 *                   the measured preload + by-name auto-load, add-only)
 *                   'off' | 'shadow' | 'act' (absent ⇒ shadow): off = nobody acts (the would-miss row is still
 *                   recorded); shadow = only the CANARY acts, everyone else records loop_metrics tool_diet
 *                   {wouldMiss}; act = every eligible human chat turn.
 *   canaryUserIds   the canary (absent ⇒ the owner 83e4fbf9-…; [] ⇒ nobody).
 *   laneToolSets    build 2026-10-08 A2b — the turn plan's lane (quick / standard / checked / research) picks the
 *                   STARTING tool view; same 'off' | 'shadow' | 'act' semantics and canary as chatToolGroups (absent ⇒
 *                   shadow), and a lane set acts only where chatToolGroups already acts.
 *   laneWebDropBelow build 2026-10-08 A2b — needs_live_web below this holds the web tools back on a quick / standard
 *                   turn (a number in 0..1; absent ⇒ 0.05; 0 = never).
 *
 * Runs INSIDE the backend container (prodq.sh copies it to /tmp and runs it from /app):
 *   bash /opt/crossmodel/scripts/framework-audit/prodq.sh set-tool-diet.js                              # dry run
 *   bash /opt/crossmodel/scripts/framework-audit/prodq.sh set-tool-diet.js --apply --chat-tool-groups act
 *   bash /opt/crossmodel/scripts/framework-audit/prodq.sh set-tool-diet.js --apply --chat-tool-groups shadow
 *   bash /opt/crossmodel/scripts/framework-audit/prodq.sh set-tool-diet.js --apply --canary <id,id>     # ids must exist
 *   bash /opt/crossmodel/scripts/framework-audit/prodq.sh set-tool-diet.js --apply --canary-clear       # nobody
 *   bash /opt/crossmodel/scripts/framework-audit/prodq.sh set-tool-diet.js --apply --canary-default     # the owner again
 *   bash /opt/crossmodel/scripts/framework-audit/prodq.sh set-tool-diet.js --apply --lane-tool-sets act   # A2b lanes
 *   bash /opt/crossmodel/scripts/framework-audit/prodq.sh set-tool-diet.js --apply --lane-tool-sets off   # A2b rollback
 *   bash /opt/crossmodel/scripts/framework-audit/prodq.sh set-tool-diet.js --apply --lane-web-drop-below 0.05
 *
 * WRITES (only with --apply) the context-store row ['instance','tool-diet'] / 'config'; every other field is kept.
 * Backends pick it up within their 30 s cache. The env kill switch CHAT_TOOL_GROUPS_DISABLED=1 overrides any stored
 * mode (no store read at all). Exit 0 ok, 2 usage / refused, 3 runtime modules unavailable.
 */
'use strict';

const NS = ['instance', 'tool-diet'];
const KEY = 'config';
const MODES = ['off', 'shadow', 'act'];
const OWNER = '83e4fbf9-e18c-42f1-9bf7-7a99caf9d9c4';

function parseArgs(argv) {
  const out = { apply: argv.includes('--apply'), mode: null, laneMode: null, webDropBelow: null, canary: null, canaryClear: argv.includes('--canary-clear'), canaryDefault: argv.includes('--canary-default'), valid: true, error: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--chat-tool-groups') {
      const v = argv[i + 1];
      if (!MODES.includes(v)) { out.valid = false; out.error = `--chat-tool-groups needs one of ${MODES.join('|')}`; }
      else out.mode = v;
      i++;
    } else if (a === '--lane-tool-sets') {
      const v = argv[i + 1];
      if (!MODES.includes(v)) { out.valid = false; out.error = `--lane-tool-sets needs one of ${MODES.join('|')}`; }
      else out.laneMode = v;
      i++;
    } else if (a === '--lane-web-drop-below') {
      const v = Number(argv[i + 1]);
      if (!(argv[i + 1] || '').trim() || !Number.isFinite(v) || v < 0 || v > 1) { out.valid = false; out.error = '--lane-web-drop-below needs a number in 0..1'; }
      else out.webDropBelow = v;
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
  if (out.apply && out.valid && !out.mode && !out.laneMode && out.webDropBelow === null && !canaryOps) { out.valid = false; out.error = 'nothing to apply'; }
  return out;
}

/** The row after the requested change (pure). */
function nextRow(before, args, now = new Date().toISOString()) {
  const next = { ...(before && typeof before === 'object' ? before : {}) };
  if (args.mode) next.chatToolGroups = args.mode;
  if (args.laneMode) next.laneToolSets = args.laneMode;
  if (args.webDropBelow !== null && args.webDropBelow !== undefined) next.laneWebDropBelow = args.webDropBelow;
  if (args.canary) next.canaryUserIds = args.canary;
  if (args.canaryClear) next.canaryUserIds = [];
  if (args.canaryDefault) delete next.canaryUserIds;
  next.updatedAt = now;
  next.updatedBy = 'set-tool-diet';
  return next;
}

/** What the backends will read from a row (pure; the tool-diet.ts defaults). */
function effective(row) {
  const r = row && typeof row === 'object' ? row : {};
  return {
    chatToolGroups: MODES.includes(r.chatToolGroups) ? r.chatToolGroups : 'shadow',
    canary: Array.isArray(r.canaryUserIds) ? r.canaryUserIds : [`${OWNER} (default)`],
    laneToolSets: MODES.includes(r.laneToolSets) ? r.laneToolSets : 'shadow',
    laneWebDropBelow: typeof r.laneWebDropBelow === 'number' && r.laneWebDropBelow >= 0 && r.laneWebDropBelow <= 1 ? r.laneWebDropBelow : 0.05,
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
