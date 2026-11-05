// FO firing 8 (2026-09-23) — PR #993 live verification + audit residue. Read-only.
// STANDING verify probe for the project-state extraction fix (squash 8c052480): parse_error
// rate + budgetTokens presence on 'changed' rows + clamped state sizes. The DB columns are
// the MAPPED snake_case ones (namespace_path), never the Prisma field names — firing 8's
// first cut 42703'd on "namespacePath" and cost a debug cycle.
// 1. memory_extraction by source × outcome since a ts: the fix's claims = parse_error ≈ 0
//    post-landing AND budgetTokens present on 'changed' rows (the firing-8 telemetry repair).
// 2. Raw sample of the LATEST project/project_brief rows with meta — what meta carries and when.
// 3. context store state sizes (key='state', namespace LIKE '%:context'): the clamp's effect
//    (firing 7 measured the largest stored state at 12,395 B; the clamp bounds items ≤180 chars).
// 4. utilityChat DeepSeek aborts by hour over 24h — the 07:32–07:36Z cluster (7 rows) fell
//    inside a 66.7s project call, so if the class predates 8c052480's 45s timeout it is the
//    provider-abort class, not our budget; if it tracks the deploy, the timeout is implicated.
const prisma = require('/app/dist/config/database').default;
const q = (sql) => prisma.$queryRawUnsafe(sql);
const since = process.argv[2] || '2026-09-23T05:49:00Z';
const out = { since };
async function sec(name, fn) { try { out[name] = await fn(); } catch (e) { out[name] = { ERR: String(e.message || e).slice(0, 200) }; } }
(async () => {
  await sec('extraction_by_source_outcome', () => q(`SELECT meta->>'source' AS source, meta->>'outcome' AS outcome, COUNT(*)::int AS n, COUNT(meta->>'budgetTokens')::int AS with_budget, MIN(meta->>'budgetTokens') AS min_budget, MAX(meta->>'budgetTokens') AS max_budget, ROUND(AVG(value))::int AS avg_ms, MAX(value) AS max_ms FROM loop_metrics WHERE kind='memory_extraction' AND "createdAt" > '${since}' GROUP BY 1,2 ORDER BY 1,3 DESC`));
  await sec('latest_project_rows', () => q(`SELECT "createdAt", meta->>'source' AS source, meta->>'outcome' AS outcome, value AS ms, meta->>'budgetTokens' AS budget, LEFT(meta->>'detail', 80) AS detail FROM loop_metrics WHERE kind='memory_extraction' AND meta->>'source' IN ('project','project_brief') AND "createdAt" > '${since}' ORDER BY "createdAt" DESC LIMIT 12`));
  await sec('state_sizes', () => q(`SELECT LEFT(namespace_path, 12) AS ns, LENGTH(value::text) AS bytes, updated_at FROM store WHERE namespace_path LIKE '%:context' AND key='state' ORDER BY LENGTH(value::text) DESC LIMIT 10`));
  await sec('utility_aborts_by_hour_24h', () => q(`SELECT to_char("createdAt", 'MM-DD HH24:00') AS h, COUNT(*)::int AS n FROM app_error_logs WHERE message LIKE '%utilityChat%aborted%' AND "createdAt" > now() - interval '24 hours' GROUP BY 1 ORDER BY 1`));
  console.log(JSON.stringify(out, (_k, v) => (typeof v === 'bigint' ? Number(v) : v), 1));
  process.exit(0);
})().catch(e => { console.error('ERR', e.message?.slice(0, 300)); process.exit(1); });
