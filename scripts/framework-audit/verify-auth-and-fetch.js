// Iteration-19 verification (arg = ISO since): expired-token warn volume + cadence, BrightData policy warns, unfetchable
// web-fetch rows, idle fleet sweeps parked, pending todo_wakes, plus the standing health checks. Read-only.
const prisma = require('/app/dist/config/database').default;
const BIG = (_k, v) => (typeof v === 'bigint' ? Number(v) : v);
const q = (sql) => prisma.$queryRawUnsafe(sql);
const since = process.argv[2] || '2026-09-21T21:30:00Z';
const out = { since };
async function sec(name, fn) { try { out[name] = await fn(); } catch (e) { out[name] = { ERR: String(e.message || e).slice(0, 200) }; } }
(async () => {
  await sec('box_sha', () => q(`SELECT DISTINCT ON (meta->>'host', meta->>'process') meta->>'host' AS host, meta->>'process' AS process, meta->>'sha' AS sha, "createdAt" FROM loop_metrics WHERE kind='box_health' AND "createdAt" > now() - interval '20 minutes' ORDER BY meta->>'host', meta->>'process', "createdAt" DESC`));
  await sec('jwt_expired_since', () => q(`SELECT COUNT(*)::int AS n, MIN("createdAt") AS first, MAX("createdAt") AS last FROM app_error_logs WHERE message LIKE 'Authentication failed (client token%' AND "createdAt" > '${since}'`));
  await sec('jwt_expired_msgs', () => q(`SELECT LEFT(message, 200) AS msg, COUNT(*)::int AS n FROM app_error_logs WHERE message LIKE 'Authentication failed (client token%' AND "createdAt" > '${since}' GROUP BY 1 ORDER BY 2 DESC LIMIT 5`));
  await sec('jwt_expired_legacy_msgs', () => q(`SELECT COUNT(*)::int AS n, MAX("createdAt") AS last FROM app_error_logs WHERE message='jwt expired' AND "createdAt" > '${since}'`));
  await sec('jwt_by_15min', () => q(`SELECT date_trunc('hour', "createdAt") + (floor(EXTRACT(MINUTE FROM "createdAt")/15)*15) * interval '1 minute' AS q, COUNT(*)::int AS n FROM app_error_logs WHERE (message='jwt expired' OR message LIKE 'Authentication failed (client token%') AND "createdAt" > now() - interval '3 hours' GROUP BY 1 ORDER BY 1`));
  await sec('policy_warns_since', () => q(`SELECT COUNT(*)::int AS n, MAX("createdAt") AS last FROM app_error_logs WHERE message LIKE 'BrightData direct:%policy_20020%' AND "createdAt" > '${since}'`));
  await sec('unfetchable_rows', () => q(`SELECT meta->>'reason' AS reason, COUNT(*)::int AS n, MAX("createdAt") AS last FROM loop_metrics WHERE kind='web_fetch_path' AND meta->>'directOutcome'='unfetchable' AND "createdAt" > '${since}' GROUP BY 1 ORDER BY 2 DESC LIMIT 6`));
  await sec('unfetchable_logs', () => q(`SELECT "createdAt", LEFT(message, 200) AS msg FROM app_error_logs WHERE (message LIKE '%unfetchable target%' OR message LIKE 'BrightData direct: screenshot skipped%') AND "createdAt" > '${since}' ORDER BY "createdAt" DESC LIMIT 4`));
  await sec('fleet_sup_sweeps', () => q(`SELECT LEFT(s."sessionId"::text,8) AS chat, s.enabled, s."lastStatus", s."nextRunAt", s."disabledAt" FROM coding_schedules s JOIN crossmodel_chats c ON c.id=s."sessionId" WHERE c.title='Fleet Supervisor' AND c."archivedAt" IS NULL AND s.kind='recurring' AND s."promptSetBy"='system' ORDER BY s."sessionId"`));
  await sec('todo_wake_pending', () => q(`SELECT e.status, COUNT(*)::int AS n, MIN(e."createdAt") AS oldest FROM hook_events e WHERE e."eventType"='todo_wake' AND e."createdAt" > '2026-09-21T17:00:00Z' GROUP BY 1`));
  await sec('runs_health', () => q(`SELECT status, COUNT(*)::int AS n FROM agent_runs WHERE "createdAt" > '${since}' GROUP BY 1`));
  await sec('hooks_health', () => q(`SELECT status, COUNT(*)::int AS n FROM hook_events WHERE "createdAt" > '${since}' GROUP BY 1`));
  await sec('pending_hooks_now', () => q(`SELECT COUNT(*)::int AS n, ROUND(EXTRACT(EPOCH FROM (now() - MIN("createdAt")))/60)::int AS oldest_min FROM hook_events WHERE status IN ('pending','delivering')`));
  await sec('queue_ages_now', () => q(`SELECT LEFT("chatId"::text,8) AS chat, COUNT(*)::int AS n, ROUND(EXTRACT(EPOCH FROM (now() - MIN("createdAt")))/60)::int AS oldest_min FROM pending_chat_messages GROUP BY 1 ORDER BY 2 DESC LIMIT 6`));
  await sec('overlapping_runs', () => q(`SELECT COUNT(*)::int AS n FROM agent_runs a JOIN agent_runs b ON a."sessionId"=b."sessionId" AND a.id < b.id WHERE a."startedAt" IS NOT NULL AND b."startedAt" IS NOT NULL AND b."startedAt" > '${since}' AND b."startedAt" < COALESCE(a."finishedAt", now()) AND a."startedAt" < COALESCE(b."finishedAt", now())`));
  console.log(JSON.stringify(out, BIG, 1));
  process.exit(0);
})().catch(e => { console.error('ERR', e.message?.slice(0, 300)); process.exit(1); });
