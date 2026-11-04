/**
 * Machine-wake reasoning-effort score — decision-gate purpose `wake_effort`
 * (N9, docs/DECISION_MODEL_ENHANCEMENTS_2026-09-25.md §5 / §8; shipped SHADOW).
 *
 * WHY: every machine wake (hook wake, schedule firing, agent-message drain,
 * webhook) runs the orchestrator seat at reasoning_effort 'max' (≈12 min of
 * thinking on glm-5.3 vs ≈3 at 'high', chat-agent/human-turn-effort.ts):
 * 631 supervisor machine turns/day, 51% of them no-ops, payloads mostly
 * 1–2 KB report-ups — order $30–60/day and up to ~50 h/day of aggregate
 * thinking, the largest lever the enhancement review found. The gate asks
 * ONE typed score (0–2, "how much deliberation does this wake need") over
 * code-computed flags + the wake HEAD (≤ 2 KB, prose last).
 *
 * MODES (decisionMode('wake_effort'); default shadow, NODE_ENV=test off):
 *   shadow — the wake runs EXACTLY as before ('max'); the gate runs
 *            CONCURRENTLY with the orchestrator call (never awaited before
 *            it — zero latency added) and the run's finalize labels the
 *            decision from what the wake actually did — HARNESS-COUNTED since
 *            2026-09-27 (agent-decisions prerequisite 1): 2 ⇔ ≥ 3
 *            evidence-bearing tool calls OR a mutating platform tool, 1 ⇔ 1–2
 *            evidence calls, 0 ⇔ none (decision-outcome-labels.ts
 *            deriveWakeEffortHarnessActual; the older 0 no-op / 1 note /
 *            2 acted-or-ACTIONS-TAKEN proxy rides the row as meta.legacyLabel) with the
 *            run's length and cost in the note.
 *   act    — a non-alarm wake whose score rounds to ≤ WAKE_EFFORT_ACT_MAX_SCORE
 *            at confidence ≥ τ (default 0.9) runs a built-in glm/deepseek seat
 *            at 'high'. It fires ONLY when the RESULT's mode is 'act' (E2:
 *            never decisionMode()) — i.e. through the normal store-backed mode
 *            + READY-stamp admission like every other purpose. HISTORY: from
 *            2026-09-25 to 2026-09-26 this was DOUBLE-LOCKED behind the owner
 *            switch DECISION_GATE_WAKE_EFFORT_ACT_ENABLED=1 (the 2026-09-22
 *            "machine wakes keep max" directive); the owner's 2026-09-26
 *            directive ("default all chats to auto even supervisors and fleet
 *            supervisors" — the compute policy decides per wake, presets are
 *            the fallback) LIFTED that lock. The env survives as the HARD
 *            DISABLE: DECISION_GATE_WAKE_EFFORT_ACT_ENABLED=0 (or false / off)
 *            keeps every wake at max whatever the purpose's mode; unset / 1
 *            = allowed. Alarm-class wakes (alarm event markers / [INFRA
 *            ALERT] / [PRODUCT ALERT] in the head) are pinned to 'max'
 *            regardless.
 * Fail-open everywhere: a gate error, timeout, null answer or a thrown
 * anything ⇒ the wake runs at the seat's own effort, exactly as before.
 * Kill switches: the gate-wide ones.
 *
 * Loaded DYNAMICALLY by chat-agent.service (decision-gate's static graph
 * reaches config/env); the effort→provider mapping is the pure leaf
 * chat-agent/human-turn-effort.ts effortProviderExtra.
 */

import logger from '../../../utils/logger';
import {
  decide, decisionMode, decisionThreshold, stashDecision, confidenceOf,
  type DecideResult, type DecisionQuestion,
} from './decision-gate';
import type { ReasoningEffort } from '../chat-agent/human-turn-effort';

// ── Tunables ─────────────────────────────────────────────────────────────────

/** The question key on every wake_effort decision/outcome row. */
export const WAKE_EFFORT_QUESTION = 'deliberation';
/** Acting confidence (DECISION_GATE_THRESHOLD_WAKE_EFFORT overrides; clamped by decisionThreshold). */
export const WAKE_EFFORT_DEFAULT_THRESHOLD = 0.9;
/** The highest score the act path still lowers effort on (mirrors ACT_POLICIES.wake_effort.maxScore). */
export const WAKE_EFFORT_ACT_MAX_SCORE = 1;
/** The effort a confidently low-deliberation wake runs at under act. */
export const WAKE_EFFORT_ACT_EFFORT: ReasoningEffort = 'high';
/** Gate deadline. Shadow never waits on it; the act path (owner-armed, machine-only) waits at most this long. */
export const WAKE_EFFORT_TIMEOUT_MS = 2500;
/** The wake head carried in the state (≤ 2 KB per the N9 spec). */
export const WAKE_EFFORT_HEAD_CHARS = 2048;

const offFlag = (v: unknown): boolean => {
  const s = String(v ?? '').trim().toLowerCase();
  return s === '0' || s === 'false' || s === 'off';
};

/** Whether a calibrated act answer may LOWER a wake's effort. Lock lifted 2026-09-26 (owner: "default all chats to auto even supervisors"): unset / 1 / true / on ⇒ allowed (the store mode + READY admission govern, like every purpose); DECISION_GATE_WAKE_EFFORT_ACT_ENABLED=0 / false / off ⇒ the HARD DISABLE — the answer is recorded, never applied. */
export function wakeEffortActEnabled(): boolean {
  return !offFlag(process.env.DECISION_GATE_WAKE_EFFORT_ACT_ENABLED);
}

/** DECISION_GATE_WAKE_EFFORT_ACT_ENABLED=0 (or false / off) — the explicit hard disable of the act path (the inverse of wakeEffortActEnabled, named for readers of the .env). */
export function wakeEffortActHardDisabled(): boolean {
  return offFlag(process.env.DECISION_GATE_WAKE_EFFORT_ACT_ENABLED);
}

// ── Alarm markers (code-computed; alarm wakes never lower effort) ────────────

/** hooks.service ALARM_EVENT_TYPES as the wake text renders them (`[run_failed]` bullets / `(run_failed)` in the
 *  default template) plus the supervisor's infra/product alert banners. Kept literal here so this leaf never imports hooks.service. */
export const WAKE_EFFORT_ALARM_RE = /\[(?:attention_needed|run_failed|goal_blocked|schedule_disabled|todo_wake)\]|\((?:attention_needed|run_failed|goal_blocked|schedule_disabled|todo_wake)\)|\[(?:INFRA|PRODUCT) ALERT/g;

/** Alarm-class markers in a wake text. Pure. */
export function countAlarmMarkers(text: string): number {
  const m = String(text ?? '').match(WAKE_EFFORT_ALARM_RE);
  return m ? m.length : 0;
}

// ── State + question ─────────────────────────────────────────────────────────

export type WakeOrigin = 'schedule' | 'hook' | 'agent' | 'webhook' | 'machine';
export type WakeChatKind = 'fleet_supervisor' | 'project_supervisor' | 'lane';

export interface WakeEffortInput {
  /** The raw wake text (hook wake / schedule prompt / batched agent rows). Only its head reaches the state. */
  message: string;
  origin: WakeOrigin;
  chatKind: WakeChatKind;
  /** Conversation messages loaded for the turn (the wake's own prior notes are its state). */
  historyMessages: number;
  hasImages: boolean;
  /** The orchestrator seat model (for the row; the act mapping re-reads the model at call time). */
  model: string;
  sessionId?: string;
}

const clip = (v: unknown, max: number): string => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/** The gate state — code-computed flags first, the wake head LAST. Pure; ≤ ~2.3k chars. */
export function buildWakeEffortState(input: WakeEffortInput): Record<string, unknown> {
  const message = String(input.message ?? '');
  const head = clip(message, WAKE_EFFORT_HEAD_CHARS);
  const alarmMarkers = countAlarmMarkers(message);
  const questionMarks = (head.match(/\?/g) ?? []).length;
  return {
    wake_origin: input.origin,
    chat_kind: input.chatKind,
    orchestrator_model: input.model,
    history_messages_loaded: input.historyMessages,
    has_image_attachments: input.hasImages,
    wake_chars_total: message.length,
    wake_head_truncated: message.length > head.length,
    alarm_markers_in_wake: alarmMarkers,
    question_marks_in_head: questionMarks,
    wake_head: head,
  };
}

/** The typed question: a 0–2 score of deliberation needed. */
export const WAKE_EFFORT_QUESTIONS: Record<string, DecisionQuestion> = {
  [WAKE_EFFORT_QUESTION]: {
    type: 'score',
    instructions: 'How much deliberation does this machine wake need before the supervisor can answer it well? Judge the wake itself (what it reports or asks), not the chat.',
    criteria: [
      '0 — routine: a report-up, heartbeat, status echo, quiet sweep or bookkeeping ping; the right answer is a short acknowledgement or a no-op note',
      '1 — ordinary supervision: read one or two lanes, update a ledger or schedule, reply or re-arm; bounded reasoning over what is already in the wake',
      '2 — hard: a failure, block or alarm, an owner-facing decision, conflicting or surprising reports, or anything whose wrong answer costs real work',
    ],
  },
};

// ── Act verdict (pure) ───────────────────────────────────────────────────────

export interface WakeEffortVerdict {
  /** Lower the effort to WAKE_EFFORT_ACT_EFFORT. */
  apply: boolean;
  score: number | null;
  confidence: number;
  reason: string;
}

/**
 * Would the act path lower effort on this answer? Requires the RESULT's mode
 * 'act' (E2), a score answer rounding to ≤ WAKE_EFFORT_ACT_MAX_SCORE at
 * confidence ≥ τ, and NO alarm markers in the wake. Pure — the owner switch
 * is checked by the caller.
 */
export function wakeEffortActVerdict(decision: DecideResult | null | undefined, alarmMarkers: number, threshold: number): WakeEffortVerdict {
  if (!decision) return { apply: false, score: null, confidence: 0, reason: 'no decision' };
  const a = decision.answers[WAKE_EFFORT_QUESTION];
  if (!a || a.type !== 'score' || !Number.isFinite(a.score)) return { apply: false, score: null, confidence: 0, reason: 'no score answer' };
  const score = Math.round(a.score);
  const confidence = confidenceOf(a);
  if (decision.mode !== 'act') return { apply: false, score, confidence, reason: `mode ${decision.mode}` };
  if (alarmMarkers > 0) return { apply: false, score, confidence, reason: `alarm wake (${alarmMarkers} marker(s)) pinned to max` };
  if (score > WAKE_EFFORT_ACT_MAX_SCORE) return { apply: false, score, confidence, reason: `score ${score} > ${WAKE_EFFORT_ACT_MAX_SCORE}` };
  if (confidence < threshold - 1e-9) return { apply: false, score, confidence, reason: `confidence ${confidence.toFixed(2)} < τ ${threshold}` };
  return { apply: true, score, confidence, reason: `score ${score} at ${confidence.toFixed(2)} ≥ τ ${threshold}` };
}

// ── The consumer handle (chat-agent.service machine path) ────────────────────

export interface WakeEffortRunOutcome {
  parts: unknown;
  finalText: string;
  failed?: boolean;
  sessionId?: string;
  /** Harness-measured run length (orchestrator start → finalize). */
  runMs?: number;
  /** The turn ledger's snapshot at finalize (when the ledger is on). */
  costUsd?: number;
  turns?: number;
}

export interface WakeEffortGate {
  /** The concurrent decision (never rejects). */
  decision: Promise<DecideResult | null>;
  /**
   * ACT path: the effort to run the wake at, or null (= the seat's own
   * effort, unchanged). Resolves IMMEDIATELY with null under the hard
   * disable (DECISION_GATE_WAKE_EFFORT_ACT_ENABLED=0) or when the purpose is
   * not in act; otherwise it waits (≤ WAKE_EFFORT_TIMEOUT_MS) for the
   * decision and applies the verdict (RESULT mode 'act' only). Never rejects.
   */
  resolveActEffort(): Promise<ReasoningEffort | null>;
  /** Finalize label — fire-and-forget; never rejects. */
  label(run: WakeEffortRunOutcome): Promise<void>;
}

/**
 * Start the gate for ONE machine wake. Returns null (nothing consulted, no
 * row) when the purpose is OFF. Never throws.
 */
export function startWakeEffortGate(input: WakeEffortInput): WakeEffortGate | null {
  try {
    // The CONFIGURED mode (store / env) is read once here: 'off' ⇒ no gate at
    // all; anything but 'act' ⇒ resolveActEffort() answers null WITHOUT
    // awaiting the decision (shadow never adds latency). Acting itself still
    // keys on the RESULT's mode (E2).
    const configuredMode = decisionMode('wake_effort');
    if (configuredMode === 'off') return null;
    const alarmMarkers = countAlarmMarkers(input.message);
    const state = buildWakeEffortState(input);
    const decision: Promise<DecideResult | null> = decide(state, WAKE_EFFORT_QUESTIONS, {
      purpose: 'wake_effort', timeoutMs: WAKE_EFFORT_TIMEOUT_MS, sessionId: input.sessionId,
    }).catch((err: any) => {
      logger.warn(`wake-effort: gate failed open (${err?.message ?? err}) — the wake runs at the seat's effort`);
      return null;
    });
    let appliedEffort: ReasoningEffort | null = null;
    let verdictReason = '';
    let labelled = false;
    const gate: WakeEffortGate = {
      decision,
      async resolveActEffort() {
        try {
          if (!wakeEffortActEnabled()) return null;
          if (configuredMode !== 'act') return null;
          const d = await decision;
          const v = wakeEffortActVerdict(d, alarmMarkers, decisionThreshold('wake_effort', WAKE_EFFORT_DEFAULT_THRESHOLD));
          verdictReason = v.reason;
          if (!v.apply) return null;
          appliedEffort = WAKE_EFFORT_ACT_EFFORT;
          logger.info(`wake-effort: ${input.sessionId ?? 'wake'} runs at reasoning_effort '${appliedEffort}' (${v.reason}; purpose in act)`);
          return appliedEffort;
        } catch (err: any) {
          logger.warn(`wake-effort: act verdict failed open (${err?.message ?? err})`);
          return null;
        }
      },
      async label(run) {
        try {
          if (labelled) return;
          labelled = true;
          const d = await decision;
          if (!d) return;
          const extra = [
            typeof run.runMs === 'number' && Number.isFinite(run.runMs) ? `run ${Math.round(run.runMs / 1000)}s` : '',
            typeof run.costUsd === 'number' && Number.isFinite(run.costUsd) ? `$${run.costUsd.toFixed(4)}` : '',
            typeof run.turns === 'number' && Number.isFinite(run.turns) ? `${run.turns} turns` : '',
            appliedEffort ? `effort=${appliedEffort}` : (verdictReason ? `kept max (${verdictReason})` : 'kept max'),
            alarmMarkers ? `alarm ${alarmMarkers}` : '',
          ].filter(Boolean).join(' ');
          const { labelMachineRunOutcome } = await import('./decision-outcome-labels');
          await labelMachineRunOutcome(stashDecision(d, 'wake_effort'), {
            parts: run.parts, finalText: run.finalText, sessionId: run.sessionId, failed: run.failed,
            acted: appliedEffort !== null, extraNote: extra,
          });
        } catch (err: any) {
          logger.debug?.(`wake-effort: label skipped (${err?.message ?? err})`);
        }
      },
    };
    return gate;
  } catch (err: any) {
    logger.warn(`wake-effort: start failed open (${err?.message ?? err})`);
    return null;
  }
}
