/**
 * Chat context machinery (agentic-only cutover, 2026-07-23).
 *
 * Extracted VERBATIM from langgraph/query-pipeline.ts (deleted) so the agent
 * chat engine keeps the bit-identical context the legacy pipeline built:
 * RAG, memory facts, SHARED_AI_RULES, datetime, platform identity, integration
 * status, truncation-continuation + follow-up-reference enrichment, and the
 * circuit-breaker-guarded getEnrichedContext load.
 *
 * Entry points:
 *   buildChatQueryContext  — everything the agent run needs for one turn
 *   persistAndEmitCanvases — save [CANVAS:] artifacts + emit `canvas` SSE events
 *
 * Anonymous support: userId may be null — loadChatContextNode then branches on
 * sessionId (Redis session history), exactly like the legacy pipeline did.
 */

import prisma from '../../../config/database';
import redisClient from '../../../config/redis';
import logger from '../../../utils/logger';
import {
  INTEGRATION_STATUS_CACHE_KEY,
  INTEGRATION_STATUS_CACHE_TTL,
} from '../langgraph/integration-status-cache';
import contextService from '../context.service';
import { retrieveChunks, retrieveGlobalChunks, buildContextBlock, buildCrossProjectBlock, RetrievedChunk, type EmbeddingProvider } from '../rag.service';
import { foldersInheritanceOn, getEffectiveSystemPrompt, getRagScopeFolderIds } from '../platform/folder-inheritance';
import { getEnrichedContext, getProjectSettings } from '../langgraph/memory.graph';
import { memSearchProjectsBlended, type MemHit, type MemBlendedHit, type MemScope } from '../memory/unified-memory.service';
import { ownsAllProjects } from '../memory/memory-access';
import { enrichFollowUpReference as pureEnrichFollowUpReference } from './followup-enrichment';
import { fleetNoticeBlockFor } from '../platform/fleet-notice';
import { userSpaceChatIsolated, userSpaceIsolationDisabled } from '../platform/user-space.service';
import { buildDateTimeBlock, dualTimestampRule } from './datetime-block';
import { buildChatUploadsBlock } from './chat-uploads-block';
import { listShellCredentialNames } from '../coding/credentials.service';
// Self-host setup hardening (2026-10-20): instance-level configuration truth (pure leaf).
import { integrationsMissingOnInstance, webSearchMissingOnInstance, WEB_SEARCH_UNCONFIGURED_IDENTITY_NOTE } from '../platform/instance-setup';

type SendEventFn = (type: string, data: any) => void;
type ConversationMessage = { role: 'user' | 'assistant'; content: string };

// ═══════════════════════════════════════════════════════════════════════════════
// Circuit breaker for getEnrichedContext + context helpers (verbatim move)
// ═══════════════════════════════════════════════════════════════════════════════
// ── Circuit breaker for getEnrichedContext ──────────────────────────────────────
// When PostgresStore is consistently slow or failing, every query waits 15s before
// falling back to direct DB load. This circuit breaker skips getEnrichedContext
// entirely for CIRCUIT_BREAKER_COOLDOWN_MS after CIRCUIT_BREAKER_THRESHOLD
// consecutive failures/timeouts, preventing cascading delays under load.
// 2026-06-10: Increased threshold from 5 to 8, kept cooldown at 20s. With the 8s context
// timeout, 5 concurrent requests timing out would open the circuit after just 5 failures —
// causing a 20s window where ALL users get empty conversation history. Threshold 8 tolerates
// more transient slow requests (common during DB load spikes) before opening the circuit.
// 2026-06-14: Reduced cooldown from 20s to 10s. Re-ask patterns show users asking follow-up
// questions within seconds — a 20s window where ALL users lose context is too long. 10s still
// prevents cascading failures while halving the context-loss window.
const CIRCUIT_BREAKER_THRESHOLD = 8;       // consecutive failures to trigger open state
const CIRCUIT_BREAKER_COOLDOWN_MS = 10000; // 10s — recover quickly; 20s caused too much context loss
// getEnrichedContext deadlines (see the loadContext block): a user turn fails
// fast at 5s; a machine wake (schedule/hook — nobody waiting, deepHistory on)
// gets 15s so supervisors keep their project-memory injection. Env override
// for the machine lane only: MACHINE_WAKE_CONTEXT_TIMEOUT_MS.
export const USER_TURN_CONTEXT_TIMEOUT_MS = 5000;
export const MACHINE_WAKE_CONTEXT_TIMEOUT_MS = (() => {
  const n = Number(process.env.MACHINE_WAKE_CONTEXT_TIMEOUT_MS);
  return Number.isFinite(n) && n >= USER_TURN_CONTEXT_TIMEOUT_MS ? n : 15_000;
})();
let _contextFailureCount = 0;
let _circuitBreakerOpenUntil = 0;

function recordContextSuccess(): void {
  _contextFailureCount = 0;
}

function recordContextFailure(): void {
  _contextFailureCount++;
  if (_contextFailureCount >= CIRCUIT_BREAKER_THRESHOLD) {
    _circuitBreakerOpenUntil = Date.now() + CIRCUIT_BREAKER_COOLDOWN_MS;
    logger.warn(
      `Pipeline: circuit breaker OPEN — ${_contextFailureCount} consecutive getEnrichedContext failures, ` +
      `bypassing LangGraph store for ${CIRCUIT_BREAKER_COOLDOWN_MS / 1000}s`
    );
  }
}

function isCircuitBreakerOpen(): boolean {
  if (_circuitBreakerOpenUntil === 0) return false;
  if (Date.now() >= _circuitBreakerOpenUntil) {
    // Cooldown expired — reset and allow a retry (half-open)
    _circuitBreakerOpenUntil = 0;
    _contextFailureCount = 0;
    logger.info('Pipeline: circuit breaker HALF-OPEN — allowing next getEnrichedContext attempt');
    return false;
  }
  return true;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Helpers (verbatim move)
// ═══════════════════════════════════════════════════════════════════════════════

// ── Truncate long assistant messages in conversation history ────────────────────
// Fix for: "next question after deep reasoning in a conversation makes no sense"
//
// After a deep reasoning / thinking mode response, the assistant message saved to
// the DB can be 5,000–10,000+ characters. When this is loaded as conversation
// history for the NEXT question, it overwhelms both the initial model queries and
// the synthesis prompt. The synthesizer sees thousands of chars of previous response
// content mixed with the current question's model responses and loses track of what
// the current question is actually asking — producing nonsensical answers.
//
// Fix: cap assistant messages in conversation history to MAX_ASSISTANT_HISTORY_CHARS.
// User messages are kept intact (they're usually short and critical for context).
// The most recent assistant message (the one right before the current question) gets
// a slightly larger budget since it's the most relevant context.
const MAX_ASSISTANT_HISTORY_CHARS = 2400;     // increased from 1600 — re-ask patterns (chat 02d7442f) show context loss on follow-ups; users rephrasing identical questions within seconds
const MAX_LAST_ASSISTANT_HISTORY_CHARS = 3500; // increased from 2500 — last response is most relevant for follow-ups; previous limit caused loss of specific details (hotel names, team matchups)

export function truncateHistoryAssistantMessages(
  history: ConversationMessage[]
): ConversationMessage[] {
  if (history.length === 0) return history;

  // Find the index of the last assistant message
  let lastAssistantIdx = -1;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === 'assistant') {
      lastAssistantIdx = i;
      break;
    }
  }

  return history.map((msg, idx) => {
    if (msg.role !== 'assistant') return msg;

    const limit = idx === lastAssistantIdx
      ? MAX_LAST_ASSISTANT_HISTORY_CHARS
      : MAX_ASSISTANT_HISTORY_CHARS;

    if (msg.content.length <= limit) return msg;

    // Truncate with a clear marker so models know context was trimmed
    const truncated = msg.content.substring(0, limit).trimEnd();
    return {
      role: msg.role,
      content: `${truncated}\n\n[… previous response truncated for brevity — ${msg.content.length} chars total]`,
    };
  });
}

// ── Follow-up reference enrichment ─────────────────────────────────────────────
// Fix for: "you said teranet for colocation..then i asked whats teranet...makes no sense"
//
// When the AI mentions a term (e.g. "Teranet" as a colocation provider) and the user
// asks a short follow-up like "what's Teranet?", the 3 models receive the truncated
// conversation history (1500 chars max for the last assistant message) and the bare
// question "what's Teranet?". Without knowing the AI mentioned Teranet in a specific
// context (colocation), the models answer about the real Teranet (Ontario land registry)
// — which is wrong in the conversation's context.
//
// Fix: detect short follow-up questions that reference a term from the previous assistant
// response. Extract the surrounding context from the FULL (pre-truncation) assistant
// message and prepend it to the user's query so all models understand the reference.
//
// This enrichment is applied in loadContextNode BEFORE truncation, and the enriched
// message is stored in the pipeline state so queryModelsNode and synthesizeNode use it.

/**
 * Detect if the user's message is a short follow-up referencing a term from the
 * previous assistant response, and if so return an enriched version that carries
 * the prior-turn context. Thin wrapper over the pure `enrichFollowUpReference`
 * in ./followup-enrichment (extracted 2026-07-02 so the logic is unit-testable);
 * this wrapper only adds the observability log line.
 */
export function enrichFollowUpReference(
  userMessage: string,
  conversationHistory: ConversationMessage[]
): string {
  return pureEnrichFollowUpReference(userMessage, conversationHistory, (info) => {
    if (info.kind === 'implicit') {
      logger.info(
        `Pipeline: enriched implicit follow-up — msg="${info.msg}", topicLen=${info.contextLen}`
      );
    } else {
      logger.info(
        `Pipeline: enriched follow-up reference — term="${info.term}", ` +
        `originalMsg="${info.msg}", contextLen=${info.contextLen}`
      );
    }
  });
}

// ── Truncation continuation detection ──────────────────────────────────────────
// Fix v265: when the AI response is truncated (due to synthesis timeout, token limits,
// or network issues), the user often says "your response stopped short", "you got cut off",
// "wasn't finished", "continue from X". Without this detection, the AI restarts the entire
// answer from scratch (repeating everything), which is frustrating. This function detects
// truncation complaints and enriches the message so models know to CONTINUE, not restart.

const TRUNCATION_PATTERNS = [
  /(?:response|answer|reply|you)\s+(?:stopped|cut|got cut|was cut|were cut)\s+(?:short|off|mid)/i,
  /(?:stopped|cut)\s+(?:short|off)\s+(?:after|at|before|mid)/i,
  /(?:wasn't|wasn't|was not|weren't|weren't|were not)\s+(?:finished|complete|completed|done)/i,
  /(?:didn't|didn't|did not)\s+(?:finish|complete)/i,
  /(?:got|was|were)\s+(?:truncated|incomplete|cut off)/i,
  /continue\s+(?:from|where|after|with)/i,
  /(?:you|it|that)\s+(?:broke off|ended abruptly|ended suddenly|stopped suddenly)/i,
  /keep\s+going/i,
  /finish\s+(?:the|your|that)\s+(?:response|answer|reply|thought|list)/i,
  /what\s+(?:was|were)\s+(?:the rest|after that)/i,
  /you\s+(?:left off|stopped)\s+(?:at|after|before)/i,
];

/**
 * Detect if the user is complaining about a truncated/cut-off previous response.
 * If so, enrich the message with the full previous response so models can continue
 * from where it stopped instead of restarting from scratch.
 */
export function enrichTruncationContinuation(
  userMessage: string,
  conversationHistory: ConversationMessage[]
): string {
  // Only check short messages (truncation complaints are usually brief)
  if (userMessage.length > 200) return userMessage;
  if (conversationHistory.length === 0) return userMessage;

  // Check if message matches any truncation pattern
  const isTruncationComplaint = TRUNCATION_PATTERNS.some(p => p.test(userMessage));
  if (!isTruncationComplaint) return userMessage;

  // Find the last assistant message
  let lastAssistantContent = '';
  for (let i = conversationHistory.length - 1; i >= 0; i--) {
    if (conversationHistory[i].role === 'assistant') {
      lastAssistantContent = conversationHistory[i].content;
      break;
    }
  }
  if (!lastAssistantContent || lastAssistantContent.length < 100) return userMessage;

  // Include the FULL previous response (up to 3000 chars) so models can see
  // exactly where it stopped and continue from that point
  const previousResponse = lastAssistantContent.length > 3000
    ? lastAssistantContent.substring(0, 3000) + '\n[... truncated for context ...]'
    : lastAssistantContent;

  const enrichedMessage = `${userMessage}

═══ TRUNCATION CONTINUATION CONTEXT ═══
The user is telling you that your PREVIOUS response below was cut off / stopped short / was incomplete.

YOUR PREVIOUS (TRUNCATED) RESPONSE:
${previousResponse}

═══ END TRUNCATION CONTEXT ═══

CRITICAL INSTRUCTION: Your previous response above was cut off mid-way. The user wants you to CONTINUE and COMPLETE the answer from where it stopped. Do NOT restart from the beginning — do NOT repeat the content already given above. Pick up EXACTLY where the previous response ended and provide the remaining content that was missing. Start your response with a brief "Picking up where I left off..." or similar, then continue with the missing sections.`;

  logger.info(
    `Pipeline: detected truncation continuation request — ` +
    `msg="${userMessage.substring(0, 60)}", prevResponseLen=${lastAssistantContent.length}`
  );

  return enrichedMessage;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Shared prompt blocks (verbatim move)
// ═══════════════════════════════════════════════════════════════════════════════

// ── Model context block injected into system context ───────────────────────────
// Tells the model who is actually running and how its answer is used, so it can
// manage response scope honestly. REWRITTEN 2026-09-03 (owner wave): the old
// version described the retired pre-cutover architecture (3 parallel models,
// frontier branches, GLM-5.2 primary, GPT-5.5/Grok-4.3) — pure misinformation
// injected into every prompt. The pipeline is open-source-only and the second
// argument (modelSet) no longer branches; kept in the signature for callers.
export function buildModelContextBlock(mode: string, _modelSet: string): string {
  // Legacy aliases (single/fast → single_thinking, deep_research_all →
  // deep_research) are normalized at the controller, but be tolerant here.
  const m = mode === 'single' || mode === 'fast' ? 'single_thinking'
    : mode === 'deep_research_all' ? 'deep_research' : mode;
  if (m === 'deep_research') {
    return `[YOUR MODEL CONTEXT — DEEP RESEARCH]
Kimi K3 leads an autonomous research council with GLM-5.3 and DeepSeek V4.1 Flash as
colleague agents (each with its own live web tools; colleagues may spawn clones
and message peers). Kimi K3 synthesizes the final answer. Research thoroughly —
your findings are cross-checked against the other agents before synthesis.
[/YOUR MODEL CONTEXT]`;
  }
  if (m === 'thinking') {
    return `[YOUR MODEL CONTEXT — ENSEMBLE]
Two independent agents work this question in parallel, each with its own live
web tools: Kimi K3 (orchestrator — writes and streams the final answer) and
DeepSeek V4.1 Flash (independent cross-checker at maximum reasoning effort).
The orchestrator reconciles both drafts into one answer, so state your
grounding and reasoning explicitly.
[/YOUR MODEL CONTEXT]`;
  }
  return `[YOUR MODEL CONTEXT — QUICK]
You are the sole responding model (Kimi K3) with live web tools available.
Respond directly and thoroughly; no other model reviews this answer.
[/YOUR MODEL CONTEXT]`;
}

// ── Shared AI rules injected into every model's system context ─────────────────
// These rules must appear in INITIAL model queries (not just synthesis) so that
// all three models get the instruction before any individual responses are generated.
// If only the synthesis prompt has these rules, but all 3 initial models agree on
// a wrong claim (e.g. "Claude 4.6 doesn't exist"), the synthesizer won't correct it.
// Fix for: severity-2 bug "AI incorrectly claims model versions don't exist" (Mar 26, 2026)
export const SHARED_AI_RULES = `[CRITICAL AI RESPONSE GUIDELINES — APPLY ALWAYS]
• NEVER claim that any AI model version, software product, tool, or feature is "not released", "not available", "doesn't exist yet", or "hasn't launched" — your training data has a cutoff date and you cannot know the current release status of any software or AI product
• NEVER correct or second-guess the user's stated tool, software, or AI model choices — if a user says they are using a specific version or product, accept it as their authoritative choice and help them accordingly
• If a user references a specific product version and you are uncertain of its status, answer helpfully for that version rather than disputing its existence
• For real-time pricing, current events, or live data: use ONLY the web search results provided — do not substitute training-data estimates
• NEVER fabricate specific product features, menu items, navigation paths, settings, buttons, or UI elements that you have not verified exist — if you are unsure whether a feature exists in a specific location within a product, say so honestly rather than guessing a path or menu name
• When describing how to use a software product, only reference features and navigation paths you are confident exist based on provided context or well-established knowledge — if you are uncertain, clearly state that the user should verify the exact location in their version of the product
• NEVER invent step-by-step instructions that reference specific UI elements (tabs, menus, sub-menus, buttons) unless you have concrete evidence they exist — fabricated navigation instructions are worse than no instructions at all
• TOPIC CORRECTION DETECTION: If the user's message contains phrases like "I meant", "no I was asking about", "not that", "I'm talking about", "I said", or otherwise corrects/clarifies a previous misunderstanding — treat the CORRECTED topic as the primary subject. Ignore the previously misunderstood topic entirely and answer the user's actual intended question. The user's latest message always takes priority over prior conversation context when there is a conflict.
• USER EXPLICIT REJECTION — CRITICAL: When the user explicitly rejects a topic, assumption, or personal attribute — you MUST immediately and permanently stop referencing it. Detection phrases include: "stop talking about", "I told you", "I'm not", "I don't", "I never said", "that's not me", "that's wrong about me", "I already told you", "how many times", "quit bringing up", "don't assume". If the user says "I'm not plant based" — NEVER mention plant-based anything again. If the user says "stop talking about my joint health" — NEVER bring up joint health, joint supplements, or joint-related topics again. The user's explicit denial of a fact about themselves ALWAYS overrides anything stored in user memory, context, or conversation history. Do NOT argue with the user about their own identity, preferences, diet, health, or lifestyle. Accept their correction immediately and move on. Repeating a rejected topic after the user has told you to stop is the fastest way to destroy trust.
• NUMERICAL ACCURACY — CRITICAL: NEVER fabricate, round, average, or approximate numbers, statistics, percentages, prices, dates, quantities, or any numerical data. If you cite a number, it must appear EXACTLY as stated in your source material or web search results. Do NOT combine numbers from different sources by averaging them. Do NOT invent statistics to sound authoritative. If you perform a calculation, show your working so the user can verify. If sources disagree on a number, state the discrepancy and cite which source each number comes from rather than picking one silently. Getting numbers wrong destroys user trust immediately.
• CONTENT DELIVERY — CRITICAL: When the user asks you to CREATE, WRITE, DRAFT, or GENERATE any content (document, one-pager, email, plan, report, letter, template, guide, checklist, worksheet, etc.) — you MUST produce the ACTUAL COMPLETE content in your response. NEVER respond with only a description of what you plan to create (e.g. "I'll create a comprehensive one-pager..." or "I'll draft a report covering..."). The user wants the finished product, not a preview or summary of your intentions. Produce the full content immediately. If the content is a standalone document or worksheet, wrap it in a [CANVAS:type=document,title=Your Title Here]...[/CANVAS] block so it opens in the editing panel — include the FULL content between the opening and closing tags. NEVER output a bare [CANVAS] tag without the colon, type, title attributes, content, and closing [/CANVAS] tag. The chat reply must ALWAYS contain the content the user actually asked for — lists, plans, menus, steps, tables, and comparisons that ARE the answer belong in the chat message text. Use a [CANVAS] block ONLY for long standalone artifacts the user will want to edit or reuse (documents, worksheets, code files, diagrams) — never for the direct answer itself: a canvas-only answer leaves chat users (especially on mobile) staring at a reply with no content in it.
• LIVE SPORTS & EVENTS — CRITICAL: For ANY question about live sports games, scores, schedules, matchups, or events happening today/tonight — the web search results provided to you are REAL-TIME data fetched moments ago. You MUST treat this data as the absolute truth. NEVER contradict web search results with your training data about schedules, scores, or game times. If web search says a game is happening right now, it IS happening right now. If web search shows a score, that IS the current score. Your training data may have outdated schedules, postponed games, or missing information — the live web data ALWAYS wins. Do NOT say "I don't have real-time access" or "I can't check live scores" when web search results containing scores/game data are present in your context. Do NOT claim a game is not happening or is scheduled for a different date when web search results show otherwise. The current date is provided in the [CURRENT DATE & TIME] block — use it to confirm "today" references.
• NEWS FRESHNESS — DATE-VERIFY CURRENT EVENTS — CRITICAL: When the user asks about events happening "today", "right now", "this week", or the "latest" news — or pastes a headline framed as "today's news" — CHECK the publication date of every web search result before presenting it as the current situation. News feeds and aggregators regularly resurface weeks/months/years-old stories as if they were new, and a headline matching the story does NOT prove it is happening now. If the only matching coverage is dated well before the current date (see the [CURRENT DATE & TIME] block), or live official sources (road-status pages, agency dashboards, official notices) do not confirm the event is happening NOW, say so plainly: flag the headline as likely a resurfaced old story, report what IS currently confirmed, and point the user at the authoritative live source. NEVER claim a source is "dated today" (or any specific date) unless you actually saw that date attached to it. When your dated search evidence contradicts the user's "it's happening now" premise, the dated evidence wins — do not anchor on the premise.
• SELF-REFERENTIAL FOLLOW-UPS — CRITICAL: When the user asks a short follow-up question like "what's X?", "what is X?", "tell me more about X", "explain X", or "what do you mean by X?" — and X is a term, name, or concept that appeared in YOUR previous response in this conversation — the user is asking you to explain what YOU meant by X in the context of YOUR previous answer. Do NOT answer about a completely different entity that happens to share the same name. For example, if you mentioned "Teranet" as a colocation provider and the user asks "what's Teranet?", explain Teranet as a colocation provider (as you used it), do NOT answer about an unrelated company called Teranet. Always check the conversation history to see if the term appeared in your previous response, and if so, answer in THAT context. If a [FOLLOW-UP REFERENCE CONTEXT] block is present in your system context, it contains the exact passage from your previous response where the term was used — use it as the primary reference for your answer.
• CONVERSATION PROGRESSION — NO REPETITION — CRITICAL: When conversation history shows you have ALREADY recommended, listed, or discussed specific items (books, movies, products, restaurants, tools, options, etc.) in a previous response, you MUST NOT repeat those same items in your current response. If the user asks for "more", "any others", "what else", "another one", or similar progressive requests — they want NEW suggestions they haven't seen yet. Read the conversation history carefully and identify everything you already mentioned. Your new response must contain ONLY items not previously discussed in this conversation. If you cannot think of genuinely new items, say so honestly rather than repeating previous recommendations. Repeating the same answer the user already received is the fastest way to make the AI feel broken.
• RESPONSE FORMATTING — IMPORTANT: Default to conversational prose paragraphs — explanations should read as flowing text, not a pile of bold fragments. Use **bold** SPARINGLY (a few genuinely key terms per answer, never every sentence), bulleted or numbered lists only when listing multiple discrete items, and ## headings only to organize genuinely long, multi-section answers. Short answers (1-3 sentences) need no special formatting at all. Do NOT output walls of unbroken text, but do NOT over-format either — most answers are prose with a light list, not a document outline with a heading per sentence. MARKDOWN WHITESPACE — CRITICAL: headings, lists, and tables only render when they start on their OWN line AFTER A BLANK LINE. Always put a blank line before every ## heading, list, and table; keep each list item on its own line; never run structure onto the same line as prose ("intro ## Heading - item" renders as raw broken markup for the user). When describing capabilities, features, or options — use a bulleted or numbered list, never a run-on paragraph. Clean, scannable formatting builds user trust.
• TRAINING DATA HONESTY — CRITICAL: Your training data has a cutoff date. When a user asks about FUTURE events, upcoming releases, planned features, or anything that may not have existed when your training data was collected — you MUST acknowledge that you cannot verify this information without web search. NEVER fabricate event names, dates, locations, ticket prices, lineups, or details for events you have not verified. If web search results are available, use ONLY the data from those results. If NO web search results were retrieved for the query, say so explicitly: "I wasn't able to find current information about this" or "I don't have verified data on this." NEVER present unverified speculation as fact. NEVER invent specific event details (names, dates, venues, prices) to fill a knowledge gap. It is ALWAYS better to say "I couldn't verify this" than to fabricate plausible-sounding details that turn out to be wrong. Fabricated event information is the fastest way to destroy user trust because the user will check and discover the event doesn't exist.
• LOCATION-AWARE PLACE QUERIES — CRITICAL: When the user asks about a physical place — a store, mall, restaurant, venue, or local service (e.g. "is there a Skechers in Mayfair Mall?") — and that place name could exist in more than one city, resolve it against the USER'S known location FIRST: check the user-memory facts (city, region, timezone) in your context and answer for the match nearest the user. A user in Victoria BC asking about "Mayfair Mall" means Mayfair Shopping Centre in Victoria — never a same-named mall in another state or country by default. NEVER anchor on the most famous or most populous matching location when the user's own locale has a plausible match. If NO user location is known from memory or context, ask which city/area they mean BEFORE answering instead of guessing a faraway one.
[/CRITICAL AI RESPONSE GUIDELINES]`;

// ── Digby platform identity & capabilities ─────────────────────────────────────
// Without this block, models have NO knowledge of what Digby is or what it can do.
// When users ask "what integrations do you have?" or "what can you do?", models
// would hallucinate or give generic answers. This block gives every model accurate
// knowledge of Digby's actual features and the user's connected integrations.
// Fix for: user feedback "you have workspace integrations for me" (thumbs down, wrong)
// 2026-09-08 refresh (agentic expansion): the block described the RETIRED
// product — "4 thinking levels — Single (fastest), Fast, Thinking, Deep
// Research" (the fast tiers died 2026-06-21), no GitHub / X / iMessage in the
// integrations list, and none of Digby Code, schedules, the Fleet Supervisor,
// feeds, memory, share links, browser automation, or Telegram pushes. Every
// claim below is checked against AGENTS.md / CLAUDE.md; the closing line hands
// the model to the capability playbook (chat-agent/capability-doctrine.ts) so
// "what can you do" answers and "do it for me" requests land on the SAME truth.
// 2026-09-26 compute-policy rewrite (audit docs-drift-5): the per-chat patience
// picker LEFT the composer (docs/DEPTH_UX_SOTA_2026-09-26.md) — Auto is the
// stored default for every chat, the ONE control under an answer is "Dig
// deeper", and a default depth lives in Account → Advanced. The block used to
// tell the model "the user picks one per chat" while the :388 rule forbade
// naming Dig deeper (not in the list) — so it described a picker that no
// longer exists and stayed silent on the real control. Copy only — no
// behaviour change, so no kill switch; the pins live in chat-context.test.ts.
// roster 2026-10-06 B-3: the Account → Advanced "Default depth" radios are gone
// (Digby picks depth and models per message) — the block says there is no depth
// setting instead of sending users to a control that no longer exists.
// Ticket c99b404a (2026-10-27): the Account → Advanced TAB itself was removed
// (it had held exactly that one read-only line — nothing to set); the block no
// longer names it at all.
export const DIGBY_PLATFORM_IDENTITY = `[DIGBY PLATFORM IDENTITY — YOU ARE DIGBY]
You are Digby, an AI assistant at digby.ai. You are NOT ChatGPT, Gemini, Grok, or any other AI — you are Digby.
Digby is an agentic multi-model platform. Auto (the default for every chat) picks the shape per message: Quick — one model with live web tools; Ensemble — a second full-peer model cross-checking in parallel, both drafts reconciled; Deep Research — an agentic research council synthesized into a report (signed-in; daily quota).

DEPTH CONTROLS (no per-chat level picker):
• "Dig deeper" — the ONE control under every answer: after Quick, a verify pass by a second model; after Ensemble, the research council runs in the background and posts a "Deeper findings" message. Signed-in only (guests see "Sign in for a deeper look").
• There is no depth setting: Digby picks depth and models per message — never tell a user to pick a level.

YOUR AVAILABLE INTEGRATIONS (users connect these in Account → Integrations):
• Google Workspace — Gmail (read & send emails), Google Calendar (view events), Google Drive (list files), Docs, Sheets. Supports multiple Google accounts (Personal, Work, Custom labels).
• GitHub — repos, issues, pull requests, code search, file reads.
• X (Twitter) — profiles, posts, search, trends. PUBLIC reads work for everyone, even without connecting an X account.
• Xero Accounting — Contacts, invoices, bills, chart of accounts, bank summaries, profit & loss reports, balance sheets.
• Plaid Banking — Bank account balances, transaction history, recurring transactions, identity info. Supports multiple banks.
• Slack — Read channels, recent messages, search across the workspace, and look up users.
• Asana — Read workspaces, projects, and your assigned tasks; search tasks across a workspace.
• Telegram — two-way chat with Digby from Telegram (connect with one tap) + notify_user pushes to the user's linked Telegram.
• iMessage — via the paired Mac (Digby desktop app): read chats, compose texts (confirm-and-send card); the same Mac provides a headless local browser + computer use.

HOW INTEGRATIONS WORK:
- Users connect in Account → Integrations tab (click profile icon → Account)
- Once connected, Digby fetches the relevant data in real time when a question touches the user's own data
- Email sending requires user confirmation via Send/Edit/Cancel buttons

OTHER CAPABILITIES:
• Image reading & analysis — YES, you CAN read and analyze images (drag-drop, paste, or attach): describe photos, read text in screenshots, interpret charts/graphs and diagrams, identify objects, answer questions about any uploaded image. Formats: JPG, PNG, WebP, GIF, HEIC, HEIF.
• File uploads — PDFs (text extracted), DOCX, text and markdown files; their content is available for your answers.
• Web search — ALWAYS available, on every question: real-time search + page reading for ANY public information (current events, prices, news, companies, and public web profiles/pages such as LinkedIn, Crunchbase, or company sites). There is deliberately no "LinkedIn integration" — none is needed. For public info about a person, company, or the user themselves, USE web search; NEVER say you can't access public web content or lack a LinkedIn/other integration for it.
• Browser automation — browser_task delegates a bounded task to a real browser (Digby's own browser profile on the paired Mac when online, a cloud reader otherwise); each step streams a live screenshot to the side panel.
• Computer use — computer_task drives the user's own Mac as an extension of them: sees the screen, clicks/types in what they already use (their Chrome/Safari with its logins, Mail, Finder, any app). Autonomous; asks only when stuck. Needs the Mac app paired + online. Use it for anything ON their Mac / IN their browser or an app / about their screen — never tell them to do it themselves.
• Digby Code — coding sessions in isolated workspaces: clone repos, edit, run, test, and open pull requests; any chat can attach a workspace.
• Schedules & recurring runs — one-shot or recurring prompts that wake a chat later (check back, monitor, daily briefs, daily topic digests on any chat — ask Digby to set one up).
• Fleet Supervisor — a per-user supervisor chat tracking goals/todos and event hooks across all chats and coding sessions.
• Persistent memory — facts remembered across sessions; the user can review and delete them.
• Projects (folders) with knowledge bases (RAG) — uploaded documents, saved URLs and notes become project context.
• Canvas/Artifacts — code, documents, diagrams, tables in a side panel; editable.
• Public share links for chats • Voice input & text-to-speech • Web app + installable PWA • News headlines on home screen
• Dig deeper — the depth control under every answer (see DEPTH CONTROLS).

IMPORTANT: When asked about your capabilities or integrations, answer from the above. Do NOT invent features not listed. Refer to the integration status block below for this user's connection state. You OPERATE these for the user through your platform tools — see the playbook in your instructions.
[/DIGBY PLATFORM IDENTITY]`;

/**
 * Build a dynamic block describing which integrations the user has connected.
 * Queried at request time so the AI can give accurate, personalized answers
 * like "You have Google Workspace connected but haven't set up Plaid yet."
 */
// Integration status changes rarely (only when a user connects/disconnects an
// integration), yet buildIntegrationStatusBlock was firing 8 parallel OAuth-token
// DB queries on EVERY chat message. Cache the rendered block in Redis so back-to-back
// messages in a session reuse it instead of re-hitting Postgres 8× each.
// 2026-07-05: Extended TTL 90s → 300s (5 min). 2026-07-06: invalidateIntegrationStatusCache()
// is now wired into every OAuth connect/disconnect callback (google/github/x/xero/plaid/slack/
// asana/telegram controllers), so a freshly-connected integration surfaces immediately — the
// 5-min TTL is now just the fallback upper bound, not the only staleness bound. The key + helper
// live in ../langgraph/integration-status-cache so the callbacks can invalidate without
// importing this file. (The legacy re-export is gone — every OAuth controller imports
// invalidateIntegrationStatusCache directly from integration-status-cache.)

export async function buildIntegrationStatusBlock(userId: string | null): Promise<string> {
  if (!userId) {
    return `[YOUR INTEGRATION STATUS]\nThis user is not signed in. They can create a free account to access integrations.\n[/YOUR INTEGRATION STATUS]`;
  }

  try {
    const cached = await redisClient.get(INTEGRATION_STATUS_CACHE_KEY(userId));
    if (cached) return cached;
  } catch { /* cache miss / redis down — fall through to DB */ }

  try {
    // 2026-07-10: googleCount was a 9th SEQUENTIAL query fired after this Promise.all on
    // every cache miss (~1 extra round-trip per uncached request). Folded into the same
    // parallel batch so all integration reads resolve in a single round-trip window.
    const [googleRow, githubRow, xRow, xeroRow, plaidRow, slackRow, asanaRow, telegramRow, googleCountRaw, shellCredNames] = await Promise.all([
      (prisma as any).googleOAuthToken.findFirst({ where: { userId }, select: { id: true, email: true, label: true } }).catch(() => null),
      (prisma as any).gitHubOAuthToken.findFirst({ where: { userId }, select: { id: true, username: true, scopes: true } }).catch(() => null),
      (prisma as any).xOAuthToken.findFirst({ where: { userId }, select: { id: true, screenName: true } }).catch(() => null),
      (prisma as any).xeroOAuthToken.findFirst({ where: { userId }, select: { id: true, orgName: true } }).catch(() => null),
      (prisma as any).plaidAccessToken.findFirst({ where: { userId }, select: { id: true, institutionName: true } }).catch(() => null),
      (prisma as any).slackOAuthToken.findFirst({ where: { userId }, select: { id: true, teamName: true } }).catch(() => null),
      (prisma as any).asanaOAuthToken.findFirst({ where: { userId }, select: { id: true, asanaName: true } }).catch(() => null),
      (prisma as any).telegramLink.findFirst({ where: { userId }, select: { id: true, username: true } }).catch(() => null),
      (prisma as any).googleOAuthToken.count({ where: { userId } }).catch(() => 0),
      // Ticket c02b85bf: coding-tab credential NAMES (never values — the store
      // is write-only from chat's side). Without this line a chat agent answers
      // "I don't have a Cloudflare key" while coding-session shells carry it.
      // Degrades to null (line omitted) on failure — never to "None stored",
      // which would assert the key is absent when the read merely failed.
      listShellCredentialNames(userId).catch(() => null),
    ]);
    const googleCount: number = typeof googleCountRaw === 'number' ? googleCountRaw : 0;
    const shellCreds: string[] | null = Array.isArray(shellCredNames) ? shellCredNames : null;

    // Self-host setup hardening (2026-10-20): on a NON-production instance an
    // integration the admin never configured must not send the user to a
    // Connect button that cannot work. Production is never "missing".
    const missingOnInstance = integrationsMissingOnInstance();
    const notConnected = (key: string, label: string): string => missingOnInstance.has(key)
      ? `• ${label}: ❌ Not connected — not available on this instance yet (an admin sets it up: Account → Admin → Setup)`
      : `• ${label}: ❌ Not connected — connect in Account → Integrations`;
    const lines: string[] = [`[YOUR INTEGRATION STATUS — THIS USER'S CONNECTIONS]`];
    if (googleRow) {
      const extra = googleCount > 1 ? ` (${googleCount} accounts)` : '';
      lines.push(`• Google Workspace: ✅ CONNECTED${extra} — Gmail, Calendar, Drive active`);
    } else {
      lines.push(notConnected('google', 'Google Workspace'));
    }
    if (githubRow) {
      const ghUser = githubRow.username ? ` — @${githubRow.username}` : '';
      // The classic-OAuth flow requests scope=repo; a token WITHOUT 'repo' (e.g. when the
      // configured GitHub client is a GitHub App authorized with only user-level permissions)
      // can authenticate but cannot read any repository. Surface that precisely instead of
      // failing silently so the model gives correct guidance.
      const hasRepoScope = Array.isArray(githubRow.scopes) && githubRow.scopes.includes('repo');
      lines.push(hasRepoScope
        ? `• GitHub: ✅ CONNECTED${ghUser} — repos, issues, pull requests, code search, file reads`
        : `• GitHub: ⚠️ CONNECTED${ghUser} but WITHOUT repository access — it was authorized with only user-level scopes, so repo / issue / pull-request / code-search / file reads will return nothing. To fix: reconnect GitHub in Account → Integrations and grant the "repo" scope. For PRIVATE ORGANIZATION repos, an org owner must also approve/authorize the app for that organization (GitHub → org Settings → Third-party access / installed apps).`);
    } else {
      lines.push(notConnected('github', 'GitHub'));
    }
    lines.push(xRow
      ? `• X (Twitter): ✅ CONNECTED${xRow.screenName ? ` — @${xRow.screenName}` : ''} — profiles, tweets, search, trends`
      : notConnected('x', 'X (Twitter)'));
    lines.push(xeroRow
      ? `• Xero Accounting: ✅ CONNECTED${xeroRow.orgName ? ` — ${xeroRow.orgName}` : ''}`
      : notConnected('xero', 'Xero Accounting'));
    lines.push(plaidRow
      ? `• Plaid Banking: ✅ CONNECTED${plaidRow.institutionName ? ` — ${plaidRow.institutionName}` : ''}`
      : notConnected('plaid', 'Plaid Banking'));
    lines.push(slackRow
      ? `• Slack: ✅ CONNECTED${slackRow.teamName ? ` — ${slackRow.teamName}` : ''} — channels, messages, search, users`
      : notConnected('slack', 'Slack'));
    lines.push(asanaRow
      ? `• Asana: ✅ CONNECTED${asanaRow.asanaName ? ` — ${asanaRow.asanaName}` : ''} — workspaces, projects, tasks`
      : notConnected('asana', 'Asana'));
    lines.push(telegramRow
      ? `• Telegram: ✅ CONNECTED${telegramRow.username ? ` — @${telegramRow.username}` : ''} — user can chat with Digby from Telegram`
      : notConnected('telegram', 'Telegram'));
    // Ticket c02b85bf: the coding-tab credential store, as NAMES only. A chat
    // agent reading only the lines above concluded "no Cloudflare access — I
    // need the key" while every coding-session shell carried the stored token.
    // A FAILED read omits the line entirely — rendering "None stored" on a
    // failed read would assert the key is absent when it may exist.
    if (shellCreds === null) {
      // read failed — omit the line (never claim absence)
    } else if (shellCreds.length > 0) {
      lines.push(`• API keys / credentials (Account → Coding): ✅ ${shellCreds.length} stored — ${shellCreds.join(', ')} — ALREADY SET as env vars in every coding-session shell (use start_coding_session to run commands with them; NEVER ask the user to paste a key that is listed here — values are write-only and cannot be read back)`);
    } else {
      lines.push(`• API keys / credentials (Account → Coding): ❌ None stored — the user can add provider keys (Cloudflare, AWS, Namecheap, Brev, custom) in Account → Coding; on a turn where they PASTE a key, store_secret saves it without it ever being echoed`);
    }
    lines.push(`[/YOUR INTEGRATION STATUS]`);
    const block = lines.join('\n');
    try { await redisClient.setEx(INTEGRATION_STATUS_CACHE_KEY(userId), INTEGRATION_STATUS_CACHE_TTL, block); } catch { /* non-critical */ }
    return block;
  } catch (err: any) {
    logger.warn(`buildIntegrationStatusBlock failed: ${err.message}`);
    return '';
  }
}

// buildDateTimeBlock + dualTimestampRule moved to ./datetime-block.ts (2026-09-08)
// so dependency-free background services (suggested-questions.service) can
// inject the SAME [CURRENT DATE & TIME] block every chat gets without pulling
// this module's prisma/redis/rag/memory graph (import cycle via
// user-facts.service → suggested-questions.service). Re-exported here so every
// existing importer keeps working unchanged.
export { buildDateTimeBlock, dualTimestampRule };

// ═══════════════════════════════════════════════════════════════════════════════
// Project learnings & decisions — the coding side's durable memory, read into chat
// (owner 2026-09-14). The unified store (digby_memory) holds project-scope rows
// tagged source 'learning' (learnings-index.service, .digby/notes/learnings.md
// entries) and 'decision' (extracted project decisions). Until now only coding
// runs' search_memory could see them; the chat [KNOWLEDGE BASE] block read
// project_chunks alone. This appends them as a '[PROJECT LEARNINGS & DECISIONS]'
// sub-block INSIDE the project knowledge block, only when non-empty.
//
// PER-USER GATES (binding): the read goes through the unified store's GATED
// entry point memSearchProjectsBlended — every scope id is run through
// memory-access.authorizedProjectScopeIds (owner, or member of the project or
// an ancestor folder) BEFORE the query; unknown/foreign ids are dropped, never
// widened. Cross-project blending spans ONLY the caller's OWNED projects
// (memory-access.ownedProjectIds, member-shared never) and only when
// crossProjectMemory is on (the same blendUserId the RAG arm uses). The gate is
// NOT re-implemented here. Best-effort: any failure or the soft deadline
// degrades recall, never the request.
// ═══════════════════════════════════════════════════════════════════════════════

export const PROJECT_LEARNINGS_SOURCES: readonly string[] = ['learning', 'decision'];
export const PROJECT_LEARNINGS_HEADER = 'PROJECT LEARNINGS & DECISIONS';
const PROJECT_LEARNINGS_K = 4;
const PROJECT_LEARNINGS_EXCERPT_CHARS = 300;
const PROJECT_LEARNINGS_BLEND_MAX_PROJECTS = 40;
/**
 * User-turn soft deadline for the learnings lookup (backlog audit PE-12,
 * 2026-09-28). The old 6 s deadline dropped the block on ~1 turn in 7
 * (memory_search_timing purpose=project_learnings, 7 d: 390 of 2,626 searches
 * ≥ 5.75 s, p95 9.79 s — DashScope embed + rerank queueing spikes, not the
 * query) and logged a warn each time (285 / 7 d). Raised to 10 s and made
 * env-tunable (PROJECT_LEARNINGS_TIMEOUT_MS); the lookup now also STARTS
 * before the enriched-context load (see loadChatContextNode), so most of the
 * budget overlaps work the turn does anyway rather than adding user wait.
 * Machine wakes keep MACHINE_WAKE_CONTEXT_TIMEOUT_MS.
 */
export const PROJECT_LEARNINGS_DEFAULT_TIMEOUT_MS = 10_000;
export function projectLearningsTimeoutMs(): number {
  const n = Number(process.env.PROJECT_LEARNINGS_TIMEOUT_MS);
  return Number.isFinite(n) && n >= 1000 ? Math.floor(n) : PROJECT_LEARNINGS_DEFAULT_TIMEOUT_MS;
}

/** One loop_metrics memory_search_timing row with phase 'deadline' per soft-
 *  deadline hit — the p95-vs-budget signal that decides whether
 *  PROJECT_LEARNINGS_TIMEOUT_MS should move. Fire-and-forget, never throws. */
function recordLearningsDeadline(meta: Record<string, unknown>, timeoutMs: number): void {
  void import('../platform/loop-metrics.service')
    .then(({ recordLoopMetric, LOOP_METRIC_KINDS }) => recordLoopMetric({
      kind: LOOP_METRIC_KINDS.MEMORY_SEARCH_TIMING,
      value: timeoutMs,
      meta: { purpose: 'project_learnings', phase: 'deadline', deadlineMs: timeoutMs, ...meta },
    }))
    .catch(() => undefined);
}

/** A learnings hit as rendered by the sub-block — the blended fields are optional
 *  so a plain MemHit (no provenance) renders too. */
export type ProjectLearningsHit = MemHit & Partial<Pick<MemBlendedHit, 'projectId' | 'projectName' | 'crossProject'>>;

/**
 * Query the unified store's PROJECT scope for ['learning','decision'] rows over
 * the user message, gated per user. Returns [] on unauthorized /
 * any failure / soft-deadline — callers never see an error.
 *
 * Primary scope = projectId + its RAG folder chain; the owned-project blend is
 * requested only when blendUserId is the CALLER (crossProjectMemory on). The
 * gate + blend + cross-project labelling live in memSearchProjectsBlended.
 */
export async function retrieveProjectLearnings(args: {
  userId: string;
  projectId: string;
  ragScopeIds: string[];
  /** The RAG blend key: userId when crossProjectMemory is on, else undefined. */
  blendUserId?: string;
  message: string;
  k?: number;
  timeoutMs?: number;
  /** Telemetry only: stamps the deadline row so user turns and wakes separate. */
  machine?: boolean;
  /** A plain chat in the hidden user space (userSpaceChatIsolated, 2026-10-20): the space itself is never searched —
   *  only the blend of the caller's REAL owned projects (nothing when the blend is off). */
  isolated?: boolean;
}): Promise<MemBlendedHit[]> {
  const { userId, projectId, message } = args;
  if (!userId || !projectId || !message?.trim()) return [];
  const timeoutMs = args.timeoutMs ?? projectLearningsTimeoutMs();
  let timer: NodeJS.Timeout | undefined;
  try {
    const inScope = args.isolated ? [] : [...new Set([projectId, ...(args.ragScopeIds || [])].filter((x) => typeof x === 'string' && x.length > 0))];
    // Owned-only blend, and only for the CALLER (a blend key naming anyone
    // else is refused — never another user's projects).
    const blendOwned = !!args.blendUserId && args.blendUserId === userId;
    if (args.isolated && !blendOwned) return [];
    const lookup = memSearchProjectsBlended(userId, inScope, message, args.k ?? PROJECT_LEARNINGS_K, {
      sources: [...PROJECT_LEARNINGS_SOURCES],
      blendOwned,
      ownedCap: PROJECT_LEARNINGS_BLEND_MAX_PROJECTS,
      // The hidden user space mixes the user's unrelated ungrouped chats — never blended into another chat (2026-10-20).
      ...(userSpaceIsolationDisabled() ? {} : { excludeUserSpace: true }),
      // Time-boxed search (unified-memory.service.ts, 2026-09-23): the search
      // itself respects the budget — embed fails fast, rerank is skipped when
      // little remains — so the race below is a backstop, not the usual exit.
      deadlineMs: Math.max(1000, timeoutMs - 250),
      purpose: 'project_learnings',
    });
    const deadline = new Promise<MemBlendedHit[]>((resolve) => {
      timer = setTimeout(() => {
        // Expected degradation, not a fault: info + a timing row (PE-12). The
        // p95 in memory_search_timing (purpose project_learnings) against
        // deadlineMs is the signal to tune PROJECT_LEARNINGS_TIMEOUT_MS.
        logger.info(`Pipeline project learnings: soft deadline ${timeoutMs}ms hit for project ${projectId} — skipping (non-fatal)`);
        recordLearningsDeadline({ projectId, machine: !!args.machine }, timeoutMs);
        resolve([]);
      }, timeoutMs);
    });
    return await Promise.race([lookup, deadline]);
  } catch (err: any) {
    logger.warn(`Pipeline project learnings failed (non-fatal): ${err?.message ?? err}`);
    return [];
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Render the '[PROJECT LEARNINGS & DECISIONS]' sub-block — '' when there are
 * no hits (so the knowledge block stays byte-identical). Each line:
 *   - (<source> · <ref>) <excerpt ≤300 chars>
 * Blended hits from another of the caller's OWNED projects carry a
 * 'from project "<name>"' marker (or 'other project' when the name is unknown)
 * so the model attributes them, mirroring the RAG arm. Provenance comes from
 * the blended hit's `crossProject`/`projectName`; a plain hit falls back to
 * "scopeId outside `inScopeIds`".
 */
export function buildProjectLearningsSubBlock(hits: ProjectLearningsHit[], inScopeIds: string[] = []): string {
  if (!hits?.length) return '';
  const inScope = new Set(inScopeIds);
  const lines: string[] = [];
  // Every hit foreign (an ungrouped chat's isolated lookup searches only the user's OTHER projects): say so in the header.
  const allForeign = hits.every((h) => (typeof h.crossProject === 'boolean' ? h.crossProject : (inScope.size > 0 && !!h.scopeId && !inScope.has(h.scopeId))));
  lines.push(`[${PROJECT_LEARNINGS_HEADER} — ${hits.length} durable note${hits.length > 1 ? 's' : ''} from ${allForeign ? "your other projects'" : "this project's"} coding memory]`);
  lines.push(
    `(Background only — use ONLY when directly relevant to the current message; conventions and past decisions that may be stale. ` +
    `Entries marked 'from project "…"' / 'other project' come from your OTHER projects — attribute them there; do NOT assume the current project covers those topics.)`
  );
  for (const h of hits) {
    const isForeign = typeof h.crossProject === 'boolean'
      ? h.crossProject
      : (inScope.size > 0 && !!h.scopeId && !inScope.has(h.scopeId));
    const foreign = isForeign ? (h.projectName ? ` · from project "${h.projectName}"` : ' · other project') : '';
    // memSearchProjectsBlended prefixes a '[Name]' label onto cross-project
    // titles for plain renderers — we carry the provenance in the marker, so
    // strip it here rather than print it twice.
    const title = (h.title || '').replace(isForeign ? /^\[[^\]]*\]\s*/ : /^$/, '').trim();
    // Learning rows carry a content-hash ref — show the human-meaningful origin
    // instead (same mapping as coding-retrieval.service).
    const ref = h.source === 'learning' ? 'learnings.md' : (h.ref || title || 'untitled').trim();
    const content = h.content || '';
    const body = (title && !content.trim().startsWith(title) ? `${title} — ${content}` : content)
      .replace(/\s+/g, ' ')
      .trim();
    const excerpt = body.length > PROJECT_LEARNINGS_EXCERPT_CHARS
      ? body.slice(0, PROJECT_LEARNINGS_EXCERPT_CHARS - 1).trimEnd() + '…'
      : body;
    lines.push(`- (${h.source} · ${ref}${foreign}) ${excerpt}`);
  }
  return lines.join('\n');
}

/**
 * Fleet-learnings retrieval for a PROJECTLESS supervisor chat (ticket
 * a6ba3fda, 2026-10-17). The project branch above is gated on projectId —
 * the Fleet Supervisor's own chat has projectId null, so its turns NEVER read
 * the durable L3 memory (digby_memory learning+decision rows) the rest of the
 * fleet sees. This runs the SAME gated blended search with NO primary project:
 * the scope is the CALLER's OWNED projects (ownedProjectIds, fail-closed) plus
 * the supervisor chat's OWN session/chat scope (authorizedMemScopes gate), over
 * learning+decision sources with the same soft deadline as project learnings.
 * Returns [] on any failure / soft deadline — never blocks a wake.
 */
export async function retrieveSupervisorLearnings(args: {
  userId: string;
  chatId: string;
  message: string;
  k?: number;
  timeoutMs?: number;
  /** Telemetry only: stamps the deadline row so user turns and wakes separate. */
  machine?: boolean;
}): Promise<MemBlendedHit[]> {
  const { userId, chatId, message } = args;
  if (!userId || !chatId || !message?.trim()) return [];
  const timeoutMs = args.timeoutMs ?? projectLearningsTimeoutMs();
  let timer: NodeJS.Timeout | undefined;
  try {
    const lookup = memSearchProjectsBlended(userId, [], message, args.k ?? PROJECT_LEARNINGS_K, {
      sources: [...PROJECT_LEARNINGS_SOURCES],
      // No primary project: the blend IS the scope — the caller's OWNED projects.
      blendOwned: true,
      ownedCap: PROJECT_LEARNINGS_BLEND_MAX_PROJECTS,
      // The supervisor chat's own durable scope rides along (session + chat
      // rows for this chat id, gated by authorizedMemScopes inside).
      extraScopes: [{ type: 'session', id: chatId }, { type: 'chat', id: chatId }],
      deadlineMs: Math.max(1000, timeoutMs - 250),
      purpose: 'fleet_learnings',
    });
    const deadline = new Promise<MemBlendedHit[]>((resolve) => {
      timer = setTimeout(() => {
        logger.info(`Pipeline fleet learnings: soft deadline ${timeoutMs}ms hit for chat ${chatId.slice(0, 8)} — skipping (non-fatal)`);
        recordLearningsDeadline({ fleet: true, chatId, machine: !!args.machine }, timeoutMs);
        resolve([]);
      }, timeoutMs);
    });
    return await Promise.race([lookup, deadline]);
  } catch (err: any) {
    logger.warn(`Pipeline fleet learnings failed (non-fatal): ${err?.message ?? err}`);
    return [];
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Render the '[FLEET LEARNINGS & DECISIONS]' block for a projectless
 * supervisor chat — the same line shape as buildProjectLearningsSubBlock, but
 * scoped to "your projects" (every hit is cross-project by construction: there
 * is no current project) and the supervisor's own chat scope.
 */
export function buildFleetLearningsBlock(hits: ProjectLearningsHit[]): string {
  if (!hits?.length) return '';
  const lines: string[] = [];
  lines.push(`[FLEET LEARNINGS & DECISIONS — ${hits.length} durable note${hits.length > 1 ? 's' : ''} from your projects' coding memory]`);
  lines.push(
    `(Background only — use ONLY when directly relevant to the current message; conventions and past decisions that may be stale. ` +
    `This chat has no project, so these come from the OWNER's other projects and this supervisor chat's own memory — attribute entries marked 'from project "…"' to that project; do NOT assume the current work covers those topics.)`
  );
  for (const h of hits) {
    // A project hit is foreign unless a future caller passes a primary set; a
    // chat/session-scope hit is never 'from project'.
    const isForeign = h.scopeType === 'project';
    const foreign = isForeign ? (h.projectName ? ` · from project "${h.projectName}"` : ' · other project') : '';
    const title = (h.title || '').replace(isForeign ? /^\[[^\]]*\]\s*/ : /^$/, '').trim();
    const ref = h.source === 'learning' ? 'learnings.md' : (h.ref || title || 'untitled').trim();
    const content = h.content || '';
    const body = (title && !content.trim().startsWith(title) ? `${title} — ${content}` : content)
      .replace(/\s+/g, ' ')
      .trim();
    const excerpt = body.length > PROJECT_LEARNINGS_EXCERPT_CHARS
      ? body.slice(0, PROJECT_LEARNINGS_EXCERPT_CHARS - 1).trimEnd() + '…'
      : body;
    lines.push(`- (${h.source} · ${ref}${foreign}) ${excerpt}`);
  }
  return lines.join('\n');
}

// ═══════════════════════════════════════════════════════════════════════════════
// LOAD CONTEXT (verbatim move; PipelineState arg → explicit LoadChatContextArgs)
// ═══════════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════════
// NODE 1: LOAD CONTEXT
// Loads enriched context (LangGraph memory + RAG + datetime) and builds
// the system context block that all models receive.
// ═══════════════════════════════════════════════════════════════════════════════

/** Everything loadChatContextNode needs — the legacy PipelineState context fields. */
export interface LoadChatContextArgs {
  userId: string | null;
  chatId: string | null;
  /** Anonymous session id (cm_session cookie) — used when userId is null. */
  sessionId?: string | null;
  message: string;
  mode: string;
  modelSet: string;
  /** Pre-fetched integration data (see integration-context.ts) injected into the system prompt. */
  additionalContext?: string;
  /**
   * Machine-wake run (schedule/hook firing): the history loaders return the
   * DEEPER window (up to 24 messages, char-bounded — context.service
   * MACHINE_WAKE_MAX_PAIRS) instead of the interactive ~10-20. Audit p10:
   * without this the final slice(-24) in chat-agent.service was a no-op.
   */
  machineWake?: boolean;
  /**
   * Orphan-recovery re-fire (ticket 68bc5aec): exclude ONE already-persisted
   * message row from the history load (the recovered turn's own user row).
   * Threaded to BOTH history loaders (getEnrichedContext + the direct
   * contextService.loadChatContext fallbacks) so every path honors it.
   */
  excludeMessageId?: string;
  /**
   * The text the RETRIEVAL legs (user-memory relevance, project learnings,
   * RAG chunks) embed and rerank — when it differs from `message`. Machine
   * wakes pass the PRE-preamble event/prompt text: the composed wake message
   * is 13–22k chars of freshness preamble + supervisor state + board digest,
   * and embedding + reranking THAT took 27 s on a live wake (audit
   * 2026-09-19 00:10Z) — the learnings lookup's 6 s soft deadline tripped on
   * ~50% of machine turns (≈15/h for 24 h) and the block was silently dropped.
   * `message` still drives history loading and the model prompt.
   */
  retrievalMessage?: string;
  /**
   * Supervisor-class chat (the Fleet Supervisor's chat, or a project
   * supervisor's own chat — chat-agent.service reads the row's
   * isSupervisor/isProjectSupervisor flags early, 2026-08-22). A PROJECTLESS
   * supervisor chat (projectId null — the Fleet Supervisor's shape) also reads
   * the durable L3 memory: blended digby_memory search over the CALLER's
   * OWNED projects + this chat's own scope (ticket a6ba3fda, 2026-10-17).
   */
  isSupervisorChat?: boolean;
  sendEvent?: SendEventFn;
}

/** The project retrieval scope both the RAG arm and the learnings lookup share. */
interface ProjectRetrievalScope {
  ragScopeIds: string[];
  crossProjectMemory: boolean;
  /** The RAG blend key: userId when crossProjectMemory is on AND the caller owns the project. */
  blendUserId: string | undefined;
}

/**
 * Resolve the folder chain + blend key for a project chat — ONE read shared by
 * the early learnings start (1a') and the RAG section (1c). Rejects like its
 * parts did (the RAG section's catch handles it); the early start swallows.
 */
async function resolveProjectRetrievalScope(projectId: string, userId: string | null): Promise<ProjectRetrievalScope> {
  const ragScopeIds = await getRagScopeFolderIds(projectId);
  const { crossProjectMemory } = await getProjectSettings(projectId);
  const blendUserId = crossProjectMemory && userId && (await ownsAllProjects(userId, [projectId])) ? userId : undefined;
  return { ragScopeIds, crossProjectMemory: !!crossProjectMemory, blendUserId };
}

async function loadChatContextNode(args: LoadChatContextArgs) {
  const { userId, chatId, message } = args;
  const retrievalMessage = (args.retrievalMessage || '').trim() || message;
  const sessionId = args.sessionId ?? undefined;
  const sendEvent: SendEventFn = args.sendEvent ?? (() => {});
  sendEvent('progress', { message: 'Preparing context...', stage: 'context' });

  // 1a. Determine project context early (needed for RAG)
  let projectId: string | null = null;
  let projectName: string | null = null;
  let projectSystemPrompt: string | null = null;
  let chatSystemPrompt: string | null = null;
  // A plain chat in the hidden user space keeps its own memory: no shared
  // project state, no project learnings / decisions (userSpaceChatIsolated).
  let projectMemoryIsolated = false;
  if (userId && chatId) {
    try {
      const chatRec = await prisma.crossModelChat.findUnique({
        where: { id: chatId },
        select: {
          projectId: true,
          systemPrompt: true, // per-chat custom instructions (project supervisors)
          project: { select: { id: true, name: true, systemPrompt: true, isUserSpace: true } },
        },
      });
      projectId = chatRec?.projectId || null;
      projectMemoryIsolated = !!projectId && userSpaceChatIsolated({ isUserSpace: chatRec?.project?.isUserSpace, isSupervisorChat: args.isSupervisorChat });
      projectName = chatRec?.project?.name || null;
      projectSystemPrompt = chatRec?.project?.systemPrompt || null;
      chatSystemPrompt = (chatRec?.systemPrompt || '').trim() || null;
      // P2 folder tree: nearest-ancestor inheritance — the folder's effective
      // system prompt is the chain's prompts concatenated root→leaf (flag on;
      // a root project is a chain of 1, so this is unchanged for it).
      if (projectId && foldersInheritanceOn()) {
        projectSystemPrompt = await getEffectiveSystemPrompt(projectId);
      }
      // Per-chat custom instructions (crossmodel_chats.systemPrompt) ride
      // AFTER the project chain — root→leaf→CHAT, chat last = highest
      // precedence. This is what lets a project Supervisor chat's doctrine
      // outrank the folder's instructions.
      if (chatSystemPrompt) {
        projectSystemPrompt = projectSystemPrompt ? `${projectSystemPrompt}\n\n${chatSystemPrompt}` : chatSystemPrompt;
      }
    } catch { /* non-critical */ }
  }

  // 1a'. Project learnings — EARLY START (backlog audit PE-12, 2026-09-28).
  // The lookup used to start inside the RAG section, AFTER the enriched-context
  // load (1b) had finished — so its whole soft deadline sat on the user's
  // critical path and the 6 s budget dropped the block on ~1 turn in 7. The
  // retrieval scope (folder chain + blend key) depends only on projectId, which
  // 1a already resolved, so both the scope reads and the gated store search now
  // start here and overlap the context load. The RAG section awaits the SAME
  // promises (no second read); a scope failure still surfaces in the RAG
  // section's own catch exactly as before, and the learnings promise itself
  // never rejects.
  let projectScopePromise: Promise<ProjectRetrievalScope> | null = null;
  let earlyLearnings: Promise<MemBlendedHit[]> | null = null;
  if (userId && chatId && projectId && projectName) {
    const pid = projectId;
    projectScopePromise = resolveProjectRetrievalScope(pid, userId);
    projectScopePromise.catch(() => undefined); // handled where it is awaited (RAG section)
    earlyLearnings = projectScopePromise
      .then(({ ragScopeIds, blendUserId }) => retrieveProjectLearnings({
        userId, projectId: pid, ragScopeIds, blendUserId, message: retrievalMessage, machine: !!args.machineWake,
        ...(projectMemoryIsolated ? { isolated: true } : {}),
        ...(args.machineWake ? { timeoutMs: MACHINE_WAKE_CONTEXT_TIMEOUT_MS } : {}),
      }))
      .catch(() => [] as MemBlendedHit[]);
  }

  // 1b. Load enriched context via LangGraph (or fallback)
  let conversationHistory: ConversationMessage[] = [];
  let memoryContext: string | undefined;
  let langGraphProjectStateBlock = '';

  if (userId) {
    // Circuit breaker: if getEnrichedContext has failed 3+ consecutive times,
    // skip it entirely for 60s and go straight to direct DB load. This prevents
    // every query from waiting 15s for a timeout when PostgresStore is down/slow.
    if (isCircuitBreakerOpen()) {
      logger.info('Pipeline loadContext: circuit breaker OPEN — skipping getEnrichedContext, using direct DB load');
      if (chatId) {
        const ctx = await contextService.loadChatContext(chatId, userId, retrievalMessage, { deepHistory: args.machineWake, excludeMessageId: args.excludeMessageId });
        conversationHistory = ctx.conversationHistory;
        memoryContext = ctx.userMemoryBlock || undefined;
      }
    } else {
      const CONTEXT_TIMEOUT_MS = args.machineWake ? MACHINE_WAKE_CONTEXT_TIMEOUT_MS : USER_TURN_CONTEXT_TIMEOUT_MS;
      try {
        // Wrap getEnrichedContext in a timeout to prevent indefinite blocking
        // when PostgresStore is slow or the DB is under load. Without this,
        // multiple concurrent queries can all block waiting for context,
        // causing cascading timeouts across the entire pipeline.
        // 2026-06-10: Reverted from 8s back to 5s, but increased circuit breaker threshold
        // from 5 to 8 (see top of file). The 8s timeout meant each slow request blocked
        // for a long time before failing. With threshold=8, we now tolerate more individual
        // slow requests at the shorter 5s timeout without prematurely opening the circuit.
        // Net effect: fail-fast (5s) with more patience (8 failures before circuit opens).
        // Rollout watch 2026-09-14 (tick 8): the 5s deadline tripped 2–6×/hour
        // for 30h straight ("getEnrichedContext timed out after 5000ms") and a
        // MACHINE wake that trips it silently loses its [PROJECT MEMORY] /
        // project-state injection — the whole point of the unified memory —
        // while no user is waiting on the latency. Machine wakes (deepHistory,
        // heavier by construction) get a 15s deadline; user turns keep the 5s
        // fail-fast. Both still feed the circuit breaker below. (Declared before
        // the try so the catch can name the deadline it missed.)
        // The deadline timer is cleared once the race settles — it used to
        // linger for the full 5s after every fast context load (one dangling
        // timer per chat turn; also what kept jest alive after the wiring tests).
        let contextTimer: NodeJS.Timeout | undefined;
        const enrichedCtx = await Promise.race([
          getEnrichedContext({
            userId,
            chatId: chatId || null,
            projectId,
            userMessage: retrievalMessage,
            deepHistory: args.machineWake,
            excludeMessageId: args.excludeMessageId,
            ...(projectMemoryIsolated ? { skipProjectState: true } : {}),
          }),
          new Promise<never>((_, reject) => {
            contextTimer = setTimeout(() => reject(new Error(`getEnrichedContext timed out after ${CONTEXT_TIMEOUT_MS}ms`)), CONTEXT_TIMEOUT_MS);
          }),
        ]).finally(() => { if (contextTimer) clearTimeout(contextTimer); });
        conversationHistory = enrichedCtx.conversationHistory;
        memoryContext = enrichedCtx.userMemoryBlock || undefined;
        langGraphProjectStateBlock = enrichedCtx.projectStateBlock;
        recordContextSuccess(); // Reset circuit breaker on success
        logger.info(
          `Pipeline loadContext: historyLen=${conversationHistory.length}, ` +
          `hasUserMem=${!!memoryContext}, hasProjectState=${!!langGraphProjectStateBlock}`
        );

        // Safety fallback: if LangGraph returned empty history but we have a chatId,
        // the PostgresStore or loadConversationNode may have silently failed.
        // Fall back to direct DB load to ensure conversation context is never lost.
        // (Fix: context lost when switching between patience modes — v174)
        // PE-12 (2026-09-28): an empty history is ALSO the normal first message
        // of a new chat — every sampled "returned empty history" warn in prod
        // (12/12 over 48 h) was one. Warn only when the direct load then finds
        // messages (a real loss, recovered); a genuinely empty chat is debug.
        if (conversationHistory.length === 0 && chatId) {
          const fallbackCtx = await contextService.loadChatContext(chatId, userId, retrievalMessage, { deepHistory: args.machineWake, excludeMessageId: args.excludeMessageId });
          if (fallbackCtx.conversationHistory.length > 0) {
            conversationHistory = fallbackCtx.conversationHistory;
            logger.warn(`Pipeline loadContext: LangGraph returned empty history for chat ${chatId} but the DB holds ${conversationHistory.length} message(s) — recovered via direct DB load`);
          } else {
            logger.debug(`Pipeline loadContext: no prior messages for chat ${chatId} (first turn) — nothing to recover`);
          }
        }
      } catch (err: any) {
        recordContextFailure(); // Track failure for circuit breaker
        // One string, not a splat: the second argument used to land in the
        // structured `context` column as a spread char-array and the message
        // read "…using basic:" with no cause in the log table.
        logger.warn(`Pipeline: LangGraph context failed, using basic (chat ${chatId ? chatId.slice(0, 8) : '-'}, ${args.machineWake ? 'machine wake' : 'user turn'}, deadline ${CONTEXT_TIMEOUT_MS}ms): ${err?.message ?? err}`);
        if (chatId) {
          const ctx = await contextService.loadChatContext(chatId, userId, retrievalMessage, { deepHistory: args.machineWake, excludeMessageId: args.excludeMessageId });
          conversationHistory = ctx.conversationHistory;
          memoryContext = ctx.userMemoryBlock || undefined;
        }
      }
    }
  } else if (sessionId) {
    const anonCtx = await contextService.loadSessionContext(sessionId);
    conversationHistory = anonCtx.conversationHistory;
    memoryContext = anonCtx.userMemoryBlock || undefined;
  }

  // 1c. RAG context injection for project chats
  let retrievedSources: RetrievedChunk[] = [];
  let systemContext = memoryContext;

  if (userId && chatId && projectId && projectName) {
    try {
      // P2 folder tree: retrieval scopes to the folder + its ancestors
      // (knowledge filed at "Work" is visible in "Work/Client A"). Flag on →
      // the ancestor chain ids; off → [projectId] (pre-P2 behavior).
      //
      // Blended account-wide RAG (owner decision 2026-08-13): retrieval also
      // blends in the user's OTHER owned projects — in-scope chunks boosted,
      // outsiders capped + labeled with their source project (rag.service).
      // The doc-count gate widens accordingly: the relevant docs may live
      // entirely in another owned project. Isolation: never another user's
      // docs; member-shared projects surface only via the in-scope arm.
      // crossProjectMemory (default ON, owner 2026-09-08): the blend is the
      // default; an explicit OFF is a real opt-out — the userId blend key is
      // withheld so retrieveChunks runs the exact pre-blend scoped behavior
      // and the doc-count gate drops its cross-project arm. (Previously the
      // 2026-08-13 blend ignored the toggle entirely — "off" silently blended.)
      // Blend the caller's OTHER projects only when they OWN this one (EOD
      // review 2026-09-14): a member's private projects must never be pulled
      // into a shared project's context that the owner and others also read.
      // (Scope resolution lives in resolveProjectRetrievalScope; the early-
      // start block above may already hold the promise — one read either way.)
      const { ragScopeIds, blendUserId } = await (projectScopePromise ?? resolveProjectRetrievalScope(projectId, userId));
      // Project learnings & decisions (owner 2026-09-14): the coding side's
      // durable memory (digby_memory project scope, sources 'learning' +
      // 'decision') rides into the knowledge block. Started in 1a' (early
      // start) so it overlaps the enriched-context load AND the doc-count +
      // RAG round-trips; per-user gated inside (scopes = this folder chain ∪
      // the caller's OWNED projects when the blend is on, each run through
      // memory-access before the query). Never rejects. Machine wakes get the
      // same 15 s patience the enriched-context load has (no user waits on a
      // wake); user turns take projectLearningsTimeoutMs() (10 s default,
      // PE-12 — the misses are DashScope queueing spikes, not the query).
      const learningsPromise = earlyLearnings ?? retrieveProjectLearnings({
        userId, projectId, ragScopeIds, blendUserId, message: retrievalMessage, machine: !!args.machineWake,
        ...(projectMemoryIsolated ? { isolated: true } : {}),
        ...(args.machineWake ? { timeoutMs: MACHINE_WAKE_CONTEXT_TIMEOUT_MS } : {}),
      });
      const docCount = await prisma.projectDocument.count({
        where: {
          status: 'ready',
          OR: [{ projectId: { in: ragScopeIds } }, ...(blendUserId ? [{ userId: blendUserId, projectId: { not: null } }] : [])],
        },
      });
      if (docCount > 0) {
        sendEvent('progress', { message: 'Searching project knowledge...', stage: 'rag' });
        // RAG is open-source-only — always DashScope text-embedding-v4 (both model sets).
        const ragEmbeddingProvider: EmbeddingProvider = 'dashscope';
        retrievedSources = await retrieveChunks(retrievalMessage, projectId, 5, ragEmbeddingProvider, ragScopeIds.slice(0, -1), blendUserId);
        logger.info(`Pipeline RAG: ${retrievedSources.length} chunks for project ${projectId} (scope: ${ragScopeIds.length} folder(s)${blendUserId ? ' + owned-project blend' : ', ISOLATED (crossProjectMemory off)'}, embeddings: ${ragEmbeddingProvider})`);
      }

      // '[PROJECT LEARNINGS & DECISIONS]' sub-block — appended INSIDE the
      // project knowledge block (buildContextBlock's trailing free-text slot,
      // before the closing rule) only when non-empty; `undefined` keeps the
      // block byte-identical to the pre-2026-09-14 output otherwise.
      const learningHits = await learningsPromise;
      const learningsSubBlock = buildProjectLearningsSubBlock(learningHits, [projectId, ...ragScopeIds]);
      if (learningsSubBlock) {
        logger.info(`Pipeline project learnings: ${learningHits.length} hit(s) for project ${projectId} (sources: ${[...new Set(learningHits.map((h) => h.source))].join(',')}${blendUserId ? ' + owned-project blend' : ''})`);
      }
      const ragBlock = buildContextBlock(projectName, projectSystemPrompt, retrievedSources, learningsSubBlock || undefined);
      const projectContextParts: string[] = [ragBlock];
      if (langGraphProjectStateBlock) projectContextParts.push(langGraphProjectStateBlock);
      const combinedProjectContext = projectContextParts.filter(Boolean).join('\n\n');

      systemContext = memoryContext
        ? `${combinedProjectContext}\n\n═══ USER MEMORY (background — use ONLY if directly relevant) ═══\nCAUTION: loose facts saved across past sessions — possibly stale, partial, or about a DIFFERENT company/venture/person than the current message. NEVER assert who an unnamed person is (or attach a name from these facts to someone the user mentions) unless the user's own words establish it — if identity matters and the message doesn't name them, ASK instead of guessing.\n${memoryContext}\n═══════════════════`
        : combinedProjectContext;
    } catch (err: any) {
      logger.warn('Pipeline RAG failed:', err.message);
      if (langGraphProjectStateBlock) {
        systemContext = memoryContext
          ? `${langGraphProjectStateBlock}\n\n═══ USER MEMORY (background — use ONLY if directly relevant) ═══\nCAUTION: loose facts saved across past sessions — possibly stale, partial, or about a DIFFERENT company/venture/person than the current message. NEVER assert who an unnamed person is (or attach a name from these facts to someone the user mentions) unless the user's own words establish it — if identity matters and the message doesn't name them, ASK instead of guessing.\n${memoryContext}\n═══════════════════`
          : langGraphProjectStateBlock;
      }
    }
  } else if (userId) {
    // Account-wide RAG for a chat with NO project (blended-RAG bonus, owner
    // decision 2026-08-13): the user's knowledge base follows them into plain
    // sidebar chats — retrieval covers every project THEY OWN, each chunk
    // labeled with its source project. Never another user's docs and never
    // member-shared projects (those stay in-project); anonymous sessions and
    // Digby Kids are untouched (kids never reach this pipeline).
    //
    // Fleet-learnings for PROJECTLESS supervisor chats (ticket a6ba3fda,
    // 2026-10-17): the project branch above never runs when projectId is null,
    // so a supervisor's turns never read the durable L3 memory (digby_memory
    // learning+decision rows). The same gated blended search now runs here —
    // scope = the CALLER's OWNED projects + this chat's own session/chat scope.
    const supervisorChat = !!(args.isSupervisorChat && chatId);
    const fleetLearningsPromise = supervisorChat
      ? retrieveSupervisorLearnings({
          userId, chatId: chatId!, message: retrievalMessage,
          ...(args.machineWake ? { timeoutMs: MACHINE_WAKE_CONTEXT_TIMEOUT_MS } : {}),
          machine: !!args.machineWake,
        }).catch(() => [] as MemBlendedHit[])
      : null;
    let globalRagBlock = '';
    try {
      const docCount = await prisma.projectDocument.count({
        where: { userId, status: 'ready', projectId: { not: null } },
      });
      if (docCount > 0) {
        sendEvent('progress', { message: 'Searching your knowledge base...', stage: 'rag' });
        // retrievalMessage, NOT the raw message (ticket a6ba3fda): every other
        // retrieval leg embeds the pre-preamble text; this leg was the lone
        // holdout embedding the composed 13–22k-char machine-wake text.
        retrievedSources = await retrieveGlobalChunks(retrievalMessage, userId, 5, 'dashscope');
        if (retrievedSources.length > 0) {
          globalRagBlock = buildCrossProjectBlock(retrievedSources, 'RELEVANT CONTEXT FROM YOUR PROJECTS');
          logger.info(`Pipeline global RAG (no-project chat): ${retrievedSources.length} chunk(s) across owned projects`);
        }
      }
    } catch (err: any) {
      logger.warn('Pipeline global RAG failed:', err.message);
    }
    // Fleet-learnings block (ticket a6ba3fda): awaited AFTER the doc-RAG leg so
    // the two retrieval legs overlap; a soft deadline or store failure yields
    // '' and the chat context builds exactly as before.
    let fleetLearningsBlock = '';
    if (fleetLearningsPromise) {
      try {
        const fleetHits = await fleetLearningsPromise;
        fleetLearningsBlock = buildFleetLearningsBlock(fleetHits);
        if (fleetLearningsBlock) {
          logger.info(`Pipeline fleet learnings: ${fleetHits.length} hit(s) for supervisor chat ${chatId!.slice(0, 8)} (sources: ${[...new Set(fleetHits.map((h) => h.source))].join(',')})`);
        }
      } catch { /* never blocks the turn */ }
    }
    const globalParts = [globalRagBlock, fleetLearningsBlock, langGraphProjectStateBlock].filter(Boolean);
    if (globalParts.length) {
      const combinedGlobalContext = globalParts.join('\n\n');
      systemContext = memoryContext
        ? `${combinedGlobalContext}\n\n═══ USER MEMORY (background — use ONLY if directly relevant) ═══\nCAUTION: loose facts saved across past sessions — possibly stale, partial, or about a DIFFERENT company/venture/person than the current message. NEVER assert who an unnamed person is (or attach a name from these facts to someone the user mentions) unless the user's own words establish it — if identity matters and the message doesn't name them, ASK instead of guessing.\n${memoryContext}\n═══════════════════`
        : combinedGlobalContext;
    }
  } else if (langGraphProjectStateBlock) {
    systemContext = memoryContext
      ? `${langGraphProjectStateBlock}\n\n═══ USER MEMORY (background — use ONLY if directly relevant) ═══\nCAUTION: loose facts saved across past sessions — possibly stale, partial, or about a DIFFERENT company/venture/person than the current message. NEVER assert who an unnamed person is (or attach a name from these facts to someone the user mentions) unless the user's own words establish it — if identity matters and the message doesn't name them, ASK instead of guessing.\n${memoryContext}\n═══════════════════`
      : langGraphProjectStateBlock;
  }

  // ── Supervisor run journal — READ side (ticket 9993f30c, 2026-10-18) ──────
  // A supervisor chat's own journal (written per turn by the chat-agent
  // finalize) injected into supervisor turns — the last 10 entries under
  // SUPERVISOR_JOURNAL_BLOCK_CAP — so the supervisor READS what its earlier
  // turns did (and the receipt ids that back them) instead of recalling it
  // from a compacted transcript. Placed AFTER the project/no-project branch
  // chain so it covers BOTH supervisor shapes (project supervisor with a
  // projectId, and the projectless Fleet Supervisor).
  // MACHINE wakes are EXCLUDED here (review M1, 88d85d8e): a machine wake
  // already carries the block composed into its persisted wake message by
  // startDetachedChatRun's supervisorStateBlock — injecting here too would
  // double the block (2 × 4000 chars) and double the DB read on the hottest
  // lane (the laneBoardSystemBlock !machineWake precedent at the owner-turn
  // seam). This seam serves HUMAN/owner-typed turns and every context
  // rebuild that is not a machine wake.
  // Dynamic import + fail-open: a failed read leaves the context exactly as
  // before; kill switch SUPERVISOR_RUN_JOURNAL_DISABLED=1.
  if (args.isSupervisorChat && !args.machineWake && chatId && process.env.SUPERVISOR_RUN_JOURNAL_DISABLED !== '1') {
    try {
      const journalMod: any = await import('../coding/run-journal.service').catch(() => null);
      if (typeof journalMod?.buildSupervisorJournalBlock === 'function') {
        const supervisorJournalBlock = await journalMod.buildSupervisorJournalBlock(chatId).catch(() => '');
        if (supervisorJournalBlock) {
          systemContext = systemContext
            ? `${supervisorJournalBlock}\n\n${systemContext}`
            : supervisorJournalBlock;
        }
      }
    } catch { /* the journal block is best-effort — never blocks the turn */ }
  }

  // Ticket 2b8508cb — [SUPERVISOR STATE (retrieved)] for HUMAN/owner-typed
  // supervisor turns (and every non-machine context rebuild): the same
  // semantic recall over the embedded doc rows (source `supervisor_state`)
  // the machine-wake compose path gets, keyed to THIS turn's message.
  // Covers BOTH supervisor shapes (project supervisor + projectless Fleet
  // Supervisor) exactly like the journal block above. A failed read leaves
  // the context exactly as before; kill switch SUPERVISOR_STATE_RECALL_DISABLED=1.
  if (args.isSupervisorChat && !args.machineWake && chatId && process.env.SUPERVISOR_STATE_RECALL_DISABLED !== '1') {
    try {
      const memMod: any = await import('../platform/supervisor-state-memory').catch(() => null);
      if (typeof memMod?.buildSupervisorStateRecallBlock === 'function') {
        const supervisorStateRecall = await memMod.buildSupervisorStateRecallBlock(chatId, retrievalMessage, 5).catch(() => '');
        if (supervisorStateRecall) {
          systemContext = systemContext
            ? `${supervisorStateRecall}\n\n${systemContext}`
            : supervisorStateRecall;
        }
      }
    } catch { /* the recall block is best-effort — never blocks the turn */ }
  }

  // Per-chat custom instructions for a chat with NO project (project chats get
  // theirs merged after the folder chain inside buildContextBlock's
  // [Custom Instructions] — a project-less chat would otherwise drop it).
  if (!projectId && chatSystemPrompt) {
    const chatPromptBlock = `═══ CUSTOM INSTRUCTIONS ═══\n${chatSystemPrompt}\n═══════════════════`;
    systemContext = systemContext ? `${systemContext}\n\n${chatPromptBlock}` : chatPromptBlock;
  }

  // 1d. Inject datetime — extract user's timezone from memory context for accurate
  // "today"/"tomorrow" calculations (fixes wrong-day bug for calendar events).
  let userTimezone: string | undefined;
  if (memoryContext) {
    const tzMatch = memoryContext.match(/[-\s]timezone:\s*([^\n]+)/i);
    if (tzMatch) userTimezone = tzMatch[1].trim();
  }
  // Dual-clock rendering rule rides along whenever the tz is known (63698528).
  // The tz comes from a memory-text regex, so validate before NAMING it in the
  // rule (buildDateTimeBlock already skips the local block for garbage zones).
  let validTz: string | undefined = userTimezone;
  if (validTz) {
    try { new Intl.DateTimeFormat('en-US', { timeZone: validTz }); } catch { validTz = undefined; }
  }
  const dateTimeBlock = buildDateTimeBlock(userTimezone, validTz ? dualTimestampRule(validTz) : undefined);
  systemContext = systemContext ? `${dateTimeBlock}\n\n${systemContext}` : dateTimeBlock;

  // 1d-bis. The owner's FLEET NOTICE (platform/fleet-notice.ts): one owner-written
  // block every agent of this user reads — plain chats, project supervisors and
  // the Fleet Supervisor all build their context here. Cached 60 s, never throws.
  if (userId) {
    const fleetNotice = await fleetNoticeBlockFor(userId).catch(() => '');
    if (fleetNotice) systemContext = `${fleetNotice}\n\n${systemContext}`;
  }

  // 1e. Inject additional context (e.g. Google Workspace data pre-fetched by controller)
  if (args.additionalContext) {
    systemContext = `${systemContext}\n\n${args.additionalContext}`;
  }

  // 1e-bis. This chat's uploads (ticket 6e15a4c8): auto-inject the compact
  // file list so answers PROACTIVELY include the media/files the user shared
  // in this chat — previously the agent only embedded an upload if it
  // spontaneously called list_files. Metadata only (names + owner-auth'd
  // serve URLs); bytes never re-enter context. The renderer promotes the
  // URLs to inline images / download cards. L2's checker embeds
  // ctx.systemContext too, so the same list reaches the ensemble.
  if (chatId && userId) {
    try {
      const chatUploads = await prisma.chatFile.findMany({
        where: { chatId },
        orderBy: { createdAt: 'desc' },
        take: 12,
        select: { id: true, filename: true, mimeType: true, sizeBytes: true },
      });
      const uploadsBlock = buildChatUploadsBlock(chatUploads);
      if (uploadsBlock) {
        systemContext = `${systemContext}\n\n${uploadsBlock}`;
      }
    } catch (err: any) {
      logger.warn('Pipeline chat-uploads block failed:', err.message);
    }
  }

  // 1f. Inject shared AI rules into ALL initial model queries.
  // These rules go at the END of systemContext so they're the most proximate instruction
  // to the model when it generates its initial response (before synthesis).
  // Fix: severity-2 bug where all 3 initial models agreed on wrong model-version claims
  // and the synthesizer couldn't correct consensus. Now ALL models get the rule upfront.
  systemContext = `${systemContext}\n\n${SHARED_AI_RULES}`;

  // 1g. Inject model context window information so models know their capabilities.
  // In thinking mode, models should know their context window sizes and output limits
  // to properly manage response length and avoid unnecessary truncation.
  const modelContextBlock = buildModelContextBlock(args.mode, args.modelSet);
  systemContext = `${systemContext}\n\n${modelContextBlock}`;

  // 1h. Inject Digby platform identity so models know what Digby is and what it can do.
  // Without this, models hallucinate or give wrong answers when users ask about
  // Digby's capabilities, integrations, or features. (Fix: "you have workspace integrations for me")
  systemContext = `${systemContext}\n\n${DIGBY_PLATFORM_IDENTITY}`;
  // 1h'. Self-host setup hardening (2026-10-20): the identity above promises web
  // search on every question. On a NON-production instance with no search
  // backend that promise is false — append the honest override so the model
  // never narrates a search it cannot run (production is never "missing").
  if (webSearchMissingOnInstance()) {
    systemContext = `${systemContext}\n\n${WEB_SEARCH_UNCONFIGURED_IDENTITY_NOTE}`;
  }

  // 1i. Inject dynamic integration status — tells models which integrations THIS user
  // has connected vs. available. Enables accurate personalized answers like
  // "You have Google Workspace connected. You can also connect Xero, Plaid, Slack, and Asana."
  const integrationStatusBlock = await buildIntegrationStatusBlock(userId);
  if (integrationStatusBlock) {
    systemContext = `${systemContext}\n\n${integrationStatusBlock}`;
  }

  // 1j. Follow-up reference enrichment — MUST run BEFORE truncation (needs full history).
  // When the user asks a short follow-up like "what's Teranet?" referencing something
  // the AI said in its previous response, inject the relevant context from the full
  // (pre-truncation) assistant message into systemContext so all models understand
  // what the user is asking about in the conversation's context.
  // Fix for: "you said teranet for colocation..then i asked whats teranet...makes no sense"
  //
  // TWO-PRONGED approach (v187):
  //   1. Inject context into systemContext (belt) — models see it in system prompt
  //   2. Update the `message` field itself (suspenders) — models see the context
  //      directly in the user message they're answering, which is much harder to ignore.
  //      This also flows to synthesizeNode so the synthesis prompt includes the context.
  //
  // Previously only (1) was done, but models often ignored systemContext and answered
  // "what's Teranet?" from training data (Ontario land registry) instead of the
  // conversation context (colocation provider). By putting the context inline in the
  // user message, all 3 models AND the synthesizer see it as part of the question.
  // 1j-pre. Truncation continuation detection (v265) — BEFORE follow-up reference enrichment.
  // When user says "your response stopped short", "you got cut off", etc., enrich the message
  // with the previous (truncated) response so models continue from where it stopped
  // instead of restarting from scratch and repeating everything.
  const truncationEnriched = enrichTruncationContinuation(message, conversationHistory);
  const effectiveMessage = truncationEnriched !== message ? truncationEnriched : message;

  const enrichedMessage = enrichFollowUpReference(effectiveMessage, conversationHistory);
  let queryMessage = effectiveMessage; // the message that will be sent to models and synthesizer
  if (enrichedMessage !== effectiveMessage) {
    // The enrichment found a reference — inject into BOTH systemContext AND message
    const contextAddendum = enrichedMessage.substring(effectiveMessage.length);
    systemContext = `${systemContext}\n\n[FOLLOW-UP REFERENCE CONTEXT — CRITICAL]\nThe user's current message appears to reference something from your previous response in this conversation.${contextAddendum}\n[/FOLLOW-UP REFERENCE CONTEXT]`;
    // Also update the message itself so models see the context inline
    queryMessage = enrichedMessage;
  }

  // 1k. Truncate long assistant messages in conversation history.
  // After deep reasoning / thinking mode, assistant messages can be 5,000–10,000+ chars.
  // Passing these as-is to the next query's models and synthesizer overwhelms the context
  // and causes the synthesizer to confuse previous response content with the current
  // question's model responses — producing nonsensical answers.
  // Fix for: "next question after deep reasoning in a conversation makes no sense"
  conversationHistory = truncateHistoryAssistantMessages(conversationHistory);

  return {
    conversationHistory,
    memoryContext,
    systemContext,
    retrievedSources,
    projectId,
    projectName,
    projectSystemPrompt,
    projectMemoryIsolated,
    message: queryMessage, // enriched message flows to queryModelsNode and synthesizeNode
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Public API
// ═══════════════════════════════════════════════════════════════════════════════

// ─── One-Digby Phase 2 (step 3): shared context + canvas helpers ─────────────
// The agent chat engine calls these so RAG, memory facts, SHARED_AI_RULES,
// datetime, platform identity, integration status, and follow-up enrichment are
// BIT-IDENTICAL across the legacy pipeline and the agent engine.

export interface ChatQueryContext {
  systemContext: string;
  conversationHistory: ConversationMessage[];
  retrievedSources: RetrievedChunk[];
  projectId: string | null;
  projectName: string | null;
  /** A plain chat in the hidden user space: it read no project memory, and must write none (updateContextAsync skipProjectState). */
  projectMemoryIsolated?: boolean;
  /** message after truncation-continuation + follow-up-reference enrichment */
  queryMessage: string;
}

export async function buildChatQueryContext(args: {
  userId: string | null;
  chatId: string | null;
  message: string;
  mode: string;
  modelSet: string;
  additionalContext?: string;
  /** Anonymous session id (cm_session cookie) — required for context when userId is null. */
  sessionId?: string | null;
  /** Machine-wake run — history loaders return the deeper window (see LoadChatContextArgs). */
  machineWake?: boolean;
  /** Orphan-recovery re-fire — exclude this already-persisted row from history (see LoadChatContextArgs). */
  excludeMessageId?: string;
  /** Text the retrieval legs embed/rerank instead of `message` (machine wakes: the pre-preamble event text — see LoadChatContextArgs). */
  retrievalMessage?: string;
  /** Supervisor-class chat — a projectless supervisor chat also reads durable L3 memory (see LoadChatContextArgs). */
  isSupervisorChat?: boolean;
}): Promise<ChatQueryContext> {
  const out = await loadChatContextNode({
    userId: args.userId,
    chatId: args.chatId,
    sessionId: args.sessionId ?? null,
    message: args.message,
    mode: args.mode,
    modelSet: args.modelSet,
    additionalContext: args.additionalContext,
    machineWake: args.machineWake,
    excludeMessageId: args.excludeMessageId,
    retrievalMessage: args.retrievalMessage,
    isSupervisorChat: args.isSupervisorChat,
  });
  return {
    systemContext: out.systemContext || '',
    conversationHistory: out.conversationHistory || [],
    retrievedSources: out.retrievedSources || [],
    projectId: out.projectId ?? null,
    projectName: out.projectName ?? null,
    projectMemoryIsolated: out.projectMemoryIsolated === true,
    queryMessage: out.message || args.message,
  };
}

/** Persist parsed [CANVAS:] artifacts and emit `canvas` SSE events with real DB ids. */
export async function persistAndEmitCanvases(args: {
  userId: string | null | undefined;
  chatId: string | null | undefined;
  parsedCanvases: Array<{ type: string; language?: string | null; title: string; content: string }>;
  sendEvent: (type: string, data: any) => void;
}): Promise<string[]> {
  const { userId, chatId, parsedCanvases, sendEvent } = args;
  const savedCanvasIds: string[] = [];
  if (userId && chatId && parsedCanvases.length > 0) {
    try {
      const savedCanvases = await Promise.all(
        parsedCanvases.map(canvas =>
          prisma.canvasDocument.create({
            data: {
              chatId,
              userId,
              title: canvas.title,
              type: canvas.type,
              language: canvas.language || null,
              content: canvas.content,
              version: 1,
            },
          })
        )
      );
      savedCanvasIds.push(...savedCanvases.map((c: { id: string }) => c.id));
      logger.info(`Saved ${parsedCanvases.length} canvas(es) for chat ${chatId}`);
    } catch (err) {
      logger.error('Failed to save canvas documents:', err);
    }
  }
  for (let i = 0; i < parsedCanvases.length; i++) {
    const canvas = parsedCanvases[i];
    sendEvent('canvas', {
      type: canvas.type,
      language: canvas.language || null,
      title: canvas.title,
      content: canvas.content,
      id: savedCanvasIds[i] || null,
    });
    logger.info(`Canvas emitted: type=${canvas.type}, title="${canvas.title}", len=${canvas.content.length}, dbId=${savedCanvasIds[i] || 'none'}`);
  }
  return savedCanvasIds;
}
