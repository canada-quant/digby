/**
 * Agent-message drain triage — decision-gate purpose `drain_triage`
 * (N6, docs/DECISION_MODEL_ENHANCEMENTS_2026-09-25.md §5; shipped SHADOW).
 *
 * WHY: report-ups queued via send_chat_message while a chat is busy drain as
 * a FULL detached reasoning turn (chat-agent.service drainChatQueue). On the
 * supervisor chats that is 157 turns/day, 58 of them no-op, and the SLOWEST
 * class of turn the fleet runs (p50 475–697 s, $7.5–15/day). wake_triage
 * never sees them — they arrive through the message queue, not a hook. The
 * gate asks ONE typed choice over the batched agent rows BEFORE the drain
 * starts the turn: acknowledge only / hold and coalesce / act now.
 *
 * STATE is CODE-COMPUTED first (the wake_triage lesson — a decision model
 * reads counts and flags, and a prose-only state was "confidently misled"):
 * row count, distinct senders, ages, whether any row reads as a question or
 * request, whether the SENDER AWAITS A REPLY, failure/block cues, superseded
 * markers, the open-directive count from the supervisor's own ledger, the
 * hook wake-depth, and how many USER rows wait behind the batch. The bodies
 * (lane-authored prose) come LAST and capped at DRAIN_TRIAGE_BODY_CAP.
 *
 * MODES (decisionMode('drain_triage'); default shadow, NODE_ENV=test off):
 *   shadow — the drain is UNCHANGED; the decision stash rides the started run
 *            (ChatAgentRunArgs.decision) and decision-outcome-labels.ts labels
 *            it at the run's finalize from what the drained turn actually did
 *            (a mutating platform tool or an ACTIONS TAKEN note ⇒ act_now;
 *            otherwise ack_only; a `coalesce` prediction agrees with an
 *            ack_only actual — both are "no turn now").
 *   act    — DESIGNED, NOT ENABLED: a confidently quiet batch (ack_only or
 *            coalesce at or above its option threshold) is PARKED — the rows
 *            stay pending, a Redis marker carries triagedAt + the retry
 *            instant (the hook-event `triagedAt` / `retryAt` idiom; the
 *            pending_chat_messages table has no such columns), and the drain
 *            returns without starting a turn. The orphan sweeper re-drains
 *            the chat every ~2 min, so the rows deliver on their own once the
 *            park lapses — and a parked batch is NEVER re-triaged (the marker
 *            outlives the park), so the delay is bounded by ONE defer window.
 *            USER rows are never gated: a batch is parked only when no user
 *            row waits behind it (humans preempt machine traffic).
 * Fail-open everywhere: a ledger read error, a null gate answer, a Redis
 * hiccup, a thrown anything ⇒ the drain proceeds exactly as before. Kill
 * switches: the gate-wide switches.
 *
 * LEAF: imports decision-gate statically; the supervisor state ledger is
 * pulled DYNAMICALLY (supervisor-state.service → prisma + the platform graph;
 * chat-agent.service must stay importable under partial test mocks).
 */

import prisma from '../../../config/database';
import redisClient from '../../../config/redis';
import logger from '../../../utils/logger';
import {
  decide, decisionMode, decisionOptionThreshold, recordDecisionOutcome, stashDecision,
  type DecideResult, type DecisionAnswer, type DecisionQuestion, type DecisionStash,
} from './decision-gate';

// ── Tunables ─────────────────────────────────────────────────────────────────

/** The question key on every drain_triage decision/outcome row. */
export const DRAIN_TRIAGE_QUESTION = 'disposition';
export const DRAIN_DISPOSITIONS = ['ack_only', 'coalesce', 'act_now'] as const;
export type DrainDisposition = typeof DRAIN_DISPOSITIONS[number];
/** Acting confidence (DECISION_GATE_THRESHOLD_DRAIN_TRIAGE[_<OPTION>] overrides; clamped by the runtime). */
export const DRAIN_TRIAGE_DEFAULT_THRESHOLD = 0.85;
/** Gate deadline — the drain is a machine path (nobody waits on it), but it must stay a small slice of a queue hop. */
export const DRAIN_TRIAGE_TIMEOUT_MS = 4000;
/** Ledger read deadline — past it the gate is NOT asked (no state, no decision). */
export const DRAIN_TRIAGE_SNAPSHOT_TIMEOUT_MS = 3000;
/** Total prose budget for the batched bodies (the doc's ≤4k) and the per-row head. */
export const DRAIN_TRIAGE_BODY_CAP = 4000;
export const DRAIN_TRIAGE_ROW_HEAD_CHARS = 1200;
/** ACT park length in minutes (env DECISION_GATE_DRAIN_TRIAGE_DEFER_MIN, clamped 5..60). */
export const DRAIN_TRIAGE_DEFAULT_DEFER_MIN = 15;
/** How long the "already triaged" marker outlives the park — no batch is re-triaged inside it. */
export const DRAIN_TRIAGE_MARKER_TTL_SEC = 2 * 60 * 60;

/** The ACT park length in minutes (clamped 5..60). */
export function drainTriageDeferMin(): number {
  const raw = Number(process.env.DECISION_GATE_DRAIN_TRIAGE_DEFER_MIN);
  const v = Number.isFinite(raw) ? Math.floor(raw) : DRAIN_TRIAGE_DEFAULT_DEFER_MIN;
  return Math.min(60, Math.max(5, v));
}

// ── code-computed flags (regex over the lane-authored bodies) ────────────────
// The harness's own reading of the prose — cheap, explicit, visible to the
// model in the state, and the honest answer to "does the sender await a
// reply" (send_chat_message carries no such field; the cue is in the text).
const QUESTION_RE = /\?\s*$|\b(?:please|request(?:s|ed|ing)?|need(?:s)? (?:you|your|the supervisor)|awaiting|waiting (?:for|on) (?:you|your|the supervisor|a decision|approval)|decision needed|should (?:i|we)\b|can you|could you|approv(?:e|al)|sign[- ]?off|input needed|guidance)\b/im;
const AWAITS_REPLY_RE = /\?\s*$|\b(?:please (?:reply|respond|confirm|advise|rule|decide)|reply (?:needed|requested|required|when you can)|awaiting (?:your |a )?(?:reply|response|decision|ruling|guidance|approval|go[- ]ahead)|let me know|need(?:s)? (?:a |your )?(?:decision|ruling|approval|answer|reply|go[- ]ahead)|waiting (?:for|on) (?:you|your|a reply|a decision|approval)|should (?:i|we)\b|can you|could you|would you|do you want|which (?:do you|should)|confirm (?:before|whether|if|that)|blocked on you|your call)\b/im;
const FAILURE_RE = /\b(?:fail(?:ed|ure|ures|ing)?|error(?:s|ed)?|blocked|stuck|stall(?:ed|ing)?|cannot|can't|unable|time(?:d)?[- ]?out|OOM|killed|exit code [1-9]\d*|rejected|REPLACED|UNVERIFIED|regression|broken|crash(?:ed|ing)?)\b/i;
const REPORT_ONLY_RE = /\b(?:FYI|for your (?:information|records)|no action (?:needed|required)|status update|progress (?:report|update)|heads[- ]up|completed successfully|done:|report[- ]up)\b/i;

const clip = (v: unknown, max: number): string => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/** Minimal row shape the builder reads (pending_chat_messages rows). */
export interface DrainRowLike {
  id: string;
  content: string;
  createdAt: Date | string;
  source?: string;
}

export interface DrainOriginLike {
  kind?: string;
  sourceChatId?: string;
  depth?: number;
}

export interface DrainTriageCodeFlags {
  rows: number;
  distinct_senders: number;
  oldest_row_age_min: number | null;
  newest_row_age_min: number | null;
  any_row_is_question_or_request: boolean;
  sender_awaits_reply: boolean;
  any_row_reports_failure_or_block: boolean;
  any_row_reads_report_only: boolean;
  any_row_superseded_by_owner: boolean;
  max_hook_depth: number;
}

/** The code-computed facts of a batch. Pure; tolerant of malformed rows. */
export function drainTriageCodeFlags(
  rows: readonly DrainRowLike[],
  origins: ReadonlyArray<DrainOriginLike | null | undefined>,
  supersededNotes: ReadonlyArray<string | null | undefined>,
  now: number = Date.now(),
): DrainTriageCodeFlags {
  let question = false; let awaits = false; let failure = false; let reportOnly = false; let superseded = false;
  const ages: number[] = [];
  const senders = new Set<string>();
  let depth = 0;
  rows.forEach((r, i) => {
    const body = String(r?.content ?? '');
    if (!question && QUESTION_RE.test(body)) question = true;
    if (!awaits && AWAITS_REPLY_RE.test(body)) awaits = true;
    if (!failure && FAILURE_RE.test(body)) failure = true;
    if (!reportOnly && REPORT_ONLY_RE.test(body)) reportOnly = true;
    if (!superseded && supersededNotes[i]) superseded = true;
    const src = origins[i]?.sourceChatId ? String(origins[i]?.sourceChatId) : '';
    if (src) senders.add(src);
    depth = Math.max(depth, Number(origins[i]?.depth ?? 0) || 0);
    const t = r?.createdAt instanceof Date ? r.createdAt.getTime() : new Date(String(r?.createdAt ?? '')).getTime();
    if (Number.isFinite(t)) ages.push(Math.max(0, Math.round((now - t) / 60000)));
  });
  return {
    rows: rows.length,
    distinct_senders: senders.size,
    oldest_row_age_min: ages.length ? Math.max(...ages) : null,
    newest_row_age_min: ages.length ? Math.min(...ages) : null,
    any_row_is_question_or_request: question,
    sender_awaits_reply: awaits,
    any_row_reports_failure_or_block: failure,
    any_row_reads_report_only: reportOnly,
    any_row_superseded_by_owner: superseded,
    max_hook_depth: depth,
  };
}

// ── The state ────────────────────────────────────────────────────────────────

export type DrainTargetKind = 'fleet supervisor chat' | 'project supervisor chat' | 'plain chat';

export interface DrainTriageSnapshot {
  target: DrainTargetKind;
  /** OPEN directives on the supervisor's own ledger (null for a non-supervisor chat / read failure). */
  openDirectives: number | null;
  /** USER rows queued behind this batch (never gated; the state says humans wait). */
  pendingUserRows: number;
}

/** Bounded, fail-open ledger reads: the target's kind, its open directives, the user rows waiting. Throws propagate. */
export async function computeDrainSnapshot(chatId: string): Promise<DrainTriageSnapshot | null> {
  const chat = await prisma.crossModelChat.findUnique({
    where: { id: chatId },
    select: { id: true, isSupervisor: true, isProjectSupervisor: true },
  });
  if (!chat) return null;
  const target: DrainTargetKind = chat.isSupervisor ? 'fleet supervisor chat' : chat.isProjectSupervisor ? 'project supervisor chat' : 'plain chat';
  const [pendingUserRows, openDirectives] = await Promise.all([
    prisma.pendingChatMessage.count({ where: { chatId, source: 'user' } }).catch(() => 0),
    target === 'plain chat'
      ? Promise.resolve<number | null>(null)
      : import('./supervisor-state.service')
          .then((m) => m.getSupervisorState(chatId))
          .then((doc) => (Array.isArray(doc?.directives) ? doc.directives.filter((d) => d?.status === 'open').length : 0))
          .catch(() => null),
  ]);
  return { target, openDirectives, pendingUserRows };
}

/** The gate state — code-computed fields first, the bodies LAST and capped. Pure. */
/** SAA-1.3 PHASE 0 (todo 9114e7b5) — what buildDrainTriageState's cap DROPPED.
 *  Filled only when the caller passes `observe`; never part of the gate state. */
export interface DrainTriageObservation {
  segments: Array<{ id: string; elidedChars: number; readCall: string }>;
  /** Rows skipped whole because the prose budget ran out (the silent class). */
  droppedRows: number;
  /** Rows offered to the builder. */
  rows: number;
}
export function buildDrainTriageState(input: {
  snapshot: DrainTriageSnapshot;
  flags: DrainTriageCodeFlags;
  rows: readonly DrainRowLike[];
  origins: ReadonlyArray<DrainOriginLike | null | undefined>;
  now?: number;
  /** SAA-1.3 PHASE 0 (todo 9114e7b5) — OBSERVE-ONLY out-param. When passed, the
   *  collector is filled with what this cap DROPPED; the returned `state` is
   *  byte-identical either way (the field is never added to it, so the gate
   *  prompt cannot change). Omitted ⇒ the collector is never allocated and the
   *  state is byte-identical to before, but the per-row measurement still runs
   *  (it shares the loop it measures) — cheap, not literally zero cost. */
  observe?: DrainTriageObservation;
}): Record<string, unknown> {
  const now = input.now ?? Date.now();
  const perRow = Math.max(200, Math.min(DRAIN_TRIAGE_ROW_HEAD_CHARS, Math.floor(DRAIN_TRIAGE_BODY_CAP / Math.max(1, input.rows.length))));
  let budget = DRAIN_TRIAGE_BODY_CAP;
  const messages: Array<Record<string, unknown>> = [];
  // SAA-1.3 PHASE 0 — this surface is the most invisible of the four: a whole
  // row is skipped once the budget is gone and leaves NO trace anywhere. The
  // collector records it; nothing below changes the state this function returns.
  const spillSegments: Array<{ id: string; elidedChars: number; readCall: string }> = [];
  let droppedRows = 0;
  input.rows.forEach((r, i) => {
    if (budget <= 0) { droppedRows += 1; return; }
    const head = clip(r.content, Math.min(perRow, budget));
    budget -= head.length;
    // A row is "lost" when the per-row head is shorter than the body it came
    // from — measured on the pre-clip body, since clip() also collapses
    // whitespace (a whitespace-only shrink is not an information loss).
    const bodyLen = String(r?.content ?? '').replace(/\s+/g, ' ').trim().length;
    if (bodyLen > head.length) {
      spillSegments.push({ id: String((r as any)?.id ?? `row-${i}`), elidedChars: bodyLen - head.length, readCall: `get_chat_messages({chatId:"${input.origins[i]?.sourceChatId ?? ''}", messageId:"${String((r as any)?.id ?? '')}"})` });
    }
    const t = r?.createdAt instanceof Date ? r.createdAt.getTime() : new Date(String(r?.createdAt ?? '')).getTime();
    const src = input.origins[i]?.sourceChatId ? String(input.origins[i]?.sourceChatId).slice(0, 8) : undefined;
    messages.push({
      ...(src ? { from_chat: src } : {}),
      ...(Number.isFinite(t) ? { age_min: Math.max(0, Math.round((now - t) / 60000)) } : {}),
      head,
    });
  });
  const state: Record<string, unknown> = {
    target: input.snapshot.target,
    ...input.flags,
    open_directives_on_ledger: input.snapshot.openDirectives ?? undefined,
    user_rows_waiting_behind: input.snapshot.pendingUserRows,
    messages,
  };
  for (const k of Object.keys(state)) if (state[k] === undefined) delete state[k];
  if (input.observe) {
    input.observe.segments = spillSegments;
    input.observe.droppedRows = droppedRows;
    input.observe.rows = input.rows.length;
  }
  return state;
}

/** The typed question — a 3-way choice with an explicit "hold" option. */
export const DRAIN_TRIAGE_QUESTIONS: Record<string, DecisionQuestion> = {
  [DRAIN_TRIAGE_QUESTION]: {
    type: 'choice',
    instructions: 'These agent-sent messages were queued for this chat while it was busy. What should the receiving chat\'s harness do with the batch?',
    criteria: {
      ack_only: 'acknowledge only — informational report-ups, routine completions, status or progress chatter; no reply is awaited and no decision, dispatch or reply is needed, so a full reasoning turn would close as a no-op',
      coalesce: 'hold — nothing needs a turn now, but the batch carries state the receiver should see folded into its next wake or sweep rather than a turn of its own',
      act_now: 'run a full turn now — a sender awaits a reply, a question or request is addressed to this chat, a lane reports a failure or block, or a decision, dispatch or steer is needed',
    },
  },
};

// ── ACT park marker (Redis; the hook-event triagedAt / retryAt idiom) ─────────

const PARK_KEY = (chatId: string) => `chat:draintriage:${chatId}`;

export interface DrainParkMarker {
  /** ms epoch the park lapses (the retryAt). */
  until: number;
  /** ISO the batch was triaged. */
  triagedAt: string;
  rowIds: string[];
  disposition: DrainDisposition;
  p: number;
}

/** The marker for a chat, or null (absent / unreadable). Never throws. */
export async function readDrainPark(chatId: string): Promise<DrainParkMarker | null> {
  try {
    const raw = await redisClient.get(PARK_KEY(chatId));
    if (!raw) return null;
    const m = JSON.parse(raw) as Partial<DrainParkMarker>;
    if (typeof m?.until !== 'number' || !Number.isFinite(m.until)) return null;
    return { until: m.until, triagedAt: String(m.triagedAt ?? ''), rowIds: Array.isArray(m.rowIds) ? m.rowIds.map(String) : [], disposition: (m.disposition as DrainDisposition) ?? 'ack_only', p: Number(m.p ?? 0) };
  } catch { return null; }
}

/** Write the park marker (TTL = the longer of the park and the "already triaged" memory). Never throws; false on failure. */
export async function writeDrainPark(chatId: string, marker: DrainParkMarker): Promise<boolean> {
  try {
    const ttlSec = Math.max(DRAIN_TRIAGE_MARKER_TTL_SEC, Math.ceil((marker.until - Date.now()) / 1000) + 60);
    await redisClient.set(PARK_KEY(chatId), JSON.stringify(marker), { EX: ttlSec });
    return true;
  } catch { return false; }
}

/** Clear the marker (tests / manual unpark). Never throws. */
export async function clearDrainPark(chatId: string): Promise<void> {
  try { await redisClient.del(PARK_KEY(chatId)); } catch { /* best-effort */ }
}

// ── The consumer entry point (called from chat-agent.service drainChatQueue) ──

export interface DrainTriageResult {
  decision: DecideResult | null;
  /** SHADOW / ACT-delivered: the stash the started run carries to its finalize (null when labels are off or no decision). */
  stash: DecisionStash | null;
  /** ACT only: the batch is parked — the caller returns WITHOUT starting a turn; the rows stay pending. */
  parked: { until: number; disposition: DrainDisposition; p: number } | null;
}

const NO_TRIAGE: DrainTriageResult = { decision: null, stash: null, parked: null };

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

const isChoice = (a: DecisionAnswer | undefined): a is Extract<DecisionAnswer, { type: 'choice' }> => !!a && a.type === 'choice';

/**
 * What the ACT contract would do with these answers: park ⇔ the chosen
 * disposition is `ack_only` or `coalesce` AND its probability clears that
 * option's threshold (DECISION_GATE_THRESHOLD_DRAIN_TRIAGE_<OPTION>, else the
 * purpose threshold). `act_now` never parks. Pure; null for a malformed answer.
 */
export function drainTriageWouldPark(answers: Record<string, DecisionAnswer> | null | undefined, fallbackThreshold = DRAIN_TRIAGE_DEFAULT_THRESHOLD): { park: boolean; disposition: DrainDisposition; p: number; threshold: number } | null {
  const d = answers?.[DRAIN_TRIAGE_QUESTION];
  if (!isChoice(d)) return null;
  const disposition = (DRAIN_DISPOSITIONS as readonly string[]).includes(d.choice) ? (d.choice as DrainDisposition) : 'act_now';
  const p = Number(d.probabilities?.[disposition] ?? d.confidence ?? 0);
  const threshold = decisionOptionThreshold('drain_triage', disposition, fallbackThreshold);
  const quiet = disposition === 'ack_only' || disposition === 'coalesce';
  return { park: quiet && p >= threshold, disposition, p: Number(p.toFixed(3)), threshold };
}

/**
 * Pre-triage ONE agent-row batch about to drain. Non-agent batches and
 * mode 'off' return NO_TRIAGE without touching the DB, Redis or
 * the seat. Never throws — every failure returns NO_TRIAGE so the drain
 * proceeds unchanged.
 */
export async function preTriageDrainBatch(input: {
  chatId: string;
  rows: readonly DrainRowLike[];
  origins: ReadonlyArray<DrainOriginLike | null | undefined>;
  supersededNotes: ReadonlyArray<string | null | undefined>;
  now?: Date;
}): Promise<DrainTriageResult> {
  try {
    if (!input.rows.length || input.rows.some((r) => r.source !== undefined && r.source !== 'agent')) return NO_TRIAGE;
    const mode = decisionMode('drain_triage');
    if (mode === 'off') return NO_TRIAGE;
    const now = input.now ?? new Date();

    // An earlier ACT park: still parked ⇒ hold; lapsed ⇒ deliver WITHOUT a
    // second triage (bounded delay — the WI-R "nothing is lost" rule).
    const park = await readDrainPark(input.chatId);
    if (park) {
      if (now.getTime() < park.until) return { decision: null, stash: null, parked: { until: park.until, disposition: park.disposition, p: park.p } };
      return NO_TRIAGE;
    }

    const snapshot = await withTimeout(computeDrainSnapshot(input.chatId), DRAIN_TRIAGE_SNAPSHOT_TIMEOUT_MS, 'drain snapshot');
    if (!snapshot) return NO_TRIAGE;
    const flags = drainTriageCodeFlags(input.rows, input.origins, input.supersededNotes, now.getTime());
    // SAA-1.3 PHASE 0 (todo 9114e7b5) — OBSERVE-ONLY. The collector is filled
    // by the builder but never enters `state`, so the prompt the gate sees is
    // byte-identical with the observation on and off.
    const observation: DrainTriageObservation = { segments: [], droppedRows: 0, rows: 0 };
    const state = buildDrainTriageState({ snapshot, flags, rows: input.rows, origins: input.origins, now: now.getTime(), observe: observation });
    // SAA-1.3 PHASE 1 (todo 2ef2b254) — the RENDER half of the drain surface.
    // Phase 0 could only measure; here the gate gets a way to FOLLOW what the
    // cap cut. The change is additive and conditional by construction:
    //   · `applied` is true ONLY in apply mode (and only when at least one
    //     segment carries a read call — the existing ones do: each is
    //     `get_chat_messages({chatId, messageId})` from buildDrainTriageState),
    //     so a default box passes `state` through UNCHANGED, by reference — the
    //     gate prompt stays byte-identical to Phase 0.
    //   · When it does apply, the pointers are EMPTY-INPUT rendered
    //     (renderSpillPointers('', plan).trim()) and ride ONE extra key, so the
    //     state's own cap arithmetic and existing fields are untouched. `state`
    //     itself is never mutated (see the fresh object below), because the
    //     observation collector is filled by the same builder call and a later
    //     reader must still see exactly what was built.
    //   · Whole-row drops (droppedRows) carry NO segment — a skipped row has no
    //     id in this batch to point at — so the pointer block honestly reflects
    //     the clipped rows only; the dropped ones are counted on the metric row.
    let stateForGate: Record<string, unknown> = state;
    try {
      const spill = await import('./inline-spill');
      const plan = spill.planInlineSpill({ surface: 'drain_triage', segments: observation.segments, droppedRows: observation.droppedRows });
      const meta = spill.inlineSpillMetricMeta(plan, { chatId: input.chatId, rows: observation.rows });
      if (meta) {
        const m: any = await import('./loop-metrics.service');
        if (typeof m?.recordLoopMetric === 'function') {
          m.recordLoopMetric({ kind: m.LOOP_METRIC_KINDS?.INLINE_SPILL_OBSERVE ?? 'inline_spill_observe', sessionId: input.chatId, value: 1, meta });
        }
      }
      if (plan.applied) stateForGate = { ...state, contextSpill: spill.renderSpillPointers('', plan).trim() };
    } catch { /* observe-only / spill: never blocks the drain */ }

    const decision = await decide(stateForGate, DRAIN_TRIAGE_QUESTIONS, {
      purpose: 'drain_triage', timeoutMs: DRAIN_TRIAGE_TIMEOUT_MS, sessionId: input.chatId,
    });
    if (!decision) return NO_TRIAGE;

    const verdict = drainTriageWouldPark(decision.answers);
    // E2 (2026-09-25): the RESULT's mode gates acting — an uncalibrated backend answers as 'shadow'.
    // USER rows are never gated: a batch with a human waiting behind it always drains.
    if (decision.mode === 'act' && verdict?.park && snapshot.pendingUserRows === 0) {
      const until = now.getTime() + drainTriageDeferMin() * 60_000;
      const marker: DrainParkMarker = { until, triagedAt: now.toISOString(), rowIds: input.rows.map((r) => r.id), disposition: verdict.disposition, p: verdict.p };
      if (await writeDrainPark(input.chatId, marker)) {
        recordDecisionOutcome(decision, 'drain_triage', {
          question: DRAIN_TRIAGE_QUESTION, actual: null, acted: true, sessionId: input.chatId,
          note: `parked ${input.rows.length} agent row(s) for ${drainTriageDeferMin()} min (${verdict.disposition} ${verdict.p}≥${verdict.threshold})`,
        });
        return { decision, stash: null, parked: { until, disposition: verdict.disposition, p: verdict.p } };
      }
      // Marker write failed — deliver (fail open); the label still applies.
    }
    return { decision, stash: stashDecision(decision, 'drain_triage'), parked: null };
  } catch (err: any) {
    logger.warn(`drain-triage: ${input.chatId.slice(0, 8)} failed open (${err?.message ?? err}) — the drain proceeds as before`);
    return NO_TRIAGE;
  }
}
