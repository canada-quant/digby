// verify-memsearch-baseline.js — pre-landing baseline for the f41e856f steer (FO, 2026-09-23).
// READ-ONLY. Sections:
//   soft_deadline_24h        — 'Pipeline project learnings: soft deadline' warns by hour (the ~100/day class)
//   dashscope_warns_24h      — embed/rerank HTTP failures (regression check input)
//   memory_search_timing_any — any rows already (should be 0 pre-landing)
//   wrong_tool_seams         — tool_preflight update_feedback (ed5c4979), slip_echo_pruned, tool_alias_used
//   run_tool_receipts        — update_feedback ok-receipts continuity (regression check input)
const prisma = require('/app/dist/config/database').default;
const q = (s) => prisma.$queryRawUnsafe(s);

(async () => {
  const out = {};
  await (async () => {
    out.soft_deadline_24h = await q(`SELECT date_trunc('hour', "createdAt") AS h, COUNT(*)::int AS n
      FROM app_error_logs WHERE message ILIKE '%Pipeline project learnings: soft deadline%'
      AND "createdAt" > now() - interval '24 hours' GROUP BY 1 ORDER BY 1`);
    out.soft_deadline_summary = await q(`SELECT COUNT(*)::int AS total_24h,
      MAX("createdAt") AS last_at FROM app_error_logs
      WHERE message ILIKE '%Pipeline project learnings: soft deadline%' AND "createdAt" > now() - interval '24 hours'`);
    out.dashscope_warns_24h = await q(`SELECT LEFT(regexp_replace(message, '[0-9a-f]{8}-[0-9a-f-]{27}', '<id>', 'g'),100) AS msg, COUNT(*)::int AS n, MAX("createdAt") AS last
      FROM app_error_logs WHERE ("createdAt" > now() - interval '24 hours')
      AND (message ILIKE '%dashscope%' OR message ILIKE '%embed%' OR message ILIKE '%rerank%')
      AND message ILIKE '%warn%'
      GROUP BY 1 ORDER BY 2 DESC LIMIT 8`);
    // f41e856f metric — should be ZERO rows pre-landing (boxes on 5a6596d2)
    out.memory_search_timing_any = await q(`SELECT COUNT(*)::int AS rows FROM loop_metrics WHERE kind='memory_search_timing'`);
    out.wrong_tool_preflight_since_ed5 = await q(`SELECT COUNT(*)::int AS n, COUNT(DISTINCT "runId")::int AS runs, MAX("createdAt") AS last
      FROM loop_metrics WHERE kind='guard_strike' AND meta->>'seam'='tool_preflight' AND meta->>'reason'='ungrounded_id'
      AND meta->>'tool'='update_feedback' AND "createdAt" > '2026-09-22T22:00:00Z'`);
    out.slip_echo_pruned_24h = await q(`SELECT COUNT(*)::int AS n, COUNT(DISTINCT "runId")::int AS runs, MAX("createdAt") AS last
      FROM loop_metrics WHERE kind='guard_strike' AND meta->>'seam'='slip_echo_pruned' AND "createdAt" > now() - interval '24 hours'`);
    out.tool_alias_used_24h = await q(`SELECT meta->>'tool' AS tool, COUNT(*)::int AS n, MAX("createdAt") AS last
      FROM loop_metrics WHERE kind='guard_strike' AND meta->>'seam'='tool_alias_used' AND "createdAt" > now() - interval '24 hours'
      GROUP BY 1 ORDER BY 2 DESC LIMIT 6`);
    out.run_tool_receipts_update_feedback_24h = await q(`SELECT ok, COUNT(*)::int AS n, MAX("createdAt") AS last
      FROM run_tool_receipts WHERE tool='update_feedback' AND "createdAt" > now() - interval '24 hours' GROUP BY 1`);
  })();
  console.log(JSON.stringify(out, (k, v) => (typeof v === 'bigint' ? Number(v) : v), 1));
  await prisma.$disconnect();
})().catch(async (e) => { console.error('PROBE_FAIL', e.message); try { await prisma.$disconnect(); } catch {} process.exit(1); });
