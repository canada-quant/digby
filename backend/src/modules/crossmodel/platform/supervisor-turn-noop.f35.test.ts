/**
 * FO firing 35 (2026-09-27) — REPLAY test: per-leg timing bank for the
 * supervisor-turn-noop facts timeout.
 *
 * Defect: the intermittent "supervisor turn facts timed out after 1500ms"
 * fail-open (6 rows 14:00Z–18:39Z; ~0.8–1.4/h) was UNDIAGNOSABLE — no evidence
 * rode the strike, so every firing re-guessed the cause. Firing 35's live probe
 * proved the cause is NOT query cost (9 legs ≈ 135 ms on the noisiest chat vs
 * the 1500 ms budget; sibling 1.2 s-budget subsystems fail in the same windows)
 * but could not see WHICH leg stalls at strike time.
 *
 * Fix: computeSupervisorTurnNoopFacts takes an optional legMs bank; each leg
 * banks its elapsed ms on completion; preTriageSupervisorTurn hoists the bank
 * above its try and appends ` [leg:ms …]` (hottest first, ≤6) to the fail-open
 * warn. The strike message keeps the greppable prefix — audit-live-state.js
 * matches "supervisor turn facts timed out" on that substring.
 */
jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockPrisma: any = {
  crossModelChat: { findUnique: jest.fn(), findMany: jest.fn() },
  loopMetric: { findMany: jest.fn() },
  crossModelMessage: { findMany: jest.fn() },
  eventHook: { findMany: jest.fn() },
  hookEvent: { count: jest.fn(), findMany: jest.fn() },
  ownerQuestion: { count: jest.fn() },
  pendingChatMessage: { count: jest.fn() },
  agentRun: { count: jest.fn() },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

const mockRedis = { get: jest.fn(async () => null), set: jest.fn(async () => 'OK'), del: jest.fn(async () => 1) };
jest.mock('../../../config/redis', () => ({ __esModule: true, default: mockRedis }));

const mockDecide: jest.Mock = jest.fn(async (..._a: any[]): Promise<any> => null);
const mockMode: jest.Mock = jest.fn((): 'off' | 'shadow' | 'act' => 'shadow');
jest.mock('./decision-gate', () => ({
  __esModule: true,
  decide: (...a: any[]) => mockDecide(...a),
  decisionMode: (...a: any[]) => mockMode(...a),
  decisionThreshold: (_p: string, fallback: number) => fallback,
  stashDecision: (d: any, purpose: string, opts?: any) => (d ? { id: d.id, purpose, mode: d.mode, backend: d.backend, answers: d.answers, decidedAt: 'now', ...(opts?.extra ? { extra: opts.extra } : {}) } : null),
  recordDecisionOutcome: (d: unknown, ...rest: any[]) => { void d; void rest; },
  reconstructDecision: (s: any) => (s && s.id && s.answers ? s : null),
}));

jest.mock('./loop-metrics.service', () => ({
  __esModule: true,
  LOOP_METRIC_KINDS: { WAKE_PARKED: 'wake_parked' },
  recordLoopMetric: (..._a: any[]) => undefined,
}));

jest.mock('./supervisor.service', () => ({
  __esModule: true,
  classifySupervisorNote: (..._a: any[]) => 'supervisor_note',
}));

jest.mock('./supervisor-state.service', () => ({
  __esModule: true,
  getSupervisorState: jest.fn(async () => ({ directives: [{ status: 'open' }] })),
}));

jest.mock('./hooks.service', () => ({
  __esModule: true,
  isAlarmEvent: (..._a: any[]) => false,
}));

import logger from '../../../utils/logger';
import { computeSupervisorTurnNoopFacts, preTriageSupervisorTurn } from './supervisor-turn-noop';

const NOW = new Date('2026-09-27T18:00:00Z');
const sup = { id: 'sup', userId: 'u1', projectId: null, isSupervisor: true, isProjectSupervisor: false };

beforeEach(() => {
  jest.clearAllMocks();
  mockMode.mockReturnValue('shadow');
  mockPrisma.crossModelChat.findUnique.mockResolvedValue(sup);
  mockPrisma.crossModelChat.findMany.mockResolvedValue([{ id: 'c2' }]); // scope → lanes leg runs
  mockPrisma.loopMetric.findMany.mockResolvedValue([]);
  mockPrisma.crossModelMessage.findMany.mockResolvedValue([]);
  mockPrisma.eventHook.findMany.mockResolvedValue([{ id: 'h1' }]); // hooks → pendHooks leg runs
  mockPrisma.hookEvent.count.mockResolvedValue(0);
  mockPrisma.ownerQuestion.count.mockResolvedValue(0);
  mockPrisma.pendingChatMessage.count.mockResolvedValue(0);
  mockPrisma.agentRun.count.mockResolvedValue(0);
});

describe('FO firing 35: per-leg timing bank rides the facts-timeout strike', () => {
  it('banks every leg that completes (all 9 on a healthy read)', async () => {
    const legMs: Record<string, number> = {};
    const f = await computeSupervisorTurnNoopFacts('sup', NOW, legMs);
    expect(f).toBeTruthy();
    expect(Object.keys(legMs).sort()).toEqual(['asks', 'chat', 'directives', 'hooks', 'lanes', 'metrics', 'notes', 'pendHooks', 'scope', 'userRows'].sort());
    for (const ms of Object.values(legMs)) expect(ms).toBeGreaterThanOrEqual(0);
  });

  it('a stalled leg never banks — its absence is the diagnosis — and the fail-open warn carries the banked tail', async () => {
    // The metrics leg hangs forever: the 1.5 s deadline fires while it is in
    // flight, so `metrics` never banks but `chat` does.
    mockPrisma.loopMetric.findMany.mockImplementation(() => new Promise(() => { /* never settles */ }));
    // FIXED firing 56: the chat leg must settle MEASURABLY slower than the
    // other legs, else the cap-6 tail in legTimingNote can slice `chat:` out.
    // On a fast runner every settled leg ties at 0–1 ms; chat rounds to 0,
    // six other legs tie at 1 ms and fill the entire cap, and the literal
    // vanishes from the warn (CI 36765521576, red main on 104eec4d — second
    // occurrence of the class; firing 36's fix made the assertion
    // position-independent but not CAP-independent). 30 ms ≫ any other leg's
    // settle time in this test, so chat is deterministically the hottest
    // banked leg and always makes the capped tail.
    mockPrisma.crossModelChat.findUnique.mockImplementation(
      async () => { await new Promise((r) => setTimeout(r, 30)); return sup; },
    );
    const t0 = Date.now();
    const r = await preTriageSupervisorTurn({ origin: 'sweep', chatId: 'sup', pending: [] });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1400); // the deadline fired (not an early throw)
    expect(r.decision).toBeNull(); // failed open
    const warn = (logger.warn as jest.Mock).mock.calls.map((c) => String(c[0])).find((m) => m.includes('supervisor-turn-noop'));
    expect(warn).toBeDefined();
    expect(warn).toContain('supervisor turn facts timed out after 1500ms'); // greppable prefix unchanged
    // FIXED firing 36: assert the chat leg BANKED, wherever it lands in the
    // hottest-first tail. The old `toContain('[chat:')` only matched when chat
    // sorted FIRST — on a fast runner every leg ties at 0–1 ms, chat rounds to
    // 0 and drops to mid-tail, and the literal vanishes (CI 36350297798, red
    // main on ba93f22af). Intent per the docstring: the banked tail exists.
    expect(warn).toMatch(/chat:\d+ms/); // the chat leg banked (position-independent)
    expect(warn).not.toContain('metrics:'); // the stalled leg never banks a settled time
    // FO firing 37: the in-flight sentinel names the stalled leg outright —
    // a live strike is its own diagnosis, no source-diffing needed.
    expect(warn).toContain('stalled:metrics');
    expect(warn).toContain('the sweep turn runs as before'); // fail-open tail unchanged
  });

  it('a fast facts read behaves exactly as before (no warn, no timeout)', async () => {
    const r = await preTriageSupervisorTurn({ origin: 'sweep', chatId: 'sup', pending: [] });
    expect(r.decision).toBeNull(); // shadow mode: decide() null → NO_TRIAGE
    const warns = (logger.warn as jest.Mock).mock.calls.map((c) => String(c[0])).filter((m) => m.includes('supervisor-turn-noop'));
    expect(warns).toHaveLength(0);
  });
});
