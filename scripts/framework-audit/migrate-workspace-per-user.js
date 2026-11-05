#!/usr/bin/env node
/**
 * migrate-workspace-per-user.js — build 2026-10-08 ISO (per-user workspace subtree).
 *
 * Moves ONE user's existing legacy coding workspace data into their per-user
 * subtree on the coding volume, so their dev container can mount only
 * `<root>/<userKey>/` (the isolation.md staged plan, steps 3–4):
 *     <root>/worktrees/<sid>               → <root>/<userKey>/worktrees/<sid>
 *     <root>/worktrees/.sandbox-home/<sid> → <root>/<userKey>/.sandbox-home/<sid>
 *     <root>/repos/<pid>.git  (--mirrors)  → <root>/<userKey>/repos/<pid>.git
 * All logic lives in the compiled backend module
 * (dist/modules/crossmodel/coding/workspace-migration — unit-tested in
 * workspace-migration.test.ts); this file is only the CLI.
 *
 * RUNS ON BOX C, INSIDE THE WORKER CONTAINER (it owns the volume + DOCKER_HOST):
 *   bash /opt/crossmodel/scripts/framework-audit/workerq.sh migrate-workspace-per-user.js --census --user <userId>
 *   bash /opt/crossmodel/scripts/framework-audit/workerq.sh migrate-workspace-per-user.js --user <userId>            # DRY RUN (default)
 *   bash /opt/crossmodel/scripts/framework-audit/workerq.sh migrate-workspace-per-user.js --user <userId> --apply
 *   bash /opt/crossmodel/scripts/framework-audit/workerq.sh migrate-workspace-per-user.js --user <userId> --mirrors --apply
 *   bash /opt/crossmodel/scripts/framework-audit/workerq.sh migrate-workspace-per-user.js --revert --run <runId>          # dry run of the revert
 *   bash /opt/crossmodel/scripts/framework-audit/workerq.sh migrate-workspace-per-user.js --revert --run <runId> --apply
 *
 * Safety (enforced in the module): dry run unless --apply; one user per run; a
 * session with a queued/running run, status 'running' or a held session
 * run-lock is SKIPPED (re-checked under the lock right before its move); each
 * move is verified with `git rev-parse` and rolled back on failure; a mirror
 * moves only when every attached worktree is this user's; every move is in the
 * manifest <root>/.digby-layout-migrations/<runId>.json for --revert.
 * Telemetry: loop_metrics kind workspace_isolation, meta.phase 'migration'.
 * Exit codes: 0 ok · 2 usage · 3 refused (key collision / manifest missing) · 4 items failed.
 */
'use strict';

const fs = require('fs');

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const has = (name) => process.argv.includes(name);

async function main() {
  const mod = require('/app/dist/modules/crossmodel/coding/workspace-migration');
  const metrics = require('/app/dist/modules/crossmodel/platform/loop-metrics.service');
  const apply = has('--apply');
  const userId = arg('--user');
  const runId = arg('--run') || `m${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}`;
  const deps = await mod.defaultMigrationDeps(runId);
  let code = 0;

  if (has('--census')) {
    if (!userId) { console.error('usage: --census --user <userId>'); return 2; }
    console.log(JSON.stringify(await mod.userWorkspaceCensus(userId, deps), null, 2));
    return 0;
  }

  if (has('--revert')) {
    const file = mod.migrationManifestPath(deps.root, runId);
    if (!arg('--run') || !fs.existsSync(file)) { console.error(`manifest not found: ${file} (pass --run <runId>)`); return 3; }
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    const r = await mod.revertMigration(manifest, deps, { apply });
    console.log(JSON.stringify({
      mode: apply ? 'REVERT APPLIED' : 'REVERT DRY RUN (nothing changed; add --apply)',
      runId,
      items: r.planned.map((i) => ({ kind: i.kind, sessionId: i.sessionId, projectId: i.projectId, status: i.status, reason: i.reason })),
    }, null, 2));
    if (r.planned.some((i) => i.status === 'revert_failed')) code = 4;
    await metrics.flushLoopMetrics();
    return code;
  }

  if (!userId) { console.error('usage: --user <userId> [--mirrors] [--apply] | --census --user <id> | --revert --run <id> [--apply]'); return 2; }
  const plan = await mod.planUserMigration(userId, deps, { mirrors: has('--mirrors') });
  if (plan.error) { console.error(`refused: ${plan.error}`); return 3; }
  const summarize = (items) => items.map((i) => ({ kind: i.kind, sessionId: i.sessionId, projectId: i.projectId, from: i.from, to: i.to, status: i.status, reason: i.reason, rewrote: i.rewrote }));
  if (!apply) {
    console.log(JSON.stringify({ mode: 'DRY RUN (nothing changed; add --apply)', userId, key: plan.key, runId, items: summarize(plan.items) }, null, 2));
    return 0;
  }
  const { manifest, manifestFile } = await mod.applyUserMigration(userId, plan, deps, runId, { mirrors: has('--mirrors') });
  console.log(JSON.stringify({ mode: 'APPLIED', userId, key: plan.key, runId, manifestFile, items: summarize(manifest.items) }, null, 2));
  if (manifest.items.some((i) => i.status === 'failed')) code = 4;
  await metrics.flushLoopMetrics();
  return code;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => { console.error(err && err.stack ? err.stack : String(err)); process.exit(1); });
