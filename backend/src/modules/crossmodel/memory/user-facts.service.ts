/**
 * User Facts Service — semantic retrieval over stored user-memory facts.
 *
 * The user_memory.facts JSON blob stays CANONICAL (every guardrail — rejections,
 * the strict name rule, dream consolidation — operates on the blob, unchanged).
 * This service maintains a derived retrieval index: one row per fact in
 * user_memory_facts, embedded with DashScope text-embedding-v4 (1536d, the same
 * model/space as RAG), searched with pgvector HNSW cosine + a recency boost.
 *
 * Retrieval replaces the pure keyword-overlap relevance gate for topical facts:
 * semantically related facts are injected even when no token matches ("what
 * should I cook tonight" ↔ "diet: pescatarian"). The hard-won guardrails are
 * preserved on top:
 *   - identity/style keys (ALWAYS_INJECT_FACT_KEYS) always pass
 *   - location keys pass on local intent (hasLocalIntent)
 *   - memory-recall questions inject everything (isMemoryRecallQuery)
 *   - on ANY failure/timeout → fall back to the keyword gate (never block a query)
 *
 * Sync model: syncUserFactRows(userId) reconciles rows to the CURRENT blob —
 * fire-and-forget after every blob write site. Only new/changed facts are
 * re-embedded; removed facts are deleted; lastSeenAt bumps only on add/change
 * (it approximates fact freshness, which feeds the recency boost).
 *
 * SPLIT-READY BOUNDARY: user_memory_facts is memory-domain — no joins into
 * app-core tables; all access goes through this module.
 */

import prisma from '../../../config/database';
import logger from '../../../utils/logger';
import { embedTexts } from '../rag.service';
import { invalidateQuestionsCache } from '../suggested-questions.service';
import { stripNulBytes } from './text-utils';
import {
  ALWAYS_INJECT_FACT_KEYS,
  filterFactsByRelevance,
  hasLocalIntent,
  isMemoryRecallQuery,
  FactRelevanceResult,
} from '../memory-relevance';

// Top-K facts injected per query (identity keys are added on top of these).
const MAX_SEMANTIC_FACTS = 8;
// Cosine-similarity floor — below this a fact is considered off-topic.
// DashScope text-embedding-v4 short-text similarities: related pairs typically
// land 0.35-0.7; unrelated pairs 0.05-0.25.
const MIN_SIMILARITY = 0.3;
// Half-life style recency boost: a fact re-affirmed today gets +0.08, ~30 days
// old +0.04, very old → +0. Keeps ties broken toward fresher facts without
// letting recency overrule topical similarity.
const RECENCY_BOOST_MAX = 0.08;
const RECENCY_HALF_LIFE_DAYS = 30;
// The semantic path must never blow the 5s context-load budget; beyond this we
// fall back to the deterministic keyword gate for the current query.
const SEMANTIC_TIMEOUT_MS = 2500;

// Location keys duplicated from memory-relevance's private set is avoided by
// re-testing with the keyword gate for the local-intent case (see below).

function factContent(key: string, value: string): string {
  // NUL-free output keeps blob↔row comparisons consistent with Postgres
  // (which rejects 0x00 outright) AND the raw INSERT below batch-safe.
  return stripNulBytes(`${key.replace(/_/g, ' ')}: ${value}`);
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    }),
  ]).finally(() => {
    // Clear the timer so every query doesn't leave a pending timeout behind
    if (timer) clearTimeout(timer);
  }) as Promise<T>;
}

// ── Sync (blob → rows) ─────────────────────────────────────────────────────────

// Per-user in-flight guard: concurrent syncs for the same user waste embedding
// calls and can interleave deletes/upserts. Last caller wins by re-running after.
const inFlightSyncs = new Map<string, Promise<void>>();

/**
 * Reconcile user_memory_facts rows to the CURRENT user_memory.facts blob.
 * Fire-and-forget (never throws): call after any blob write.
 * Reads the blob itself so callers can't pass a stale copy.
 */
export function syncUserFactRows(userId: string): Promise<void> {
  const existing = inFlightSyncs.get(userId);
  if (existing) return existing;

  const run = (async () => {
    try {
      const memory = await prisma.userMemory.findUnique({
        where: { userId },
        select: { facts: true },
      });
      const rawFacts = (memory?.facts as Record<string, unknown>) || {};
      const blobEntries = Object.entries(rawFacts)
        .filter(([k, v]) => !k.startsWith('__') && v != null && String(v).trim() !== '')
        .map(([k, v]) => [stripNulBytes(k), typeof v === 'object' ? stripNulBytes(JSON.stringify(v)) : stripNulBytes(String(v))] as [string, string]);
      const blobMap = new Map(blobEntries);

      const rows = await prisma.userMemoryFact.findMany({
        where: { userId },
        select: { key: true, content: true },
      });
      const rowMap = new Map(rows.map(r => [r.key, r.content]));

      // Deletions: rows whose key no longer exists in the blob
      const staleKeys = rows.map(r => r.key).filter(k => !blobMap.has(k));
      if (staleKeys.length > 0) {
        await prisma.userMemoryFact.deleteMany({ where: { userId, key: { in: staleKeys } } });
      }

      // Additions/changes: keys missing from rows or whose content changed
      const dirty = blobEntries.filter(([k, v]) => rowMap.get(k) !== factContent(k, v));
      if (dirty.length === 0) {
        // Deletions alone still changed the fact set → the cached home-screen
        // questions are stale too (feedback 93fa84af). HARD: a chip built on a
        // removed fact must not keep being served while the regen runs.
        if (staleKeys.length > 0) void invalidateQuestionsCache(userId, { hard: true });
        return;
      }

      const contents = dirty.map(([k, v]) => factContent(k, v));
      const embeddings = await embedTexts(contents);

      for (let i = 0; i < dirty.length; i++) {
        const [key] = dirty[i];
        const content = contents[i];
        const vectorStr = `[${embeddings[i].join(',')}]`;
        // Raw SQL upsert — Prisma can't bind pgvector params.
        await prisma.$executeRawUnsafe(
          `INSERT INTO user_memory_facts ("id", "userId", "key", "content", "embedding", "lastSeenAt", "createdAt")
           VALUES (gen_random_uuid()::text, $1, $2, $3, $4::vector, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
           ON CONFLICT ("userId", "key")
           DO UPDATE SET "content" = $3, "embedding" = $4::vector, "lastSeenAt" = CURRENT_TIMESTAMP`,
          userId, key, content, vectorStr
        );
      }
      logger.debug(`user-facts: synced ${dirty.length} fact row(s) for ${userId} (${staleKeys.length} removed)`);
      // Facts changed → the cached home-screen questions are now stale
      // (feedback 93fa84af — the 24h cache never invalidated, so new memory
      // took up to a day to show up). Fire-and-forget. Soft (stale-while-
      // revalidate) for additions/changes; HARD when facts were also removed.
      void invalidateQuestionsCache(userId, { hard: staleKeys.length > 0 });
    } catch (err: any) {
      logger.debug(`user-facts: syncUserFactRows failed for ${userId} (non-fatal): ${err.message}`);
    } finally {
      inFlightSyncs.delete(userId);
    }
  })();

  inFlightSyncs.set(userId, run);
  return run;
}

/** Wipe all fact rows for a user (clear-memory path). */
export async function deleteAllFactRows(userId: string): Promise<void> {
  try {
    await prisma.userMemoryFact.deleteMany({ where: { userId } });
  } catch (err: any) {
    logger.debug(`user-facts: deleteAllFactRows failed for ${userId} (non-fatal): ${err.message}`);
  }
}

// ── Retrieval (semantic top-K + recency, guarded fallback) ────────────────────

export interface FactSelection extends FactRelevanceResult {
  /** True when the semantic (embedding) path produced the selection. */
  semantic: boolean;
}

interface FactRowHit {
  key: string;
  score: number;
  lastSeenAt: Date;
}

/**
 * Select which stored facts to inject for the current query.
 *
 * Semantic path: embed the current message (+ recent user messages for
 * follow-up continuity), pull top-K rows by cosine similarity + recency boost,
 * then union with the always-inject identity keys and (on local intent) the
 * location keys via the keyword gate. Falls back to the pure keyword gate when
 * rows/embeddings are unavailable, and lazily backfills rows for pre-existing
 * users the first time retrieval finds an empty index.
 */
export async function selectRelevantFacts(
  userId: string,
  facts: Record<string, string>,
  currentMessage: string,
  recentUserMessages: string[] = [],
): Promise<FactSelection> {
  const keywordResult = () => ({
    ...filterFactsByRelevance(facts, currentMessage, recentUserMessages),
    semantic: false,
  });

  const entries = Object.entries(facts).filter(([k]) => !k.startsWith('__'));
  if (entries.length === 0) return { relevant: {}, withheldCount: 0, recallBypass: false, semantic: false };

  // Recall/personalization questions bypass every gate — inject everything.
  if (isMemoryRecallQuery(currentMessage)) {
    return { relevant: Object.fromEntries(entries), withheldCount: 0, recallBypass: true, semantic: false };
  }

  try {
    return await withTimeout(
      (async (): Promise<FactSelection> => {
        const rowCount = await prisma.userMemoryFact.count({ where: { userId } });
        if (rowCount === 0) {
          // Pre-existing user with facts but no index yet — backfill in the
          // background, answer this query via the keyword gate.
          void syncUserFactRows(userId);
          return keywordResult();
        }

        const queryText = [currentMessage, ...recentUserMessages.slice(-2)].join('\n').substring(0, 4000);
        const [queryEmbedding] = await embedTexts([queryText]);
        const vectorStr = `[${queryEmbedding.join(',')}]`;

        const hits: FactRowHit[] = await prisma.$queryRawUnsafe(
          `SELECT "key", (1 - ("embedding" <=> $1::vector)) AS score, "lastSeenAt"
           FROM user_memory_facts
           WHERE "userId" = $2 AND "embedding" IS NOT NULL
           ORDER BY "embedding" <=> $1::vector
           LIMIT ${MAX_SEMANTIC_FACTS * 2}`,
          vectorStr, userId
        );

        const now = Date.now();
        const scored = hits
          .map(h => {
            const ageDays = Math.max(0, (now - new Date(h.lastSeenAt).getTime()) / 86_400_000);
            const recencyBoost = RECENCY_BOOST_MAX * Math.pow(0.5, ageDays / RECENCY_HALF_LIFE_DAYS);
            return { key: h.key, adjusted: Number(h.score) + recencyBoost, similarity: Number(h.score) };
          })
          .filter(h => h.similarity >= MIN_SIMILARITY)
          .sort((a, b) => b.adjusted - a.adjusted)
          .slice(0, MAX_SEMANTIC_FACTS);

        const semanticKeys = new Set(scored.map(s => s.key));

        // Identity/style keys always pass; location keys pass on local intent.
        // Reuse the keyword gate for the local-intent/location logic so the two
        // paths can't drift apart.
        const localIntent = hasLocalIntent([currentMessage, ...recentUserMessages.slice(-1)].join(' '));
        const gateResult = (localIntent)
          ? filterFactsByRelevance(facts, currentMessage, recentUserMessages)
          : null;

        const relevant: Record<string, string> = {};
        let withheldCount = 0;
        for (const [key, value] of entries) {
          const keyNorm = key.toLowerCase().replace(/[^a-z]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
          const isIdentity = ALWAYS_INJECT_FACT_KEYS.has(keyNorm) || ALWAYS_INJECT_FACT_KEYS.has(key.toLowerCase());
          const passesLocal = !!gateResult && key in gateResult.relevant;
          if (isIdentity || passesLocal || semanticKeys.has(key)) {
            relevant[key] = value;
          } else {
            withheldCount++;
          }
        }
        return { relevant, withheldCount, recallBypass: false, semantic: true };
      })(),
      SEMANTIC_TIMEOUT_MS,
      'user-facts semantic retrieval'
    );
  } catch (err: any) {
    logger.debug(`user-facts: semantic retrieval fell back to keyword gate (non-fatal): ${err.message}`);
    return keywordResult();
  }
}
