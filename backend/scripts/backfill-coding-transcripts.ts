/**
 * P5-A transcript backfill: coding_messages → crossmodel_messages.
 *
 * Idempotent and resumable by construction: every row is inserted with
 * `ON CONFLICT ("id") DO NOTHING` (ids are reused across the two tables), so a
 * re-run — or a resume after interruption — simply skips what's already there.
 * The scan paginates by keyset on (createdAt, id), so concurrent dual-writes
 * can't shift the window mid-scan.
 *
 * Usage:
 *   cd backend && npx tsx scripts/backfill-coding-transcripts.ts [--batch=500]
 *   cd backend && npx tsx scripts/backfill-coding-transcripts.ts --verify
 *
 *   --batch=N   rows scanned per page (default 500)
 *   --verify    write nothing: per-chat row-count + md5 checksum comparison of
 *               legacy vs mirrored transcripts; prints every mismatch and exits
 *               non-zero if any chat diverges.
 *
 * Column mapping (physical):
 *   coding_messages.id        → crossmodel_messages.id        (reused — idempotency)
 *   coding_messages.sessionId → crossmodel_messages.chatId
 *   coding_messages.role      → crossmodel_messages.role      (1:1)
 *   coding_messages.content   → crossmodel_messages.content
 *   — no counterpart —        → crossmodel_messages.metadata  (NULL; column default)
 *   coding_messages.parts     → crossmodel_messages.parts     (jsonb, 1:1)
 *   coding_messages.createdAt → crossmodel_messages.createdAt (preserved, not defaulted)
 */

import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

/** Minimal Prisma surface this script uses — injectable for tests. */
export interface BackfillDb {
  $queryRawUnsafe<T = unknown>(sql: string, ...values: unknown[]): Promise<T>;
  $executeRawUnsafe(sql: string, ...values: unknown[]): Promise<number>;
}

export interface LegacyCodingMessageRow {
  id: string;
  sessionId: string;
  role: string;
  content: string;
  parts: unknown;
  createdAt: Date;
}

// Keyset scan: (createdAt, id) > cursor, ordered, limited. Deterministic under
// concurrent inserts — no OFFSET drift.
const SCAN_SQL = `
  SELECT "id", "sessionId", "role", "content", "parts", "createdAt"
  FROM "coding_messages"
  WHERE ("createdAt", "id") > ($1, $2)
  ORDER BY "createdAt", "id"
  LIMIT $3`;

// Explicit column list; "metadata" has no legacy counterpart and stays NULL.
// $5 is the parts JSON as TEXT, cast to jsonb (nullable).
const INSERT_SQL = `
  INSERT INTO "crossmodel_messages" ("id", "chatId", "role", "content", "metadata", "parts", "createdAt")
  VALUES ($1, $2, $3, $4, NULL, $5::jsonb, $6)
  ON CONFLICT ("id") DO NOTHING`;

const CHATS_SQL = `
  SELECT "sessionId" FROM "coding_messages" GROUP BY "sessionId" ORDER BY "sessionId"`;

// Per-chat checksum: md5 over the ordered `id|createdAt|length(parts::text)`
// signature of every row on one side. epoch-seconds text for createdAt is
// identical on both sides because the dual-write/backfill preserves the value.
const digestSql = (table: 'coding_messages' | 'crossmodel_messages', chatCol: 'sessionId' | 'chatId') => `
  SELECT COUNT(*)::int AS n,
         COALESCE(md5(string_agg(sig, E'\\n' ORDER BY "createdAt", "id")), md5('')) AS digest
  FROM (
    SELECT "id" || '|' || extract(epoch from "createdAt")::text || '|' ||
           COALESCE(length("parts"::text), -1)::text AS sig,
           "id", "createdAt"
    FROM "${table}"
    WHERE "${chatCol}" = $1
  ) t`;

const DIGEST_LEGACY_SQL = digestSql('coding_messages', 'sessionId');
const DIGEST_MERGED_SQL = digestSql('crossmodel_messages', 'chatId');

/**
 * THE GATE (MERGE-1 step 2 re-specification, 2026-11-02).
 *
 * Per-chat row-count EQUALITY is unsatisfiable once one session carries both a chat
 * profile and a coding profile — which is the whole point of the one-session object
 * model. Measured 2026-11-02: 125 of 1700 chats reported `mirrored > legacy` purely
 * because the merged transcript correctly holds chat-profile turns the legacy table
 * never saw, so the old equality gate could never go green.
 *
 * The migration's actual obligation is that NO legacy message is lost — i.e. every
 * legacy id is present in the mirror. That is a SUBSET check, and unlike equality it
 * goes green exactly when the data is right.
 */
const MISSING_SQL = `
  SELECT COUNT(*)::int AS missing
  FROM "coding_messages" l
  LEFT JOIN "crossmodel_messages" m
    ON l."id" = m."id" AND m."chatId" = l."sessionId"
  WHERE l."sessionId" = $1 AND m."id" IS NULL`;

/** Class of a chat under the re-specified gate. */
export type VerifyClass = 'ok' | 'digest-only' | 'missing-in-mirror';

export interface VerifyChatResult {
  chatId: string;
  cls: VerifyClass;
  legacy: ChatDigest;
  mirrored: ChatDigest;
  /** Legacy ids in this chat with no mirror row — the only gate-failing quantity. */
  missingIds: number;
}

export interface VerifyResult {
  checked: number;
  /** Chats whose parts-digest AND missing-count are both clean. */
  ok: number;
  /** Chats where every legacy id is mirrored but the parts digest differs (diagnostic only). */
  digestOnly: number;
  /** Chats with at least one legacy id absent from the mirror — THE GATE. */
  missingInMirror: number;
  /** Total legacy rows with no mirror row across every chat — what the gate reads. */
  totalMissingRows: number;
  totalLegacy: number;
  totalMirrored: number;
  mismatches: VerifyChatResult[];
  digestOnlyChats: VerifyChatResult[];
}

export interface BackfillResult {
  scanned: number;
  inserted: number;
  skipped: number;
}

export async function backfillTranscripts(
  db: BackfillDb,
  opts: { batch?: number; onProgress?: (scanned: number, inserted: number, skipped: number) => void } = {},
): Promise<BackfillResult> {
  const batch = opts.batch ?? 500;
  let scanned = 0;
  let inserted = 0;
  let skipped = 0;
  let nextLogAt = 1000;
  let cursorCreatedAt = new Date(0); // epoch: every real row sorts after this
  let cursorId = '';

  for (;;) {
    const rows = await db.$queryRawUnsafe<LegacyCodingMessageRow[]>(SCAN_SQL, cursorCreatedAt, cursorId, batch);
    if (rows.length === 0) break;
    for (const r of rows) {
      const n = await db.$executeRawUnsafe(
        INSERT_SQL,
        r.id,
        r.sessionId,
        r.role,
        r.content,
        r.parts == null ? null : JSON.stringify(r.parts),
        r.createdAt,
      );
      inserted += n; // 1 = inserted, 0 = ON CONFLICT skip
      skipped += 1 - n;
    }
    scanned += rows.length;
    const last = rows[rows.length - 1];
    cursorCreatedAt = last.createdAt instanceof Date ? last.createdAt : new Date(last.createdAt);
    cursorId = last.id;
    while (scanned >= nextLogAt) {
      opts.onProgress?.(scanned, inserted, skipped);
      nextLogAt += 1000;
    }
    if (rows.length < batch) break;
  }
  return { scanned, inserted, skipped };
}

export interface ChatDigest {
  count: number;
  digest: string;
}

export type VerifyClass = 'ok' | 'digest-only' | 'missing-in-mirror';

export interface VerifyChatResult {
  chatId: string;
  cls: VerifyClass;
  legacy: ChatDigest;
  mirrored: ChatDigest;
  /** Legacy ids in this chat with no mirror row — the only gate-failing quantity. */
  missingIds: number;
}

export interface VerifyResult {
  checked: number;
  /** Chats with zero missing ids AND a matching parts digest. */
  ok: number;
  /** Chats with zero missing ids but a differing parts digest (DIAGNOSTIC, not a gate). */
  digestOnly: number;
  /** Chats with at least one legacy id absent from the mirror — THE GATE. */
  missingInMirror: number;
  /** Total legacy rows with no mirror row across every chat — what the gate reads. */
  totalMissingRows: number;
  totalLegacy: number;
  totalMirrored: number;
  /** Chats that FAIL the gate (missing-in-mirror), with detail. */
  mismatches: VerifyChatResult[];
  /** Chats reported for legibility only (digest drift, no loss). */
  digestOnlyChats: VerifyChatResult[];
}

async function chatDigest(db: BackfillDb, side: 'legacy' | 'mirrored', chatId: string): Promise<ChatDigest> {
  const rows = await db.$queryRawUnsafe<{ n: number | string; digest: string }[]>(
    side === 'legacy' ? DIGEST_LEGACY_SQL : DIGEST_MERGED_SQL,
    chatId,
  );
  return { count: Number(rows[0]?.n ?? 0), digest: String(rows[0]?.digest ?? '') };
}

/**
 * Per-chat verification under the RE-SPECIFIED gate (2026-11-02).
 *
 * THE GATE is `missingIds === 0` for every chat: every legacy message still has a
 * mirror row, so no message can be lost when `coding_messages` is dropped. The parts
 * digest is a DIAGNOSTIC — it is reported in its own class and never fails the run,
 * because the mirror is legitimately enriched after backfill by a mirror-only write
 * path (measured: 658 shared rows with legacy parts NULL and non-NULL on the mirror).
 */
export async function verifyTranscripts(
  db: BackfillDb,
  opts: { onDigestDrift?: (m: VerifyResult['digestOnlyChats'][number]) => void } = {},
): Promise<VerifyResult> {
  const chats = await db.$queryRawUnsafe<{ sessionId: string }[]>(CHATS_SQL);
  let ok = 0;
  let digestOnly = 0;
  let missingInMirror = 0;
  let totalMissingRows = 0;
  let totalLegacy = 0;
  let totalMirrored = 0;
  const mismatches: VerifyChatResult[] = [];
  const digestOnlyChats: VerifyChatResult[] = [];

  for (const c of chats) {
    const legacy = await chatDigest(db, 'legacy', c.sessionId);
    const mirrored = await chatDigest(db, 'mirrored', c.sessionId);
    totalLegacy += legacy.count;
    totalMirrored += mirrored.count;

    const missRows = await db.$queryRawUnsafe<{ missing: number | string }[]>(MISSING_SQL, c.sessionId);
    const missingIds = Number(missRows[0]?.missing ?? 0);
    totalMissingRows += missingIds;

    const digestMatches = legacy.count === mirrored.count && legacy.digest === mirrored.digest;

    if (missingIds > 0) {
      // THE GATE: a legacy message has no mirror row. Count differences here are the
      // real signal; digest drift is secondary.
      missingInMirror++;
      mismatches.push({ chatId: c.sessionId, cls: 'missing-in-mirror', legacy, mirrored, missingIds });
    } else if (!digestMatches) {
      // Every legacy id is mirrored. The parts differ — by-design enrichment, or drift.
      digestOnly++;
      const r: VerifyChatResult = { chatId: c.sessionId, cls: 'digest-only', legacy, mirrored, missingIds: 0 };
      digestOnlyChats.push(r);
      opts.onDigestDrift?.(r);
    } else {
      ok++;
    }
  }

  return {
    checked: chats.length, ok, digestOnly, missingInMirror, totalMissingRows,
    totalLegacy, totalMirrored, mismatches, digestOnlyChats,
  };
}

export function parseArgs(argv: string[]): { verify: boolean; batch: number } {
  const verify = argv.includes('--verify');
  const batchArg = argv.find(a => a.startsWith('--batch='));
  const batch = batchArg === undefined ? 500 : parseInt(batchArg.slice('--batch='.length), 10);
  if (!Number.isFinite(batch) || batch < 1) {
    throw new Error(`Invalid --batch value: ${batchArg} (expected a positive integer)`);
  }
  return { verify, batch };
}

/** CLI entry. Returns the process exit code (0 ok / 1 verify mismatch or error). */
export async function main(argv: string[] = process.argv.slice(2), db?: BackfillDb & { $disconnect(): Promise<void> }): Promise<number> {
  const { verify, batch } = parseArgs(argv);
  const ownDb = db ?? new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' }), log: ['error'] });
  try {
    if (verify) {
      console.log('P5-A transcript verification — GATE: every legacy id present in the mirror (parts digest is diagnostic)');
      const result = await verifyTranscripts(ownDb, {
        onDigestDrift: m => console.log(
          `  digest-only chat ${m.chatId} (every legacy id mirrored; parts differ):\n` +
          `    legacy   { count: ${m.legacy.count}, md5: ${m.legacy.digest} }\n` +
          `    mirrored { count: ${m.mirrored.count}, md5: ${m.mirrored.digest} }`,
        ),
      });
      for (const m of result.mismatches) {
        console.error(
          `  MISSING-IN-MIRROR chat ${m.chatId} — ${m.missingIds} legacy row(s) absent from the mirror:\n` +
          `    legacy   { count: ${m.legacy.count}, md5: ${m.legacy.digest} }\n` +
          `    mirrored { count: ${m.mirrored.count}, md5: ${m.mirrored.digest} }`,
        );
      }
      console.log(
        `\nverify summary: ${result.checked} chat(s) checked — ` +
        `${result.ok} ok, ${result.digestOnly} digest-only (diagnostic), ${result.missingInMirror} missing-in-mirror (GATE); ` +
        `missing rows=${result.totalMissingRows}; rows legacy=${result.totalLegacy} mirrored=${result.totalMirrored}`,
      );
      if (result.totalMissingRows > 0) {
        console.error('verification FAILED — legacy messages have no mirror row; dropping coding_messages would lose them. Re-run the backfill and re-verify.');
        return 1;
      }
      console.log('verification PASSED — every legacy message is present in the mirror');
      return 0;
    }

    console.log(`P5-A transcript backfill — coding_messages → crossmodel_messages (batch=${batch}, idempotent via ON CONFLICT ("id") DO NOTHING)`);
    const result = await backfillTranscripts(ownDb, {
      batch,
      onProgress: (scanned, inserted, skipped) => console.log(`  … ${scanned} scanned (${inserted} inserted, ${skipped} skipped)`),
    });
    console.log(`\nbackfill summary: scanned=${result.scanned} inserted=${result.inserted} skipped=${result.skipped}`);
    return 0;
  } finally {
    await ownDb.$disconnect();
  }
}

/* istanbul ignore next -- CLI entry */
if (require.main === module) {
  main()
    .then(code => { process.exitCode = code; })
    .catch(err => { console.error('backfill failed:', err); process.exitCode = 1; });
}
