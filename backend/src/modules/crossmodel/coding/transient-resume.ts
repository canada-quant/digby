/**
 * RESUME AFTER A PROVIDER LIMIT (2026-09-29 — TB 2.1 v3e bench; owner: "real
 * no time out tb2.1 digby coding harness scores … hardening framework where
 * you find bugs").
 *
 * The unfinished-work backstop (run-executor.ts) queues a continuation only
 * when the plan board has OPEN steps. A machine run that the provider's rate
 * limit killed BEFORE it wrote a plan (the transient lane's whole backoff
 * table exhausted — the owner's gateway group had every deployment in
 * cooldown for 47 min, 04:50–05:37Z) ended FAILED with no plan, so nothing
 * resumed it and the task was silently dropped (bench trial build-cython-ext:
 * zero model turns, scored 0). The claim-time and queue-time "zero unfinished
 * steps" guards would also have cancelled any continuation on that plan-less
 * session.
 *
 * Now a NON-user run whose agent result is a TRANSIENT provider kill
 * (`modelErrorKind === 'transient'`) and whose board has no open step queues
 * ONE throttled resume (the same 3–5 min provider-throttle delay, the same
 * `[HARNESS CONTINUATION rN/6]` round accounting + stop-means-stop guard) whose
 * prompt carries TRANSIENT_RESUME_MARKER — the zero-unfinished guards exempt
 * it (the resume exists precisely because no plan was written).
 *
 * Telemetry loop_metrics
 * `transient_resume {seam, round}`. Pure leaf, no imports.
 */
export const TRANSIENT_RESUME_MARKER = '[RESUME AFTER PROVIDER LIMIT]';

/** True when a run's input message is a transient-resume continuation. */
export function isTransientResumeInput(message: unknown): boolean {
  return String(message ?? '').includes(TRANSIENT_RESUME_MARKER);
}

/** The resume prompt: the standard continuation marker (round accounting) + the resume marker (guard exemption). */
export function transientResumePrompt(round: number, maxRounds: number): string {
  return `[HARNESS CONTINUATION r${round}/${maxRounds}] ${TRANSIENT_RESUME_MARKER} The previous run on this session was cut off by the model provider's rate limit (its backoff-and-retry budget ran out) before the task was finished — nothing is wrong with the task or the approach. Continue the task from the conversation above: re-read the original request, check the current state first (files, running processes, anything already done), then carry on to completion. Do not start over unless nothing was done.`;
}
