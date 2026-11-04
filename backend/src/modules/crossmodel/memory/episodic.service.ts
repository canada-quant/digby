/**
 * Episodic Memory Service — retrieval over the user's PAST conversations.
 *
 * When the current message references shared history ("what did we discuss last
 * week?", "like I told you before", "in my other chat…"), search the user's
 * previous chats (crossmodel_messages, full-text GIN index) and inject the top
 * matching exchanges as a [RELATED PAST CONVERSATIONS] context block.
 *
 * Deliberately cue-gated + deterministic (same philosophy as memory-relevance):
 * this sits on the pre-query critical path, so it must cost nothing for the
 * ~95% of messages that don't reference the past — a regex gate decides, and
 * only then does the (indexed) FTS query run.
 *
 * Note on the split-ready boundary: this module READS chat-domain tables
 * (crossmodel_messages/chats). Episodic search is chat-data retrieval, not
 * memory-domain storage — if the memory domain moves to a dedicated Postgres,
 * this service stays with the chat data.
 */

import prisma from '../../../config/database';
import logger from '../../../utils/logger';
import { memSearch } from './unified-memory.service';

const MAX_EPISODES = 3;
const SNIPPET_MAX_CHARS = 400;
// 4.5s: the hybrid leg (query embed + rerank) needs ~1.5-2.5s; the path is
// cue-gated so this only ever costs on messages that reference past chats.
const EPISODIC_TIMEOUT_MS = 4500;

/**
 * Does the message reference past shared conversations/history?
 * Conservative: explicit references only — mentioning a topic again is NOT a cue
 * (thread state + facts already cover topical continuity inside a chat).
 */
export function referencesPastConversation(message: string): boolean {
  const m = (message || '').toLowerCase().replace(/[‘’]/g, "'");
  return /\b(last (time|week|month|conversation|chat|session)|we (talked|spoke|discussed|chatted|went over|covered)|you (told|said to|mentioned to|explained to|showed) me|i (told|asked|mentioned to) you (before|earlier|previously|already|once)|(in|from) (a|an|my|the|another|our) (previous|prior|other|earlier|different|old) (chat|conversation|session|thread)|(previous|prior|earlier|other) (chat|conversation|session|thread)s?\b|remember (when|what|that|our|the time)|as (we|you) discussed|like (i|we) (said|mentioned|discussed) (before|earlier|previously|last time)|we've (talked|spoken|discussed|been over)|what did (we|you|i) (say|discuss|talk about|decide|conclude|tell (me|you)|ask)|(bring|pull) up (what|our|the) (we|conversation|discussion)|where did we (leave|land|end up)|pick up where we left off|continue (from|where) (last time|we left))\b/.test(m);
}

interface EpisodeHit {
  chatId: string;
  chatTitle: string;
  role: string;
  content: string;
  createdAt: Date;
  rank: number;
}

/**
 * Search the user's OTHER chats for messages related to the current one.
 * Returns a formatted context block, or '' when the gate doesn't fire /
 * nothing relevant is found / anything fails (never blocks the query).
 */
export async function buildEpisodicBlock(
  userId: string,
  currentMessage: string,
  excludeChatId: string | null,
): Promise<string> {
  if (!userId || !referencesPastConversation(currentMessage)) return '';

  try {
    const search = (async () => {
      // TWO legs run CONCURRENTLY so a slow DashScope call can never starve
      // the Postgres-only leg inside the race window:
      // - unified leg: distilled conversation records (hybrid inside memSearch)
      //   catch PARAPHRASE that raw-text FTS never could;
      // - FTS leg over live messages: exact tokens + pre-distillation chats.
      const unifiedPromise = memSearch(
        [{ type: 'user', id: userId }], currentMessage, MAX_EPISODES * 2, { sources: ['conversation'], purpose: 'episodic' }
      ).catch(() => [] as Awaited<ReturnType<typeof memSearch>>);

      // plainto_tsquery ANDs all terms, which over-restricts long questions —
      // strip to the meatiest words and OR them via to_tsquery.
      const words = currentMessage
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(w => w.length >= 4)
        .slice(0, 8);
      const ftsPromise: Promise<EpisodeHit[]> = words.length === 0
        ? Promise.resolve([])
        : prisma.$queryRawUnsafe(
            `SELECT m."chatId" as "chatId", c.title as "chatTitle", m.role, m.content,
                    m."createdAt" as "createdAt",
                    ts_rank(to_tsvector('english', m.content), to_tsquery('english', $1)) AS rank
             FROM crossmodel_messages m
             JOIN crossmodel_chats c ON c.id = m."chatId"
             WHERE c."userId" = $2
               AND c."archivedAt" IS NULL -- archived chats leave episodic recall (search-defaults rule)
               AND ($3::text IS NULL OR m."chatId" <> $3)
               AND to_tsvector('english', m.content) @@ to_tsquery('english', $1)
             ORDER BY rank DESC, m."createdAt" DESC
             LIMIT ${MAX_EPISODES * 3}`,
            words.join(' | '), userId, excludeChatId
          ) as Promise<EpisodeHit[]>;
      const [unifiedHits, hits] = await Promise.all([unifiedPromise, ftsPromise]);

      // Dedupe the unified leg per chat (a chat distills one record per
      // exchange — don't let one conversation fill every slot), drop the
      // current chat, and cap at MAX_EPISODES.
      const seenRefs = new Set<string>();
      const unified = unifiedHits.filter(h => {
        if (!h.ref || h.ref === excludeChatId || seenRefs.has(h.ref)) return false;
        seenRefs.add(h.ref);
        return true;
      }).slice(0, MAX_EPISODES);
      if (hits.length === 0 && unified.length === 0) return '';

      // FTS fills the REMAINING slots (one snippet per chat, skipping chats
      // the unified leg already covers) — exactly MAX_EPISODES total.
      const coveredChats = new Set(unified.map(h => h.ref));
      const byChat = new Map<string, EpisodeHit>();
      for (const h of hits) {
        if (unified.length + byChat.size >= MAX_EPISODES) break;
        if (coveredChats.has(h.chatId)) continue;
        if (!byChat.has(h.chatId)) byChat.set(h.chatId, h);
      }

      const lines: string[] = [
        '[RELATED PAST CONVERSATIONS — background reference from the user\'s earlier chats]',
      ];
      for (const u of unified.slice(0, MAX_EPISODES)) {
        const when = new Date(u.createdAt).toISOString().split('T')[0];
        const snippet = u.content.replace(/\s+/g, ' ').trim().substring(0, SNIPPET_MAX_CHARS);
        lines.push(`• (${when}) "${u.title}" — ${snippet}${u.content.length > SNIPPET_MAX_CHARS ? '…' : ''}`);
      }
      for (const h of byChat.values()) {
        const when = new Date(h.createdAt).toISOString().split('T')[0];
        const who = h.role === 'user' ? 'User' : 'Digby';
        const snippet = h.content.replace(/\s+/g, ' ').trim().substring(0, SNIPPET_MAX_CHARS);
        lines.push(`• (${when}, chat "${h.chatTitle}") ${who}: "${snippet}${h.content.length > SNIPPET_MAX_CHARS ? '…' : ''}"`);
      }
      lines.push(
        'Use these ONLY because the user referenced a past conversation. Quote/summarize what is relevant; if none of it matches what the user means, say you could not find that discussion rather than inventing one.'
      );
      return lines.join('\n');
    })();

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        search,
        new Promise<string>(resolve => {
          timer = setTimeout(() => resolve(''), EPISODIC_TIMEOUT_MS);
        }),
      ]);
    } finally {
      // Clear even when search rejects — a rejected race would otherwise leave
      // the 2s timer pending on every failed lookup
      if (timer) clearTimeout(timer);
    }
  } catch (err: any) {
    logger.debug(`episodic: search failed (non-fatal): ${err.message}`);
    return '';
  }
}
