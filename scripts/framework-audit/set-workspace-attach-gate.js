#!/usr/bin/env node
/**
 * set-workspace-attach-gate.js — the WORKSPACE ATTACH GATE mode (2026-10-20, real-user audit; backend
 * platform/workspace-attach-gate.ts + turn-plan.ts workspaceAttachGateMode). Every chat is auto-filed into a
 * code-capable project, and a send matching the auto-router CODE_INTENT keyword list ("fix", "bug", "merge" …) used to
 * convert the chat into a coding session for good; the task_kind decision now judges the keyword hit.
 *
 *   off    — the keyword alone attaches (no ask);
 *   shadow — (the default when unset) the task_kind verdict is asked + recorded (loop_metrics workspace_attach_gate
 *            meta.wouldAttach), the keyword still attaches;
 *   act    — a confident (p ≥ 0.8), calibrated non-code verdict keeps the turn a chat.
 *
 * Runs INSIDE the backend container (prodq.sh copies it to /tmp and runs it from /app):
 *   bash /opt/crossmodel/scripts/framework-audit/prodq.sh set-workspace-attach-gate.js              # dry run: print the row
 *   bash /opt/crossmodel/scripts/framework-audit/prodq.sh set-workspace-attach-gate.js --apply act  # set the mode
 *
 * WRITES (only with --apply) the `workspaceAttachGate` field (+ its updatedAt / updatedBy stamps) of the context-store
 * row ['instance','turn-plan'] / 'config' — every other field is kept. Backends pick it up within their 30 s cache.
 * WORKSPACE_ATTACH_KIND_GATE_DISABLED=1 (env) overrides any stored mode to off. Exit 0 ok, 2 usage, 3 runtime modules
 * unavailable.
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

/** The next stored row (pure): only workspaceAttachGate + its stamps change. */
function nextRow(before, mode, now, by) {
  return { ...(before && typeof before === 'object' ? before : {}), workspaceAttachGate: mode, workspaceAttachGateUpdatedAt: now, workspaceAttachGateUpdatedBy: by };
}

/** What the backends run (pure over the row + env): the stored mode, absent ⇒ shadow, the env kill switch ⇒ off. */
function effective(row, env) {
  const e = env || {};
  const r = row && typeof row === 'object' ? row : {};
  const off = ['1', 'true', 'on'].includes(String(e.WORKSPACE_ATTACH_KIND_GATE_DISABLED || '').trim().toLowerCase());
  const stored = MODES.includes(r.workspaceAttachGate) ? r.workspaceAttachGate : null;
  return { workspaceAttachGate: off ? 'off (WORKSPACE_ATTACH_KIND_GATE_DISABLED=1)' : stored || 'shadow (default)' };
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
  const next = nextRow(before, mode, new Date().toISOString(), 'set-workspace-attach-gate');
  await store.storePut(NS, KEY, next);
  console.log(JSON.stringify({ applied: true, before, after: next, effective: effective(next, process.env) }));
  try { await prisma.$disconnect(); } catch { /* ignore */ }
}

if (require.main === module) {
  main().catch((err) => { console.log(JSON.stringify({ error: String(err && err.message || err).slice(0, 300) })); process.exit(1); });
}

module.exports = { parseArgs, nextRow, effective, MODES };
