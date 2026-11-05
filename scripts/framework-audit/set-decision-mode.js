#!/usr/bin/env node
/**
 * set-decision-mode.js — an OWNER-APPROVED decision-gate mode change, audited (2026-10-04).
 *
 * The admin PUT (Account → Admin → Endpoints → Model roles → Decision gate) refuses `act` for a purpose without a
 * fresh MEASURED READY stamp (E12 admission). A tier-2 purpose the owner flips on a read of the readout
 * (e.g. turn_plan — the dynamic-roster Quick lane, owner 2026-10-04) needs an OWNER-OVERRIDE stamp first; this
 * script writes exactly that, then the mode through the SAME `updateDecisionModes` the admin PUT uses (cache drop,
 * act-band window reset, the audit log line). The rollout automaton never treats an owner-override stamp as
 * measured, the 6-hourly readiness cron replaces it with the measured verdict without reverting the mode, and
 * auto-demote still guards act on act-period labels.
 *
 * Runs INSIDE the backend container (prodq.sh copies it to /tmp and runs it from /app):
 *   prodq.sh set-decision-mode.js turn_plan                                          # dry run: mode + readiness + admission
 *   prodq.sh set-decision-mode.js --apply turn_plan act --owner-override "owner 2026-10-04: Quick lane fleet-wide"
 *   prodq.sh set-decision-mode.js --apply turn_plan shadow                           # back to shadow (no stamp needed)
 * Prints JSON before / after. Exit 0 ok, 2 usage / refused, 3 runtime modules unavailable.
 */
'use strict';

function parseArgs(argv) {
  const apply = argv.includes('--apply');
  const oi = argv.indexOf('--owner-override');
  const override = oi >= 0 ? String(argv[oi + 1] || '').trim() : '';
  const rest = argv.filter((a, i) => !a.startsWith('--') && (oi < 0 || i !== oi + 1));
  return { apply, override, purpose: rest[0] || '', mode: rest[1] || '' };
}

async function main() {
  const { apply, override, purpose, mode } = parseArgs(process.argv.slice(2));
  if (!purpose) { console.log(JSON.stringify({ error: 'usage: [--apply] <purpose> [off|shadow|act] [--owner-override "<reason>"]' })); process.exit(2); }
  let modes, store;
  try {
    modes = require('/app/dist/modules/crossmodel/platform/decision-gate-modes');
    store = require('/app/dist/modules/crossmodel/memory/context-store');
  } catch (err) {
    console.log(JSON.stringify({ error: `runtime modules unavailable (${err && err.message})` }));
    process.exit(3);
  }
  const view = async () => {
    const cfg = await modes.getDecisionModeConfig();
    return (cfg.purposes || []).find((p) => p.purpose === purpose) || null;
  };
  const before = await view();
  if (!before) { console.log(JSON.stringify({ error: `unknown purpose ${purpose}` })); process.exit(2); }
  if (!apply) { console.log(JSON.stringify({ dryRun: true, purpose: before })); return; }
  if (!['off', 'shadow', 'act'].includes(mode)) { console.log(JSON.stringify({ error: 'mode must be off | shadow | act' })); process.exit(2); }
  let stamped = null;
  if (mode === 'act' && !(before.admission && before.admission.admitted)) {
    if (!override) {
      console.log(JSON.stringify({ error: `not admitted (${before.admission && before.admission.reason}) — an owner-approved flip needs --owner-override "<who/when/why>"`, purpose: before }));
      process.exit(2);
    }
    const NS = ['instance', 'decision-gate'];
    const current = (await store.storeGet(NS, 'readiness')) || {};
    stamped = { ready: true, at: new Date().toISOString(), metrics: { backend: `owner-override:${override.slice(0, 120)}`, ownerOverride: true }, reasons: [`owner override: ${override.slice(0, 200)}`] };
    await store.storePut(NS, 'readiness', { ...(current && typeof current === 'object' ? current : {}), [purpose]: stamped });
  }
  await modes.updateDecisionModes({ [purpose]: mode }, `owner-override:set-decision-mode${override ? `:${override.slice(0, 80)}` : ''}`);
  const after = await view();
  console.log(JSON.stringify({ applied: true, purpose, mode, stamped, before: { storeMode: before.storeMode, effective: before.effective, admission: before.admission }, after: { storeMode: after.storeMode, effective: after.effective, effectiveSource: after.effectiveSource } }));
  try { await require('/app/dist/config/database').default.$disconnect(); } catch { /* ignore */ }
}

if (require.main === module) {
  main().catch((err) => { console.log(JSON.stringify({ error: String((err && err.message) || err).slice(0, 300) })); process.exit(1); });
}

module.exports = { parseArgs };
