// Iteration-17 verification (arg = ISO since): Fleet Supervisor hook delivery ratio + pending ages, finalize_hooks_first rows,
// wake_parked re-parks, queue ages, fairness preempts, plus the standing health checks. Read-only.
const prisma = require('/app/dist/config/database').default;
const BIG = (_k, v) => (typeof v === 'bigint' ? Number(v) : v);
const q = (sql) => prisma.$queryRawUnsafe(sql);
const since = process.argv[2] || '2026-09-21T13:00:00Z';
const out = { since };
async function sec(name, fn) { try { out[name] = await fn(); } catch (e) { out[name] = { ERR: String(e.message || e).slice(0, 200) }; } }
(async () => {
  await sec('box_sha', () => q(`SELECT DISTINCT ON (meta->>'host', meta->>'process') meta->>'host' AS host, meta->>'process' AS process, meta->>'sha' AS sha, "createdAt" FROM loop_metrics WHERE kind='box_health' AND "createdAt" > now() - interval '20 minutes' ORDER BY meta->>'host', meta->>'process', "createdAt" DESC`));
  await sec('fleet_hook_ratio', () => q(`SELECT e.status, COUNT(*)::int AS n, ROUND(AVG(EXTRACT(EPOCH FROM (e."updatedAt" - e."createdAt")))/60)::int AS avg_age_min FROM hook_events e JOIN event_hooks h ON h.id=e."hookId" WHERE h."targetChatId"::text LIKE 'c0e22e36%' AND e."createdAt" > '${since}' GROUP BY 1`));
  await sec('pending_hooks_now', () => q(`SELECT LEFT(h."targetChatId"::text,8) AS target, e."eventType", e.status, COUNT(*)::int AS n, ROUND(EXTRACT(EPOCH FROM (now() - MIN(e."createdAt")))/60)::int AS oldest_min FROM hook_events e JOIN event_hooks h ON h.id=e."hookId" WHERE e.status IN ('pending','delivering') GROUP BY 1,2,3 ORDER BY 5 DESC`));
  await sec('finalize_hooks_first', () => q(`SELECT LEFT("sessionId"::text,8) AS chat, (meta->>'wakeStarted')::boolean AS started, COUNT(*)::int AS n, ROUND(AVG((meta->>'hookAgeMs')::numeric)/60000)::int AS avg_hook_min, ROUND(AVG((meta->>'queueHeadAgeMs')::numeric)/60000)::int AS avg_queue_min, MAX("createdAt") AS last FROM loop_metrics WHERE kind='finalize_hooks_first' AND "createdAt" > '${since}' GROUP BY 1,2 ORDER BY 3 DESC LIMIT 12`));
  await sec('fairness_preempts', () => q(`SELECT LEFT("sessionId"::text,8) AS chat, meta->>'reason' AS reason, COUNT(*)::int AS n FROM loop_metrics WHERE kind='queue_fairness_preempt' AND "createdAt" > '${since}' GROUP BY 1,2 ORDER BY 3 DESC LIMIT 8`));
  await sec('fleet_wake_parked', () => q(`SELECT COUNT(*)::int AS n, SUM(COALESCE((meta->>'reparked')::int,0))::int AS reparked FROM loop_metrics WHERE kind='wake_parked' AND "sessionId"::text LIKE 'c0e22e36%' AND "createdAt" > '${since}'`));
  await sec('fleet_wakes_delivered', () => q(`SELECT "createdAt", LEFT(meta::text, 160) AS meta FROM loop_metrics WHERE kind='wake_delivered' AND "sessionId"::text LIKE 'c0e22e36%' AND "createdAt" > '${since}' ORDER BY "createdAt" DESC LIMIT 8`));
  await sec('queue_ages_now', () => q(`SELECT LEFT(p."chatId"::text,8) AS chat, p.source, COUNT(*)::int AS n, ROUND(EXTRACT(EPOCH FROM (now() - MIN(p."createdAt")))/60)::int AS oldest_min FROM pending_chat_messages p GROUP BY 1,2 ORDER BY 3 DESC LIMIT 8`));
  await sec('queue_full_errors', () => q(`SELECT COUNT(*)::int AS n FROM app_error_logs WHERE message LIKE '%Message queue is full%' AND "createdAt" > '${since}'`));
  await sec('hook_lag', () => q(`SELECT ROUND(AVG(EXTRACT(EPOCH FROM (e."updatedAt" - e."createdAt")))/60)::int AS avg_min, ROUND(PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (e."updatedAt" - e."createdAt")))/60)::int AS p90_min, COUNT(*)::int AS n FROM hook_events e WHERE e.status='delivered' AND e."createdAt" > '${since}'`));
  await sec('runs_health', () => q(`SELECT status, COUNT(*)::int AS n FROM agent_runs WHERE "createdAt" > '${since}' GROUP BY 1`));
  await sec('hooks_health', () => q(`SELECT status, COUNT(*)::int AS n FROM hook_events WHERE "createdAt" > '${since}' GROUP BY 1`));
  await sec('overlapping_runs', () => q(`SELECT COUNT(*)::int AS n FROM agent_runs a JOIN agent_runs b ON a."sessionId"=b."sessionId" AND a.id < b.id WHERE a."startedAt" IS NOT NULL AND b."startedAt" IS NOT NULL AND b."startedAt" > '${since}' AND b."startedAt" < COALESCE(a."finishedAt", now()) AND a."startedAt" < COALESCE(b."finishedAt", now())`));
  console.log(JSON.stringify(out, BIG, 1));
  process.exit(0);
})().catch(e => { console.error('ERR', e.message?.slice(0, 300)); process.exit(1); });
