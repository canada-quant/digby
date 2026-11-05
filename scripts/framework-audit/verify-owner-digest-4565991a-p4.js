// Ticket 4565991a E2E probe p4 (2026-09-27) — READ-ONLY: near-term owner-subscribed firings.
const prisma = require('/app/dist/config/database').default;
const BIG = (_k, v) => (typeof v === 'bigint' ? Number(v) : v);
const q = (sql) => prisma.$queryRawUnsafe(sql);
(async () => {
  const rows = await q(
    `SELECT LEFT(s.id::text,8) AS sched, LEFT(s."sessionId"::text,8) AS chat,
       (cs.id IS NOT NULL) AS is_coding, s.kind, s."promptSetBy", s."ownerSubscribed", s."nextRunAt",
       ROUND(EXTRACT(EPOCH FROM (s."nextRunAt" - now()))/60)::int AS in_min
     FROM coding_schedules s
     LEFT JOIN crossmodel_chats c ON c.id = s."sessionId"
     LEFT JOIN coding_sessions cs ON cs.id = c.id
     WHERE s.enabled AND (s."ownerSubscribed" = true OR s."promptSetBy" = 'user')
       AND s."nextRunAt" < now() + interval '6 hours'
     ORDER BY s."nextRunAt" ASC LIMIT 15`);
  console.log(JSON.stringify(rows, BIG, 1));
  process.exit(0);
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
