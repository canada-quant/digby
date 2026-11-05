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
 * transcript-drop-gate.js — READ-ONLY MERGE-1 DROP gate (todo 2fd4416a).
 *
 * Answers ONE question before anyone drops `coding_messages`: can that table be
 * dropped without losing a message? Runs INSIDE a box-side backend container
 * (it requires /app/dist/config/database, i.e. the deployed Prisma client) and
 * prints ONE JSON object.
 *
 * Usage (keyless, via SSM):
 *   scripts/framework-audit/run-on-box.sh C \
 *     "sudo docker cp /tmp/x.js admin-worker-blue:/tmp/x.js && sudo docker exec admin-worker-blue node /tmp/x.js"
 *
 * THE GATE IS A SUBSET CHECK, NOT EQUALITY. Per-chat row-count EQUALITY is
 * unsatisfiable by design once one session carries both a chat profile and a
 * coding profile (the one-session object model): the merged transcript then
 * legitimately holds chat-profile turns the legacy table never saw. Measured
 * 2026-11-02: 125 of 1700 chats reported mirrored > legacy for exactly that
 * reason. The migration's actual obligation — no legacy message is lost — is
 * "every legacy id has a mirror row in the SAME chat", which is a SUBSET test
 * and goes green exactly when the data is right. Same contract as
 * backend/scripts/backfill-coding-transcripts.ts --verify.
 *
 * THE CHECKSUM IS A DIAGNOSTIC, NOT THE GATE. The md5 signature is over
 * `id|epoch(createdAt)|length(parts)` on each side. It MUST differ whenever the
 * merged side holds extra rows (a chat-profile turn has no legacy counterpart),
 * so a raw mismatch count conflates two very different situations:
 *   - `count_differs`      — expected, benign (merged has extra chat turns).
 *   - `content_divergence` — equal row counts but a different digest: the SAME
 *                            rows disagree on createdAt or parts. This is the
 *                            only mismatch class worth acting on, and it is
 *                            reported separately here so it cannot hide inside
 *                            the benign majority.
 *
 * Writes nothing. Credentials are the container's own DATABASE_URL.
 */
const prisma = require('/app/dist/config/database').default;

const CHAT_CAP = Number(process.env.PROOF_CHAT_CAP || 400);

const digestSql = (table, chatCol) => `
  SELECT COUNT(*)::int AS n,
         COALESCE(md5(string_agg(sig, E'\\n' ORDER BY "createdAt", "id")), md5('')) AS digest
  FROM (
    SELECT "id" || '|' || extract(epoch from "createdAt")::text || '|' ||
           COALESCE(length("parts"::text), -1)::text AS sig,
           "id", "createdAt"
    FROM "${table}" WHERE "${chatCol}" = $1
  ) t`;

const digest = async (table, chatCol, chatId) => {
  const r = await prisma.$queryRawUnsafe(digestSql(table, chatCol), chatId);
  return { n: Number(r[0].n), digest: r[0].digest };
};

(async () => {
  const out = { at: new Date().toISOString(), gate: 'subset', chatCap: CHAT_CAP };

  const [t] = await prisma.$queryRawUnsafe(
    `SELECT (SELECT COUNT(*)::int FROM "coding_messages") AS legacy_rows,
            (SELECT COUNT(*)::int FROM "crossmodel_messages") AS merged_rows`);
  out.totals = { legacyRows: Number(t.legacy_rows), mergedRows: Number(t.merged_rows) };

  // ── THE GATE: no legacy row may be absent from the mirror ──
  const [miss] = await prisma.$queryRawUnsafe(
    `SELECT COUNT(*)::int AS missing FROM "coding_messages" l
     LEFT JOIN "crossmodel_messages" m ON l."id" = m."id" AND m."chatId" = l."sessionId"
     WHERE m."id" IS NULL`);
  out.missingInMirror = Number(miss.missing);

  const [mch] = await prisma.$queryRawUnsafe(
    `SELECT COUNT(*)::int AS chats FROM (
       SELECT l."sessionId" FROM "coding_messages" l
       LEFT JOIN "crossmodel_messages" m ON l."id" = m."id" AND m."chatId" = l."sessionId"
       WHERE m."id" IS NULL GROUP BY 1) t`);
  out.chatsWithMissing = Number(mch.chats);

  // ── live write-path liveness: is the CURRENT code still mirroring? ──
  const [nt] = await prisma.$queryRawUnsafe(
    `SELECT (SELECT max("createdAt")::text FROM "coding_messages") AS legacy_newest,
            (SELECT max("createdAt")::text FROM "crossmodel_messages") AS merged_newest`);
  out.newest = { legacy: nt.legacy_newest, merged: nt.merged_newest };

  // A legacy row written in the last 2h with NO mirror row means the deployed
  // write path is not mirroring — the DROP precondition, not a data question.
  const [rec] = await prisma.$queryRawUnsafe(
    `SELECT COUNT(*)::int AS legacy FROM "coding_messages" WHERE "createdAt" > now() - interval '2 hours'`);
  const [recM] = await prisma.$queryRawUnsafe(
    `SELECT COUNT(*)::int AS mirrored FROM "coding_messages" l
       JOIN "crossmodel_messages" m ON l."id" = m."id" AND m."chatId" = l."sessionId"
     WHERE l."createdAt" > now() - interval '2 hours'`);
  out.recent2h = { legacy: Number(rec.legacy), mirrored: Number(recM.mirrored) };

  // ── per-chat row-count + checksum, classified ──
  const chats = await prisma.$queryRawUnsafe(
    `SELECT "sessionId" AS id, COUNT(*)::int AS n FROM "coding_messages"
     GROUP BY 1 ORDER BY n DESC LIMIT ${CHAT_CAP}`);

  const legacyOnly = [];
  const contentDivergence = [];
  const countDiff = { mirroredMore: 0, mirroredLess: 0, equal: 0 };
  const digestDiffer = { countDiffers: 0, countEqual: 0 };

  for (const c of chats) {
    const L = await digest('coding_messages', 'sessionId', c.id);
    const M = await digest('crossmodel_messages', 'chatId', c.id);
    if (M.n === 0 && L.n > 0) { legacyOnly.push({ chatId: c.id, legacyN: L.n }); continue; }
    if (M.n > L.n) countDiff.mirroredMore++;
    else if (M.n < L.n) countDiff.mirroredLess++;
    else countDiff.equal++;

    if (M.digest !== L.digest) {
      if (M.n === L.n) {
        digestDiffer.countEqual++;
        contentDivergence.push({ chatId: c.id, n: L.n });
      } else {
        digestDiffer.countDiffers++;
      }
    }
  }

  out.chatsSampled = chats.length;
  out.legacyOnlyChats = legacyOnly.length;
  out.legacyOnlySample = legacyOnly.slice(0, 5);
  out.countDiff = countDiff;
  out.digestDiffer = digestDiffer;
  out.contentDivergence = contentDivergence.length;
  out.contentDivergenceSample = contentDivergence.slice(0, 5);

  // Gate = the subset invariant + no chat the drop would orphan + no legacy row
  // written recently without a mirror. Content divergence is surfaced, NOT gating:
  // the legacy copy is the one being dropped, so a parts/createdAt drift on the
  // MERGED side cannot lose a legacy message — it is a fidelity question the
  // read-rollback covers, and it is reported for the reviewer either way.
  out.DROP_SAFE = out.missingInMirror === 0 && legacyOnly.length === 0;
  out.contentDivergencePresent = contentDivergence.length > 0;

  console.log(JSON.stringify(out, null, 2));
  await prisma.$disconnect();
  process.exit(0);
})().catch(async (e) => {
  console.log(JSON.stringify({ error: String((e && e.message) || e).slice(0, 600) }));
  process.exit(1);
});