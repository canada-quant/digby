// Ticket 4565991a probe 2 (2026-09-27) — READ-ONLY.
// Compare the FULL metadata shape of:
//  - the digest lane's (coding-session chat dddbf9ba) wake + answer rows from TODAY's
//    owner-subscribed firing of rung a1bb2121 (kind/ownerArmed stamps MISSING);
//  - chat 810c924d's latest WORKING owner_digest row (the path where the fix DOES land);
//  - what kind of chat each is (CrossModelChat row: type/coding state fields).
const prisma = require('/app/dist/config/database').default;
const BIG = (_k, v) => (typeof v === 'bigint' ? Number(v) : v);
const q = (sql) => prisma.$queryRawUnsafe(sql);
const out = {};
async function sec(name, fn) { try { out[name] = await fn(); } catch (e) { out[name] = { ERR: String(e.message || e).slice(0, 300) }; } }
(async () => {
  await sec('digest_chat_row', () => q(
    `SELECT id, LEFT(title,60) AS title, "userId" IS NOT NULL AS has_user, "createdAt"
     FROM crossmodel_chats WHERE id='dddbf9ba-e9ff-431d-97ac-2e4e5ef7dc38'`));
  await sec('working_chat_row', () => q(
    `SELECT id, LEFT(title,60) AS title, "createdAt" FROM crossmodel_chats WHERE id LIKE '810c924d%'`));
  await sec('coding_state_digest_chat', () => q(
    `SELECT * FROM chat_coding_state WHERE "chatId"='dddbf9ba-e9ff-431d-97ac-2e4e5ef7dc38' LIMIT 1`));
  await sec('coding_state_working_chat', () => q(
    `SELECT * FROM chat_coding_state WHERE "chatId" LIKE '810c924d%' LIMIT 1`));

  await sec('wake_row_full_meta_today', () => q(
    `SELECT metadata FROM crossmodel_messages WHERE id LIKE 'dae58f92%'`));
  await sec('answer_row_full_meta_today', () => q(
    `SELECT metadata FROM crossmodel_messages WHERE id LIKE '71b24778%'`));
  await sec('working_owner_digest_row_meta', () => q(
    `SELECT metadata FROM crossmodel_messages WHERE metadata->>'kind'='owner_digest' ORDER BY "createdAt" DESC LIMIT 1`));
  await sec('working_wake_row_meta', () => q(
    `SELECT metadata FROM crossmodel_messages WHERE id LIKE '5ad226f3%'`));
  // Which run kind produced each: agent_runs provenance for today's digest run.
  await sec('agent_runs_digest_chat_today', () => q(
    `SELECT LEFT(id::text,8) AS run, status, "triggerKind", LEFT("sessionId"::text,8) AS chat, "startedAt", "finishedAt", (input->>'origin') AS input_origin, (input->>'machineWake') AS machine_wake, (input->>'scheduleOwnerArmed') AS input_sched_owner_armed, (input->>'messageOrigin') AS msg_origin
     FROM agent_runs WHERE "sessionId"='dddbf9ba-e9ff-431d-97ac-2e4e5ef7dc38' AND "createdAt" > '2026-09-27T14:00:00Z' ORDER BY "createdAt" LIMIT 8`));
  await sec('agent_runs_working_chat_today', () => q(
    `SELECT LEFT(id::text,8) AS run, status, "triggerKind", LEFT("sessionId"::text,8) AS chat, "startedAt", "finishedAt", (input->>'origin') AS input_origin, (input->>'machineWake') AS machine_wake, (input->>'scheduleOwnerArmed') AS input_sched_owner_armed, (input->>'messageOrigin') AS msg_origin
     FROM agent_runs WHERE "sessionId" LIKE '810c924d%' AND "createdAt" > '2026-09-27T14:00:00Z' ORDER BY "createdAt" LIMIT 8`));

  console.log(JSON.stringify(out, BIG, 1));
  process.exit(0);
})().catch(e => { console.error('PROBE FAIL', e); process.exit(1); });
