#!/usr/bin/env node
/** READ-ONLY: which chats/runs are now producing mode:'apply' vs 'observe'? */
const prisma = require('/app/dist/config/database').default;
(async () => {
  const out = { at: new Date().toISOString() };
  out.recent = await prisma.$queryRawUnsafe(
    `SELECT "createdAt"::text AS at, "sessionId" AS chat_id, "runId" AS run_id,
            meta->>'mode' AS mode, meta->>'tool' AS tool
     FROM "loop_metrics" WHERE kind='async_tool_calls_observe'
       AND "createdAt" > now() - interval '20 minutes'
     ORDER BY "createdAt" DESC LIMIT 25`);
  out.byChatApply = await prisma.$queryRawUnsafe(
    `SELECT "sessionId" AS chat_id, meta->>'mode' AS mode, COUNT(*)::int AS rows,
            MAX("createdAt")::text AS last_at
     FROM "loop_metrics" WHERE kind='async_tool_calls_observe'
       AND "createdAt" > now() - interval '30 minutes'
     GROUP BY 1,2 ORDER BY rows DESC LIMIT 15`);
  console.log(JSON.stringify(out, null, 2));
  await prisma.$disconnect(); process.exit(0);
})().catch(async (e) => { console.log(JSON.stringify({error:String((e&&e.message)||e).slice(0,500)})); process.exit(1); });