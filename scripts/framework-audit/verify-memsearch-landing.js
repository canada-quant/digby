// verify-memsearch-landing.js — post-landing verification for the f41e856f steer (FO, 2026-09-23).
// Usage: prodq.sh verify-memsearch-landing.js <landingISO>   (e.g. 2026-09-23T14:35:00Z)
// READ-ONLY. Sections:
//   timing_by_purpose — count, p50/p90 totalMs, avg per-leg ms, rerankSkipped/embedCached/embedFailed shares, hits>0 vs 0
//   soft_deadline_since_landing — the ~100/day class; expect near 0
//   dashscope_warns_since_landing — embed/rerank HTTP failures
const prisma = require('/app/dist/config/database').default;
const q = (s) => prisma.$queryRawUnsafe(s);
const since = process.argv[2];

(async () => {
  if (!since || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(since)) {
    console.error('usage: verify-memsearch-landing.js <landingISO>'); process.exit(2);
  }
  const out = { since };
  out.timing_by_purpose = await q(`SELECT meta->>'purpose' AS purpose, COUNT(*)::int AS n,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY COALESCE(value, (meta->>'totalMs')::numeric))::int AS p50_ms,
      percentile_cont(0.9) WITHIN GROUP (ORDER BY COALESCE(value, (meta->>'totalMs')::numeric))::int AS p90_ms,
      ROUND(AVG((meta->>'embedMs')::numeric))::int AS avg_embed_ms,
      ROUND(AVG((meta->>'vecMs')::numeric))::int AS avg_vec_ms,
      ROUND(AVG((meta->>'ftsMs')::numeric))::int AS avg_fts_ms,
      COUNT(*) FILTER (WHERE meta ? 'rerankMs')::int AS rerank_ran,
      ROUND(AVG((meta->>'rerankMs')::numeric))::int AS avg_rerank_ms,
      COUNT(*) FILTER (WHERE (meta->>'rerankSkipped')::boolean)::int AS rerank_skipped,
      COUNT(*) FILTER (WHERE (meta->>'embedCached')::boolean)::int AS embed_cached,
      COUNT(*) FILTER (WHERE (meta->>'embedFailed')::boolean)::int AS embed_failed,
      COUNT(*) FILTER (WHERE COALESCE((meta->>'hits')::int, 0) > 0)::int AS hits_gt0,
      COUNT(*) FILTER (WHERE COALESCE((meta->>'hits')::int, 0) = 0)::int AS hits_0,
      MAX("createdAt") AS last
    FROM loop_metrics WHERE kind='memory_search_timing' AND "createdAt" > '${since}'
    GROUP BY 1 ORDER BY 2 DESC`);
  out.slow_rows = await q(`SELECT meta->>'purpose' AS purpose, value::int AS total_ms,
      (meta->>'embedMs')::int AS embed_ms, (meta->>'rerankMs')::int AS rerank_ms,
      (meta->>'rerankSkipped')::boolean AS rerank_skipped, (meta->>'embedCached')::boolean AS embed_cached,
      COALESCE((meta->>'hits')::int,0) AS hits, "createdAt"
    FROM loop_metrics WHERE kind='memory_search_timing' AND "createdAt" > '${since}'
      AND COALESCE(value, (meta->>'totalMs')::numeric, 0) > 5000
    ORDER BY value DESC NULLS LAST LIMIT 8`);
  out.soft_deadline_since_landing = await q(`SELECT date_trunc('hour', "createdAt") AS h, COUNT(*)::int AS n
    FROM app_error_logs WHERE message ILIKE '%Pipeline project learnings: soft deadline%'
    AND "createdAt" > '${since}' GROUP BY 1 ORDER BY 1`);
  out.dashscope_warns_since_landing = await q(`SELECT LEFT(regexp_replace(message, '[0-9a-f]{8}-[0-9a-f-]{27}', '<id>', 'g'),100) AS msg, COUNT(*)::int AS n, MAX("createdAt") AS last
    FROM app_error_logs WHERE "createdAt" > '${since}'
      AND (message ILIKE '%dashscope%' OR message ILIKE '%unified-memory%')
    GROUP BY 1 ORDER BY 2 DESC LIMIT 8`);
  console.log(JSON.stringify(out, (k, v) => (typeof v === 'bigint' ? Number(v) : v), 1));
  await prisma.$disconnect();
})().catch(async (e) => { console.error('PROBE_FAIL', e.message); try { await prisma.$disconnect(); } catch {} process.exit(1); });
