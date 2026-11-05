// Iteration-18 verification (arg = ISO since): fleet-sweep dormancy parks/resumes, idle supervisors' sweep rows + no-op wakes,
// the owner's sweep untouched, plus the standing health checks. Read-only.
const prisma = require('/app/dist/config/database').default;
const BIG = (_k, v) => (typeof v === 'bigint' ? Number(v) : v);
const q = (sql) => prisma.$queryRawUnsafe(sql);
const since = process.argv[2] || '2026-09-21T17:30:00Z';
const out = { since };
async function sec(name, fn) { try { out[name] = await fn(); } catch (e) { out[name] = { ERR: String(e.message || e).slice(0, 200) }; } }
(async () => {
  await sec('box_sha', () => q(`SELECT DISTINCT ON (meta->>'host', meta->>'process') meta->>'host' AS host, meta->>'process' AS process, meta->>'sha' AS sha, "createdAt" FROM loop_metrics WHERE kind='box_health' AND "createdAt" > now() - interval '20 minutes' ORDER BY meta->>'host', meta->>'process', "createdAt" DESC`));
  await sec('fleet_sweep_dormancy', () => q(`SELECT LEFT("sessionId"::text,8) AS chat, meta->>'action' AS action, LEFT(meta->>'scheduleId',8) AS sched, "createdAt" FROM loop_metrics WHERE kind='fleet_sweep_dormancy' AND "createdAt" > '${since}' ORDER BY "createdAt" DESC LIMIT 12`));
  await sec('fleet_sup_sweeps', () => q(`SELECT LEFT(s."sessionId"::text,8) AS chat, LEFT(s.id,8) AS sched, s.enabled, s."lastStatus", s."runsCount", s."lastFiredAt", s."nextRunAt", s."disabledAt", s."cancelledBy" FROM coding_schedules s JOIN crossmodel_chats c ON c.id=s."sessionId" WHERE c.title='Fleet Supervisor' AND c."archivedAt" IS NULL AND s.kind='recurring' AND s."promptSetBy"='system' ORDER BY s."sessionId"`));
  await sec('parked_dormant_events', () => q(`SELECT LEFT(h."targetChatId"::text,8) AS target, e.status, e."createdAt", LEFT(e.payload->>'detail', 120) AS detail FROM hook_events e JOIN event_hooks h ON h.id=e."hookId" WHERE e."eventType"='schedule_disabled' AND e.payload->>'reason'='parked_dormant' AND e."createdAt" > '${since}' ORDER BY e."createdAt" DESC LIMIT 8`));
  await sec('idle_sup_wakes_since', () => q(`SELECT LEFT("sessionId"::text,8) AS chat, kind, COUNT(*)::int AS n FROM loop_metrics WHERE "sessionId"::text IN (SELECT id::text FROM crossmodel_chats WHERE title='Fleet Supervisor' AND id::text NOT LIKE 'c0e22e36%') AND kind IN ('supervisor_action','supervisor_noop') AND "createdAt" > '${since}' GROUP BY 1,2 ORDER BY 1`));
  await sec('owner_sup_sweep_fires', () => q(`SELECT COUNT(*)::int AS n, MAX("createdAt") AS last FROM loop_metrics WHERE "sessionId"::text LIKE 'c0e22e36%' AND kind='supervisor_action' AND meta->>'origin'='schedule' AND "createdAt" > '${since}'`));
  await sec('dormancy_park_logs', () => q(`SELECT "createdAt", LEFT(message, 240) AS msg FROM app_error_logs WHERE (message LIKE 'coding schedule: % auto-parked (goal-gate) — account is dormant%' OR message LIKE 'fleet supervisor: parked % stock sweep%' OR message LIKE 'fleet supervisor: resumed the dormancy-parked%') AND "createdAt" > '${since}' ORDER BY "createdAt" DESC LIMIT 8`));
  await sec('runs_health', () => q(`SELECT status, COUNT(*)::int AS n FROM agent_runs WHERE "createdAt" > '${since}' GROUP BY 1`));
  await sec('hooks_health', () => q(`SELECT status, COUNT(*)::int AS n FROM hook_events WHERE "createdAt" > '${since}' GROUP BY 1`));
  await sec('pending_hooks_now', () => q(`SELECT COUNT(*)::int AS n, ROUND(EXTRACT(EPOCH FROM (now() - MIN("createdAt")))/60)::int AS oldest_min FROM hook_events WHERE status IN ('pending','delivering')`));
  await sec('queue_ages_now', () => q(`SELECT LEFT("chatId"::text,8) AS chat, COUNT(*)::int AS n, ROUND(EXTRACT(EPOCH FROM (now() - MIN("createdAt")))/60)::int AS oldest_min FROM pending_chat_messages GROUP BY 1 ORDER BY 2 DESC LIMIT 6`));
  await sec('overlapping_runs', () => q(`SELECT COUNT(*)::int AS n FROM agent_runs a JOIN agent_runs b ON a."sessionId"=b."sessionId" AND a.id < b.id WHERE a."startedAt" IS NOT NULL AND b."startedAt" IS NOT NULL AND b."startedAt" > '${since}' AND b."startedAt" < COALESCE(a."finishedAt", now()) AND a."startedAt" < COALESCE(b."finishedAt", now())`));
  console.log(JSON.stringify(out, BIG, 1));
  process.exit(0);
})().catch(e => { console.error('ERR', e.message?.slice(0, 300)); process.exit(1); });
