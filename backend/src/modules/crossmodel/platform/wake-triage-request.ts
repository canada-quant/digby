/**
 * wake_triage request builder (E7, 2026-09-25 — decision-model enhancements
 * doc §4). PURE leaf: the state + questions the hook sweeper sends to the
 * decision seat before a non-alarm supervisor wake, plus the decision-time
 * code-flag labels and the shadow "would v2 have parked" readout.
 *
 * WHY. The v1 request was ONE noul (`needs_turn_now`) over the lane-authored
 * prose summary. 24 h of TypeSafe Jev shadow rows showed the paper's
 * "confidently misled" regime: 4 of 16 act-band answers (needs_turn_now
 * ≤ 0.15) were wakes that then acted — the prose lacked the facts that
 * determine action. The vendor names both failure modes: "hiding several
 * judgments inside one question" and "large state full of irrelevant
 * detail"; fan-out questions are free on a one-prefill decision model.
 *
 * WHAT (v2; the v1 request — one noul over the prose — is gone):
 *   state  — CODE-COMPUTED fields first: the event-kind histogram, whether any
 *            row reads as a question/request, is addressed to the supervisor,
 *            reports a failure/block, carries a guard-replaced final or an
 *            owner-facing decision; distinct sources; event ages; the source
 *            lane's status + last run outcome (a bounded, fail-open lookup
 *            the caller performs — null when unavailable); the prose summary
 *            LAST and capped at WAKE_TRIAGE_PROSE_CAP chars.
 *   questions — `needs_turn_now` (text UNCHANGED for comparability with the
 *            v1 rows) + `disposition` choice {ack, coalesce, act_now,
 *            escalate_owner} + `addressed_to_supervisor` noul +
 *            `contains_failure_or_block` noul + `urgency` score.
 *   act    — UNCHANGED: the act path still keys on `needs_turn_now` alone and
 *            keeps the bounded 30-min park (no chained re-triage on
 *            re-delivery — the WI-R "nothing is lost" guarantee). The new
 *            questions are shadow instrumentation; `wakeTriageV2WouldPark`
 *            records what a 4-way contract with per-option thresholds
 *            (decisionOptionThreshold) WOULD have parked, in the outcome note.
 *   labels — `addressed_to_supervisor` / `contains_failure_or_block` are
 *            properties of the BATCH, known at decision time: they close
 *            immediately against the code flags (note says so). The run-
 *            derived labels for `disposition` / `urgency` live in
 *            decision-outcome-labels.ts next to `needs_turn_now`.
 *   memo   — E3b (2026-09-25, live defect: 0 cached rows / 37 min): every
 *            request also carries a MEMO-STABLE projection (`memoState`) —
 *            the same facts with the whole-minute ages bucketed (0–5 / 5–15 /
 *            15–60 / 60+ min) and the batch identified by its sorted event
 *            IDS instead of its count — so a busy re-ask of the SAME batch a
 *            minute later answers from the decision memo, while a batch with
 *            a NEW event id (a different set) never does. `memoable` is false
 *            (the caller passes memo:false → never memoised) when any row
 *            lacks an id or is alarm-class (the caller's predicate).
 * The purpose stays SHADOW (no act flip here). Never throws.
 */

import type { DecideResult, DecisionAnswer, DecisionQuestion } from './decision-gate';
import { decisionOptionThreshold, decisionThreshold } from './decision-gate';
// E3b: from the dependency-free leaf, NOT decision-gate.ts — the sweeper's unit
// suite mocks decision-gate wholesale, and a missing export would throw here.
import { bucketMinutes } from './decision-gate-math';

// ── 2026-10-04: the ACT CONTROL SAMPLE (the sweep_triage E12 design, applied to hook wakes) ──
// In act, a confident-quiet verdict (needs_turn_now ≤ 1 − τ) PARKS the wake: the
// gate writes an acted:true row with actual:null and the deferred delivery later
// rides with payload.triagedAt (never re-triaged, never stashed), so NO park ever
// earns a label. The only labelled wakes are the ones that fired — outside the
// act band by construction — so the act band held zero act-period labels for 14
// days (prod probe 2026-10-04) and neither the in-memory E12 window
// (decision-gate-modes noteActBandOutcome) nor the durable one
// (decision-gate-durable-demote durableActBandWindows) could ever judge it. One
// confident-quiet park in WAKE_TRIAGE_CONTROL_SAMPLE_DEFAULT_N (10) now DELIVERS
// instead and its stash carries extra {control:true, controlReason:'sample'}: the
// woken run's finalize labels it (decision-outcome-labels.ts) with mode 'act',
// inside the band (the same noul ≤ 1 − τ), acted:false — a random sample of the
// park band's real action rate. Only the confident-park path draws; alarm rows,
// cap-bypass wakes and already-triaged rows never reach the gate. Env
// DECISION_GATE_WAKE_TRIAGE_CONTROL_RATE (0..1, default 1/10); kill switch
// WAKE_TRIAGE_CONTROL_SAMPLE_DISABLED=1 restores park-every-time.
export const WAKE_TRIAGE_CONTROL_SAMPLE_DEFAULT_N = 10;
/** The stash / outcome-row meta a control wake carries (merged into the row via recordDecisionOutcome `extra`). */
export const WAKE_TRIAGE_CONTROL_EXTRA: Readonly<{ control: true; controlReason: 'sample' }> = Object.freeze({ control: true as const, controlReason: 'sample' as const });

const onFlagValue = (v: unknown): boolean => {
  const s = String(v ?? '').trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'on';
};

/** WAKE_TRIAGE_CONTROL_SAMPLE_DISABLED=1 — every confident-quiet act verdict parks again (no control draw). */
export function wakeTriageControlSampleDisabled(): boolean {
  return onFlagValue(process.env.WAKE_TRIAGE_CONTROL_SAMPLE_DISABLED);
}

/** The control draw rate for act parks (env DECISION_GATE_WAKE_TRIAGE_CONTROL_RATE, clamped 0..1; default 1/10; 0 under the kill switch). */
export function wakeTriageControlSampleRate(): number {
  if (wakeTriageControlSampleDisabled()) return 0;
  const raw = process.env.DECISION_GATE_WAKE_TRIAGE_CONTROL_RATE;
  if (raw === undefined || String(raw).trim() === '') return 1 / WAKE_TRIAGE_CONTROL_SAMPLE_DEFAULT_N;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 1 / WAKE_TRIAGE_CONTROL_SAMPLE_DEFAULT_N;
}

let wakeControlSampler: () => number = Math.random;
/** Test hook: replace the control draw (null restores Math.random). */
export function setWakeTriageControlSampler(fn: (() => number) | null): void { wakeControlSampler = fn ?? Math.random; }

/** Does this confident-quiet act park deliver as a control instead? Pure given the sampler. */
export function drawWakeTriageControl(): boolean {
  const rate = wakeTriageControlSampleRate();
  if (rate <= 0) return false;
  return rate >= 1 || wakeControlSampler() < rate;
}

/** The prose cap — prose is LAST and capped, the code fields carry the facts. */
export const WAKE_TRIAGE_PROSE_CAP = 4000;
/** Source lanes whose facts the caller looks up (bounded — a wildcard wake can fan in from many chats). */
export const WAKE_TRIAGE_LANE_LOOKUP_MAX = 3;

export type WakeTriageTargetKind = 'fleet supervisor chat' | 'project supervisor chat' | 'supervised chat';

/** The question keys whose label is derived from what the woken RUN did (finalize-time, decision-outcome-labels.ts). */
export const WAKE_TRIAGE_RUN_LABELLED_QUESTIONS = ['needs_turn_now', 'disposition', 'urgency'] as const;
/** The question keys whose label is a property of the BATCH (decision-time code flag). */
export const WAKE_TRIAGE_CODE_LABELLED_QUESTIONS = ['addressed_to_supervisor', 'contains_failure_or_block'] as const;
export const WAKE_DISPOSITIONS = ['ack', 'coalesce', 'act_now', 'escalate_owner'] as const;
export type WakeDisposition = typeof WAKE_DISPOSITIONS[number];

/** The bounded, fail-open facts about ONE source lane the caller may attach. */
export interface WakeSourceLaneFacts {
  chat_id: string;
  /** chat_coding_state.status (provisioning | ready | running | error | archived) or null for a plain chat. */
  coding_status: string | null;
  /** The lane's newest agent run, if any. */
  last_run: { status: string; ended_min_ago: number | null; error_head: string | null } | null;
}

/** Minimal row shape the builder reads (hook_events rows: id + eventType + payload + createdAt). */
export interface WakeTriageRowLike {
  /** hook_events.id — the batch's memo identity (E3b); a row without one makes the batch un-memoable. */
  id?: unknown;
  eventType?: unknown;
  payload?: unknown;
  createdAt?: unknown;
}

export interface WakeTriagePreviewLike { eventType: string; sourceChatTitle: string; summary: string }

// ── code-computed flags (regex over the emitter-authored summaries) ──────────
// These are the harness's own reading of the prose — cheap, explicit, and
// visible to the model in the state. They are ALSO the decision-time label for
// the two batch-property nouls, so a disagreement row is exactly the case a
// human ruler wants to see (the model read the prose differently from the
// regex), and an agreement rate of 1.0 says the model only echoes the flags.
const QUESTION_RE = /\?\s*$|\b(?:please|request(?:s|ed|ing)?|need(?:s)? (?:you|your|the supervisor)|awaiting|waiting (?:for|on) (?:you|your|the supervisor|a decision|approval)|decision needed|should (?:i|we)\b|can you|could you|approv(?:e|al)|sign[- ]?off|input needed|guidance)\b/im;
const ADDRESSED_RE = /\b(?:supervisor|report(?:ing)?[- ]up|escalat(?:e|ed|es|ing|ion)|@(?:fleet|project))\b/i;
const FAILURE_RE = /\b(?:fail(?:ed|ure|ures|ing)?|error(?:s|ed)?|blocked|stuck|stall(?:ed|ing)?|cannot|can't|unable|time(?:d)?[- ]?out|OOM|killed|exit code [1-9]\d*|rejected|REPLACED|UNVERIFIED|regression|broken|crash(?:ed|ing)?)\b/i;
const GUARD_REPLACED_RE = /evidence guard REPLACED|REPLACED its final/i;
const OWNER_FACING_RE = /\b(?:owner(?:'s)?[- ](?:decision|approval|card|question|input)|flag_owner_question|needs? the owner|ask(?:ing)? the owner|human (?:decision|approval))\b/i;

function summaryOf(row: WakeTriageRowLike): string {
  const p = (row?.payload ?? {}) as Record<string, unknown>;
  return String(p.summary ?? '');
}
function eventTypeOf(row: WakeTriageRowLike): string {
  const p = (row?.payload ?? {}) as Record<string, unknown>;
  return String(row?.eventType ?? p.eventType ?? '');
}
function sourceIdOf(row: WakeTriageRowLike): string {
  const p = (row?.payload ?? {}) as Record<string, unknown>;
  return String(p.sourceChatId ?? '').trim();
}

/** Distinct source chat ids of a batch, first-seen order (the caller bounds its lookup to WAKE_TRIAGE_LANE_LOOKUP_MAX). */
export function wakeTriageSourceIds(rows: readonly WakeTriageRowLike[]): string[] {
  return [...new Set(rows.map(sourceIdOf).filter(Boolean))];
}

/** E3b: the batch's identity for the memo — its event ids, sorted, distinct.
 *  null when any row lacks an id (the identity cannot be vouched for). */
export function wakeTriageEventIds(rows: readonly WakeTriageRowLike[]): string[] | null {
  const ids: string[] = [];
  for (const r of rows) {
    const id = r?.id === undefined || r?.id === null ? '' : String(r.id).trim();
    if (!id) return null;
    ids.push(id);
  }
  return [...new Set(ids)].sort();
}

export interface WakeTriageCodeFlags {
  event_kinds: Record<string, number>;
  any_row_is_question_or_request: boolean;
  any_row_addressed_to_supervisor: boolean;
  any_row_reports_failure_or_block: boolean;
  any_row_guard_replaced_final: boolean;
  any_row_owner_facing: boolean;
  distinct_sources: number;
  oldest_event_age_min: number | null;
  newest_event_age_min: number | null;
}

/** The code-computed facts of a batch. Pure; tolerant of malformed rows. */
export function wakeTriageCodeFlags(rows: readonly WakeTriageRowLike[], now: number = Date.now()): WakeTriageCodeFlags {
  const kinds: Record<string, number> = {};
  let question = false; let addressed = false; let failure = false; let replaced = false; let owner = false;
  const ages: number[] = [];
  for (const r of rows) {
    const k = eventTypeOf(r) || 'unknown';
    kinds[k] = (kinds[k] ?? 0) + 1;
    const s = summaryOf(r);
    if (!question && QUESTION_RE.test(s)) question = true;
    if (!addressed && ADDRESSED_RE.test(s)) addressed = true;
    if (!failure && FAILURE_RE.test(s)) failure = true;
    if (!replaced && GUARD_REPLACED_RE.test(s)) replaced = true;
    if (!owner && OWNER_FACING_RE.test(s)) owner = true;
    const t = r?.createdAt instanceof Date ? r.createdAt.getTime() : new Date(String(r?.createdAt ?? '')).getTime();
    if (Number.isFinite(t)) ages.push(Math.max(0, Math.round((now - t) / 60000)));
  }
  return {
    event_kinds: kinds,
    any_row_is_question_or_request: question,
    any_row_addressed_to_supervisor: addressed,
    any_row_reports_failure_or_block: failure,
    any_row_guard_replaced_final: replaced,
    any_row_owner_facing: owner,
    distinct_sources: wakeTriageSourceIds(rows).length,
    oldest_event_age_min: ages.length ? Math.max(...ages) : null,
    newest_event_age_min: ages.length ? Math.min(...ages) : null,
  };
}

// ── questions ────────────────────────────────────────────────────────────────

/** The v1 noul — text pinned: the ONLY question v1 rows answered; v2 keeps it verbatim for comparability. */
export const NEEDS_TURN_NOW_QUESTION: DecisionQuestion = {
  type: 'noul',
  instructions: 'This event batch requires the supervisor to act NOW (decide, dispatch, reply, escalate, unblock or investigate) rather than being an informational report-up or routine completion notice that can wait for the next scheduled sweep.',
  criteria: {
    true: 'a failure or error, a question or request addressed to the supervisor, a blocked or stuck lane, an owner-facing decision, or work that must be dispatched now',
    false: 'a routine completion, a status or progress report, an acknowledgement, or duplicate / informational chatter with no action for the supervisor',
  },
};

export const WAKE_TRIAGE_V2_QUESTIONS: Record<string, DecisionQuestion> = {
  needs_turn_now: NEEDS_TURN_NOW_QUESTION,
  disposition: {
    type: 'choice',
    instructions: 'Which disposition should the supervisor\'s harness give this event batch?',
    criteria: {
      ack: 'acknowledge and drop — informational, a routine completion, duplicate or status chatter; no supervisor turn now or later',
      coalesce: 'hold — nothing needs a turn now, but the batch carries state the supervisor should see folded into its next scheduled sweep or wake',
      act_now: 'wake the supervisor now — a decision, dispatch, reply, unblock or investigation is needed',
      escalate_owner: 'needs the human owner — an owner-facing decision, approval, spend, credential or policy question the supervisor cannot settle itself',
    },
  },
  addressed_to_supervisor: {
    type: 'noul',
    instructions: 'At least one event in this batch is a message, question or request directed AT the supervisor (asking it to decide, reply, approve, unblock, dispatch or review), rather than a broadcast status line.',
    criteria: {
      true: 'an event asks the supervisor for something, awaits its reply, or reports up expecting a decision',
      false: 'every event is a completion notice, progress report, acknowledgement or other status broadcast that asks nothing of the supervisor',
    },
  },
  contains_failure_or_block: {
    type: 'noul',
    instructions: 'At least one event in this batch reports a failure, an error, a blocked or stuck lane, a replaced or unverified final answer, or work that cannot proceed.',
    criteria: {
      true: 'a run failed or errored, a lane is blocked / stuck / waiting on something it cannot resolve, a final was replaced or marked unverified, or a step could not be completed',
      false: 'every event reports success, progress or routine state with nothing failing or blocked',
    },
  },
  urgency: {
    type: 'score',
    instructions: 'How urgently does this event batch need the supervisor\'s attention?',
    criteria: [
      'none — informational only; no action now or later',
      'low — can wait for the next scheduled sweep',
      'medium — should be handled within the hour',
      'high — needs the supervisor now (blocked lane, failure, request awaiting a reply, owner-facing decision)',
    ],
  },
};

// ── request builders ─────────────────────────────────────────────────────────

export interface WakeTriageRequest {
  state: Record<string, unknown>;
  questions: Record<string, DecisionQuestion>;
  shape: 'v2';
  /** The code flags — the decision-time labels for the batch-property nouls. */
  flags: WakeTriageCodeFlags | null;
  /** E3b: the memo-stable projection of `state` (decide() opts.memoState) — null when the batch is not memoable. */
  memoState: Record<string, unknown> | null;
  /** E3b: false ⇒ the caller passes memo:false (a row without an id, or an alarm-class row in the batch). */
  memoable: boolean;
}

/** E3b: an alarm predicate the caller supplies (hooks.service isAlarmRow) — the builder is a leaf and owns no event-type list. */
export type WakeTriageAlarmPredicate = (row: WakeTriageRowLike) => boolean;

/** E3b: whether a batch may be served from / stored in the decision memo:
 *  every row carries an id and none is alarm-class. An alarm must always be
 *  a fresh ask (the sweeper never triages alarm batches anyway — this is the
 *  builder-level guarantee for any other caller). */
export function wakeTriageMemoable(rows: readonly WakeTriageRowLike[], isAlarm?: WakeTriageAlarmPredicate): boolean {
  if (!rows.length) return false;
  if (wakeTriageEventIds(rows) === null) return false;
  if (isAlarm) { try { if (rows.some((r) => isAlarm(r))) return false; } catch { return false; } }
  return true;
}

/** E3b: bucketed lane facts for the memo projection (ended_min_ago → coarse bucket; the rest verbatim). */
function memoLanes(lanes: WakeSourceLaneFacts[] | null): unknown {
  if (!lanes) return null;
  return lanes.map((l) => ({
    chat_id: l.chat_id,
    coding_status: l.coding_status,
    last_run: l.last_run
      ? { status: l.last_run.status, ended_ago: l.last_run.ended_min_ago === null ? null : bucketMinutes(l.last_run.ended_min_ago), error_head: l.last_run.error_head }
      : null,
  }));
}

/** The v2 fan-out request: code-computed fields first, lane facts, prose last and capped. */
export function buildWakeTriageRequestV2(input: {
  target: WakeTriageTargetKind;
  rows: readonly WakeTriageRowLike[];
  preview: WakeTriagePreviewLike;
  lanes: WakeSourceLaneFacts[] | null;
  now?: number;
  isAlarm?: WakeTriageAlarmPredicate;
}): WakeTriageRequest {
  const flags = wakeTriageCodeFlags(input.rows, input.now);
  const summary = input.preview.summary.slice(0, WAKE_TRIAGE_PROSE_CAP);
  const state: Record<string, unknown> = {
    target: input.target,
    events: input.rows.length,
    event_type: input.preview.eventType,
    ...flags,
    source_chat: input.preview.sourceChatTitle,
    // null = lookup unavailable / disabled (a plain chat with no coding state
    // reports coding_status null and last_run null instead).
    source_lanes: input.lanes,
    summary,
  };
  // E3b: the memo-stable projection — the SAME facts, minus the two fields
  // that change every minute (whole-minute ages → coarse buckets) and with
  // the batch identified by its event ids (a new id = a different batch,
  // never a memo hit) instead of its count. The lane facts stay (a status
  // change IS a different batch) with their own age bucketed. The digest
  // prose carries absolute stamps only, so it is stable per row set.
  const memoable = wakeTriageMemoable(input.rows, input.isAlarm);
  const { oldest_event_age_min, newest_event_age_min, ...stableFlags } = flags;
  const memoState: Record<string, unknown> | null = memoable ? {
    target: input.target,
    event_type: input.preview.eventType,
    event_ids: wakeTriageEventIds(input.rows),
    ...stableFlags,
    oldest_event_age: oldest_event_age_min === null ? null : bucketMinutes(oldest_event_age_min),
    newest_event_age: newest_event_age_min === null ? null : bucketMinutes(newest_event_age_min),
    source_chat: input.preview.sourceChatTitle,
    source_lanes: memoLanes(input.lanes),
    summary,
  } : null;
  return { state, questions: WAKE_TRIAGE_V2_QUESTIONS, shape: 'v2', flags, memoState, memoable };
}

/** The request for this batch (the v2 fan-out). */
export function buildWakeTriageRequest(input: {
  target: WakeTriageTargetKind;
  rows: readonly WakeTriageRowLike[];
  preview: WakeTriagePreviewLike;
  lanes: WakeSourceLaneFacts[] | null;
  now?: number;
  /** E3b: hooks.service isAlarmRow — an alarm-class batch is never memoable. */
  isAlarm?: WakeTriageAlarmPredicate;
}): WakeTriageRequest {
  return buildWakeTriageRequestV2(input);
}

// ── shadow readouts over the answers ─────────────────────────────────────────

const isChoice = (a: DecisionAnswer | undefined): a is Extract<DecisionAnswer, { type: 'choice' }> => !!a && a.type === 'choice';
const isNoul = (a: DecisionAnswer | undefined): a is Extract<DecisionAnswer, { type: 'noul' }> => !!a && a.type === 'noul';

/** The v2 question keys a decision actually answered (a v1 stash has only needs_turn_now). */
export function wakeTriageAnsweredKeys(answers: Record<string, DecisionAnswer> | undefined | null): string[] {
  return Object.keys(answers ?? {}).filter((k) => k in WAKE_TRIAGE_V2_QUESTIONS);
}

/**
 * What a 4-way act contract WOULD do with these answers (shadow readout only;
 * nothing acts on it): park ⇔ the chosen disposition is `ack` or `coalesce`
 * AND its probability clears that option's threshold
 * (DECISION_GATE_THRESHOLD_WAKE_TRIAGE_<OPTION>, else the purpose threshold)
 * AND `needs_turn_now` is at or below 1 − its threshold. `act_now` /
 * `escalate_owner` never park. Returns null for a v1 answer set.
 */
export function wakeTriageV2WouldPark(answers: Record<string, DecisionAnswer> | undefined | null, fallbackThreshold = 0.85): { park: boolean; disposition: WakeDisposition; p: number; threshold: number } | null {
  const d = answers?.disposition;
  const n = answers?.needs_turn_now;
  if (!isChoice(d) || !isNoul(n)) return null;
  const disposition = (WAKE_DISPOSITIONS as readonly string[]).includes(d.choice) ? (d.choice as WakeDisposition) : 'act_now';
  const p = Number(d.probabilities?.[disposition] ?? d.confidence ?? 0);
  const threshold = decisionOptionThreshold('wake_triage', disposition, fallbackThreshold);
  const quiet = disposition === 'ack' || disposition === 'coalesce';
  const park = quiet && p >= threshold && n.noul <= 1 - decisionThreshold('wake_triage', fallbackThreshold);
  return { park, disposition, p: Number(p.toFixed(3)), threshold };
}

/** One-line shadow readout for an outcome note: "v2 park:ack 0.93≥0.85" / "v2 deliver:act_now 0.61". */
export function wakeTriageV2Note(answers: Record<string, DecisionAnswer> | undefined | null): string {
  const r = wakeTriageV2WouldPark(answers);
  if (!r) return '';
  return r.park ? `v2 park:${r.disposition} ${r.p}≥${r.threshold}` : `v2 deliver:${r.disposition} ${r.p}`;
}

/**
 * The decision-time labels for the batch-property nouls: [question, actual]
 * pairs for the answered keys only (a v1 answer set yields none). The caller
 * records them with recordDecisionOutcome right after decide().
 */
export function wakeTriageCodeLabels(decision: Pick<DecideResult, 'answers'> | null | undefined, flags: WakeTriageCodeFlags | null): Array<{ question: string; actual: boolean }> {
  if (!decision || !flags) return [];
  const out: Array<{ question: string; actual: boolean }> = [];
  if (isNoul(decision.answers.addressed_to_supervisor)) {
    out.push({ question: 'addressed_to_supervisor', actual: flags.any_row_is_question_or_request || flags.any_row_addressed_to_supervisor });
  }
  if (isNoul(decision.answers.contains_failure_or_block)) {
    out.push({ question: 'contains_failure_or_block', actual: flags.any_row_reports_failure_or_block || flags.any_row_guard_replaced_final });
  }
  return out;
}
