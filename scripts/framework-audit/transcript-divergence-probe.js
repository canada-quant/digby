#!/usr/bin/env node
// ⚠ RETIRED 2026-11-04 (MERGE-1 step 10): `coding_messages` WAS DROPPED.
// Migration 20261104150000_drop_coding_messages finished 2026-11-04T15:58:58.936Z and
// the deployed build 99114c0c has no such relation (to_regclass -> null). Every SQL
// statement below names that table, so running this now can only fail with
// `42P01 relation "coding_messages" does not exist`. That failure is EXPECTED, not a
// fault. This file is kept ONLY as the historical record of the pre-drop proof; it is
// not runnable and must not be repaired to point elsewhere. For the post-drop end state
// see docs/MERGE1_MIGRATION_PLAN.md -> "POST-DROP CONFIRMATION".
/**
 * transcript-divergence-probe.js — READ-ONLY: NAME the cause of a per-chat
 * digest mismatch between coding_messages and its crossmodel_messages mirror.
 *
 * The drop gate's md5 signature covers three things: id, epoch(createdAt) and
 * length(parts::text). A chat whose row COUNTS match but whose digest differs
 * must disagree on one of the latter two. This probe splits that into
 *   - `createdAt` drift   (same id, different instant)
 *   - `parts` length drift (same id, different serialized length)
 *   - `content` drift      (same id/lengths, different text — the serious one)
 * so a benign serialization artifact is never reported as data corruption, and
 * real content loss is never waved through as an artifact.
 *
 * Writes nothing. Prints ONE JSON object.
 */
const prisma = require('/app/dist/config/database').default;

(async () => {
  // Chats with equal counts but a differing digest — the class to explain.
  const chats = await prisma.$queryRawUnsafe(
    `SELECT "sessionId" AS id, COUNT(*)::int AS n FROM "coding_messages"
     GROUP BY 1 ORDER BY n DESC LIMIT 400`);

  const out = { at: new Date().toISOString(), chatsScanned: 0, equalCountDigestDiffer: 0,
                classes: { createdAtDrift: 0, partsLengthDrift: 0, contentDrift: 0, identical: 0 },
                samples: [] };

  for (const c of chats) {
    const [l] = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS n FROM "coding_messages" WHERE "sessionId" = $1`, c.id);
    const [m] = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS n FROM "crossmodel_messages" WHERE "chatId" = $1`, c.id);
    if (Number(l.n) !== Number(m.n) || Number(l.n) === 0) continue;

    // Compare the two sides row by row on the id they share.
    const [d] = await prisma.$queryRawUnsafe(
      `SELECT
         COUNT(*) FILTER (WHERE l."createdAt" <> m."createdAt")::int          AS ca_drift,
         COUNT(*) FILTER (WHERE COALESCE(length(l."parts"::text),-1)
                             <> COALESCE(length(m."parts"::text),-1))::int   AS parts_drift,
         COUNT(*) FILTER (WHERE l."content" IS DISTINCT FROM m."content")::int AS content_drift,
         COUNT(*)::int                                                        AS joined
       FROM "coding_messages" l
       JOIN "crossmodel_messages" m ON l."id" = m."id" AND m."chatId" = l."sessionId"
       WHERE l."sessionId" = $1`, c.id);

    const ca = Number(d.ca_drift), pa = Number(d.parts_drift), co = Number(d.content_drift);
    if (ca === 0 && pa === 0 && co === 0) { out.classes.identical++; continue; }

    out.equalCountDigestDiffer++;
    if (co > 0) out.classes.contentDrift++;
    else if (pa > 0) out.classes.partsLengthDrift++;
    else if (ca > 0) out.classes.createdAtDrift++;

    if (out.samples.length < 5) {
      out.samples.push({ chatId: c.id, rows: Number(d.joined),
                         createdAtDrift: ca, partsLengthDrift: pa, contentDrift: co });
    }
  }
  console.log(JSON.stringify(out, null, 2));
  await prisma.$disconnect();
  process.exit(0);
})().catch(async (e) => {
  console.log(JSON.stringify({ error: String((e && e.message) || e).slice(0, 600) }));
  process.exit(1);
});