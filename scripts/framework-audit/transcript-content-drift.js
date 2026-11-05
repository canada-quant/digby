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
 * transcript-content-drift.js — READ-ONLY: size the ONE divergence class that is
 * not a serialization artifact. A row whose shared `id` carries DIFFERENT
 * `content` on the legacy and merged sides means the two transcripts disagree
 * about what was actually said. That matters twice:
 *   - today, because `TRANSCRIPT_READ` defaults to `merged` (so the merged text is
 *     what users already read), and
 *   - at the DROP, because the legacy copy is the one deleted — so this is a
 *     fidelity question, not a message-loss question.
 * Reported separately so it can never hide inside the benign parts-length majority.
 *
 * Writes nothing. Prints ONE JSON object.
 */
const prisma = require('/app/dist/config/database').default;

(async () => {
  const out = { at: new Date().toISOString() };

  // Fleet-wide, not sample-bounded: every shared id whose content disagrees.
  const [agg] = await prisma.$queryRawUnsafe(
    `SELECT COUNT(*)::int AS rows, COUNT(DISTINCT l."sessionId")::int AS chats
     FROM "coding_messages" l
     JOIN "crossmodel_messages" m ON l."id" = m."id" AND m."chatId" = l."sessionId"
     WHERE l."content" IS DISTINCT FROM m."content"`);
  out.fleet = { rows: Number(agg.rows), chats: Number(agg.chats) };

  out.byRole = await prisma.$queryRawUnsafe(
    `SELECT l."role"::text AS role, COUNT(*)::int AS rows
     FROM "coding_messages" l
     JOIN "crossmodel_messages" m ON l."id" = m."id" AND m."chatId" = l."sessionId"
     WHERE l."content" IS DISTINCT FROM m."content"
     GROUP BY 1 ORDER BY rows DESC`);

  // Which side is longer? A merged side that is consistently SHORTER would mean
  // text loss; longer or equal-length edits point at a rewrite/append path.
  out.lengths = await prisma.$queryRawUnsafe(
    `SELECT
       COUNT(*) FILTER (WHERE length(m."content") > length(l."content"))::int AS merged_longer,
       COUNT(*) FILTER (WHERE length(m."content") < length(l."content"))::int AS merged_shorter,
       COUNT(*) FILTER (WHERE length(m."content") = length(l."content"))::int AS same_length
     FROM "coding_messages" l
     JOIN "crossmodel_messages" m ON l."id" = m."id" AND m."chatId" = l."sessionId"
     WHERE l."content" IS DISTINCT FROM m."content"`);

  out.samples = await prisma.$queryRawUnsafe(
    `SELECT l."id" AS id, l."sessionId" AS chat_id, l."role"::text AS role,
            l."updatedAt"::text AS legacy_updated,
            length(l."content") AS legacy_len, length(m."content") AS merged_len,
            left(l."content", 160) AS legacy_head, left(m."content", 160) AS merged_head
     FROM "coding_messages" l
     JOIN "crossmodel_messages" m ON l."id" = m."id" AND m."chatId" = l."sessionId"
     WHERE l."content" IS DISTINCT FROM m."content"
     ORDER BY abs(length(m."content") - length(l."content")) DESC
     LIMIT 6`);

  console.log(JSON.stringify(out, null, 2));
  await prisma.$disconnect();
  process.exit(0);
})().catch(async (e) => {
  console.log(JSON.stringify({ error: String((e && e.message) || e).slice(0, 600) }));
  process.exit(1);
});