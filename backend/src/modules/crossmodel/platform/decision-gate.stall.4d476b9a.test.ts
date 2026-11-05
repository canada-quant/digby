/**
 * Ticket 4d476b9a (2026-10-21): "Decision-gate egress: recurring all_legs_failed bursts
 * (sub-second simultaneous timeouts on both backends)".
 *
 * Prod 16:58:25Z / 17:00:44Z: five asks, every one "TypeSafe Jev: timeout of 595–1499ms"
 * and then "DeepSeek logprob readout: timeout of 249–1417ms". The legs run in sequence
 * inside one deadline, so on a 1200 ms ask the readout should have started with about
 * 595 ms left. It started with 249–349 ms: Jev's timer fired 250–350 ms LATE, i.e. the
 * process's event loop was blocked. Live probes right after answered.
 *
 * Pinned here with an injected clock (Date.now), an injected event-loop meter and an injected
 * dispatch probe, no real timers: a stall-explained timeout re-asks the SAME leg once inside
 * the caller's deadline and the success is recorded (no all_legs_failed row); a real provider
 * error, a timeout on a free loop, or a deadline too short is NOT retried; an ask the stall
 * explains end to end keeps its all_legs_failed row with cause 'stall' but never advances the
 * streak alert; the egress case still alerts and says so;
 * DECISION_GATE_STALL_RECOVERY_DISABLED=1 restores the pre-change loop and rows byte for byte.
 *
 * Rounds 2–4 (reviews of each previous cut):
 *   - while a later servable leg could still answer in what is left, only a CONFIRMED stall buys a
 *     retry (round 4), bounded: the later legs keep their reserve (the readout ~1.1 s) plus the
 *     lateness the loop already showed, never more than half of what is left or the leg's own
 *     budget — so a hung first leg on a free loop (on time, or only cheaply late) leaves the later
 *     leg EXACTLY its pre-ticket budget; only when no later leg could answer in what is left (or
 *     none can be called) does the retry take the full residual on the cheap signal — the
 *     incident's own 1200 ms asks; a retry under the retried leg's own minimum is no retry;
 *   - the cheap lateness signal is ≥ 50 ms WIRE-late when measured (round 3); cause 'stall' (the
 *     streak / sweep exemption) needs CONFIRMED evidence: the loop meter saturated over the leg
 *     window, or the timer late past its wire-armed due time by max(200 ms, 25 % of the budget)
 *     (lateness measured from the dispatch probe, so a block BEFORE the request left the process
 *     never counts). A hung backend on a free loop counts and alerts as before.
 */

jest.mock('axios', () => ({ __esModule: true, default: { post: jest.fn() } }));
// The real logger boots env.ts, which process.exit()s a keyless jest.
jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock('./loop-metrics.service', () => ({
  LOOP_METRIC_KINDS: { DECISION_GATE: 'decision_gate' },
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
  recordLoopMetrics: jest.fn(),
}));
/** The Decision gate seat (round 4: 'deepseek-flash' gives the chain [DeepSeek readout, TypeSafe Jev]). */
let mockSeat = 'jev';
jest.mock('../model-endpoints/model-roles.service', () => ({
  resolveRoleModel: jest.fn(async () => mockSeat),
  resolveRoleFallback: jest.fn(async () => ''),
}));
jest.mock('../model-endpoints/model-endpoints.service', () => ({
  resolveRegistryModel: jest.fn(async () => null),
}));
const mockStoreGet = jest.fn(async (..._a: any[]): Promise<any> => null);
jest.mock('../memory/context-store', () => ({
  storeGet: (...a: any[]) => mockStoreGet(...a),
  storePut: jest.fn(async () => undefined),
}));

import axios from 'axios';
import logger from '../../../utils/logger';
import {
  DECISION_GATE_BACKEND_DOWN_KIND,
  clearDecisionAuthLatches,
  clearDecisionBackendCache,
  clearDecisionMemo,
  decide,
  legShareCap,
  setDecisionBackendDownAlerter,
  type DecisionBackendDownAlert,
  type DecisionPurpose,
  type DecisionQuestion,
} from './decision-gate';
import {
  DECISION_STALL_LATE_MS,
  DECISION_STALL_LEG_NEED,
  DECISION_STALL_RETRY_MIN_MS,
  allFailedCauseText,
  askWindowSaturated,
  classifyAllLegsFailed,
  decisionStallRecoveryDisabled,
  isStallExemptAllFailedRow,
  isStallRetryLegError,
  laterLegsReserveMs,
  legFailureOf,
  legStallConfirmedUnderAsk,
  legTiming,
  setDecisionDispatchProbe,
  setDecisionLoopMeter,
  stallConfirmLateMs,
  stallConfirms,
  stallExplains,
  stallRetryDeadline,
  type DecisionLegKind,
  type LoopBusy,
  type StallRetryInput,
} from './decision-gate-stall';

const post = (axios as any).post as jest.Mock;
const mockRecordLoopMetric = jest.fn();
const ENV_KEYS = ['DECISION_GATE_DISABLED', 'DECISION_GATE_DEFAULT_MODE', 'DECISION_GATE_LEG_TIMEOUT_MS', 'DECISION_GATE_STALL_RECOVERY_DISABLED',
  'TYPESAFE_API_KEY', 'TYPESAFE_BASE_URL', 'TYPESAFE_MODEL', 'DEEPSEEK_API_KEY'];
const saved: Record<string, string | undefined> = {};
const Q: Record<string, DecisionQuestion> = { needs_turn: { type: 'noul', instructions: 'Does the lane need a turn now?' } };
const JEV_OK = { data: { model: 'jev-1.13.0', answers: { needs_turn: { noul: 0.9 } }, usage: { input_tokens: 12 } } };
const READOUT_OK = { data: { choices: [{ logprobs: { content: [{ token: 'B', logprob: Math.log(0.8), top_logprobs: [{ token: 'B', logprob: Math.log(0.8) }, { token: 'A', logprob: Math.log(0.2) }] }] } }], usage: { prompt_tokens: 10 } } };

// ── the injected clock + meter ───────────────────────────────────────────────
let clock = 0;
let nowSpy: jest.SpyInstance<number, []> | null = null;
let busy: LoopBusy | null = { activeMs: 0, utilization: 0 };
/** How long after a leg's first post the loop got back to it (the dispatch probe) — 0 = the request left at once. */
let dispatchLag = 0;
const probe = jest.fn((issuedAt: number) => ({ at: issuedAt + dispatchLag }));
const alerts: DecisionBackendDownAlert[] = [];

type Step = (url: string, body: any, cfg: any) => Promise<any>;
const timeoutErr = (ms: number) => Object.assign(new Error(`timeout of ${ms}ms exceeded`), { code: 'ECONNABORTED' });
/** The leg's timer fires `lagMs` after its own deadline (the event loop could not run it sooner) — the clock moves there. */
const timesOut = (lagMs: number): Step => async (_u, _b, cfg) => { clock += Number(cfg.timeout) + lagMs; throw timeoutErr(Number(cfg.timeout)); };
const answers = (ms: number, body: any): Step => async () => { clock += ms; return body; };
const httpFails = (status: number, ms = 20): Step => async () => { clock += ms; throw Object.assign(new Error(`Request failed with status code ${status}`), { response: { status } }); };
const isJev = (url: string) => String(url).endsWith('/systemone');
/** Script the next posts per backend; an unscripted post fails the test loudly. */
function script(jev: Step[], readout: Step[]): void {
  const j = [...jev];
  const r = [...readout];
  post.mockImplementation(async (url: string, body: any, cfg: any) => {
    const step = (isJev(url) ? j : r).shift();
    if (!step) throw new Error(`unscripted post to ${url}`);
    return step(url, body, cfg);
  });
}
const rows = () => mockRecordLoopMetric.mock.calls.map((c) => c[0]);
const decisionRows = () => rows().filter((r) => r.kind === 'decision_gate' && r.meta?.phase === 'decision').map((r) => r.meta);
const downRows = () => rows().filter((r) => r.kind === DECISION_GATE_BACKEND_DOWN_KIND).map((r) => r.meta);
const jevPosts = () => post.mock.calls.filter((c) => isJev(c[0]));
const readoutPosts = () => post.mock.calls.filter((c) => !isJev(c[0]));
const tick = () => new Promise((r) => setImmediate(r));
const ask = (purpose: DecisionPurpose, timeoutMs: number, i = 0) => decide({ lane: 'x', i }, Q, { purpose, timeoutMs, memo: false, challengers: false });
/** A reply that HONOURS its axios timeout: it answers in `ms` when that fits, else its timer fires `lagMs` late. */
const replyIn = (ms: number, body: any, lagMs = 0): Step => async (_u, _b, cfg) => {
  const to = Number(cfg.timeout);
  if (ms <= to) { clock += ms; return body; }
  clock += to + lagMs;
  throw timeoutErr(to);
};
/** Three asks of one shape; what the rows and the alerter saw. */
async function run3(purpose: DecisionPurpose, timeoutMs: number, jev: () => Step[], readout: () => Step[]) {
  const results: Array<string | null> = [];
  for (let i = 0; i < 3; i++) {
    script(jev(), readout());
    const t0 = clock;
    const r = await ask(purpose, timeoutMs, i);
    expect(clock - t0).toBeLessThanOrEqual(timeoutMs);
    results.push(r ? r.backend : null);
  }
  await tick();
  return {
    results,
    jevTimeouts: jevPosts().map((c) => c[2].timeout),
    readoutTimeouts: readoutPosts().map((c) => c[2].timeout),
    allFailed: downRows().filter((m) => m.event === 'all_legs_failed'),
    alerts: alerts.slice(),
  };
}
/** run3 from a clean slate (posts, rows, alerts, latches + the streak), with the kill switch set or not — the switch
 *  run is the PRE-TICKET leg loop, so its budgets are the ones a later leg must keep. */
async function run3Under(switchOff: boolean, ...a: Parameters<typeof run3>) {
  post.mockReset();
  mockRecordLoopMetric.mockReset();
  alerts.length = 0;
  clearDecisionAuthLatches();
  clearDecisionBackendCache();
  if (switchOff) process.env.DECISION_GATE_STALL_RECOVERY_DISABLED = '1';
  else delete process.env.DECISION_GATE_STALL_RECOVERY_DISABLED;
  try { return await run3(...a); } finally { delete process.env.DECISION_GATE_STALL_RECOVERY_DISABLED; }
}

beforeEach(() => {
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  process.env.DECISION_GATE_DEFAULT_MODE = 'shadow';
  process.env.TYPESAFE_API_KEY = 'k';
  process.env.DEEPSEEK_API_KEY = 'd';
  post.mockReset();
  mockRecordLoopMetric.mockReset();
  mockStoreGet.mockReset();
  mockStoreGet.mockResolvedValue(null);
  alerts.length = 0;
  setDecisionBackendDownAlerter(async (a) => { alerts.push(a); });
  clearDecisionBackendCache();
  clearDecisionAuthLatches();
  clearDecisionMemo();
  clock = 1_792_000_000_000;
  nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => clock);
  busy = { activeMs: 0, utilization: 0 };
  setDecisionLoopMeter({ mark: () => 'mark', since: () => busy });
  dispatchLag = 0;
  probe.mockClear();
  setDecisionDispatchProbe(probe);
  mockSeat = 'jev';
});
afterEach(() => {
  nowSpy?.mockRestore();
  nowSpy = null;
  setDecisionLoopMeter(null);
  setDecisionDispatchProbe(null);
  setDecisionBackendDownAlerter(null);
  clearDecisionAuthLatches();
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

describe('decide() — a stall-explained timeout is retried once on the same leg (ticket 4d476b9a)', () => {
  it('the prod burst: the two 1200 ms asks whose Jev timer fired 300 / 170 ms late retry Jev ONCE inside their own deadline and answer; the 3000 ms ask (80 ms late — unconfirmed, and the readout can answer in what is left) falls through to the readout with exactly its pre-ticket budget — no all_legs_failed row, no alert', async () => {
    const shapes: Array<[DecisionPurpose, number, number]> = [['turn_plan', 1200, 300], ['task_kind', 1200, 170], ['memory_extract', 3000, 80]];
    for (const [i, [purpose, timeoutMs, late]] of shapes.entries()) {
      script([timesOut(late), answers(150, JEV_OK)], [answers(700, READOUT_OK)]);
      const t0 = clock;
      const r = await ask(purpose, timeoutMs, i);
      expect(r).not.toBeNull();
      expect(r!.backend).toBe(i < 2 ? 'TypeSafe Jev' : 'DeepSeek logprob readout');
      // Never past the caller's own deadline.
      expect(clock - t0).toBeLessThanOrEqual(timeoutMs);
    }
    await tick();
    // The 1200 ms asks: Jev's share 600; 300 / 430 ms left after the late timer — under the readout's 500 ms minimum, so it
    // could not answer in it anyway and the retry takes the whole residual (the cheap signal is enough there).
    // The 3000 ms ask: share 1500, 1420 left — the readout could answer in it and 80 ms on 1500 is under the 375 ms
    // confirm bar, so no retry (round 4): the readout gets the 1420 ms the pre-ticket loop gave it.
    expect(jevPosts().map((c) => c[2].timeout)).toEqual([600, 300, 600, 430, 1500]);
    expect(readoutPosts().map((c) => c[2].timeout)).toEqual([1420]);
    // Success recorded: answering rows with the stall attribution, no fall-through, no failure row.
    const d = decisionRows();
    expect(d).toHaveLength(3);
    for (const row of d.slice(0, 2)) {
      expect(row).toMatchObject({ ok: true, backend: 'TypeSafe Jev', stall: { retried: true, recovered: true } });
      expect(row.legErrors).toBeUndefined();
      expect(row.legIndex).toBeUndefined();
    }
    expect(d[0].stall.legs).toEqual([expect.objectContaining({ backend: 'TypeSafe Jev', attempt: 1, failure: 'timeout', lateMs: 300, stall: true })]);
    expect(d[1].stall.legs).toEqual([expect.objectContaining({ backend: 'TypeSafe Jev', attempt: 1, failure: 'timeout', lateMs: 170, stall: true })]);
    expect(d[0].stall.legs[0]).toMatchObject({ budgetMs: 600, elapsedMs: 900, dispatchLagMs: 0, wireLateMs: 300, stallConfirmed: true });
    // 170 ms on 600 is under the 200 ms confirm bar: the full-residual retry stands, the verdict says so.
    expect(d[1].stall.legs[0]).toMatchObject({ stallConfirmed: false });
    // The 3000 ms ask: an ordinary fall-through row (no retry, so no meta.stall); the leg error says the timer was late.
    expect(d[2]).toMatchObject({ ok: true, backend: 'DeepSeek logprob readout', legIndex: 1 });
    expect(d[2].stall).toBeUndefined();
    expect(d[2].legErrors[0]).toContain('[timer 80 ms late');
    expect(downRows()).toEqual([]);
    expect(alerts).toEqual([]);
  });

  it('a timeout inside a SATURATED loop window is stall-explained even when the timer fired on time (the stall ended at the due time)', async () => {
    busy = { activeMs: 520, utilization: 0.87 };
    script([timesOut(0), answers(120, JEV_OK)], []);
    const r = await ask('auto_route', 4000);
    expect(r!.backend).toBe('TypeSafe Jev');
    expect(jevPosts()).toHaveLength(2);
    expect(readoutPosts()).toHaveLength(0);
    expect(decisionRows()[0].stall.legs[0]).toMatchObject({ lateMs: 0, busyMs: 520, busy: 0.87, stall: true, stallConfirmed: true });
    // Bounded retry: 2000 ms left after Jev's on-time 2000 ms timeout, the readout servable → 2000 − its 1100 reserve = 900.
    expect(jevPosts()[1][2].timeout).toBe(900);
  });

  it('a real provider error is NOT retried: Jev HTTP 500 then readout HTTP 502 ⇒ all_legs_failed, cause provider, counted toward the streak', async () => {
    script([httpFails(500)], [httpFails(502)]);
    expect(await ask('sweep_triage', 4000)).toBeNull();
    expect(jevPosts()).toHaveLength(1);
    expect(readoutPosts()).toHaveLength(1);
    expect(downRows()).toEqual([expect.objectContaining({ event: 'all_legs_failed', cause: 'provider', streak: 1, stallRetried: false })]);
    expect(downRows()[0].streakExempt).toBeUndefined();
  });

  it('a timeout on a FREE loop is not retried: it falls through to the readout as before', async () => {
    script([timesOut(2)], [answers(400, READOUT_OK)]);
    const r = await ask('auto_route', 1500);
    expect(r!.backend).toBe('DeepSeek logprob readout');
    expect(jevPosts()).toHaveLength(1);
    const row = decisionRows()[0];
    expect(row).toMatchObject({ ok: true, legIndex: 1, legErrors: [expect.stringContaining('TypeSafe Jev: timeout')] });
    expect(row.stall).toBeUndefined();
  });

  it('egress: every leg timed out on a free loop ⇒ cause egress; the streak counts and the 3rd ask alerts naming the cause', async () => {
    for (let i = 0; i < 3; i++) {
      script([timesOut(1)], [timesOut(1)]);
      expect(await ask('turn_plan', 1200, i)).toBeNull();
    }
    await tick();
    expect(downRows().map((m) => [m.event, m.cause, m.streak])).toEqual([['all_legs_failed', 'egress', 1], ['all_legs_failed', 'egress', 2], ['all_legs_failed', 'egress', 3]]);
    expect(downRows()[0].legTimings).toEqual([
      expect.objectContaining({ backend: 'TypeSafe Jev', failure: 'timeout', budgetMs: 600, lateMs: 1, stall: false, stallConfirmed: false }),
      expect.objectContaining({ backend: 'DeepSeek logprob readout', failure: 'timeout', lateMs: 1, stall: false, stallConfirmed: false }),
    ]);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ event: 'all_legs_failed', streak: 3, cause: 'egress' });
  });

  it('a stall that eats the retry too ⇒ all_legs_failed with cause stall: the row is kept, the streak is NOT advanced, no alert even after 4 such asks', async () => {
    for (let i = 0; i < 4; i++) {
      script([timesOut(300), timesOut(200)], []);
      expect(await ask('task_kind', 1200, i)).toBeNull();
    }
    await tick();
    expect(jevPosts()).toHaveLength(8); // one retry per ask, never more
    // 300 ms left: under the readout's 500 ms minimum, so the retry took the whole residual — and landed 200 ms late itself.
    expect(jevPosts()[1][2].timeout).toBe(300);
    expect(readoutPosts()).toHaveLength(0);
    const down = downRows();
    expect(down).toHaveLength(4);
    for (const m of down) {
      expect(m).toMatchObject({ event: 'all_legs_failed', cause: 'stall', streak: 0, streakExempt: 'stall', stallRetried: true });
      expect(m.legTimings.map((l: any) => [l.attempt, l.stall, l.stallConfirmed])).toEqual([[1, true, true], [2, true, true]]);
    }
    expect(alerts).toEqual([]);
    // The decision row carries the same verdict and names both attempts.
    expect(decisionRows()[0]).toMatchObject({ ok: false, stall: { cause: 'stall', retried: true } });
    expect(decisionRows()[0].legErrors).toEqual([expect.stringContaining('loop stall: 300 ms late'), expect.stringContaining('loop stall: 200 ms late'), 'deadline exhausted before the next leg']);
  });

  it('a stall-explained timeout with less than the retry floor left is not retried (the caller budget is never exceeded)', async () => {
    // 1200 ms ask: Jev's 600 ms timer lands 560 ms late → 40 ms left (< the 100 ms floor).
    script([timesOut(560)], []);
    expect(await ask('turn_plan', 1200)).toBeNull();
    expect(jevPosts()).toHaveLength(1);
    expect(readoutPosts()).toHaveLength(0);
    expect(downRows()[0]).toMatchObject({ cause: 'stall', stallRetried: false, streakExempt: 'stall' });
  });

  it('the stall retry runs at most ONCE per ask: the readout timing out late after a failed retry is not retried again', async () => {
    // 5000 ms ask: Jev 2000 → 600 ms late (a confirmed stall: bar 500) → retried with 2400 − the readout's 1100 reserve −
    // 600 = 700; the retry fails HTTP 503 in 30 ms; the readout gets the 2370 left and its timer lands 100 ms late.
    script([timesOut(600), httpFails(503, 30)], [timesOut(100)]);
    expect(await ask('checker_route', 5000)).toBeNull();
    expect(jevPosts()).toHaveLength(2);
    expect(jevPosts()[1][2].timeout).toBe(700);
    expect(readoutPosts()).toHaveLength(1);
    expect(readoutPosts()[0][2].timeout).toBe(2370);
    expect(downRows()[0]).toMatchObject({ cause: 'mixed', stallRetried: true });
    expect(downRows()[0].streakExempt).toBeUndefined();
  });

  it('a spec-pinned ask (the admin Test button) is never stall-retried', async () => {
    script([timesOut(300)], []);
    expect(await decide({ lane: 'x' }, Q, { purpose: 'probe', spec: 'jev', timeoutMs: 2000 })).toBeNull();
    expect(jevPosts()).toHaveLength(1);
  });

  it('kill switch DECISION_GATE_STALL_RECOVERY_DISABLED=1 restores today byte for byte: no retry, the readout gets the residual, the rows carry no attribution and the streak counts', async () => {
    process.env.DECISION_GATE_STALL_RECOVERY_DISABLED = '1';
    for (let i = 0; i < 3; i++) {
      script([timesOut(300)], [timesOut(0)]);
      expect(await ask('turn_plan', 1200, i)).toBeNull();
    }
    await tick();
    expect(jevPosts()).toHaveLength(3);
    expect(readoutPosts()).toHaveLength(3);
    // The readout started with only the 300 ms the stall left (the prod shape).
    expect(readoutPosts()[0][2].timeout).toBe(300);
    const legErrors = ['TypeSafe Jev: timeout timeout of 600ms exceeded', 'DeepSeek logprob readout: timeout timeout of 300ms exceeded'];
    expect(downRows()).toEqual([
      { event: 'all_legs_failed', purpose: 'turn_plan', legErrors, streak: 1 },
      { event: 'all_legs_failed', purpose: 'turn_plan', legErrors, streak: 2 },
      { event: 'all_legs_failed', purpose: 'turn_plan', legErrors, streak: 3 },
    ]);
    expect(decisionRows()[0].stall).toBeUndefined();
    expect(decisionRows()[0].legErrors).toEqual(legErrors);
    expect(alerts).toEqual([{ event: 'all_legs_failed', purpose: 'turn_plan', at: expect.any(String), legErrors, streak: 3 }]);
    // Round 2: no dispatch probe is scheduled under the switch either.
    expect(probe).not.toHaveBeenCalled();
  });
});

describe('decide() — round 2: a bounded stall retry leaves a later servable leg its reserve; the full residual only when nothing later can use it (review of 4d476b9a)', () => {
  it('a first-leg (Jev) CONFIRMED stall (the loop meter saturated) with a healthy readout: the bounded retry leaves the readout its reserve and the readout still answers — no all_legs_failed row, no alert (4000 ms ask, timer 60 ms late twice)', async () => {
    busy = { activeMs: 1800, utilization: 0.9 };
    for (let i = 0; i < 3; i++) {
      script([timesOut(60), timesOut(60)], [answers(700, READOUT_OK)]);
      const t0 = clock;
      const r = await ask('sweep_triage', 4000, i);
      expect(r).not.toBeNull();
      expect(r!.backend).toBe('DeepSeek logprob readout');
      expect(clock - t0).toBeLessThanOrEqual(4000);
    }
    await tick();
    // Jev 2000 → 60 ms late → 1940 left: the retry gets 1940 − the readout's 1100 reserve − the 60 ms lateness = 780.
    expect(jevPosts().map((c) => c[2].timeout)).toEqual([2000, 780, 2000, 780, 2000, 780]);
    // The retry landed 60 ms late too → 1100 left for the readout (the last leg), which answers in 700.
    expect(readoutPosts().map((c) => c[2].timeout)).toEqual([1100, 1100, 1100]);
    const d = decisionRows();
    expect(d).toHaveLength(3);
    for (const row of d) {
      expect(row).toMatchObject({ ok: true, backend: 'DeepSeek logprob readout', legIndex: 1, stall: { retried: true, recovered: false } });
      expect(row.legErrors).toHaveLength(2);
      expect(row.legErrors[1]).toContain('stall retry');
    }
    expect(downRows()).toEqual([]);
    expect(alerts).toEqual([]);
  });

  it('the same CONFIRMED shape on the 3000 ms memory_extract ask, the retry timer on time: the readout keeps 1160 ms and answers', async () => {
    busy = { activeMs: 1300, utilization: 0.88 };
    script([timesOut(60), timesOut(0)], [answers(650, READOUT_OK)]);
    const r = await ask('memory_extract', 3000);
    expect(r!.backend).toBe('DeepSeek logprob readout');
    expect(jevPosts().map((c) => c[2].timeout)).toEqual([1500, 280]);
    expect(readoutPosts().map((c) => c[2].timeout)).toEqual([1160]);
    expect(downRows()).toEqual([]);
  });

  it('what is left is under the readout\'s minimum (1200 ms ask, Jev 450 ms late → 150 left): the readout could not answer in it, so the retry takes all of it — a retry that times out on time is not a confirmed stall, so the row counts', async () => {
    script([timesOut(450), timesOut(0)], []);
    expect(await ask('turn_plan', 1200)).toBeNull();
    expect(jevPosts().map((c) => c[2].timeout)).toEqual([600, 150]);
    expect(readoutPosts()).toHaveLength(0);
    expect(downRows()[0]).toMatchObject({ stallRetried: true, cause: 'mixed', streak: 1 });
    expect(downRows()[0].legTimings.map((l: any) => [l.attempt, l.stallConfirmed])).toEqual([[1, true], [2, false]]);
  });

  it('the LAST servable leg\'s retry takes the full residual: with the readout latched (HTTP 403), a late Jev timeout is re-asked with everything that is left and answers', async () => {
    // Ask 1 latches the readout (403) — Jev's HTTP 500 is a provider error, never retried.
    script([httpFails(500)], [httpFails(403)]);
    expect(await ask('turn_plan', 1200, 0)).toBeNull();
    post.mockClear();
    mockRecordLoopMetric.mockClear();
    alerts.length = 0;
    // Ask 2: Jev's 600 ms timer lands 300 ms late; the only later leg is latched → the retry may take all 300 ms.
    script([timesOut(300), answers(150, JEV_OK)], []);
    const r = await ask('turn_plan', 1200, 1);
    expect(r!.backend).toBe('TypeSafe Jev');
    expect(jevPosts().map((c) => c[2].timeout)).toEqual([600, 300]);
    expect(readoutPosts()).toHaveLength(0);
    expect(decisionRows()[0]).toMatchObject({ ok: true, stall: { retried: true, recovered: true } });
    expect(downRows().filter((m) => m.event === 'all_legs_failed')).toEqual([]);
  });
});

describe('decide() — round 2: the streak / sweep exemption needs CONFIRMED stall evidence (review of 4d476b9a)', () => {
  it('a HUNG backend on a free loop (every timer 60 ms late, the loop idle): no retry (round 4 — the readout could answer in what is left), cause egress — counted, and the 3rd ask alerts as before', async () => {
    for (let i = 0; i < 3; i++) {
      script([timesOut(60)], [timesOut(60)]);
      expect(await ask('sweep_triage', 4000, i)).toBeNull();
    }
    await tick();
    expect(jevPosts()).toHaveLength(3); // the cheap lateness signal buys no bounded retry
    expect(readoutPosts().map((c) => c[2].timeout)).toEqual([1940, 1940, 1940]); // the pre-ticket budget
    const down = downRows();
    expect(down.map((m) => [m.event, m.cause, m.streak, m.streakExempt, m.stallRetried])).toEqual([
      ['all_legs_failed', 'egress', 1, undefined, false],
      ['all_legs_failed', 'egress', 2, undefined, false],
      ['all_legs_failed', 'egress', 3, undefined, false],
    ]);
    expect(down[0].legTimings.map((l: any) => [l.attempt, l.stall, l.stallConfirmed])).toEqual([[1, true, false], [1, true, false]]);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ event: 'all_legs_failed', streak: 3, cause: 'egress' });
    // The leg error says the timer was late but does not call it a loop stall.
    expect(decisionRows()[0].legErrors[0]).toContain('[timer 60 ms late');
    expect(decisionRows()[0].legErrors[0]).toContain('not a confirmed loop stall');
    expect(decisionRows()[0].legErrors[0]).not.toContain('[loop stall');
    expect(decisionRows()[0].legErrors.some((e: string) => isStallRetryLegError(e))).toBe(false);
  });

  it('lateness from a block BEFORE the request left the process is not a stall: 320 ms late on a 600 ms leg, but 300 of it before dispatch ⇒ no retry (round 3), counted (egress), alert on the 3rd ask', async () => {
    dispatchLag = 300;
    for (let i = 0; i < 3; i++) {
      script([timesOut(320)], [timesOut(0)]);
      expect(await ask('turn_plan', 1200, i)).toBeNull();
    }
    await tick();
    expect(jevPosts()).toHaveLength(3);
    expect(readoutPosts().map((c) => c[2].timeout)).toEqual([280, 280, 280]);
    const down = downRows();
    expect(down.map((m) => [m.cause, m.streak, m.stallRetried])).toEqual([['egress', 1, false], ['egress', 2, false], ['egress', 3, false]]);
    expect(down[0].legTimings[0]).toMatchObject({ attempt: 1, lateMs: 320, dispatchLagMs: 300, wireLateMs: 20, stall: false, stallConfirmed: false });
    expect(alerts).toEqual([expect.objectContaining({ event: 'all_legs_failed', streak: 3, cause: 'egress' })]);
  });

  it('a CONFIRMED stall is exempt: a timer late past max(200 ms, 25 % of the budget) from dispatch on every leg ⇒ cause stall, no streak, no alert after 4 asks', async () => {
    for (let i = 0; i < 4; i++) {
      // 5000 ms ask: Jev 2000 → 600 ms late (bar 500) → 2400 left → retry 2400 − 1100 − 600 = 700 → 400 ms late (bar
      // 200) → 1300 left → the readout's 1300 ms timer → 350 ms late (bar 325). Every leg is late past its own bar.
      script([timesOut(600), timesOut(400)], [timesOut(350)]);
      expect(await ask('checker_route', 5000, i)).toBeNull();
    }
    await tick();
    const down = downRows();
    expect(down).toHaveLength(4);
    for (const m of down) {
      expect(m).toMatchObject({ cause: 'stall', streak: 0, streakExempt: 'stall' });
      expect(m.legTimings.map((l: any) => [l.attempt, l.budgetMs, l.wireLateMs, l.stallConfirmed])).toEqual([[1, 2000, 600, true], [2, 700, 400, true], [1, 1300, 350, true]]);
    }
    expect(alerts).toEqual([]);
    expect(decisionRows()[0].legErrors[0]).toContain('[loop stall: 600 ms late');

    // One leg that is only cheaply late (60 ms on its 1300 ms readout timer) next to confirmed ones ⇒ mixed ⇒ counted.
    script([timesOut(600), timesOut(400)], [timesOut(60)]);
    expect(await ask('checker_route', 5000, 9)).toBeNull();
    expect(downRows()[4]).toMatchObject({ cause: 'mixed', streak: 1 });
    expect(downRows()[4].streakExempt).toBeUndefined();
  });

  it('a CONFIRMED stall by the loop meter: a saturated leg window (90 % busy, 1.8 s active) exempts on-time timeouts too', async () => {
    busy = { activeMs: 1800, utilization: 0.9 };
    for (let i = 0; i < 3; i++) {
      script([timesOut(0), timesOut(0)], [timesOut(0)]);
      expect(await ask('sweep_triage', 4000, i)).toBeNull();
    }
    await tick();
    expect(downRows().map((m) => [m.cause, m.streak])).toEqual([['stall', 0], ['stall', 0], ['stall', 0]]);
    expect(alerts).toEqual([]);
  });
});

describe('decide() — round 3: the later legs keep their USEFUL share; the full residual only when they could not answer in it (review of 4d476b9a round 2)', () => {
  // Round 4: a bounded retry needs a CONFIRMED stall, so these shapes run in a saturated loop window (the unconfirmed
  // 60 ms-late shapes take no retry at all — the round-4 block below pins the pre-ticket budgets).
  for (const [purpose, timeoutMs, jevRetry, readoutGets] of [['sweep_triage', 4000, 780, 1100], ['memory_extract', 3000, 280, 1100]] as Array<[DecisionPurpose, number, number, number]>) {
    for (const readoutMs of [680, 800, 900, 1067, 1100]) {
      it(`a HUNG Jev in a CONFIRMED stall (saturated loop; timer 60 ms late on both attempts) with the readout healthy at ${readoutMs} ms: the bounded retry leaves the readout its reserve and it still answers a ${timeoutMs} ms ${purpose} ask — no all_legs_failed row, no alert`, async () => {
        busy = { activeMs: 1800, utilization: 0.9 };
        const out = await run3(purpose, timeoutMs, () => [replyIn(99_999, JEV_OK, 60), replyIn(99_999, JEV_OK, 60)], () => [replyIn(readoutMs, READOUT_OK)]);
        expect(out.results).toEqual(['DeepSeek logprob readout', 'DeepSeek logprob readout', 'DeepSeek logprob readout']);
        // The retry is bounded by the readout's useful latency (1100 ms) plus the lateness the loop already showed (60 ms).
        const share = timeoutMs / 2;
        expect(out.jevTimeouts).toEqual([share, jevRetry, share, jevRetry, share, jevRetry]);
        expect(out.readoutTimeouts).toEqual([readoutGets, readoutGets, readoutGets]);
        expect(out.allFailed).toEqual([]);
        expect(alerts).toEqual([]);
      });
    }
  }

  for (const [jevLate, jevMs] of [[300, 164], [300, 221], [300, 265], [170, 164], [170, 221]]) {
    it(`the incident's own 1200 ms ask: Jev's timer ${jevLate} ms late, Jev healthy at ${jevMs} ms — the readout could not answer in what is left, so the retry takes the FULL residual and answers`, async () => {
      const out = await run3('turn_plan', 1200, () => [replyIn(99_999, JEV_OK, jevLate), replyIn(jevMs, JEV_OK)], () => [replyIn(750, READOUT_OK)]);
      expect(out.results).toEqual(['TypeSafe Jev', 'TypeSafe Jev', 'TypeSafe Jev']);
      const left = 600 - jevLate;
      expect(out.jevTimeouts).toEqual([600, left, 600, left, 600, left]);
      expect(out.readoutTimeouts).toEqual([]);
      expect(out.allFailed).toEqual([]);
      expect(alerts).toEqual([]);
      expect(decisionRows()[0]).toMatchObject({ ok: true, stall: { retried: true, recovered: true } });
    });
  }

  it('a 2000 ms ask with a hung Jev (60 ms late): the readout can answer in what is left (940) and the timeout is unconfirmed — no retry, the readout keeps its pre-change share and answers', async () => {
    const out = await run3('compute_policy', 2000, () => [replyIn(99_999, JEV_OK, 60)], () => [replyIn(900, READOUT_OK)]);
    expect(out.results).toEqual(['DeepSeek logprob readout', 'DeepSeek logprob readout', 'DeepSeek logprob readout']);
    expect(out.jevTimeouts).toEqual([1000, 1000, 1000]);
    expect(out.readoutTimeouts).toEqual([940, 940, 940]);
    expect(out.allFailed).toEqual([]);
    expect(decisionRows()[0].stall).toBeUndefined();
  });

  it("a 130 ms-late (unconfirmed) Jev timeout on a 3000 ms ask is no retry: the readout gets everything that is left", async () => {
    // 3000 ms ask: Jev 1500 → 130 ms late → 1370 left: the readout could answer in it and 130 < the 375 ms confirm bar.
    script([replyIn(99_999, JEV_OK, 130)], [replyIn(900, READOUT_OK)]);
    const r = await ask('memory_extract', 3000);
    expect(r!.backend).toBe('DeepSeek logprob readout');
    expect(jevPosts().map((c) => c[2].timeout)).toEqual([1500]);
    expect(readoutPosts().map((c) => c[2].timeout)).toEqual([1370]);
  });

  it('lateness from a block BEFORE dispatch does not buy the retry (the backend had its full wire budget): 85 ms late, 80 of it before the request left — no retry, the readout keeps its share and answers', async () => {
    dispatchLag = 80;
    const out = await run3('sweep_triage', 4000, () => [replyIn(99_999, JEV_OK, 85)], () => [replyIn(1100, READOUT_OK)]);
    expect(out.results).toEqual(['DeepSeek logprob readout', 'DeepSeek logprob readout', 'DeepSeek logprob readout']);
    expect(out.jevTimeouts).toEqual([2000, 2000, 2000]);
    expect(out.readoutTimeouts).toEqual([1915, 1915, 1915]);
    expect(decisionRows()[0].stall).toBeUndefined();
    expect(decisionRows()[0].legErrors[0]).not.toContain('ms late');
    expect(out.allFailed).toEqual([]);
  });

  it('a re-post inside a leg (the 429 re-ask) is measured from ITS OWN dispatch: a block between the re-post and its socket event never confirms a stall', async () => {
    // Jev's first post 429s; callSystemOne re-posts (after its 400 ms backoff) and that re-post's timer lands 600 ms
    // late, 580 of it before the re-post left the process. Measured from the FIRST post that would read 600 ms
    // wire-late (≥ the 500 ms bar on the 2000 ms budget) — a confirmed stall that never was.
    probe.mockImplementationOnce((issuedAt: number) => ({ at: issuedAt }));
    probe.mockImplementationOnce((issuedAt: number) => ({ at: issuedAt + 580 }));
    script([httpFails(429), replyIn(99_999, JEV_OK, 600)], [replyIn(700, READOUT_OK)]);
    const r = await ask('sweep_triage', 4000);
    expect(r!.backend).toBe('DeepSeek logprob readout');
    expect(jevPosts()).toHaveLength(2); // the 429 and its re-post — no stall retry
    expect(probe).toHaveBeenCalledTimes(3); // every post is marked (Jev ×2, the readout ×1)
    expect(decisionRows()[0].stall).toBeUndefined();
    expect(decisionRows()[0].legErrors[0]).not.toContain('loop stall');
  });

  it('the recovery log line tells a CONFIRMED stall from a merely late timer', async () => {
    const info = (logger as any).info as jest.Mock;
    // Past the 5-min throttle of earlier tests.
    clock += 3_600_000;
    info.mockClear();
    // 1200 ms ask, Jev 170 ms late (cheap signal only; 430 ms left — under the readout's minimum), the full-residual retry answers.
    script([replyIn(99_999, JEV_OK, 170), replyIn(150, JEV_OK)], []);
    expect((await ask('task_kind', 1200))!.backend).toBe('TypeSafe Jev');
    const cheap = info.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('retried once and answered'));
    expect(cheap).toHaveLength(1);
    expect(cheap[0]).toContain('timer 170 ms late');
    expect(cheap[0]).not.toContain('event-loop stall');
    // A confirmed stall (the 1200 ms incident: 300 ms late on a 600 ms budget), past the throttle again.
    clock += 3_600_000;
    info.mockClear();
    script([replyIn(99_999, JEV_OK, 300), replyIn(150, JEV_OK)], []);
    expect((await ask('turn_plan', 1200))!.backend).toBe('TypeSafe Jev');
    const confirmed = info.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('retried once and answered'));
    expect(confirmed).toHaveLength(1);
    expect(confirmed[0]).toContain('event-loop stall, not the backend');
  });
});

describe('decide() — round 4: a bounded retry needs a CONFIRMED stall; no retry shorter than its own leg can use (review of 4d476b9a round 3)', () => {
  // A hung Jev whose timer fired only cheaply late (60 / 120 ms — not a confirmed stall: the bar is max(200 ms, 25 % of
  // the budget)) on an otherwise free loop, with the readout healthy at latencies up to its slow tail. Round 3's fixed
  // 1100 ms readout reserve cut the readout from 1940 to 1100 ms (4000 ms ask) and 1440 to 1100 ms (3000 ms ask), so its
  // 1.15–1.9 s replies failed. The later leg must keep EXACTLY the budget the pre-ticket loop gave it — measured here by
  // running the same asks under DECISION_GATE_STALL_RECOVERY_DISABLED=1.
  const shapes: Array<[DecisionPurpose, number, number, number[], number[]]> = [
    // purpose, ask ms, the readout's pre-ticket budget at 60 ms late, the lateness values, the readout latencies
    ['turn_plan', 1200, 540, [60], [500, 540]],
    ['memory_extract', 3000, 1440, [60, 120], [900, 1150, 1300, 1440 - 120]],
    ['sweep_triage', 4000, 1940, [60, 120], [900, 1150, 1300, 1600, 1940 - 120]],
  ];
  for (const [purpose, timeoutMs, preBudget, lates, readoutLatencies] of shapes) {
    for (const late of lates) {
      for (const readoutMs of readoutLatencies) {
        it(`${timeoutMs} ms ${purpose} ask, a HUNG Jev whose timer fired ${late} ms late (unconfirmed), the readout at ${readoutMs} ms: no Jev retry, the readout keeps exactly its pre-ticket budget and answers — no all_legs_failed row, no alert`, async () => {
          const jev = () => [replyIn(99_999, JEV_OK, late), replyIn(99_999, JEV_OK, late)];
          const readout = () => [replyIn(readoutMs, READOUT_OK)];
          const pre = await run3Under(true, purpose, timeoutMs, jev, readout);
          const out = await run3Under(false, purpose, timeoutMs, jev, readout);
          const budget = preBudget + 60 - late;
          expect(pre.readoutTimeouts).toEqual([budget, budget, budget]);
          expect(out.readoutTimeouts).toEqual(pre.readoutTimeouts);
          expect(out.jevTimeouts).toEqual(pre.jevTimeouts); // one Jev post per ask: no stall retry
          expect(out.jevTimeouts).toHaveLength(3);
          expect(out.results).toEqual(['DeepSeek logprob readout', 'DeepSeek logprob readout', 'DeepSeek logprob readout']);
          expect(out.allFailed).toEqual([]);
          expect(out.alerts).toEqual([]);
          // The row says the timer was late without calling it a stall, and carries no retry.
          expect(decisionRows()[0].stall).toBeUndefined();
          expect(decisionRows()[0].legErrors[0]).toContain(`[timer ${late} ms late`);
          expect(decisionRows()[0].legErrors[0]).toMatch(/not a confirmed loop stall\]$/);
        });
      }
    }
  }

  it('a hung Jev whose retry timer would have landed LATER than the first (lag growth 60 → 250 in round 3) costs the readout nothing: no retry is taken on an unconfirmed first timeout', async () => {
    const pre = await run3Under(true, 'sweep_triage', 4000, () => [replyIn(99_999, JEV_OK, 60), replyIn(99_999, JEV_OK, 250)], () => [replyIn(950, READOUT_OK)]);
    const out = await run3Under(false, 'sweep_triage', 4000, () => [replyIn(99_999, JEV_OK, 60), replyIn(99_999, JEV_OK, 250)], () => [replyIn(950, READOUT_OK)]);
    expect(out.readoutTimeouts).toEqual(pre.readoutTimeouts);
    expect(out.readoutTimeouts).toEqual([1940, 1940, 1940]);
    expect(out.results).toEqual(['DeepSeek logprob readout', 'DeepSeek logprob readout', 'DeepSeek logprob readout']);
    expect(out.allFailed).toEqual([]);
  });

  it('a CONFIRMED stall (the loop meter saturated) on a 3000 ms ask still buys the bounded retry: Jev re-asked with 1500 − the readout\'s 1100 reserve = 400 ms, and answers', async () => {
    busy = { activeMs: 1300, utilization: 0.88 };
    script([replyIn(99_999, JEV_OK, 0), replyIn(150, JEV_OK)], []);
    const r = await ask('memory_extract', 3000);
    expect(r!.backend).toBe('TypeSafe Jev');
    expect(jevPosts().map((c) => c[2].timeout)).toEqual([1500, 400]);
    expect(decisionRows()[0]).toMatchObject({ ok: true, stall: { retried: true, recovered: true } });
    expect(decisionRows()[0].stall.legs[0]).toMatchObject({ stall: true, stallConfirmed: true });
  });

  it('a confirmed stall whose bounded share (110 ms) is under the retried Jev\'s own minimum is no retry: the readout gets everything that is left', async () => {
    // 2420 ms ask: Jev's 1210 ms timer fires on time in a saturated window → 1210 left → min(1210, 605, 1210 − 1100) = 110.
    busy = { activeMs: 1100, utilization: 0.9 };
    script([replyIn(99_999, JEV_OK, 0)], [replyIn(900, READOUT_OK)]);
    const r = await ask('memory_extract', 2420);
    expect(r!.backend).toBe('DeepSeek logprob readout');
    expect(jevPosts().map((c) => c[2].timeout)).toEqual([1210]);
    expect(readoutPosts().map((c) => c[2].timeout)).toEqual([1210]);
  });

  describe('the readout first, Jev second (the Decision gate seat = deepseek-flash)', () => {
    for (const [late, jevMs] of [[450, 120], [490, 100]]) {
      it(`1200 ms ask: the readout's 600 ms timer ${late} ms late leaves ${600 - late} ms — under the retried readout's own 500 ms minimum, so no readout retry: Jev gets all of it (its pre-ticket budget) and answers in ${jevMs} ms`, async () => {
        mockSeat = 'deepseek-flash';
        const jev = () => [replyIn(jevMs, JEV_OK)];
        const readout = () => [replyIn(99_999, READOUT_OK, late), replyIn(99_999, READOUT_OK, 0)];
        const pre = await run3Under(true, 'turn_plan', 1200, jev, readout);
        const out = await run3Under(false, 'turn_plan', 1200, jev, readout);
        expect(pre.readoutTimeouts).toEqual([600, 600, 600]);
        expect(out.readoutTimeouts).toEqual(pre.readoutTimeouts); // never re-posted
        expect(out.jevTimeouts).toEqual(pre.jevTimeouts);
        expect(out.jevTimeouts).toEqual([600 - late, 600 - late, 600 - late]);
        expect(out.results).toEqual(['TypeSafe Jev', 'TypeSafe Jev', 'TypeSafe Jev']);
        expect(out.allFailed).toEqual([]);
      });
    }
  });

  it('every leg error decide() writes for a failed stall retry ends with the tail the readiness counters skip (isStallRetryLegError), and no first attempt does', async () => {
    // 1200 ms asks: a confirmed retry late again; an unconfirmed retry late; a retry that timed out on time.
    for (const [i, steps] of ([[timesOut(300), timesOut(200)], [timesOut(170), timesOut(60)], [timesOut(170), timesOut(0)]] as Step[][]).entries()) {
      script(steps, []);
      expect(await ask('task_kind', 1200, i)).toBeNull();
    }
    const errs = decisionRows().map((d) => d.legErrors);
    expect(errs.map((e) => e.map((x: string) => isStallRetryLegError(x)))).toEqual([[false, true, false], [false, true, false], [false, true, false]]);
    expect(errs[0][1]).toMatch(/\[loop stall: 200 ms late, loop 0% busy; stall retry\]$/);
    expect(errs[1][1]).toMatch(/\[timer 60 ms late, loop 0% busy — not a confirmed loop stall; stall retry\]$/);
    expect(errs[2][1]).toMatch(/ \[stall retry\]$/);
  });

  it('the egress alert / log clause no longer claims a free event loop: a timer cheaply late (not a confirmed stall) lands in egress too', () => {
    expect(allFailedCauseText('egress')).toContain('no timeout was a confirmed event-loop stall');
    expect(allFailedCauseText('egress')).not.toContain('free event loop');
  });
});

describe('decision-gate-stall (pure)', () => {
  it('legFailureOf: only a status-less axios timeout is a timeout; our own "deadline exhausted" is budget; everything else is an error', () => {
    expect(legFailureOf(timeoutErr(600))).toBe('timeout');
    expect(legFailureOf({ code: 'ETIMEDOUT', message: 'timeout of 600ms exceeded' })).toBe('timeout');
    expect(legFailureOf({ code: 'ECONNABORTED', message: 'timeout' })).toBe('timeout');
    expect(legFailureOf(new Error('deadline exhausted'))).toBe('budget');
    expect(legFailureOf({ response: { status: 504 }, code: 'ECONNABORTED', message: 'timeout' })).toBe('error');
    expect(legFailureOf({ code: 'ECONNRESET', message: 'socket hang up' })).toBe('error');
    expect(legFailureOf({ code: 'ECONNABORTED', message: 'Request aborted' })).toBe('error');
    expect(legFailureOf(new Error('response carries no logprobs'))).toBe('error');
  });

  it('stallExplains / legTiming: late ≥ 50 ms, or a ≥ 80 % busy window with ≥ 200 ms active; never a non-timeout', () => {
    expect(stallExplains('timeout', DECISION_STALL_LATE_MS, null)).toBe(true);
    expect(stallExplains('timeout', DECISION_STALL_LATE_MS - 1, null)).toBe(false);
    expect(stallExplains('timeout', 0, { activeMs: 200, utilization: 0.8 })).toBe(true);
    expect(stallExplains('timeout', 0, { activeMs: 199, utilization: 0.99 })).toBe(false);
    expect(stallExplains('timeout', 0, { activeMs: 900, utilization: 0.79 })).toBe(false);
    expect(stallExplains('error', 900, { activeMs: 900, utilization: 1 })).toBe(false);
    expect(stallExplains('budget', 900, null)).toBe(false);
    expect(legTiming({ backend: 'TypeSafe Jev', attempt: 1, err: timeoutErr(595), legStart: 1000, legDeadlineAt: 1595, failedAt: 1895, busy: { activeMs: 610.4, utilization: 0.678912 }, dispatchedAt: 1004 }))
      .toEqual({ backend: 'TypeSafe Jev', attempt: 1, failure: 'timeout', budgetMs: 595, elapsedMs: 895, lateMs: 300, dispatchLagMs: 4, wireLateMs: 296, busyMs: 610, busy: 0.679, stall: true, stallConfirmed: true });
    // No dispatch measurement: the cheap signal stands, lateness cannot confirm (only the meter could).
    expect(legTiming({ backend: 'TypeSafe Jev', attempt: 1, err: timeoutErr(595), legStart: 1000, legDeadlineAt: 1595, failedAt: 1895, busy: null, dispatchedAt: null }))
      .toEqual({ backend: 'TypeSafe Jev', attempt: 1, failure: 'timeout', budgetMs: 595, elapsedMs: 895, lateMs: 300, stall: true, stallConfirmed: false });
  });

  it('stallConfirms: a saturated loop window, or wire lateness ≥ max(200 ms, 25 % of the budget); never a non-timeout, never unmeasured lateness alone', () => {
    expect(stallConfirmLateMs(600)).toBe(200);
    expect(stallConfirmLateMs(2000)).toBe(500);
    expect(stallConfirmLateMs(0)).toBe(200);
    expect(stallConfirms('timeout', 200, 600, null)).toBe(true);
    expect(stallConfirms('timeout', 199, 600, null)).toBe(false);
    expect(stallConfirms('timeout', 499, 2000, null)).toBe(false);
    expect(stallConfirms('timeout', 500, 2000, null)).toBe(true);
    expect(stallConfirms('timeout', undefined, 600, null)).toBe(false);
    expect(stallConfirms('timeout', 0, 600, { activeMs: 200, utilization: 0.8 })).toBe(true);
    expect(stallConfirms('timeout', undefined, 600, { activeMs: 900, utilization: 0.95 })).toBe(true);
    expect(stallConfirms('timeout', 60, 2000, { activeMs: 900, utilization: 0.5 })).toBe(false);
    expect(stallConfirms('error', 900, 600, { activeMs: 900, utilization: 1 })).toBe(false);
    expect(stallConfirms('budget', 900, 600, null)).toBe(false);
  });

  it('stallRetryDeadline (round 4): the full residual only when no later leg could answer in it; a bounded retry only on a CONFIRMED stall, leaving the later legs their reserve plus the lateness already seen; never under the retried leg\'s own minimum', () => {
    const at = (o: Partial<StallRetryInput>) => stallRetryDeadline({ now: 0, deadlineAt: 0, budgetMs: 0, lateMs: 0, confirmed: true, ownKind: 'systemone', laterKinds: ['logit'], legTimeoutMs: 2000, ...o });
    expect(DECISION_STALL_LEG_NEED).toEqual({ systemone: { minMs: 120, reserveMs: 400 }, logit: { minMs: 500, reserveMs: 1100 } });
    // A later readout could answer and the stall is CONFIRMED: min(budget, half, what is left − 1100 − late).
    expect(at({ deadlineAt: 1940, budgetMs: 2000, lateMs: 60 })).toBe(780);
    expect(at({ deadlineAt: 1440, budgetMs: 1500, lateMs: 60 })).toBe(280);
    expect(at({ deadlineAt: 2940, budgetMs: 2000, lateMs: 60 })).toBe(1470); // half of what is left binds
    expect(at({ deadlineAt: 9000, budgetMs: 2000, lateMs: 60 })).toBe(2000); // the original budget binds
    expect(at({ now: 1000, deadlineAt: 2940, budgetMs: 2000, lateMs: 60 })).toBe(1000 + 780);
    // The SAME shapes on an unconfirmed (cheap-only) first attempt: no retry — the later leg keeps its pre-ticket budget.
    for (const [left, budget, late] of [[1940, 2000, 60], [1440, 1500, 60], [2940, 2000, 60], [9000, 2000, 60], [540, 600, 60], [1880, 2000, 120]]) {
      expect(at({ deadlineAt: left, budgetMs: budget, lateMs: late, confirmed: false })).toBeNull();
    }
    // Never more than the non-final leg rule (legShareCap) whenever a later leg can still be called.
    for (const [budget, left, late] of [[2000, 1940, 60], [1500, 1440, 60], [2000, 2400, 600], [2000, 9000, 0], [2000, 2000, 0]]) {
      const d = at({ deadlineAt: left, budgetMs: budget, lateMs: late });
      expect(d).not.toBeNull();
      expect(d!).toBeLessThanOrEqual(legShareCap(budget, left));
    }
    // A confirmed stall whose share does not fit next to the later leg's reserve ⇒ no retry.
    expect(at({ deadlineAt: 940, budgetMs: 1000, lateMs: 60 })).toBeNull();
    expect(at({ deadlineAt: 1210, budgetMs: 1210, lateMs: 0 })).toBeNull(); // 110 < Jev's 120 minimum
    expect(at({ deadlineAt: 1210, budgetMs: 1210, lateMs: 0, ownKind: undefined })).toBe(110); // the bare 100 ms floor
    expect(at({ deadlineAt: 1220, budgetMs: 1220, lateMs: 0 })).toBe(120); // exactly Jev's minimum
    expect(at({ deadlineAt: 1940, budgetMs: 2000, lateMs: -5 })).toBe(840); // an early timer reserves no lateness
    // Less left than any later leg's minimum ⇒ they could not answer in it anyway ⇒ the whole residual, on the cheap
    // signal too (the incident's own 1200 ms asks).
    for (const confirmed of [true, false]) {
      expect(at({ deadlineAt: 300, budgetMs: 600, lateMs: 300, confirmed })).toBe(300);
      expect(at({ deadlineAt: 430, budgetMs: 600, lateMs: 170, confirmed })).toBe(430);
      expect(at({ deadlineAt: 499, budgetMs: 600, lateMs: 101, confirmed })).toBe(499);
      expect(at({ deadlineAt: 120, budgetMs: 600, lateMs: 480, confirmed })).toBe(120); // exactly the retried Jev's minimum
    }
    expect(at({ deadlineAt: 500, budgetMs: 600, lateMs: 100, confirmed: false })).toBeNull(); // the readout could answer in 500
    // …but never shorter than the RETRIED leg's own minimum (round-3 review finding): 119 ms is no Jev retry.
    expect(at({ deadlineAt: 119, budgetMs: 600, lateMs: 481 })).toBeNull();
    expect(at({ deadlineAt: 119, budgetMs: 600, lateMs: 481, ownKind: undefined })).toBe(119);
    // The readout first, Jev second (a deepseek-flash Decision seat): a retried readout never gets less than its own 500 ms.
    const readoutFirst: Partial<StallRetryInput> = { ownKind: 'logit', laterKinds: ['systemone'] };
    expect(at({ ...readoutFirst, deadlineAt: 150, budgetMs: 600, lateMs: 450 })).toBeNull(); // the reviewer's case: Jev gets the 150
    expect(at({ ...readoutFirst, deadlineAt: 110, budgetMs: 600, lateMs: 490 })).toBeNull(); // under Jev's minimum too: still no readout retry
    expect(at({ ...readoutFirst, deadlineAt: 1940, budgetMs: 2000, lateMs: 60 })).toBe(970); // confirmed: min(2000, 970, 1940 − 400 − 60)
    expect(at({ ...readoutFirst, deadlineAt: 1940, budgetMs: 2000, lateMs: 60, confirmed: false })).toBeNull();
    expect(at({ ...readoutFirst, deadlineAt: 1000, budgetMs: 1000, lateMs: 60 })).toBe(500); // min(1000, 500, 540)
    expect(at({ ...readoutFirst, deadlineAt: 998, budgetMs: 1000, lateMs: 60 })).toBeNull(); // 499 < the readout's 500
    // No later servable leg ⇒ the whole residual (the cheap signal is enough), still never under the retried leg's minimum.
    for (const confirmed of [true, false]) {
      expect(at({ deadlineAt: 300, budgetMs: 600, lateMs: 300, laterKinds: [], confirmed })).toBe(300);
      expect(at({ now: 1000, deadlineAt: 5000, budgetMs: 2000, laterKinds: [], confirmed })).toBe(5000);
    }
    expect(at({ deadlineAt: 119, laterKinds: [] })).toBeNull();
    expect(at({ deadlineAt: 300, laterKinds: [], ownKind: 'logit' })).toBeNull(); // a last readout with 300 ms left: no retry
    expect(at({ deadlineAt: 500, laterKinds: [], ownKind: 'logit' })).toBe(500);
    expect(at({ deadlineAt: DECISION_STALL_RETRY_MIN_MS, laterKinds: [], ownKind: undefined })).toBe(DECISION_STALL_RETRY_MIN_MS);
    expect(at({ deadlineAt: DECISION_STALL_RETRY_MIN_MS - 1, laterKinds: [], ownKind: undefined })).toBeNull();
    // Several later legs: the FASTEST one's minimum decides "could answer"; the reserve keeps EACH its share (laterLegsReserveMs).
    expect(at({ deadlineAt: 450, budgetMs: 600, lateMs: 150, laterKinds: ['systemone', 'logit'] })).toBeNull();
    expect(at({ deadlineAt: 110, budgetMs: 600, lateMs: 150, laterKinds: ['systemone', 'logit'], ownKind: undefined })).toBe(110);
    expect(at({ deadlineAt: 4000, budgetMs: 2000, lateMs: 0, laterKinds: ['systemone', 'logit'] })).toBe(1800); // 4000 − 2200
    expect(at({ deadlineAt: 2400, budgetMs: 2000, lateMs: 0, laterKinds: ['systemone', 'logit'] })).toBe(200);
    expect(at({ deadlineAt: 2300, budgetMs: 2000, lateMs: 0, laterKinds: ['systemone', 'logit'] })).toBeNull(); // 100 < Jev's 120
    // An unknown kind is treated as the slower one (later: keeps the readout's reserve; retried: the readout's 500 minimum).
    expect(at({ deadlineAt: 1940, budgetMs: 2000, lateMs: 60, laterKinds: ['weird'] })).toBe(780);
    expect(at({ deadlineAt: 300, ownKind: 'weird', laterKinds: [] })).toBeNull();
    expect(at({ deadlineAt: 1940, ownKind: 'weird', laterKinds: [] })).toBe(1940);
  });

  it('laterLegsReserveMs (round 4): EACH later leg keeps its reserve under decide()\'s own sharing — a non-final later leg takes min(leg cap, half of what is left), the last one the rest', () => {
    expect(laterLegsReserveMs([], 2000)).toBe(0);
    expect(laterLegsReserveMs(['logit'], 2000)).toBe(1100); // one later leg: exactly its reserve (round 3's arithmetic)
    expect(laterLegsReserveMs(['systemone'], 2000)).toBe(400);
    // [Jev, readout] behind the retried leg: Jev takes half, so 2 × 1100 keeps the readout 1100 behind a hung Jev
    // (round 3 kept max(400, 1100) = 1100, and a hung middle Jev then left the readout 550).
    expect(laterLegsReserveMs(['systemone', 'logit'], 2000)).toBe(2200);
    expect(laterLegsReserveMs(['logit', 'logit'], 1000)).toBe(2100); // the leg cap binds: 1100 + 1000
    expect(laterLegsReserveMs(['logit', 'systemone'], 2000)).toBe(2200); // the middle readout's own 1100 (× 2) binds
    expect(laterLegsReserveMs(['systemone', 'systemone', 'logit'], 2000)).toBe(4200);
    // DECISION_GATE_LEG_TIMEOUT_MS=0: every leg takes the whole residual — only the first later leg's reserve can be kept.
    expect(laterLegsReserveMs(['systemone', 'logit'], 0)).toBe(400);
    expect(laterLegsReserveMs(['logit', 'systemone'], 0)).toBe(1100);
    // Simulated with decide()'s own sharing: starting from the reserve, every middle leg gets at least its reserve and
    // the tail leg is left at least its reserve.
    const chains: DecisionLegKind[][] = [['systemone', 'logit'], ['logit', 'logit'], ['systemone', 'systemone', 'logit'], ['logit', 'systemone'], ['logit']];
    for (const kinds of chains) {
      for (const T of [1000, 2000, 3000]) {
        let R = laterLegsReserveMs(kinds, T);
        for (let i = 0; i < kinds.length - 1; i++) {
          const take = legShareCap(T, R);
          expect(take).toBeGreaterThanOrEqual(Math.min(DECISION_STALL_LEG_NEED[kinds[i]].reserveMs, T));
          R -= take;
        }
        expect(R).toBeGreaterThanOrEqual(DECISION_STALL_LEG_NEED[kinds[kinds.length - 1]].reserveMs);
      }
    }
  });

  it('isStallRetryLegError: only the tail decide() appends to a failed stall retry', () => {
    expect(isStallRetryLegError('TypeSafe Jev: timeout timeout of 300ms exceeded [stall retry]')).toBe(true);
    expect(isStallRetryLegError('TypeSafe Jev: timeout timeout of 700ms exceeded [loop stall: 400 ms late, loop 3% busy; stall retry]')).toBe(true);
    expect(isStallRetryLegError('TypeSafe Jev: timeout timeout of 430ms exceeded [timer 60 ms late — not a confirmed loop stall; stall retry]')).toBe(true);
    expect(isStallRetryLegError('TypeSafe Jev: timeout timeout of 600ms exceeded [loop stall: 300 ms late]')).toBe(false);
    expect(isStallRetryLegError('TypeSafe Jev: HTTP 500 stall retry] in the body, then more')).toBe(false);
    expect(isStallRetryLegError(undefined)).toBe(false);
  });

  it('legTiming (round 3): the cheap signal reads the WIRE lateness when the dispatch probe measured it, measured from the marked post', () => {
    // 85 ms late, 80 of it before the request left: wire-late 5 ⇒ no cheap signal, no retry.
    expect(legTiming({ backend: 'TypeSafe Jev', attempt: 1, err: timeoutErr(2000), legStart: 0, legDeadlineAt: 2000, failedAt: 2085, busy: null, dispatchedAt: 80 }))
      .toMatchObject({ lateMs: 85, dispatchLagMs: 80, wireLateMs: 5, stall: false, stallConfirmed: false });
    // Unmeasured (the probe had not run by the failure): the raw lateness stands for the cheap signal.
    expect(legTiming({ backend: 'TypeSafe Jev', attempt: 1, err: timeoutErr(2000), legStart: 0, legDeadlineAt: 2000, failedAt: 2085, busy: null, dispatchedAt: null }))
      .toMatchObject({ lateMs: 85, stall: true, stallConfirmed: false });
    // A re-post issued at +20 whose own dispatch ran at +600: measured from THAT post, not the leg start.
    expect(legTiming({ backend: 'TypeSafe Jev', attempt: 1, err: timeoutErr(1980), legStart: 0, legDeadlineAt: 2000, failedAt: 2600, busy: null, dispatchedAt: 600, dispatchIssuedAt: 20 }))
      .toMatchObject({ lateMs: 600, dispatchLagMs: 580, wireLateMs: 20, stall: false, stallConfirmed: false });
    // A saturated window still buys the retry whatever the lateness says.
    expect(legTiming({ backend: 'TypeSafe Jev', attempt: 1, err: timeoutErr(2000), legStart: 0, legDeadlineAt: 2000, failedAt: 2085, busy: { activeMs: 1800, utilization: 0.9 }, dispatchedAt: 80 }))
      .toMatchObject({ stall: true, stallConfirmed: true });
  });

  it('classifyAllLegsFailed: stall only when EVERY timed-out leg is a CONFIRMED stall and nothing else failed', () => {
    const t = (stallConfirmed: boolean) => ({ failure: 'timeout' as const, stallConfirmed });
    const e = { failure: 'error' as const, stallConfirmed: false };
    const b = { failure: 'budget' as const, stallConfirmed: false };
    expect(classifyAllLegsFailed([t(true), t(true)])).toBe('stall');
    expect(classifyAllLegsFailed([t(true), b])).toBe('stall');
    expect(classifyAllLegsFailed([t(false), t(false)])).toBe('egress');
    expect(classifyAllLegsFailed([t(true), t(false)])).toBe('mixed');
    expect(classifyAllLegsFailed([t(true), e])).toBe('mixed');
    expect(classifyAllLegsFailed([t(true)], 1)).toBe('mixed'); // a latched leg next to a stall
    expect(classifyAllLegsFailed([e, e])).toBe('provider');
    expect(classifyAllLegsFailed([], 2)).toBe('provider');
    expect(classifyAllLegsFailed([b])).toBe('budget');
    expect(allFailedCauseText('stall')).toContain('event-loop stall');
    expect(allFailedCauseText('egress')).toContain('no timeout was a confirmed event-loop stall');
  });

  it('isStallExemptAllFailedRow: cause stall AND every timed-out leg on the row carries the confirmed evidence; honours the reading process\'s kill switch; decisionStallRecoveryDisabled reads 1 / true / on', () => {
    const confirmed = [{ failure: 'timeout', stall: true, stallConfirmed: true }, { failure: 'budget', stall: false, stallConfirmed: false }];
    expect(isStallExemptAllFailedRow({ event: 'all_legs_failed', cause: 'stall', legTimings: confirmed }, {})).toBe(true);
    expect(isStallExemptAllFailedRow({ event: 'all_legs_failed', cause: 'egress', legTimings: confirmed }, {})).toBe(false);
    expect(isStallExemptAllFailedRow({ event: 'latched', cause: 'stall', legTimings: confirmed }, {})).toBe(false);
    expect(isStallExemptAllFailedRow(null, {})).toBe(false);
    // The row must carry the evidence itself: no legTimings, no timed-out leg, or a cheap-only (unconfirmed) leg ⇒ counted.
    expect(isStallExemptAllFailedRow({ event: 'all_legs_failed', cause: 'stall' }, {})).toBe(false);
    expect(isStallExemptAllFailedRow({ event: 'all_legs_failed', cause: 'stall', legTimings: [{ failure: 'budget', stallConfirmed: false }] }, {})).toBe(false);
    expect(isStallExemptAllFailedRow({ event: 'all_legs_failed', cause: 'stall', legTimings: [{ failure: 'timeout', stall: true }] }, {})).toBe(false);
    expect(isStallExemptAllFailedRow({ event: 'all_legs_failed', cause: 'stall', legTimings: confirmed }, { DECISION_GATE_STALL_RECOVERY_DISABLED: '1' })).toBe(false);
    expect(decisionStallRecoveryDisabled({ DECISION_GATE_STALL_RECOVERY_DISABLED: 'true' })).toBe(true);
    expect(decisionStallRecoveryDisabled({ DECISION_GATE_STALL_RECOVERY_DISABLED: '0' })).toBe(false);
    expect(decisionStallRecoveryDisabled({})).toBe(false);
  });

  // ── Round 5 — ticket 91912bee (2026-11-04): the burst where a PURE event-loop stall was counted as a backend-down ──
  // Prod 22:10:07–22:10:20.681Z: four asks whose own window was 100 % busy for 1154–1282 ms. The first leg of each ate
  // the shared deadline late, so the LATER legs were handed residuals of 36 / 136 / 169 / 190 / 199 ms — every one under
  // DECISION_STALL_BUSY_MIN_MS (200), so `loopSaturated` on the leg window could only answer false however hot the loop
  // ran. Those legs read stallConfirmed:false, the ask classified 'mixed' instead of 'stall', the in-process streak
  // advanced 1→4 and decision-backend-down fired. The 199 ms leg missed the floor by ONE millisecond.
  const burstLegs = (over: Record<string, any> = {}) => ([
    // attempt 1 — a REAL window, saturated: confirmed by its own evidence (round 2), unchanged by this round.
    { failure: 'timeout' as const, budgetMs: 599, lateMs: 381, busyMs: 361, busy: 1, stall: true, stallConfirmed: true, ...over },
    // the STARVED legs — windows shorter than the floor, all at busy 1.0.
    { failure: 'timeout' as const, budgetMs: 190, lateMs: 40, busyMs: 36, busy: 1, stall: false, stallConfirmed: false },
    { failure: 'timeout' as const, budgetMs: 169, lateMs: 22, busyMs: 136, busy: 1, stall: false, stallConfirmed: false },
    { failure: 'timeout' as const, budgetMs: 190, lateMs: 30, busyMs: 190, busy: 1, stall: false, stallConfirmed: false },
    { failure: 'timeout' as const, budgetMs: 199, lateMs: 12, busyMs: 199, busy: 1, stall: false, stallConfirmed: false },
  ]);
  const burstAsk = { activeMs: 1234, utilization: 1 };

  it('91912bee: a leg the stall itself STARVED is confirmed by the ask window — a pure stall no longer classifies mixed', () => {
    // The defect, reproduced: without the ask reading the starved legs read unconfirmed and the ask is 'mixed'.
    expect(classifyAllLegsFailed(burstLegs())).toBe('mixed');
    // With the ask's own reading (which decide() already records on the row) the same legs are a stall.
    expect(classifyAllLegsFailed(burstLegs(), 0, burstAsk)).toBe('stall');
    // Every leg of the burst is individually covered — the 199 ms one included (the one that missed by 1 ms).
    for (const leg of burstLegs()) expect(legStallConfirmedUnderAsk(leg, burstAsk)).toBe(true);
  });

  it('91912bee: the ask window only covers legs it could not judge — a real un-saturated leg still reads egress and still counts', () => {
    // A leg with a REAL window (≥ the 200 ms floor) that was NOT saturated keeps its own verdict: the backend hung on a
    // free-ish loop. That is exactly the egress class the alert exists for — the ask reading must NOT launder it.
    const slowWire = [
      { failure: 'timeout' as const, budgetMs: 2000, busyMs: 1800, busy: 0.9, stallConfirmed: true },   // own evidence: saturated
      { failure: 'timeout' as const, budgetMs: 2000, busyMs: 1800, busy: 0.1, stallConfirmed: false },  // hot window, idle loop ⇒ wire
    ];
    expect(classifyAllLegsFailed(slowWire, 0, burstAsk)).toBe('mixed');
    expect(classifyAllLegsFailed([slowWire[1]], 0, burstAsk)).toBe('egress');
    // An UNMEASURED leg (no window at all) under a saturated ask is still a stall: there is no counter-evidence.
    expect(legStallConfirmedUnderAsk({ failure: 'timeout', stallConfirmed: false }, burstAsk)).toBe(true);
    // …and with no ask reading at all the behaviour is EXACTLY the pre-round-5 rule (every existing test above holds).
    expect(classifyAllLegsFailed(burstLegs(), 0, null)).toBe('mixed');
    expect(classifyAllLegsFailed(burstLegs(), 0, { activeMs: 199, utilization: 1 })).toBe('mixed');  // ask under the floor
    expect(classifyAllLegsFailed(burstLegs(), 0, { activeMs: 1234, utilization: 0.5 })).toBe('mixed'); // ask not saturated
    expect(askWindowSaturated(burstAsk)).toBe(true);
    expect(askWindowSaturated({ activeMs: 199, utilization: 1 })).toBe(false);
    expect(askWindowSaturated({ activeMs: 1234, utilization: 0.49 })).toBe(false);
    expect(askWindowSaturated(undefined)).toBe(false);
  });

  it('91912bee: the SWEEP reaches the same verdict as decide() for the burst row — the row carries loopBusyMs/loopBusy', () => {
    // Replay of the prod row shape (meta.stall is folded flat into the row for the sweep's reader).
    const row = { event: 'all_legs_failed', cause: 'stall', loopBusyMs: 1234, loopBusy: 1, legTimings: burstLegs() };
    expect(isStallExemptAllFailedRow(row, {})).toBe(true);
    // A starved leg WITHOUT the ask reading on the row cannot be excused — the evidence must be on the row itself.
    expect(isStallExemptAllFailedRow({ ...row, loopBusyMs: undefined, loopBusy: undefined }, {})).toBe(false);
    // An egress row is never exempt, whatever the ask window says.
    expect(isStallExemptAllFailedRow({ ...row, cause: 'egress' }, {})).toBe(false);
    // The kill switch still disarms the whole exemption.
    expect(isStallExemptAllFailedRow(row, { DECISION_GATE_STALL_RECOVERY_DISABLED: '1' })).toBe(false);
  });

  it('DETECTOR-RECALL REPLAY 91912bee: the prior convicting cases STILL convict — a free-loop timeout burst is never excused', () => {
    // Widening what CONFIRMS a stall could, if done carelessly, stop the alert firing on the class it exists for:
    // a provider/egress burst on a HEALTHY process. Every prior true positive is replayed here and must STILL fire.
    // True positives of rounds 1–4, re-run against the widened rule: on a free loop nothing is confirmed, so a
    // provider/egress burst classifies egress and the row counts. This is the class the alert was built for.
    const free = [
      { failure: 'timeout' as const, budgetMs: 2000, busyMs: 40, busy: 0.02, stallConfirmed: false },
      { failure: 'timeout' as const, budgetMs: 2000, busyMs: 55, busy: 0.03, stallConfirmed: false },
    ];
    expect(classifyAllLegsFailed(free, 0, { activeMs: 2000, utilization: 0.02 })).toBe('egress');
    expect(classifyAllLegsFailed(free, 0, null)).toBe('egress');
    expect(isStallExemptAllFailedRow({ event: 'all_legs_failed', cause: 'egress', loopBusyMs: 2000, loopBusy: 0.02, legTimings: free }, {})).toBe(false);
    // A genuine wire-timeout burst on a BUSY-but-not-blocked process: the ask window is below the utilization bar.
    const wireWhileBusy = [
      { failure: 'timeout' as const, budgetMs: 2000, busyMs: 1200, busy: 0.55, stallConfirmed: false },
      { failure: 'timeout' as const, budgetMs: 2000, busyMs: 1400, busy: 0.6, stallConfirmed: false },
    ];
    expect(classifyAllLegsFailed(wireWhileBusy, 0, { activeMs: 2000, utilization: 0.6 })).toBe('egress');
    // Provider errors next to timeouts still count as mixed, ask window or not.
    expect(classifyAllLegsFailed([...burstLegs(), { failure: 'error', stallConfirmed: false }], 0, burstAsk)).toBe('mixed');
    // No leg called at all is still a budget miss, never a stall.
    expect(classifyAllLegsFailed([{ failure: 'budget', stallConfirmed: false }], 0, burstAsk)).toBe('budget');
    // The kill switch still disarms every exemption path.
    expect(isStallExemptAllFailedRow({ event: 'all_legs_failed', cause: 'stall', loopBusyMs: 1234, loopBusy: 1, legTimings: burstLegs() }, { DECISION_GATE_STALL_RECOVERY_DISABLED: '1' })).toBe(false);
  });
});
