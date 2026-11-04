/**
 * Deep research has NO wall clock (2026-10-20, owner: "deep research shouldn't have any limit") — the dispatch wait,
 * the late-findings holder and the chat-agent wiring (council-dispatch.ts researchNoWallClock).
 *
 * Before: the lead waited 12 min for a colleague (retry 6 min) and the colleague was fitted to a 9 / 3-min final turn —
 * research still in progress was ended by a clock. Now:
 *   - runBoundedColleague `stall`: an attempt ends only after the colleague made NO progress for the window (1.5 ×
 *     COUNCIL_STALL_MS); a PROGRESSING colleague is never timed out; the retry gets the same window; an idle retry
 *     becomes a terminal straggler whose late report is handed over and whose promise is tracked (onStraggler);
 *   - council-late-addendum: markDelivered / track — a non-degraded run flushes the late notes the lead never read
 *     after the grace, then each tracked straggler's later finding as it lands (bounded);
 *   - RESEARCH_NO_WALL_CLOCK_DISABLED=1 (switch) and COUNCIL_STALL_MS (ops knob).
 * Review 2026-10-20: reasoning alone is bounded liveness (councilReasoningOnlyMs), the dispatch window never undercuts
 * the 290 s pre-header wait, and an in-hand late finding is never held for a slower straggler.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../../config/database', () => ({ __esModule: true, default: {} }));
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: jest.fn(),
  LOOP_METRIC_KINDS: { COUNCIL_LATE_ADDENDUM: 'council_late_addendum' },
}));

import {
  runBoundedColleague, isRealCouncilReport, councilStalledPlaceholder, councilStallMs, councilDispatchStallMs,
  researchNoWallClock, researchNoWallClockDisabled, createSeatProgress, noteSeatProgress, seatIdleMs, isLateCouncilFinding,
  COUNCIL_STALL_MS_DEFAULT, COUNCIL_TOOL_IN_FLIGHT_GRACE_MS, COUNCIL_TURN_HEADER_WAIT_MS, councilReasoningOnlyMs,
  councilLateStragglerWaitMs, type CouncilTimer,
} from './council-dispatch';
import { armLateCouncilAddendum } from './council-late-addendum';

/** Hand-driven timer: every armed callback waits until the test fires it; `armed` records the ms of each. */
function manualTimer() {
  const pending: Array<{ cb: () => void; ms: number; live: boolean }> = [];
  const armed: number[] = [];
  const timer: CouncilTimer = {
    set: (cb, ms) => { const h = { cb, ms, live: true }; pending.push(h); armed.push(ms); return h; },
    clear: (h: any) => { if (h) h.live = false; },
  };
  /** Fire every live timer once (a poll re-arms itself as a NEW timer). Returns how many fired. */
  const fireAll = () => { const live = pending.filter((h) => h.live); for (const h of live) { h.live = false; h.cb(); } return live.length; };
  const liveCount = () => pending.filter((h) => h.live).length;
  return { timer, fireAll, liveCount, armed };
}
const flush = () => new Promise<void>((r) => setImmediate(r));
type Deferred = { promise: Promise<string>; resolve: (v: string) => void };
const defer = (): Deferred => { let resolve!: (v: string) => void; const promise = new Promise<string>((r) => { resolve = r; }); return { promise, resolve }; };
const REAL = '## Findings\nThe three primary sources agree on the 2026 figure; the fourth is a reprint — details and links below.';

const ENV = ['RESEARCH_NO_WALL_CLOCK_DISABLED', 'COUNCIL_STALL_MS'] as const;
beforeEach(() => { for (const k of ENV) delete process.env[k]; });
afterAll(() => { for (const k of ENV) delete process.env[k]; });

describe('switch + knob', () => {
  it('RESEARCH_NO_WALL_CLOCK_DISABLED=1 is the release switch (default: no wall clock)', () => {
    expect(researchNoWallClock()).toBe(true);
    process.env.RESEARCH_NO_WALL_CLOCK_DISABLED = '1';
    expect(researchNoWallClockDisabled()).toBe(true);
    expect(researchNoWallClock()).toBe(false);
  });
  it('COUNCIL_STALL_MS: default 10 min, clamped 2..60 min, blank / garbage ⇒ default; the dispatch waits 1.5 × it', () => {
    expect(councilStallMs()).toBe(COUNCIL_STALL_MS_DEFAULT);
    expect(COUNCIL_STALL_MS_DEFAULT).toBe(600_000);
    process.env.COUNCIL_STALL_MS = '300000';
    expect(councilStallMs()).toBe(300_000);
    process.env.COUNCIL_STALL_MS = '1000';
    expect(councilStallMs()).toBe(120_000);
    process.env.COUNCIL_STALL_MS = '99999999';
    expect(councilStallMs()).toBe(3_600_000);
    process.env.COUNCIL_STALL_MS = ' ';
    expect(councilStallMs()).toBe(600_000);
    process.env.COUNCIL_STALL_MS = 'ten minutes';
    expect(councilStallMs()).toBe(600_000);
    expect(councilDispatchStallMs(600_000)).toBe(900_000);
  });
});

describe('seat progress (pure)', () => {
  it('idle grows from the last event; a tool in flight counts as progress up to the tool grace; tool_end balances', () => {
    const p = createSeatProgress(1_000);
    expect(seatIdleMs(p, 61_000)).toBe(60_000);
    noteSeatProgress(p, 'event', 100_000);
    expect(seatIdleMs(p, 100_000)).toBe(0);
    noteSeatProgress(p, 'tool_start', 200_000);
    expect(seatIdleMs(p, 200_000 + 10 * 60_000)).toBe(0); // a 10-min web call is progress
    expect(seatIdleMs(p, 200_000 + COUNCIL_TOOL_IN_FLIGHT_GRACE_MS + 5_000)).toBe(5_000); // a leaked tool_start cannot hold the wait forever
    noteSeatProgress(p, 'tool_end', 300_000);
    expect(p.toolsInFlight).toBe(0);
    expect(seatIdleMs(p, 360_000)).toBe(60_000);
    noteSeatProgress(p, 'tool_end', 300_000); // never negative
    expect(p.toolsInFlight).toBe(0);
  });
});

describe('runBoundedColleague — no wall clock (`stall`)', () => {
  it('a colleague that keeps PROGRESSING is never timed out — 50 polls (≈ 4 h of wall clock) and it still reports, one attempt', async () => {
    const t = manualTimer();
    const d = defer();
    const onTimeout = jest.fn();
    const onStraggler = jest.fn();
    let idle = 0;
    const p = runBoundedColleague({
      persona: 'the Double Checker', run: () => d.promise, timer: t.timer, onTimeout, onStraggler,
      ceilingMs: 60_000, // ignored in stall mode
      stall: { ms: 900_000, idleMs: () => idle, pollMs: 300_000 },
    });
    await flush();
    for (let i = 0; i < 50; i++) { idle = (i * 7_919) % 899_000; expect(t.fireAll()).toBe(1); }
    expect(t.liveCount()).toBe(1); // still waiting, re-armed
    d.resolve(REAL);
    const out = await p;
    expect(out).toEqual({ report: REAL, realReport: true, timedOut: false, attempts: 1 });
    expect(onTimeout).not.toHaveBeenCalled();
    expect(onStraggler).not.toHaveBeenCalled();
    expect(t.armed.every((ms) => ms === 300_000)).toBe(true);
    expect(t.liveCount()).toBe(0); // the poll is cleared once the run reports
  });

  it('an IDLE colleague: the attempt is given up (cancel + retry with the SAME window), the idle retry becomes a terminal straggler — placeholder says it stopped responding; both promises tracked; the late report lands', async () => {
    const t = manualTimer();
    const d1 = defer();
    const d2 = defer();
    const seen: Array<{ attempt: number; ceilingMs: number } | undefined> = [];
    const onTimeout = jest.fn();
    const onStraggler = jest.fn();
    const onLateReport = jest.fn();
    let idle = 0;
    const p = runBoundedColleague({
      persona: 'the Triple Checker',
      run: (a) => { seen.push(a); return a?.attempt === 1 ? d1.promise : d2.promise; },
      timer: t.timer, onTimeout, onStraggler, onLateReport,
      stall: { ms: 900_000, idleMs: () => idle },
    });
    await flush();
    t.fireAll(); // progressing: nothing happens
    expect(onTimeout).not.toHaveBeenCalled();
    idle = 900_001; // past 1.5 × the stall
    t.fireAll();
    await flush();
    expect(onTimeout).toHaveBeenNthCalledWith(1, { attempt: 1, attempts: 2, terminal: false, ceilingMs: 900_000 });
    expect(seen).toEqual([{ attempt: 1, ceilingMs: 900_000 }, { attempt: 2, ceilingMs: 900_000 }]); // the retry gets the SAME window — not half
    idle = 0; // the fresh attempt starts progressing…
    t.fireAll();
    expect(onTimeout).toHaveBeenCalledTimes(1);
    idle = 2_000_000; // …then stalls too
    t.fireAll();
    const out = await p;
    expect(onTimeout).toHaveBeenNthCalledWith(2, { attempt: 2, attempts: 2, terminal: true, ceilingMs: 900_000 });
    expect(out).toEqual({ report: councilStalledPlaceholder('the Triple Checker', 900_000), realReport: false, timedOut: true, attempts: 2 });
    expect(out.report).toBe('(the Triple Checker stopped responding — no progress for 15 minutes — proceed with the reports you have; late findings may still arrive as council notes.)');
    expect(isRealCouncilReport(out.report)).toBe(false);
    expect(onStraggler).toHaveBeenCalledTimes(2); // the abandoned attempt AND the terminal straggler
    expect(onStraggler.mock.calls[1][0]).toBeInstanceOf(Promise);
    d2.resolve(REAL); // the straggler recovers later — its findings are handed over, not dropped
    await flush();
    expect(onLateReport).toHaveBeenCalledWith(REAL);
  });

  it('a late FINDING is research only — never an abandoned attempt\'s "(Stopped.)" nor a failure / stall note', () => {
    expect(isLateCouncilFinding(REAL)).toBe(true);
    expect(isLateCouncilFinding('(Stopped.)')).toBe(false);
    expect(isLateCouncilFinding('  (Stopped.)  ')).toBe(false);
    expect(isLateCouncilFinding('(the Double Checker failed: 502)')).toBe(false);
    expect(isLateCouncilFinding(councilStalledPlaceholder('the Double Checker', 900_000))).toBe(false);
    expect(isLateCouncilFinding('')).toBe(false);
  });

  it('the default poll is ≤ 30 s and at least 1 s', async () => {
    const t = manualTimer();
    void runBoundedColleague({ persona: 'x', run: () => new Promise<string>(() => {}), timer: t.timer, stall: { ms: 900_000, idleMs: () => 0 } });
    await flush();
    const t2 = manualTimer();
    void runBoundedColleague({ persona: 'x', run: () => new Promise<string>(() => {}), timer: t2.timer, stall: { ms: 1_200, idleMs: () => 0 } });
    await flush();
    expect(t.armed[0]).toBe(30_000);
    expect(t2.armed[0]).toBe(1_000);
  });

  it('without `stall` the ceiling is exactly as before (12-min attempt, half-ceiling retry, the old placeholder, no onStraggler)', async () => {
    const t = manualTimer();
    const onStraggler = jest.fn();
    const p = runBoundedColleague({ persona: 'the Double Checker', run: () => new Promise<string>(() => {}), timer: t.timer });
    await flush();
    t.fireAll();
    await flush();
    t.fireAll();
    const out = await p;
    expect(t.armed).toEqual([12 * 60_000, 6 * 60_000]);
    expect(out.report).toMatch(/still working past the 12-minute dispatch ceiling/);
    expect(onStraggler).not.toHaveBeenCalled();
  });
});

describe('council-late-addendum — no finding dropped on a NON-degraded run', () => {
  function holder() {
    const created: any[] = [];
    const prisma: any = {
      crossModelMessage: { create: jest.fn(async (q: any) => { created.push(q.data); return { id: 'add-1' }; }) },
      crossModelChat: { update: jest.fn(async () => ({})) },
    };
    const recordMetric = jest.fn();
    const h = armLateCouncilAddendum({ chatId: 'c1', sessionId: 's1', graceMs: 0, prisma, recordMetric });
    return { h, created, prisma, recordMetric };
  }

  it('flushes ONLY the late notes the lead never read, after awaiting the tracked straggler', async () => {
    const { h, created, recordMetric } = holder();
    h.enable(); // the chat-agent enables every run that dispatched
    h.note('the Double Checker', 'EARLY late report the lead drained');
    h.markDelivered(); // the lead's injectSystem drained it
    const straggler = defer();
    h.track(straggler.promise.then((t) => { h.note('the Triple Checker', t); return t; }));
    h.bind('row-1', { models: {}, modelLabels: {}, mode: 'deep_research' });
    const settled = h.settle();
    await flush();
    expect(created).toHaveLength(0); // waits for the straggler — nothing undelivered yet
    straggler.resolve('LATE report after the answer shipped');
    await settled;
    expect(created).toHaveLength(1);
    expect(created[0].content).toContain('LATE report after the answer shipped');
    expect(created[0].content).not.toContain('EARLY late report');
    expect(created[0].metadata).toMatchObject({ kind: 'council_addendum', addendumFor: 'row-1', council: { reports: 1 } });
    expect(recordMetric).toHaveBeenCalledWith(expect.objectContaining({ meta: expect.objectContaining({ reports: 1 }) }));
  });

  it('nothing undelivered and no straggler ⇒ no follow-up row', async () => {
    const { h, created } = holder();
    h.enable();
    h.note('the Double Checker', 'read by the lead');
    h.markDelivered();
    h.bind('row-2', { models: {}, modelLabels: {}, mode: 'deep_research' });
    await h.settle();
    expect(created).toHaveLength(0);
  });

  it('a tracked straggler that recovers with nothing (or rejects) adds no row and never throws', async () => {
    const { h, created } = holder();
    h.enable();
    h.track(Promise.reject(new Error('provider died')));
    h.track(Promise.resolve(''));
    h.bind('row-3', { models: {}, modelLabels: {}, mode: 'deep_research' });
    await expect(h.settle()).resolves.toBeUndefined();
    expect(created).toHaveLength(0);
  });

  it('an un-enabled holder (a run that never dispatched) never waits nor flushes', async () => {
    const { h, created } = holder();
    h.note('x', 'y');
    h.track(new Promise(() => {})); // would hang settle() if it were awaited
    h.bind('row-4', { models: {}, modelLabels: {}, mode: 'deep_research' });
    await h.settle();
    expect(created).toHaveLength(0);
  });
});

describe('review 2026-10-20 — bounded reasoning liveness, the header wait, incremental late findings', () => {
  it('the dispatch window never undercuts the colleague\'s own 290 s pre-header wait (COUNCIL_STALL_MS below ~193 s)', () => {
    expect(COUNCIL_TURN_HEADER_WAIT_MS).toBe(290_000);
    expect(councilDispatchStallMs(600_000)).toBe(900_000); // the default is unchanged
    expect(councilDispatchStallMs(120_000)).toBe(435_000); // was 180 s — shorter than the 290 s header wait
    expect(councilDispatchStallMs(193_000)).toBe(435_000);
    expect(councilDispatchStallMs(300_000)).toBe(450_000);
    for (const s of [120_000, 150_000, 192_000, 250_000, 290_000, 600_000, 3_600_000]) {
      expect(councilDispatchStallMs(s)).toBeGreaterThan(Math.max(s, COUNCIL_TURN_HEADER_WAIT_MS));
    }
    process.env.COUNCIL_STALL_MS = '120000';
    expect(councilDispatchStallMs()).toBe(435_000);
  });

  it('reasoning is BOUNDED liveness: a seat that only reasons goes idle one extra window past its last material event', () => {
    const W = councilDispatchStallMs(); // 900 s
    expect(councilReasoningOnlyMs()).toBe(W);
    const p = createSeatProgress(0);
    noteSeatProgress(p, 'event', 0);
    // a reasoning token every 5 s for 40 min: never idle by the plain measure…
    let t = 0;
    for (; t <= 40 * 60_000; t += 5_000) noteSeatProgress(p, 'reasoning', t);
    t -= 5_000;
    expect(seatIdleMs(p, t)).toBe(0);
    // …but reasoning-only past the allowance counts as idle, so the wait (idle > W) gives up at 2 × W
    expect(seatIdleMs(p, W, COUNCIL_TOOL_IN_FLIGHT_GRACE_MS, W)).toBe(0);
    expect(seatIdleMs(p, 2 * W, COUNCIL_TOOL_IN_FLIGHT_GRACE_MS, W)).toBe(W);
    expect(seatIdleMs(p, 2 * W + 1, COUNCIL_TOOL_IN_FLIGHT_GRACE_MS, W)).toBeGreaterThan(W);
    // a material event (answer text, a tool call / result) resets the reasoning-only clock
    noteSeatProgress(p, 'event', t);
    expect(seatIdleMs(p, t + 60_000, COUNCIL_TOOL_IN_FLIGHT_GRACE_MS, W)).toBe(60_000);
    noteSeatProgress(p, 'reasoning', t + 60_000);
    expect(seatIdleMs(p, t + 60_000, COUNCIL_TOOL_IN_FLIGHT_GRACE_MS, W)).toBe(0);
  });

  it('a tool in flight: the reasoning allowance never drops below the tool grace (a short COUNCIL_STALL_MS never undercuts a running tool)', () => {
    const W = councilDispatchStallMs(120_000); // 435 s < the 15-min tool grace
    const p = createSeatProgress(0);
    noteSeatProgress(p, 'tool_start', 0); // e.g. spawn_self — its clone streams reasoning
    for (let t = 5_000; t <= COUNCIL_TOOL_IN_FLIGHT_GRACE_MS; t += 5_000) noteSeatProgress(p, 'reasoning', t);
    expect(seatIdleMs(p, COUNCIL_TOOL_IN_FLIGHT_GRACE_MS, COUNCIL_TOOL_IN_FLIGHT_GRACE_MS, W)).toBe(0);
    expect(seatIdleMs(p, COUNCIL_TOOL_IN_FLIGHT_GRACE_MS + W + 1, COUNCIL_TOOL_IN_FLIGHT_GRACE_MS, W)).toBe(W + 1); // …and it is still bounded
  });

  it('omitting reasoningOnlyMs keeps reasoning unbounded progress (the pure function\'s pre-review shape)', () => {
    const p = createSeatProgress(0);
    for (let t = 0; t <= 4 * 60 * 60_000; t += 60_000) noteSeatProgress(p, 'reasoning', t);
    expect(seatIdleMs(p, 4 * 60 * 60_000)).toBe(0);
  });

  it('runBoundedColleague gives up on a colleague that streams ONLY reasoning (the incident: hours of looping thinking held the lead)', async () => {
    const t = manualTimer();
    const W = councilDispatchStallMs();
    let clock = 0;
    const progress = createSeatProgress(0);
    const onTimeout = jest.fn();
    const p = runBoundedColleague({
      persona: 'the Double Checker', run: () => new Promise<string>(() => {}), timer: t.timer, onTimeout, retryDisabled: true,
      stall: { ms: W, idleMs: () => seatIdleMs(progress, clock, COUNCIL_TOOL_IN_FLIGHT_GRACE_MS, councilReasoningOnlyMs()), pollMs: 30_000 },
    });
    await flush();
    let polls = 0;
    while (onTimeout.mock.calls.length === 0 && polls < 1_000) {
      clock += 30_000;
      noteSeatProgress(progress, 'reasoning', clock); // a reasoning token every poll — never silent
      t.fireAll();
      polls += 1;
      await flush();
    }
    const out = await p;
    expect(out.timedOut).toBe(true);
    expect(clock).toBeGreaterThan(2 * W); // gave up just past 2 × the window (30 min by default)…
    expect(clock).toBeLessThanOrEqual(2 * W + 30_000); // …not hours later
  });

  it('the late-findings straggler wait is 6 × COUNCIL_STALL_MS (60 min by default)', () => {
    expect(councilLateStragglerWaitMs()).toBe(3_600_000);
    expect(councilLateStragglerWaitMs(120_000)).toBe(720_000);
  });

  function holderWith(over: Record<string, any> = {}) {
    const created: any[] = [];
    const prisma: any = {
      crossModelMessage: { create: jest.fn(async (q: any) => { created.push(q.data); return { id: `add-${created.length}` }; }) },
      crossModelChat: { update: jest.fn(async () => ({})) },
    };
    const recordMetric = jest.fn();
    const h = armLateCouncilAddendum({ chatId: 'c1', sessionId: 's1', graceMs: 0, prisma, recordMetric, ...over });
    return { h, created, recordMetric };
  }

  it('a finding already IN HAND is posted after the grace — never held for a slower (or hung) straggler', async () => {
    const t = manualTimer();
    const { h, created, recordMetric } = holderWith({ timer: t.timer });
    h.enable();
    h.note('the Double Checker', 'IN-HAND finding the lead never read');
    const slow = defer();
    h.track(slow.promise.then((x) => { h.note('the Triple Checker', x); return x; }));
    h.bind('row-1', { models: {}, modelLabels: {}, mode: 'deep_research' });
    const settled = h.settle();
    await flush();
    expect(created).toHaveLength(1); // posted at once, while the straggler is still running
    expect(created[0].content).toContain('IN-HAND finding');
    expect(created[0].metadata.council).toEqual(expect.objectContaining({ reports: 1 }));
    expect(created[0].metadata.council.part).toBeUndefined(); // the first row keeps today's metadata shape
    // the straggler lands later: its finding is ONE more follow-up row, immediately
    slow.resolve('LATER finding from the straggler');
    await flush();
    expect(created).toHaveLength(2);
    expect(created[1].content).toContain('LATER finding from the straggler');
    expect(created[1].content).not.toContain('IN-HAND finding');
    expect(created[1].metadata).toMatchObject({ kind: 'council_addendum', addendumFor: 'row-1', council: { reports: 1, part: 2 } });
    expect(recordMetric).toHaveBeenLastCalledWith(expect.objectContaining({ meta: expect.objectContaining({ reports: 1, part: 2 }) }));
    await settled;
    expect(t.liveCount()).toBe(0); // the straggler bound is cleared once every straggler landed
  });

  it('a straggler that never lands: settle() still ends at the bound, the in-hand finding already posted', async () => {
    const t = manualTimer();
    const { h, created } = holderWith({ timer: t.timer, stragglerWaitMs: 3_600_000 });
    h.enable();
    h.note('the Double Checker', 'IN-HAND finding');
    h.track(new Promise(() => {})); // hung forever
    h.bind('row-2', { models: {}, modelLabels: {}, mode: 'deep_research' });
    let done = false;
    const settled = h.settle().then(() => { done = true; });
    await flush();
    expect(created).toHaveLength(1);
    expect(done).toBe(false);
    expect(t.armed).toContain(3_600_000);
    t.fireAll(); // the bound expires
    await settled;
    expect(done).toBe(true);
    expect(created).toHaveLength(1);
  });
});

describe('chat-agent.service.ts wiring (source pins)', () => {
  const svc = readFileSync(join(__dirname, 'chat-agent.service.ts'), 'utf8');

  it('council profiles drop the final-turn deadline and carry the stream stall watchdog under no-wall-clock', () => {
    expect(svc).toContain('runDeadlineMs: unclocked ? undefined :');
    expect(svc).toContain('...(unclocked ? { streamStallMs: councilStallMs() } : {}),');
    expect(svc).toContain('maxSteps: kind === \'lead\' ? 24 : kind === \'colleague\' ? 16 : 8,'); // the step caps stay
  });

  it('no rung rail, no colleague fit, no per-attempt fit, no council deadline under no-wall-clock', () => {
    expect(svc).toContain('const rungDeadlineArmed = !researchUnclocked && researchRungBudgeted');
    expect(svc).toContain('const presetAttemptFit = !researchUnclocked && !rungDeadlineArmed');
    expect(svc).toMatch(/const councilDeadlineFor = \(kind[^\n]*\n\s+if \(researchUnclocked\) return undefined;/);
  });

  it('the dispatch waits on progress, tracks stragglers, and the lead\'s drain marks late notes delivered', () => {
    expect(svc).toContain('const stallWait = researchUnclocked ? { ms: councilDispatchStallMs(), idleMs: () => seatIdleMs(seatProgress, Date.now(), COUNCIL_TOOL_IN_FLIGHT_GRACE_MS, reasoningOnlyMs) } : undefined;');
    expect(svc).toContain('const reasoningOnlyMs = councilReasoningOnlyMs();'); // review 2026-10-20: reasoning alone is bounded
    expect(svc).toContain('...(stallWait ? { stall: stallWait, onStraggler: (p: Promise<string>) => lateCouncil.track(p) } : {}),');
    expect(svc).toMatch(/if \(researchUnclocked\) lateCouncil\.markDelivered\(\);\n\s+return leadDrain\(\);/);
    expect(svc).toContain('if (councilDegraded || (researchUnclocked && dispatchRounds > 0)) lateCouncil.enable();');
    expect(svc).toContain('if (!stallWait || isLateCouncilFinding(text)) lateCouncil.note(persona,');
    // clone activity keeps its parent's seat alive
    expect(svc).toContain('...(opts?.onProgress ? { onProgress: opts.onProgress } : {})');
  });

  it('review 2026-10-20: reasoning events report as their own kind, a reasoning-only give-up is labelled, the holder is bounded', () => {
    expect(svc).toContain("type === 'subagent:reasoning' ? 'reasoning' : 'event');");
    expect(svc).toContain('const reasoningOnly = !!stallWait && seatIdleMs(seatProgress) <= stallWait.ms;');
    expect(svc).toContain('...(reasoningOnly ? { reasoningOnly: true } : {})');
    expect(svc).toContain('...(researchUnclocked ? { stragglerWaitMs: councilLateStragglerWaitMs() } : {})');
  });
});
