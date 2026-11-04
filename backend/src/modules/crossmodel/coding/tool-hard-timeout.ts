/**
 * build 2026-10-09 VS — the agent loop's per-tool hard-timeout race (agent.ts TOOL_HARD_TIMEOUT_MS, 15 min),
 * extracted so a harness QUEUE wait inside the call is not charged to the tool.
 *
 * The 2026-10-09 box C incident: lanes' `verify` calls queued behind peer chains (verify-limiter.ts per process,
 * verify-container-slots.ts per container) and were answered "Tool "verify" exceeded 900s and was aborted" —
 * a failure shape (learnings-index FAILURE_MARKERS) that fed "3× tool-failure streak" tickets for work that had
 * merely been waiting in line. Now, when the timer fires it re-arms for the queued milliseconds the tool reported
 * since the call began (`getQueuedMs` — agent.ts sums ToolContext.onShieldedWait(ms, { queued: true }); the
 * verify gate reports its waits AS THEY ACCRUE), so the tool gets its full 15 min of its own time. With nothing
 * reported the race is the old one exactly: same timeout, same abort text, and — as before — the tool is never
 * cancelled (it keeps running in the background).
 */
export function raceToolHardTimeout<T>(
  work: Promise<T>,
  timeoutMs: number,
  abortValue: () => T,
  getQueuedMs?: () => number,
): Promise<T> {
  const queuedNow = (): number => {
    try { const v = getQueuedMs?.() ?? 0; return Number.isFinite(v) ? v : 0; } catch { return 0; }
  };
  const queued0 = queuedNow();
  let granted = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const hard = new Promise<T>(resolve => {
    const arm = (ms: number) => {
      timer = setTimeout(() => {
        const owed = queuedNow() - queued0 - granted;
        if (owed > 0) { granted += owed; arm(owed); return; }
        resolve(abortValue());
      }, ms);
    };
    arm(timeoutMs);
  });
  return Promise.race([work, hard]).finally(() => { if (timer) clearTimeout(timer); });
}
