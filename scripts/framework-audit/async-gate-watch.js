#!/usr/bin/env node
/**
 * async-gate-watch.js — READ-ONLY: wait (bounded) for the Phase-3b gate's
 * decisive row: an `async_tool_calls_deliver` entry at phase `delivered`,
 * written under `apply:true`.
 *
 * Why a bounded wait and not a single read: a handed-off call writes
 * `threshold_crossed` at t+60 s and `delivered` only when the underlying work
 * FINISHES, so the two rows are minutes apart by construction. Reading once
 * right after a call crosses the threshold would report "no delivery" even on a
 * perfectly healthy hand-off.
 *
 * Prints every apply-mode threshold row it saw (with its correlation id) plus
 * any delivered row, so the caller can join a transcript "Started" id to a
 * delivery row.
 */
const prisma = require('/app/dist/config/database').default;

const SECONDS = Number(process.env.WATCH_SECONDS || 150);
const started = Date.now();

(async () => {
  let delivered = [];
  let applyRows = [];
  while (Date.now() - started < SECONDS * 1000) {
    // NOTE: `apply` is stamped ONLY on the threshold_crossed row (agent.ts:2434
    // adds it conditionally); a `delivered` row never carries it. Filtering
    // delivered on apply='true' therefore matches NOTHING and would read as
    // "no delivery ever" on a perfectly healthy hand-off. Join to the crossing
    // row by correlation id instead, which is exactly how the gate is cited.
    delivered = await prisma.$queryRawUnsafe(
      `SELECT d."createdAt"::text AS at, d."sessionId" AS chat_id, d."runId" AS run_id,
              d.meta->>'id' AS correlation_id, d.meta->>'tool' AS tool,
              d.meta->>'phase' AS phase, d."value"::int AS elapsed_ms,
              c."createdAt"::text AS crossed_at, c.meta->>'apply' AS crossed_apply
       FROM "loop_metrics" d
       LEFT JOIN "loop_metrics" c
         ON c.kind='async_tool_calls_deliver' AND c.meta->>'phase'='threshold_crossed'
        AND c.meta->>'id' = d.meta->>'id'
       WHERE d.kind='async_tool_calls_deliver'
         AND d.meta->>'phase'='delivered'
         AND d."createdAt" > now() - interval '30 minutes'
       ORDER BY d."createdAt" DESC LIMIT 10`);
    applyRows = await prisma.$queryRawUnsafe(
      `SELECT "createdAt"::text AS at, "sessionId" AS chat_id, "runId" AS run_id,
              meta->>'id' AS correlation_id, meta->>'tool' AS tool,
              meta->>'apply' AS apply, meta->>'phase' AS phase, "value"::int AS elapsed_ms
       FROM "loop_metrics" WHERE kind='async_tool_calls_deliver'
         AND meta->>'apply'='true'
         AND "createdAt" > now() - interval '15 minutes'
       ORDER BY "createdAt" DESC LIMIT 10`);
    if (delivered.length) break;
    await new Promise((r) => setTimeout(r, 10000));
  }

  console.log(JSON.stringify({
    at: new Date().toISOString(),
    waitedSeconds: Math.round((Date.now() - started) / 1000),
    deliveredApplyRows: delivered,
    anyApplyRows: applyRows,
    gateSignal: delivered.length > 0,
  }, null, 2));
  await prisma.$disconnect();
  process.exit(0);
})().catch(async (e) => {
  console.log(JSON.stringify({ error: String((e && e.message) || e).slice(0, 600) }));
  process.exit(1);
});