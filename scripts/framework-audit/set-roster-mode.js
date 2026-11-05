#!/usr/bin/env node
/**
 * set-roster-mode.js — the dynamic roster phase-4 switches (roster 2026-10-06 Team D; backend
 * platform/roster-config.ts): the persisted SESSION ROSTER, the lead's call_in tool, and their per-feature canary.
 *
 *   sessionRoster  off | shadow | act   (unset ⇒ shadow: every human turn WRITES the roster; it acts only for the canary)
 *   callIn         off | canary | act   (unset ⇒ canary: the lead's call_in tool is offered only to the canary users)
 *   rosterCanaryUserIds                 the users both paths act for while shadow / canary
 *
 * Runs INSIDE the backend container (prodq.sh copies it to /tmp and runs it from /app):
 *   bash /opt/crossmodel/scripts/framework-audit/prodq.sh set-roster-mode.js                                  # dry run
 *   bash /opt/crossmodel/scripts/framework-audit/prodq.sh set-roster-mode.js --apply --canary <id,id>         # canary list
 *   bash /opt/crossmodel/scripts/framework-audit/prodq.sh set-roster-mode.js --apply --session-roster act      # fleet-wide
 *   bash /opt/crossmodel/scripts/framework-audit/prodq.sh set-roster-mode.js --apply --call-in act            # fleet-wide
 *   bash /opt/crossmodel/scripts/framework-audit/prodq.sh set-roster-mode.js --apply --canary-clear
 * Flags combine in one call. WRITES (only with --apply) ONLY these fields of the context-store row
 * ['instance','turn-plan'] / 'config' — actCanaryUserIds, modelPick and every other field are kept. Every canary id
 * must be an existing users.id (a miss refuses the whole write). Backends pick it up within their 30 s cache. Env kill
 * switches (SESSION_ROSTER_DISABLED=1, CALL_IN_DISABLED=1) win over any stored mode. Exit 0 ok, 2 usage / refused,
 * 3 runtime modules unavailable.
 */
'use strict';

const NS = ['instance', 'turn-plan'];
const KEY = 'config';
const SESSION_MODES = ['off', 'shadow', 'act'];
const CALL_IN_MODES = ['off', 'canary', 'act'];

function parseArgs(argv) {
  const out = { apply: argv.includes('--apply'), sessionRoster: null, callIn: null, canary: null, canaryClear: argv.includes('--canary-clear'), valid: true, error: null };
  const val = (flag) => {
    const i = argv.indexOf(flag);
    if (i < 0) return undefined;
    const v = argv[i + 1];
    return v && !v.startsWith('--') ? v : '';
  };
  const sr = val('--session-roster');
  const ci = val('--call-in');
  const can = val('--canary');
  if (sr !== undefined) { if (SESSION_MODES.includes(sr)) out.sessionRoster = sr; else { out.valid = false; out.error = `--session-roster <${SESSION_MODES.join('|')}>`; } }
  if (ci !== undefined) { if (CALL_IN_MODES.includes(ci)) out.callIn = ci; else { out.valid = false; out.error = `--call-in <${CALL_IN_MODES.join('|')}>`; } }
  if (can !== undefined) {
    const ids = [...new Set(String(can).split(',').map((s) => s.trim()).filter(Boolean))];
    if (ids.length) out.canary = ids; else { out.valid = false; out.error = '--canary <id,id>'; }
  }
  if (out.canary && out.canaryClear) { out.valid = false; out.error = '--canary and --canary-clear together'; }
  if (out.apply && out.valid && !out.sessionRoster && !out.callIn && !out.canary && !out.canaryClear) { out.valid = false; out.error = 'nothing to apply'; }
  return out;
}

/** The next stored row (pure): only the roster fields change. */
function nextRow(before, a, now, by) {
  const next = { ...(before && typeof before === 'object' ? before : {}) };
  if (a.sessionRoster) next.sessionRoster = a.sessionRoster;
  if (a.callIn) next.callIn = a.callIn;
  if (a.canary) next.rosterCanaryUserIds = a.canary;
  if (a.canaryClear) next.rosterCanaryUserIds = [];
  next.rosterUpdatedAt = now;
  next.rosterUpdatedBy = by;
  return next;
}

function effective(row) {
  const r = row && typeof row === 'object' ? row : {};
  return {
    sessionRoster: SESSION_MODES.includes(r.sessionRoster) ? r.sessionRoster : 'shadow (default)',
    callIn: CALL_IN_MODES.includes(r.callIn) ? r.callIn : 'canary (default)',
    rosterCanaryUserIds: Array.isArray(r.rosterCanaryUserIds) ? r.rosterCanaryUserIds : [],
  };
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  if (!a.valid) {
    console.log(JSON.stringify({ error: `usage: ${a.error}` }));
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
  if (!a.apply) {
    console.log(JSON.stringify({ dryRun: true, current: before, effective: effective(before) }));
    return;
  }
  if (a.canary) {
    const found = await prisma.user.findMany({ where: { id: { in: a.canary } }, select: { id: true } });
    const have = new Set(found.map((u) => u.id));
    const missing = a.canary.filter((id) => !have.has(id));
    if (missing.length) {
      console.log(JSON.stringify({ error: `unknown user id(s): ${missing.join(', ')} — nothing written` }));
      process.exit(2);
    }
  }
  const next = nextRow(before, a, new Date().toISOString(), 'set-roster-mode');
  await store.storePut(NS, KEY, next);
  console.log(JSON.stringify({ applied: true, before, after: next, effective: effective(next) }));
  try { await prisma.$disconnect(); } catch { /* ignore */ }
}

if (require.main === module) {
  main().catch((err) => { console.log(JSON.stringify({ error: String(err && err.message || err).slice(0, 300) })); process.exit(1); });
}

module.exports = { parseArgs, nextRow, effective, SESSION_MODES, CALL_IN_MODES };
