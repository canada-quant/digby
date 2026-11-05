/**
 * verify-memsearch-prefilter.js — post-deploy battery for d2b7bd53 (owner steer
 * 2026-09-23 16:37Z: vector-leg scope prefilter + composite index). READ-ONLY.
 * Usage: run-on-box.sh A 'bash /opt/crossmodel/scripts/framework-audit/prodq.sh verify-memsearch-prefilter.js <sinceISO>'
 * <sinceISO> = the wave-conclusion time (default: 2026-09-23T16:55:22Z). Checks:
 * vecShape='prefilter' coverage, vecMs p50/p90 + hits by purpose, soft-deadline
 * warns/h, digby_mem_scope_src_idx presence, unified-memory leg warns,
 * workspace_missing attention events, new workspace-missing failures, and new
 * sessions in the repo-less project 922fd3ad. Re-run at ~4h for the warm-sample
 * statistical verdict (baseline pre-wave: project_learnings avg 4.3s / p90 14s;
 * expect vecMs p90 <2s warm).
 */
const prisma = require('/app/dist/config/database').default;
(async () => {
  const since = process.argv[2] || '2026-09-23T16:55:22Z';
  const out = { since };
  const J = (_k, v) => (typeof v === 'bigint' ? Number(v) : v);
  const q = (sql) => prisma.$queryRawUnsafe(sql);
  out.timing = await q(`SELECT (meta->>'purpose') AS purpose, COUNT(*)::int AS n,
      COUNT(*) FILTER (WHERE meta->>'vecShape' = 'prefilter')::int AS vecshape_prefilter,
      COUNT(*) FILTER (WHERE meta->>'vecShape' IS NOT NULL AND meta->>'vecShape' <> 'prefilter')::int AS vecshape_other,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY (meta->>'vecMs')::int)::int AS vec_p50,
      percentile_cont(0.9) WITHIN GROUP (ORDER BY (meta->>'vecMs')::int)::int AS vec_p90,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY (meta->>'totalMs')::int)::int AS total_p50,
      COUNT(*) FILTER (WHERE COALESCE((meta->>'hits')::int,0) > 0)::int AS hits_gt0
    FROM loop_metrics WHERE kind='memory_search_timing' AND "createdAt" > '${since}' GROUP BY 1`);
  out.timing_rows = await q(`SELECT (meta->>'purpose') AS purpose, (meta->>'vecMs')::int AS vec, (meta->>'totalMs')::int AS total, meta->>'vecShape' AS shape, (meta->>'hits')::int AS hits, "createdAt" FROM loop_metrics WHERE kind='memory_search_timing' AND "createdAt" > '${since}' ORDER BY "createdAt" DESC LIMIT 12`);
  out.deadline_by_hour = await q(`SELECT date_trunc('hour', "createdAt") AS h, COUNT(*)::int AS n, MAX("createdAt") AS last FROM app_error_logs WHERE message LIKE 'Pipeline project learnings: soft deadline%' AND "createdAt" > '${since}' GROUP BY 1 ORDER BY 1`);
  out.mem_indexes = await q(`SELECT indexname FROM pg_indexes WHERE tablename='digby_memory'`);
  out.mem_warns = await q(`SELECT COUNT(*)::int AS n, MAX("createdAt") AS last FROM app_error_logs WHERE (message LIKE '%semantic leg failed%' OR message LIKE '%keyword leg failed%' OR message LIKE '%unified-memory: embed failed%') AND "createdAt" > '${since}'`);
  out.workspace_missing_events = await q(`SELECT he."eventType", LEFT(eh."targetChatId"::text,8) AS target, he.status, he."createdAt" FROM hook_events he JOIN event_hooks eh ON eh.id=he."hookId" WHERE he.payload->>'reason'='workspace_missing' AND he."createdAt" > '${since}' ORDER BY he."createdAt" DESC LIMIT 5`);
  out.dead_chat_failures_since = await q(`SELECT LEFT("sessionId"::text,8) AS chat, COUNT(*)::int AS n, MAX("createdAt") AS last FROM agent_runs WHERE error LIKE 'Workspace missing on disk%' AND "createdAt" > '${since}' GROUP BY 1`);
  out.new_sessions_project = await q(`SELECT LEFT(cs.id::text,8) AS chat, cs.status, cs."createdAt" FROM coding_sessions cs WHERE cs."projectId"::text LIKE '922fd3ad%' AND cs."createdAt" > '${since}'`);
  console.log(JSON.stringify(out, J, 1));
  await prisma.$disconnect(); process.exit(0);
})().catch(e => { console.error('PROBE_ERR', e && e.message); process.exit(1); });
