/**
 * LangGraph Memory System — Type Definitions
 *
 * These types define the structured state maintained for:
 *  - User context (preferences, focus, style — richer than flat key-value facts)
 *  - Project context (decisions, entities, open items — shared across all project chats)
 *  - Conversation thread (per-chat summary — fixes long-conversation context degradation)
 *
 * The LangGraph memory system replaces the simple sibling-chat text dump with
 * a compact, structured state that gets updated after every synthesis.
 */

/** Structured user context state (richer than flat key-value user_memory.facts) */
export interface UserContextState {
  /** One-line summary of who this user is */
  summary: string;
  /** Communication preferences (e.g. "direct and brief", "detailed with examples") */
  preferences: string;
  /** What they're currently focused on (their active project/goal) */
  currentFocus: string;
  /** Recent topics discussed (max 5, newest first) */
  recentTopics: string[];
  /** Communication style inferred from interactions */
  communicationStyle: string;
}

/** Structured project context state (shared across all chats within a project) */
export interface ProjectContextState {
  /** One-paragraph summary of what this project is about */
  summary: string;
  /** Key decisions made (max 10, newest first) */
  recentDecisions: string[];
  /** Key entities referenced in this project */
  entities: {
    /** People involved (names, roles) */
    people: string[];
    /** Amounts, budgets, numbers */
    amounts: string[];
    /** Places, locations, addresses */
    places: string[];
    /** Key topics/themes of the project */
    topics: string[];
  };
  /** Open items, unresolved questions, pending tasks */
  openItems: string[];
  /** ISO timestamp of last update */
  lastUpdated: string;
}

/**
 * Per-chat conversation thread state.
 *
 * Stored in PostgresStore ([chatId, 'thread'] namespace).
 * Updated fire-and-forget after every synthesis via LangGraph.
 * Loaded before each query — when messageCount > 8, the raw sliding window
 * is reduced to 4 messages and this summary provides the historical context.
 *
 * This is the fix for the long-conversation context degradation problem:
 * instead of losing context after 12 raw messages, Kimi maintains a rolling
 * structured summary of the full conversation arc.
 */
export interface ConversationThreadState {
  /** 2-3 sentence narrative of what this whole conversation has been about */
  threadSummary: string;
  /** Key facts established during this conversation (tech stack, names, decisions, etc.) */
  confirmedFacts: Record<string, string>;
  /** Topics raised but not fully resolved yet */
  openTopics: string[];
  /** What the user is currently trying to accomplish */
  lastUserGoal: string;
  /** Total messages processed (user+assistant pairs × 2) — used to trigger summary mode */
  messageCount: number;
  /** ISO timestamp of last update */
  lastUpdated: string;
}

/** The enriched context bundle returned by the load phase */
export interface EnrichedContext {
  /** Conversation history (from existing chat messages, may be trimmed for long chats) */
  conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }>;
  // wasCompressed removed in v2 Phase 1 — compression no longer happens
  /** Formatted user memory block for system context (includes thread state for long chats) */
  userMemoryBlock: string;
  /** Formatted project state block for system context (empty if not in project) */
  projectStateBlock: string;
}

/**
 * Per-feed context state — long-term memory for feed research.
 *
 * Stored in PostgresStore ([feedId, 'feed'] namespace).
 * Updated after every content fetch cycle.
 * Used to improve search queries over time — the feed "learns" about its topic
 * by accumulating key entities, trends, and insights from previous scrapes.
 */
export interface FeedContextState {
  /** One-paragraph summary of what this feed covers and key findings so far */
  topicSummary: string;
  /** Key entities discovered across all fetches (people, orgs, products, etc.) */
  keyEntities: string[];
  /** Recurring themes/trends observed across multiple fetches */
  trends: string[];
  /** Specific subtopics that have yielded good results — used to refine future queries */
  effectiveSubtopics: string[];
  /** Headlines already covered (last 30) — prevents repetition */
  recentHeadlines: string[];
  /** Insights/learnings that should inform future searches */
  learnings: string[];
  /** Total number of fetch cycles completed */
  fetchCount: number;
  /** ISO timestamp of last update */
  lastUpdated: string;
}

/** Input to the get-context graph */
export interface GetContextInput {
  userId: string | null;
  chatId: string | null;
  projectId: string | null;
  userMessage: string;
  /**
   * Machine-wake runs (schedule/hook firings) read a DEEPER history window —
   * up to 24 messages, char-bounded (context.service MACHINE_WAKE_MAX_PAIRS /
   * MACHINE_WAKE_HISTORY_CHAR_BUDGET). Threaded from chat-agent.service via
   * buildChatQueryContext; default (undefined) keeps the interactive trims.
   */
  deepHistory?: boolean;
  /**
   * Orphan-recovery re-fire (ticket 68bc5aec): exclude ONE already-persisted
   * message row from the conversation-history load (the recovered turn's own
   * user row — the dead run wrote it, and the recovery run must not see the
   * current question twice). Threaded to contextService.loadChatContext.
   */
  excludeMessageId?: string;
  /**
   * A plain chat in the hidden user space (platform/user-space.service
   * userSpaceChatIsolated, 2026-10-20): the shared project state is not
   * loaded — every ungrouped chat sits in that one project, so its state mixes
   * unrelated conversations. projectId stays set (the currentFocus guard keys on it).
   */
  skipProjectState?: boolean;
}

/** Input to the update-context graph */
export interface UpdateContextInput {
  userId: string | null;
  projectId: string | null;
  /** chatId — required for thread state updates */
  chatId: string | null;
  userMessage: string;
  synthesis: string;
  /**
   * Machine run (2026-09-14): `userMessage` is a wake/schedule/hook prompt —
   * NOT a human statement — and `synthesis` is a coding run's ACCEPTED final
   * (post evidence guard). The pipeline then SKIPS user-fact extraction,
   * thread-state extraction and the user-scope conversation distill (a machine
   * prompt must never enter user memory) but STILL runs project-state
   * extraction — an accepted final is a rich source of project decisions — and
   * files the newly extracted decisions into the unified store (source
   * 'decision', project scope).
   * Default (undefined/false) = the interactive chat behavior, unchanged.
   */
  machineRun?: boolean;
  /**
   * Supervisor chat (2026-09-15 memory-wipe incident): the exchange is a REAL
   * user turn, but in a Fleet/project-supervisor chat — operational text about
   * lanes, tickets and schedules, never a personal statement. The pipeline
   * skips PERSONAL fact extraction (user_memory facts + rejections) for it and
   * keeps the episodic distill, thread state and project extraction. The
   * owner's every chat with the Fleet Supervisor had been feeding the personal
   * extractor, which wrote fleet chatter ("steer received 17:58Z", "ticket
   * b216475a") into __rejections and scrubbed every real fact.
   */
  supervisorChat?: boolean;
  /**
   * A plain chat in the hidden user space (userSpaceChatIsolated, 2026-10-20):
   * no project-state extraction and no 'decision' rows — the user never made a
   * project, so one chat's brief must not become every ungrouped chat's context.
   * projectId stays set (the extractor's currentFocus guard keys on it).
   */
  skipProjectState?: boolean;
  /**
   * A human-typed turn in a chat that was BORN a coding session (review
   * 2026-10-23): nothing on the coding path reads the thread summary
   * ([chatId,'thread'] feeds only the chat agent's getEnrichedContext), so the
   * thread LLM extraction is skipped — the counter still advances (a
   * counter-only row when none exists), so the user / project cadence the
   * THREAD_STATE_DEBOUNCE_FIX restored keeps running. Ignored while
   * THREAD_STATE_DEBOUNCE_FIX_DISABLED=1 (the previous behaviour, byte for byte).
   */
  skipThreadState?: boolean;
  /**
   * audit 2026-10-08 W4-2: what backed the assistant's answer THIS turn (memory/answer-grounding.ts
   * answerGroundingFromParts). `toolBacked:false` ⇒ the extractors treat the answer as UNVERIFIED — they record only
   * what the USER stated, and nothing from the exchange is stored as "confirmed". Absent (machine finals from the
   * coding executor, rebuilds) ⇒ the previous behaviour.
   */
  answerGrounding?: import('../memory/answer-grounding').AnswerGrounding | null;
}
