/**
 * ALARM-CAUSE-AWARE (supervisor SOTA 2026-10-20, ranked #10) — PURE LEAF.
 *
 * hooks.service isAlarmEvent was TYPE-based: every run_failed and every
 * schedule_disabled was an alarm (daily-cap bypass, debounce bypass,
 * frozen-attempt park, and an unconditional 'alarm' reason in the supervisor
 * material gate). Three causes are not smoke detectors, and the event now
 * says so in its own payload:
 *
 *   cancelled           run_failed for a run a CHAT stopped with stop_run
 *                       (payload.cancelledBy — the requester read back from
 *                       Redis cancel-actor:<runId>). The stopper is the hook
 *                       actor, so actor-echo suppression drops its own wake;
 *                       any other subscriber gets a QUIET row.
 *   provider_transient  run_failed for a run the provider's rate limit killed
 *                       AFTER the harness queued its resume (payload
 *                       {cause:'provider_transient', resumeQueued:true, round}).
 *                       If the resume later fails without queuing another, that
 *                       failure is an ordinary alarm (lane_failed stays material).
 *   self_stop           schedule_disabled whose actor is the lane itself
 *                       (payload.stoppedByChatId === payload.sourceChatId)
 *                       while something still drives the lane
 *                       (payload.laneLiveWork — another enabled schedule or a
 *                       queued run, read at emission; never an assigned todo,
 *                       and never when the stop left ZERO enabled schedules —
 *                       that lane is DEAF and the alarm stands).
 *
 * Quiet rows flow through the supervisor material gate like any quiet event
 * but add no material reason of their own (wake-material-rule quietCause).
 *
 * Kill switch HOOK_ALARM_CAUSE_AWARE_DISABLED=1 — isAlarmEvent is type-based
 * again, stop_run writes no cancel actor, the terminal emit carries no cause
 * and the ledger diff stops excusing resume-queued failures.
 */

const onFlag = (v: unknown): boolean => {
  const s = String(v ?? '').trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'on';
};

/** HOOK_ALARM_CAUSE_AWARE_DISABLED=1 — alarm class is type-based again (pre-2026-10-20 byte-for-byte). Read per call. */
export function hookAlarmCauseAwareDisabled(): boolean {
  return onFlag(process.env.HOOK_ALARM_CAUSE_AWARE_DISABLED);
}

export type QuietAlarmCause = 'cancelled' | 'provider_transient' | 'self_stop';

/** Redis key holding the chat that requested a run's cancel (written by stop_run, read by the run finalize). */
export const CANCEL_ACTOR_KEY = (runId: string): string => `cancel-actor:${runId}`;
/** TTL of the cancel-actor key (1 h — a cancel lands within seconds; the key only has to outlive the finalize). */
export const CANCEL_ACTOR_TTL_SEC = 3600;

/** The error prefix run-executor stamps on a run the model provider killed with a TRANSIENT failure (providerKilledCause). */
export const PROVIDER_TRANSIENT_ERROR_PREFIX = 'model provider killed the run (transient';

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/**
 * The cause that makes an ALARM-TYPE row quiet, or null (still an alarm / not
 * an alarm type at all). Pure apart from the kill-switch read.
 */
export function quietAlarmCause(eventType: unknown, payload?: unknown): QuietAlarmCause | null {
  if (hookAlarmCauseAwareDisabled()) return null;
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as Record<string, unknown>;
  const t = String(eventType ?? '');
  if (t === 'run_failed') {
    if (str(p.cancelledBy)) return 'cancelled';
    if (p.resumeQueued === true) return 'provider_transient';
    return null;
  }
  if (t === 'schedule_disabled') {
    const by = str(p.stoppedByChatId);
    // A stop that left ZERO enabled schedules is the deaf lane whatever the emitter judged (review fix 2026-10-20).
    if (by && by === str(p.sourceChatId) && p.laneLiveWork === true && p.remainingEnabled !== 0) return 'self_stop';
    return null;
  }
  return null;
}

/**
 * The terminal hook extra for a run_failed emission (run-executor finalize).
 * Pure. `cancelledBy` wins (a stopped run is cancelled whatever killed it);
 * the resume only marks a FAILED provider-transient run whose resume was queued.
 * Returns {} when nothing applies or the switch is off — the emission stays
 * byte-identical to the pre-change `{ runId }`.
 */
export function terminalRunCauseExtra(input: {
  finalStatus: string;
  cancelledBy?: string | null;
  providerTransientResumeRound?: number | null;
}): Record<string, unknown> {
  if (hookAlarmCauseAwareDisabled()) return {};
  const by = str(input.cancelledBy);
  if (input.finalStatus === 'cancelled' && by) return { cause: 'cancelled', cancelledBy: by, actorChatId: by };
  const round = input.providerTransientResumeRound;
  if (input.finalStatus === 'failed' && typeof round === 'number' && Number.isFinite(round) && round > 0) {
    return { cause: 'provider_transient', resumeQueued: true, round };
  }
  return {};
}

/** Does a failed agent_runs row's error name a provider TRANSIENT kill (the resume-eligible class)? Pure. */
export function isProviderTransientFailure(error: unknown): boolean {
  return String(error ?? '').trim().toLowerCase().startsWith(PROVIDER_TRANSIENT_ERROR_PREFIX);
}

/**
 * Ledger diff: is a failed run excused because its provider-limit resume took
 * over? True when the failure is a provider TRANSIENT kill and the same lane
 * holds a LATER run (created after the failed run started) that is queued,
 * running or completed. A later run that itself FAILED excuses nothing — it is
 * judged on its own (lane_failed stays material when the resume later fails).
 * Pure.
 */
export function failureResumeQueued(
  failed: { id?: string | null; sessionId: string; error?: string | null; startedAt?: Date | null; createdAt?: Date | null },
  laneRuns: ReadonlyArray<{ id?: string | null; sessionId: string; status: string; createdAt?: Date | null }>,
): boolean {
  if (!isProviderTransientFailure(failed.error)) return false;
  const anchor = (failed.startedAt ?? failed.createdAt)?.getTime?.();
  if (!Number.isFinite(anchor as number)) return false;
  return laneRuns.some((r) => r.sessionId === failed.sessionId
    && (!failed.id || r.id !== failed.id)
    && (r.status === 'queued' || r.status === 'running' || r.status === 'completed')
    && r.createdAt instanceof Date && r.createdAt.getTime() > (anchor as number));
}
