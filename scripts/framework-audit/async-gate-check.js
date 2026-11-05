#!/usr/bin/env node
/**
 * async-gate-check.js — READ-ONLY: resolve ONE correlation id end-to-end.
 *
 * The Phase-3b gate is cited as a JOIN, not a single row: a handed-off call
 * writes `threshold_crossed` at t+60s (carrying `apply`), and `delivered` only
 * when the underlying work settles (carrying NO `apply`). Citing either row
 * alone is incomplete, so this prints both, plus the observe row written at
 * dispatch, for a given meta->>'id'.
 */
const prisma = require('/app/dist/config/database').default;
const ID = process.env.CORR_ID || '';

(async () => {
  if (!ID) { console.log(JSON.stringify({ error: 'CORR_ID not set' })); process.exit(1); }
  const rows = await prisma.$queryRawUnsafe(
    `SELECT kind, "createdAt"::text AS at, "sessionId" AS chat_id, "runId" AS run_id,
            meta->>'phase' AS phase, meta->>'tool' AS tool, meta->>'apply' AS apply,
            meta->>'mode' AS mode, meta->>'eligible' AS eligible,
            "value"::int AS value_ms, meta::text AS meta
     FROM "loop_metrics"
     WHERE meta->>'id' = $1
     ORDER BY "createdAt" ASC`, ID);
  const phases = rows.map(r => `${r.kind}:${r.phase || r.mode}`);
  console.log(JSON.stringify({
    at: new Date().toISOString(),
    correlationId: ID,
    rowCount: rows.length,
    phases,
    hasDelivered: phases.some(p => p.endsWith('delivered')),
    rows,
  }, null, 2));
  await prisma.$disconnect(); process.exit(0);
})().catch(async (e) => {
  console.log(JSON.stringify({ error: String((e && e.message) || e).slice(0, 600) }));
  process.exit(1);
});