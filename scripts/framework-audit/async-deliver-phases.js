#!/usr/bin/env node
/**
 * async-deliver-phases.js — READ-ONLY: what phases has the async-tool delivery
 * machinery actually produced, ever?
 *
 * The Phase-3b gate needs an `async_tool_calls_deliver` row at phase
 * `delivered`. Before waiting on a run hosted on the armed worker, it is worth
 * knowing whether `delivered` has EVER landed — if it has, the machinery works
 * and the gate is a matter of arming + a long call; if it never has, waiting
 * again would be the same dead wait in a new costume, and the fault is in the
 * delivery path, not the switch.
 *
 * Also reports how many rows were written with `apply` true vs false, which
 * separates "handed off" from "only observed".
 *
 * Writes nothing. Prints ONE JSON object.
 */
const prisma = require('/app/dist/config/database').default;

(async () => {
  const out = { at: new Date().toISOString() };

  out.phasesAllTime = await prisma.$queryRawUnsafe(
    `SELECT COALESCE(meta->>'phase','<none>') AS phase,
            COUNT(*)::int AS rows,
            MIN("createdAt")::text AS first_at,
            MAX("createdAt")::text AS last_at
     FROM "loop_metrics" WHERE kind = 'async_tool_calls_deliver'
     GROUP BY 1 ORDER BY rows DESC`);

  out.applyAllTime = await prisma.$queryRawUnsafe(
    `SELECT COALESCE(meta->>'apply','<none>') AS apply,
            COUNT(*)::int AS rows, MAX("createdAt")::text AS last_at
     FROM "loop_metrics" WHERE kind = 'async_tool_calls_deliver'
     GROUP BY 1 ORDER BY rows DESC`);

  out.observeModes = await prisma.$queryRawUnsafe(
    `SELECT COALESCE(meta->>'mode','<none>') AS mode, COUNT(*)::int AS rows,
            MAX("createdAt")::text AS last_at
     FROM "loop_metrics" WHERE kind = 'async_tool_calls_observe'
       AND "createdAt" > now() - interval '24 hours'
     GROUP BY 1 ORDER BY rows DESC`);

  // Any `delivered` row in the last 24h, with its correlation id.
  out.recentDelivered = await prisma.$queryRawUnsafe(
    `SELECT "createdAt"::text AS at, "sessionId" AS chat_id, "runId" AS run_id,
            meta->>'id' AS correlation_id, meta->>'tool' AS tool,
            meta->>'apply' AS apply, "value"::int AS elapsed_ms
     FROM "loop_metrics"
     WHERE kind = 'async_tool_calls_deliver' AND meta->>'phase' = 'delivered'
       AND "createdAt" > now() - interval '7 days'
     ORDER BY "createdAt" DESC LIMIT 10`);

  console.log(JSON.stringify(out, null, 2));
  await prisma.$disconnect();
  process.exit(0);
})().catch(async (e) => {
  console.log(JSON.stringify({ error: String((e && e.message) || e).slice(0, 600) }));
  process.exit(1);
});