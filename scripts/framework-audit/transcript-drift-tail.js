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
 * transcript-drift-tail.js — READ-ONLY: name the EXACT differing segment between a
 * legacy row and its merged mirror, for the small set where they disagree.
 *
 * Why: the aggregate probe found 11 user-role rows whose two copies differ, and
 * several differ by EXACTLY 31 characters. A constant offset is a systematic
 * marker/rewrite, not random corruption — but "31 chars" is not an answer, and
 * the legacy table is the copy a DROP deletes, so the segment must be READ
 * before anyone calls it benign.
 *
 * Prints, per row, the first and last differing window on each side. Truncated
 * hard: this is a classification probe, not a content dump.
 *
 * Writes nothing.
 */
const prisma = require('/app/dist/config/database').default;

const DIFF_WINDOW = 120;

/** First index where two strings differ, or -1. */
const firstDiff = (a, b) => {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : n;
};

(async () => {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT l."id" AS id, l."sessionId" AS chat_id, l."content" AS legacy, m."content" AS merged,
            length(l."content")::int AS legacy_len, length(m."content")::int AS merged_len
     FROM "coding_messages" l
     JOIN "crossmodel_messages" m ON l."id" = m."id" AND m."chatId" = l."sessionId"
     WHERE l."content" IS DISTINCT FROM m."content"
     ORDER BY abs(length(m."content") - length(l."content")) DESC
     LIMIT 20`);

  const out = [];
  for (const r of rows) {
    const L = String(r.legacy ?? ''), M = String(r.merged ?? '');
    const i = firstDiff(L, M);
    const entry = {
      id: r.id,
      chatId: r.chat_id,
      legacyLen: Number(r.legacy_len),
      mergedLen: Number(r.merged_len),
      delta: Number(r.merged_len) - Number(r.legacy_len),
      firstDiffAt: i,
      legacyAtDiff: i >= 0 ? L.slice(i, i + DIFF_WINDOW) : null,
      mergedAtDiff: i >= 0 ? M.slice(i, i + DIFF_WINDOW) : null,
      // The tail of the SHORTER side tells you what was removed when one copy is
      // a prefix of the other with a block deleted from the middle.
      legacyTail: L.slice(-DIFF_WINDOW),
      mergedTail: M.slice(-DIFF_WINDOW),
    };
    // Classify the shape so a reader does not have to squint at 120 chars.
    if (i < 0) entry.shape = 'identical';
    else if (L.startsWith(M) || M.startsWith(L)) entry.shape = 'prefix_one_side';
    else entry.shape = 'mid_string';
    out.push(entry);
  }

  console.log(JSON.stringify({ at: new Date().toISOString(), rows: out.length, detail: out }, null, 2));
  await prisma.$disconnect();
  process.exit(0);
})().catch(async (e) => {
  console.log(JSON.stringify({ error: String((e && e.message) || e).slice(0, 600) }));
  process.exit(1);
});