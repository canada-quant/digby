#!/usr/bin/env node
/**
 * apply-closure-manifest.js — run the deterministic ticket-closure manifest
 * (feedback/closure-manifest.ts) on demand, inside the live backend container
 * (backlog audit DOI-27, 2026-09-28).
 *
 * The worker cron `ticket-closure-manifest` applies the manifest every 10
 * minutes on its own; this probe is for the coordinator who wants to SEE what
 * the deployed manifest would close right now — and WHY an evidence-gated
 * entry is still pending (fix not yet proven merged + deployed, no GitHub
 * token on the ticket owner, …) — without waiting for the sweep.
 *
 * DRY RUN BY DEFAULT (reads only — no row update, no claim):
 *   bash /opt/crossmodel/scripts/framework-audit/prodq.sh apply-closure-manifest.js
 *   bash /opt/crossmodel/scripts/framework-audit/prodq.sh apply-closure-manifest.js --apply   # the cron's own write, once, now
 *
 * The evidence checks call GitHub with the ticket owner's connected token
 * (fix-state.ts) in BOTH modes — reads only. `--apply` is the same
 * applyClosureManifest() the worker runs (idempotent, at-most-once per entry).
 *
 * Runs INSIDE the live backend container (prodq.sh copies it to /tmp and runs
 * it from /app): `require('/app/dist/modules/crossmodel/feedback/closure-manifest')`
 * is the backend's own compiled module — so this probe reports what the DEPLOYED
 * manifest holds, never a stale local copy. Testable offline:
 * `module.exports.run({ manifest, argv })` takes a mocked module.
 *
 * Output: ONE JSON object on stdout; exit 0. Exit 2 = usage.
 */
'use strict';

const MODULE_CANDIDATES = [
  '/app/dist/modules/crossmodel/feedback/closure-manifest',
  require('path').resolve(process.cwd(), 'dist', 'modules', 'crossmodel', 'feedback', 'closure-manifest'),
];

function parseArgs(argv) {
  const out = { apply: false, help: false };
  for (const a of argv) {
    if (a === '--apply') out.apply = true;
    else if (a === '--dry-run') out.apply = false;
    else if (a === '--help' || a === '-h') out.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return out;
}

function defaultLoad() {
  let lastErr = null;
  for (const candidate of MODULE_CANDIDATES) {
    try { return { mod: require(candidate), modulePath: candidate }; } catch (err) { lastErr = err; }
  }
  throw lastErr || new Error('closure-manifest module not found');
}

async function run({ manifest, argv, print, load } = {}) {
  const opts = parseArgs(argv || process.argv.slice(2));
  if (opts.help) {
    if (print) console.log('usage: apply-closure-manifest.js [--apply]');
    return { help: true };
  }
  const loaded = manifest ? { mod: manifest, modulePath: 'injected' } : (load || defaultLoad)();
  const mod = loaded.mod;
  if (!mod || typeof mod.applyClosureManifest !== 'function') throw new Error(`closure-manifest module at ${loaded.modulePath} has no applyClosureManifest export`);
  const entries = Array.isArray(mod.CLOSURE_MANIFEST) ? mod.CLOSURE_MANIFEST : [];
  const report = {
    script: 'apply-closure-manifest',
    at: new Date().toISOString(),
    modulePath: loaded.modulePath,
    apply: opts.apply,
    dryRun: !opts.apply,
    entries: entries.length,
    evidenceGated: entries.filter((e) => e && e.evidence).map((e) => ({ idPrefix: e.idPrefix, evidence: e.evidence, duplicateOf: e.duplicateOf || null })),
  };
  const result = await mod.applyClosureManifest({ dryRun: !opts.apply });
  report.applied = result.applied;
  report.wouldClose = result.wouldClose || [];
  report.pending = result.pending || [];
  if (print) console.log(JSON.stringify(report, null, 2));
  return report;
}

module.exports = { run, parseArgs, MODULE_CANDIDATES };

if (require.main === module) {
  run({ print: true })
    .then(() => process.exit(0))
    .catch((err) => {
      const usage = /unknown argument/.test(String(err && err.message));
      console.error(`apply-closure-manifest: ${err && err.message ? err.message : err}`);
      process.exit(usage ? 2 : 1);
    });
}
