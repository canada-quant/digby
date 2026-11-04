/**
 * Background-task registry (audit 2026-10-08 W3-1 — plumbing F1).
 *
 * A draining coding worker exited as soon as its last run's executeClaimedRun
 * resolved: `drain()` → `prisma.$disconnect()` → `process.exit(0)`. Every
 * fire-and-forget follow-up that run had started — the run_completed hook
 * emit, the coding-memory fold, the project-decision extraction, the run
 * journal — was killed mid-flight, and the loop-metrics buffer (run_spend /
 * run_tokens rows, flushed on an unref'd 2 s timer) was never written. Prod
 * 48 h: 15 runs, $188 of spend missing from API costs and spend_daily_rollups,
 * each one the LAST run its worker finished.
 *
 * The fire-and-forget call sites now register their promise here
 * (`trackBackground`), and the worker's shutdown awaits the registry with a
 * bounded deadline (`awaitBackgroundTasks`) before flushing metrics and
 * disconnecting. Registering never changes a call site's behaviour: the
 * promise is returned unchanged, rejections stay the caller's to handle (the
 * registry only observes settlement), and nothing here can throw.
 *
 * LEAF — no imports. Kill switch for the shutdown wait lives with the worker
 * (WORKER_SHUTDOWN_FLUSH_DISABLED=1); registration itself is always on and
 * free (a Set insert + one settle callback).
 */

const pending = new Map<Promise<unknown>, string>();

/**
 * Register a fire-and-forget promise so a graceful shutdown can wait for it.
 * Returns the SAME promise (call sites keep their own `.catch`). A
 * non-promise is returned untouched.
 */
export function trackBackground<T>(p: Promise<T>, label = 'background'): Promise<T> {
  try {
    if (!p || typeof (p as any).then !== 'function') return p;
    const entry: Promise<unknown> = p.then(() => undefined, () => undefined);
    pending.set(entry, String(label).slice(0, 60));
    void entry.then(() => { pending.delete(entry); });
  } catch {
    /* registration never breaks the caller */
  }
  return p;
}

/** How many tracked tasks are still in flight (tests / the shutdown log). */
export function pendingBackgroundCount(): number {
  return pending.size;
}

/** The labels of the tasks still in flight (deduped, for the shutdown log). */
export function pendingBackgroundLabels(): string[] {
  return [...new Set(pending.values())];
}

export interface BackgroundDrainResult {
  /** tasks in flight when the wait began */
  initial: number;
  /** tasks still in flight when the wait ended (0 unless timedOut) */
  remaining: number;
  /** labels still in flight at the deadline */
  remainingLabels: string[];
  timedOut: boolean;
  ms: number;
}

/**
 * Wait until every tracked task has settled — including tasks those tasks
 * register while they run (a hook emit that starts a child-failure escalation)
 * — or until `maxMs` elapses. Never throws; never rejects.
 */
export async function awaitBackgroundTasks(maxMs: number): Promise<BackgroundDrainResult> {
  const t0 = Date.now();
  const initial = pending.size;
  const budget = Number.isFinite(maxMs) && maxMs > 0 ? maxMs : 0;
  let timedOut = false;
  while (pending.size > 0) {
    const left = budget - (Date.now() - t0);
    if (left <= 0) { timedOut = true; break; }
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<'deadline'>((res) => {
      timer = setTimeout(() => res('deadline'), left);
      (timer as any).unref?.();
    });
    const settled = Promise.allSettled([...pending.keys()]).then(() => 'settled' as const);
    const which = await Promise.race([settled, deadline]);
    if (timer) clearTimeout(timer);
    if (which === 'deadline') { timedOut = pending.size > 0; break; }
  }
  return { initial, remaining: pending.size, remainingLabels: pendingBackgroundLabels(), timedOut, ms: Date.now() - t0 };
}

/** Test hook: forget every tracked task. */
export function __resetBackgroundTasksForTest(): void {
  pending.clear();
}
