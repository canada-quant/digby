/**
 * verify-blank-provisioning.js — post-deploy verification for the 2026-09-23
 * cross-box blank-session fix (Framework Operator firing 10; handed to the
 * 002542b1 dispatch lane b92ef13f). READ-ONLY probe: run via prodq.sh inside
 * the live backend container, e.g.
 *   run-on-box.sh A 'bash /opt/crossmodel/scripts/framework-audit/prodq.sh verify-blank-provisioning.js'
 *
 * The fix has two seams; this probe checks BOTH from telemetry + tables:
 *  1. blank_provision_deferred  — web boxes flip blank sessions ready WITHOUT
 *     a worktreePath (provisioning deferred to the claiming coding worker).
 *  2. blank_provision_selfheal  — the claiming worker rebuilds a stranded
 *     fresh blank session (worktreePath set, dir absent, zero completed runs).
 * Regression signal: NEW "Workspace missing on disk" failed runs after the
 * deploy roll (the two known pre-fix chats 26e38cce / 8a898e61 are expected
 * to SELF-HEAL on their next queued run — count them under healed, not failed).
 */
const prisma = require('/app/dist/config/database').default;
const BIG = (_k, v) => (typeof v === 'bigint' ? Number(v) : v);
const q = (sql) => prisma.$queryRawUnsafe(sql);
const out = {};
(async () => {
  const since = process.argv[2] || new Date(Date.now() - 4 * 3600_000).toISOString();
  out.since = since;
  out.deferred = await q(`SELECT COUNT(*)::int AS n, MAX("createdAt") AS last FROM loop_metrics WHERE kind='blank_provision_deferred' AND "createdAt" > '${since}'`);
  out.selfheal = await q(`SELECT COUNT(*)::int AS n, MAX("createdAt") AS last FROM loop_metrics WHERE kind='blank_provision_selfheal' AND "createdAt" > '${since}'`);
  // N2 (reviewer, supervisor merge-guard 2026-09-23): CONTAINS, not prefix —
  // appendAttemptCause prepends earlier attempt causes, so the phrase is not
  // guaranteed to lead the error text.
  out.workspace_missing_failed = await q(`SELECT LEFT("sessionId"::text,8) AS chat, COUNT(*)::int AS n, MAX("createdAt") AS last FROM agent_runs WHERE error LIKE '%Workspace missing on disk%' AND "createdAt" > '${since}' GROUP BY 1 ORDER BY 3 DESC LIMIT 10`);
  // The known pre-fix stranded chats: are they recovered yet? (ready + zero
  // completed runs ⇒ they will self-heal on their next queued run; a completed
  // run ⇒ already healed.)
  out.known_chats = await q(`SELECT LEFT(cs.id::text,8) AS chat, cs.status, cs."worktreePath" IS NOT NULL AS has_wt_path, (SELECT COUNT(*)::int FROM agent_runs r WHERE r."sessionId"=cs.id AND r.status='completed') AS completed_runs, (SELECT COUNT(*)::int FROM agent_runs r WHERE r."sessionId"=cs.id AND r.status='failed') AS failed_runs FROM coding_sessions cs WHERE cs.id::text LIKE '26e38cce%' OR cs.id::text LIKE '8a898e61%' OR cs.id::text LIKE '9c1e7c42%'`);
  // N1 (reviewer, supervisor merge-guard 2026-09-23): blank-provider = a
  // crossmodel_projects row with repoProvider NULL (toLegacySession maps
  // provider: repoProvider ?? 'blank') — the old NOT EXISTS(coding_projects)
  // shape matched project-LESS sessions (~0 given the FK) and could not
  // false-green only because it never matched anything.
  out.blank_ready_no_path = await q(`SELECT COUNT(*)::int AS n FROM coding_sessions cs JOIN crossmodel_projects cp ON cp.id = cs."projectId" WHERE cs.status='ready' AND cs."worktreePath" IS NULL AND cp."repoProvider" IS NULL AND cs."createdAt" > '${since}'`);
  // Ticket a086c69d (2026-09-28): repo-backed sessions deferred by a
  // non-volume-owner web box — should be ~0 in steady state after landing,
  // with the count falling as old stranded sessions get re-provisioned by
  // their claiming worker.
  out.repo_provision_deferred = await q(`SELECT COUNT(*)::int AS n, MAX("createdAt") AS last FROM loop_metrics WHERE kind='repo_provision_deferred' AND "createdAt" > '${since}'`);
  out.repo_ready_no_path = await q(`SELECT COUNT(*)::int AS n FROM coding_sessions cs JOIN crossmodel_projects cp ON cp.id = cs."projectId" WHERE cs.status='ready' AND cs."worktreePath" IS NULL AND cp."repoProvider" IS NOT NULL AND cs."createdAt" > '${since}'`);
  console.log(JSON.stringify(out, BIG, 1));
  await prisma.$disconnect();
  process.exit(0);
})().catch(e => { console.error('PROBE_ERR', e && e.message); process.exit(1); });
