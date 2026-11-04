/**
 * Project Brief — the hourly status card, written for a human (owner
 * 2026-09-22: "I am always asking 'ok what is happening now? what are you doing?
 * what is your goal?' … it is very hard to remember what project is doing what
 * in the grand picture … basically the project status updates but more in depth
 * human readable").
 *
 * The card (fleet/project-status.service) is a deterministic ledger: goal and
 * todo titles with the lanes' own progress notes pasted in — firing numbers,
 * census strings, lane ids. This module adds, on the SAME row and cadence:
 *
 *   mission   one sentence: what this project is for
 *   now       what is being worked on right now and how far along, in words
 *   changed   what moved since the owner last looked (≤3)
 *   blocked   what is stuck or needs the owner (≤3)
 *   next      the next milestone
 *   asks      "You asked" — the owner's own recent messages in the supervisor
 *             chat, each with what became of it (done / in progress / answered /
 *             open / unknown) — the "oh yeah, I asked you that yesterday" answer
 *
 * Sources: the rendered status (already identifier-free), the project's goals
 * and todos, open owner questions, the project supervisor's directive ledger
 * (supervisor_states) and the owner's human-typed messages in that chat.
 * One utility-model call (reasoning on) writes the prose; every string is then
 * run through the card's identifier scrubber (`plain`), so a lane id that
 * slips through the prompt never reaches the owner. When the MODEL fails, a
 * deterministic fallback brief is built from the same inputs — the card never
 * loses its brief to a provider blip. When the INPUTS cannot be read, there is
 * no brief at all (null) — never one built from empty evidence (review C8,
 * 2026-09-24); the card keeps its previous brief instead.
 *
 * Change key (2026-09-24 design decision): a CHANGED SET OF ASKS IS A REAL
 * CHANGE. The brief carries `asksFingerprint` (asks × ledger status × match
 * tier × reply presence); the card treats an hour as "unchanged" only when the
 * status hash AND this fingerprint are both unchanged — a quiet stub copies
 * the previous brief forward verbatim and NEVER rebuilds it; when only the
 * asks moved, a REAL card (full body + rebuilt brief) lands.
 *
 * "You asked" grounding (2026-09-24 — canlegal-bench supervisor chat,
 * 2026-09-23/24: the card listed the owner's own messages as "→ no record
 * yet" for 12+ hours while the supervisor had answered each in chat within
 * 6 minutes AND the directive ledger already held both as done with
 * evidence). The rules, one per cause:
 *   1. the ledger array is stored OLDEST-first and was sliced before sorting,
 *      so the newest asks never reached the model → every ledger read is
 *      sorted newest-first BEFORE any slice (`newestFirst`);
 *   2. the newest 60 user rows of ANY origin were fetched and only then
 *      filtered to owner rows — ~62 machine wake prompts a day crowded the
 *      owner out → BRIEF_ASKS_FETCH candidate rows (id/createdAt/metadata
 *      only — no content, review C9) are scanned inside the window, filtered
 *      to origin null/'user' BEFORE any cap, and content is loaded for the
 *      surviving handful in ONE findMany by id;
 *   3. the supervisor's own on-turn reply was never loaded, so an in-chat
 *      answer was invisible → each ask carries the first assistant row after
 *      it (≤ BRIEF_REPLY_WINDOW_MS) that carries the chat engine's FINALIZE
 *      STAMP (metadata.engine 'agent' or a `models` object — review C6: an
 *      unstamped assistant row in a supervisor chat is a harness notice —
 *      schedule stopped/parked/capped, hook dead-letter — never the reply)
 *      and is not a machine note; ONE findMany serves every ask (review C21);
 *   4. its directive is matched by tier — exact text, then the ≤ 5 s capture
 *      stamp, then word overlap — and the overlap tier is ADVISORY (review
 *      C7): only a directive stamped no earlier than the message qualifies,
 *      and an overlap match never closes an ask as done when a reply exists
 *      (the reply's 'answered' wins);
 *   5. the brief lists exactly the messages the ledger captures: the SAME
 *      ack/status classifier appendDirective uses (isAckOrStatusQuestion), so
 *      a message the ledger skipped is never listed as an ask that could then
 *      fuzzy-match an older directive;
 *   6. a model 'unknown' / "no record" against evidence is overruled by the
 *      deterministic verdict; "no record" is never shown at any status
 *      (review C11), and an empty model note takes the evidence-backed one
 *      (review C10).
 */
import { createHash } from 'crypto';
import prisma from '../../../config/database';
import logger from '../../../utils/logger';
import { utilityChat } from '../../../utils/utility-llm';
import { recordExtractionOutcome, parseModelJson } from '../memory/memory-audit';
// tt-rd audit 2026-09-27: the reply-row predicate moved to a shared leaf so the
// [OPEN OWNER ASKS] wake block and follow-through detector 3 read the SAME rule.
import { isOwnerOrigin, hasFinalizeStamp, isSupervisorReplyRow, MACHINE_NOTE_KINDS } from './supervisor-reply-row';
// LEAF module (its own header): prisma + logger only — static-import-safe here.
import { getSupervisorState, isAckOrStatusQuestion } from '../platform/supervisor-state.service';
import type { ProjectStatus } from './project-status.service';
import { plain } from './project-status.service';
import { progressNoteForDisplay } from '../platform/progress-note';
// KPI of record (tt-rd audit 2026-09-27, finding 4): the brief quotes the
// register's number and a model-typed rate that disagrees with it is dropped
// for the deterministic sentence.
import { kpiPremiseOf, kpiOfRecordText, kpiBarText, kpiBareKey, readPremisesLoose, typedRatesDisagreeingWithKpi, type KpiPremiseLike } from '../platform/kpi-of-record';
import { recordLoopMetric } from '../platform/loop-metrics.service';

export type BriefAskStatus = 'done' | 'in_progress' | 'answered' | 'open' | 'unknown';

export interface ProjectBriefAsk {
  /** ISO time the owner said it. */
  at: string;
  /** The owner's words (clipped). */
  text: string;
  status: BriefAskStatus;
  /** What became of it, one short clause. */
  note?: string;
}

export interface ProjectBrief {
  mission: string;
  now: string;
  changed: string[];
  blocked: string[];
  next: string;
  asks: ProjectBriefAsk[];
  generatedAt: string;
  /** 'model' when the utility model wrote the prose; 'fallback' when it was assembled deterministically. */
  source: 'model' | 'fallback';
  /** sha256/32 over the owner asks × their ledger status × match tier × reply
   *  presence (2026-09-24). Part of the card's "unchanged" test: a quiet stub
   *  copies the brief forward only while the status hash AND this fingerprint
   *  are unchanged; a moved fingerprint is a real card. Absent when there is
   *  no supervisor chat. */
  asksFingerprint?: string;
}

export const BRIEF_ASKS_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const BRIEF_MAX_ASKS = 8;
/** The brief LLM's output budget. maxTokens is a CAP, not a spend — a brief
 *  that fits still costs only what it uses — but it must be GENEROUS whenever
 *  thinking is on, because reasoning counts against max_tokens on both legs
 *  that can serve this call:
 *   - 1400 (before 2026-09-28) cut the JSON mid-string once 8 owner asks
 *     crowded it: parse_error 10%, 3 fallback cards (firing 39 → 2200).
 *   - 2200 still cut MID-MISSION at 18.8% parse_error / 7 fallback cards in
 *     4h (firing 45, 2026-09-29) — because the admin's 'utility' Edge
 *     override leg (`cql-litellm:…qwen3.8-flash`) passes max_tokens through
 *     LITERALLY: utility-llm's 16384 thinking floor guards only the built-in
 *     DeepSeek leg. Reasoning on the proxy ate the 2200 before the JSON.
 *  8000 gives the JSON + reasoning room on BOTH legs (the DeepSeek leg keeps
 *  its own floor). Rows now carry leg/finishReason via onMeta, so the audit
 *  alone attributes the next regression. Pinned in project-brief.service.test.ts. */
export const PROJECT_BRIEF_BUDGET_TOKENS = 8000;
/** Candidate user rows scanned inside the window BEFORE the owner filter
 *  (2026-09-24: machine wake prompts are user rows too — ~62/day on a
 *  hook-dense project, 434 a week — and a 60-row fetch left 1-2 owner
 *  messages). The scan selects id/createdAt/metadata ONLY (review C9); 800
 *  covers a week of wakes with headroom. */
export const BRIEF_ASKS_FETCH = 800;
/** Owner-origin rows whose CONTENT is loaded (one findMany by id): twice the
 *  ask cap, because acks and bracketed machine-prompt echoes are dropped only
 *  after the content read. */
export const BRIEF_OWNER_CONTENT_FETCH = BRIEF_MAX_ASKS * 2;
/** How long after an ask the supervisor's on-turn reply may land. */
export const BRIEF_REPLY_WINDOW_MS = 6 * 60 * 60 * 1000;
/** A directive captured from the same message is stamped within seconds of it. */
export const BRIEF_DIRECTIVE_MATCH_MS = 5000;
/** The 'unknown' note — never "no record yet" (owner 2026-09-24). */
export const ASK_UNTRACKED_NOTE = 'not tracked on the board yet';
/** Assistant rows read in the ONE reply query that serves every ask (review C21). */
export const BRIEF_REPLY_FETCH = 300;
const BRIEF_LINE_MAX = 220;
const BRIEF_ASK_TEXT_MAX = 160;
const BRIEF_REPLY_TEXT_MAX = 240;
const ASK_STATUSES = new Set<BriefAskStatus>(['done', 'in_progress', 'answered', 'open', 'unknown']);
/** Assistant rows the harness writes WITHOUT an origin stamp but which are never the supervisor's reply. */
// MACHINE_NOTE_KINDS lives in ./supervisor-reply-row (shared leaf).

// ── Goal counts of record (audit 2026-10-06 T8-3, spark #7) ─────────────────
// The card's headline said "all 25 goals done" while the brief beside it said
// "All 17 active goals … are complete": the prompt saw only the 20 newest goal
// rows (done + archived mixed) and was asked for "e.g. '7 of 8 goals done'".
// Now the prompt carries the EXACT counts (the same status.goals the headline
// renders), the deterministic fallback counts from them too, and a model
// sentence whose goal count disagrees with them is replaced by the canonical
// count sentence. BRIEF_GOAL_COUNTS_DISABLED=1 restores all three.

export interface GoalCounts { active: number; done: number; blocked: number; total: number }

export function briefGoalCountsDisabled(): boolean {
  return process.env.BRIEF_GOAL_COUNTS_DISABLED === '1';
}

/** The card's own goal counts (archived goals are not counted), or null under the kill switch / no status. Pure. */
export function goalCountsOf(status: Pick<ProjectStatus, 'goals'> | null | undefined): GoalCounts | null {
  if (briefGoalCountsDisabled()) return null;
  const g = status?.goals;
  if (!g || ![g.active, g.done, g.blocked].every((n) => Number.isFinite(Number(n)))) return null;
  const active = Number(g.active); const done = Number(g.done); const blocked = Number(g.blocked);
  return { active, done, blocked, total: active + done + blocked };
}

/** "All 25 goals are done." / "3 of 8 goals are done (4 active, 1 blocked)." Pure. */
export function canonicalGoalSentence(c: GoalCounts): string {
  if (c.total === 0) return 'No goals are set yet.';
  if (c.done === c.total) return c.total === 1 ? 'Its one goal is done.' : `All ${c.total} goals are done.`;
  const rest = [c.active ? `${c.active} active` : '', c.blocked ? `${c.blocked} blocked` : ''].filter(Boolean).join(', ');
  return `${c.done} of ${c.total} goal${c.total === 1 ? ' is' : 's are'} done${rest ? ` (${rest})` : ''}.`;
}

const GOAL_QUAL = 'active|open|in[- ]progress|done|complete|completed|finished|closed|blocked|stuck|remaining|pending|left';
// groups: 1 "all", 2 N, 3 M ("N of M"), 4 qualifier before "goals", 5 qualifier after "goals"
const GOAL_COUNT_RE = new RegExp(
  `\\b(?:(all)\\s+(?:the\\s+)?)?(\\d{1,4})(?:\\s+(?:of|out of)\\s+(?:the\\s+)?(\\d{1,4}))?\\s+(?:(${GOAL_QUAL})\\s+)?(?:project\\s+)?goals?\\b(?:\\s+(?:are|is|were|have been|has been|now)?\\s*(${GOAL_QUAL})\\b)?`,
  'gi',
);

function goalBucketCount(q: string, c: GoalCounts): number {
  const k = q.toLowerCase();
  if (/^(active|in[- ]progress)$/.test(k)) return c.active;
  if (/^(done|complete|completed|finished|closed)$/.test(k)) return c.done;
  if (/^(blocked|stuck)$/.test(k)) return c.blocked;
  return c.active + c.blocked; // open / remaining / pending / left
}

/** The goal-count phrases in `text` that disagree with the counts of record (as written). A bare unqualified
 *  "N goals" is never judged (precision over recall). Pure. */
export function goalCountMismatches(text: string, c: GoalCounts): string[] {
  const out: string[] = [];
  GOAL_COUNT_RE.lastIndex = 0;
  for (const m of String(text ?? '').matchAll(GOAL_COUNT_RE)) {
    const [whole, all, nRaw, mRaw, before, after] = m;
    const n = Number(nRaw);
    let ok = true;
    if (mRaw !== undefined) {
      if (Number(mRaw) !== c.total) ok = false;
      const q = after ?? before;
      if (q && n !== goalBucketCount(q, c)) ok = false;
    } else if (all) {
      if (before) { if (n !== goalBucketCount(before, c)) ok = false; } else if (n !== c.total) ok = false;
      if (after && goalBucketCount(after, c) !== n) ok = false;
    } else {
      const q = after ?? before;
      if (q && n !== goalBucketCount(q, c)) ok = false;
    }
    if (!ok) out.push(whole.trim());
  }
  return out;
}

/** Replace every sentence of `text` that states a wrong goal count with the canonical sentence (once). Pure. */
export function reconcileGoalCountText(text: string, c: GoalCounts): { text: string; fixed: string[] } {
  const src = String(text ?? '');
  const fixed = goalCountMismatches(src, c);
  if (!fixed.length) return { text: src, fixed };
  let placed = false;
  const kept: string[] = [];
  for (const sentence of src.split(/(?<=[.!?])\s+/)) {
    if (goalCountMismatches(sentence, c).length) {
      if (!placed) { kept.push(canonicalGoalSentence(c)); placed = true; }
      continue;
    }
    kept.push(sentence);
  }
  return { text: kept.join(' ').trim(), fixed };
}

/** Apply reconcileGoalCountText to every prose field of a brief, in place. Returns the fixed phrases (empty = untouched). Pure. */
export function reconcileBriefGoalCounts(brief: ProjectBrief, c: GoalCounts | null): string[] {
  if (!c) return [];
  const fixed: string[] = [];
  const fix = (v: string): string => { const r = reconcileGoalCountText(v, c); fixed.push(...r.fixed); return r.text; };
  brief.mission = fix(brief.mission);
  brief.now = fix(brief.now);
  brief.next = fix(brief.next);
  brief.changed = brief.changed.map(fix);
  brief.blocked = brief.blocked.map(fix);
  return fixed;
}

/**
 * Not an ask: pure acks and bare status questions ("ok", "thanks", "any
 * update?"). Review C7 (2026-09-24): this is the SAME classifier the directive
 * ledger's capture path uses (supervisor-state appendDirective →
 * isAckOrStatusQuestion), so the brief lists exactly the messages the ledger
 * captured — a message the ledger skipped can never be listed as an ask and
 * then fuzzy-match an older directive. Kept under its original name for
 * callers and tests. Pure.
 */
export function isStatusCheckOrAck(text: string): boolean {
  return isAckOrStatusQuestion(String(text ?? ''));
}

// isOwnerOrigin / hasFinalizeStamp: ./supervisor-reply-row (shared leaf).

/** Re-exported for callers that pinned the stamp rule here. */
export { hasFinalizeStamp, MACHINE_NOTE_KINDS };

export interface ReplyRow { id: string; at: Date; text: string }
export interface DirectiveRow { at: string; text: string; status: string; evidence?: string; archivedAt?: string }
/** How an ask was matched to its ledger row — 'overlap' is advisory (review C7). */
export type DirectiveMatchTier = 'exact' | 'near' | 'overlap';
export interface DirectiveMatch { directive: DirectiveRow; tier: DirectiveMatchTier }
export interface OwnerAskRow {
  /** crossmodel_messages id (the fingerprint key). Absent on hand-built fixtures. */
  id?: string;
  at: Date;
  text: string;
  /** The ledger row captured from this message, when one matches (see findDirectiveMatch). */
  directive?: DirectiveRow | null;
  /** The tier the directive matched on; absent when there is no directive. */
  directiveTier?: DirectiveMatchTier;
  /** The supervisor's on-turn reply, when one landed (see loadReplies). */
  reply?: ReplyRow | null;
}
/** The ledger (newest first) and the owner's asks — each with its directive and reply. Loaded once per card (review C21). */
export interface AskContext { directives: DirectiveRow[]; asks: OwnerAskRow[] }
interface BoardRow { title: string; status: string; note: string | null; blocked: string | null; updatedAt: Date | null }

/** Newest first by `at` (ISO); rows without a parsable stamp sort last. Exported for tests. */
export function newestFirst<T extends { at: string }>(rows: T[]): T[] {
  const ms = (r: T) => { const t = Date.parse(r.at); return Number.isFinite(t) ? t : Number.MIN_SAFE_INTEGER; };
  return [...rows].sort((a, b) => ms(b) - ms(a));
}

const MATCH_STOPWORDS = new Set(['what', 'that', 'this', 'with', 'from', 'have', 'about', 'your', 'them', 'they', 'were', 'will', 'just', 'like', 'more', 'some', 'than', 'then', 'there', 'their', 'would', 'could', 'should', 'please', 'want', 'need', 'make', 'sure', 'doing', 'going', 'well', 'still', 'also', 'into', 'over', 'when', 'where', 'which', 'does', 'done', 'been', 'being', 'very', 'much', 'many', 'every', 'because']);
const tokens = (t: string) => new Set(String(t ?? '').toLowerCase().split(/[^a-z0-9%]+/).filter((w) => w.length >= 4 && !MATCH_STOPWORDS.has(w)));
/** The owner's message and a recorded directive talk about the same thing: ≥2 shared distinctive words covering ≥50 % of the shorter side. Exported for tests. */
export function askMatchesDirective(ask: string, directive: string): boolean {
  const a = tokens(ask); const b = tokens(directive);
  if (!a.size || !b.size) return false;
  let shared = 0; for (const w of a) if (b.has(w)) shared++;
  return shared >= 2 && shared / Math.min(a.size, b.size) >= 0.5;
}

const normText = (t: unknown) => String(t ?? '').toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * The ledger row captured from this owner message, with the tier it matched
 * on. Tiers, strongest first: exact text (the capture stores the message
 * verbatim; the ask side is clipped, so a prefix of ≥ 40 chars counts), then
 * the nearest stamp within BRIEF_DIRECTIVE_MATCH_MS (capture happens on the
 * same persist), then the word-overlap heuristic for hand-merged ledgers.
 * Review C7 (2026-09-24): tiers 2-3 consider ONLY directives stamped no
 * earlier than ask.at − BRIEF_DIRECTIVE_MATCH_MS — a directive that predates
 * the message cannot be its capture, and the overlap tier is advisory (see
 * deterministicAskStatus). Exported for tests.
 */
export function findDirectiveMatch(ask: { at: Date; text: string }, directives: DirectiveRow[]): DirectiveMatch | null {
  const askNorm = normText(ask.text);
  if (askNorm) {
    for (const d of directives) {
      const dNorm = normText(d.text);
      if (!dNorm) continue;
      if (dNorm === askNorm || (askNorm.length >= 40 && (dNorm.startsWith(askNorm) || askNorm.startsWith(dNorm)))) return { directive: d, tier: 'exact' };
    }
  }
  const askMs = ask.at.getTime();
  const eligible = directives
    .map((d) => ({ d, ms: Date.parse(d.at) }))
    .filter(({ ms }) => Number.isFinite(ms) && ms >= askMs - BRIEF_DIRECTIVE_MATCH_MS);
  let nearest: DirectiveRow | null = null;
  let nearestGap = Infinity;
  for (const { d, ms } of eligible) {
    const gap = Math.abs(ms - askMs);
    if (gap <= BRIEF_DIRECTIVE_MATCH_MS && gap < nearestGap) { nearest = d; nearestGap = gap; }
  }
  if (nearest) return { directive: nearest, tier: 'near' };
  const overlap = eligible.find(({ d }) => askMatchesDirective(ask.text, d.text));
  return overlap ? { directive: overlap.d, tier: 'overlap' } : null;
}

/** The directive alone (findDirectiveMatch without the tier). Exported for tests. */
export function findDirectiveForAsk(ask: { at: Date; text: string }, directives: DirectiveRow[]): DirectiveRow | null {
  return findDirectiveMatch(ask, directives)?.directive ?? null;
}

/** ≤ maxWords of the supervisor's reply, markdown stripped, identifiers scrubbed. Exported for tests. */
export function replyGist(text: unknown, maxWords = 20): string {
  const cleaned = String(text ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\|?-{3,}\|?/g, ' ')
    .replace(/[*_#>|`]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const words = plain(cleaned, 400).split(' ').filter(Boolean);
  const out = words.slice(0, maxWords).join(' ');
  return words.length > maxWords ? `${out}…` : out;
}

/**
 * The deterministic verdict for one ask, from its ledger row and reply only
 * (2026-09-24): ledger done → done (evidence as the note); a reply → answered
 * (gist of the reply); a ledger row still open → open; nothing → unknown with
 * ASK_UNTRACKED_NOTE. Review C7: a directive matched by WORD OVERLAP is
 * advisory — when a reply exists it never yields 'done' (the reply's
 * 'answered' wins). Used by the fallback brief, for asks the model skipped,
 * and to overrule a model 'unknown' that contradicts the evidence. Exported
 * for tests.
 */
export function deterministicAskStatus(ask: { directive?: DirectiveRow | null; directiveTier?: DirectiveMatchTier; reply?: ReplyRow | null }): { status: BriefAskStatus; note: string } {
  const d = ask.directive ?? null;
  const advisoryDone = !!d && d.status === 'done' && ask.directiveTier === 'overlap' && !!ask.reply;
  if (d && d.status === 'done' && !advisoryDone) return { status: 'done', note: d.evidence ? plain(d.evidence, 120) : "recorded as done in the supervisor's ledger" };
  // Audit 96fb2f25: the harness stamp 'answered' (a reply landed — the outcome
  // is NOT verified) renders as 'answered', never 'done'. The note prefers the
  // reply gist; the 6h reply window can miss it, so fall back to the evidence
  // stamp ('msg <id>') and then a plain statement.
  if (d && d.status === 'answered') {
    const gist = replyGist(ask.reply?.text ?? '');
    const evNote = d.evidence ? plain(d.evidence, 120) : '';
    return { status: 'answered', note: gist || (evNote && evNote !== 'msg' ? evNote : 'a supervisor reply landed — no verified outcome yet') };
  }
  if (ask.reply) return { status: 'answered', note: replyGist(ask.reply.text) || 'the supervisor replied in chat' };
  if (d) return { status: 'open', note: "recorded in the supervisor's ledger, still open" };
  return { status: 'unknown', note: ASK_UNTRACKED_NOTE };
}

/** sha256/32 over the sorted asks × ledger status × match tier × reply presence. Pure. Exported for tests. */
export function asksFingerprintOf(asks: OwnerAskRow[]): string {
  const lines = asks
    .map((a) => `${a.id ?? ''}|${a.at.toISOString()}|${a.directive ? `${a.directive.status}:${a.directiveTier ?? ''}` : '-'}|${a.reply ? 'reply' : '-'}`)
    .sort();
  return createHash('sha256').update(lines.join('\n')).digest('hex').slice(0, 32);
}

// isSupervisorReplyRow: ./supervisor-reply-row (shared leaf).

/**
 * The supervisor's on-turn reply to each ask: the first qualifying assistant
 * row after it within BRIEF_REPLY_WINDOW_MS. ONE findMany serves every ask
 * (review C21): assistant rows of the chat after the oldest ask, restricted to
 * the asks' own 6-hour windows, oldest first, bounded by BRIEF_REPLY_FETCH,
 * then partitioned per ask in memory. A read failure PROPAGATES (review C8) —
 * an ask must not read as unanswered because the lookup broke.
 */
async function loadReplies(chatId: string, asks: Array<{ at: Date }>): Promise<Array<ReplyRow | null>> {
  if (!asks.length) return [];
  const oldestMs = Math.min(...asks.map((a) => a.at.getTime()));
  const rows = await prisma.crossModelMessage.findMany({
    where: {
      chatId,
      role: 'assistant',
      createdAt: { gt: new Date(oldestMs) },
      OR: asks.map((a) => ({ createdAt: { gt: a.at, lte: new Date(a.at.getTime() + BRIEF_REPLY_WINDOW_MS) } })),
    },
    select: { id: true, content: true, createdAt: true, metadata: true },
    orderBy: { createdAt: 'asc' },
    take: BRIEF_REPLY_FETCH,
  });
  const replies: ReplyRow[] = [];
  for (const r of rows as Array<{ id: string; content: string | null; createdAt: Date; metadata: any }>) {
    if (!isSupervisorReplyRow(r)) continue;
    replies.push({ id: String(r.id), at: new Date(r.createdAt), text: String(r.content ?? '').trim().replace(/\s+/g, ' ').slice(0, BRIEF_REPLY_TEXT_MAX) });
  }
  return asks.map((a) => {
    const from = a.at.getTime();
    const to = from + BRIEF_REPLY_WINDOW_MS;
    return replies.find((r) => r.at.getTime() > from && r.at.getTime() <= to) ?? null;
  });
}

/**
 * The ledger (newest first) and the owner's asks — each with its directive
 * (and match tier) and reply. Shared by the brief and the fingerprint; loaded
 * ONCE per card and handed to buildProjectBrief (review C21). Every read
 * failure PROPAGATES (review C8): a brief must never be built from an empty
 * ledger that merely failed to load. Exported for tests.
 */
export async function loadAskContext(supervisorChatId: string, now: Date): Promise<AskContext> {
  const doc = await getSupervisorState(supervisorChatId);
  // Newest first BEFORE the cap — the stored arrays are oldest-first (2026-09-24).
  const directives: DirectiveRow[] = newestFirst([...doc.directives, ...doc.archived]
    .map((d) => ({ at: d.at, text: d.text, status: d.status, evidence: d.evidence, archivedAt: d.archivedAt })))
    .slice(0, 60);
  // Review C9: the wide scan carries no content — origin lives in metadata.
  const candidates = (await prisma.crossModelMessage.findMany({
    where: { chatId: supervisorChatId, role: 'user', createdAt: { gte: new Date(now.getTime() - BRIEF_ASKS_WINDOW_MS) } },
    select: { id: true, createdAt: true, metadata: true },
    orderBy: { createdAt: 'desc' },
    take: BRIEF_ASKS_FETCH,
  })) as Array<{ id: string; createdAt: Date; metadata: any }>;
  const ownerRows = candidates.filter((r) => isOwnerOrigin(r.metadata)).slice(0, BRIEF_OWNER_CONTENT_FETCH);
  const contentById = new Map<string, string>();
  if (ownerRows.length) {
    const withContent = (await prisma.crossModelMessage.findMany({
      where: { id: { in: ownerRows.map((r) => String(r.id)) } },
      select: { id: true, content: true },
    })) as Array<{ id: string; content: string | null }>;
    for (const r of withContent) contentById.set(String(r.id), String(r.content ?? ''));
  }
  const owner = ownerRows
    .map((r) => ({ id: String(r.id), at: new Date(r.createdAt), raw: (contentById.get(String(r.id)) ?? '').trim() }))
    .filter((r) => r.raw.length > 0 && !r.raw.startsWith('[') && !isStatusCheckOrAck(r.raw))
    .slice(0, BRIEF_MAX_ASKS)
    .map((r) => ({ id: r.id, at: r.at, text: r.raw.replace(/\s+/g, ' ').trim().slice(0, BRIEF_ASK_TEXT_MAX) }));
  const replies = await loadReplies(supervisorChatId, owner);
  const asks: OwnerAskRow[] = owner.map((a, i) => {
    const m = findDirectiveMatch(a, directives);
    return { ...a, directive: m?.directive ?? null, ...(m ? { directiveTier: m.tier } : {}), reply: replies[i] };
  });
  return { directives, asks };
}

/**
 * Cheap change key for the "You asked" ledger (2026-09-24): the card compares
 * it with the previous brief's `asksFingerprint`; a moved fingerprint is a
 * real change (a real card, a rebuilt brief) even on an unchanged status
 * hash. Returns the fingerprint WITH the loaded context so the card can hand
 * it to buildProjectBrief and nothing is read twice (review C21). Null when
 * the chat is unknown or the reads fail (the caller then cannot prove nothing
 * moved and treats the asks as changed).
 */
export async function computeAsksFingerprint(
  supervisorChatId: string | null | undefined,
  now: Date = new Date(),
): Promise<{ fingerprint: string; context: AskContext } | null> {
  if (!supervisorChatId) return null;
  try {
    const context = await loadAskContext(supervisorChatId, now);
    return { fingerprint: asksFingerprintOf(context.asks), context };
  } catch (err: any) {
    logger.warn(`project-brief: asks fingerprint failed for ${String(supervisorChatId).slice(0, 8)}: ${err?.message ?? err}`);
    return null;
  }
}

async function loadInputs(projectId: string, supervisorChatId: string | null, now: Date, preloaded?: AskContext | null): Promise<{
  projectName: string; goals: BoardRow[]; todos: BoardRow[]; questions: string[]; directives: DirectiveRow[]; asks: OwnerAskRow[]; asksFingerprint?: string; kpi?: KpiPremiseLike | null;
} | null> {
  const project = await prisma.crossModelProject.findUnique({ where: { id: projectId }, select: { name: true } });
  if (!project) return null;
  const [goals, todos, questions] = await Promise.all([
    prisma.projectGoal.findMany({ where: { projectId }, select: { title: true, status: true, progressNote: true, blockedReason: true, updatedAt: true, premises: true }, orderBy: { updatedAt: 'desc' }, take: 20 }),
    prisma.projectTodo.findMany({ where: { projectId, status: { not: 'dropped' } }, select: { title: true, status: true, progressNote: true, blockedReason: true, updatedAt: true }, orderBy: { updatedAt: 'desc' }, take: 40 }),
    // owner_questions carry no projectId — the ones raised from this project's supervisor chat are the project's.
    supervisorChatId
      ? prisma.ownerQuestion.findMany({ where: { chatId: supervisorChatId, status: 'open' }, select: { question: true }, orderBy: { createdAt: 'desc' }, take: 5 }).catch(() => [] as Array<{ question: string }>)
      : Promise.resolve([] as Array<{ question: string }>),
  ]);
  let directives: DirectiveRow[] = [];
  let asks: OwnerAskRow[] = [];
  let asksFingerprint: string | undefined;
  if (supervisorChatId) {
    // Review C8: a failure here propagates — never a brief from empty evidence.
    const ctx = preloaded ?? (await loadAskContext(supervisorChatId, now));
    directives = ctx.directives;
    asks = ctx.asks;
    asksFingerprint = asksFingerprintOf(asks);
  }
  // a8d6e514: the brief prompt carries the bounded display form of a (≤2,000-char) note.
  const row = (g: any): BoardRow => ({ title: String(g.title ?? ''), status: String(g.status ?? ''), note: progressNoteForDisplay(g.progressNote), blocked: g.blockedReason ?? null, updatedAt: g.updatedAt ?? null });
  // The KPI of record: the first active (then blocked) goal's kpi: premise.
  const kpi = ([...goals] as any[])
    .sort((a, b) => Number(b.status === 'active') - Number(a.status === 'active'))
    .filter((g) => g.status === 'active' || g.status === 'blocked')
    .map((g) => kpiPremiseOf(readPremisesLoose(g.premises)))
    .find((p): p is KpiPremiseLike => !!p) ?? null;
  return { projectName: project.name, goals: goals.map(row), todos: todos.map(row), questions: questions.map((q) => String(q.question ?? '')), directives, asks, ...(asksFingerprint ? { asksFingerprint } : {}), kpi };
}

/** "5.08 tok/s (measured 2h ago, receipt f5b42fe6), bar ≥10" — the brief's own KPI sentence. */
export function kpiBriefSentence(kpi: KpiPremiseLike, now: Date): string {
  const bar = kpiBarText(kpi);
  const ofRecord = kpiOfRecordText(kpi, now); // "5.08 tok/s — receipt f5b42fe6, 2h ago"
  const [value, meta] = ofRecord.split(' — ');
  return `KPI of record (${kpiBareKey(kpi.key).replace(/[_-]+/g, ' ')}): ${value}${meta ? ` (measured ${meta})` : ''}${bar ? `, ${bar}` : ''}.`;
}

/** The "now" sentence about work sessions, from the measured counters (2026-09-24 B3):
 *  running → "N work session(s) running: <titles>"; only scheduled → nothing is
 *  running, M scheduled to wake later; none → nothing is running. The titles
 *  come from the timing block (capped at its lane limit); when the UNCAPPED
 *  count exceeds them, "…and N more running" keeps the count and the list in
 *  agreement (review C18). Exported for tests. */
export function sessionsSentence(status: ProjectStatus): string {
  const running = status.lanesRunning ?? 0;
  const scheduled = status.lanesScheduled ?? 0;
  if (running > 0) {
    const titles = (status.timing?.lanes ?? []).filter((l) => l.state === 'running').map((l) => plain(l.title, 48)).filter(Boolean);
    const more = running - titles.length;
    const list = titles.length ? `: ${titles.join(', ')}${more > 0 ? `, …and ${more} more running` : ''}` : '';
    return `${running} work session${running === 1 ? '' : 's'} running${list}.`;
  }
  if (scheduled > 0) return `Nothing is running right now; ${scheduled} session${scheduled === 1 ? ' is' : 's are'} scheduled to wake later.`;
  return 'Nothing is running right now.';
}

/** Deterministic brief from the same inputs — used when the model is unavailable or answers junk. Exported for tests. */
export function fallbackBrief(input: {
  projectName: string; status: ProjectStatus; goals: BoardRow[]; asks: OwnerAskRow[]; directives: DirectiveRow[]; now: Date; asksFingerprint?: string; kpi?: KpiPremiseLike | null;
}): ProjectBrief {
  const active = input.goals.filter((g) => g.status === 'active');
  // audit 2026-10-06 T8-3: the counts of record (status.goals — what the headline renders), never the
  // 20-row goal list's length; BRIEF_GOAL_COUNTS_DISABLED=1 counts the list as before.
  const counts = goalCountsOf(input.status);
  const done = counts ? counts.done : input.goals.filter((g) => g.status === 'done').length;
  const total = counts ? counts.total : input.goals.length;
  const mission = active[0]
    ? `${plain(input.projectName, 60)} is working toward: ${plain(active[0].title, 140)}.${total ? ` ${done} of ${total} goals are done.` : ''}`
    : `${plain(input.projectName, 60)}: ${total ? `${done} of ${total} goals are done; nothing is active right now.` : 'no goals have been set yet.'}`;
  const first = input.status.workingOn[0];
  // A "Running: <lane>" entry (status B4) is already the sessions sentence — no "Right now:" echo.
  const nowLine = [first && !/^Running: /.test(first) ? `Right now: ${first}.` : '', sessionsSentence(input.status), input.kpi ? kpiBriefSentence(input.kpi, input.now) : ''].filter(Boolean).join(' ');
  const asks: ProjectBriefAsk[] = input.asks.map((a) => {
    const m = a.directive === undefined ? findDirectiveMatch(a, input.directives) : null;
    const det = deterministicAskStatus(a.directive === undefined ? { directive: m?.directive ?? null, directiveTier: m?.tier, reply: a.reply } : a);
    return { at: a.at.toISOString(), text: a.text, status: det.status, note: det.note };
  });
  return {
    mission, now: nowLine,
    changed: input.status.doneSince.slice(0, 3),
    blocked: input.status.blocked.slice(0, 3),
    next: input.status.next[0] ?? '',
    asks, generatedAt: input.now.toISOString(), source: 'fallback',
    ...(input.asksFingerprint ? { asksFingerprint: input.asksFingerprint } : {}),
  };
}

/** The prompt's GOAL COUNTS block ('' under the kill switch — the prompt is then byte-identical to before). */
function goalCountsBlock(status: ProjectStatus): string {
  const c = goalCountsOf(status);
  if (!c) return '';
  return `
GOAL COUNTS (exact, of record — the ONLY goal numbers you may state; the GOALS list below shows at most the 20 most recently updated and is NOT a count; archived goals are not counted): ${c.total} goal${c.total === 1 ? '' : 's'} — ${c.active} active, ${c.done} done, ${c.blocked} blocked.
`;
}

function buildPrompt(input: {
  projectName: string; status: ProjectStatus; goals: BoardRow[]; todos: BoardRow[]; questions: string[]; directives: DirectiveRow[]; asks: OwnerAskRow[]; now: Date; kpi?: KpiPremiseLike | null;
}): string {
  const fmt = (r: BoardRow) => `- [${r.status}] ${r.title}${r.note ? ` — progress note: ${String(r.note).slice(0, 300)}` : ''}${r.blocked ? ` — blocked: ${String(r.blocked).slice(0, 200)}` : ''}`;
  const askBlock = (a: OwnerAskRow) => {
    const d = a.directive;
    const ledger = d
      ? `LEDGER: ${d.status}${d.archivedAt ? ' (archived)' : ''}${a.directiveTier === 'overlap' ? ' (matched by wording — advisory)' : ''}${d.evidence ? ` — evidence: ${d.evidence.slice(0, 160)}` : ''}`
      : 'LEDGER: (no directive recorded for this message)';
    const reply = a.reply
      ? `SUPERVISOR'S REPLY (msg ${a.reply.id.slice(0, 8)}): "${a.reply.text.slice(0, BRIEF_REPLY_TEXT_MAX)}"`
      : `SUPERVISOR'S REPLY: (none within ${Math.round(BRIEF_REPLY_WINDOW_MS / 3_600_000)} hours)`;
    return `- ${a.at.toISOString()} "${a.text}"\n    ${ledger}\n    ${reply}`;
  };
  return `You write the one-paragraph PROJECT BRIEF a busy owner reads to remember what one of many projects is doing. Plain English. Present tense. No identifiers of any kind: no ids, hashes, firing numbers, census strings, lane names, ticket numbers, PR numbers, timestamps with Z. Refer to work by WHAT it is ("the citator re-scrape", "the 16-GPU serving cluster"), never by lane or run. Every statement must come from the inputs below — never invent, never guess at numbers.

Project: ${input.projectName}
Now: ${input.now.toISOString()}
${goalCountsBlock(input.status)}
GOALS (status, title, the lane's own progress note):
${input.goals.map(fmt).join('\n') || '(none)'}

TODOS (open ones):
${input.todos.filter((t) => t.status !== 'done').slice(0, 15).map(fmt).join('\n') || '(none)'}

OPEN QUESTIONS WAITING ON THE OWNER:
${input.questions.map((q) => `- ${q.slice(0, 240)}`).join('\n') || '(none)'}

STATUS CARD (already plain):
- Working on: ${input.status.workingOn.join(' | ') || '(nothing)'}
- Done in the last hour: ${input.status.doneSince.join(' | ') || '(nothing)'}
- Blocked: ${input.status.blocked.join(' | ') || '(nothing)'}
- Next: ${input.status.next.join(' | ') || '(nothing)'}
- Work sessions running: ${input.status.lanesRunning} · scheduled (idle until their next wake): ${input.status.lanesScheduled ?? 0}
${input.kpi ? `
MISSION KPI (of record — the ONLY rate you may state; the "now" sentence must quote it verbatim and no other rate from any note may replace it):
- ${kpiBriefSentence(input.kpi, input.now)}
` : ''}
OWNER DIRECTIVE LEDGER (what the supervisor recorded the owner asking, NEWEST FIRST, with status and evidence):
${newestFirst(input.directives).slice(0, 30).map((d) => `- ${d.at} [${d.status}${d.archivedAt ? ', archived' : ''}] ${d.text.slice(0, 200)}${d.evidence ? ` — evidence: ${d.evidence.slice(0, 160)}` : ''}`).join('\n') || '(none)'}

OWNER'S RECENT MESSAGES (verbatim, newest first) — each with its ledger row and the supervisor's own reply in the chat:
${input.asks.map(askBlock).join('\n') || '(none)'}

Write JSON only:
{
  "mission": "ONE sentence: what this project is for and where it stands overall (${goalCountsOf(input.status) ? "goal numbers copied from GOAL COUNTS, e.g. '7 of 8 goals done'" : "e.g. '7 of 8 goals done'"}).",
  "now": "1-2 sentences: what is being worked on right now and how far along, in words a non-engineer follows.",
  "changed": ["up to 3 short bullets: what moved since the last look — only from Done/Working on/progress notes"],
  "blocked": ["up to 3 short bullets: what is stuck, and whether it needs the owner"],
  "next": "ONE sentence: the next milestone and what it depends on.",
  "asks": [
    {"at": "<the message's ISO time, copied exactly>", "text": "<the owner's words, copied>", "status": "done|in_progress|answered|open|unknown", "note": "≤20 words: what became of it, grounded in the ledger, the reply, goals and todos"}
  ]
}
Rules for asks: one row per OWNER MESSAGE above (same order). Status:
- LEDGER says done → "done"; the note is grounded in that evidence.
- LEDGER says answered (your reply landed, no verified outcome yet) → "answered"; the note is a ≤20-word gist of the reply — never "done".
- a question the supervisor replied to → "answered"; the note is a ≤20-word gist of the reply.
- an order with a reply but no ledger or board evidence → "in_progress" or "answered", whichever the reply supports.
- LEDGER open and no reply → "open".
- ONLY when there is neither a ledger row, a board change, nor a reply → "unknown" with the note "${ASK_UNTRACKED_NOTE}" (never "no record yet").
Never mark done without evidence in the inputs.`;
}

function sanitizeBrief(raw: any, input: { asks: OwnerAskRow[]; now: Date; asksFingerprint?: string; kpi?: KpiPremiseLike | null } & Partial<Parameters<typeof fallbackBrief>[0]>): ProjectBrief | null {
  if (!raw || typeof raw !== 'object') return null;
  const line = (v: unknown, max = BRIEF_LINE_MAX) => plain(typeof v === 'string' ? v : '', max);
  const list = (v: unknown, n: number) => (Array.isArray(v) ? v.map((x) => line(x)).filter(Boolean).slice(0, n) : []);
  const mission = line(raw.mission);
  let now = line(raw.now, 320);
  const next = line(raw.next);
  // KPI honesty (finding 4, tightened by the 2026-09-27 fixer follow-up): a
  // "now" that types a rate in the KPI's unit which the register does NOT hold
  // (the value, its bar, the previous reading and the history ring all count as
  // held) asserts a current value the register contradicts — it is replaced by
  // the deterministic sentence. "next" is a target / milestone sentence: a rate
  // there is not a claim of the current value, so it is kept verbatim (it used
  // to be erased for the first pending todo title). The register sentence is
  // appended when "now" omitted the number.
  if (input.kpi && input.kpi.unit && input.status && input.goals && input.directives) {
    const det = fallbackBrief({ projectName: input.projectName ?? '', status: input.status, goals: input.goals, asks: input.asks, directives: input.directives, now: input.now, kpi: input.kpi });
    if (typedRatesDisagreeingWithKpi(now, input.kpi).length) now = det.now;
    const sentence = kpiBriefSentence(input.kpi, input.now);
    if (now && !now.includes(sentence) && !now.includes(String(input.kpi.value))) now = `${now} ${sentence}`.slice(0, 480);
  }
  if (!mission && !now) return null;
  const byTime = new Map(input.asks.map((a) => [a.at.toISOString(), a]));
  const asks: ProjectBriefAsk[] = [];
  const withVerdict = (src: OwnerAskRow, modelStatus: unknown, modelNote: unknown): ProjectBriefAsk => {
    const det = deterministicAskStatus(src);
    let status: BriefAskStatus = ASK_STATUSES.has(modelStatus as BriefAskStatus) ? (modelStatus as BriefAskStatus) : det.status;
    let note = line(modelNote, 140);
    // The model may not answer 'unknown' against the evidence: a ledger close
    // or a reply in the inputs is the verdict (2026-09-24).
    if (status === 'unknown' && det.status !== 'unknown') { status = det.status; note = det.note; }
    // Audit 96fb2f25: the model may not type 'done' over a ledger 'answered'
    // row — a reply landing is not a fulfilled request (the raspi specimen
    // rendered "done" while the fix lane was still running). The deterministic
    // floor wins, symmetric to the unknown-clamp above.
    if (det.status === 'answered' && status === 'done') { status = 'answered'; note = det.note; }
    // Review C11: "no record" is never shown at ANY status — the evidence-backed
    // note replaces it when the verdicts agree; otherwise the note goes.
    if (/no record/i.test(note)) note = det.status === status ? det.note : '';
    // Review C10: an empty (or scrubbed-to-empty) model note takes the
    // deterministic one when the verdicts agree, or whenever the evidence has
    // a verdict at all — a grounded clause beats a blank.
    if (!note && (det.status === status || det.status !== 'unknown')) note = det.note;
    return { at: src.at.toISOString(), text: src.text, status, ...(note ? { note } : {}) };
  };
  if (Array.isArray(raw.asks)) {
    for (const a of raw.asks) {
      if (!a || typeof a !== 'object') continue;
      const at = typeof a.at === 'string' ? a.at : '';
      const src = byTime.get(at) ?? input.asks.find((x) => x.text.toLowerCase().startsWith(String(a.text ?? '').toLowerCase().slice(0, 30)) && String(a.text ?? '').length > 8);
      if (!src) continue; // the model may not invent an ask
      if (asks.some((x) => x.at === src.at.toISOString())) continue;
      asks.push(withVerdict(src, a.status, a.note));
      if (asks.length >= BRIEF_MAX_ASKS) break;
    }
  }
  // Every owner message gets a row even when the model skipped it — with the deterministic verdict, never a bare 'unknown'.
  for (const a of input.asks) {
    if (asks.length >= BRIEF_MAX_ASKS) break;
    if (!asks.some((x) => x.at === a.at.toISOString())) asks.push(withVerdict(a, undefined, undefined));
  }
  asks.sort((x, y) => (x.at < y.at ? 1 : x.at > y.at ? -1 : 0));
  return {
    mission, now, changed: list(raw.changed, 3), blocked: list(raw.blocked, 3), next,
    asks, generatedAt: input.now.toISOString(), source: 'model',
    ...(input.asksFingerprint ? { asksFingerprint: input.asksFingerprint } : {}),
  };
}

/**
 * Build the brief for one project. `status` is the rendered (identifier-free)
 * card; `supervisorChatId` is the project supervisor's chat (directives + the
 * owner's messages); `askContext` is the ledger/asks the card already loaded
 * for the fingerprint (review C21 — passed through so nothing is read twice).
 * Returns null when the project is gone, the kill switch is set, or the
 * INPUTS could not be read (review C8: never a confident brief built from
 * empty evidence — the card keeps its previous brief). A MODEL failure falls
 * back to the deterministic brief. Never throws.
 */
export async function buildProjectBrief(
  projectId: string,
  status: ProjectStatus,
  opts: { now?: Date; supervisorChatId?: string | null; askContext?: AskContext | null } = {},
): Promise<ProjectBrief | null> {
  const now = opts.now ?? new Date();
  const t0 = Date.now();
  try {
    const input = await loadInputs(projectId, opts.supervisorChatId ?? null, now, opts.askContext ?? null);
    if (!input) return null;
    const full = { ...input, status, now };
    let raw = '';
    // Which provider leg answered + its finish reason (firing 45): the brief's
    // parse_error rows carried budgetTokens but NO leg, so a truncation could
    // not be attributed (Edge override vs DeepSeek vs DashScope) from the audit
    // alone. onMeta lands both on every outcome row below.
    let leg: string | undefined;
    let finishReason: string | undefined;
    const briefMessages = [{ role: 'user' as const, content: buildPrompt(full) }];
    try {
      raw = await utilityChat(briefMessages, {
        maxTokens: PROJECT_BRIEF_BUDGET_TOKENS, temperature: 0.2, timeout: 90000, retryNotFound: true,
        thinking: true,
        contentOnly: true, // JSON extractor (2026-09-24) — never parse reasoning as the brief
        onMeta: (m) => { leg = m.leg; finishReason = m.finishReason; },
      });
    } catch (err: any) {
      recordExtractionOutcome({ userId: projectId, source: 'project_brief', outcome: 'llm_error', ms: Date.now() - t0, budgetTokens: PROJECT_BRIEF_BUDGET_TOKENS, ...(leg ? { leg } : {}), ...(finishReason ? { finishReason } : {}), detail: String(err?.message ?? err) });
      return fallbackBrief(full);
    }
    let brief = sanitizeBrief(parseModelJson(raw), full);
    // f160 (2026-10-18 audit): even at the 16384 thinking floor with bounded-low
    // reasoning, the thinking leg clips the brief JSON mid-body ~1-2/day (9 rows
    // in 7d, EVERY one leg=deepseek finishReason=length — the rollup's
    // memory_parse_error_4h ESCALATE; goal-count growth outran the cap). The clip
    // signature is EXACTLY finishReason='length' with a non-empty raw: retry ONCE
    // with thinking OFF — no reasoning eats the budget, so the whole cap is JSON
    // room. A junk answer with fr≠'length' never re-pays the call.
    if (!brief && raw.trim() && finishReason === 'length') {
      const clippedLeg = leg;
      try {
        raw = await utilityChat(briefMessages, {
          maxTokens: PROJECT_BRIEF_BUDGET_TOKENS, temperature: 0.2, timeout: 90000, retryNotFound: true,
          thinking: false,
          contentOnly: true,
          onMeta: (m) => { leg = m.leg; finishReason = m.finishReason; },
        });
        brief = sanitizeBrief(parseModelJson(raw), full);
        recordLoopMetric({ kind: 'brief_length_retry', meta: { projectId, clippedLeg, retryLeg: leg, retryOutcome: brief ? 'changed' : 'parse_error' } });
      } catch {
        // The retry failed too — raw/leg/finishReason still describe the clipped
        // first call, so the parse_error row below attributes THAT clip.
      }
    }
    if (brief) {
      // audit 2026-10-06 T8-3: a model-typed goal count that disagrees with the card's counts is replaced.
      const counts = goalCountsOf(status);
      const fixedCounts = reconcileBriefGoalCounts(brief, counts);
      if (fixedCounts.length) {
        recordLoopMetric({ kind: 'brief_goal_count_fixed', meta: { projectId, fixed: fixedCounts.slice(0, 4).map((f) => f.slice(0, 60)), counts } });
      }
    }
    if (!brief) {
      recordExtractionOutcome({ userId: projectId, source: 'project_brief', outcome: raw.trim() ? 'parse_error' : 'empty', ms: Date.now() - t0, budgetTokens: PROJECT_BRIEF_BUDGET_TOKENS, ...(leg ? { leg } : {}), ...(finishReason ? { finishReason } : {}), detail: raw.slice(0, 160).replace(/\s+/g, ' ') });
      return fallbackBrief(full);
    }
    recordExtractionOutcome({ userId: projectId, source: 'project_brief', outcome: 'changed', ms: Date.now() - t0, budgetTokens: PROJECT_BRIEF_BUDGET_TOKENS, ...(leg ? { leg } : {}), ...(finishReason ? { finishReason } : {}), detail: `${brief.asks.length} asks` });
    return brief;
  } catch (err: any) {
    logger.warn(`project-brief: inputs unreadable for ${projectId.slice(0, 8)} (no brief — the card keeps its previous one): ${err?.message ?? err}`);
    return null;
  }
}

/** Markdown for surfaces that only have the body (the card renders from metadata). */
export function renderBriefMarkdown(brief: ProjectBrief, formatAt: (iso: string) => string = (iso) => iso.slice(0, 16).replace('T', ' ') + 'Z'): string {
  const lines: string[] = [];
  lines.push('**In plain words**');
  lines.push([brief.mission, brief.now].filter(Boolean).join(' '));
  if (brief.next) lines.push(`Next: ${brief.next}`);
  if (brief.asks.length) {
    lines.push('');
    lines.push('**You asked**');
    for (const a of brief.asks.slice(0, 5)) {
      const st = a.status === 'in_progress' ? 'in progress' : a.status;
      lines.push(`- ${formatAt(a.at)} — "${a.text.length > 90 ? a.text.slice(0, 89) + '…' : a.text}" → ${st}${a.note ? `: ${a.note}` : ''}`);
    }
  }
  return lines.join('\n');
}
