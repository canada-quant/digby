/**
 * Digby Code — in-loop context compaction.
 *
 * A 40-step run accumulates a large message array (every tool result — up to 8k
 * chars — stays in context). Left unbounded it overflows the model's window. When
 * the running transcript exceeds the budget we summarize the middle into a recap
 * and keep the system prompt + the most-recent turns verbatim.
 *
 * The recent cut is advanced past any leading tool result so a tool response is
 * never orphaned from its assistant tool_call — OpenAI-compatible providers
 * (GLM/DeepSeek/Kimi) reject an orphaned tool message.
 */

import { utilityChat } from '../../../utils/utility-llm';
import logger from '../../../utils/logger';
import { recordLoopMetric, LOOP_METRIC_KINDS } from '../platform/loop-metrics.service';
import { storeFindings } from './coding-retrieval.service';
// Ticket f03b739c: compacted-away tool results (a raw BrightData SERP body —
// base64 icons, sxsrf/fbs tokens, pagination arrays) must not embed their
// scaffolding into session memory either; a failed search surface embeds a
// compact error record instead. Pure + kill-switched inside the module.
import { sanitizeForMemoryEmbed, failedSearchCompactRecord } from './serp-memory-sanitize';
import { imagePlaceholder } from './chat-images';

export const CONTEXT_CHAR_BUDGET = 90_000; // ~22k tokens of running transcript
export const KEEP_RECENT_MSGS = 8;         // most-recent turns kept verbatim on compaction
export const PER_MSG_CHAR_CAP = 14_000;    // hard cap for any single message's content (recovery)
/** System prompts are clip-EXEMPT below this pathological valve (see the
 *  clipOversizedMessages doc): a real composed coding-lane prompt tops out
 *  around ~50k chars, so 200k only trips on a genuinely malformed compose
 *  (e.g. a megabyte-sized chat-instructions paste) and keeps size-rejection
 *  recovery able to shrink even that. */
export const SYSTEM_MSG_CHAR_CAP = 200_000;
/** The FIRST user-role message is the run's TASK — for a machine wake it is the
 *  whole wake prompt (board digest + hook payload + doctrine; every supervisor
 *  wake measured 20–27k chars in prod, 2026-09-24). Like the system prompt it is
 *  recoverable from NOWHERE once clipped, so it rides its own cap (a valve for a
 *  pathological paste, not a working limit). */
export const FIRST_USER_MSG_CHAR_CAP = 60_000;
export const IMAGE_PART_CHAR_WEIGHT = 1_500; // fixed weight of one image_url part (the base64 itself is never counted)

// ── Compaction v2 (remediation P6 — v1#18/#34, sparks B1/G2) ─────────────────
// The v1 shape was dishonest at scale: the summarizer saw only the OLDEST 14k
// of the compacted middle, the memory offload stored ONE item silently cut to
// the first 40k of a possibly ~700k middle, the recap claimed "FULL detail…
// embedded" regardless, and the next compaction STRIPPED that recap on the
// false premise. v2: per-chunk head+tail offload with honest stored-N-of-M
// accounting, tail-weighted summarizer input carrying every tool-call name,
// strict (strippable) recap marker only when ≥80% of the middle really stored,
// and an earlier trigger (70% of budget) compacting the oldest THIRD instead
// of one 100% cliff. Kill switch: COMPACTION_V2_DISABLED=1 restores the old
// behavior byte-for-byte (compactMessagesV1 below is the untouched v1 body).
export const COMPACTION_TRIGGER_RATIO = 0.7;        // v2: compact at 70% of the context budget
export const COMPACT_OLDEST_FRACTION = 1 / 3;       // v2 'early' mode compacts the oldest third (by chars)
export const MAX_OFFLOAD_ITEMS_PER_COMPACTION = 40; // bounded offload volume per compaction
export const OFFLOAD_ITEM_TARGET_CHARS = 8_000;     // per stored item (head+tail per long message)
export const SUMMARIZER_TAIL_CHARS = 14_000;        // tail-weighted summarizer input (the NEWEST part)
export const SUMMARIZER_HEAD_SAMPLE_CHARS = 2_000;  // plus a sampled head so the opening isn't lost
export const STRIP_RECAP_MIN_STORED_RATIO = 0.8;    // strict 'embedded' marker only when stored ≥ 80% of total

// ── Ticket c9133b94 (2026-11-01): a repeat compaction that cannot converge is
// paid for again, one step later.
//
// What production recorded, chat 76263cb1 / run `chat-501` — three
// `context_compaction` rows inside 61 seconds, all `mode:'early'`:
//
//   18:18:11.899Z  32473 ms  {totalChars:20937, cutMessages:6, keptMessages:6, storedChars:0, storedItems:0, offloadStopped:true}
//   18:19:02.832Z   2495 ms  {totalChars: 8373, cutMessages:4, keptMessages:7, storedChars:0, storedItems:0, offloadStopped:true}
//   18:19:12.946Z   2818 ms  {totalChars: 2263, cutMessages:4, keptMessages:7, storedChars:0, storedItems:0, offloadStopped:true}
//
// `totalChars` is the rendered middle — what a pass reclaims — so each pass
// reclaimed a SMALLER sliver while the run re-triggered anyway. Three blocking
// LLM summarizers (32.5 s on the first) bought to delete transcript that, with
// offload stopped, was recorded nowhere; the recap then tells the model to
// "re-run the call", which it did. That is the owner's "wasted non optimized
// flow" and "why did compaction lose things", from ONE loop rather than three
// separate problems.
//
// WHY no further cut can help, and why there is no 'full' escalation rung
// (review correction, 2026-11-01 — an earlier draft of this guard escalated to
// 'full' and that was WRONG): 'full' cuts to `messages.length - KEEP_RECENT_MSGS`
// and 'early' cuts to `min(oldestThird, messages.length - KEEP_RECENT_MSGS)`.
// When the clamp binds they are the SAME SPAN — so on exactly the shape that
// thrashes, escalating to 'full' reclaims nothing while paying another
// summariser to delete the same messages. Cutting harder (keeping fewer than
// KEEP_RECENT_MSGS) would converge, but it would delete MORE transcript into a
// store that is stopped — the opposite of what this ticket asks for.
//
// So the honest guard is: cut once, and if that cut did not land the transcript
// back under the trigger, STOP paying. The safety net for a genuinely oversized
// payload is the provider size-recovery lane (agent.ts, the 400/413 handler),
// which acts on a FACTUAL "too large" from the server instead of guessing, and
// compacts 'full' + shrinks the largest tool results at that point.
export type CompactionStep = 'early' | 'skip';

/** COMPACTION_CONVERGENCE_GUARD_DISABLED=1 restores the pre-c9133b94 thrash byte-for-byte. */
export function compactionConvergenceGuardDisabled(): boolean {
  return process.env.COMPACTION_CONVERGENCE_GUARD_DISABLED === '1';
}

/**
 * Which compaction a step that is over the trigger should run. Pure so the
 * ladder is testable without driving the whole agent loop; `nonConvergingCuts`
 * is how many cuts this run has already failed to get the transcript back under
 * the trigger.
 */
export function compactStepDecision(state: { nonConvergingCuts: number }): CompactionStep {
  if (compactionConvergenceGuardDisabled()) return 'early'; // restore today's behavior exactly
  const n = Number.isFinite(state.nonConvergingCuts) ? Math.max(0, state.nonConvergingCuts) : 0;
  if (n === 0) return 'early'; // the first cut over the trigger is always a real, productive cut
  return 'skip'; // a repeat cannot converge (see above) — stop paying; provider recovery is the net
}

// ── build 2026-10-08 C-3: STOP the compaction embedding offload ─────────────
// context.md §1.5: ≤4.5 % of the compaction rows written since 10-01 were ever
// returned by a search (6.4k of 95.6k surviving + ≥47.8k evicted unread); the
// session scope is 439k rows / digby_memory 10 GB. The v2 body no longer
// embeds the compacted turns (≤40 items × 8k chars per compaction); the ONE
// distilled-recap row per compaction stays (report: "optionally keep the
// distilled recap as one row"), and existing rows are never touched. The
// recap now says the turns are not stored and how to restore them (re-run the
// call) instead of steering the model into search_memory. Kill switch
// COMPACTION_OFFLOAD_STOP_DISABLED=1 restores the offload byte-for-byte.
export function compactionOffloadStopped(): boolean { return process.env.COMPACTION_OFFLOAD_STOP_DISABLED !== '1'; }
export const OFFLOAD_STOPPED_RECAP_LINE = '\nThe original turns are not stored anywhere searchable — if you need their exact output, re-run the call (re-read the file, re-run the command).';

/** Kill switch (read per call so a env flip needs no restart): v2 off → v1 everywhere. */
export function compactionV2Disabled(): boolean {
  const v = process.env.COMPACTION_V2_DISABLED || '';
  return v === '1' || /^true$/i.test(v);
}

/**
 * The transcript size at which the agent loop should compact. v2 triggers at
 * 70% of the budget (compacting the oldest third each time — several small
 * cheap compactions instead of one 100% cliff that summarizes everything);
 * the kill switch restores the old exact-budget cliff.
 */
export function compactionTriggerChars(contextBudget: number): number {
  return compactionV2Disabled() ? contextBudget : Math.floor(contextBudget * COMPACTION_TRIGGER_RATIO);
}

export interface LoopMessage {
  role: string;
  content?: any;
  tool_calls?: Array<{ function?: { name?: string } }>;
  [k: string]: any;
}

/**
 * Char weight of ONE message's content. A string counts its length; a content
 * PARTS array (vision turns) counts text-part chars + a fixed weight per
 * image_url part — the base64 payload is huge but the model consumes it as
 * image tokens, so counting it would trigger spurious compactions. Any other
 * shape keeps the JSON.stringify fallback. String/other-shape results are
 * byte-identical to before the array branch existed.
 */
function contentChars(content: any): number {
  if (typeof content === 'string') return content.length;
  if (Array.isArray(content)) {
    let n = 0;
    for (const p of content) {
      if (p?.type === 'text') n += String(p.text ?? '').length;
      else if (p?.type === 'image_url') n += IMAGE_PART_CHAR_WEIGHT;
      else n += JSON.stringify(p ?? null).length;
    }
    return n;
  }
  if (content) return JSON.stringify(content).length;
  return 0;
}

/** Char weight of ONE message (content + reasoning passback + tool_calls). */
function messageChars(m: LoopMessage): number {
  let n = contentChars(m.content);
  if (typeof m.reasoning_content === 'string') n += m.reasoning_content.length; // Kimi K3 loop passback
  if (m.tool_calls) n += JSON.stringify(m.tool_calls).length;
  return n;
}

/** Approximate size of the running transcript (chars across content + tool_calls). */
export function messagesChars(messages: LoopMessage[]): number {
  let n = 0;
  for (const m of messages) n += messageChars(m);
  return n;
}

/** Clip marker shared by the string and text-part clipping paths. */
const clipMarker = (clipped: number) => `\n…[clipped ${clipped} chars to fit the model context — re-read a narrower range if you need the rest]…\n`;

/**
 * Terminal note when the compact-and-retry recovery loop exhausts its attempts
 * (agent.ts model-error path). Evidence-based, not speculative: cites the real
 * transcript size vs budget and the attempt count, and only blames context
 * size when the transcript is actually over budget — a small transcript
 * failing repeatedly is almost always a transient provider glitch, and the
 * note must say so instead of guessing "the transcript may have grown too
 * large" (ticket 4aa91a41: tiny transcript, misleading note, next run passed).
 */
export function modelErrorTerminalNote(opts: {
  errorStatus?: number;
  errorMessage?: string;
  /** The provider's own parsed rejection reason (drained error body). When
   *  present it is appended to the note so the user sees the REAL cause —
   *  ticket 189cfeb9: a status-only note blamed "too large or malformed" on a
   *  ~4h Moonshot 400-incident window, and the drained body carrying the real
   *  reason never reached anything queryable. */
  providerError?: string;
  transcriptChars: number;
  contextBudget: number;
  attempts: number;
  /** Recovery actually attempted — 'compact-and-retry' (size/malformed class)
   *  by default; the transient class passes 'backoff-and-retry' so the note
   *  never claims a compaction that didn't happen (tickets 039dceb8/1e465443). */
  recoveryLabel?: string;
  /** Who READS the note. 'operator' (default — coding sessions, an unattended
   *  engineering audience) keeps the evidence-dense jargon: exact chars vs
   *  budget, recovery lane, provider body. 'user' (chat-profile runs — the
   *  note lands in an end-user chat bubble) speaks plainly: what failed, that
   *  it is not their fault, and what to do next — the engineering detail
   *  stays queryable in the provider_rejected loop-metric meta + progress
   *  events. Ticket 6d633649: a casual chat question died on a provider 429
   *  and the operator note ("transcript ~48k chars vs ~100k context budget,
   *  3 backoff-and-retry attempts exhausted") was incomprehensible to the
   *  user — "what is failing here??" */
  audience?: 'operator' | 'user';
}): string {
  const st = opts.errorStatus;
  if (opts.audience === 'user') {
    const over = opts.transcriptChars > opts.contextBudget;
    const retries = `${opts.attempts} ${opts.attempts === 1 ? 'retry' : 'retries'}`;
    if (over) {
      return `Sorry — this conversation has grown too large for the AI model to handle, and ${retries} with a trimmed transcript still didn't fit. Starting a fresh chat usually fixes it.`;
    }
    if (st === 429) {
      return `Sorry — I couldn't get an answer out this time: the AI provider is rate-limiting requests right now (too much traffic on their side), and ${retries} spaced over a couple of minutes all hit the same limit. Nothing is wrong with your message or your account — resending in a minute or two usually works.`;
    }
    const what = st
      ? `the AI provider returned an error (HTTP ${st})`
      : `the AI provider hit an error (${(opts.errorMessage || 'request failed').slice(0, 120)})`;
    return `Sorry — I couldn't get an answer out this time: ${what}, and ${retries} didn't get through. This looks like a provider-side problem, not something you did — resending your message in a minute or two usually works.`;
  }
  const why = st === 400
    ? 'the request was too large or malformed for the model'
    : st === 429
      ? 'the model provider rate-limited the request (HTTP 429)'
      : st ? `the model provider returned HTTP ${st}` : (opts.errorMessage || 'a model request error');
  const provider = opts.providerError ? `; provider said: ${opts.providerError.slice(0, 200)}` : '';
  const label = opts.recoveryLabel ?? 'compact-and-retry';
  const evidence = `transcript ~${Math.round(opts.transcriptChars / 1000)}k chars vs ~${Math.round(opts.contextBudget / 1000)}k context budget, ${opts.attempts} ${label} attempt${opts.attempts === 1 ? '' : 's'} exhausted`;
  const advice = opts.transcriptChars > opts.contextBudget
    ? 'the transcript may have outgrown the model — try narrowing the task or starting a fresh session'
    : st === 429
      ? 'the transcript was within budget — the provider was rate-limiting; resend in a minute or two and it usually succeeds'
      : 'the transcript was within budget, so this was likely a transient provider issue — resending the message usually succeeds';
  return `The model kept rejecting the request (${why}${provider}; ${evidence}). Stopping here rather than reporting a false success — ${advice}.`;
}

/** Head+tail clip of an over-cap string, preserving both ends. */
function clipString(s: string, cap: number): string {
  const half = Math.floor(cap / 2);
  return `${s.slice(0, half)}${clipMarker(s.length - cap)}${s.slice(s.length - half)}`;
}

/** Parse the mime out of an image_url data URL ('data:image/png;base64,…' → 'image/png'). */
function dataUrlMime(url: unknown): string {
  const m = /^data:([^;,]+)/.exec(typeof url === 'string' ? url : '');
  return m?.[1] || 'image';
}

/**
 * Shrink an over-cap content-PARTS array. Images are downgraded first (OLDEST
 * → newest): each image_url part is REPLACED with a one-line text placeholder —
 * the base64 is never sliced. If the remaining text still exceeds the cap, the
 * longest text part is head+tail clipped exactly like a string message.
 */
function clipContentParts(parts: Array<{ type: string; [k: string]: any }>, cap: number): Array<{ type: string; [k: string]: any }> {
  let out = parts.slice();
  for (let i = 0; i < out.length && contentChars(out) > cap; i++) {
    const p = out[i];
    if (p?.type === 'image_url') {
      out = [...out.slice(0, i), { type: 'text', text: imagePlaceholder({ mediaType: dataUrlMime(p.image_url?.url) }) }, ...out.slice(i + 1)];
    }
  }
  if (contentChars(out) > cap) {
    let longest = -1, longestLen = 0;
    for (let j = 0; j < out.length; j++) {
      const len = out[j]?.type === 'text' ? String(out[j].text ?? '').length : 0;
      if (len > longestLen) { longestLen = len; longest = j; }
    }
    if (longest >= 0) {
      const text = String(out[longest].text ?? '');
      const keep = Math.max(0, text.length - (contentChars(out) - cap));
      const half = Math.floor(keep / 2);
      out = [...out.slice(0, longest),
        { ...out[longest], text: `${text.slice(0, half)}${clipMarker(text.length - keep)}${text.slice(text.length - half)}` },
        ...out.slice(longest + 1)];
    }
  }
  return out;
}

/**
 * Clip any single message whose string content exceeds `cap` to head+tail with a
 * marker. Used to recover from a model 400 caused by one (or a few) huge tool
 * results in the recent window that compaction keeps verbatim — a giant file read
 * or diff can alone blow the model's window. Safe: never removes a message, never
 * changes a role, never breaks assistant↔tool pairing — it only shrinks content.
 * Array content (vision turns) is shrunk by clipContentParts: images become text
 * placeholders oldest-first; base64 is never sliced.
 *
 * ROLE-AWARE (R&D stream 3, test-bench #3, 2026-09-18): role:'system' messages
 * ride a far higher effective cap (SYSTEM_MSG_CHAR_CAP). The pre-fix map clipped
 * ANY over-cap message — including messages[0], the run's system prompt (≈20k
 * chars before the memory/repo blocks are even added: static doctrine ≈9.9k +
 * identity/mode ≈2k + the 8k AGENTS.md injection; ~31k–45k fully composed).
 * Every compaction (both tails below) and both agent.ts recovery clips therefore
 * sliced the system prompt to a 7k head + 7k tail mid-run, silently amputating
 * its middle — AGENTS.md, chat instructions, memory blocks, and any doctrine not
 * sitting inside the retained head. Unlike a tool result, that content is
 * recoverable from NOWHERE: it is not in session memory and never re-injected.
 * shrinkLargestToolResults below already exempts assistant/user/system outright;
 * this brings the same role asymmetry to the clip while SYSTEM_MSG_CHAR_CAP
 * keeps a recovery valve for a pathological oversize system prompt.
 */
export function clipOversizedMessages(messages: LoopMessage[], cap = PER_MSG_CHAR_CAP): LoopMessage[] {
  const firstUserIdx = messages.findIndex((m) => m.role === 'user');
  return messages.map((m, idx) => {
    const effCap = m.role === 'system' ? Math.max(cap, SYSTEM_MSG_CHAR_CAP)
      : idx === firstUserIdx ? Math.max(cap, FIRST_USER_MSG_CHAR_CAP)
      : cap;
    if (typeof m.content === 'string' && m.content.length > effCap) {
      return { ...m, content: clipString(m.content, effCap) };
    }
    if (Array.isArray(m.content) && contentChars(m.content) > effCap) {
      return { ...m, content: clipContentParts(m.content, effCap) };
    }
    return m;
  });
}

/** A tool result is never shrunk below this (head+tail excerpt + marker) —
 *  enough to keep ids, status lines and error text legible to the model. */
export const TOOL_RESULT_SHRINK_FLOOR = 1_200;

/**
 * Oversize shrink-retry (remediation P1, provider too-large rejections):
 * head+tail-shrink the LARGEST role:'tool' result bodies — largest first —
 * until the transcript fits under `targetChars`. Four production firings died
 * "model kept rejecting the request (too large or malformed)" at 178k–439k
 * chars against an 800k budget: UNDER budget, so compactMessages no-oped, and
 * every message was under the 14k per-message cap, so clipOversizedMessages
 * no-oped too — the compact-and-retry loop resent the IDENTICAL payload twice
 * and gave up with zero tools run. This makes each retry strictly smaller.
 *
 * Safe by construction: never removes a message, never changes a role, never
 * touches tool_call_id pairing or assistant/user/system content — only tool
 * RESULT bodies shrink (head+tail excerpt with a clip marker, exactly like
 * clipOversizedMessages). Returns null when nothing could shrink (already
 * under target, or no tool result above the floor) so the caller can tell a
 * real shrink from a no-op.
 */
export function shrinkLargestToolResults(messages: LoopMessage[], targetChars: number): LoopMessage[] | null {
  if (!(targetChars > 0) || messagesChars(messages) <= targetChars) return null;
  const out = messages.slice();
  const candidates = out
    .map((m, i) => ({ i, len: m.role === 'tool' && typeof m.content === 'string' ? m.content.length : 0 }))
    .filter((c) => c.len > TOOL_RESULT_SHRINK_FLOOR + 200) // +200: a barely-over clip frees nothing after the marker
    .sort((a, b) => b.len - a.len);
  let changed = false;
  for (const c of candidates) {
    if (messagesChars(out) <= targetChars) break;
    const m = out[c.i];
    out[c.i] = { ...m, content: clipString(String(m.content), TOOL_RESULT_SHRINK_FLOOR) };
    changed = true;
  }
  return changed ? out : null;
}

/**
 * Synthetic harness messages carry no session facts — FINAL TURN notices,
 * cross-check injections, and PRIOR COMPACTION RECAPS. Letting them back into
 * the summarizer input (or the full-fidelity memory offload) is recursive
 * pollution: a recap gets re-summarized into the next recap and re-stored
 * inside every new 'compaction' memory chunk, so search_memory starts
 * returning summaries-of-summaries instead of source content (ticket
 * 7852814c). Strip them from compaction input; the real content they
 * reference is already in session memory from the compaction that first
 * produced them.
 */
const SYNTHETIC_MESSAGE_PREFIXES = [
  '[HARNESS NOTICE',
  '[HARNESS INJECTION',
  '[HARNESS] Continue the in-progress task',
];
const RECAP_PREFIXES = ['[EARLIER IN THIS RUN', '[Earlier steps in this run'];
/** Present in a recap IFF its full-fidelity offload to session memory succeeded
 *  (the retrieve-guide line appended at compaction time). */
const RECAP_OFFLOAD_MARKER = 'embedded to session memory';
/**
 * Weaker marker: the recap POINTS at earlier compacted phases living in session
 * memory without its own turns being offloaded (owner 2026-09-04 — before this,
 * compaction N+1 stripped compaction N's offload-backed recap and the pointer
 * to the earliest phases' detail died with it). Deliberately NOT the strict
 * marker: a recap carrying only this line is still the sole record of ITS OWN
 * turns and must survive the synthetic-message strip (PR #285 medium #3).
 */
const RECAP_PRIOR_OFFLOAD_MARKER = 'is in session memory';
export function isSyntheticHarnessMessage(content: unknown): boolean {
  if (typeof content !== 'string') return false;
  const t = content.trimStart();
  if (RECAP_PREFIXES.some(p => t.startsWith(p))) {
    // Strip only OFFLOAD-BACKED recaps: a recap whose memory offload failed is
    // the ONLY surviving record of those turns — filtering it out would
    // silently drop that history, so it is carried forward (re-summarized, as
    // before the strip existed). PR #285 adversarial review, medium #3.
    return t.includes(RECAP_OFFLOAD_MARKER);
  }
  return SYNTHETIC_MESSAGE_PREFIXES.some(p => t.startsWith(p));
}

// ── Live STEERS survive compaction (audit 2026-10-06 T1-3) ──────────────────
// A mid-run owner / supervisor message reaches a coding run through the
// harness injection channel ("[HARNESS INJECTION — not typed by the user …]"
// + run-executor's "The user sent this WHILE you are working — treat it as a
// live steering instruction …" lead), so the v2 cut treated it as SYNTHETIC
// harness chrome: it was dropped from the compacted middle without even
// reaching the summarizer, and never pinned. Litellm lane run 8abce324 lost the
// PS's 21:02 "write the 2 routes + push + PR now, no more audits" steer to the
// next compaction and compacted 84 more times before its first edit. The
// newest STEER_PIN_MAX steers in the cut are now carried VERBATIM after the
// recap (oldest first, marked once with STEER_PIN_PREFIX); older ones join the
// summarized middle like ordinary user turns. A steer is never the "pinned
// question" (the run's task keeps that slot). Kill switch
// COMPACTION_STEER_PIN_DISABLED=1 restores the strip byte-for-byte.
export const STEER_MARKER = 'treat it as a live steering instruction';
export const STEER_PIN_MAX = 3;
export const STEER_PIN_PREFIX = '[STEER — kept verbatim through context compaction; received earlier in this run, still in force unless a later steer changes it]\n';
export function compactionSteerPinDisabled(): boolean { return process.env.COMPACTION_STEER_PIN_DISABLED === '1'; }
/** True when a user-role message carries a live steer (string or text parts). Pure. */
export function isSteerMessage(m: LoopMessage | null | undefined): boolean {
  if (!m || m.role !== 'user') return false;
  return contentToText(m.content).includes(STEER_MARKER);
}
/** The pinned form of a steer: prefixed once (idempotent across compactions). */
function pinSteer(m: LoopMessage): LoopMessage {
  if (typeof m.content === 'string') return m.content.startsWith(STEER_PIN_PREFIX) ? m : { ...m, content: `${STEER_PIN_PREFIX}${m.content}` };
  if (Array.isArray(m.content)) {
    const first = m.content[0];
    if (first?.type === 'text' && String(first.text ?? '').startsWith(STEER_PIN_PREFIX)) return m;
    return { ...m, content: [{ type: 'text', text: STEER_PIN_PREFIX.trimEnd() }, ...m.content] };
  }
  return m;
}

// ── Memory READS are never re-offloaded (audit 2026-10-06 T1-4/T1-5) ────────
// search_memory returns chunks that ALREADY live in session memory; storing
// its ~8k results back made memory retrieve its own retrievals (40,917
// `search_memory:` chunks in 14 days, ~16 self-hits per result). The agent's
// big-result offload and the compaction offload both skip these tools.
// Kill switch MEMORY_READ_REOFFLOAD_SKIP_DISABLED=1.
export const MEMORY_READ_TOOLS: ReadonlySet<string> = new Set(['search_memory', 'list_memory']);
export function memoryReadReoffloadSkipDisabled(): boolean { return process.env.MEMORY_READ_REOFFLOAD_SKIP_DISABLED === '1'; }
/** tool_call_id → tool name across the assistant turns of a transcript. Pure. */
function toolNamesById(messages: LoopMessage[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of messages) {
    if (m?.role !== 'assistant' || !Array.isArray(m.tool_calls)) continue;
    for (const t of m.tool_calls as Array<{ id?: unknown; function?: { name?: string } }>) {
      if (typeof t?.id === 'string' && t.function?.name) out.set(t.id, t.function.name);
    }
  }
  return out;
}

/** Model-facing text of one message's content (parts arrays → text parts + image placeholders). */
function contentToText(content: any): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(p => {
      if (p?.type === 'text') return String(p.text ?? '');
      if (p?.type === 'image_url') return imagePlaceholder({ mediaType: dataUrlMime(p.image_url?.url) });
      return JSON.stringify(p ?? null);
    }).join('\n');
  }
  if (content) return JSON.stringify(content);
  return '';
}

/**
 * Compact an over-budget array into [system prompt] + [pinned question] +
 * [recap of the middle] + [remaining turns verbatim]. Returns null when
 * there's nothing worth compacting. Never orphans a tool result from its
 * assistant tool_call.
 *
 * When `sessionId` is provided, the detail of the compacted-away turns is
 * first embedded into session retrieval memory (head+tail per long message,
 * ≤ MAX_OFFLOAD_ITEMS_PER_COMPACTION items) and the recap says HONESTLY how
 * much of it is retrievable via search_memory.
 *
 * `opts.mode` (v2 only): 'early' (default — the 70%-trigger path) compacts
 * the oldest THIRD of the transcript by chars; 'full' (the 400-recovery
 * paths) compacts everything down to the recent window, like v1 always did.
 * With COMPACTION_V2_DISABLED=1 both modes fall back to the v1 body.
 */
export async function compactMessages(
  messages: LoopMessage[],
  sessionId?: string,
  opts?: { mode?: 'early' | 'full' },
): Promise<LoopMessage[] | null> {
  if (compactionV2Disabled()) return compactMessagesV1(messages, sessionId);
  return compactMessagesV2(messages, sessionId, opts?.mode ?? 'early');
}

/** The pre-P6 compaction body, kept byte-identical behind the kill switch. */
async function compactMessagesV1(messages: LoopMessage[], sessionId?: string): Promise<LoopMessage[] | null> {
  if (messages.length <= KEEP_RECENT_MSGS + 3) return null;
  const head = messages[0]; // system prompt
  const compactionStartedAt = Date.now();
  let summarizerError: string | undefined;
  // PIN the first user message (the actual question) through compaction.
  // Summarizing it into the recap left [system, assistant, tool...] with NO
  // user turn — ZAI rejects that with 1214 'messages parameter is illegal'
  // (the root cause of EVERY mystery 400 across L2/L3, found 2026-07-16 via
  // payload fingerprinting).
  const firstUser = messages[1]?.role === 'user' ? messages[1] : null;
  let cut = messages.length - KEEP_RECENT_MSGS;
  while (cut < messages.length && messages[cut]?.role === 'tool') cut++;
  // Strip synthetic harness messages (notices/injections and PRIOR RECAPS)
  // from the compaction input — see isSyntheticHarnessMessage (ticket
  // 7852814c). The recent window is untouched: a notice there is live context.
  const middleAll = messages.slice(firstUser ? 2 : 1, cut);
  // Remember whether any recap being stripped (or carried) pointed at session
  // memory — the NEW recap must keep that pointer alive or the earliest phases'
  // retrievability dies with the stripped recap (owner 2026-09-04).
  const priorOffloaded = middleAll.some(m => {
    if (typeof m.content !== 'string') return false;
    const t = m.content.trimStart();
    return RECAP_PREFIXES.some(p => t.startsWith(p))
      && (t.includes(RECAP_OFFLOAD_MARKER) || t.includes(RECAP_PRIOR_OFFLOAD_MARKER));
  });
  const middle = middleAll.filter(m => !isSyntheticHarnessMessage(m.content));
  const recent = messages.slice(cut);
  if (middle.length < 2) return null;

  const middleText = middle.map(m => {
    if (m.role === 'tool') return `[tool result] ${String(m.content ?? '').slice(0, 400)}`;
    if (m.tool_calls?.length) return `[assistant → ${m.tool_calls.map(t => t.function?.name).join(', ')}] ${String(m.content ?? '').slice(0, 300)}`;
    return `${m.role}: ${String(m.content ?? '').slice(0, 500)}`;
  }).join('\n').slice(0, 14000);

  // Embed the compacted-away turns at FULL fidelity (generous per-message slices;
  // storeFindings chunks + caps internally) so search_memory can recover the
  // verbatim detail the recap necessarily drops. Best-effort — a store failure
  // just means the recap stays lossy, exactly as before.
  let storedToMemory = false;
  if (sessionId) {
    try {
      const fullText = middle.map(m => {
        // Ticket f03b739c: same write-boundary gate as the live offload sites.
        if (m.role === 'tool') {
          const text = String(m.content ?? '');
          const gate = sanitizeForMemoryEmbed(text);
          return `[tool result] ${(gate.action === 'skip' ? failedSearchCompactRecord(text) : gate.content).slice(0, 3000)}`;
        }
        if (m.tool_calls?.length) return `[assistant → ${m.tool_calls.map(t => `${t.function?.name}(${String((t.function as any)?.arguments ?? '').slice(0, 400)})`).join(', ')}] ${String(m.content ?? '').slice(0, 2000)}`;
        return `${m.role}: ${String(m.content ?? '').slice(0, 2000)}`;
      }).join('\n\n');
      const n = await storeFindings(sessionId, 'compaction', [{ ref: 'compacted earlier-run transcript', content: fullText }]);
      storedToMemory = n > 0;
    } catch { /* recap stays lossy */ }
  }

  let summary = '';
  try {
    summary = (await utilityChat([{ role: 'user', content:
      `Summarize the earlier part of an in-progress coding session into a concise progress recap (<=250 words). Cover: what was explored, files created/edited, commands run and their outcomes, key decisions, and any open threads. Keep concrete file paths and names.\n\n${middleText}` }],
      { maxTokens: 500, temperature: 0.2, timeout: 30000, retryNotFound: true })).trim();
  } catch (err: any) {
    // 2026-09-22 audit: this was a bare catch — a failed summarizer degraded the
    // recap to "[Earlier steps … omitted]" with no trace anywhere.
    summarizerError = String(err?.message ?? err).slice(0, 160);
    logger.warn(`compaction: recap summarizer failed for ${sessionId ?? 'anonymous'} — recap degrades to the omitted-steps line: ${summarizerError}`);
  }

  // Distill-on-write: store the normalized recap as its OWN embedded record
  // (title = first line) alongside the raw transcript — the distilled form is
  // what semantic search actually matches well (Cerebras finding). Fire-and-forget.
  if (sessionId && summary) {
    void storeFindings(sessionId, 'compaction', [{
      ref: 'compacted recap (distilled)',
      title: summary.split('\n')[0].slice(0, 200),
      content: summary,
    }]).catch(() => {});
  }

  // Guide composition: the strict 'embedded to session memory' phrasing marks
  // THIS recap's turns as offloaded (→ strippable by the next compaction); the
  // weaker 'is in session memory' phrasing keeps the pointer to EARLIER phases
  // alive without marking this recap's own turns as recoverable.
  const retrieveHow = 'call search_memory with specific keywords (file paths, function names, command output, error text) to retrieve any of it verbatim instead of re-doing the work.';
  const retrieveGuide = storedToMemory
    ? `\nThe FULL detail of these turns${priorOffloaded ? ' — and of earlier compacted phases of this run —' : ''} was embedded to session memory: ${retrieveHow}`
    : priorOffloaded
      ? `\nDetail from earlier compacted phases of this run is in session memory: ${retrieveHow}`
      : '';
  const recap: LoopMessage = { role: 'system', content: summary
    ? `[EARLIER IN THIS RUN — summarized to fit the context window]\n${summary}${retrieveGuide}`
    : `[Earlier steps in this run were omitted to fit the context window.]${retrieveGuide}` };
  try {
    recordLoopMetric({
      kind: LOOP_METRIC_KINDS.CONTEXT_COMPACTION, sessionId, value: Date.now() - compactionStartedAt, unit: 'ms',
      meta: { mode: 'v1', cutMessages: middleAll.length, keptMessages: recent.length, storedToMemory, priorOffloaded, summarizerOk: !!summary, ...(summarizerError ? { summarizerError } : {}) },
    });
  } catch { /* telemetry never breaks compaction */ }
  // Also clip any oversized message still kept verbatim in the recent window — a
  // couple of giant tool results there can keep us over the window on their own.
  return clipOversizedMessages([head, ...(firstUser ? [firstUser] : []), recap, ...recent]);
}

/**
 * v2 body (P6 — honest compaction). Differences from v1, each with its lie:
 *  (a) OFFLOAD: v1 stored ONE item whose content memStore silently cut to the
 *      FIRST 40k chars — a 700k middle lost 94% of itself while the recap said
 *      "FULL detail … embedded". v2 renders each compacted message, head+tail
 *      clips long ones to OFFLOAD_ITEM_TARGET_CHARS, packs small ones together,
 *      and stores ≤ MAX_OFFLOAD_ITEMS_PER_COMPACTION items (newest kept when
 *      over — older phases were offloaded by earlier compactions).
 *  (b) SUMMARIZER INPUT: v1 was slice(0, 14000) — the OLDEST 14k; the newest
 *      (most relevant) work never reached the recap. v2 is tail-weighted (last
 *      SUMMARIZER_TAIL_CHARS + a sampled head) and carries EVERY tool-call
 *      name/id verbatim so the recap can cite what actually ran.
 *  (c) RECAP HONESTY: the recap states 'stored N of M chars (K items)', and the
 *      strict 'embedded to session memory' marker — the one the NEXT compaction
 *      strips the recap on — appears ONLY when stored ≥ 80% of the middle.
 *  (d) QUESTION PIN (v1#34): v1 pinned messages[1] — on a machine lane past 48
 *      rows that is the OLDEST wake prompt, not the live task. v2 pins the LAST
 *      non-harness user message before the cut (fallback: messages[1]).
 */
async function compactMessagesV2(
  messages: LoopMessage[],
  sessionId: string | undefined,
  mode: 'early' | 'full',
): Promise<LoopMessage[] | null> {
  if (messages.length <= KEEP_RECENT_MSGS + 3) return null;
  const head = messages[0]; // system prompt
  const compactionStartedAt = Date.now();
  let summarizerError: string | undefined;

  // ── Cut point. 'full' = the v1 cut (everything but the recent window).
  // 'early' = the oldest COMPACT_OLDEST_FRACTION of the transcript by chars,
  // clamped so the recent window always survives verbatim. ──
  let cut: number;
  if (mode === 'full') {
    cut = messages.length - KEEP_RECENT_MSGS;
  } else {
    const target = messagesChars(messages) * COMPACT_OLDEST_FRACTION;
    let acc = 0;
    cut = 1;
    for (let i = 1; i < messages.length; i++) {
      acc += messageChars(messages[i]);
      cut = i + 1;
      if (acc >= target) break;
    }
    cut = Math.min(cut, messages.length - KEEP_RECENT_MSGS);
  }
  // Never orphan a tool result from its assistant tool_call.
  while (cut < messages.length && messages[cut]?.role === 'tool') cut++;

  // ── Pin "the question" (v1#34): the LAST non-harness user message before the
  // cut — the live task, not the oldest wake. Harness notices/injections and
  // recaps are user/system-role scaffolding, never the question. Fallback to
  // messages[1] (the v1 pin) so ZAI's no-user-turn 1214 rejection stays fixed
  // even when every user turn in the middle is harness chrome. ──
  // audit 2026-10-06 T1-3: a live steer is never the pinned question (the
  // run's TASK keeps that slot) — it rides its own pin below.
  const steerPin = !compactionSteerPinDisabled();
  let pinnedIdx = -1;
  for (let i = cut - 1; i >= 1; i--) {
    const m = messages[i];
    if (m?.role !== 'user') continue;
    if (isSyntheticHarnessMessage(contentToText(m.content))) continue;
    if (steerPin && isSteerMessage(m)) continue;
    pinnedIdx = i;
    break;
  }
  if (pinnedIdx === -1 && messages[1]?.role === 'user') pinnedIdx = 1;
  const pinned = pinnedIdx >= 1 ? messages[pinnedIdx] : null;

  // audit 2026-10-06 T1-3: the NEWEST STEER_PIN_MAX steers in the cut span are
  // carried verbatim after the recap (oldest first) instead of being stripped.
  const steerIdx = new Set<number>();
  if (steerPin) {
    for (let i = cut - 1; i >= 1 && steerIdx.size < STEER_PIN_MAX; i--) {
      if (i !== pinnedIdx && isSteerMessage(messages[i])) steerIdx.add(i);
    }
  }
  const pinnedSteers = [...steerIdx].sort((a, b) => a - b).map((i) => pinSteer(messages[i]));

  const middleAll: LoopMessage[] = [];
  for (let i = 1; i < cut; i++) if (i !== pinnedIdx && !steerIdx.has(i)) middleAll.push(messages[i]);
  // Same prior-offload pointer detection as v1 (owner 2026-09-04).
  const priorOffloaded = middleAll.some(m => {
    if (typeof m.content !== 'string') return false;
    const t = m.content.trimStart();
    return RECAP_PREFIXES.some(p => t.startsWith(p))
      && (t.includes(RECAP_OFFLOAD_MARKER) || t.includes(RECAP_PRIOR_OFFLOAD_MARKER));
  });
  // T1-3: an OLDER steer (beyond the pin budget) is a real user instruction —
  // summarized like any user turn, never stripped as harness chrome.
  const middle = middleAll.filter(m => !isSyntheticHarnessMessage(m.content) || (steerPin && isSteerMessage(m)));
  const rest = messages.slice(cut);
  if (middle.length < 2) {
    // An early cut too small to be productive: escalate once to the full cut
    // (the v1 shape); a full cut that is still unproductive returns null.
    if (mode === 'early') return compactMessagesV2(messages, sessionId, 'full');
    return null;
  }

  // ── (a) Honest offload: render each message at full fidelity, head+tail clip
  // long renders, pack small consecutive ones, bound the item count. ──
  const renderFull = (m: LoopMessage): string => {
    // Ticket f03b739c: a compacted tool result is a SECOND path into session
    // memory — sanitize it exactly like the live offload sites (a raw SERP
    // body distills; a failed search surface becomes a compact error record).
    // The recap summarizer input below keeps the raw text: it is LLM-destined,
    // never embedded.
    if (m.role === 'tool') {
      const text = contentToText(m.content);
      const gate = sanitizeForMemoryEmbed(text);
      return `[tool result] ${gate.action === 'skip' ? failedSearchCompactRecord(text) : gate.content}`;
    }
    if (m.tool_calls?.length) {
      const calls = m.tool_calls.map(t => `${t.function?.name}(${String((t.function as any)?.arguments ?? '').slice(0, 400)})`).join(', ');
      return `[assistant → ${calls}] ${contentToText(m.content)}`;
    }
    return `${m.role}: ${contentToText(m.content)}`;
  };
  // audit 2026-10-06 T1-5: a memory READ's result (search_memory / list_memory)
  // is already in memory — never offloaded again (summarized as usual).
  const memReadSkip = !memoryReadReoffloadSkipDisabled();
  const nameById = memReadSkip ? toolNamesById(messages) : null;
  const isMemoryReadResult = (m: LoopMessage): boolean => !!nameById && m.role === 'tool'
    && typeof m.tool_call_id === 'string' && MEMORY_READ_TOOLS.has(nameById.get(m.tool_call_id) ?? '');
  const offloadable = nameById ? middle.filter((m) => !isMemoryReadResult(m)) : middle;
  const skippedMemoryReads = middle.length - offloadable.length;
  const renderedFull = offloadable.map(renderFull);
  const totalChars = renderedFull.reduce((n, s) => n + s.length, 0);
  let storedToMemory = false;
  let storedChars = 0;
  let storedItems = 0;
  const offloadStopped = compactionOffloadStopped(); // build 2026-10-08 C-3
  if (sessionId && renderedFull.length && !offloadStopped) {
    try {
      const clipped = renderedFull.map(s => (s.length > OFFLOAD_ITEM_TARGET_CHARS ? clipString(s, OFFLOAD_ITEM_TARGET_CHARS) : s));
      const packed: string[] = [];
      let cur = '';
      for (const s of clipped) {
        if (cur && cur.length + 2 + s.length > OFFLOAD_ITEM_TARGET_CHARS) { packed.push(cur); cur = s; }
        else cur = cur ? `${cur}\n\n${s}` : s;
      }
      if (cur) packed.push(cur);
      // Over the bound → keep the NEWEST parts (the oldest were offloaded by
      // earlier compactions of this run) and say so honestly in the recap.
      const kept = packed.length > MAX_OFFLOAD_ITEMS_PER_COMPACTION
        ? packed.slice(packed.length - MAX_OFFLOAD_ITEMS_PER_COMPACTION)
        : packed;
      const items = kept.map((content, i) => ({
        ref: `compacted earlier-run transcript (part ${i + 1}/${kept.length})`,
        title: content.split('\n')[0].slice(0, 160),
        content,
      }));
      // maxChunks sized so every ~8k item's ~3 store-chunks fit (memStore's
      // default 40-chunk cap would silently drop items past the first ~17).
      const n = await storeFindings(sessionId, 'compaction', items, { maxChunks: MAX_OFFLOAD_ITEMS_PER_COMPACTION * 3 });
      if (n > 0) {
        storedToMemory = true;
        storedItems = items.length;
        storedChars = Math.min(kept.reduce((s, c) => s + c.length, 0), totalChars);
      }
    } catch { /* recap stays honest: nothing stored */ }
  }

  // ── (b) Tail-weighted summarizer input + verbatim tool-call roster. ──
  const brief = middle.map(m => {
    if (m.role === 'tool') return `[tool result] ${contentToText(m.content).slice(0, 400)}`;
    if (m.tool_calls?.length) return `[assistant → ${m.tool_calls.map(t => t.function?.name).join(', ')}] ${contentToText(m.content).slice(0, 300)}`;
    return `${m.role}: ${contentToText(m.content).slice(0, 500)}`;
  }).join('\n');
  const summarizerInput = brief.length <= SUMMARIZER_HEAD_SAMPLE_CHARS + SUMMARIZER_TAIL_CHARS
    ? brief
    : `${brief.slice(0, SUMMARIZER_HEAD_SAMPLE_CHARS)}\n…[${brief.length - SUMMARIZER_HEAD_SAMPLE_CHARS - SUMMARIZER_TAIL_CHARS} chars of the middle omitted — the NEWEST part follows]…\n${brief.slice(-SUMMARIZER_TAIL_CHARS)}`;
  const toolCallNames: string[] = [];
  for (const m of middle) {
    for (const t of m.tool_calls ?? []) {
      const id = (t as any).id ? `#${String((t as any).id).slice(0, 12)}` : '';
      toolCallNames.push(`${t.function?.name || 'tool'}${id}`);
    }
  }
  let toolRoster = toolCallNames.length
    ? `\n\nAll tool calls in the compacted span, in order (${toolCallNames.length}): ${toolCallNames.join(', ')}`
    : '';
  if (toolRoster.length > 4000) toolRoster = `${toolRoster.slice(0, 4000)}…[roster truncated]`;

  let summary = '';
  try {
    summary = (await utilityChat([{ role: 'user', content:
      `Summarize the earlier part of an in-progress coding session into a concise progress recap (<=250 words). Cover: what was explored, files created/edited, commands run and their outcomes, key decisions, and any open threads. Keep concrete file paths and names. The excerpt is tail-weighted: the newest (most current) work is at the END.\n\n${summarizerInput}${toolRoster}` }],
      { maxTokens: 500, temperature: 0.2, timeout: 30000, retryNotFound: true })).trim();
  } catch (err: any) {
    summarizerError = String(err?.message ?? err).slice(0, 160);
    logger.warn(`compaction: recap summarizer failed for ${sessionId ?? 'anonymous'} — recap degrades to the omitted-steps line: ${summarizerError}`);
  }

  // Distill-on-write (unchanged from v1): the normalized recap as its own record.
  if (sessionId && summary) {
    void storeFindings(sessionId, 'compaction', [{
      ref: 'compacted recap (distilled)',
      title: summary.split('\n')[0].slice(0, 200),
      content: summary,
    }]).catch(() => {});
  }

  // ── (c) Honest retrieval guide. The strict RECAP_OFFLOAD_MARKER ('embedded
  // to session memory') marks this recap strippable by the NEXT compaction —
  // used ONLY when ≥ STRIP_RECAP_MIN_STORED_RATIO of the middle really stored.
  // A partial store gets the weak 'is in session memory' phrasing, so the
  // recap (the sole record of the unstored remainder) survives future strips. ──
  const retrieveHow = 'call search_memory with specific keywords (file paths, function names, command output, error text) to retrieve any of it verbatim instead of re-doing the work.';
  const storedFully = storedToMemory && totalChars > 0 && storedChars >= totalChars * STRIP_RECAP_MIN_STORED_RATIO;
  const countsNote = `(stored ${storedChars.toLocaleString('en-US')} of ${totalChars.toLocaleString('en-US')} chars, ${storedItems} item${storedItems === 1 ? '' : 's'})`;
  const retrieveGuide = storedFully
    ? `\nThe FULL detail of these turns${priorOffloaded ? ' — and of earlier compacted phases of this run —' : ''} was embedded to session memory ${countsNote}: ${retrieveHow}`
    : storedToMemory
      ? `\nPARTIAL detail of these turns ${countsNote} — head+tail of each long message${priorOffloaded ? ', plus earlier compacted phases,' : ''} — is in session memory: ${retrieveHow} Anything outside the stored head+tail slices is GONE from this run's context.`
      : priorOffloaded
        ? `\nDetail from earlier compacted phases of this run is in session memory: ${retrieveHow}`
        : offloadStopped ? OFFLOAD_STOPPED_RECAP_LINE : '';

  const recap: LoopMessage = { role: 'system', content: summary
    ? `[EARLIER IN THIS RUN — summarized to fit the context window]\n${summary}${retrieveGuide}`
    : `[Earlier steps in this run were omitted to fit the context window.]${retrieveGuide}` };
  // One durable row per compaction (2026-09-22 audit: the primary context
  // compactor emitted only SSE progress events — nothing to query afterwards).
  try {
    recordLoopMetric({
      kind: LOOP_METRIC_KINDS.CONTEXT_COMPACTION,
      sessionId,
      value: Date.now() - compactionStartedAt,
      unit: 'ms',
      meta: {
        mode, cutMessages: middle.length, keptMessages: rest.length, totalChars, storedItems, storedChars,
        storedFully, priorOffloaded, summarizerOk: !!summary, ...(summarizerError ? { summarizerError } : {}),
        ...(pinnedSteers.length ? { pinnedSteers: pinnedSteers.length } : {}),
        ...(skippedMemoryReads ? { skippedMemoryReads } : {}),
        ...(offloadStopped ? { offloadStopped: true } : {}),
      },
    });
  } catch { /* telemetry never breaks compaction */ }
  return clipOversizedMessages([head, ...(pinned ? [pinned] : []), recap, ...pinnedSteers, ...rest]);
}
