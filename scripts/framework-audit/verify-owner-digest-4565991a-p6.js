// Ticket 4565991a E2E probe p6 (2026-09-27) — READ-ONLY: post-firing state of schedule b3395ed0.
const prisma = require('/app/dist/config/database').default;
const BIG = (_k, v) => (typeof v === 'bigint' ? Number(v) : v);
const q = (sql) => prisma.$queryRawUnsafe(sql);
(async () => {
  const sched = await q(
    `SELECT LEFT(id::text,8) AS sched, kind, enabled, "promptSetBy", "ownerSubscribed",
            "nextRunAt", "lastFiredAt", "lastStatus", "runsCount"
     FROM coding_schedules WHERE id LIKE 'b3395ed0%'`);
  const runs = await q(
    `SELECT LEFT(id::text,8) AS run, status, (input->>'origin') AS input_origin, "startedAt", "finishedAt", "updatedAt"
     FROM agent_runs WHERE "sessionId" LIKE 'cbead56f%' AND "createdAt" > '2026-09-27T18:10:00Z'
     ORDER BY "createdAt" DESC LIMIT 5`);
  const msgs = await q(
    `SELECT LEFT(id::text,8) AS msg, role, "createdAt",
            metadata->>'origin' AS origin, metadata->>'kind' AS kind,
            (metadata->>'scheduleOwnerArmed') AS sched_armed,
            metadata->>'triggerKind' AS trigger_kind
     FROM crossmodel_messages WHERE "chatId" LIKE 'cbead56f%' AND "createdAt" > '2026-09-27T18:10:00Z'
     ORDER BY "createdAt" ASC LIMIT 10`);
  console.log(JSON.stringify({ sched, runs, msgs }, BIG, 1));
  process.exit(0);
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
