/**
 * CrossModel Context Management Service
 *
 * Handles all aspects of conversation context:
 *
 * 1. Full History Loading — loads ALL messages from a chat. Never deletes or
 *    compresses messages in the database. Context is trimmed READ-ONLY when
 *    sent to models (Phase 1 of v2 architecture).
 *
 * 2. Smart Trimming — when messages exceed model context budgets, trim to
 *    [threadSummary] + last N messages. The DB always has the full history.
 *
 * 3. Persistent User Memory — a PostgreSQL UserMemory row per user stores
 *    key facts (name, preferences, recurring topics) across sessions.
 *    These facts are prepended as a system-level "memory" block.
 *
 * 4. Anonymous Session Memory — anonymous visitors get a sessionId cookie
 *    that maps to a Redis key holding their recent history (TTL: 24 h).
 *    When they log in, the session can be migrated to their account.
 *
 * NOTE: Destructive compression (buildSlidingWindow, compressHistory,
 * persistCompressionMarker) was REMOVED in Phase 1 of v2 architecture.
 * Messages are NEVER deleted or replaced with summaries in the DB.
 * GLM-5.2 has 202k context — it can read everything. For smaller-context
 * models, trimForModelContext() handles read-only trimming.
 */

import axios from 'axios';
import redisClient from '../../config/redis';
import prisma from '../../config/database';
import logger from '../../utils/logger';
import { Message } from './types';
import { filterFactsByRelevance } from './memory-relevance';
import { syncUserFactRows, deleteAllFactRows } from './memory/user-facts.service';
import { recordMemoryMutation, countVisibleFacts, MemoryMutationSource } from './memory/memory-audit';
import { recordFactVersions, purgeAllFactVersions } from './memory/fact-versions';
import { getActivePendingForSession } from './platform/pending-confirmations';
import { redactGuardChromeMessage } from './guard-chrome-redact';
import { EMPTY_RUN_FALLBACK_NOTE } from './coding/harness-error-notes';

// ── Types ──────────────────────────────────────────────────────────────────

/** Canonical message format shared with all AI integrations */
export interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** Full context bundle passed to each model query */
export interface ContextBundle {
  conversationHistory: ConversationMessage[];
  /**
   * The loaded window — the newest HISTORY_FETCH_LIMIT rows in chronological
   * order, before the model-context trim (was "ALL messages" until the
   * 2026-09-14 bounded fetch; no caller ever consumed the full transcript
   * from here — transcript readers use the paged coding-data / fleet loaders).
   */
  fullHistory: ConversationMessage[];
  userMemoryBlock: string;  // Injected into user message or system message
}

// ── Constants ──────────────────────────────────────────────────────────────

/**
 * Newest rows fetched per chat before trimming (loadChatContext). Must stay
 * ≥ MACHINE_WAKE_MAX_PAIRS × 2 (24) with room for the pending-confirmation
 * rehydration and the "everything under the smart-trim threshold" branch;
 * 80 keeps that branch byte-identical for every chat up to 80 rows.
 */
export const HISTORY_FETCH_LIMIT = 80;

/** Default max message-pairs for model context (used when no threadSummary available) */
// 2026-05-28: Increased from 8 → 10 (20 messages total) to further reduce context loss.
const DEFAULT_MAX_PAIRS = 10;

/** Max chars before we switch to threadSummary + tail mode */
// 2026-05-28: Increased from 12000 → 16000 to reduce context loss in technical
// research conversations. User reports showed identical rephrasing (context loss)
// when conversations hit the 12K boundary during multi-turn research sessions.
const SMART_TRIM_CHAR_THRESHOLD = 16000;

/**
 * Machine-wake runs (schedule/hook firings) read a DEEPER history window — up
 * to 12 pairs (24 messages): they aren't latency-bound and live-or-die by
 * continuity with their own prior notes (fleet-supervisor postmortem
 * 2026-08-11). Audit p10: PR #190 only deepened the FINAL slice in
 * chat-agent.service; the upstream loaders here and in memory.graph kept
 * trimming to ~10-20 first, so the deepening was a no-op on exactly the
 * long-running chats it targeted.
 */
export const MACHINE_WAKE_MAX_PAIRS = 12;

/**
 * Char ceiling for the deeper machine-wake window — protects the context
 * window when wake prompts / assistant notes are char-heavy. ~12k tokens;
 * the downstream per-message assistant caps (chat-context
 * truncateHistoryAssistantMessages) still apply on top.
 */
export const MACHINE_WAKE_HISTORY_CHAR_BUDGET = 48000;

/**
 * Drop OLDEST messages until the window fits the char budget (always keeps at
 * least `minMessages` — parity with the shallow window a normal run gets).
 * Pure + exported so memory.graph's long-conversation trim shares it.
 */
export function capHistoryToCharBudget<T extends { content: string }>(
  messages: T[],
  budget: number,
  minMessages: number
): T[] {
  let start = 0;
  let total = messages.reduce((s, m) => s + m.content.length, 0);
  while (total > budget && messages.length - start > minMessages) {
    total -= messages[start].content.length;
    start++;
  }
  return start === 0 ? messages : messages.slice(start);
}

/** Redis TTL for anonymous sessions (24 hours) */
const SESSION_TTL_SECONDS = 86400;

/** Redis key prefix for anonymous sessions */
const SESSION_KEY_PREFIX = 'cm_session:';

// Cohere Command-A — used for memory extraction (replaces Llama-3.3-70B on Fireworks).
import { utilityChat, isUtilityLLMAvailable } from '../../utils/utility-llm';

// ── Main Service ───────────────────────────────────────────────────────────

export class ContextService {

  // ─────────────────────────────────────────────────────────────────────────
  // 1. LOAD CONTEXT — assembles the full ContextBundle for a request
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Load full context for an authenticated user with a named chat.
   * Returns ALL messages (fullHistory) + a trimmed version for model context.
   * Reads from the crossmodel_messages table (O(1) indexed query).
   * NEVER modifies the database — read-only operation.
   */
  async loadChatContext(
    chatId: string,
    userId: string,
    currentMessage?: string,
    opts?: {
      /**
       * Machine-wake runs read the deeper window (MACHINE_WAKE_MAX_PAIRS,
       * char-bounded) instead of DEFAULT_MAX_PAIRS. Threaded from
       * chat-agent.service via buildChatQueryContext/getEnrichedContext.
       */
      deepHistory?: boolean;
      /**
       * Orphan-recovery re-fire (ticket 68bc5aec): exclude ONE message row from
       * the history load. The recovered turn's user row is ALREADY persisted
       * (the run that died wrote it); without the exclusion the recovery run
       * would see the current question in history AND as the live message —
       * the 2026-07-14 "models saw it twice" regression.
       */
      excludeMessageId?: string;
    }
  ): Promise<ContextBundle> {
    try {
      // Verify ownership
      const chat = await prisma.crossModelChat.findUnique({
        where: { id: chatId },
        select: { userId: true },
      });

      if (!chat || chat.userId !== userId) {
        return this.emptyContext();
      }

      // Read from normalized messages table (indexed by chatId + createdAt).
      // Rollout watch 2026-09-14 (tick 9): this used to load EVERY row of the
      // chat and trim afterwards — the Fleet Supervisor's chat (11,548 rows,
      // 58 MB of content, ~520 new rows/day) took 5.9s here on every wake and
      // every user turn, blowing even the 15s machine-wake context deadline
      // and silently dropping the wake's project-memory injection; the same
      // newest-80 window loads in 13ms. Nothing downstream needs more than
      // the trim window (MACHINE_WAKE_MAX_PAIRS × 2 = 24 rows, or everything
      // under SMART_TRIM_CHAR_THRESHOLD), so fetch the newest
      // HISTORY_FETCH_LIMIT rows (id as the tie-breaker) and restore
      // chronological order.
      const rows = (await prisma.crossModelMessage.findMany({
        where: { chatId, ...(opts?.excludeMessageId ? { id: { not: opts.excludeMessageId } } : {}) },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: HISTORY_FETCH_LIMIT,
        select: { role: true, content: true },
      })).reverse();

      // Guard-chrome redaction (ticket ac835c00): a stored evidence-guard /
      // action-verifier replacement wrapper is audit material for the UI and
      // the guard's own detectors — but as MODEL CONTEXT it teaches the exact
      // chrome the guard forbids. Swap it for a neutral placeholder HERE, at
      // the context-build seam, BEFORE rehydration + trim so token/length
      // accounting uses the redacted text. Storage stays byte-identical.
      const fullHistory: ConversationMessage[] = rows.map((r): ConversationMessage =>
        redactGuardChromeMessage({
          role: r.role as 'user' | 'assistant',
          content: r.content,
        }));

      // Pending-confirmation rehydration (plain-chat protocol amnesia fix):
      // a confirmation-gated action's confirmationId lives only in the
      // previous run's tool-result message, which this reload (role+content
      // only) drops — so a user's "confirm" reply starts a run whose model
      // CANNOT complete the protocol and just re-registers (the infinite
      // confirm loop from user feedback). If a live pending exists for this
      // chat, append a compact protocol note to the last assistant message.
      // One indexed DB read (pending_confirmations); expired pendings are
      // excluded by the expiresAt filter — a deploy can no longer strand one.
      const activePending = await getActivePendingForSession(chatId);
      if (activePending) {
        for (let i = fullHistory.length - 1; i >= 0; i--) {
          if (fullHistory[i].role === 'assistant') {
            fullHistory[i] = {
              ...fullHistory[i],
              content:
                `${fullHistory[i].content}\n\n[System note — action awaiting the user's confirmation: ` +
                `in a previous turn you registered a confirmation-gated action and asked the user to confirm it. ` +
                `Tool: ${activePending.tool}. Summary: ${activePending.summary}. confirmationId: "${activePending.confirmationId}". ` +
                `If the user's latest message confirms this action, re-call ${activePending.tool} with just confirmationId "${activePending.confirmationId}" ` +
                `(no other arguments needed — the originally staged arguments execute exactly as summarized). ` +
                `If the user declined or asked for changes, do NOT use that id: call the tool again WITHOUT confirmationId to register the updated action, or drop the matter.]`,
            };
            break;
          }
        }
      }

      // Smart trim for model context — READ-ONLY, never modifies DB
      // Note: threadSummary is loaded from PostgresStore by LangGraph's
      // loadConversationNode, not here. Basic trim uses last N messages.
      const conversationHistory = this.trimForModelContext(
        fullHistory,
        undefined,
        opts?.deepHistory ? MACHINE_WAKE_MAX_PAIRS : DEFAULT_MAX_PAIRS
      );

      const userMemoryBlock = await this.getUserMemoryBlock(userId, currentMessage);

      return { conversationHistory, fullHistory, userMemoryBlock };
    } catch (err) {
      logger.error('ContextService.loadChatContext error:', err);
      return this.emptyContext();
    }
  }

  /**
   * Load context for anonymous user from Redis session.
   */
  async loadSessionContext(sessionId: string): Promise<ContextBundle> {
    try {
      const key = SESSION_KEY_PREFIX + sessionId;
      const raw = await redisClient.get(key);
      if (!raw) return this.emptyContext();

      const messages: ConversationMessage[] = (JSON.parse(raw) as ConversationMessage[]).map(redactGuardChromeMessage);
      const trimmed = this.trimForModelContext(messages);

      // Refresh TTL on access
      await redisClient.expire(key, SESSION_TTL_SECONDS);

      return { conversationHistory: trimmed, fullHistory: messages, userMemoryBlock: '' };
    } catch (err) {
      logger.error('ContextService.loadSessionContext error:', err);
      return this.emptyContext();
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 2. SAVE CONTEXT — persists new messages after a successful response
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Save user + assistant messages to a named chat in PostgreSQL.
   * INSERTs 2 rows into crossmodel_messages — O(1), no read-modify-write.
   * Also touches chat.updatedAt so "recent chats" sort stays correct.
   */
  async saveToChatHistory(
    chatId: string,
    userId: string,
    userMessage: string,
    assistantMessage: string,
    metadata: Message['metadata']
  ): Promise<void> {
    try {
      // Verify ownership
      const chat = await prisma.crossModelChat.findUnique({
        where: { id: chatId },
        select: { userId: true },
      });

      if (!chat || chat.userId !== userId) return;

      // Guard: never persist an undefined/null assistant message — these render as
      // 'undefined' in the chat history UI. If the pipeline produced nothing, store
      // a user-visible fallback. However, empty string IS valid (canvas-only responses
      // intentionally have no text content — the canvas card handles the UX).
      // 2026-06-10: Changed from unconditional fallback to only fallback when the
      // message is undefined/null (not when it's an intentional empty string from
      // stripForStorage). This fixes the bug where canvas-only responses got
      // 'I wasn't able to generate a response...' saved to DB and shown in chat history.
      // 2026-07-03: Also treat the LITERAL strings "undefined"/"null" as a missing
      // message. Production chats surfaced assistant bubbles whose entire content was
      // the word "undefined" — an upstream stringification bug (e.g. String(undefined)
      // or a `${maybeUndefined}` template) slipping a nullish value through as text.
      // The whole-message == "undefined"/"null" case is NEVER a legitimate response,
      // so we fall back like a truly missing message. Empty string stays valid
      // (canvas-only responses intentionally carry no text).
      const trimmed = (assistantMessage ?? '').trim();
      const isStringifiedNullish = /^(undefined|null)$/i.test(trimmed);
      const safeAssistant = (assistantMessage === undefined || assistantMessage === null || isStringifiedNullish)
        ? EMPTY_RUN_FALLBACK_NOTE // ticket 08e58e1d: shared harness-envelope constant (single source of truth)
        : trimmed;

      const now = new Date();

      // INSERT 2 rows — O(1) append, no read-modify-write, no race condition
      await prisma.$transaction([
        prisma.crossModelMessage.create({
          data: {
            chatId,
            role: 'user',
            content: userMessage,
            // Shared-project author attribution (f89d1213): stamp who sent it
            // (the owner here — this path is ownership-guarded above) so the
            // transcript can label non-viewer authors. Additive: legacy rows
            // have no stamp and render as before.
            metadata: { authorId: userId },
            createdAt: now,
          },
        }),
        prisma.crossModelMessage.create({
          data: {
            chatId,
            role: 'assistant',
            content: safeAssistant,
            metadata: metadata as any,
            createdAt: new Date(now.getTime() + 1), // +1ms to ensure ordering
          },
        }),
        // Touch updatedAt so "recent chats" sort stays correct
        prisma.crossModelChat.update({
          where: { id: chatId },
          data: { updatedAt: now },
        }),
      ]);

      logger.debug(`ContextService: saved 2 messages to chat ${chatId} (O(1) insert)`);
    } catch (err) {
      logger.error('ContextService.saveToChatHistory error:', err);
    }
  }

  /**
   * Append user + assistant messages to an anonymous Redis session.
   * Redis sessions keep a rolling window (limited by Redis memory).
   */
  async saveToSessionHistory(
    sessionId: string,
    userMessage: string,
    assistantMessage: string
  ): Promise<void> {
    try {
      const key = SESSION_KEY_PREFIX + sessionId;
      const raw = await redisClient.get(key);
      const existing: ConversationMessage[] = raw ? JSON.parse(raw) : [];

      // For Redis sessions, keep a reasonable limit (24 message-pairs max)
      const updated: ConversationMessage[] = [
        ...existing,
        { role: 'user' as const, content: userMessage },
        { role: 'assistant' as const, content: assistantMessage },
      ].slice(-48);

      await redisClient.setEx(key, SESSION_TTL_SECONDS, JSON.stringify(updated));
      logger.debug(`ContextService: saved session history for ${sessionId}, ${updated.length} messages`);
    } catch (err) {
      logger.error('ContextService.saveToSessionHistory error:', err);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 3. USER MEMORY — cross-session key facts per authenticated user
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Get user memory as a formatted block for injection into prompts.
   * Returns empty string if no memory exists yet.
   *
   * When `currentMessage` is provided, facts are relevance-gated: only facts
   * topically related to the current question (plus identity/style keys) are
   * injected. This is the fallback path's version of the same gate applied in
   * memory.graph.ts formatUserMemoryBlock — stored memory must not leak into
   * unrelated chats through the fallback either.
   */
  async getUserMemoryBlock(userId: string, currentMessage?: string): Promise<string> {
    try {
      const memory = await prisma.userMemory.findUnique({
        where: { userId },
        select: { facts: true },
      });

      if (!memory || !memory.facts) return '';

      const facts = memory.facts as Record<string, any>;
      // Filter out internal keys (e.g. __rejectedFacts) and empty values
      const entries = Object.entries(facts).filter(
        ([k, v]) => !k.startsWith('__') && v != null && String(v).trim() !== ''
      );
      if (entries.length === 0) return '';

      let usable: Array<[string, any]> = entries;
      if (currentMessage) {
        const flat: Record<string, string> = Object.fromEntries(
          entries.map(([k, v]) => [k, typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v)])
        );
        const { relevant, withheldCount } = filterFactsByRelevance(flat, currentMessage);
        if (withheldCount > 0) {
          logger.debug(`ContextService: memory relevance gate withheld ${withheldCount} off-topic fact(s)`);
        }
        usable = Object.entries(relevant);
        if (usable.length === 0) return '';
      }

      const block = usable.map(([k, v]) => `- ${k}: ${typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v)}`).join('\n');
      return `[User Memory — background reference only]\n${block}\n[MEMORY USAGE RULES: These facts are from previous conversations and are background reference ONLY. Do NOT mention or weave them into the answer unless the user's current question directly relates to them — never force personalization into unrelated topics. If the user says a fact is wrong, outdated, or asks you to stop mentioning something — IMMEDIATELY stop referencing that fact. Never argue about stored facts — the user's current statement ALWAYS overrides stored memory.]`;
    } catch (err) {
      logger.error('ContextService.getUserMemoryBlock error:', err);
      return '';
    }
  }

  /**
   * Asynchronously update user memory by extracting new facts from the
   * latest conversation. Runs fire-and-forget (non-blocking).
   */
  updateUserMemoryAsync(
    userId: string,
    userMessage: string,
    assistantSummary: string
  ): void {
    this.extractAndSaveMemory(userId, userMessage, assistantSummary).catch(err => {
      logger.error('ContextService.updateUserMemoryAsync failed:', err);
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 4. SMART TRIM — read-only context trimming for model queries
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Trim conversation history for model context — READ-ONLY.
   * NEVER modifies the database. Only affects what's sent to the LLM.
   *
   * Strategy:
   * - If messages fit within SMART_TRIM_CHAR_THRESHOLD → return all
   * - If threadSummary exists → return [summary] + last 4 message pairs
   * - Otherwise → return last DEFAULT_MAX_PAIRS message pairs
   *
   * For models with massive context (GLM-5.2 = 202k), this could be relaxed
   * in the future. Currently we trim to keep API costs and latency reasonable.
   */
  trimForModelContext(
    messages: ConversationMessage[],
    threadSummary?: string,
    maxPairs: number = DEFAULT_MAX_PAIRS
  ): ConversationMessage[] {
    if (messages.length === 0) return [];

    // A deeper-than-default window (machine wakes) trades latency for
    // continuity — bounded by the char budget instead of the smart-trim
    // threshold so the deepening is real on char-heavy chats (audit p10).
    const deep = maxPairs > DEFAULT_MAX_PAIRS;

    const totalChars = messages.reduce((s, m) => s + m.content.length, 0);

    // If within budget, return everything
    if (totalChars <= SMART_TRIM_CHAR_THRESHOLD) {
      return messages;
    }

    // If we have a thread summary, use it + recent tail
    if (threadSummary && threadSummary.length > 20) {
      // Deep windows keep the full maxPairs tail (char-bounded below);
      // the default keeps the legacy 4 pairs.
      const tailCount = Math.min(deep ? maxPairs * 2 : 8, messages.length);
      const tail = deep
        ? capHistoryToCharBudget(messages.slice(-tailCount), MACHINE_WAKE_HISTORY_CHAR_BUDGET, 8)
        : messages.slice(-tailCount);
      return [
        { role: 'assistant' as const, content: `[Conversation Thread Summary — ${Math.floor(messages.length / 2)} exchanges so far — model-maintained, may contain inaccuracies; verify operational specifics fresh before relying]:\n${threadSummary}` },
        ...tail,
      ];
    }

    // No summary available — just use the last N messages
    const maxMessages = maxPairs * 2;
    const tail = messages.length <= maxMessages ? messages : messages.slice(-maxMessages);
    return deep ? capHistoryToCharBudget(tail, MACHINE_WAKE_HISTORY_CHAR_BUDGET, 8) : tail;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 5. MEMORY EXTRACTION — asynchronous, non-blocking
  // ─────────────────────────────────────────────────────────────────────────

  private async extractAndSaveMemory(
    userId: string,
    userMessage: string,
    assistantSummary: string
  ): Promise<void> {
    // Gated on the utility LLM being available at all. utilityChat() uses
    // DeepSeek primary with a DashScope fallback, so a bare DEEPSEEK_API_KEY
    // check wrongly skipped memory extraction when only DASHSCOPE_API_KEY was
    // configured. Check both via the shared helper.
    if (!isUtilityLLMAvailable()) return;

    const prompt = `From this conversation exchange, extract any personal facts about the user 
that would be useful to remember for future conversations. Examples: their name, location, 
occupation, preferences, ongoing projects, language preference, etc.

User: ${userMessage}
Assistant: ${assistantSummary}

Return ONLY a JSON object with fact keys and string values. If no new facts are present, 
return an empty object {}. Example: {"name": "Paul", "location": "Vancouver, Canada"}`;

    try {
      const content = await utilityChat(
        [{ role: 'user', content: prompt }],
        { maxTokens: 256, temperature: 0.3, timeout: 15000 }
      ) || '{}';

      // Parse JSON from content (strip markdown code blocks if present)
      const jsonStr = content.replace(/```json\n?|\n?```/g, '').trim();
      const newFacts: Record<string, string> = JSON.parse(jsonStr);

      if (Object.keys(newFacts).length === 0) return;

      // Upsert: merge new facts with existing
      const existing = await prisma.userMemory.findUnique({ where: { userId } });
      const existingFacts = (existing?.facts as Record<string, string>) || {};
      const mergedFacts = { ...existingFacts, ...newFacts };

      await prisma.userMemory.upsert({
        where: { userId },
        create: { userId, facts: mergedFacts },
        update: { facts: mergedFacts, updatedAt: new Date() },
      });
      void recordFactVersions({ userId, before: existingFacts, after: mergedFacts, source: 'turn', removal: 'purge' }).catch(() => null);
      void syncUserFactRows(userId); // reconcile semantic retrieval index (fire-and-forget)

      logger.info(`ContextService: updated user memory for ${userId} with ${Object.keys(newFacts).length} new facts`);
    } catch (err: any) {
      // Silently fail — memory extraction is best-effort
      logger.debug('ContextService.extractAndSaveMemory error (non-fatal):', err.message);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 6. MEMORY MANAGEMENT — explicit read/write/delete for API endpoints
  // ─────────────────────────────────────────────────────────────────────────

  /** Return raw facts record for a user (for the memory management API) */
  async getUserMemory(userId: string): Promise<Record<string, string>> {
    try {
      const memory = await prisma.userMemory.findUnique({
        where: { userId },
        select: { facts: true },
      });
      return (memory?.facts as Record<string, string>) || {};
    } catch (err) {
      logger.error('ContextService.getUserMemory error:', err);
      return {};
    }
  }

  /**
   * Upsert a single fact (`source`: Memory tab PUT = 'api', remember_fact = 'tool').
   *
   * `liftRejections` (ticket ccd634fb): an EXPLICIT user remember — the remember_fact tool on a live
   * user turn, or the Memory tab — lifts every persistent ban (`__rejections`) the stored fact would
   * collide with. A user who said "forget my favourite spice" and later "remember my favourite spice
   * is saffron" got "you asked me to stop bringing up that topic": the old ban rode every prompt as
   * [BANNED TOPICS] beside the fact they had just asked for. Model-proposed writes (profile
   * interview, consolidation) never pass it. Returns the lifted bans.
   * Kill switch MEMORY_REMEMBER_LIFTS_REJECTION_DISABLED=1.
   *
   * `chatId` (2026-10-20): the chat the write came from (remember_fact passes its chat) —
   * recorded as the fact version's source chat (memory/fact-versions.ts).
   */
  async updateMemoryFact(
    userId: string,
    key: string,
    value: string,
    source: MemoryMutationSource = 'api',
    opts: { liftRejections?: boolean; chatId?: string | null } = {},
  ): Promise<{ liftedRejections: string[] }> {
    try {
      const existing = await prisma.userMemory.findUnique({ where: { userId } });
      const existingFacts = (existing?.facts as Record<string, string>) || {};
      const merged: Record<string, any> = { ...existingFacts, [key]: value };
      let liftedRejections: string[] = [];
      if (opts.liftRejections && (existingFacts as any).__rejections != null) {
        const { liftRejectionsForFact, rememberLiftsRejectionDisabled } = await import('./langgraph/memory.graph');
        if (!rememberLiftsRejectionDisabled()) {
          const split = liftRejectionsForFact((existingFacts as any).__rejections, key, value);
          liftedRejections = split.lifted;
          if (liftedRejections.length) {
            if (split.kept.length) merged.__rejections = split.kept;
            else delete merged.__rejections;
            logger.info(`ContextService: explicit remember of "${key}" lifted banned topic(s) for ${userId}: ${liftedRejections.join(', ')}`);
          }
        }
      }
      await prisma.userMemory.upsert({
        where: { userId },
        create: { userId, facts: merged },
        update: { facts: merged, updatedAt: new Date() },
      });
      // A changed value keeps the old one as a closed 'replaced' version (never overwritten).
      void recordFactVersions({ userId, before: existingFacts, after: merged, source, chatId: opts.chatId ?? null, removal: 'purge' }).catch(() => null);
      void syncUserFactRows(userId); // reconcile semantic retrieval index (fire-and-forget)
      recordMemoryMutation({ userId, source, added: [key], ...(liftedRejections.length ? { liftedRejections } : {}), before: countVisibleFacts(existingFacts), after: countVisibleFacts(merged) });
      return { liftedRejections };
    } catch (err) {
      logger.error('ContextService.updateMemoryFact error:', err);
      throw err;
    }
  }

  /** Delete a single fact key (`source`: Memory tab DELETE = 'api', forget_fact = 'tool') */
  async deleteMemoryFact(userId: string, key: string, source: MemoryMutationSource = 'api'): Promise<void> {
    try {
      const existing = await prisma.userMemory.findUnique({ where: { userId } });
      if (!existing) return;
      const before = { ...(existing.facts as Record<string, string>) };
      const facts = { ...before };
      delete facts[key];
      await prisma.userMemory.update({
        where: { userId },
        data: { facts, updatedAt: new Date() },
      });
      // An explicit forget really forgets: every version of the key is deleted.
      void recordFactVersions({ userId, before, after: facts, source, removal: 'purge' }).catch(() => null);
      void syncUserFactRows(userId); // reconcile semantic retrieval index (fire-and-forget)
      recordMemoryMutation({ userId, source, removed: key in before ? [key] : [], before: countVisibleFacts(before), after: countVisibleFacts(facts) });
    } catch (err) {
      logger.error('ContextService.deleteMemoryFact error:', err);
      throw err;
    }
  }

  /** Wipe all facts for a user */
  async clearUserMemory(userId: string, source: MemoryMutationSource = 'api'): Promise<void> {
    try {
      const existing = await prisma.userMemory.findUnique({ where: { userId }, select: { facts: true } }).catch(() => null);
      const before = (existing?.facts as Record<string, string>) || {};
      recordMemoryMutation({ userId, source, removed: Object.keys(before).filter((k) => !k.startsWith('__')), before: countVisibleFacts(before), after: 0 });
      await prisma.userMemory.upsert({
        where: { userId },
        create: { userId, facts: {} },
        update: { facts: {}, updatedAt: new Date() },
      });
      // Wipe the semantic retrieval index too — cleared facts must not remain retrievable.
      await deleteAllFactRows(userId);
      // ...and their value history (memory/fact-versions.ts; never throws).
      await purgeAllFactVersions(userId);
      // The home-screen starter chips were built from these facts — drop the cached
      // set HARD (not stale-while-revalidate: a chip about a wiped fact must not be
      // served for another minute). Dynamic import mirrors the memory-graph pattern.
      try {
        const { invalidateQuestionsCache } = await import('./suggested-questions.service');
        await invalidateQuestionsCache(userId, { hard: true });
      } catch (e) {
        logger.warn('ContextService.clearUserMemory: failed to drop the cached starter questions', e);
      }
      // Also wipe the structured global context state in the LangGraph Store
      // (summary/currentFocus/recentTopics). Without this, project-specific focus/topics
      // survive a "clear memory" and keep leaking across projects. Dynamic import avoids a
      // circular dependency between context.service and the memory graph.
      try {
        const { clearUserContextState } = await import('./langgraph/memory.graph');
        await clearUserContextState(userId);
      } catch (e) {
        logger.warn('ContextService.clearUserMemory: failed to clear structured context state', e);
      }
    } catch (err) {
      logger.error('ContextService.clearUserMemory error:', err);
      throw err;
    }
  }

  // Helpers
  // ─────────────────────────────────────────────────────────────────────────

  emptyContext(): ContextBundle {
    return { conversationHistory: [], fullHistory: [], userMemoryBlock: '' };
  }

  /**
   * Build the augmented user message: prepend user memory block if present,
   * so all models receive consistent context.
   */
  buildAugmentedMessage(message: string, userMemoryBlock: string): string {
    if (!userMemoryBlock) return message;
    return `${userMemoryBlock}\n\n${message}`;
  }

  /**
   * Migrate an anonymous Redis session to a named PostgreSQL chat.
   * Called after login/register when the user has an active session cookie.
   * Creates a chat + inserts messages into the normalized messages table.
   *
   * Returns the new chat ID, or null if there was nothing to migrate.
   */
  async migrateSessionToChat(sessionId: string, userId: string): Promise<string | null> {
    try {
      const key = SESSION_KEY_PREFIX + sessionId;
      const raw = await redisClient.get(key);
      if (!raw) return null;

      const history: ConversationMessage[] = JSON.parse(raw);
      if (!history || history.length === 0) return null;

      // Use the first user message as the chat title
      const firstUser = history.find(m => m.role === 'user');
      const rawTitle = firstUser?.content || 'Anonymous session';
      const title = rawTitle.slice(0, 55) + (rawTitle.length > 55 ? '…' : '');

      // Create the chat (empty JSONB array — deprecated field).
      // User Space auto-filing (P3 §3): the claimed guest chat files into the
      // new user's hidden user-space project. Best-effort — ensureUserSpace
      // never throws; a null result leaves the chat unfiled (the migration
      // itself must not fail over a user-space hiccup).
      const { ensureUserSpace } = await import('./platform/user-space.service');
      const userSpace = await ensureUserSpace(userId);
      const chat = await prisma.crossModelChat.create({
        data: {
          title,
          mode: 'auto', // 2026-09-26: the stored default everywhere (routed per send)
          userId,
          ...(userSpace ? { projectId: userSpace.id } : {}),
          messages: [], // deprecated JSONB column — kept empty for new chats
        },
        select: { id: true },
      });

      // Insert messages into the normalized table
      const baseTime = new Date();
      await prisma.crossModelMessage.createMany({
        data: history.map((m, i) => ({
          chatId: chat.id,
          role: m.role,
          content: m.content,
          // Author attribution (f89d1213): the migrating user wrote every user
          // turn of their own anonymous session — stamp them so the chat stays
          // attributable if it is later filed into a shared project.
          ...(m.role === 'user' ? { metadata: { authorId: userId } } : {}),
          createdAt: new Date(baseTime.getTime() + i), // +1ms per message for ordering
        })),
      });

      // Delete the Redis session now that it's been migrated
      await redisClient.del(key);

      logger.info(`ContextService.migrateSessionToChat: migrated ${history.length} msgs → chat ${chat.id}`);
      return chat.id;
    } catch (err) {
      logger.error('ContextService.migrateSessionToChat error:', err);
      return null;
    }
  }
}

export default new ContextService();
