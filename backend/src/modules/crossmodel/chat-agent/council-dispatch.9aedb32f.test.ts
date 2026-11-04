/**
 * Ticket 9aedb32f (bug_report, 2026-09-29) — council dispatch timeouts silently
 * degraded deep-research runs to single-model.
 *
 * The mishap (chat 2f25f493): every `dispatch_colleagues` round in a
 * deep-research run raced each colleague against a 12-minute ceiling; when the
 * ceiling won, the raw Promise.race resolved a placeholder note and the lead
 * answered ALONE — no retry, no telemetry, no user-visible notice — while the
 * deep-research compute quota was paid in full.
 *
 * The fix (council-dispatch.ts + wiring in chat-agent.service.ts):
 *   1. runBoundedColleague: per-attempt ceiling, ONE automatic retry of a
 *      wedged attempt (fresh run; the timed-out attempt is cancelled by the
 *      caller's per-attempt latch), the TERMINAL straggler keeps running and
 *      its late report lands in the lead's council-note inbox (onLateReport).
 *   2. council_dispatch_timeout + council_degraded_run loop metrics.
 *   3. Degraded-run notice in the final message when the council was
 *      dispatched but returned ZERO real reports.
 *
 * These tests drive the ceilings by hand via the injectable timer (no real
 * waiting) and pin the service wiring by source bytes (repo idiom:
 * tool-executor.88915954.test.ts).
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import {
  runBoundedColleague,
  isRealCouncilReport,
  councilCeilingPlaceholder,
  councilAttemptCeiling,
  COUNCIL_DISPATCH_CEILING_MS,
  COUNCIL_DISPATCH_MAX_ATTEMPTS,
  type CouncilTimer,
} from './council-dispatch';

/** Hand-driven clock: ceilings fire only when the test fires them. */
class FakeClock {
  now = 0;
  private timers: Array<{ at: number; cb: () => void; cleared: boolean }> = [];
  /** Ceiling durations actually armed, in order — pins half-ceiling retries. */
  armedCeilings: number[] = [];
  set = (cb: () => void, ms: number) => {
    const h = { at: this.now + ms, cb, cleared: false };
    this.timers.push(h);
    this.armedCeilings.push(ms);
    return h;
  };
  clear = (h: unknown) => { (h as { cleared: boolean }).cleared = true; };
  get timer(): CouncilTimer { return { set: this.set, clear: this.clear }; }
  /** Fire the earliest pending timer; returns the ms it was armed with. */
  fireNext(): number | null {
    const pending = this.timers.filter(t => !t.cleared && t.at >= this.now).sort((a, b) => a.at - b.at);
    if (!pending.length) return null;
    pending[0].cleared = true;
    this.now = pending[0].at;
    pending[0].cb();
    return pending[0].at - 0; // fired at its scheduled time (advance value kept in this.now)
  }
}

type Deferred = { promise: Promise<string>; resolve: (v: string) => void; reject: (e: unknown) => void };
const defer = (): Deferred => {
  let resolve!: (v: string) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<string>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};
const flush = () => new Promise<void>(r => setImmediate(r));

const REAL_REPORT = '## Research findings\nIndependent verification: the 2026 Q3 numbers reconcile; two sources disagree on the margin figure — details below.';

describe('ticket 9aedb32f — runBoundedColleague (per-colleague budget + one retry)', () => {

  it('1. a colleague that reports within the ceiling returns its report, one attempt, no timeout', async () => {
    const onTimeout = jest.fn();
    const outcome = await runBoundedColleague({
      persona: 'GLM-5.3', run: () => Promise.resolve(REAL_REPORT), onTimeout, ceilingMs: 12 * 60_000, timer: new FakeClock().timer,
    });
    expect(outcome).toEqual({ report: REAL_REPORT, realReport: true, timedOut: false, attempts: 1 });
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it('2. a WEDGED first attempt is retried once on a fresh run — retry succeeds, budget halves', async () => {
    const clock = new FakeClock();
    const onTimeout = jest.fn();
    const d1 = defer(); let started = 0;
    const outcomeP = runBoundedColleague({
      persona: 'GLM-5.3',
      run: () => { started += 1; return started === 1 ? d1.promise : Promise.resolve(REAL_REPORT); },
      onTimeout, ceilingMs: 12 * 60_000, timer: clock.timer,
    });
    await flush();
    expect(started).toBe(1);
    expect(clock.fireNext()).not.toBeNull(); // attempt-1 ceiling (12 min)
    await flush();
    expect(started).toBe(2); // fresh run started before we wait again
    const outcome = await outcomeP;
    expect(outcome).toEqual({ report: REAL_REPORT, realReport: true, timedOut: false, attempts: 2 });
    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(onTimeout).toHaveBeenCalledWith({ attempt: 1, attempts: 2, terminal: false, ceilingMs: 12 * 60_000 });
    // Budget shape: attempt 1 = full ceiling, attempt 2 = HALF (floor 60 s).
    expect(clock.armedCeilings).toEqual([12 * 60_000, 6 * 60_000]);
  });

  it('3. both attempts wedge → terminal timeout: placeholder report, 2 attempts, terminal onTimeout', async () => {
    const clock = new FakeClock();
    const onTimeout = jest.fn();
    let started = 0;
    const outcomeP = runBoundedColleague({
      persona: 'DeepSeek V4.1 Flash',
      run: () => { started += 1; return defer().promise; },
      onTimeout, ceilingMs: 12 * 60_000, timer: clock.timer,
    });
    await flush(); clock.fireNext(); await flush(); clock.fireNext();
    const outcome = await outcomeP;
    expect(started).toBe(2);
    expect(outcome.timedOut).toBe(true);
    expect(outcome.attempts).toBe(2);
    expect(outcome.realReport).toBe(false);
    // Placeholder wording is UNCHANGED from the pre-fix race (lead-behaviour stability).
    // Placeholder cites the TOTAL ceiling (12-min — pre-fix wording preserved);
    // the per-attempt 6-min ceiling rides the onTimeout telemetry instead.
    expect(outcome.report).toBe(councilCeilingPlaceholder('DeepSeek V4.1 Flash', 12 * 60_000));
    expect(outcome.report).toContain('still working past the 12-minute dispatch ceiling');
    expect(onTimeout).toHaveBeenCalledTimes(2);
    expect(onTimeout).toHaveBeenLastCalledWith({ attempt: 2, attempts: 2, terminal: true, ceilingMs: 6 * 60_000 });
  });

  it('4. the TERMINAL straggler keeps running: its late report is handed over exactly once', async () => {
    const clock = new FakeClock();
    const onLateReport = jest.fn();
    let started = 0; const ds: Array<ReturnType<typeof defer>> = [];
    const outcomeP = runBoundedColleague({
      persona: 'GLM-5.3',
      run: () => { started += 1; const d = defer(); ds.push(d); return d.promise; },
      onLateReport, ceilingMs: 12 * 60_000, timer: clock.timer,
    });
    await flush(); clock.fireNext(); await flush(); clock.fireNext();
    const outcome = await outcomeP;
    expect(outcome.timedOut).toBe(true);
    // Straggler (attempt 2) finishes minutes later — the report is NOT discarded:
    ds[1].resolve('  Late-arriving findings from the straggler.  ');
    await flush(); await flush();
    expect(onLateReport).toHaveBeenCalledTimes(1);
    expect(onLateReport).toHaveBeenCalledWith('Late-arriving findings from the straggler.');
    // Reviewer F2: the abandoned non-terminal attempt may STILL resolve late
    // (a wedged tool call that never re-checks its cancel flag). Its report is
    // routed to the SAME inbox hook instead of being silently discarded — the
    // lead drains it if still alive; the .catch keeps a rejection benign.
    ds[0].resolve('stale wedged attempt text');
    await flush(); await flush();
    expect(onLateReport).toHaveBeenCalledTimes(2);
    expect(onLateReport).toHaveBeenLastCalledWith('stale wedged attempt text');
    // An EMPTY late resolution from the abandoned attempt delivers nothing
    // (the blank guard in the routing keeps empty strings out of the inbox):
    ds[0].resolve = () => {}; // a resolved promise stays resolved — no-op guard
  });

  it('5. a late REJECTION (straggler or abandoned attempt) never becomes an unhandledRejection', async () => {
    const clock = new FakeClock();
    const ds: Array<ReturnType<typeof defer>> = [];
    const outcomeP = runBoundedColleague({
      persona: 'GLM-5.3',
      run: () => { const d = defer(); ds.push(d); return d.promise; },
      ceilingMs: 12 * 60_000, timer: clock.timer,
    });
    await flush(); clock.fireNext(); await flush(); clock.fireNext();
    const outcome = await outcomeP;
    expect(outcome.timedOut).toBe(true);
    const unhandled: unknown[] = [];
    const onUnhandled = (r: unknown) => unhandled.push(r);
    process.on('unhandledRejection', onUnhandled);
    try {
      ds[1].reject(new Error('provider connection reset (late straggler)'));
      ds[0].reject(new Error('abandoned attempt rejected late'));
      await new Promise(r => setTimeout(r, 25));
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    expect(unhandled).toEqual([]);
  });

  it('6. a run() that SYNC-THROWS is treated as an empty attempt, not a crash', async () => {
    const outcome = await runBoundedColleague({
      persona: 'GLM-5.3', run: (() => { throw new Error('sync blowup'); }) as () => Promise<string>,
      ceilingMs: 12 * 60_000, timer: new FakeClock().timer,
    });
    expect(outcome).toEqual({ report: '(no report produced)', realReport: false, timedOut: false, attempts: 1 });
  });

  it('7. retryDisabled (kill switch) restores pre-fix pacing: ONE attempt, terminal on the first ceiling', async () => {
    const clock = new FakeClock();
    const onTimeout = jest.fn();
    let started = 0;
    const outcomeP = runBoundedColleague({
      persona: 'GLM-5.3',
      run: () => { started += 1; return defer().promise; },
      retryDisabled: true, onTimeout, ceilingMs: 12 * 60_000, timer: clock.timer,
    });
    await flush(); clock.fireNext();
    const outcome = await outcomeP;
    expect(started).toBe(1);
    expect(outcome.attempts).toBe(1);
    expect(outcome.timedOut).toBe(true);
    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(onTimeout).toHaveBeenCalledWith({ attempt: 1, attempts: 1, terminal: true, ceilingMs: 12 * 60_000 });
    expect(clock.armedCeilings).toEqual([12 * 60_000]); // full ceiling, no half retry armed
  });

  it('10. maxAttempts is honoured beyond the default (a 3-attempt config retries twice)', async () => {
    const clock = new FakeClock();
    let started = 0;
    const outcomeP = runBoundedColleague({
      persona: 'GLM-5.3',
      run: () => { started += 1; return started < 3 ? defer().promise : Promise.resolve(REAL_REPORT); },
      maxAttempts: 3, ceilingMs: 12 * 60_000, timer: clock.timer,
    });
    await flush(); clock.fireNext(); await flush(); clock.fireNext(); await flush();
    const outcome = await outcomeP;
    expect(outcome).toEqual({ report: REAL_REPORT, realReport: true, timedOut: false, attempts: 3 });
    expect(clock.armedCeilings).toEqual([12 * 60_000, 6 * 60_000, 6 * 60_000]);
  });

  it('11. a custom classify() overrides real-report detection', async () => {
    const outcome = await runBoundedColleague({
      persona: 'GLM-5.3', run: () => Promise.resolve('(no report produced)'),
      classify: () => true, ceilingMs: 12 * 60_000, timer: new FakeClock().timer,
    });
    expect(outcome.realReport).toBe(true);
  });
});

describe('ticket 9aedb32f — isRealCouncilReport (lead-directive notes are NOT research)', () => {
  it('accepts real research text, including text that merely MENTIONS a failure', () => {
    expect(isRealCouncilReport(REAL_REPORT)).toBe(true);
    expect(isRealCouncilReport('  trimmed real text  ')).toBe(true);
    expect(isRealCouncilReport('Research summary\n(one provider call failed, retried successfully)')).toBe(true);
  });
  it('rejects empty and the known lead-directive placeholder shapes', () => {
    expect(isRealCouncilReport('')).toBe(false);
    expect(isRealCouncilReport('   ')).toBe(false);
    expect(isRealCouncilReport('(no report produced)')).toBe(false);
    expect(isRealCouncilReport('(GLM-5.3 failed: 401 from provider)')).toBe(false);
    expect(isRealCouncilReport('(DeepSeek V4.1 Flash unavailable — no key configured)')).toBe(false);
    expect(isRealCouncilReport('(GLM-5.3 is still working past the 12-minute dispatch ceiling — proceed with the reports you have; late findings may still arrive as council notes.)')).toBe(false);
  });
});

describe('ticket 9aedb32f — budget constants', () => {
  it('defaults: 12-minute ceiling, 2 attempts; attempt 2 gets HALF (floor 60 s)', () => {
    expect(COUNCIL_DISPATCH_CEILING_MS).toBe(12 * 60_000);
    expect(COUNCIL_DISPATCH_MAX_ATTEMPTS).toBe(2);
    expect(councilAttemptCeiling(12 * 60_000, 1)).toBe(12 * 60_000);
    expect(councilAttemptCeiling(12 * 60_000, 2)).toBe(6 * 60_000);
    expect(councilAttemptCeiling(90_000, 2)).toBe(60_000); // floor
    expect(councilAttemptCeiling(12 * 60_000, 3)).toBe(6 * 60_000);
  });
});

describe('ticket 9aedb32f — chat-agent.service.ts wiring (source pins, repo idiom 88915954)', () => {
  const svcSrc = readFileSync(join(__dirname, 'chat-agent.service.ts'), 'utf8');
  // The kind registry lives in the import-free leaf loop-metric-kinds.ts
  // (ticket 6665fff6, review A8 extraction) — loop-metrics.service re-exports it.
  const loopSrc = readFileSync(join(__dirname, '..', 'platform', 'loop-metric-kinds.ts'), 'utf8');

  it('12. imports runBoundedColleague from ./council-dispatch', () => {
    expect(svcSrc).toContain("from './council-dispatch'");
    expect(svcSrc).toMatch(/import \{[^}]*runBoundedColleague[^}]*\} from '\.\/council-dispatch'/);
  });

  it('13. the dispatch round routes every colleague through runBoundedColleague with retry + late-report wiring', () => {
    expect(svcSrc).toContain('runBoundedColleague({');
    expect(svcSrc).toContain('retryDisabled: fitCeilingMs !== undefined,');
    expect(svcSrc).toContain("onLateReport: text => { inbox.lead.push(`[LATE REPORT from ${persona}]");
    expect(svcSrc).toContain('if (outcome.realReport) councilRealReports += 1;');
    // The per-attempt cancel latch: a wedged NON-terminal attempt is cancelled so it stops spending.
    expect(svcSrc).toContain('if (!info.terminal && latch) latch.cancelled = true;');
    // The user's Stop is still OR-ed in for EVERY attempt (run-level latch preserved).
    expect(svcSrc).toContain('args.isCancelled?.() || opts?.cancelled?.()');
    // Timeout telemetry + a user-visible progress line on the retry.
    expect(svcSrc).toContain('LOOP_METRIC_KINDS.COUNCIL_DISPATCH_TIMEOUT');
    // Copy lives in status-voice.ts since 2026-10-04 (Digby's status voice): the retry beat is STATUS.team.slow —
    // or, with no wall clock (2026-10-20), STATUS.team.stalled (a colleague is restarted only when it STOPPED) /
    // STATUS.team.stuckThinking (it only kept reasoning past the reasoning-only bound — review 2026-10-20).
    expect(svcSrc).toContain('if (!info.terminal) send(\'progress\', { message: stallWait ? (reasoningOnly ? STATUS.team.stuckThinking(persona) : STATUS.team.stalled(persona)) : STATUS.team.slow(persona)');
  });

  it('14. dispatchRounds increments BEFORE dispatch, so an all-timeout round still counts as degraded', () => {
    const inc = svcSrc.indexOf('dispatchRounds += 1;');
    const call = svcSrc.indexOf('runBoundedColleague({');
    expect(inc).toBeGreaterThan(-1);
    expect(call).toBeGreaterThan(-1);
    expect(inc).toBeLessThan(call);
  });

  it('15. the degraded-run notice: dispatched-but-zero-real-reports → visible notice + metric, kill-switchable', () => {
    expect(svcSrc).toContain('dispatchRounds > 0 && councilRealReports === 0;');
    expect(svcSrc).toContain('Degraded research run: the deep-research council');
    expect(svcSrc).toContain('this answer is from the lead model alone');
    expect(svcSrc).toContain('[LATE REPORT] blocks');
    expect(svcSrc).toContain('LOOP_METRIC_KINDS.COUNCIL_DEGRADED_RUN');
    // `raw` is the text BOTH surfaces read; the notice rides it before persistence.
    expect(svcSrc).toContain('result.parts = [...(result.parts || []).filter(p => p.type !== \'text\'), { type: \'text\', text: raw }];');
  });

  it('16. the notice is appended BEFORE markdown repair/persistence (survives reloads — screen≠DB doctrine)', () => {
    const notice = svcSrc.indexOf('Degraded research run: the deep-research council');
    const persist = svcSrc.indexOf('raw = normalizeAssistantMarkdown(raw);');
    expect(notice).toBeGreaterThan(-1);
    expect(persist).toBeGreaterThan(-1);
    expect(notice).toBeLessThan(persist);
  });

  it('17. both loop-metric kinds are registered', () => {
    expect(loopSrc).toContain("COUNCIL_DISPATCH_TIMEOUT: 'council_dispatch_timeout'");
    expect(loopSrc).toContain("COUNCIL_DEGRADED_RUN: 'council_degraded_run'");
  });
});
