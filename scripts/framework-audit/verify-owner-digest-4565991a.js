// Ticket 4565991a recurrence probe (2026-09-27) — READ-ONLY.
// Ground truth for the digest lane chat dddbf9ba-e9ff-431d-97ac-2e4e5ef7dc38:
//  1. the schedule rungs (ownerSubscribed / promptSetBy / kind) — which row fired today;
//  2. today's message rows: does the WAKE user row carry metadata.scheduleOwnerArmed,
//     and does the ASSISTANT answer row carry metadata.kind 'owner_digest'?
//  3. the same for Sep 26 (the prior recurrence) for comparison.
const prisma = require('/app/dist/config/database').default;
const BIG = (_k, v) => (typeof v === 'bigint' ? Number(v) : v);
const q = (sql) => prisma.$queryRawUnsafe(sql);
const out = {};
async function sec(name, fn) { try { out[name] = await fn(); } catch (e) { out[name] = { ERR: String(e.message || e).slice(0, 300) }; } }
const CHAT = 'dddbf9ba-e9ff-431d-97ac-2e4e5ef7dc38';
(async () => {
  await sec('schedule_rungs', () => q(
    `SELECT id, kind, enabled, "promptSetBy", "ownerSubscribed", "nextRunAt", "lastFiredAt", "lastStatus", "runsCount", LEFT("createdAt"::text,19) AS created
     FROM coding_schedules WHERE "sessionId"='${CHAT}' ORDER BY "createdAt" DESC LIMIT 12`));

  // Which rung fired at ~14:28Z today, and its subscription state THEN.
  await sec('rung_that_fired_today', () => q(
    `SELECT id, kind, "promptSetBy", "ownerSubscribed", "lastFiredAt", "cancelledBy"
     FROM coding_schedules WHERE "sessionId"='${CHAT}' AND "lastFiredAt" > '2026-09-27T00:00:00Z' ORDER BY "lastFiredAt" DESC LIMIT 5`));

  // Today's + Sep 26's message rows on the digest chat, metadata-shape only (no content bodies).
  await sec('digest_rows_meta', () => q(
    `SELECT LEFT(id::text,8) AS msg, role, "createdAt",
            metadata->>'origin' AS origin,
            metadata->>'kind' AS kind,
            (metadata->>'scheduleOwnerArmed') AS sched_owner_armed,
            metadata->>'triggerKind' AS trigger_kind,
            metadata->>'scheduleId' AS schedule_id,
            LEFT(content, 90) AS head
     FROM crossmodel_messages WHERE "chatId"='${CHAT}'
       AND "createdAt" > '2026-09-26T00:00:00Z'
     ORDER BY "createdAt" ASC LIMIT 60`));

  // Any owner_digest-stamped row on this chat EVER (also count platform-wide since the fix shipped).
  await sec('owner_digest_rows_this_chat', () => q(
    `SELECT LEFT(id::text,8) AS msg, role, "createdAt", metadata->>'origin' AS origin
     FROM crossmodel_messages WHERE "chatId"='${CHAT}' AND metadata->>'kind'='owner_digest' ORDER BY "createdAt" DESC LIMIT 10`));
  await sec('owner_digest_rows_platform_wide', () => q(
    `SELECT LEFT("chatId"::text,8) AS chat, COUNT(*)::int AS n, MAX("createdAt") AS last
     FROM crossmodel_messages WHERE metadata->>'kind'='owner_digest' GROUP BY 1 ORDER BY 3 DESC LIMIT 10`));
  await sec('scheduleOwnerArmed_wake_rows', () => q(
    `SELECT LEFT("chatId"::text,8) AS chat, LEFT(id::text,8) AS msg, role, "createdAt", metadata->>'origin' AS origin
     FROM crossmodel_messages WHERE metadata->>'scheduleOwnerArmed'='true' ORDER BY "createdAt" DESC LIMIT 10`));

  console.log(JSON.stringify(out, BIG, 1));
  process.exit(0);
})().catch(e => { console.error('PROBE FAIL', e); process.exit(1); });
