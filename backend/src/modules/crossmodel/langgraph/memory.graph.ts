/**
 * Memory Pipeline
 *
 * Two sequential pipelines that enrich context before queries and update
 * state after synthesis. (Formerly LangGraph StateGraphs — replaced 2026-07-10
 * with plain async steps threading a typed state object; identical semantics,
 * no framework.) This replaces the basic sliding-window + key-value
 * memory system with:
 *
 *  1. User context state: structured preferences, focus, communication style
 *  2. Project state: decisions, entities, open items (shared across project chats)
 *  3. Conversation thread state: rolling summary of the full chat arc
 *     — fixes long-conversation context degradation by compressing history
 *       into a structured narrative instead of relying solely on raw message window
 *
 * Flow:
 *   PRE-REQUEST:  getEnrichedContext()  → enriched context for model queries
 *   POST-REQUEST: updateContextAsync()  → fire-and-forget state update after synthesis
 *
 * Persistence (all via the Prisma-backed context store — memory/context-store.ts):
 *   - [userId, 'memory'] / 'contextState'    → UserContextState
 *   - [projectId, 'context'] / 'state'       → ProjectContextState
 *   - [chatId, 'thread'] / 'state'           → ConversationThreadState
 */

import prisma from '../../../config/database';
import { storeAdvanceNumberField, storeDelete, storeGet, storePut } from '../memory/context-store';
import { getMergedProjectStoreState } from '../platform/folder-inheritance';
import logger from '../../../utils/logger';
import { trackBackground } from '../../../utils/background-tasks';
import contextService, { capHistoryToCharBudget, MACHINE_WAKE_HISTORY_CHAR_BUDGET, MACHINE_WAKE_MAX_PAIRS } from '../context.service';
import {
  UserContextState,
  ProjectContextState,
  ConversationThreadState,
  EnrichedContext,
  GetContextInput,
  UpdateContextInput,
} from './types';

// Background memory/thread/project extraction uses the utility LLM
// (DeepSeek V4 Flash via utilityChat, DashScope Qwen Flash fallback).
import { utilityChat } from '../../../utils/utility-llm';
import { redactInboundHead, redactInboundSecrets } from '../platform/secret-scan';
import { MACHINE_TEXT_RE } from '../chat-agent/machine-wake';
import { recordMemoryMutation, recordExtractionOutcome, parseModelJson, salvageTruncatedJson, countVisibleFacts as countVisibleFactsInBlob, MemoryMutationSource, type MemoryExtractionOutcome } from '../memory/memory-audit';
import { profileFieldCapsEnabled, clampUserContextState, boundedProfileFieldsInstruction, claimProfileExtraction, settleProfileExtraction, PROFILE_FIELD_CAPS } from '../memory/profile-guard';
import { memoryStateOpsEnabled, renderStateForOps, opsInstruction, parseStateOps, applyStateOps, describeOps, type OpsSpec } from '../memory/state-ops';
import { memStore, memReplaceRef, enforceScopeCap } from '../memory/unified-memory.service';
import {
  isUngroundedAnswer, dropUngroundedItem, neutralizeConfirmations, hasConfirmationClaim, UNGROUNDED_ASSISTANT_LABEL, UNGROUNDED_EXTRACTION_RULE,
  MEMORY_PROVENANCE_METRIC, type AnswerGrounding,
} from '../memory/answer-grounding';
import { recordLoopMetric } from '../platform/loop-metrics.service';
import type { MemItem } from '../memory/unified-memory.service';

// Deterministic relevance gate — decides which stored facts are actually
// injected into a given query's context (see memory-relevance.ts).
import { filterFactsByRelevance, isTextRelevantToMessage } from '../memory-relevance';

// Semantic memory layer (2026-07-10): embedding-based fact retrieval (top-K
// cosine + recency over user_memory_facts rows, keyword-gate fallback) and
// episodic search over past conversations.
import { selectRelevantFacts, syncUserFactRows, FactSelection } from '../memory/user-facts.service';
import { buildEpisodicBlock } from '../memory/episodic.service';
// Fact versions (2026-10-20): value history + "(since …)" dates for the flat-facts extractor.
import { recordFactVersions, getFactMeta, factVersionsEnabled, factSinceSuffix, FACT_RECENCY_RULE, type FactMetaMap } from '../memory/fact-versions';

// Thread-summary provenance guard (ticket 65aa3682): the extraction LLM below
// rewrites threadSummary from text alone (no receipts) — the guard strips
// provably fabricated specifics before persist; the rules harden the prompt.
import { guardThreadSummaryGrounding, THREAD_SUMMARY_GROUNDING_RULES } from './thread-grounding';

// Decision gate (2026-09-24, purpose 'memory_extract'): typed "is there
// anything durable to extract?" judgments ahead of the background extraction
// LLM calls — shadow records agreement, act drops confidently-empty extractors.
import { decide, decisionMode, decisionThreshold, recordDecisionOutcome } from '../platform/decision-gate';
import type { DecideResult, DecisionMode, DecisionQuestion } from '../platform/decision-gate';

// ── LLM helper (utility model — background extraction only) ──

/*
 * Flat-fact extraction needs the utility model's REASONING (2026-09-22): with
 * the 2026-09-04 thinking-off pin, DeepSeek V4.1 Flash answered `{"add": {}}`
 * for the owner's "my family go to Lanai Four Seasons every year…" exchange
 * 12 times out of 12 (temperature 0.3 and 0); with thinking on it added
 * spouse / family tradition / travel preference 4 times out of 4 (~8 s a call).
 * That pin — not deletion — is why memory stopped growing for users whose
 * statements are not spelled out.
 */

/** Head + tail of a model answer for a parse_error row — the TAIL is what shows a truncated JSON. */
function extractionDetail(raw: unknown): string {
  const t = String(raw ?? '').replace(/\s+/g, ' ').trim();
  return t.length <= 240 ? t : `${t.slice(0, 120)} … ${t.slice(-110)}`;
}

async function callExtractionLLM(prompt: string, maxTokens = 512, opts?: { thinking?: boolean; timeoutMs?: number; onMeta?: (m: { leg: string; finishReason?: string }) => void }): Promise<string> {
  // retryNotFound: this runs fire-and-forget AFTER synthesis (off the user's
  // critical path), so it can afford the short DeepSeek retry-on-404 that rides
  // out the daily ~6am UTC provider maintenance window. Without it, background
  // extraction 404-floods the logs every morning and silently drops memory updates.
  const thinking = opts?.thinking === true;
  return utilityChat(
    [{ role: 'user', content: prompt }],
    // contentOnly (2026-09-24): every caller parses JSON — a thinking call that
    // exhausts its budget must return '' (→ the non-reasoning fallback answers),
    // never its reasoning_content as the "answer".
    { maxTokens, temperature: 0.3, timeout: opts?.timeoutMs ?? (thinking ? 90000 : 30000), retryNotFound: true, contentOnly: true, ...(thinking ? { thinking: true } : {}), ...(opts?.onMeta ? { onMeta: opts.onMeta } : {}) }
  );
}

/**
 * Programmatically scrub a text string against a set of rejected keywords.
 * For each sentence/clause that contains a rejected keyword, the entire
 * sentence is removed rather than leaving a nonsensical fragment.
 */
/**
 * Normalize curly/smart apostrophes + quotes to straight ASCII so rejection
 * matching is consistent. A stored fact extracted earlier can contain a curly
 * apostrophe (I’m, don’t) while the rejection phrase uses a straight one
 * (or vice-versa); without this, `includes()` silently misses and the rejected
 * fact survives. Applied to BOTH the keywords and the text being scrubbed.
 */
function normalizeQuotes(s: string): string {
  return s
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"');
}

function scrubTextAgainstRejections(text: string, rejectionKeywords: Set<string>): string {
  if (!text || rejectionKeywords.size === 0) return text;
  text = normalizeQuotes(text);
  // Split on sentence/clause boundaries using a forward-matching approach
  // that works in ALL environments (no lookbehind needed).
  // Fix: lookbehind regex (?<=...) fails on older Safari (< 16.4, iOS 15) and
  // the fallback was too aggressive (split on commas lost data). Now uses a
  // universal approach: split on sentence-ending punctuation followed by whitespace.
  // This preserves the delimiter in the preceding part (unlike the old fallback).
  const parts = text.split(/(?:\.\s+|;\s+|\|\s+|\n+)/).map(p => p.trim()).filter(Boolean);
  const filtered = parts.filter(part => {
    const lower = part.toLowerCase();
    for (const keyword of rejectionKeywords) {
      if (lower.includes(keyword)) return false;
    }
    return true;
  });
  return filtered.join(' ').replace(/\s{2,}/g, ' ').trim();
}

/** Build a set of rejection keywords from rejection phrases (full phrases + individual words ≥3 chars). */
/**
 * user_memory.facts.__rejections is model-written JSON — it has arrived as an
 * object and as a bare string (prod 2026-09-14: "rejections.map is not a
 * function" on every getEnrichedContext, which dropped the WHOLE user-memory
 * block into the basic-context fallback). Normalize to string[] at every read.
 */
export function normalizeRejections(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((r): r is string => typeof r === 'string' && r.trim().length > 0);
  if (typeof raw === 'string') return raw.trim() ? [raw.trim()] : [];
  if (raw && typeof raw === 'object') return Object.values(raw as Record<string, unknown>).filter((r): r is string => typeof r === 'string' && r.trim().length > 0);
  return [];
}

/**
 * Words that appear in almost any fact and must never become scrub keywords
 * on their own (2026-09-15 memory-wipe incident: rejections carrying "time",
 * "status", "project", "chat", "side", "based" deleted every real fact on
 * every save). The FULL rejection phrase always scrubs; single words only
 * when they are specific (≥4 chars, not generic).
 */
const GENERIC_REJECTION_TOKENS = new Set([
  'time', 'times', 'status', 'project', 'projects', 'chat', 'chats', 'work', 'works', 'plan', 'plans', 'data',
  'model', 'models', 'code', 'repo', 'repos', 'ticket', 'tickets', 'queue', 'error', 'errors', 'side', 'based',
  'note', 'notes', 'message', 'messages', 'session', 'sessions', 'task', 'tasks', 'user', 'users', 'file', 'files',
  'fresh', 'filed', 'received', 'attempt', 'attempts', 'attachment', 'creation', 'platform', 'gate', 'gates',
  'requirement', 'requirements', 'interpretation', 'analysis', 'thing', 'things', 'stuff', 'topic', 'topics',
  'about', 'with', 'from', 'that', 'this', 'have', 'been', 'into', 'your', 'their', 'when', 'what', 'which',
  'also', 'just', 'like', 'more', 'some', 'than', 'them', 'then', 'they', 'were', 'will', 'only', 'over', 'very',
  'much', 'make', 'made', 'does', 'doing', 'done', 'said', 'says', 'want', 'wants', 'need', 'needs', 'keep',
]);

/**
 * Ticket ccd634fb (nightly suite 2026-10-06): "favourite" is a QUALIFIER, not a topic — a ban on
 * "favourite bird" scrubbed a freshly remembered favourite_spice 23 s after remember_fact stored it
 * (prod user_memory_mutation 2026-10-04 15:39). The full phrase still scrubs; "bird" still scrubs.
 * Read at call time so MEMORY_REMEMBER_LIFTS_REJECTION_DISABLED=1 restores the old keyword set.
 */
const QUALIFIER_REJECTION_TOKENS = new Set(['favourite', 'favourites', 'favorite', 'favorites']);

/**
 * Ticket ccd634fb (nightly query suite 2026-10-06, case "remember-recall-forget"): a user who once
 * said "forget my favourite spice" and later says "remember my favourite spice is saffron" got
 * "you've asked me to stop bringing up that topic" — the ban outlived the user's NEWER explicit
 * decision: remember_fact stored the fact, the [BANNED TOPICS] block still listed "favourite spice",
 * and the model obeyed the ban. An explicit remember (the remember_fact tool, the Memory tab, or a
 * user message with a remember cue that the extractor turns into an add) now LIFTS every ban that
 * would scrub the fact being stored — the user's latest word wins. Kill switch
 * MEMORY_REMEMBER_LIFTS_REJECTION_DISABLED=1 restores bans-outlive-remember and the broad
 * "favourite" scrub word.
 */
export function rememberLiftsRejectionDisabled(): boolean {
  return process.env.MEMORY_REMEMBER_LIFTS_REJECTION_DISABLED === '1';
}

export function buildRejectionKeywords(rejections: string[]): Set<string> {
  const keywords = new Set<string>();
  const skipQualifiers = !rememberLiftsRejectionDisabled();
  for (const rejection of normalizeRejections(rejections)) {
    const rejLower = normalizeQuotes(rejection.toLowerCase()).trim();
    if (!rejLower) continue;
    keywords.add(rejLower); // the phrase itself always scrubs ("ACL", "joint health", "diet: vegan")
    for (const word of rejLower.split(/[\s,\-\/:;]+/)) {
      if (word.length >= 4 && !GENERIC_REJECTION_TOKENS.has(word) && !(skipQualifiers && QUALIFIER_REJECTION_TOKENS.has(word))) keywords.add(word);
    }
  }
  return keywords;
}

/** True when this one rejection would scrub the fact `key: value` (the save-time scrub's own match,
 *  plus the key with underscores read as spaces so "favourite spice" names `favourite_spice`). Pure. */
export function factMatchesRejection(rejection: string, key: string, value: unknown): boolean {
  const kw = buildRejectionKeywords([rejection]);
  if (!kw.size) return false;
  const k = normalizeQuotes(String(key ?? '').toLowerCase());
  const v = normalizeQuotes(String(value ?? '').toLowerCase());
  const combined = `${k} ${v} ${k.replace(/_+/g, ' ')}`;
  for (const w of kw) if (combined.includes(w)) return true;
  return false;
}

/** Split stored rejections into the ones an explicit remember of `key: value` lifts and the rest. Pure. */
export function liftRejectionsForFact(rejections: unknown, key: string, value: unknown): { kept: string[]; lifted: string[] } {
  const list = normalizeRejections(rejections);
  const kept: string[] = [];
  const lifted: string[] = [];
  for (const r of list) (factMatchesRejection(r, key, value) ? lifted : kept).push(r);
  return { kept, lifted };
}

/** A user message that asks Digby to keep something ("remember …", "note that …", "keep in mind …"). */
export const REMEMBER_CUE_RE = /\b(?:remember|memori[sz]e|note (?:that|down)|make a note|keep in mind|save (?:that|this)|store (?:that|this))\b/i;

/**
 * The extractor's twin of the explicit-remember lift: a ban is lifted when the user's OWN message
 * asks to remember (REMEMBER_CUE_RE, and no forget cue — a mixed message never lifts), the ban's
 * specific words are in that message, and the extractor is adding a fact the ban would scrub.
 * Pure; exported for tests.
 */
export function groundRejectionLifts(rejections: unknown, factsToAdd: Record<string, unknown>, userMessage: string): string[] {
  if (rememberLiftsRejectionDisabled()) return [];
  const list = normalizeRejections(rejections);
  if (!list.length || !factsToAdd || !Object.keys(factsToAdd).length) return [];
  const msg = normalizeQuotes(String(userMessage ?? '').toLowerCase());
  if (!REMEMBER_CUE_RE.test(msg) || FORGET_CUE_RE.test(msg)) return [];
  const out: string[] = [];
  for (const r of list) {
    if (![...buildRejectionKeywords([r])].some((w) => msg.includes(w))) continue;
    if (Object.entries(factsToAdd).some(([k, v]) => factMatchesRejection(r, k, v))) out.push(r);
  }
  return out;
}

/**
 * A rejection ("never remember this again") is the user's decision, so it must
 * be GROUNDED in the user's own message (2026-09-15 memory-wipe incident: the
 * extractor returned rejections parroted from this prompt's own examples —
 * "joint health", "plant-based", "ACL", "vegan" — and fleet chatter lifted
 * from the assistant's text — "steer received 17:58Z", "ticket b216475a" —
 * none of which the owner ever asked to forget). Kept only when (1) the user's
 * message carries a forget/deny/correct cue and (2) at least one specific
 * token of the topic appears in the user's own words; a comma-joined list or a
 * sentence-length "topic" is never a rejection. Capped at 5 per exchange.
 * Pure; exported for tests.
 */
export const FORGET_CUE_RE =
  /\b(forget|don'?t (remember|store|save|keep|track|mention|bring up|say)|stop (remembering|saying|talking about|mentioning|bringing up|tracking|asking)|remove|delete|erase|scrub|never (mention|bring up|remember)|that'?s not me|i'?m not|i am not|i'?m no longer|no longer|not anymore|anymore|i told you|wrong about|that'?s wrong|incorrect|not true)\b/i;
const REJECTION_GROUND_STOPWORDS = new Set(['the', 'and', 'that', 'this', 'with', 'from', 'have', 'about', 'into', 'your', 'their', 'there', 'what', 'when', 'which', 'would', 'could', 'should', 'been', 'being', 'also', 'just', 'like', 'more', 'some', 'than', 'them', 'then', 'they', 'were', 'will', 'only', 'over', 'such', 'very', 'much', 'make', 'made', 'does', 'did', 'not', 'now', 'how', 'all', 'any', 'are', 'but', 'can', 'for', 'its', 'was', 'who', 'why', 'you', 'our', 'out', 'per', 'via', 'one', 'two']);
export function groundRejections(candidates: unknown, userMessage: string): string[] {
  const list = normalizeRejections(candidates).map((s) => s.trim()).filter(Boolean);
  if (!list.length) return [];
  const msg = normalizeQuotes(String(userMessage ?? '').toLowerCase());
  if (!FORGET_CUE_RE.test(msg)) return [];
  const out: string[] = [];
  for (const raw of list) {
    if (raw.length > 60) continue;
    if ((raw.match(/,/g) ?? []).length >= 2) continue;
    const tokens = normalizeQuotes(raw.toLowerCase()).split(/[^a-z0-9]+/).filter((t) => t.length >= 3 && !REJECTION_GROUND_STOPWORDS.has(t));
    if (!tokens.length) continue;
    if (!tokens.some((t) => msg.includes(t))) continue;
    out.push(raw);
    if (out.length >= 5) break;
  }
  return out;
}

/**
 * A `remove` from the flat-fact extractor deletes a stored fact — the user's
 * decision, never the model's (2026-09-21: the owner's memory sat at 3 facts
 * while a live replay of the extractor on his own message produced two adds in
 * one second — facts were being churned back out by later turns' `remove`
 * lists; the 09-15 wipe fix had grounded `reject` but not `remove`). A removal
 * survives only when (a) the same key is also being added — an in-place
 * correction ("I moved to X") — or (b) the user's message carries a
 * forget/deny/correct cue (FORGET_CUE_RE) AND names the fact: a specific token
 * of its key or value appears in the user's own words. Unknown keys are
 * dropped silently (nothing to delete). Pure; exported for tests.
 */
export function groundRemovals(
  candidates: unknown,
  existingFacts: Record<string, unknown>,
  factsToAdd: Record<string, unknown>,
  userMessage: string,
): { kept: string[]; dropped: string[] } {
  const list = Array.isArray(candidates)
    ? candidates.filter((k): k is string => typeof k === 'string').map((k) => k.trim()).filter(Boolean)
    : [];
  if (!list.length) return { kept: [], dropped: [] };
  const existingKeys = Object.keys(existingFacts).filter((k) => !k.startsWith('__'));
  const addKeys = new Set(Object.keys(factsToAdd).map((k) => k.toLowerCase()));
  const msg = normalizeQuotes(String(userMessage ?? '').toLowerCase());
  const hasCue = FORGET_CUE_RE.test(msg);
  const kept: string[] = [];
  const dropped: string[] = [];
  const tokensOf = (text: string) =>
    normalizeQuotes(String(text ?? '').toLowerCase()).split(/[^a-z0-9]+/).filter((t) => t.length >= 3 && !REJECTION_GROUND_STOPWORDS.has(t));
  for (const raw of list) {
    const key = existingKeys.find((k) => k.toLowerCase() === raw.toLowerCase());
    if (!key) continue; // nothing to delete — not a removal at all
    if (addKeys.has(key.toLowerCase())) { kept.push(key); continue; } // in-place correction
    if (hasCue) {
      const tokens = [...tokensOf(key.replace(/_/g, ' ')), ...tokensOf(String(existingFacts[key] ?? ''))];
      if (tokens.some((t) => msg.includes(t))) { kept.push(key); continue; }
    }
    dropped.push(key);
  }
  return { kept, dropped };
}

/** Programmatically scrub a UserContextState against rejection keywords. */
export function scrubUserContextState(state: UserContextState, rejectionKeywords: Set<string>): UserContextState {
  if (rejectionKeywords.size === 0) return state;
  return {
    summary: scrubTextAgainstRejections(state.summary || '', rejectionKeywords),
    preferences: scrubTextAgainstRejections(state.preferences || '', rejectionKeywords),
    currentFocus: scrubTextAgainstRejections(state.currentFocus || '', rejectionKeywords),
    communicationStyle: state.communicationStyle || '',
    recentTopics: (state.recentTopics || []).filter(topic => {
      const lower = topic.toLowerCase();
      for (const keyword of rejectionKeywords) { if (lower.includes(keyword)) return false; }
      return true;
    }),
  };
}

/** Programmatically scrub a ConversationThreadState against rejection keywords. */
function scrubThreadState(state: ConversationThreadState, rejectionKeywords: Set<string>): ConversationThreadState {
  if (rejectionKeywords.size === 0) return state;
  const scrubbedFacts: Record<string, string> = {};
  for (const [k, v] of Object.entries(state.confirmedFacts || {})) {
    const combined = `${k.toLowerCase()} ${v.toLowerCase()}`;
    let matched = false;
    for (const keyword of rejectionKeywords) { if (combined.includes(keyword)) { matched = true; break; } }
    if (!matched) scrubbedFacts[k] = v;
  }
  return {
    ...state,
    threadSummary: scrubTextAgainstRejections(state.threadSummary || '', rejectionKeywords),
    confirmedFacts: scrubbedFacts,
    openTopics: (state.openTopics || []).filter(topic => {
      const lower = topic.toLowerCase();
      for (const keyword of rejectionKeywords) { if (lower.includes(keyword)) return false; }
      return true;
    }),
    lastUserGoal: scrubTextAgainstRejections(state.lastUserGoal || '', rejectionKeywords),
  };
}

/**
 * Extract flat key-value facts from a conversation exchange and merge into
 * the Prisma userMemory table. Supports persistent rejections: when a user
 * denies/corrects a fact, a "reject" list permanently bans those topics.
 * Facts matching rejected keywords are scrubbed programmatically.
 */
/** What the extractor proposes for one exchange — applied separately so a rebuild can propose in parallel and apply in order. */
export interface FlatFactProposal {
  add: Record<string, string>;
  remove: unknown;
  reject: unknown;
  llmMs: number;
  budgetTokens: number;
}

/** One extractor call: prompt → utility model (reasoning on) → parsed proposal. Records the call outcome; never throws. */
// FO firing 88 (2026-10-06): the turn-source flat-facts leg ESCALATEd the
// charter's parse-share bar (12.5 % over n=8, tail cut mid-word at "not denying
// previ…") — a reasoning-model preamble ("STEP 1 — SCAN FOR REJECTIONS: No
// rejections found. …") eats the 384-token output budget before the JSON
// answer window ever starts. Same truncation class as distill 400→900 and
// profile 512→900 (2026-09-22): the {add,remove,reject} JSON plus a reasoning
// preamble needs more than 384 output tokens on dense turns.
export const TURN_FLAT_FACTS_BUDGET_TOKENS = 2000;

async function proposeFlatFacts(
  userId: string,
  existingFacts: Record<string, string>,
  userMessage: string,
  assistantSummary: string,
  source: MemoryMutationSource,
  chatId?: string | null,
  ungrounded = false,
  factMeta?: FactMetaMap | null,
): Promise<FlatFactProposal | null> {
  try {
    // Fact versions (2026-10-20): each stored fact carries "(since YYYY-MM-DD)" so the
    // model can judge recency; FACT_VERSIONS_DISABLED=1 (or no known date) = the old prompt.
    const meta = factVersionsEnabled() ? (factMeta ?? await getFactMeta(userId)) : null;
    let dated = false;
    // Internal bookkeeping (`__rejections`, `__dream`, `__rebuild`) is not a
    // fact — it used to render as "__dream: [object Object]" in the prompt.
    const existingFactsStr = Object.entries(existingFacts)
      .filter(([k]) => !k.startsWith('__'))
      .map(([k, v]) => {
        const since = factSinceSuffix(meta, k);
        if (since) dated = true;
        return `  ${k}: ${v}${since}`;
      })
      .join('\n') || '  (none)';

    const prompt = `You are a memory manager for an AI assistant. Analyze this conversation exchange and update the user's stored facts.

CURRENT STORED FACTS:
${existingFactsStr}
${dated ? `${FACT_RECENCY_RULE}\n` : ''}
LATEST CONVERSATION:
User: ${userMessage.substring(0, 600)}
${ungrounded ? UNGROUNDED_ASSISTANT_LABEL : 'Assistant'}: ${assistantSummary.substring(0, 500)}
${ungrounded ? `\n${UNGROUNDED_EXTRACTION_RULE}\n` : ''}
INSTRUCTIONS — READ CAREFULLY:

STEP 1 — SCAN FOR REJECTIONS: Read the user's message. If the user denies, corrects, or complains about ANY topic being mentioned:
  - "stop talking about my joints/ACL" → remove ALL health/injury/rehab facts, reject those terms
  - "I'm not plant based" → remove ALL diet facts containing "plant based"/"vegan"/"vegetarian"
  - "stop saying X" / "I told you" / "I'm fine now" / "that's not me" → find and remove the matching stored fact
  - "I only eat seafood" → CORRECT: remove old diet fact, add corrected one (e.g. diet: eats seafood, family eats everything)
  - Check EVERY stored fact (key AND value) against what the user is denying — if it relates, put it in "remove"

STEP 2 — ADD new facts only if they don't conflict with any rejected topic. SCOPE: these facts are GLOBAL across ALL the user's projects, so store ONLY durable, project-agnostic PERSONAL facts (name, role/occupation, location, language, long-standing preferences). Do NOT store project-specific facts — NO project names, codenames, clients, initiatives, deadlines, or "working on project X / bid / challenge". Storing those here leaks one project into another.

NAME RULE — STRICT: ONLY add or change the "name" fact when the USER explicitly states THEIR OWN name in first person (e.g. "my name is …", "call me …", "I'm …", "I go by …"). NEVER infer the user's name from an email address, email signature, Calendly/handle, quoted text, a person mentioned in the conversation, or the assistant's own words. If you are not certain the user stated their own name, leave "name" out entirely.

STEP 3 — REJECT: For each denied/corrected topic, add a short keyword to "reject" array (permanently banned — never re-added)

Return THREE JSON fields:
  - "add": facts to add/update (key-value pairs) — include corrected facts here
  - "remove": array of fact KEYS to DELETE from memory — use EXACT key names from CURRENT STORED FACTS
  - "reject": array of short topics to permanently ban — ONLY a topic the USER explicitly denied or asked to forget in THEIR message, in the user's own words. Leave it [] when the user did not deny or correct anything. Never copy the examples in these instructions into it; never take a topic from the assistant's text.

Return ONLY valid JSON:
{"add": {"key": "value"}, "remove": ["key_to_remove"], "reject": ["<topic the user denied, in their words>"]}

If no changes needed, return: {"add": {}, "remove": [], "reject": []}`;

    const llmStartedAt = Date.now();
    let content: string;
    try {
      content = await callExtractionLLM(prompt, TURN_FLAT_FACTS_BUDGET_TOKENS, { thinking: true });
    } catch (err: any) {
      recordExtractionOutcome({ userId, source, chatId, outcome: 'llm_error', ms: Date.now() - llmStartedAt, budgetTokens: TURN_FLAT_FACTS_BUDGET_TOKENS, detail: String(err?.message ?? err) });
      return null;
    }
    if (!content || !content.trim()) {
      recordExtractionOutcome({ userId, source, chatId, outcome: 'empty', ms: Date.now() - llmStartedAt, budgetTokens: TURN_FLAT_FACTS_BUDGET_TOKENS });
      return null;
    }
    // Tolerate prose around the JSON (a reasoning model's preamble, a fenced
    // block with a label): take the outermost {...} when the whole text isn't JSON.
    const stripped = content.replace(/```json\n?|\n?```/g, '').trim();
    const braceStart = stripped.indexOf('{');
    const braceEnd = stripped.lastIndexOf('}');
    const jsonStr = braceStart >= 0 && braceEnd > braceStart ? stripped.slice(braceStart, braceEnd + 1) : stripped;

    let parsed: { add?: Record<string, string>; remove?: string[]; reject?: string[] };
    try {
      parsed = JSON.parse(jsonStr);
      // Backwards-compatible: a flat object (old format) is add-only
      if (parsed && typeof parsed === 'object' && !('add' in parsed) && !('remove' in parsed) && !('reject' in parsed)) {
        parsed = { add: parsed as Record<string, string>, remove: [], reject: [] };
      }
    } catch {
      recordExtractionOutcome({ userId, source, chatId, outcome: 'parse_error', ms: Date.now() - llmStartedAt, budgetTokens: TURN_FLAT_FACTS_BUDGET_TOKENS, detail: content.slice(0, 160).replace(/\s+/g, ' ') });
      return null;
    }
    const llmMs = Date.now() - llmStartedAt;
    const add = (parsed.add && typeof parsed.add === 'object' && !Array.isArray(parsed.add)) ? parsed.add : {};
    return { add, remove: parsed.remove, reject: parsed.reject, llmMs, budgetTokens: TURN_FLAT_FACTS_BUDGET_TOKENS };
  } catch (err: any) {
    logger.debug(`Memory: proposeFlatFacts failed (non-fatal): ${err.message}`);
    return null;
  }
}

/** Apply one proposal to the CURRENT blob (re-read here): ground removals + rejections, name guard, scrub, save, audit.
 *  Returns what it did (E5 honest labels): 'changed' = the blob was written with ≥1 add/remove/rejection,
 *  'noop' = nothing to persist, 'llm_error' = the apply itself failed (unknown). */
export async function applyFlatFactProposal(
  userId: string,
  proposal: FlatFactProposal,
  userMessage: string,
  source: MemoryMutationSource,
  chatId?: string | null,
): Promise<MemoryExtractionOutcome> {
  try {
    const existing = await prisma.userMemory.findUnique({ where: { userId } });
    const existingFacts = (existing?.facts as Record<string, string>) || {};
    const factsToAdd: Record<string, string> = { ...proposal.add };
    const llmMs = proposal.llmMs;
    // 2026-09-21 (owner: "I only see 3 facts"): a `remove` deletes a stored
    // fact, so like a rejection it must be the USER's decision — grounded in
    // the user's own words or an in-place correction of the same key. The
    // extractor had been churning facts back out on later turns (the 09-15
    // fix grounded `reject` only). Ungrounded removals are dropped + audited.
    const removalVerdict = groundRemovals(proposal.remove, existingFacts, factsToAdd, userMessage);
    const factsToRemove = removalVerdict.kept;
    if (removalVerdict.dropped.length > 0) {
      logger.info(`Memory: dropped ${removalVerdict.dropped.length} ungrounded removal(s) for ${userId} (not the user's decision): ${removalVerdict.dropped.join(', ')}`);
    }
    // 2026-09-15 memory-wipe incident: a rejection is the USER's decision —
    // keep only the ones grounded in the user's own message (forget/deny cue
    // + the topic's words). Everything else the model "rejected" is dropped.
    const rawRejections = normalizeRejections(proposal.reject);
    const newRejections = groundRejections(rawRejections, userMessage);
    if (rawRejections.length > newRejections.length) {
      logger.info(`Memory: dropped ${rawRejections.length - newRejections.length} ungrounded rejection(s) for ${userId} (not in the user's own words): ${rawRejections.filter((r) => !newRejections.includes(r)).slice(0, 5).map((r) => r.slice(0, 60)).join(' | ')}`);
    }

    // ── Guard: spurious 'name' overwrites ──────────────────────────────────────
    // 2026-06-23: A thumbs-down report showed Digby answering "what's my name" with a
    // name pulled from an email signature ("Paul Cozzolino") for a user actually named
    // "Rome". The extraction LLM sometimes lifts a name from quoted text, an email
    // address, or a Calendly handle rather than what the user stated. Because the 'name'
    // fact is injected into EVERY query via getUserMemoryBlock(), a wrong value
    // propagates everywhere. So we only accept a NEW/CHANGED name when the user declared
    // it in first person in THIS message; otherwise drop the change (existing name kept).
    const nameKey = Object.keys(factsToAdd).find(k => k.toLowerCase() === 'name');
    if (nameKey) {
      const proposed = String(factsToAdd[nameKey] ?? '').trim();
      const existingNameKey = Object.keys(existingFacts).find(k => k.toLowerCase() === 'name');
      const existingName = existingNameKey ? String(existingFacts[existingNameKey] ?? '').trim() : '';
      const changesName = !existingName || proposed.toLowerCase() !== existingName.toLowerCase();
      if (changesName) {
        // 2026-07-01: The first-person regex below still fired on PASTED content —
        // an email/signature that literally contains "I'm Paul Cozzolino" (or a
        // Calendly/LinkedIn handle) matches "i'?m <Name>" even though the *user*
        // never declared that name. A user almost never both pastes an email AND
        // introduces themselves in the same message, so if the message carries
        // paste/signature markers we do NOT trust the regex and keep the existing
        // name. This directly stops names lifted from email signatures / handles.
        const looksPasted =
          /[\w.+-]+@[\w-]+\.[\w.-]+/.test(userMessage) ||                       // any email address
          /\b(?:best regards|kind regards|warm regards|regards|sincerely|cheers|many thanks|thanks (?:&|and) regards|sent from my|unsubscribe|calendly\.com|linkedin\.com\/in|book a (?:time|call|meeting))\b/i.test(userMessage) ||
          // 2026-07-08: bare handle markers ("handle: pcozz", "@pcozz", "username pcozz").
          // The "Paul Cozzolino" incident lifted a surname from a Calendly *handle*
          // (pcozz) that appeared without the literal calendly.com domain, so the
          // email/domain checks above missed it. Treat any handle-style token as paste.
          /(?:\b(?:handle|username|user|login|@)\s*[:=]?\s*)@?[a-z][a-z0-9._-]{2,}/i.test(userMessage);
        // Capitalized 1-2 word name following a first-person self-introduction.
        // 2026-09-15: the cue is case-insensitive ("My name is Paul" at the
        // start of a sentence used to fail the guard and the name was never
        // learned); the name itself must still be capitalized.
        const m = /\b(?:[Mm]y name(?:'s| is)|[Cc]all me|[Yy]ou can call me|[Ii] go by|[Ii]'?m called|[Ii] am called|[Ii]'?m|[Ii] am)\s+([A-Z][a-zA-Z'’.-]+(?:\s+[A-Z][a-zA-Z'’.-]+)?)/.exec(userMessage);
        const stated = m?.[1]?.trim() || '';
        // 2026-07-08: require EVERY word of the proposed name to appear in the
        // first-person declaration — not just the first token. Previously we accepted
        // when `proposed` merely *contained* the stated first name, so if the user said
        // "I'm Paul" and the LLM appended a surname from context ("Paul Cozzolino" via a
        // Calendly handle), the extra surname slipped through. Now the LLM cannot graft
        // on any name-part the user did not actually state.
        const statedLower = stated.toLowerCase();
        const proposedWords = proposed.toLowerCase().split(/\s+/).filter(Boolean);
        const allProposedWordsStated =
          proposedWords.length > 0 && !!stated && proposedWords.every(w => statedLower.includes(w));
        const userDeclared = !looksPasted && allProposedWordsStated;
        if (!userDeclared) {
          logger.warn(`Memory: rejected spurious name update for ${userId} ("${proposed}") — ${looksPasted ? 'message contains paste/signature/handle markers (likely lifted from quoted text)' : 'proposed name not fully stated by the user in first person'}`);
          delete factsToAdd[nameKey];
        }
      }
    }

    if (Object.keys(factsToAdd).length === 0 && factsToRemove.length === 0 && newRejections.length === 0) {
      recordExtractionOutcome({ userId, source, chatId, outcome: 'noop', ms: llmMs, budgetTokens: proposal.budgetTokens });
      if (removalVerdict.dropped.length > 0) {
        const n = countVisibleFactsInBlob(existingFacts);
        recordMemoryMutation({ userId, source, chatId, droppedRemovals: removalVerdict.dropped, before: n, after: n });
      }
      return 'noop';
    }

    // Load persistent rejections from existing facts. Ticket ccd634fb: a ban the user's OWN
    // remember request now collides with (they asked to forget it, then asked to remember it again)
    // is LIFTED before the scrub — otherwise the scrub below deletes the very fact they asked for.
    // Live turns only: a rebuild replays OLD exchanges against today's bans, and today's bans
    // already carry the user's latest word — an old "remember X" must never undo a newer "forget X".
    const liftedRejections = source === 'turn' ? groundRejectionLifts((existingFacts as any).__rejections, factsToAdd, userMessage) : [];
    const persistentRejections: string[] = normalizeRejections((existingFacts as any).__rejections)
      .filter((r) => !liftedRejections.includes(r));

    // Merge: add new facts, remove rejected ones
    const mergedFacts = { ...existingFacts, ...factsToAdd };
    if (liftedRejections.length > 0) {
      if (persistentRejections.length > 0) (mergedFacts as any).__rejections = persistentRejections;
      else delete (mergedFacts as any).__rejections;
      logger.info(`Memory: lifted banned topic(s) for ${userId} — the user asked to remember them again: ${liftedRejections.join(', ')}`);
    }
    for (const key of factsToRemove) {
      for (const existingKey of Object.keys(mergedFacts)) {
        if (existingKey.toLowerCase() === key.toLowerCase()) {
          delete mergedFacts[existingKey];
        }
      }
    }

    // Persist new rejections — deduplicate with existing (case-insensitive)
    if (newRejections.length > 0) {
      const existingLower = persistentRejections.map(r => r.toLowerCase());
      const uniqueNew = newRejections.filter(r => !existingLower.includes(r.toLowerCase()));
      const allRejections = [...persistentRejections, ...uniqueNew].slice(-20);
      (mergedFacts as any).__rejections = allRejections;
      logger.info(`Memory: permanently rejected topics for ${userId}: ${uniqueNew.join(', ')}`);
    }

    // Programmatic scrub: remove any fact whose key or value matches a rejected topic
    const allRejections: string[] = normalizeRejections((mergedFacts as any).__rejections);
    if (allRejections.length > 0) {
      const rejKw = buildRejectionKeywords(allRejections);
      for (const key of Object.keys(mergedFacts)) {
        if (key.startsWith('__')) continue;
        const combined = `${key.toLowerCase()} ${String(mergedFacts[key]).toLowerCase()}`;
        for (const kw of rejKw) {
          if (combined.includes(kw)) {
            delete mergedFacts[key];
            logger.debug(`Memory: scrubbed fact "${key}" matching rejected keyword "${kw}"`);
            break;
          }
        }
      }
    }

    await prisma.userMemory.upsert({
      where: { userId },
      create: { userId, facts: mergedFacts },
      update: { facts: mergedFacts, updatedAt: new Date() },
    });

    // Fact versions (2026-10-20): a changed value is CLOSED as 'replaced' (kept), never
    // overwritten; removals + the rejection scrub are the user's own forget → purged.
    // Before the index sync so a lazy backfill can still read the old row's createdAt.
    void recordFactVersions({ userId, before: existingFacts, after: mergedFacts, source, chatId, removal: 'purge' }).catch(() => null);

    // Reconcile the semantic retrieval index (user_memory_facts rows) to the
    // new blob — fire-and-forget, embeds only added/changed facts.
    void syncUserFactRows(userId);

    const addCount = Object.keys(factsToAdd).length;
    const removeCount = factsToRemove.length;
    logger.info(`Memory: updated flat user memory for ${userId} — added ${addCount}, removed ${removeCount}, rejected ${newRejections.length} facts`);
    recordExtractionOutcome({ userId, source, chatId, outcome: 'changed', ms: llmMs, budgetTokens: proposal.budgetTokens });
    recordMemoryMutation({
      userId, source, chatId,
      added: Object.keys(factsToAdd),
      removed: Object.keys(existingFacts).filter((k) => !k.startsWith('__') && !(k in mergedFacts)),
      droppedRemovals: removalVerdict.dropped,
      rejected: newRejections,
      ...(liftedRejections.length ? { liftedRejections } : {}),
      before: countVisibleFactsInBlob(existingFacts),
      after: countVisibleFactsInBlob(mergedFacts),
    });
    return 'changed';
  } catch (err: any) {
    logger.debug(`Memory: applyFlatFactProposal failed (non-fatal): ${err.message}`);
    return 'llm_error';
  }
}

/** Propose + apply flat facts. Returns the apply outcome, or null when no proposal came back (the LLM leg failed / empty). */
async function extractAndSaveFlatFacts(
  userId: string,
  userMessage: string,
  assistantSummary: string,
  source: MemoryMutationSource = 'turn',
  chatId?: string | null,
  ungrounded = false,
): Promise<MemoryExtractionOutcome | null> {
  const existing = await prisma.userMemory.findUnique({ where: { userId } }).catch(() => null);
  const existingFacts = (existing?.facts as Record<string, string>) || {};
  const proposal = await proposeFlatFacts(userId, existingFacts, userMessage, assistantSummary, source, chatId, ungrounded);
  if (!proposal) return null;
  if (ungrounded) {
    // audit 2026-10-08 W4-2 backstop: an added fact carrying a "confirmed" claim or a detail only the UNVERIFIED
    // answer stated (a model number the user never typed) is not the user's fact — drop it.
    const grounded = [userMessage, JSON.stringify(existingFacts)];
    const dropped: string[] = [];
    for (const [k, v] of Object.entries(proposal.add ?? {})) {
      const verdict = dropUngroundedItem(`${k}: ${v}`, assistantSummary, grounded);
      if (verdict.drop) { delete proposal.add[k]; dropped.push(verdict.why ?? 'ungrounded'); }
    }
    if (dropped.length) recordProvenance({ chatId, answerGrounding: null }, 'user', { action: 'dropped_facts', dropped: dropped.length, why: dropped.slice(0, 3) });
  }
  return applyFlatFactProposal(userId, proposal, userMessage, source, chatId);
}

// ── E5 honest labels (2026-09-25): did an extractor PERSIST a change? ────────
// The memory_extract outcome rows used to read actual:true on every extractor
// that ran (`note 'ran'`) — a vacuous label: 14/14 positives, agreement
// unmeasurable. Each extractor node now returns what it measurably did, and
// the node's saved state is compared to the prior state on its CONTENT fields
// (bookkeeping fields like lastUpdated / messageCount always change).

/** Node return shape: the extractor's harness-measured outcome (absent = unknown). */
export interface ExtractorNodeResult { memoryExtractOutcome?: MemoryExtractionOutcome }

/** True when two states differ on any field except the ignored bookkeeping keys. Pure; order-insensitive on keys. */
export function stateContentChanged(before: unknown, after: unknown, ignoreKeys: readonly string[]): boolean {
  const strip = (v: unknown): unknown => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return v ?? null;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      if (ignoreKeys.includes(k)) continue;
      out[k] = (v as Record<string, unknown>)[k];
    }
    return out;
  };
  try { return JSON.stringify(strip(before)) !== JSON.stringify(strip(after)); }
  catch { return true; }
}

function parseJson<T>(text: string, fallback: T): T {
  try {
    const clean = text.replace(/```json\n?|\n?```/g, '').trim();
    return JSON.parse(clean) as T;
  } catch {
    return fallback;
  }
}

// ── DB helpers ────────────────────────────────────────────────────────────────

async function loadUserContextState(userId: string): Promise<{
  facts: Record<string, string>;
  contextState: UserContextState | null;
  rejections: string[];
}> {
  try {
    // Load raw user facts from Prisma (profile interview data stays in Prisma)
    const memory = await prisma.userMemory.findUnique({ where: { userId } });
    const rawFacts = (memory?.facts as Record<string, any>) || {};

    // Extract persistent rejections before stripping internal keys
    const rejections: string[] = normalizeRejections((rawFacts as any).__rejections);

    // Strip internal keys from plain facts
    const plainFacts = Object.fromEntries(
      Object.entries(rawFacts).filter(([k]) => !k.startsWith('__'))
    );

    // Load structured context state from the context store (sole source of truth)
    const contextState = await storeGet<UserContextState>([userId, 'memory'], 'contextState');

    return { facts: plainFacts as Record<string, string>, contextState, rejections };
  } catch (err) {
    logger.error('Memory: loadUserContextState error', err);
    return { facts: {}, contextState: null, rejections: [] };
  }
}

async function saveUserContextState(userId: string, contextState: UserContextState): Promise<void> {
  try {
    await storePut([userId, 'memory'], 'contextState', contextState as unknown as Record<string, unknown>);
    logger.debug(`Memory: saved user context state to Store for ${userId}`);
  } catch (err) {
    logger.error('Memory: saveUserContextState error', err);
  }
}

/**
 * Wipe the structured GLOBAL user context state (summary/currentFocus/recentTopics/…).
 * `clearUserMemory` previously only cleared the Prisma flat facts, leaving the structured
 * state in the Store — so polluted project focus/topics kept leaking after a "clear memory".
 */
export async function clearUserContextState(userId: string): Promise<void> {
  await saveUserContextState(userId, {
    summary: '', preferences: '', currentFocus: '', recentTopics: [], communicationStyle: '',
  });
}

async function loadProjectContextState(projectId: string): Promise<ProjectContextState | null> {
  try {
    return await storeGet<ProjectContextState>([projectId, 'context'], 'state');
  } catch (err) {
    logger.error('Memory: loadProjectContextState error', err);
    return null;
  }
}

/**
 * P2 folder-tree read: project context merged across the ancestor chain
 * (nearest-wins on key conflicts, arrays concatenate root→leaf) — memory filed
 * at "Work" is visible in "Work/Client A". Used ONLY on the prompt-building
 * read path; the update path (loadExistingStateNode) stays leaf-only because
 * writes always go to the leaf and must not pin inherited ancestor state.
 */
async function loadMergedProjectContextState(projectId: string): Promise<ProjectContextState | null> {
  try {
    return await getMergedProjectStoreState<ProjectContextState>(projectId, 'context');
  } catch (err) {
    logger.error('Memory: loadMergedProjectContextState error', err);
    return null;
  }
}

async function saveProjectContextState(projectId: string, state: ProjectContextState): Promise<void> {
  try {
    await storePut([projectId, 'context'], 'state', state as unknown as Record<string, unknown>);
    logger.debug(`Memory: saved project context state to Store for ${projectId}`);
  } catch (err) {
    logger.error('Memory: saveProjectContextState error', err);
  }
}

// ── Project decisions → unified store (2026-09-14) ─────────────────────────────
//
// extractProjectStateNode merges decisions into the project context state
// ([projectId,'context'] in the context store) — a blob only the CHAT
// prompt-builder reads. Coding runs' search_memory reads digby_memory, so every
// NEWLY extracted decision is also filed there: scope 'project', source
// 'decision', one row per decision, ref 'decision:<yyyy-mm-dd>:<slug>', short
// title. Dedupe is the before/after DIFF of recentDecisions (near-duplicate
// aware — the extractor rephrases), so a decision is written once and a second
// identical run writes nothing. This is the WRITE side, keyed by the project the
// run already belongs to; reads stay per-project-authorized upstream
// (memory/memory-access.ts).

export const DECISION_SOURCE = 'decision';
/** Newest decision rows kept per project (source-scoped — never the shared scope cap). */
export const DECISION_CAP = 500;
const MIN_DECISION_CHARS = 12;
const MAX_DECISIONS_PER_RUN = 10;
const DECISION_SLUG_MAX = 48;
const DECISION_TITLE_MAX = 90;
const DECISION_PLACEHOLDER_RE = /^\(?\s*(?:none|n\/a|na|tbd|todo|unknown|no (?:new )?decisions?(?: yet| made| recorded)?|nothing(?: yet)?|not yet)\s*\.?\)?$/i;
/** Machine-run project extraction reads a wider slice of the final (a coding
 *  run's report is long and its decisions sit past a chat answer's 600 chars). */
const MACHINE_RUN_SYNTHESIS_WINDOW_CHARS = 2500;

// ── Project-state verbosity clamp (2026-09-23, firing 7) ─────────────────────
// Measured live: CanLaw's stored project state hit 12,395 bytes at the LEGAL
// 10+10 items — every array already at its cap; item LENGTH is the growth
// vector (a "decision" carried a whole paragraph of run ids). The extraction
// prompt echoes that state back inside maxTokens, so an unbounded echo budget
// cannot exist: the state is clamped to ≤180 chars/item on SAVE and the prompt
// embeds at most PROJECT_STATE_EMBED_MAX_CHARS of it.
const PROJECT_STATE_ITEM_CHAR_CAP = 180;
const PROJECT_STATE_EMBED_MAX_CHARS = 12000;
/** Clamp every string array of a ProjectContextState to N chars/item (head+tail
 *  elision keeps the identifying start and the newest tail of each item). */
export function clampProjectStateItems<T extends { summary?: string; recentDecisions?: unknown[]; openItems?: unknown[]; entities?: Record<string, unknown[]> }>(state: T): T {
  const clampOne = (s: unknown): unknown => {
    if (typeof s !== 'string' || s.length <= PROJECT_STATE_ITEM_CHAR_CAP) return s;
    return `${s.slice(0, 120)} … ${s.slice(-50)}`;
  };
  const clampArr = (a: unknown): unknown => (Array.isArray(a) ? a.map(clampOne) : a);
  return {
    ...state,
    ...(typeof state.summary === 'string' && state.summary.length > 600 ? { summary: `${state.summary.slice(0, 360)} … ${state.summary.slice(-200)}` } : {}),
    recentDecisions: clampArr(state.recentDecisions) as T['recentDecisions'],
    openItems: clampArr(state.openItems) as T['openItems'],
    entities: Object.fromEntries(Object.entries(state.entities ?? {}).map(([k, v]) => [k, clampArr(v)])) as T['entities'],
  };
}
/** Output-token budget for the project extractor: the model must ECHO the
 *  existing state it was shown, so the budget scales with that state — ~0.5
 *  output tokens per char of COMPACT state JSON (measured 2026-09-23: a
 *  12.4k-char state truncated at 4000 tokens mid-array; DeepSeek JSON echo
 *  runs ≈ 2 chars/token pretty-printed) plus headroom for the new exchange's
 *  items. Floor 4000 (the fa915ba0 raise — fits any fresh 10+10 state),
 *  ceiling 8000 (a state so large it needs more was mis-extracted; the
 *  save-side clamp keeps legal states under it). */
export function projectExtractionBudget(stateChars: number): number {
  return Math.min(8000, Math.max(4000, Math.ceil((stateChars * 0.5 + 1000) / 100) * 100));
}
/**
 * 2026-10-20 memory wave — project state as PER-ITEM OPS (memory/state-ops.ts). The scaled echo
 * budget above exists only because the model re-emitted the whole state; with ops the answer
 * carries only this exchange's changes, so a fixed budget fits any state size. Same caps as the
 * legacy save clamp (summary 600, ≤10 items of ≤180 chars per list).
 */
export const PROJECT_OPS_SPEC: OpsSpec = {
  text: { summary: { cap: 600 } },
  lists: {
    recentDecisions: { cap: 10, itemCap: PROJECT_STATE_ITEM_CHAR_CAP, idPrefix: 'D' },
    openItems: { cap: 10, itemCap: PROJECT_STATE_ITEM_CHAR_CAP, idPrefix: 'O' },
    'entities.people': { cap: 10, itemCap: PROJECT_STATE_ITEM_CHAR_CAP, idPrefix: 'P' },
    'entities.amounts': { cap: 10, itemCap: PROJECT_STATE_ITEM_CHAR_CAP, idPrefix: 'A' },
    'entities.places': { cap: 10, itemCap: PROJECT_STATE_ITEM_CHAR_CAP, idPrefix: 'L' },
    'entities.topics': { cap: 10, itemCap: PROJECT_STATE_ITEM_CHAR_CAP, idPrefix: 'K' },
  },
};
/** The ops answer is bounded by one exchange's changes — not by the state it updates. */
export const PROJECT_OPS_BUDGET_TOKENS = 3000;
const EMPTY_PROJECT_STATE = (): ProjectContextState => ({
  summary: '', recentDecisions: [], entities: { people: [], amounts: [], places: [], topics: [] }, openItems: [], lastUpdated: new Date().toISOString(),
});
/** A machine final shorter than this ("No changes needed.") isn't worth an LLM call. */
const MACHINE_RUN_MIN_SYNTHESIS_CHARS = 100;

export function normalizeDecisionText(s: unknown): string {
  return normalizeQuotes(String(s ?? '')).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function decisionTokens(s: string): Set<string> {
  return new Set(normalizeDecisionText(s).split(' ').filter(t => t.length >= 3));
}

/** Near-duplicate test: equal after normalization, containment, or ≥ 0.8 token Jaccard. */
export function isSameDecision(a: string, b: string): boolean {
  const na = normalizeDecisionText(a);
  const nb = normalizeDecisionText(b);
  if (!na || !nb) return false;
  if (na === nb || na.includes(nb) || nb.includes(na)) return true;
  const ta = decisionTokens(a);
  const tb = decisionTokens(b);
  if (ta.size < 3 || tb.size < 3) return false;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter) >= 0.8;
}

/**
 * Decisions present in `after` but not in `before` (near-duplicate aware),
 * placeholders/stubs dropped, deduped within the batch, capped. Tolerates a
 * non-array from the extractor (treated as empty).
 */
export function diffNewDecisions(before: unknown, after: unknown): string[] {
  const prev = (Array.isArray(before) ? before : []).filter((s): s is string => typeof s === 'string');
  const next = (Array.isArray(after) ? after : []).filter((s): s is string => typeof s === 'string');
  const out: string[] = [];
  for (const raw of next) {
    const d = raw.replace(/\s+/g, ' ').trim();
    if (d.length < MIN_DECISION_CHARS || DECISION_PLACEHOLDER_RE.test(d)) continue;
    if (prev.some(p => isSameDecision(p, d)) || out.some(p => isSameDecision(p, d))) continue;
    out.push(d);
    if (out.length >= MAX_DECISIONS_PER_RUN) break;
  }
  return out;
}

export function decisionSlug(decision: string, max = DECISION_SLUG_MAX): string {
  const slug = normalizeDecisionText(decision).split(' ').filter(Boolean).join('-');
  if (slug.length <= max) return slug || 'decision';
  const cut = slug.slice(0, max);
  const i = cut.lastIndexOf('-');
  return (i >= 16 ? cut.slice(0, i) : cut) || 'decision';
}

/** 'decision:<yyyy-mm-dd>:<slug>' (UTC date). */
export function decisionRef(decision: string, when: Date = new Date()): string {
  return `decision:${when.toISOString().slice(0, 10)}:${decisionSlug(decision)}`;
}

function shortDecisionTitle(decision: string, max = DECISION_TITLE_MAX): string {
  const d = decision.replace(/\s+/g, ' ').trim();
  if (d.length <= max) return d;
  const cut = d.slice(0, max - 1);
  const i = cut.lastIndexOf(' ');
  return `${i >= 24 ? cut.slice(0, i) : cut}…`;
}

/** One MemItem per decision: ref 'decision:<date>:<slug>', short title, provenance-stamped content. */
export function buildDecisionMemoryItems(
  decisions: string[],
  opts: { origin: 'chat' | 'machine_run'; when?: Date },
): MemItem[] {
  const when = opts.when ?? new Date();
  const day = when.toISOString().slice(0, 10);
  const from = opts.origin === 'machine_run' ? "a coding run's accepted final" : 'a chat';
  return decisions.map(d => ({
    ref: decisionRef(d, when),
    title: shortDecisionTitle(d),
    content: `Project decision (recorded ${day} from ${from}): ${d}`,
  }));
}

/**
 * File the newly extracted decisions into digby_memory. Best-effort: a failure
 * degrades coding-run recall, never the request. Returns rows written.
 * `skipGate: true` — decisions are CURATED extractor output, usually one short
 * plain-prose sentence, exactly what worthEmbedding drops (the same reason the
 * learnings sync skips it); diffNewDecisions is the quality gate here.
 */
async function storeProjectDecisionsToUnifiedMemory(
  projectId: string,
  userId: string | null,
  before: ProjectContextState | null,
  after: ProjectContextState,
  machineRun: boolean,
): Promise<number> {
  const fresh = diffNewDecisions(before?.recentDecisions, after?.recentDecisions);
  if (!fresh.length) return 0;
  try {
    const items = buildDecisionMemoryItems(fresh, { origin: machineRun ? 'machine_run' : 'chat' });
    // skipCap is LOAD-BEARING (EOD review 2026-09-14 BLOCKER): the project scope
    // is SHARED with the code index + learnings, and memStore's default cap
    // sweep is source-blind — without skipCap the first decision write deleted
    // every project row beyond the newest 800 (spark-cluster lost its code index
    // in prod at 15:4xZ). Decisions get their own source-scoped bound instead.
    const n = await memStore({ type: 'project', id: projectId }, DECISION_SOURCE, items, { userId: userId ?? undefined, skipGate: true, skipCap: true });
    if (n > 0) await enforceScopeCap({ type: 'project', id: projectId }, DECISION_CAP, DECISION_SOURCE).catch(() => {});
    logger.info(`Memory: filed ${fresh.length} new project decision(s) → digby_memory (${n} row(s)) for project ${projectId}${machineRun ? ' [machine run]' : ''}`);
    return n;
  } catch (err: any) {
    logger.debug(`Memory: decision store failed (non-fatal): ${err?.message ?? err}`);
    return 0;
  }
}

// ── Per-project settings (stored in the Store to avoid a schema migration) ──────

export interface ProjectSettings {
  /** When true, queries in this project may also retrieve relevant knowledge
   *  from the user's OTHER projects (reranker-gated, labeled). Default TRUE
   *  (owner directive 2026-09-08 — the account-wide blend of 2026-08-13 had
   *  already made this always-on and left the toggle vestigial; the default
   *  now matches that reality and FALSE is an honest opt-out: chat-context
   *  withholds userId from retrieveChunks, restoring pre-blend isolation).
   *  Unset parses as true; only an explicit false isolates. */
  crossProjectMemory: boolean;
  /** Project-level coding ORCHESTRATOR pick (owner ask 2026-09-04): a built-in
   *  id or a '<label>:<modelId>' endpoint spec. Wins over the user's pref at
   *  session stamping AND over the stamped session model at run time (so
   *  swapping the project's agent applies to EXISTING sessions' next runs).
   *  Absent = no override. Folder-inherited like every settings key. */
  codingModel?: string;
  /** Provenance of `codingModel` (seats govern sessions, 2026-09-28): 'user' =
   *  a human set it (side panel / REST / a tool call on a human turn);
   *  'machine' = a lane / supervisor wrote it on a machine turn — such an
   *  override never shadows the admin's coding_default seat. Absent on
   *  legacy overrides (treated as user-set). Dropped with the override. */
  codingModelSource?: 'user' | 'machine';
  /** Spend cap (remediation P7 N7/S1a): max trailing-24h machine-run spend
   *  (USD) for chats in this project — the schedule sweeper skips firings over
   *  it (spend-cap.service). Absent/null = NO cap (the default; the owner
   *  opts in). Folder-inherited like every settings key. */
  spendCapUsdPerDay?: number;
  /** Machine self-merge policy (owner directive 2026-09-09; self-merge.service
   *  resolveSelfMergePolicy). Absent = inference/ask. An 'off' is only honored
   *  when selfMergeSource is a human ('owner'/'answered') — inferred 'off' is
   *  never trusted (the 2026-09-09 inversion incident). */
  selfMerge?: 'on' | 'off';
  selfMergeSource?: 'owner' | 'answered' | 'inferred';
  selfMergeWhy?: string;
  /** Gmail auto-ingest (ticket 99145890): when true, a gmail_get_attachment
   *  the agent runs in this project files the attachment into the KB
   *  automatically (fire-and-forget, dedup by messageId+filename via
   *  gmail-knowledge.service — a re-download is a no-op). Default FALSE
   *  (explicit opt-in); folder-inherited like every settings key. */
  autoIngestGmailAttachments?: boolean;
}

const DEFAULT_PROJECT_SETTINGS: ProjectSettings = { crossProjectMemory: true };

/**
 * Effective settings for a project. P2 folder tree: reads MERGE the ancestor
 * chain (nearest-wins per key — a setting made at "Work" applies in
 * "Work/Client A" unless overridden there). Flag off → leaf-only read.
 */
export async function getProjectSettings(projectId: string): Promise<ProjectSettings> {
  try {
    const v = (await getMergedProjectStoreState<Partial<ProjectSettings>>(projectId, 'settings')) || {};
    return {
      ...DEFAULT_PROJECT_SETTINGS, ...v,
      crossProjectMemory: v.crossProjectMemory !== false, // unset → true (default-on); only explicit false isolates

      // Gmail auto-ingest (99145890): default OFF — only an explicit boolean counts.
      autoIngestGmailAttachments: v.autoIngestGmailAttachments === true,

      // Type-guard stored JSON: only a non-empty string is a real pick.
      ...(typeof v.codingModel === 'string' && v.codingModel.trim() ? { codingModel: v.codingModel.trim() } : {}),
      // Provenance rides only with a real pick (seats govern sessions, 2026-09-28).
      ...(typeof v.codingModel === 'string' && v.codingModel.trim() && (v.codingModelSource === 'user' || v.codingModelSource === 'machine')
        ? { codingModelSource: v.codingModelSource }
        : {}),
      // P7: only a finite positive number is a real cap.
      ...(typeof v.spendCapUsdPerDay === 'number' && Number.isFinite(v.spendCapUsdPerDay) && v.spendCapUsdPerDay > 0
        ? { spendCapUsdPerDay: v.spendCapUsdPerDay }
        : {}),
    };
  } catch {
    return { ...DEFAULT_PROJECT_SETTINGS };
  }
}

export async function setProjectSettings(projectId: string, patch: Partial<ProjectSettings>): Promise<ProjectSettings> {
  // Writes stay LEAF-ONLY: read the leaf's own row (not the merged view) so an
  // inherited value is never pinned into the leaf by an unrelated patch.
  let current: ProjectSettings;
  try {
    const v = (await storeGet<Partial<ProjectSettings>>([projectId, 'settings'], 'state')) || {};
    current = { ...DEFAULT_PROJECT_SETTINGS, ...v, crossProjectMemory: v.crossProjectMemory !== false };
  } catch {
    current = { ...DEFAULT_PROJECT_SETTINGS };
  }
  const updated: ProjectSettings = { ...current, ...patch };
  // '' means CLEAR for optional string keys — drop the key rather than pinning
  // an empty override into the leaf (which would also shadow folder inheritance).
  if (!updated.codingModel || !updated.codingModel.trim()) { delete updated.codingModel; delete updated.codingModelSource; }
  // The provenance is only ever 'user' | 'machine' — anything else is dropped (legacy = absent).
  if (updated.codingModelSource !== 'user' && updated.codingModelSource !== 'machine') delete updated.codingModelSource;
  // P7: a non-positive/invalid cap means CLEAR (same drop-the-key doctrine).
  if (!(typeof updated.spendCapUsdPerDay === 'number' && Number.isFinite(updated.spendCapUsdPerDay) && updated.spendCapUsdPerDay > 0)) {
    delete updated.spendCapUsdPerDay;
  }
  // Self-merge (2026-09-09): undefined/invalid means CLEAR — drop the trio.
  if (updated.selfMerge !== 'on' && updated.selfMerge !== 'off') {
    delete updated.selfMerge; delete updated.selfMergeSource; delete updated.selfMergeWhy;
  }
  try {
    await storePut([projectId, 'settings'], 'state', updated as unknown as Record<string, unknown>);
  } catch (err) {
    logger.error('Memory: setProjectSettings error', err);
  }
  return updated;
}

/**
 * Load conversation thread state from PostgresStore.
 * Returns null if no state exists yet (new chat or not yet updated).
 */
async function loadThreadState(chatId: string): Promise<ConversationThreadState | null> {
  try {
    return await storeGet<ConversationThreadState>([chatId, 'thread'], 'state');
  } catch (err) {
    logger.error('Memory: loadThreadState error', err);
    return null;
  }
}

/**
 * THREAD_STATE_DEBOUNCE_FIX bookkeeping (review 2026-10-22): raise ONLY the
 * stored thread messageCount — an atomic single-field update, never a rewrite
 * of the snapshot this turn loaded (an overlapping extraction may have saved a
 * newer threadSummary / openTopics since that read), and never downward (a
 * concurrent save that already counted further wins). Never throws.
 */
async function advanceThreadCounter(chatId: string, messageCount: number): Promise<void> {
  try {
    await storeAdvanceNumberField([chatId, 'thread'], 'state', 'messageCount', messageCount);
  } catch (err) {
    logger.error('Memory: advanceThreadCounter error', err);
  }
}

/**
 * Save conversation thread state to PostgresStore.
 */
/**
 * True only when the chat row is DEFINITELY gone (a lookup that answers null).
 * A failed lookup is "unknown" ⇒ false: a late write is never undone on a DB blip.
 */
async function chatDefinitelyGone(chatId: string): Promise<boolean> {
  try {
    const row = await (prisma as any).crossModelChat.findUnique({ where: { id: chatId }, select: { id: true } });
    return row === null;
  } catch {
    return false;
  }
}

async function saveThreadState(chatId: string, state: ConversationThreadState): Promise<void> {
  try {
    await storePut([chatId, 'thread'], 'state', state as unknown as Record<string, unknown>);
    logger.debug(`Memory: saved thread state to Store for ${chatId}`);
  } catch (err) {
    logger.error('Memory: saveThreadState error', err);
    return;
  }
  // Review 2026-10-23 (privacy): this pipeline is fire-and-forget and the
  // extraction spends seconds in utilityChat, so a chat (or account) deleted
  // meanwhile had its [chatId,'thread'] row purged BEFORE this upsert
  // re-created it — an orphan summary of a deleted chat (the store has no FK,
  // no TTL, no sweep). Write, THEN check: a chat that is gone loses the row
  // it just got. A lookup failure keeps it.
  if (await chatDefinitelyGone(chatId)) {
    try {
      await storeDelete([chatId, 'thread'], 'state');
      logger.info(`Memory: chat ${chatId} was deleted during its thread extraction — the late thread save was removed`);
    } catch { /* best-effort */ }
  }
}

// ── Format helpers ─────────────────────────────────────────────────────────────

/**
 * Format user memory block for system context injection.
 * Includes plain facts, structured user context state, and (for long chats)
 * the conversation thread state to provide historical context.
 * Also includes persistent rejections — topics the user has permanently banned.
 * Scrubs all structured state against rejections at format-time (defensive).
 *
 * RELEVANCE GATE (2026-07-05): topical facts and profile summary/focus/topics
 * are only injected when they topically relate to the current user message
 * (+ recent user messages). Identity/style keys (name, timezone, communication
 * style…) always pass, and memory-recall questions ("what do you know about
 * me?") bypass the gate. This stops Digby volunteering stored personal facts
 * in completely unrelated chats — models can't misuse what they don't see.
 * Exported for tests (ticket 6fd4663a): the BANNED TOPICS doctrine text is the contract the
 * model reads on a banned-topic turn — the carve-out for the user's own explicit remember is
 * what makes remember_fact callable again; a test pins it so the wording can never silently
 * re-broaden to "under ANY circumstances".
 */
export function formatUserMemoryBlock(
  factSelection: FactSelection,
  contextState: UserContextState | null,
  threadState?: ConversationThreadState | null,
  rejections?: string[],
  inProject = false,
  currentMessage = '',
  recentUserMessages: string[] = [],
): string {
  const parts: string[] = [];

  // Build rejection keyword set for format-time scrubbing
  rejections = normalizeRejections(rejections);
  const rejKw = rejections.length > 0 ? buildRejectionKeywords(rejections) : new Set<string>();

  // Persistent rejections — ALWAYS inject first so synthesizers see them prominently
  if (rejections && rejections.length > 0) {
    // Ticket 6fd4663a (nightly suite 2026-10-15, case 02-memory): the ABSOLUTIST wording
    // ("under ANY circumstances … permanent bans — not suggestions") made the model refuse the
    // user's OWN later "please remember that my favourite tea is oolong" — it answered from the
    // ban and asked "do you want to lift that ban?" instead of calling remember_fact, WHICH
    // WOULD HAVE LIFTED THE BAN SERVER-SIDE (context.service updateMemoryFact liftRejections,
    // ticket ccd634fb). An explicit remember IS the lift path. The carve-out keeps the ban's
    // force for volunteering, answering and small talk, and names the two legitimate routes:
    // the user's own explicit remember ask, and (as the suite's case 14 showed) asking ONE
    // clarifying question when the intent is genuinely ambiguous. Never re-broaden this to
    // "ANY circumstances" — that exact wording is what broke the nightly case.
    parts.push(`[BANNED TOPICS — NEVER MENTION THESE UNLESS THE USER EXPLICITLY ASKS]\nThe user has told you to STOP talking about these topics. Do NOT reference, allude to, or bring up ANY of these on your own — not in answers, not in small talk, not in suggestions:\n${rejections.map(r => `⛔ ${r}`).join('\n')}\nEXCEPTION — the user's OWN explicit request wins: when the user THEMSELVES ask you to remember, store, discuss or answer about one of these topics in THIS message ("please remember that my favourite tea is oolong"), that is the ban being lifted — do exactly as they ask. Call remember_fact (it lifts the ban server-side), answer their question, or run their ask without re-asking whether the ban should stand. Asking "do you want to lift that ban?" instead of acting is a FAILURE MODE: the lift is the answer. Only ask one clarifying question when the request is genuinely ambiguous about wanting the topic back.\nViolating this unprompted will upset the user. These bans stay until the user lifts them.`);
  }

  // Plain key-value facts — relevance-selected upstream (semantic retrieval when
  // the embedding index is available, deterministic keyword gate otherwise).
  const { relevant: relevantFacts, withheldCount, recallBypass, semantic } = factSelection;
  const factEntries = Object.entries(relevantFacts);
  if (withheldCount > 0) {
    logger.debug(`Memory: ${semantic ? 'semantic' : 'keyword'} relevance gate withheld ${withheldCount} off-topic fact(s) for this query`);
  }
  if (factEntries.length > 0) {
    const factLines = factEntries.map(([k, v]) => `- ${k}: ${v}`).join('\n');
    parts.push(`[User Facts — background reference only]\n${factLines}`);
  }

  // Rich context state (LangGraph-powered) — scrub against rejections at format-time
  const scrubbed = contextState && rejKw.size > 0 ? scrubUserContextState(contextState, rejKw) : contextState;
  if (scrubbed) {
    const lines: string[] = ['[User Context]'];
    // Profile summary/focus/topics describe WHO the user is and what they've been
    // doing lately — highly tempting for models to weave into unrelated answers.
    // Only inject them when they topically relate to the current question (or the
    // user is explicitly asking about themselves).
    if (scrubbed.summary && (recallBypass || isTextRelevantToMessage(scrubbed.summary, currentMessage, recentUserMessages))) {
      lines.push(`Summary: ${scrubbed.summary}`);
    }
    // `currentFocus` and `recentTopics` describe the user's ACTIVE project/topics. Inside a project
    // they would carry whatever project the user touched last (often a DIFFERENT project) into this
    // one — the cross-project leak. Omit them here; the [Project Context] block supplies the focus
    // for the current project. They are only injected for project-less ("general") chats,
    // and only when relevant to the current question.
    if (!inProject && scrubbed.currentFocus && (recallBypass || isTextRelevantToMessage(scrubbed.currentFocus, currentMessage, recentUserMessages))) {
      lines.push(`Current Focus: ${scrubbed.currentFocus}`);
    }
    if (scrubbed.preferences) lines.push(`Preferences: ${scrubbed.preferences}`);
    if (scrubbed.communicationStyle) lines.push(`Style: ${scrubbed.communicationStyle}`);
    if (!inProject && scrubbed.recentTopics?.length > 0) {
      const relevantTopics = recallBypass
        ? scrubbed.recentTopics
        : scrubbed.recentTopics.filter(t => isTextRelevantToMessage(t, currentMessage, recentUserMessages));
      if (relevantTopics.length > 0) {
        lines.push(`Recent Topics: ${relevantTopics.slice(0, 3).join(', ')}`);
      }
    }
    if (lines.length > 1) parts.push(lines.join('\n'));
  }

  // Conversation thread state — scrub against rejections, then inject
  if (threadState && threadState.messageCount > 8 && threadState.threadSummary) {
    const ts = rejKw.size > 0 ? scrubThreadState(threadState, rejKw) : threadState;
    const turnCount = Math.floor(ts.messageCount / 2);
    const lines: string[] = [
      `[Conversation Thread — ${turnCount} exchanges so far — model-maintained summary, may contain inaccuracies; verify operational specifics (commands, URLs, amounts, action statuses) with fresh tool calls before relying on them]`,
      `History: ${ts.threadSummary}`,
    ];
    if (ts.lastUserGoal) {
      lines.push(`Current Goal: ${ts.lastUserGoal}`);
    }
    if (Object.keys(ts.confirmedFacts).length > 0) {
      lines.push('Established in this chat:');
      Object.entries(ts.confirmedFacts)
        .slice(0, 8)
        .forEach(([k, v]) => lines.push(`  • ${k}: ${v}`));
    }
    if (ts.openTopics.length > 0) {
      lines.push(`Still open: ${ts.openTopics.slice(0, 4).join(' | ')}`);
    }
    parts.push(lines.join('\n'));
  }

  // Add memory usage rules when there are facts stored
  if (parts.length > 0) {
    parts.push(`[MEMORY USAGE RULES — CRITICAL]
- Stored facts are BACKGROUND REFERENCE ONLY — the default is to NOT mention them at all
- Only reference a stored fact when the user's CURRENT question directly relates to it, or the user explicitly asks about themselves
- Do NOT volunteer memory facts unprompted (e.g. don't start with "Since you're in Vancouver..." when the question isn't about location)
- Do NOT force personalization: an answer that never touches stored memory is usually the CORRECT answer
- If the user corrects or rejects ANY stored fact, IMMEDIATELY stop using it — the user's words ALWAYS override stored memory
- Do NOT mention that you "remember" things about the user — just naturally incorporate relevant context
- Stale/old facts may be outdated — prefer information the user provides in the current conversation over stored memory
- NEVER keep referencing a topic the user has told you to stop mentioning, even if it's still in memory`);
  }

  return parts.join('\n\n');
}

function formatProjectStateBlock(state: ProjectContextState | null): string {
  if (!state) return '';

  const lines: string[] = ['[Project Context — Shared across all chats in this project]'];
  if (state.summary) lines.push(`\nProject: ${state.summary}`);

  if (state.recentDecisions?.length > 0) {
    lines.push('\nDecisions Made:');
    state.recentDecisions.slice(0, 5).forEach(d => lines.push(`  • ${d}`));
  }

  if (state.entities) {
    const entityParts: string[] = [];
    if (state.entities.people?.length > 0) entityParts.push(`People: ${state.entities.people.join(', ')}`);
    if (state.entities.amounts?.length > 0) entityParts.push(`Amounts: ${state.entities.amounts.join(', ')}`);
    if (state.entities.places?.length > 0) entityParts.push(`Places: ${state.entities.places.join(', ')}`);
    if (entityParts.length > 0) {
      lines.push('\nKey Entities:');
      entityParts.forEach(e => lines.push(`  ${e}`));
    }
  }

  if (state.openItems?.length > 0) {
    lines.push('\nOpen Items:');
    state.openItems.slice(0, 3).forEach(item => lines.push(`  ⟳ ${item}`));
  }

  return lines.join('\n');
}

// ═══════════════════════════════════════════════════════════════════════════════
// GET CONTEXT PIPELINE — loads enriched context before model queries
// Plain state object threaded through sequential steps; each step returns a
// partial that is spread-merged (same semantics as the old last-write-wins
// LangGraph channels).
// ═══════════════════════════════════════════════════════════════════════════════

interface GetContextState {
  // Inputs
  userId: string | null;
  chatId: string | null;
  projectId: string | null;
  userMessage: string;
  /** Machine-wake deep window (see GetContextInput.deepHistory). */
  deepHistory?: boolean;
  /** Orphan-recovery history exclusion (see GetContextInput.excludeMessageId). */
  excludeMessageId?: string;
  /** A plain user-space chat — the shared project state is not loaded (see GetContextInput.skipProjectState). */
  skipProjectState?: boolean;

  // Accumulated state
  conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }>;
  // wasCompressed removed in v2 Phase 1 — compression no longer happens
  userFacts: Record<string, string>;
  userContextState: UserContextState | null;
  projectContextState: ProjectContextState | null;
  chatThreadState: ConversationThreadState | null;
  // Persistent rejections — topics the user has explicitly told us to never mention
  userRejections: string[];

  // Final output
  userMemoryBlock: string;
  projectStateBlock: string;
}

/**
 * Node: load conversation history + thread state from DB.
 *
 * For long conversations (threadState.messageCount > 8), reduces the raw
 * history to the last 4 messages. The thread state summary provides the
 * historical context for everything before that — this is the key fix for
 * long-conversation context degradation.
 */
async function loadConversationNode(state: GetContextState) {
  if (!state.chatId || !state.userId) {
    return { conversationHistory: [], chatThreadState: null };
  }

  try {
    const [context, threadState] = await Promise.all([
      contextService.loadChatContext(state.chatId, state.userId, undefined, { deepHistory: state.deepHistory, excludeMessageId: state.excludeMessageId }),
      loadThreadState(state.chatId),
    ]);

    let conversationHistory = context.conversationHistory;

    // Long conversation optimization: when thread state exists and has enough
    // history, keep only the most recent raw messages as context.
    // The thread summary in userMemoryBlock will cover the rest.
    //
    // IMPORTANT: Keep 10 messages (5 exchanges) instead of 4 to provide
    // sufficient overlap with the thread state summary. The thread state is
    // debounced (updated every other turn for long convos), so recent messages
    // may not be captured in the summary yet. 10 messages ensures the models
    // always see the last 5 user questions + 5 assistant responses, which is
    // enough context for follow-up questions even when switching patience modes.
    // (Fix: context lost when switching between patience modes — v174)
    //
    // Machine wakes (deepHistory — audit p10): keep the deeper 24-message
    // window instead, char-bounded. This trim used to unconditionally cut to
    // 10 for exactly the long-running supervisor chats whose wakes PR #190
    // promised 24 messages, making that deepening a dead letter.
    const keepMessages = state.deepHistory ? MACHINE_WAKE_MAX_PAIRS * 2 : 10;
    if (threadState && threadState.messageCount > 12 && conversationHistory.length > keepMessages) {
      logger.debug(
        `Memory: long conversation detected (${threadState.messageCount} msgs), ` +
        `trimming history from ${conversationHistory.length} to ${keepMessages} messages`
      );
      conversationHistory = conversationHistory.slice(-keepMessages);
    }
    if (state.deepHistory) {
      conversationHistory = capHistoryToCharBudget(conversationHistory, MACHINE_WAKE_HISTORY_CHAR_BUDGET, 8);
    }

    return {
      conversationHistory,
      // wasCompressed removed in v2
      chatThreadState: threadState,
    };
  } catch (err: any) {
    logger.error(`Memory: loadConversationNode failed for chat=${state.chatId}: ${err?.message || err}`);
    return { conversationHistory: [], chatThreadState: null };
  }
}

// Node: load user facts + context state + rejections from DB
async function loadUserStateNode(state: GetContextState) {
  if (!state.userId) return {};
  const { facts, contextState, rejections } = await loadUserContextState(state.userId);
  return { userFacts: facts, userContextState: contextState, userRejections: rejections };
}

// Node: load project context state from DB (only if in a project).
// P2: MERGED across the ancestor chain (prompt-building read path).
async function loadProjectStateNode(state: GetContextState) {
  if (!state.projectId || state.skipProjectState) return { projectContextState: null };
  const projectState = await loadMergedProjectContextState(state.projectId);
  return { projectContextState: projectState };
}

// Node: format everything into context blocks for model queries.
// Also scrubs conversation history against rejected keywords so the synthesizer
// doesn't see banned topics in prior assistant responses and reference them again.
async function buildContextBlocksNode(state: GetContextState) {
  // Recent USER messages give the relevance gate topical continuity for short
  // follow-ups ("what about the other one?") that carry no topic words.
  const recentUserMessages = (state.conversationHistory || [])
    .filter(m => m.role === 'user')
    .slice(-2)
    .map(m => m.content);

  // Select which facts to inject: semantic retrieval (embeddings, top-K +
  // recency) when the user's fact index is available, keyword gate otherwise.
  // Anonymous users have no stored facts — keep the deterministic gate.
  const factSelection: FactSelection = state.userId
    ? await selectRelevantFacts(state.userId, state.userFacts, state.userMessage, recentUserMessages)
    : { ...filterFactsByRelevance(state.userFacts, state.userMessage, recentUserMessages), semantic: false };

  // Episodic memory: when the user references a past conversation ("what did
  // we discuss last week?"), pull matching snippets from their OTHER chats.
  // Cue-gated — zero cost for messages that don't reference the past.
  const episodicBlock = state.userId
    ? await buildEpisodicBlock(state.userId, state.userMessage, state.chatId)
    : '';

  let userMemoryBlock = formatUserMemoryBlock(
    factSelection,
    state.userContextState,
    state.chatThreadState,   // thread state injected here for long convos
    state.userRejections,    // persistent rejections — topics user banned
    !!state.projectId,       // in a project → omit global currentFocus/recentTopics (prevents cross-project leak)
    state.userMessage,       // relevance gate: only inject facts related to the current question
    recentUserMessages,
  );
  if (episodicBlock) {
    userMemoryBlock = userMemoryBlock ? `${userMemoryBlock}\n\n${episodicBlock}` : episodicBlock;
  }
  const projectStateBlock = formatProjectStateBlock(state.projectContextState);

  // Scrub conversation history against rejected keywords.
  // Without this, the LLM sees banned topics in prior assistant responses and echoes them.
  // Only scrub assistant messages — user messages should be preserved verbatim.
  let conversationHistory = state.conversationHistory;
  if (state.userRejections && state.userRejections.length > 0 && conversationHistory.length > 0) {
    const rejKw = buildRejectionKeywords(state.userRejections);
    conversationHistory = conversationHistory.map(msg => {
      if (msg.role === 'assistant') {
        return { ...msg, content: scrubTextAgainstRejections(msg.content, rejKw) };
      }
      return msg;
    });
  }

  return { userMemoryBlock, projectStateBlock, conversationHistory };
}

// Run the get-context pipeline: sequential steps, spread-merged partials
async function runGetContextPipeline(input: GetContextInput): Promise<GetContextState> {
  let state: GetContextState = {
    userId: input.userId,
    chatId: input.chatId,
    projectId: input.projectId,
    userMessage: input.userMessage,
    deepHistory: input.deepHistory,
    excludeMessageId: input.excludeMessageId,
    skipProjectState: input.skipProjectState === true,
    conversationHistory: [],
    userFacts: {},
    userContextState: null,
    projectContextState: null,
    chatThreadState: null,
    userRejections: [],
    userMemoryBlock: '',
    projectStateBlock: '',
  };
  state = { ...state, ...(await loadConversationNode(state)) };
  state = { ...state, ...(await loadUserStateNode(state)) };
  state = { ...state, ...(await loadProjectStateNode(state)) };
  state = { ...state, ...(await buildContextBlocksNode(state)) };
  return state;
}

// ═══════════════════════════════════════════════════════════════════════════════
// UPDATE CONTEXT PIPELINE — updates state after synthesis (fire-and-forget)
// ═══════════════════════════════════════════════════════════════════════════════

interface UpdateContextState {
  // Inputs
  userId: string | null;
  projectId: string | null;
  chatId: string | null;
  userMessage: string;
  synthesis: string;
  /** See UpdateContextInput.machineRun — project extraction only, no user/thread. */
  machineRun: boolean;
  /** See UpdateContextInput.supervisorChat — a real user turn in a supervisor chat: no PERSONAL fact extraction. */
  supervisorChat: boolean;
  /** See UpdateContextInput.skipProjectState — a plain user-space chat: no project-state extraction, no decision rows. */
  skipProjectState?: boolean;
  /** See UpdateContextInput.skipThreadState — a born-coding session: no thread LLM extraction, the counter still advances. */
  skipThreadState?: boolean;
  /** See UpdateContextInput.answerGrounding — audit 2026-10-08 W4-2 (null = unknown ⇒ the previous behaviour). */
  answerGrounding?: AnswerGrounding | null;
  /** The user's message denies / corrects stored info (extractAllParallelNode's regex) — the profile leg runs at once, past its per-user throttle. */
  explicitRejection?: boolean;

  // Loaded existing state
  existingUserFacts: Record<string, string>;
  existingUserContextState: UserContextState | null;
  existingProjectState: ProjectContextState | null;
  existingThreadState: ConversationThreadState | null;
}

// Node: load existing state (needed to merge with new extractions)
async function loadExistingStateNode(state: UpdateContextState) {
  const result: Partial<UpdateContextState> = {};

  const promises: Promise<void>[] = [];

  // Machine runs skip user + thread extraction, so skip those loads too.
  if (state.userId && !state.machineRun) {
    promises.push(
      loadUserContextState(state.userId).then(({ facts, contextState }) => {
        result.existingUserFacts = facts;
        result.existingUserContextState = contextState;
      })
    );
  }

  if (state.projectId && !state.skipProjectState) {
    promises.push(
      loadProjectContextState(state.projectId).then(s => {
        result.existingProjectState = s;
      })
    );
  }

  if (state.chatId && !state.machineRun) {
    promises.push(
      loadThreadState(state.chatId).then(s => {
        result.existingThreadState = s;
      })
    );
  }

  await Promise.all(promises);
  return result;
}

// Node: extract and update user context state via LLM
// FO firing 91 (2026-10-07): the profile leg ESCALATEd the charter's parse-share
// bar — 20.3 % (25 of 123, 4h window ending 02:35Z) with every tail cut
// mid-string ("…prefers ultra-concise formattin") — the {summary, preferences,
// currentFocus, recentTopics, communicationStyle} JSON plus the rejection-scan
// preamble no longer fits 900 output tokens. Same truncation class as the
// 2026-09-22 family (profile 512→900, distill 400→900, thread 600→2000) and
// firing 88's turn leg (384→2000): monotone-safe budget raise, now pinned at
// 1800 (headroom for preamble + the 5-field JSON on dense profiles).
export const PROFILE_EXTRACTION_BUDGET_TOKENS = 1800;

/**
 * 2026-10-20 memory wave — the profile as PER-ITEM OPS (memory/state-ops.ts): the model is shown the
 * profile with an id per topic and answers only what changes (`set` a field, `add` / `remove`
 * topics, or {}), so the answer is bounded by the change instead of echoing the whole profile —
 * the echo is what outgrew 512 → 900 → 1800 tokens. Same caps as PROFILE_FIELD_CAPS.
 * MEMORY_STATE_OPS_DISABLED=1 restores the whole-object answer (with the bounds of the caps switch).
 */
export const PROFILE_OPS_SPEC: OpsSpec = {
  text: {
    summary: { cap: PROFILE_FIELD_CAPS.summary },
    preferences: { cap: PROFILE_FIELD_CAPS.preferences },
    currentFocus: { cap: PROFILE_FIELD_CAPS.currentFocus },
    communicationStyle: { cap: PROFILE_FIELD_CAPS.communicationStyle },
  },
  lists: { recentTopics: { cap: PROFILE_FIELD_CAPS.topics, itemCap: PROFILE_FIELD_CAPS.topic, idPrefix: 'T' } },
};
const EMPTY_PROFILE: UserContextState = { summary: '', preferences: '', currentFocus: '', recentTopics: [], communicationStyle: '' };

async function extractUserContextNode(state: UpdateContextState): Promise<ExtractorNodeResult> {
  if (!state.userId || !state.synthesis) return {};
  // 2026-09-15 memory-wipe incident: a real user turn in a Fleet/project
  // supervisor chat is operational, never personal — no profile update, no
  // flat-fact extraction, no rejections from it.
  if (state.supervisorChat) {
    logger.debug(`Memory: supervisor-chat turn — skipping personal fact extraction for ${state.userId}`);
    return {};
  }

  // 2026-10-20 profile parse_error bursts (memory/profile-guard.ts): the profile is per USER but this
  // node runs on every fresh chat's first turns — 23 chats at once re-ran the same re-emission 23
  // times. One profile call per user in flight + a cooldown (a backoff after a failure); an explicit
  // rejection runs at once; a throttled turn still extracts its flat facts.
  const claim = claimProfileExtraction(state.userId, { bypass: state.explicitRejection === true });
  if (!claim.run) {
    logger.debug(`Memory: profile extraction for ${state.userId} throttled (retry in ${Math.round(claim.retryInMs / 1000)} s) — flat facts only this turn`);
    const factsOnly = await extractAndSaveFlatFacts(state.userId, state.userMessage, state.synthesis, 'turn', state.chatId, isUngroundedAnswer(state.answerGrounding));
    return { memoryExtractOutcome: factsOnly === 'changed' ? 'changed' : (factsOnly === null || factsOnly === 'llm_error' ? 'llm_error' : 'noop') };
  }
  let settled = false;
  const settle = (outcome: MemoryExtractionOutcome) => { if (!settled) { settled = true; settleProfileExtraction(state.userId!, outcome); } };

  const existing = state.existingUserContextState;
  // The model only echoes what it is SHOWN: under the caps it sees the clamped profile (a stored
  // profile that already outgrew the budget heals here) and is told each field's limit. In ops
  // mode the shown profile is always the bounded one — it is the snapshot the [ids] point into.
  const opsOn = memoryStateOpsEnabled();
  const capsOn = opsOn || profileFieldCapsEnabled();
  const shown = capsOn && existing ? clampUserContextState(existing) : null;
  const shownProfile = shown ? shown.profile : existing;
  const opsBase: UserContextState = shownProfile ?? EMPTY_PROFILE;
  const profileBlock = opsOn
    ? `Current user profile (each topic has an [id]):\n${renderStateForOps(opsBase, PROFILE_OPS_SPEC)}`
    : `Current user profile:\n${shownProfile ? JSON.stringify(shownProfile, null, 2) : '(none yet)'}`;
  const prompt = `You are analyzing a conversation to maintain a user profile for an AI assistant.

${profileBlock}

Current existing facts:
${Object.entries(state.existingUserFacts).map(([k, v]) => `${k}: ${v}`).join('\n') || '(none)'}

Latest conversation:
User: ${state.userMessage.substring(0, 600)}
${isUngroundedAnswer(state.answerGrounding) ? `${UNGROUNDED_ASSISTANT_LABEL} — summary` : 'Assistant summary'}: ${state.synthesis.substring(0, 400)}
${isUngroundedAnswer(state.answerGrounding) ? `\n${UNGROUNDED_EXTRACTION_RULE}\n` : ''}
FIRST — CHECK FOR REJECTIONS:
Read the user's message carefully. If the user denies, corrects, or complains about anything:
- "stop talking about my joints/ACL" → PURGE all references to joints, ACL, injury, rehab from EVERY field
- "I'm not plant based" → PURGE "plant based", "vegan", "vegetarian" from EVERY field
- "stop saying X" → PURGE X from summary, preferences, currentFocus, recentTopics
- "I'm fine now" about health → PURGE health conditions/concerns from EVERY field
- "I told you" / "I already said" → the user is frustrated — find and remove the offending info immediately
- Do NOT keep rejected info in any form — not even as "user doesn't like X" or "user corrected X"
- Replace with the corrected info if provided (e.g. "I only eat seafood" → update diet preference)

${opsOn ? 'To purge: "set" each affected field to its complete new text without the rejected info, and "remove" affected topics by [id].\n' : ''}THEN — UPDATE the profile with any new positive info from the conversation.
${opsOn ? 'Change only what this conversation changes. A field you "set" is replaced whole: write its COMPLETE new text (summary is ONE sentence), merging the new information into what it already says, within the limit shown beside it.' : capsOn ? boundedProfileFieldsInstruction() : 'Fields: summary (1 line), preferences, currentFocus, recentTopics (array max 5), communicationStyle'}

SCOPE — THIS IS A GLOBAL, CROSS-PROJECT PROFILE ABOUT THE PERSON:
Store ONLY durable, project-agnostic facts: who they are, their role/occupation, location, language, long-standing preferences, communication style. Do NOT store project-specific work here — NO project names, codenames, clients, initiatives, deadlines, or "currently working on project X / bid / challenge". Those belong to per-project memory, not this global profile (they would leak into unrelated projects). If the user's only current focus or topics are a specific project, leave currentFocus "" and recentTopics [].

${opsOn ? opsInstruction(PROFILE_OPS_SPEC) : `Return ONLY valid JSON matching this structure:
{
  "summary": "...",
  "preferences": "...",
  "currentFocus": "...", 
  "recentTopics": ["...", "..."],
  "communicationStyle": "..."
}`}`;

  const t0 = Date.now(); // hoisted: the catch's llm_error row measures real elapsed too (firing 13)
  // Which provider leg answered and why it stopped (finish 'length' = the budget cut it) — every
  // profile row carries it, as the fold / dream / project-brief rows have since 7555d2f6a.
  let profileMeta: { leg?: string; finishReason?: string } = {};
  const rowExtras = { budgetTokens: PROFILE_EXTRACTION_BUDGET_TOKENS, throttledSkips: claim.skippedSinceLast, clampedFields: shown?.clampedFields };
  try {
    const result = await callExtractionLLM(prompt, PROFILE_EXTRACTION_BUDGET_TOKENS, { onMeta: (m) => { profileMeta = { leg: m.leg, finishReason: m.finishReason }; } }); // firing 91: 900→1800 (20.3 % parse_error, tail cut mid-string)
    let parsedProfile: UserContextState | null = null;
    let salvaged = false;
    let opsDetail: string | undefined;
    if (opsOn) {
      // Per-item ops: the answer names only what changed; applied to the SAME bounded snapshot the
      // prompt rendered (the [ids] point into it). A truncated answer keeps its complete op groups;
      // a whole-object answer (legacyShape) is still honoured, clamped.
      const parsed = parseStateOps(result, PROFILE_OPS_SPEC);
      if (parsed) {
        const applied = applyStateOps(opsBase, parsed.ops, PROFILE_OPS_SPEC);
        parsedProfile = applied.state;
        salvaged = parsed.salvaged;
        opsDetail = describeOps(parsed, applied);
      }
    } else {
      parsedProfile = parseModelJson<UserContextState>(result);
      // f171 salvage arm (memory_parse_error_4h ESCALATE, profile leg 71.2 % parse share,
      // 99/139 in 4h — every tail the SAME over-long profile cut mid-string at the 1800
      // budget; the firing-91 bump was the same class at 900): when the re-emitted profile
      // no longer fits the budget, parseModelJson has no closing brace to find. Salvage
      // keeps every COMPLETE top-level field and merges them over the existing profile, so
      // the one truncated field keeps its existing value — bounded loss instead of a fully
      // wasted call every turn for that user. The metric keeps visibility via the detail
      // marker (outcome 'changed', detail 'salvage:truncation').
      if (!parsedProfile && String(result ?? '').trim()) {
        const salv = salvageTruncatedJson<Partial<UserContextState>>(result);
        if (salv && typeof salv === 'object') {
          const base: UserContextState = existing ?? { summary: '', preferences: '', currentFocus: '', recentTopics: [], communicationStyle: '' };
          parsedProfile = {
            summary: typeof salv.summary === 'string' ? salv.summary : base.summary,
            preferences: typeof salv.preferences === 'string' ? salv.preferences : base.preferences,
            currentFocus: typeof salv.currentFocus === 'string' ? salv.currentFocus : base.currentFocus,
            recentTopics: Array.isArray(salv.recentTopics) ? salv.recentTopics.filter((t): t is string => typeof t === 'string') : base.recentTopics,
            communicationStyle: typeof salv.communicationStyle === 'string' ? salv.communicationStyle : base.communicationStyle,
          };
          salvaged = true;
        }
      }
    }
    // ops mode: an answer that moves nothing is a 'noop', not a 'changed' (the parse succeeded either way).
    const profileOutcome: MemoryExtractionOutcome = parsedProfile
      ? (opsOn && !stateContentChanged(existing ?? null, parsedProfile, []) ? 'noop' : 'changed')
      : (String(result ?? '').trim() ? 'parse_error' : 'empty');
    settle(profileOutcome);
    recordExtractionOutcome({ userId: state.userId, source: 'profile', chatId: state.chatId, outcome: profileOutcome, ms: Date.now() - t0, ...rowExtras, ...profileMeta, ...(parsedProfile ? (opsDetail ? { detail: opsDetail } : salvaged ? { detail: 'salvage:truncation' } : {}) : { detail: extractionDetail(result) }) });
    let updated = parsedProfile ?? (existing || {
      summary: '', preferences: '', currentFocus: '', recentTopics: [], communicationStyle: '',
    });
    // Hard guard: a chat INSIDE a project must NEVER overwrite the global, cross-project
    // currentFocus/recentTopics with that project's content. That is exactly how one project's
    // work (e.g. "IDEaS Challenge 13 / DGX B300") leaked into unrelated projects. Project specifics
    // live in the project-scoped state (extractProjectStateNode), not this global profile.
    if (state.projectId) {
      updated.currentFocus = existing?.currentFocus || '';
      updated.recentTopics = existing?.recentTopics || [];
    }
    // What is saved is bounded too (a model that ignored the limits, or a failed call re-saving an
    // oversized stored profile): the next call's echo always fits the budget. After the project
    // guard, which restores the stored focus / topics.
    if (capsOn) updated = clampUserContextState(updated).profile;
    // E5 honest label: did the PROFILE's content actually move? (a re-save of
    // the same profile is not a change) — combined with the flat-facts apply
    // outcome below: the user_fact question is "a durable fact worth
    // remembering", which either store persisting something answers.
    const profileChanged = !!parsedProfile && stateContentChanged(existing ?? null, updated, []);
    await saveUserContextState(state.userId, updated);
    logger.info(`Memory: updated user context state for ${state.userId}`);

    // ALSO extract flat key-value facts for the Prisma userMemory table.
    // This replaces the old contextService.extractAndSaveMemory() which was removed
    // from the controller to eliminate duplicate LLM calls and race conditions.
    // The structured state above is stored in PostgresStore; the flat facts below
    // are stored in Prisma userMemory (used by getUserMemoryBlock for [User Memory] blocks).
    const factsOutcome = await extractAndSaveFlatFacts(state.userId, state.userMessage, state.synthesis, 'turn', state.chatId, isUngroundedAnswer(state.answerGrounding));
    if (profileChanged || factsOutcome === 'changed') return { memoryExtractOutcome: 'changed' };
    if (!parsedProfile) return { memoryExtractOutcome: String(result ?? '').trim() ? 'parse_error' : 'empty' };
    if (factsOutcome === null || factsOutcome === 'llm_error') return { memoryExtractOutcome: 'llm_error' };
    return { memoryExtractOutcome: 'noop' };
  } catch (err: any) {
    settle('llm_error'); // no-op when the profile call already settled (a later save / flat-facts throw)
    recordExtractionOutcome({ userId: state.userId, source: 'profile', chatId: state.chatId, outcome: 'llm_error', ms: Date.now() - t0, budgetTokens: PROFILE_EXTRACTION_BUDGET_TOKENS, throttledSkips: rowExtras.throttledSkips, clampedFields: rowExtras.clampedFields, ...profileMeta, detail: String(err?.message ?? err) });
    logger.debug('Memory: extractUserContextNode failed (non-fatal):', err);
    return { memoryExtractOutcome: 'llm_error' };
  }
}

// Node: extract and update project context state via LLM (project chats AND
// machine runs — a coding run's accepted final lands here too, see
// UpdateContextInput.machineRun). Newly extracted decisions are also filed
// into the unified store (storeProjectDecisionsToUnifiedMemory).
async function extractProjectStateNode(state: UpdateContextState): Promise<ExtractorNodeResult> {
  if (!state.projectId || !state.synthesis || state.skipProjectState) return {};

  const existing = state.existingProjectState;
  // A machine run's "user" message is a wake prompt — labeled so the extractor
  // never records it as a user statement; the accepted final is the rich
  // source, so it gets a wider window than a chat answer.
  const exchange = state.machineRun
    ? `Trigger: an AUTOMATED run prompt (schedule/hook wake — NOT a human statement; record nothing from it as a user decision, fact or request): ${state.userMessage.substring(0, 300)}
Accepted final report of the automated run: ${state.synthesis.substring(0, MACHINE_RUN_SYNTHESIS_WINDOW_CHARS)}

For this automated run, record as decisions ONLY what the report shows was actually done, chosen or verified with concrete evidence (files, commands, results) — never plans, intentions or unverified claims.`
    : (isUngroundedAnswer(state.answerGrounding)
      // audit 2026-10-08 W4-2: an answer no tool result backed is labelled — decisions come from the USER only.
      ? `User: ${state.userMessage.substring(0, 400)}
${UNGROUNDED_ASSISTANT_LABEL}: ${state.synthesis.substring(0, 600)}

${UNGROUNDED_EXTRACTION_RULE}`
      : `User: ${state.userMessage.substring(0, 400)}
Assistant response: ${state.synthesis.substring(0, 600)}`);
  const existingCompact = existing ? JSON.stringify(existing) : '';
  // The model only ever echoes what it is SHOWN: when the state exceeds the
  // embed cap, the compact form is sliced and the model is TOLD it is partial
  // (so it does not hallucinate the cut items back), and the budget keys on
  // the shown length, not the stored length.
  const shownChars = Math.min(existingCompact.length, PROJECT_STATE_EMBED_MAX_CHARS);
  const stateBlock = !existing
    ? '(none yet — this is the first chat)'
    : (existingCompact.length <= PROJECT_STATE_EMBED_MAX_CHARS
        ? JSON.stringify(existing, null, 2)
        : `${existingCompact.slice(0, PROJECT_STATE_EMBED_MAX_CHARS)}\n(state truncated to fit — keep the shown items; do NOT re-add cut ones)`);
  const opsOn = memoryStateOpsEnabled();
  // ops mode: the stored state is bounded to the spec first — it is the snapshot the [ids] point into.
  const opsBase: ProjectContextState = opsOn ? applyStateOps(existing ?? EMPTY_PROJECT_STATE(), {}, PROJECT_OPS_SPEC).state : (existing ?? EMPTY_PROJECT_STATE());
  const prompt = opsOn ? `You are maintaining a project knowledge base for an AI assistant.

Current project state (each list item has an [id]):
${existing ? renderStateForOps(opsBase, PROJECT_OPS_SPEC) : '(none yet — this is the first chat)\n' + renderStateForOps(opsBase, PROJECT_OPS_SPEC)}

Latest conversation:
${exchange}

Update the project state for what THIS conversation establishes: add new decisions, entities and open items; "update" an item the conversation corrects; "remove" an item it resolves (an open item now done) or supersedes; "set" the summary only when the project's description itself changed. Never restate what stays the same.
Densely phrased facts — never prose paragraphs.

${opsInstruction(PROJECT_OPS_SPEC)}` : `You are maintaining a project knowledge base for an AI assistant.

Current project state:
${stateBlock}

Latest conversation:
${exchange}

Update the project state based on this conversation. Preserve all existing information that's still relevant.
Add new decisions, entities, and open items discovered in this conversation.

Return ONLY valid JSON:
{
  "summary": "one paragraph describing what this project is about",
  "recentDecisions": ["decision 1", "decision 2"],
  "entities": {
    "people": ["name/role"],
    "amounts": ["$X for Y"],
    "places": ["location"],
    "topics": ["topic"]
  },
  "openItems": ["open question or pending task"],
  "lastUpdated": "${new Date().toISOString()}"
}

Keep arrays to max 10 items each (most recent/important first). Keep the summary and EVERY array item under 180 characters — densely phrased facts, never prose paragraphs. Keep existing items unless superseded.`;

  try {
    const t0 = Date.now();
    // 2026-09-22: the FIRST hour of memory_extraction telemetry showed this
    // node's JSON (summary + 10 decisions + entities + 10 open items) cut off
    // at 768 tokens on two of two calls → parse_error → state kept as-is (a
    // silent no-update for as long as that budget stood). Budget fits the
    // largest legal answer now.
    // 2026-09-22 21:00Z: 2000 still truncated CanLaw's state 6 of 37 calls (~6.5 s
    // of output = the whole budget) — 4000 fits any 10+10-item state.
    // 2026-09-23 firing 7: 4000 was NOT enough either. The model ECHOES the
    // existing state, and the live post-f7b0d29f sample showed 10 parse_errors
    // / 59 project calls (16.9 %) with the largest stored state at 12,395 B —
    // legal 10+10 items whose ITEMS had grown into paragraphs (item LENGTH is
    // the growth vector; the array cap alone cannot bound the echo). Three
    // prongs, root cause not symptom: (1) the budget now SCALES with the state
    // it must echo (projectExtractionBudget, 4000…8000) with a matching 45 s
    // timeout; (2) every state is clamped to ≤180 chars/item ON SAVE
    // (clampProjectStateItems) so a state that large can no longer form;
    // (3) the prompt embeds at
    // most PROJECT_STATE_EMBED_MAX_CHARS and demands short items, and the
    // budget used is recorded in the metric (budgetTokens) for live audit.
    // 2026-10-20: with per-item ops the answer no longer echoes the state, so the budget is fixed.
    const budget = opsOn ? PROJECT_OPS_BUDGET_TOKENS : projectExtractionBudget(shownChars);
    let projectMeta: { leg?: string; finishReason?: string } = {};
    const result = await callExtractionLLM(prompt, budget, { timeoutMs: 45000, onMeta: (m) => { projectMeta = { leg: m.leg, finishReason: m.finishReason }; } });
    let parsedProject: ProjectContextState | null = null;
    let opsDetail: string | undefined;
    if (opsOn) {
      const parsed = parseStateOps(result, PROJECT_OPS_SPEC);
      if (parsed) {
        const applied = applyStateOps(opsBase, parsed.ops, PROJECT_OPS_SPEC);
        parsedProject = applied.state;
        opsDetail = describeOps(parsed, applied);
        if (applied.evicted.length) logger.debug(`Memory: project ${state.projectId} state ops evicted ${applied.evicted.length} oldest item(s) past the caps`);
      }
    } else {
      parsedProject = parseModelJson<ProjectContextState>(result);
    }
    recordExtractionOutcome({ userId: state.userId ?? '', source: 'project', chatId: state.chatId, outcome: parsedProject ? 'changed' : (String(result ?? '').trim() ? 'parse_error' : 'empty'), ms: Date.now() - t0, ...(opsOn ? { ...projectMeta, budgetTokens: budget } : {}), ...(parsedProject ? { budgetTokens: budget, ...(opsDetail ? { detail: opsDetail } : {}) } : { detail: extractionDetail(result) }) });
    const updated = clampProjectStateItems(parsedProject ?? (existing || {
      summary: '',
      recentDecisions: [],
      entities: { people: [], amounts: [], places: [], topics: [] },
      openItems: [],
      lastUpdated: new Date().toISOString(),
    }));
    updated.lastUpdated = new Date().toISOString();
    // audit 2026-10-08 W4-2 backstop: on an UNGROUNDED turn a NEW decision that claims a confirmation ("Cloudflare API
    // access confirmed missing") or a detail only the unverified answer stated is dropped before the save — it would
    // otherwise be filed into digby_memory as a project decision coding lanes trust.
    if (parsedProject && isUngroundedAnswer(state.answerGrounding) && Array.isArray(updated.recentDecisions)) {
      const prior = (Array.isArray(existing?.recentDecisions) ? existing!.recentDecisions : []).filter((x): x is string => typeof x === 'string');
      const grounded = [state.userMessage, existing ? JSON.stringify(existing) : ''];
      const dropped: string[] = [];
      updated.recentDecisions = updated.recentDecisions.filter((d) => {
        if (typeof d !== 'string' || prior.some((p) => isSameDecision(p, d))) return true; // carried over — not this turn's claim
        const v = dropUngroundedItem(d, state.synthesis, grounded);
        if (v.drop) dropped.push(v.why ?? 'ungrounded');
        return !v.drop;
      });
      if (dropped.length) {
        logger.info(`Memory: dropped ${dropped.length} ungrounded project decision(s) for project ${state.projectId} (audit 2026-10-08 W4-2: ${dropped.join('; ').slice(0, 200)})`);
        recordProvenance(state, 'project', { action: 'dropped_decisions', dropped: dropped.length, why: dropped.slice(0, 3) });
      }
    }
    // E5 honest label: content moved (lastUpdated is bookkeeping and always changes).
    const contentChanged = !!parsedProject && stateContentChanged(existing ?? null, updated, ['lastUpdated']);
    await saveProjectContextState(state.projectId, updated);
    logger.info(`Memory: updated project context state for project ${state.projectId}${state.machineRun ? ' [machine run]' : ''}`);
    // Newly extracted decisions → digby_memory (diff against the PRE-merge
    // state, so each decision is filed once). Best-effort, never throws.
    await storeProjectDecisionsToUnifiedMemory(state.projectId, state.userId, existing, updated, state.machineRun);
    if (!parsedProject) return { memoryExtractOutcome: String(result ?? '').trim() ? 'parse_error' : 'empty' };
    return { memoryExtractOutcome: contentChanged ? 'changed' : 'noop' };
  } catch (err: any) {
    recordExtractionOutcome({ userId: state.userId ?? '', source: 'project', chatId: state.chatId, outcome: 'llm_error', ms: 0, detail: String(err?.message ?? err) });
    logger.debug('Memory: extractProjectStateNode failed (non-fatal):', err);
    return { memoryExtractOutcome: 'llm_error' };
  }
}

/**
 * Node: extract and update conversation thread state.
 *
 * This is the key fix for long-conversation context degradation.
 * After each synthesis, Kimi builds a rolling structured summary of the
 * entire conversation. The next query loads this summary and uses it
 * alongside only the most recent 4 raw messages instead of 12.
 *
 * Runs after extractProjectStateNode (fire-and-forget, non-blocking).
 */
/**
 * 2026-10-20 memory wave — thread state as PER-ITEM OPS (memory/state-ops.ts): the summary is a
 * bounded `set`, facts are map entries (`put` / `update` / `remove` by id), open topics a list.
 * The answer no longer re-emits the whole thread state.
 */
export const THREAD_OPS_SPEC: OpsSpec = {
  text: { threadSummary: { cap: 900 }, lastUserGoal: { cap: 200 } },
  lists: { openTopics: { cap: 5, itemCap: 160, idPrefix: 'Q' } },
  maps: { confirmedFacts: { cap: 10, keyCap: 60, valueCap: 180, idPrefix: 'F' } },
};

async function extractThreadStateNode(state: UpdateContextState): Promise<ExtractorNodeResult> {
  if (!state.chatId || !state.synthesis) return {};

  const existing = state.existingThreadState;
  const messageCount = (existing?.messageCount || 0) + 2; // +2 for this user+assistant pair

  // For very early conversations (first 2 turns), save a minimal state
  // without paying for LLM extraction — not enough content yet.
  if (messageCount <= 4) {
    const minimal: ConversationThreadState = {
      threadSummary: `Conversation started about: ${state.userMessage.substring(0, 100)}`,
      confirmedFacts: {},
      openTopics: [],
      lastUserGoal: state.userMessage.substring(0, 200),
      messageCount,
      lastUpdated: new Date().toISOString(),
    };
    await saveThreadState(state.chatId, minimal);
    return {};
  }

  const opsOn = memoryStateOpsEnabled();
  const emptyThread: ConversationThreadState = { threadSummary: '', confirmedFacts: {}, openTopics: [], lastUserGoal: '', messageCount, lastUpdated: new Date().toISOString() };
  // ops mode: the [ids] point into the stored state bounded to the spec.
  const opsBase: ConversationThreadState = applyStateOps(existing ?? emptyThread, {}, THREAD_OPS_SPEC).state;
  const prompt = `You are maintaining a conversation thread summary for an AI memory system.

${opsOn
    ? `Previous thread state (each fact and open topic has an [id]):\n${renderStateForOps(opsBase, THREAD_OPS_SPEC)}`
    : `Previous thread state:\n${existing ? JSON.stringify(existing, null, 2) : '(none — first extraction)'}`}

New exchange (turn ${Math.floor(messageCount / 2)}):
User: ${state.userMessage.substring(0, 600)}
${isUngroundedAnswer(state.answerGrounding) ? UNGROUNDED_ASSISTANT_LABEL : 'Assistant'}: ${state.synthesis.substring(0, 600)}
${isUngroundedAnswer(state.answerGrounding) ? `\n${UNGROUNDED_EXTRACTION_RULE} confirmedFacts holds only what the USER stated or an earlier verified state already held.\n` : ''}
FIRST — CHECK FOR REJECTIONS:
If the user denies, corrects, or complains about anything in this exchange:
- REMOVE the rejected topic/fact from confirmedFacts immediately
- REMOVE it from threadSummary and openTopics too
- Do NOT keep it in any form (not "user rejected X" — just delete it)
- If the user provides a correction, add the corrected version instead
Examples: "stop talking about my joints" → remove all joint/ACL/injury facts; "I'm not plant based, I eat seafood" → remove plant-based, add seafood diet

THEN update the thread state to reflect the full conversation arc including this new exchange.
${opsOn ? `
${opsInstruction(THREAD_OPS_SPEC)}

Rules:
- Rejected facts / topics: "remove" them by [id], and "set" threadSummary without them
- threadSummary: when this exchange adds to the arc, "set" the COMPLETE updated 2-3 sentence narrative of the ENTIRE conversation (not just this exchange)
- confirmedFacts: "put" newly established facts, "update" a corrected one, "remove" a wrong one — at most 10
- openTopics: "add" new unresolved questions, "remove" resolved ones — at most 5
- lastUserGoal: "set" it when the user's current intent changed
- User rejections/corrections are HIGHEST priority — always process them first before updating other fields
${THREAD_SUMMARY_GROUNDING_RULES}` : `
Return ONLY valid JSON:
{
  "threadSummary": "2-3 sentence narrative of what this ENTIRE conversation has been about so far",
  "confirmedFacts": {
    "key established fact": "value or details"
  },
  "openTopics": ["question or topic not yet fully resolved"],
  "lastUserGoal": "what the user is currently trying to accomplish in this conversation",
  "messageCount": ${messageCount},
  "lastUpdated": "${new Date().toISOString()}"
}

Rules:
- threadSummary must cover the ENTIRE conversation arc, not just the latest exchange
- confirmedFacts: max 10 most important facts established (merge old + new, no duplicates)
- openTopics: max 5 unresolved questions or ongoing threads
- lastUserGoal: most recent user intent (update each turn)
- User rejections/corrections are HIGHEST priority — always process them first before updating other fields
${THREAD_SUMMARY_GROUNDING_RULES}`}`;

  const t0 = Date.now(); // hoisted: the catch's llm_error row measures real elapsed too (firing 13)
  try {
    let threadMeta: { leg?: string; finishReason?: string } = {};
    const result = await callExtractionLLM(prompt, 2000, { onMeta: (m) => { threadMeta = { leg: m.leg, finishReason: m.finishReason }; } }); // 2026-09-22: same truncation class as the project node — 10 facts + 5 topics + summary need more than 600
    let parsedThread: ConversationThreadState | null = null;
    let opsDetail: string | undefined;
    if (opsOn) {
      const parsed = parseStateOps(result, THREAD_OPS_SPEC);
      if (parsed) {
        const applied = applyStateOps(opsBase, parsed.ops, THREAD_OPS_SPEC);
        parsedThread = applied.state;
        opsDetail = describeOps(parsed, applied);
      }
    } else {
      parsedThread = parseModelJson<ConversationThreadState>(result);
    }
    recordExtractionOutcome({ userId: state.userId ?? '', source: 'thread', chatId: state.chatId, outcome: parsedThread ? 'changed' : (String(result ?? '').trim() ? 'parse_error' : 'empty'), ms: Date.now() - t0, budgetTokens: 2000, ...(opsOn ? threadMeta : {}), ...(parsedThread ? (opsDetail ? { detail: opsDetail } : {}) : { detail: extractionDetail(result) }) });
    const updated = parsedThread ?? (existing || {
      threadSummary: '',
      confirmedFacts: {},
      openTopics: [],
      lastUserGoal: state.userMessage.substring(0, 200),
      messageCount,
      lastUpdated: new Date().toISOString(),
    });
    // Provenance guard (ticket 65aa3682): the extraction above saw only text —
    // no tool receipts — so it can confabulate operational specifics (the
    // 2026-09-17 "Progress Recap (00:13:34Z)" / curl /v1/credits → "$12.40"
    // fabrication on the Fleet Supervisor chat). Strip sentences carrying
    // high-specificity tokens (URLs, $amounts, paths, commands) that appear in
    // NONE of the extraction inputs before the summary is persisted; an
    // emptied summary falls back to the prior one rather than saving a blank.
    const grounding = guardThreadSummaryGrounding(updated.threadSummary, [
      existing ? JSON.stringify(existing) : '',
      state.userMessage,
      state.synthesis,
    ]);
    if (grounding.strippedHeadings.length || grounding.strippedSentences.length) {
      logger.warn(
        `Memory: thread-summary grounding guard stripped ${grounding.strippedHeadings.length} heading(s) + ` +
        `${grounding.strippedSentences.length} ungrounded sentence(s) for chat ${state.chatId} (ticket 65aa3682): ` +
        [...grounding.strippedHeadings, ...grounding.strippedSentences].map((s) => s.slice(0, 100)).join(' | ').slice(0, 600)
      );
      updated.threadSummary = grounding.text || (existing?.threadSummary ?? '');
    }
    // audit 2026-10-08 W4-2 backstop: on an UNGROUNDED turn a NEW confirmedFacts entry carrying a confirmation claim
    // or a detail only the unverified answer stated is dropped (the field's name is the claim — it must have a source).
    if (parsedThread && isUngroundedAnswer(state.answerGrounding) && updated.confirmedFacts && typeof updated.confirmedFacts === 'object') {
      const before = (existing?.confirmedFacts && typeof existing.confirmedFacts === 'object') ? existing.confirmedFacts : {};
      const grounded = [state.userMessage, existing ? JSON.stringify(existing) : ''];
      const dropped: string[] = [];
      for (const [k, v] of Object.entries(updated.confirmedFacts)) {
        if (Object.prototype.hasOwnProperty.call(before, k) && String((before as Record<string, unknown>)[k]) === String(v)) continue; // carried over
        const verdict = dropUngroundedItem(`${k}: ${v}`, state.synthesis, grounded);
        if (verdict.drop) { delete (updated.confirmedFacts as Record<string, unknown>)[k]; dropped.push(verdict.why ?? 'ungrounded'); }
      }
      if (dropped.length) recordProvenance(state, 'thread', { action: 'dropped_confirmed_facts', dropped: dropped.length, why: dropped.slice(0, 3) });
    }
    // Always override these to ensure correctness
    updated.messageCount = messageCount;
    updated.lastUpdated = new Date().toISOString();
    // E5 honest label: content moved (messageCount / lastUpdated are bookkeeping).
    const contentChanged = !!parsedThread && stateContentChanged(existing ?? null, updated, ['messageCount', 'lastUpdated']);
    await saveThreadState(state.chatId, updated);
    logger.info(
      `Memory: updated thread state for chat ${state.chatId} ` +
      `(turn ${Math.floor(messageCount / 2)}, ${Object.keys(updated.confirmedFacts).length} facts)`
    );
    if (!parsedThread) return { memoryExtractOutcome: String(result ?? '').trim() ? 'parse_error' : 'empty' };
    return { memoryExtractOutcome: contentChanged ? 'changed' : 'noop' };
  } catch (err: any) {
    recordExtractionOutcome({ userId: state.userId ?? '', source: 'thread', chatId: state.chatId, outcome: 'llm_error', ms: Date.now() - t0, budgetTokens: 2000, detail: String(err?.message ?? err) });
    logger.debug('Memory: extractThreadStateNode failed (non-fatal):', err);
    return { memoryExtractOutcome: 'llm_error' };
  }
}

// ── Memory-extract decision gate (2026-09-24, purpose 'memory_extract') ──────

export type MemoryExtractor = 'thread' | 'user' | 'project';
const MEMORY_EXTRACTORS: readonly MemoryExtractor[] = ['user', 'project', 'thread'];
/** Question key per extractor (the vocabulary the telemetry rows carry). */
export const MEMORY_EXTRACT_QUESTION: Record<MemoryExtractor, string> = {
  user: 'user_fact',
  project: 'project_decision',
  thread: 'thread_change',
};
const MEMORY_EXTRACT_INSTRUCTIONS: Record<MemoryExtractor, string> = {
  user: 'The exchange reveals a NEW durable fact about the user (preference, role, relationship, constraint, biographical detail) worth remembering across conversations.',
  project: 'The exchange records a decision, requirement, or state change about the project that future work should know.',
  thread: 'The exchange materially changes what this conversation is about or commits to (new topic, task, or agreement) versus the previous turns.',
};
export const MEMORY_EXTRACT_GATE_DEFAULT_THRESHOLD = 0.8;
export const MEMORY_EXTRACT_GATE_TIMEOUT_MS = 3000;

export interface MemoryExtractGateInput {
  userMessage: string;
  synthesis: string;
  /** The extractors that WOULD run under today's debounce (project implies a projectId). */
  wanted: Record<MemoryExtractor, boolean>;
  /** Stamped on the telemetry rows (the chat id). */
  sessionId?: string;
}

export interface MemoryExtractGateResult {
  gate: DecideResult | null;
  mode: DecisionMode;
  /** Extractors the gate says to drop — act mode only; always all-false in shadow/off. */
  skip: Record<MemoryExtractor, boolean>;
}

const noSkips = (): Record<MemoryExtractor, boolean> => ({ thread: false, user: false, project: false });

/**
 * ONE decide() over the wanted extractors' questions (state = the latest user
 * message + assistant answer only — never the transcript). shadow → skip
 * nothing; act → skip an extractor whose noul is confidently false
 * (≤ 1 − threshold, default threshold 0.8 → noul ≤ 0.2). Never throws: any
 * failure means skip nothing (the gate can only remove work, never add risk).
 */
export async function consultMemoryExtractGate(input: MemoryExtractGateInput): Promise<MemoryExtractGateResult> {
  const result: MemoryExtractGateResult = { gate: null, mode: 'off', skip: noSkips() };
  try {
    const mode = decisionMode('memory_extract');
    result.mode = mode;
    if (mode === 'off') return result;
    const questions: Record<string, DecisionQuestion> = {};
    for (const ex of MEMORY_EXTRACTORS) {
      if (input.wanted[ex]) questions[MEMORY_EXTRACT_QUESTION[ex]] = { type: 'noul', instructions: MEMORY_EXTRACT_INSTRUCTIONS[ex] };
    }
    if (!Object.keys(questions).length) return result;
    result.gate = await decide(
      { user_message: (input.userMessage || '').slice(0, 2000), assistant_answer: (input.synthesis || '').slice(0, 3000) },
      questions,
      { purpose: 'memory_extract', timeoutMs: MEMORY_EXTRACT_GATE_TIMEOUT_MS, ...(input.sessionId ? { sessionId: input.sessionId } : {}) },
    );
    // E2 (2026-09-25): the RESULT's mode gates acting — decide() returns
    // 'shadow' for an act purpose answered by an uncalibrated backend.
    if (!result.gate || result.gate.mode !== 'act') return result;
    // + 1e-9: 1 − 0.8 is 0.19999999999999996 in floating point — a noul of
    // exactly 0.2 must still count as "confidently false" at the 0.8 default.
    const cutoff = 1 - decisionThreshold('memory_extract', MEMORY_EXTRACT_GATE_DEFAULT_THRESHOLD) + 1e-9;
    for (const ex of MEMORY_EXTRACTORS) {
      if (!input.wanted[ex]) continue;
      const a = result.gate.answers[MEMORY_EXTRACT_QUESTION[ex]];
      if (a && a.type === 'noul' && a.noul <= cutoff) result.skip[ex] = true;
    }
  } catch (err: any) {
    logger.debug(`Memory: decision gate failed open (non-fatal): ${err?.message || err}`);
    result.skip = noSkips();
  }
  return result;
}

/** The outcomes the extractors that RAN reported (E5); undefined = the legacy constant label. */
export type MemoryExtractRanOutcomes = Partial<Record<MemoryExtractor, MemoryExtractionOutcome | null>>;

/**
 * The `actual` for one extractor that ran (E5 honest labels): 'changed' ⇒ true
 * (it persisted ≥ 1 content change — the question's positive class), 'noop' ⇒
 * false, and an LLM / parse / empty failure ⇒ null (the extractor evidences
 * nothing about the question). Pure.
 */
export function memoryExtractActual(outcome: MemoryExtractionOutcome | null | undefined): { actual: boolean | null; note: string } {
  if (outcome === 'changed') return { actual: true, note: 'ran: changed' };
  if (outcome === 'noop') return { actual: false, note: 'ran: noop' };
  if (outcome === 'llm_error' || outcome === 'parse_error' || outcome === 'empty') return { actual: null, note: `ran: ${outcome} — outcome unknown` };
  return { actual: null, note: 'ran: outcome unknown' };
}

/**
 * One outcome row per asked question: a skipped extractor is `acted:true`
 * (actual null — the pre-gate path did not run); one that ran is `acted:false`
 * with the HARNESS-MEASURED actual from `ran` (E5, 2026-09-25: changed ⇒ true,
 * noop ⇒ false, failure ⇒ null) — or, when `ran` is not given, the legacy
 * constant actual:true + note 'ran'. Fire-and-forget.
 */
export function recordMemoryExtractOutcomes(gated: MemoryExtractGateResult, wanted: Record<MemoryExtractor, boolean>, sessionId?: string, ran?: MemoryExtractRanOutcomes): void {
  if (!gated.gate) return;
  const honest = !!ran;
  for (const ex of MEMORY_EXTRACTORS) {
    if (!wanted[ex]) continue;
    const question = MEMORY_EXTRACT_QUESTION[ex];
    if (gated.skip[ex]) recordDecisionOutcome(gated.gate, 'memory_extract', { question, actual: null, acted: true, sessionId });
    else if (honest) {
      const { actual, note } = memoryExtractActual(ran?.[ex]);
      recordDecisionOutcome(gated.gate, 'memory_extract', { question, actual, acted: false, sessionId, note });
    } else recordDecisionOutcome(gated.gate, 'memory_extract', { question, actual: true, acted: false, sessionId, note: 'ran' });
  }
}

/**
 * THREAD_STATE_DEBOUNCE_FIX (2026-10-22, fs-durable-memory). The debounce
 * below reads the turn number from the STORED thread messageCount (+2), and
 * only a thread-extraction save ever advanced that count. Once a chat stored
 * 12 (turn 6 — the last save inside the every-turn bootstrap window), every
 * later turn computed messageCount 14 → turn 7 (odd) → skipped → saved
 * nothing → computed 14 again: the thread summary froze for every chat past
 * its 6th substantive turn (only an explicit-rejection message moved it two
 * steps, after which it froze again), and the full user/project extraction —
 * keyed on the same count (14 % 6 ≠ 0) — froze with it. The stale summary was
 * still injected as "6 exchanges so far".
 *
 * Fix: a turn that reaches the debounce (not a machine run, not a < 30-char
 * non-rejection message) and does not run a saving thread extraction —
 * skipped by the every-other-turn debounce or by the memory_extract decision
 * gate — persists the advanced count (bookkeeping only: ONE atomic, upward-only
 * update of messageCount — advanceThreadCounter — so summary, facts, topics and
 * lastUpdated are never rewritten, not even from this turn's stale snapshot).
 * The designed cadence returns: thread every 2nd substantive turn past turn 5,
 * full extraction every 3rd (≤ turn 10) / 6th turn — each still through the
 * memory_extract decision gate below (messageCount > 6 is always true here, so
 * every restored extractor is asked; act mode can still drop it). A thread extraction that FAILED saves nothing, exactly as before, so
 * it is retried on the next turn. Short messages never count: a long/short
 * alternation must not pin the long turns to the skip parity.
 * Kill switch THREAD_STATE_DEBOUNCE_FIX_DISABLED=1 restores the frozen counter.
 */
export function threadStateDebounceFixDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.THREAD_STATE_DEBOUNCE_FIX_DISABLED === '1';
}
/** Does this turn owe a bookkeeping save of the advanced thread count? (`ran` = a saving thread extraction runs this turn.) Pure. */
export function threadCounterBookkeepingDue(input: { ran: boolean; hasState: boolean }, env: NodeJS.ProcessEnv = process.env): boolean {
  return !input.ran && input.hasState && !threadStateDebounceFixDisabled(env);
}

/**
 * Node: run all extraction tasks in PARALLEL via Promise.allSettled.
 * Each extraction is independent (different LLM calls, different DB writes),
 * so parallelizing cuts wall-clock time from ~3× to ~1× the single-call latency.
 * All are fire-and-forget and non-fatal — failures are logged, never thrown.
 *
 * Debouncing (Apr 24, 2026 — updated):
 *   All 3 extractions use Cohere Command-A calls adding background load.
 *   For active users these ran after EVERY synthesis.
 *
 *   Thread state: ALWAYS runs — it's critical for conversation continuity.
 *     Uses a single Cohere call (~200ms) to maintain a rolling summary.
 *
 *   User context + project state: debounced to reduce API load.
 *     - Short convos (≤ turn 10): run every 3rd turn
 *     - Long convos (> turn 10): run every 6th turn
 *     - Explicit rejections: always run immediately
 *     - Early turns (≤ messageCount 6): always run for bootstrapping
 */
async function extractAllParallelNode(state: UpdateContextState) {
  // Machine runs (coding finals / scheduled wakes): PROJECT-state extraction
  // ONLY — no user facts, no thread state (the "user" message is a machine
  // prompt and must never enter user memory), no debounce (each accepted final
  // is a distinct source), no short-message skip (the wake prompt's length says
  // nothing about the final's value).
  if (state.machineRun) {
    if (!state.projectId || state.skipProjectState) {
      logger.debug('Memory: machine run outside a project (or a plain user-space chat) — nothing to extract (user/thread extraction is skipped for machine runs)');
      return {};
    }
    const finalLen = (state.synthesis || '').trim().length;
    if (finalLen < MACHINE_RUN_MIN_SYNTHESIS_CHARS) {
      logger.debug(`Memory: machine run final too short (${finalLen} chars) — skipping project extraction`);
      return {};
    }
    await extractProjectStateNode(state);
    return {};
  }

  const messageCount = (state.existingThreadState?.messageCount || 0) + 2;
  const turnNumber = Math.floor(messageCount / 2);

  const lastUserMsg = state.userMessage || '';

  // Normalize curly/smart apostrophes and quotes to straight ASCII equivalents
  // before running the rejection regex. Users typing on iOS/macOS often produce
  // curly apostrophes (I\u2019m, don\u2019t) which don't match the straight apostrophe
  // in the regex patterns (i'm, don't). This was causing "I\u2019m fine now" to slip
  // through the rejection check entirely because the regex used straight apostrophes.
  const normalizedMsg = lastUserMsg
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")   // curly single quotes → straight
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"');   // curly double quotes → straight

  // Detect explicit user rejections/corrections FIRST — these MUST bypass ALL skips
  // and debouncing. Incorrect facts must be removed from memory immediately.
  // Fix for: "I told you many times to stop talking about my joint health and I'm not plant based"
  // Fix for: "I'm fine now" (short message that IS a rejection — must not be skipped by length check)
  // Fix for: curly apostrophe "I\u2019m fine now" not matching straight apostrophe in regex (Unicode normalization)
  const isExplicitRejection = /\b(stop talking about|stop mentioning|stop bringing up|stop referencing|stop saying|stop asking|i told you|i'm not|i am not|i don't|i do not|i never said|that's not me|that's wrong|that's not right|that's incorrect|i already told you|how many times|quit bringing up|don't assume|not plant.?based|not vegan|not vegetarian|that isn't relevant|not relevant anymore|outdated|that's old|stop it|enough about|drop it|forget about|remove that|delete that|wrong about me|you keep saying|you keep asking|i'm fine now|no longer|not anymore|that was before|used to but|i used to|not true anymore|please stop|quit it|cut it out|don't bring up|never bring up|my .+ (?:is|are) fine|don't mention|quit mentioning)\b/i.test(normalizedMsg);
  if (isExplicitRejection) {
    logger.info(`Memory: explicit user rejection detected — forcing full extraction to update memory: "${lastUserMsg.substring(0, 80)}"`);
  }

  // Short message skip: skip extraction for trivial messages like "ok", "thanks", "yes".
  // BUT: never skip if it's an explicit rejection (even short ones like "I'm fine now").
  if (!isExplicitRejection && lastUserMsg.length < 30) {
    logger.debug(`Memory: skipping extraction — message too short (${lastUserMsg.length} chars): "${lastUserMsg.substring(0, 40)}"`);
    return {};
  }

  // Adaptive debouncing (updated Apr 24, 2026):
  // Thread state ALWAYS runs — it's critical for conversation continuity and cheap to update.
  // User context + project state are debounced to reduce background Cohere API calls.
  //
  // Short conversations (≤ turn 10):
  //   Thread state: ALWAYS (no debounce)
  //   Full extraction: every 3rd turn (messageCount % 6 === 0)
  //
  // Long conversations (> turn 10):
  //   Thread state: ALWAYS (no debounce)
  //   Full extraction: every 6th turn (messageCount % 12 === 0)
  //
  // Early turns (≤ messageCount 6) always run full extraction for bootstrapping.
  // Explicit rejections ALWAYS bypass all debounce — incorrect facts must be removed immediately.
  const isLongConversation = messageCount > 20;
  const fullDebounce   = isLongConversation ? 12 : 6;

  // Thread state debounce.
  // 2026-06-11: For long conversations (> 20 messages), debounce to every 2nd turn.
  // 2026-06-24: Extended the every-2nd-turn debounce to ALL conversations past the
  // bootstrapping window. Thread summaries change little turn-to-turn once context
  // is established, and the utility model (DeepSeek V4 Flash) is a reasoning model —
  // each extraction costs 5-15s and real tokens. The early window (≤ 10 messages /
  // ≤ 5 turns) still runs EVERY turn so continuity is locked in before debouncing;
  // explicit rejections always run so wrong facts are removed immediately. This roughly
  // halves background extraction load for medium-length sessions (turns 6-10) without
  // hurting continuity, since loadConversation still passes recent raw history through.
  // Review 2026-10-23: a chat BORN a coding session never reads its thread
  // summary (only the chat agent's getEnrichedContext does) — its thread LLM
  // call is skipped, its counter still advances below (see skipThreadState).
  const skipThread = state.skipThreadState === true && !threadStateDebounceFixDisabled();
  const runThreadExtraction = !skipThread && (isExplicitRejection || messageCount <= 10 || (turnNumber % 2 === 0));

  // Full extraction: user context + project state — debounced — or on rejection
  const runFullExtraction = isExplicitRejection || (messageCount % fullDebounce === 0) || messageCount <= 6;

  const tasks: Promise<any>[] = [];

  // Decision gate (2026-09-24, purpose 'memory_extract'): outside the
  // bootstrap window (messageCount > 6) and never on a rejection, ONE typed
  // judgment per extractor that WOULD run under the debounce above. shadow =
  // ask + record, run everything as before; act = drop an extractor whose
  // question is confidently false. Fails open — consultMemoryExtractGate
  // never throws and skips nothing on any failure.
  const wanted: Record<MemoryExtractor, boolean> = {
    thread: runThreadExtraction,
    user: runFullExtraction,
    project: runFullExtraction && !!state.projectId && !state.skipProjectState,
  };
  let gated: MemoryExtractGateResult = { gate: null, mode: 'off', skip: noSkips() };
  if (!isExplicitRejection && messageCount > 6 && (wanted.thread || wanted.user || wanted.project)) {
    gated = await consultMemoryExtractGate({ userMessage: lastUserMsg, synthesis: state.synthesis || '', wanted, sessionId: state.chatId ?? undefined });
    const skipped = MEMORY_EXTRACTORS.filter(ex => gated.skip[ex]);
    if (skipped.length) {
      logger.debug(`Memory: decision gate skipped ${skipped.join(' + ')} extraction (turn ${turnNumber}: confidently nothing durable to extract)`);
    }
  }
  // E5 (2026-09-25): the outcome rows are written AFTER the extractors settle
  // so each one carries what its extractor measurably did (changed / noop /
  // failure) instead of the constant 'ran'.
  const ranBy: Partial<Record<MemoryExtractor, Promise<ExtractorNodeResult>>> = {};

  if (runThreadExtraction) {
    if (!gated.skip.thread) { const p = extractThreadStateNode(state); ranBy.thread = p; tasks.push(p); }
  } else {
    logger.debug(`Memory: skipping thread extraction (turn ${turnNumber})`);
  }
  // THREAD_STATE_DEBOUNCE_FIX (2026-10-22): a turn the thread extractor does
  // not save still advances the stored counter — see threadStateDebounceFixDisabled.
  // Only the counter is written (atomically, upward) — never the snapshot loaded at the start of
  // the turn, which an overlapping extraction may have superseded meanwhile (review 2026-10-22).
  if (threadCounterBookkeepingDue({ ran: runThreadExtraction && !gated.skip.thread, hasState: !!state.existingThreadState }) && state.chatId) {
    tasks.push(advanceThreadCounter(state.chatId, messageCount));
  } else if (skipThread && !state.existingThreadState && state.chatId) {
    // A born-coding session that never had a thread row: a COUNTER-ONLY row
    // (empty summary — buildContextBlocks injects nothing for it), so the next
    // turn counts on and the user / project cadence leaves the bootstrap window
    // (with no row every turn read as turn 1 and ran the full extraction).
    tasks.push(saveThreadState(state.chatId, { threadSummary: '', confirmedFacts: {}, openTopics: [], lastUserGoal: '', messageCount, lastUpdated: new Date().toISOString() }));
  }

  if (runFullExtraction) {
    logger.debug(`Memory: running full extraction (turn ${turnNumber})`);
    if (!gated.skip.user) { const p = extractUserContextNode({ ...state, explicitRejection: isExplicitRejection }); ranBy.user = p; tasks.push(p); }
    if (wanted.project && !gated.skip.project) { const p = extractProjectStateNode(state); ranBy.project = p; tasks.push(p); }
  } else {
    logger.debug(
      `Memory: skipping user/project LLM extraction (turn ${turnNumber}, ` +
      `next full at turn ${Math.floor((messageCount + (6 - (messageCount % 6))) / 2)})`
    );
  }

  if (tasks.length > 0) {
    await Promise.allSettled(tasks);
  }
  if (gated.gate) {
    const ran: MemoryExtractRanOutcomes = {};
    for (const ex of MEMORY_EXTRACTORS) {
      const p = ranBy[ex];
      if (!p) continue;
      // Settled above — a rejected node (they never throw, but stay honest) reads as unknown.
      ran[ex] = await p.then((r) => r?.memoryExtractOutcome ?? null, () => null);
    }
    recordMemoryExtractOutcomes(gated, wanted, state.chatId ?? undefined, ran);
  }
  return {};
}

// Run the update-context pipeline:
// loadExisting → extractAllParallel (user + project + thread in parallel)
// All run fire-and-forget (non-blocking for the user response).
// Exported for tests (updateContextAsync is the fire-and-forget public entry).
export async function runUpdateContextPipeline(input: UpdateContextInput): Promise<void> {
  const machineRun = input.machineRun === true;
  // Cerebras-style distill-on-write: normalize the finished exchange into a
  // searchable record and embed it into the UNIFIED memory store (scope user,
  // ref chatId) — this is what makes hybrid episodic recall work. Fire-and-
  // forget alongside the classic extraction pipeline. Machine runs skip it:
  // the record's "question" would be distilled from a wake prompt and land in
  // the USER scope — exactly the pollution machineRun exists to prevent.
  if (!machineRun) {
    void distillConversationToUnifiedMemory(input).catch(err => {
      recordExtractionOutcome({ userId: input.userId ?? '', source: 'distill', chatId: input.chatId, outcome: 'llm_error', ms: 0, detail: String(err?.message ?? err) });
      logger.debug(`Memory: conversation distill failed (non-fatal): ${err.message}`);
    });
  }
  let state: UpdateContextState = {
    userId: input.userId,
    projectId: input.projectId,
    chatId: input.chatId,
    userMessage: input.userMessage,
    synthesis: input.synthesis,
    machineRun,
    supervisorChat: input.supervisorChat === true,
    skipProjectState: input.skipProjectState === true,
    skipThreadState: input.skipThreadState === true,
    answerGrounding: input.answerGrounding ?? null,
    existingUserFacts: {},
    existingUserContextState: null,
    existingProjectState: null,
    existingThreadState: null,
  };
  state = { ...state, ...(await loadExistingStateNode(state)) };
  await extractAllParallelNode(state);
}

/**
 * audit 2026-10-08 W4-2: one `memory_provenance` row per extractor decision on an UNGROUNDED turn (the answer had no
 * evidence-bearing tool result): what the extractor did with it (labelled / items dropped). Never throws.
 */
function recordProvenance(src: { chatId?: string | null; answerGrounding?: AnswerGrounding | null }, extractor: 'distill' | 'user' | 'project' | 'thread', meta: Record<string, unknown>): void {
  try {
    recordLoopMetric({
      kind: MEMORY_PROVENANCE_METRIC, sessionId: src.chatId ?? undefined,
      meta: { extractor, toolBacked: false, evidenceCalls: src.answerGrounding?.evidenceCalls ?? 0, ...meta },
    });
  } catch { /* telemetry never breaks extraction */ }
}

/**
 * Distillation before embedding (the Cerebras finding: accuracy improves
 * significantly when threads are normalized into a consistent format instead
 * of embedding raw transcripts): a one-line searchable question (title), a
 * short summary + resolution, and the systems/refs mentioned.
 */
async function distillConversationToUnifiedMemory(input: UpdateContextInput): Promise<void> {
  if (!input.userId || !input.chatId) return;               // anonymous / unsaved — nothing durable
  if ((input.synthesis || '').length < 300) return;          // trivial exchanges aren't worth a record
  // Firing 13 (2026-09-24): this node's outcome rows hardcoded ms: 0 — the
  // live audit's avg_ms column read 0 for every distill row (7 changed
  // in-window, avg_ms 0, ~seconds of real LLM time invisible) — and carried
  // no budgetTokens. The budget itself is pinned by distill-budget.pin.test.ts;
  // the rows now prove both live.
  const distillStartedAt = Date.now();
  // audit 2026-10-08 W4-2: an answer no tool result backed is recorded as what Digby SAID, never as a confirmed fact.
  const ungrounded = isUngroundedAnswer(input.answerGrounding);
  // Review 2026-10-23 (privacy): the record is a user-scope row any of the
  // user's chats — and a supervisor's search_memory, on any later wake — can
  // recall, and its refs ("systems, files, URLs, or entities mentioned")
  // copied a pasted credential verbatim. Redact before the clip (a key the
  // window cuts is matched whole) and again on the way out.
  const askText = redactInboundHead(input.userMessage, 1500).text.slice(0, 1500);
  const answerText = redactInboundHead(input.synthesis, 4000).text.slice(0, 4000);
  let raw = '';
  try {
    raw = await utilityChat([{ role: 'user', content:
      `Normalize this finished AI-chat exchange into a searchable memory record.

User asked:
${askText}

${ungrounded ? `${UNGROUNDED_ASSISTANT_LABEL}:` : 'Assistant answered:'}
${answerText}
${ungrounded ? `\nThe answer used no tool or source: summarize it as what the assistant SAID ("Digby said …"), and the resolution as what the USER established — never "confirmed" or "verified".\n` : ''}
Return ONLY valid JSON:
{"question": "<one-line question someone would actually search for>",
 "summary": "<2-4 sentence summary of the answer>",
 "resolution": "<the concrete conclusion/decision/answer, 1-2 sentences>",
 "refs": ["<systems, files, URLs, or entities mentioned>"]}` }],
      // 2026-09-22 23:05Z (FO steer run): distill ran 25 % parse_error over the 4h window
      // (3 of 12 calls) with cut-off-mid-string tails ("…\"summary\": \"PR #23 was squ")
      // — this node's 400-token budget was never raised with the fa915ba0 siblings
      // (project 768→2000→4000, thread 600→2000, profile 512→900). The record's JSON
      // (question + 2-4-sentence summary + resolution + refs[]) needs ~900 for dense
      // exchanges (the answer window alone is 4000 chars of input). A parse_error here
      // silently drops the conversation's memory record — return happens before any write.
      { maxTokens: 900, temperature: 0.2, timeout: 30000, retryNotFound: true });
  } catch (err: any) {
    recordExtractionOutcome({ userId: input.userId ?? '', source: 'distill', chatId: input.chatId, outcome: 'llm_error', ms: Date.now() - distillStartedAt, budgetTokens: 900, detail: String(err?.message ?? err) });
    return;
  }
  const rec = parseModelJson<{ question?: string; summary?: string; resolution?: string; refs?: string[] }>(raw);
  if (!rec) { recordExtractionOutcome({ userId: input.userId ?? '', source: 'distill', chatId: input.chatId, outcome: String(raw ?? '').trim() ? 'parse_error' : 'empty', ms: Date.now() - distillStartedAt, budgetTokens: 900, detail: `head=${String(raw ?? '').slice(0, 90).replace(/\s+/g, ' ')} tail=${String(raw ?? '').slice(-70).replace(/\s+/g, ' ')}` }); return; }
  if (!rec.question || !rec.summary) { recordExtractionOutcome({ userId: input.userId ?? '', source: 'distill', chatId: input.chatId, outcome: 'noop', ms: Date.now() - distillStartedAt, budgetTokens: 900 }); return; }
  recordExtractionOutcome({ userId: input.userId ?? '', source: 'distill', chatId: input.chatId, outcome: 'changed', ms: Date.now() - distillStartedAt, budgetTokens: 900 });
  const content = ungrounded
    ? [
      // audit 2026-10-08 W4-2: the record says what kind of claim it is — recall shows it as unverified.
      'Unverified — Digby\'s answer used no tool or source this turn (what it said, not an established fact).',
      neutralizeConfirmations(rec.summary),
      rec.resolution ? `Resolution (unverified — Digby said): ${neutralizeConfirmations(rec.resolution)}` : '',
      rec.refs?.length ? `Refs: ${rec.refs.slice(0, 10).join(', ')}` : '',
    ].filter(Boolean).join('\n')
    : [
      rec.summary,
      rec.resolution ? `Resolution: ${rec.resolution}` : '',
      rec.refs?.length ? `Refs: ${rec.refs.slice(0, 10).join(', ')}` : '',
    ].filter(Boolean).join('\n');
  if (ungrounded) recordProvenance(input, 'distill', { action: 'labelled_unverified', neutralized: hasConfirmationClaim(rec.summary) || hasConfirmationClaim(rec.resolution) });
  await memStore(
    { type: 'user', id: input.userId },
    'conversation',
    [{ ref: input.chatId, title: redactInboundSecrets(String(rec.question)), content: redactInboundSecrets(content) }],
    { userId: input.userId }
  );
  // Same race as saveThreadState (review 2026-10-23): deleteChat drops this
  // record BEFORE the row goes; a distill still in its LLM call would bring a
  // deleted chat back into episodic recall. Write, then check.
  if (await chatDefinitelyGone(input.chatId)) {
    try { await memReplaceRef({ type: 'user', id: input.userId }, 'conversation', input.chatId, []); } catch { /* best-effort */ }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Public API
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Get enriched context before querying models.
 * Loads conversation history (trimmed for long chats), user memory, project state,
 * and conversation thread state. Returns formatted context blocks for system prompts.
 */
export async function getEnrichedContext(input: GetContextInput): Promise<EnrichedContext> {
  try {
    const result = await runGetContextPipeline(input);

    return {
      conversationHistory: result.conversationHistory || [],
      // wasCompressed removed in v2
      userMemoryBlock: result.userMemoryBlock || '',
      projectStateBlock: result.projectStateBlock || '',
    };
  } catch (err) {
    logger.error('Memory: getEnrichedContext failed, falling back to basic context:', err);
    // Fall back to the existing context service
    if (input.userId && input.chatId) {
      const ctx = await contextService.loadChatContext(input.chatId, input.userId, input.userMessage, { deepHistory: input.deepHistory, excludeMessageId: input.excludeMessageId });
      const userBlock = await contextService.getUserMemoryBlock(input.userId, input.userMessage);
      return {
        conversationHistory: ctx.conversationHistory,
        // wasCompressed removed in v2 (compression eliminated)
        userMemoryBlock: userBlock,
        projectStateBlock: '',
      };
    }
    return { conversationHistory: [], userMemoryBlock: '', projectStateBlock: '' };
  }
}

/**
 * Update context state after synthesis (fire-and-forget).
 * Extracts and saves:
 *   - User context state (preferences, focus, style) via the utility model
 *   - Project state (decisions, entities, open items) if in a project —
 *     newly extracted decisions are ALSO filed into digby_memory (source
 *     'decision', project scope) so coding runs' search_memory sees them
 *   - Conversation thread state (rolling summary for long-convo context)
 * `machineRun: true` (coding finals / scheduled wakes) runs ONLY the project
 * step — see UpdateContextInput.machineRun.
 */
// ── Rebuild personal memory from the user's OWN conversations (2026-09-15) ────
//
// The memory-wipe incident left the owner with zero facts: bogus rejections
// (prompt-example parrots + fleet chatter) had scrubbed every real fact on
// every save. The blob keeps no history, so the honest recovery is to re-read
// the user's own past exchanges — real user turns in their own non-supervisor,
// non-coding chats — through the (now grounded) extractor, oldest first so the
// newest statement wins. Bookkeeping rides the facts blob under `__rebuild`
// (hidden from the Memory tab like `__dream`), the job runs detached behind a
// per-user Redis lock, and every read is scoped to the requesting user.

export const REBUILD_KEY = '__rebuild';
// 2026-09-22: 150 newest pairs covered one month of a 1,239-turn user — his
// personal chats (interests, family, habits) were months older. 600 pairs
// (~10 min of utility calls) over a 12k-message scan reaches them; the lock
// TTL grows to match.
export const REBUILD_MAX_EXCHANGES = 600;
const REBUILD_LOCK_TTL_S = 45 * 60;
const REBUILD_SCAN_MESSAGES = 12000;
const REBUILD_CONCURRENCY = 4; // parallel extractor proposals per batch (~8 s reasoning calls); applies stay ordered
const REBUILD_MIN_USER_CHARS = 12;
/** Text that is a harness/agent artifact even when it sits in a user role. */
const REBUILD_MACHINE_TEXT_RE = MACHINE_TEXT_RE; // shared with the coding executor (chat-agent/machine-wake)

export interface MemoryRebuildStatus {
  startedAt: string;
  finishedAt: string | null;
  total: number;
  processed: number;
  factsBefore: number;
  factsAfter: number | null;
  error?: string;
}

/** `chatId` (2026-10-20): the chat the exchange came from — recorded as the fact version's source chat. */
export interface RebuildExchange { userMessage: string; synthesis: string; at: Date; chatId?: string }

const rebuildLockKey = (userId: string) => `memory:rebuild:${userId}`;

async function readRebuildStatus(userId: string): Promise<MemoryRebuildStatus | null> {
  const row = await prisma.userMemory.findUnique({ where: { userId }, select: { facts: true } });
  const facts = (row?.facts as Record<string, any>) || {};
  const s = facts[REBUILD_KEY];
  return s && typeof s === 'object' ? (s as MemoryRebuildStatus) : null;
}

async function writeRebuildStatus(userId: string, status: MemoryRebuildStatus): Promise<void> {
  const row = await prisma.userMemory.findUnique({ where: { userId }, select: { facts: true } });
  const facts: Record<string, any> = { ...((row?.facts as Record<string, any>) || {}), [REBUILD_KEY]: { ...status } };
  await prisma.userMemory.upsert({ where: { userId }, create: { userId, facts: facts as any }, update: { facts: facts as any, updatedAt: new Date() } });
}

function countVisibleFacts(facts: Record<string, unknown>): number {
  return Object.keys(facts).filter((k) => !k.startsWith('__')).length;
}

/**
 * The user's own exchanges eligible for a rebuild: real user turns (origin
 * user/null, not harness text) followed by the next assistant answer in the
 * same chat, from the user's non-supervisor, non-coding, non-archived chats.
 * Newest `max` pairs, returned OLDEST FIRST so later statements override.
 * Exported for tests.
 */
export async function loadRebuildExchanges(userId: string, max = REBUILD_MAX_EXCHANGES): Promise<RebuildExchange[]> {
  const chats = await prisma.crossModelChat.findMany({
    // Ghost mode (owner 2026-10-22): a ghost chat is private — a later rebuild
    // must not re-mine its exchanges either (the run-time extractor skipped
    // them; the rebuild would otherwise re-learn them from the transcript).
    where: { userId, isSupervisor: false, isProjectSupervisor: false, archivedAt: null, codingState: { is: null }, ghostMode: false },
    select: { id: true },
    orderBy: { updatedAt: 'desc' },
    take: 300,
  });
  const chatIds = chats.map((c: { id: string }) => c.id);
  if (!chatIds.length) return [];
  const rows = await prisma.crossModelMessage.findMany({
    where: { chatId: { in: chatIds }, role: { in: ['user', 'assistant'] } },
    orderBy: { createdAt: 'desc' },
    take: REBUILD_SCAN_MESSAGES,
    select: { chatId: true, role: true, content: true, createdAt: true, metadata: true },
  });
  rows.reverse(); // oldest first
  const isUserTurn = (m: any) => {
    const origin = (m.metadata as any)?.origin;
    if (origin != null && origin !== 'user') return false;
    const text = String(m.content ?? '');
    return text.trim().length >= REBUILD_MIN_USER_CHARS && !REBUILD_MACHINE_TEXT_RE.test(text);
  };
  const isAnswer = (m: any) => {
    const origin = (m.metadata as any)?.origin;
    return (origin == null || origin === 'user') && String(m.content ?? '').trim().length > 0;
  };
  const pairs: RebuildExchange[] = [];
  const pendingByChat = new Map<string, any>();
  for (const m of rows) {
    if (m.role === 'user') {
      if (isUserTurn(m)) pendingByChat.set(m.chatId, m); else pendingByChat.delete(m.chatId);
      continue;
    }
    const u = pendingByChat.get(m.chatId);
    if (u && isAnswer(m)) {
      pairs.push({ userMessage: String(u.content), synthesis: String(m.content), at: m.createdAt, chatId: m.chatId });
      pendingByChat.delete(m.chatId);
    }
  }
  return pairs.slice(-Math.max(1, Math.min(max, REBUILD_MAX_EXCHANGES)));
}

/** The detached job: one extractor pass per exchange, progress every 5. Never throws. */
export async function runUserMemoryRebuild(userId: string, exchanges: RebuildExchange[], status: MemoryRebuildStatus): Promise<MemoryRebuildStatus> {
  let processed = 0;
  try {
    // Propose REBUILD_CONCURRENCY exchanges at a time (each is an ~8 s reasoning
    // call), then apply the proposals in exchange order against the live blob —
    // the read-modify-write on user_memory stays sequential, so nothing is lost.
    for (let i = 0; i < exchanges.length; i += REBUILD_CONCURRENCY) {
      const chunk = exchanges.slice(i, i + REBUILD_CONCURRENCY);
      const row = await prisma.userMemory.findUnique({ where: { userId }, select: { facts: true } }).catch(() => null);
      const snapshot = (row?.facts as Record<string, string>) || {};
      // One fact-meta read per chunk (the "(since …)" dates), shared by its proposals.
      const meta = factVersionsEnabled() ? await getFactMeta(userId) : null;
      const proposals = await Promise.all(chunk.map((ex) => proposeFlatFacts(userId, snapshot, ex.userMessage, ex.synthesis, 'rebuild', ex.chatId ?? null, false, meta)));
      for (let k = 0; k < chunk.length; k++) {
        const proposal = proposals[k];
        if (proposal) await applyFlatFactProposal(userId, proposal, chunk[k].userMessage, 'rebuild', chunk[k].chatId ?? null);
        processed += 1;
      }
      await writeRebuildStatus(userId, { ...status, processed }).catch(() => {});
    }
    const row = await prisma.userMemory.findUnique({ where: { userId }, select: { facts: true } });
    const done: MemoryRebuildStatus = { ...status, processed, finishedAt: new Date().toISOString(), factsAfter: countVisibleFacts((row?.facts as Record<string, unknown>) || {}) };
    await writeRebuildStatus(userId, done);
    void syncUserFactRows(userId);
    logger.info(`Memory: rebuild for ${userId} finished — ${processed}/${exchanges.length} exchanges, facts ${status.factsBefore} → ${done.factsAfter}`);
    return done;
  } catch (err: any) {
    const failed: MemoryRebuildStatus = { ...status, processed, finishedAt: new Date().toISOString(), factsAfter: null, error: String(err?.message ?? err).slice(0, 200) };
    await writeRebuildStatus(userId, failed).catch(() => {});
    logger.warn(`Memory: rebuild for ${userId} failed after ${processed} exchange(s): ${err?.message ?? err}`);
    return failed;
  }
}

/**
 * Start a rebuild for the requesting user (one at a time per user — Redis NX
 * lock, released when the job settles). Returns immediately; poll
 * getUserMemoryRebuildStatus. `wait: true` (tests / one-shot ops) runs inline.
 */
export async function startUserMemoryRebuild(
  userId: string,
  opts: { maxExchanges?: number; wait?: boolean } = {},
): Promise<{ started: boolean; reason?: 'already_running' | 'no_history'; total: number; status?: MemoryRebuildStatus }> {
  const redis = await import('../../../config/redis').then((m) => m.default).catch(() => null);
  const lockKey = rebuildLockKey(userId);
  if (redis) {
    const ok = await redis.set(lockKey, new Date().toISOString(), { NX: true, EX: REBUILD_LOCK_TTL_S }).catch(() => null);
    if (ok !== 'OK') return { started: false, reason: 'already_running', total: 0 };
  }
  const release = async () => { if (redis) await redis.del(lockKey).catch(() => {}); };
  let exchanges: RebuildExchange[];
  try {
    exchanges = await loadRebuildExchanges(userId, opts.maxExchanges);
  } catch (err) {
    await release();
    throw err;
  }
  if (!exchanges.length) {
    await release();
    return { started: false, reason: 'no_history', total: 0 };
  }
  const row = await prisma.userMemory.findUnique({ where: { userId }, select: { facts: true } });
  const status: MemoryRebuildStatus = {
    startedAt: new Date().toISOString(), finishedAt: null, total: exchanges.length, processed: 0,
    factsBefore: countVisibleFacts((row?.facts as Record<string, unknown>) || {}), factsAfter: null,
  };
  await writeRebuildStatus(userId, status);
  const job = runUserMemoryRebuild(userId, exchanges, status).finally(release);
  if (opts.wait) return { started: true, total: exchanges.length, status: await job };
  void job;
  return { started: true, total: exchanges.length };
}

export async function getUserMemoryRebuildStatus(userId: string): Promise<{ status: MemoryRebuildStatus | null; running: boolean; facts: number }> {
  const [status, row] = await Promise.all([
    readRebuildStatus(userId),
    prisma.userMemory.findUnique({ where: { userId }, select: { facts: true } }),
  ]);
  const running = !!status && !status.finishedAt;
  return { status, running, facts: countVisibleFacts((row?.facts as Record<string, unknown>) || {}) };
}

export function updateContextAsync(input: UpdateContextInput): void {
  // audit 2026-10-08 W3-1: tracked so a draining coding worker awaits the project-decision extraction before exit.
  void trackBackground(runUpdateContextPipeline(input).catch(err => {
    logger.error('Memory: updateContextAsync failed (non-fatal):', err);
  }), 'memory-pipeline');
}
