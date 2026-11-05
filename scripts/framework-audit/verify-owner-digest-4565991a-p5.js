// Ticket 4565991a E2E probe p5 (2026-09-27) — READ-ONLY: after a real owner-subscribed
// CODING firing, do the wake user row + final assistant row carry the new stamps?
// Usage: node verify-owner-digest-4565991a-p5.js <chatId> <sinceISO>
const prisma = require('/app/dist/config/database').default;
const BIG = (_k, v) => (typeof v === 'bigint' ? Number(v) : v);
const q = (sql) => prisma.$queryRawUnsafe(sql);
const chatId = process.argv[2] || '6ef785c3-8f9e-76e9-917-16fe967488cf';
const since = process.argv[3] || '2026-09-27T17:45:00Z';
(async () => {
  const rows = await q(
    `SELECT LEFT(id::text,8) AS msg, role, "createdAt", "updatedAt",
            metadata->>'origin' AS origin, metadata->>'kind' AS kind,
            (metadata->>'scheduleOwnerArmed') AS sched_armed,
            metadata->>'triggerKind' AS trigger_kind, metadata->>'scheduleId' AS schedule_id,
            LEFT(content, 60) AS head
     FROM crossmodel_messages WHERE "chatId"='${chatId}' AND "createdAt" > '${since}'
     ORDER BY "createdAt" ASC LIMIT 20`);
  const counts = await q(
    `SELECT COUNT(*) FILTER (WHERE metadata->>'kind'='owner_digest')::int AS digest_rows,
            COUNT(*) FILTER (WHERE metadata->>'scheduleOwnerArmed'='true')::int AS armed_rows
     FROM crossmodel_messages WHERE "chatId"='${chatId}'`);
  console.log(JSON.stringify({ rows, counts: counts[0] }, BIG, 1));
  process.exit(0);
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
