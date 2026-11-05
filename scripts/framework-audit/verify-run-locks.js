// Iteration-14 verification (arg = ISO since): lock re-acquires, snapshot trims, overlapping runs per session,
// lock refusals, running rows vs. their leases, box shas, health. Read-only.
const prisma = require('/app/dist/config/database').default;
const BIG = (_k, v) => (typeof v === 'bigint' ? Number(v) : v);
const q = (sql) => prisma.$queryRawUnsafe(sql);
const since = process.argv[2] || '2026-09-21T01:00:00Z';
const out = { since };
async function sec(name, fn) { try { out[name] = await fn(); } catch (e) { out[name] = { ERR: String(e.message || e).slice(0, 200) }; } }
(async () => {
  await sec('box_sha', () => q(`SELECT DISTINCT ON (meta->>'host', meta->>'process') meta->>'host' AS host, meta->>'process' AS process, meta->>'sha' AS sha, "createdAt" FROM loop_metrics WHERE kind='box_health' AND "createdAt" > now() - interval '20 minutes' ORDER BY meta->>'host', meta->>'process', "createdAt" DESC`));
  await sec('run_lock_reacquired', () => q(`SELECT LEFT("sessionId"::text,8) AS chat, COUNT(*)::int AS n, MIN("createdAt") AS first, MAX("createdAt") AS last FROM loop_metrics WHERE kind='run_lock_reacquired' AND "createdAt" > '${since}' GROUP BY 1 ORDER BY 2 DESC LIMIT 12`));
  await sec('snapshot_trimmed', () => q(`SELECT COUNT(*)::int AS n, ROUND(AVG((meta->>'before')::numeric)/1024)::int AS avg_before_kb, ROUND(MAX((meta->>'before')::numeric)/1024)::int AS max_before_kb, ROUND(AVG((meta->>'after')::numeric)/1024)::int AS avg_after_kb, SUM((meta->>'droppedFiles')::int)::int AS dropped_files, SUM((meta->>'cutEntries')::int)::int AS cut_entries FROM loop_metrics WHERE kind='worktree_snapshot_trimmed' AND "createdAt" > '${since}'`));
  await sec('overlapping_runs_since', () => q(`SELECT LEFT(a."sessionId"::text,8) AS chat, LEFT(a.id::text,8) AS run_a, a."startedAt" AS a_start, a."finishedAt" AS a_end, LEFT(b.id::text,8) AS run_b, b."startedAt" AS b_start, b."finishedAt" AS b_end FROM agent_runs a JOIN agent_runs b ON a."sessionId"=b."sessionId" AND a.id < b.id WHERE a."startedAt" IS NOT NULL AND b."startedAt" IS NOT NULL AND b."startedAt" > '${since}' AND b."startedAt" < COALESCE(a."finishedAt", now()) AND a."startedAt" < COALESCE(b."finishedAt", now()) ORDER BY b."startedAt" LIMIT 10`));
  await sec('lock_refusals_since', () => q(`SELECT SUM(CASE WHEN message LIKE '%held by another owner%' THEN 1 ELSE 0 END)::int AS other_owner, SUM(CASE WHEN message LIKE '%lock not held%' THEN 1 ELSE 0 END)::int AS not_held_legacy, SUM(CASE WHEN message LIKE '%was MISSING%' THEN 1 ELSE 0 END)::int AS missing_reacquired, SUM(CASE WHEN message LIKE '%lost the race%' THEN 1 ELSE 0 END)::int AS lost_race FROM app_error_logs WHERE message LIKE 'session-run-lock:%' AND "createdAt" > '${since}'`));
  await sec('running_rows_leases', () => q(`SELECT LEFT("sessionId"::text,8) AS chat, LEFT(id::text,8) AS run, "startedAt", "heartbeatAt", "leaseExpiresAt", ("leaseExpiresAt" > now()) AS lease_live, "workerId" FROM agent_runs WHERE status='running' ORDER BY "startedAt" LIMIT 30`));
  await sec('sessions_with_multiple_running', () => q(`SELECT LEFT("sessionId"::text,8) AS chat, COUNT(*)::int AS n FROM agent_runs WHERE status='running' GROUP BY 1 HAVING COUNT(*) > 1`));
  await sec('runs_health', () => q(`SELECT status, COUNT(*)::int AS n FROM agent_runs WHERE "createdAt" > '${since}' GROUP BY 1`));
  await sec('hooks_health', () => q(`SELECT status, COUNT(*)::int AS n FROM hook_events WHERE "createdAt" > '${since}' GROUP BY 1`));
  await sec('archived_refusals', () => q(`SELECT meta->>'surface' AS surface, COUNT(*)::int AS n FROM loop_metrics WHERE kind='machine_dispatch_archived_refused' AND "createdAt" > '${since}' GROUP BY 1`));
  await sec('child_archives', () => q(`SELECT COUNT(*)::int AS n FROM loop_metrics WHERE kind='child_session_archived' AND "createdAt" > '${since}'`));
  console.log(JSON.stringify(out, BIG, 1));
  process.exit(0);
})().catch(e => { console.error('ERR', e.message?.slice(0, 300)); process.exit(1); });
