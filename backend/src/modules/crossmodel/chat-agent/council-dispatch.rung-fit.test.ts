/**
 * audit 2026-10-08 W4-8 — a Dig-deeper RESEARCH rung's colleagues are fitted inside the lead's dispatch wait.
 *
 * REPLAY (chat 182f27b7 — another user's tap; timings only): tap 07:19:41, a deploy cut the run at 07:37 (requeued as
 * an escalation and restarted — the requeue path is pinned in shutdown-interrupt.test.ts / orphan-recovery.test.ts),
 * then both colleague seats hit council_dispatch_timeout at 720 s and again at 360 s on the terminal attempt; the
 * degraded synthesis shipped at 08:03 and the three real reports arrived at 08:05 as a late addendum. Cause: each
 * colleague's FINAL-TURN deadline was what was LEFT of the 15-min rung budget (~13.5 min) while the lead waited 12 min
 * (+ a 6-min retry). Fitted: the colleague's deadline ≤ ceiling − the final-turn grace, the wait = deadline + grace,
 * one attempt — the forced final report lands inside the wait.
 */
import {
  fitColleagueDeadline, fittedDispatchCeiling, runBoundedColleague, COUNCIL_DISPATCH_CEILING_MS, COUNCIL_FINAL_TURN_GRACE_MS,
  researchRungColleagueFitDisabled, type CouncilTimer,
} from './council-dispatch';
import { researchRungDeadlineMs } from './compute-policy-wiring';

describe('fitColleagueDeadline / fittedDispatchCeiling', () => {
  const RUNG_BUDGET = { maxBackgroundMs: 15 * 60_000 };
  const COLLEAGUE_BACKSTOP = 30 * 60_000;

  it('the replayed dispatch (90 s into the rung): 13.5 min of budget becomes a 9-min colleague deadline and a 12-min wait', () => {
    const left = researchRungDeadlineMs(COLLEAGUE_BACKSTOP, RUNG_BUDGET, 90_000, false);
    expect(left).toBe(13.5 * 60_000); // > the 12-min wait: a full-budget colleague was GUARANTEED to time out
    const d = fitColleagueDeadline(left);
    expect(d).toBe(COUNCIL_DISPATCH_CEILING_MS - COUNCIL_FINAL_TURN_GRACE_MS);
    expect(fittedDispatchCeiling(d)).toBe(COUNCIL_DISPATCH_CEILING_MS);
    expect(d + COUNCIL_FINAL_TURN_GRACE_MS).toBeLessThanOrEqual(fittedDispatchCeiling(d)); // the forced final fits the wait
  });

  it('a late dispatch keeps the smaller budget and waits only deadline + grace (never past the standard ceiling)', () => {
    const left = researchRungDeadlineMs(COLLEAGUE_BACKSTOP, RUNG_BUDGET, 12 * 60_000, false); // 3 min left
    expect(fitColleagueDeadline(left)).toBe(3 * 60_000);
    expect(fittedDispatchCeiling(fitColleagueDeadline(left))).toBe(6 * 60_000);
    expect(fitColleagueDeadline(10_000)).toBe(60_000); // floor
  });

  it('kill switch name', () => {
    process.env.RESEARCH_RUNG_COLLEAGUE_FIT_DISABLED = '1';
    expect(researchRungColleagueFitDisabled()).toBe(true);
    delete process.env.RESEARCH_RUNG_COLLEAGUE_FIT_DISABLED;
    expect(researchRungColleagueFitDisabled()).toBe(false);
  });
});

describe('runBoundedColleague under the fit (one attempt, fitted ceiling)', () => {
  function manualTimer() {
    const pending: Array<{ cb: () => void; ms: number; live: boolean }> = [];
    const timer: CouncilTimer = { set: (cb, ms) => { const h = { cb, ms, live: true }; pending.push(h); return h; }, clear: (h: any) => { h.live = false; } };
    return { timer, fire: () => { for (const h of pending) if (h.live) { h.live = false; h.cb(); } }, pending };
  }

  it('a colleague that reports by its forced final is a REAL report — no timeout, no retry', async () => {
    const t = manualTimer();
    const out = await runBoundedColleague({ persona: 'the Double Checker', run: async () => 'Findings: … sources …', ceilingMs: fittedDispatchCeiling(9 * 60_000), retryDisabled: true, timer: t.timer });
    expect(out).toMatchObject({ realReport: true, timedOut: false, attempts: 1 });
    expect(t.pending[0].ms).toBe(12 * 60_000);
  });

  it('a wedged colleague times out ONCE at the fitted ceiling (no half-ceiling retry past the rung budget)', async () => {
    const t = manualTimer();
    let runs = 0;
    const onTimeout = jest.fn();
    const p = runBoundedColleague({ persona: 'the Triple Checker', run: () => { runs += 1; return new Promise<string>(() => {}); }, ceilingMs: fittedDispatchCeiling(3 * 60_000), retryDisabled: true, timer: t.timer, onTimeout });
    t.fire();
    const out = await p;
    expect(out).toMatchObject({ timedOut: true, attempts: 1 });
    expect(runs).toBe(1);
    expect(onTimeout).toHaveBeenCalledWith(expect.objectContaining({ attempt: 1, terminal: true, ceilingMs: 6 * 60_000 }));
  });
});

describe('per-attempt fit (2026-10-20 review — the L3 preset): each attempt knows ITS ceiling', () => {
  it('runBoundedColleague hands run() the attempt number and that attempt\'s ceiling (12 min, then the 6-min retry)', async () => {
    const seen: Array<{ attempt: number; ceilingMs: number } | undefined> = [];
    const pending: Array<() => void> = [];
    const timer: CouncilTimer = { set: (cb) => { pending.push(cb); return cb; }, clear: () => {} };
    const p = runBoundedColleague({ persona: 'the Double Checker', run: (a) => { seen.push(a); return new Promise<string>(() => {}); }, timer });
    await Promise.resolve();
    pending.shift()!(); // attempt 1 hits its ceiling → the retry starts
    await new Promise((r) => setImmediate(r));
    pending.shift()!(); // attempt 2 hits its ceiling → terminal
    const out = await p;
    expect(seen).toEqual([{ attempt: 1, ceilingMs: COUNCIL_DISPATCH_CEILING_MS }, { attempt: 2, ceilingMs: COUNCIL_DISPATCH_CEILING_MS / 2 }]);
    expect(out).toMatchObject({ timedOut: true, attempts: 2 });
  });

  it('the preset colleague backstop (30 min) fits 9 min into the 12-min attempt and 3 min into the 6-min retry', () => {
    expect(fitColleagueDeadline(30 * 60_000, COUNCIL_DISPATCH_CEILING_MS)).toBe(9 * 60_000);
    expect(fitColleagueDeadline(30 * 60_000, COUNCIL_DISPATCH_CEILING_MS / 2)).toBe(3 * 60_000);
    expect(fitColleagueDeadline(30 * 60_000, 3 * 60_000)).toBe(60_000); // floor
  });
});
