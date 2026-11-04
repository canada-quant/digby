/**
 * Deploy retire nudge (WI-G, 2026-09-25) — a one-time harness notice delivered
 * to a MACHINE-triggered chat run at its next tool round once this process is
 * RETIRING (the old colour of a blue-green deploy, coding/retiring.ts).
 *
 * WHY: a supervisor wake that outlives the drain budget is interrupted and
 * replayed on the new colour (shutdown-interrupt.ts) — correct, but every
 * replay costs the wake's 10–20 min again. Told ONCE that the server is going
 * away in ~N s, the model can write its final from what it already has and
 * finish in place; a run that still overruns is interrupted exactly as before.
 *
 * Rides the SAME channel the Double Checker's late drafts use — agent.ts's
 * injectSystem hook, framed "[HARNESS INJECTION — not typed by the user]" —
 * so nothing new reaches the model surface. Leaf module (no app imports) so
 * the once-per-run + retiring-only contract is unit-testable. Never a
 * blocking gate — the nudge is advice; the run keeps its full tool budget.
 */

/** The deploy script's DRAIN_MAX_RETIRING_SECONDS default — what a retiring process may assume when nothing else says (env DEPLOY_RETIRE_BUDGET_SECONDS). */
export const DEFAULT_RETIRE_BUDGET_SECONDS = 900;

export function retireBudgetSeconds(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.DEPLOY_RETIRE_BUDGET_SECONDS);
  return Number.isFinite(raw) && raw > 0 ? Math.round(raw) : DEFAULT_RETIRE_BUDGET_SECONDS;
}

/** Seconds the retiring process has left before teardown, from the retire stamp + budget (never negative). */
export function retireRemainingSeconds(opts: { retiringSinceIso: string | null; budgetSeconds: number; nowMs: number }): number {
  const since = opts.retiringSinceIso ? Date.parse(opts.retiringSinceIso) : NaN;
  if (!Number.isFinite(since)) return opts.budgetSeconds;
  const elapsed = Math.max(0, Math.round((opts.nowMs - since) / 1000));
  return Math.max(0, opts.budgetSeconds - elapsed);
}

/**
 * audit 2026-10-06 T4-4 (spark.md F3c): "stop exploring, write your final in
 * your next turn" made a supervisor drop the follow-up re-arm its firing asked
 * for — the note then claimed the re-arm (struck as fabricated) and the chain
 * died. The notice now says to FINISH any re-arm / dispatch call already
 * started (one real tool call) before writing the final. Kill switch
 * RETIRE_NUDGE_FINISH_REARM_DISABLED=1 restores the previous text byte-for-byte.
 */
export function retireNudgeFinishRearmDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.RETIRE_NUDGE_FINISH_REARM_DISABLED === '1';
}

/** The notice text — one paragraph, no ids, no instructions that widen authority. */
export function retireNudgeText(remainingSeconds: number, env: NodeJS.ProcessEnv = process.env): string {
  if (retireNudgeFinishRearmDisabled(env)) {
    return `[HARNESS NOTICE — deploy: this server is RETIRING and is torn down in roughly ${remainingSeconds} s. Finish THIS run now: stop exploring, write your final message in your next turn from what you already have, and label anything unfinished as PLANNED — NOT EXECUTED. If the server is replaced before you finish, the harness re-fires this turn on the new server with your executed-tool receipts, so nothing is lost — but a run that finishes here costs nothing to replay.]`;
  }
  return `[HARNESS NOTICE — deploy: this server is RETIRING and is torn down in roughly ${remainingSeconds} s. Finish THIS run now: stop exploring; first finish any re-arm or dispatch you already decided on (ONE real schedule_message / send_chat_message call — a follow-up you only describe in your final does not exist), then write your final message from what you already have and label anything unfinished as PLANNED — NOT EXECUTED. If the server is replaced before you finish, the harness re-fires this turn on the new server with your executed-tool receipts, so nothing is lost — but a run that finishes here costs nothing to replay.]`;
}

type Injected = string | { text: string; images?: any[] } | null;
type InjectFn = (step: number) => Promise<Injected> | Injected;

export interface RetireNudgeOpts {
  /** the run is machine-triggered (schedule / hook / agent / webhook) — user turns are never nudged */
  machineTriggered: boolean;
  isRetiring: () => boolean;
  retiringSinceIso: () => string | null;
  budgetSeconds?: number;
  now?: () => number;
  /** telemetry seam — called exactly once, when the nudge is delivered */
  onNudge?: (info: { step: number; remainingSeconds: number }) => void;
}

/**
 * Wrap a run's injectSystem so the retire nudge is appended ONCE, on the first
 * tool round that finds the process retiring. The inner injector's own text
 * (drafts, colleague notes) is preserved ahead of the nudge; a null inner
 * result still delivers the nudge alone. Returns the inner function unchanged
 * when the nudge cannot apply (user turn).
 */
export function wrapInjectWithRetireNudge(inner: InjectFn | undefined, opts: RetireNudgeOpts): InjectFn | undefined {
  if (!opts.machineTriggered) return inner;
  let nudged = false;
  return async (step: number): Promise<Injected> => {
    const base = inner ? await inner(step) : null;
    if (nudged || !opts.isRetiring()) return base;
    nudged = true;
    const remaining = retireRemainingSeconds({
      retiringSinceIso: opts.retiringSinceIso(),
      budgetSeconds: opts.budgetSeconds ?? retireBudgetSeconds(),
      nowMs: (opts.now ?? Date.now)(),
    });
    try { opts.onNudge?.({ step, remainingSeconds: remaining }); } catch { /* telemetry never breaks the run */ }
    const nudge = retireNudgeText(remaining);
    if (!base) return nudge;
    if (typeof base === 'string') return `${base}\n\n${nudge}`;
    return { ...base, text: `${base.text}\n\n${nudge}` };
  };
}
