/**
 * audit 2026-10-08 W6-2 — the material-change gate at the sweep seam
 * (schedule.service processDueScheduleRow): a stock supervisor SWEEP firing the
 * gate judges non-material is skipped — lastStatus 'skipped:no_material_change',
 * no run / maxRuns budget, the daily-cap token refunded, the Jev stashes closed,
 * one agreement row; a material verdict or a gate error fires exactly as
 * before; a non-sweep prompt never consults the gate. The gate module is
 * mocked here (rule + reads: supervisor-wake-ledger.test.ts).
 *
 * Harness copied from delta-gate.0b1dbe75.test.ts.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../../config/env', () => ({
  __esModule: true,
  env: { NODE_ENV: 'test' },
}));

// ── Prisma: the CRUD paths (create/findFirst/update), the view reads
//    (findMany), and the sweeper fire path (findMany due rows, the atomic
//    claim + skip/persist/bump writes via updateMany, the stale-firing
//    re-read via findUnique). ──
const mockCreate = jest.fn();
const mockCount = jest.fn();
const mockFindFirst = jest.fn();
const mockFindMany = jest.fn();
const mockUpdate = jest.fn();
const mockUpdateMany = jest.fn();
const mockDeleteMany = jest.fn(async (..._a: any[]): Promise<any> => ({ count: 0 }));
const mockScheduleFindUnique = jest.fn(async (..._a: any[]): Promise<any> => ({ enabled: true }));
const mockChatFindUnique = jest.fn();
const mockChatUpdate = jest.fn(async (..._a: any[]) => ({}));
const mockMsgCreate = jest.fn(async (..._a: any[]) => ({}));
const mockRunFindFirst = jest.fn(async (..._a: any[]): Promise<any> => null);
const mockRunCreate = jest.fn(async (..._a: any[]): Promise<any> => ({ id: 'run-dg-1' }));
const mockRunCount = jest.fn(async (..._a: any[]): Promise<number> => 0);
const mockPromptHistoryFindFirst = jest.fn(async (..._a: any[]): Promise<any> => null);
const mockPromptHistoryCount = jest.fn(async (..._a: any[]): Promise<number> => 0);
const mockPromptHistoryCreate = jest.fn(async (..._a: any[]): Promise<any> => ({ id: 'ph-1' }));
// $transaction seam (ticket ae20da66): createSchedule wraps the create + the
// same-cadence collapse in ONE interactive transaction. The tx reuses this
// file's mock fns; the collapse's in-tx stale read gets its OWN mock defaulting
// to [] so pre-collapse tests behave exactly as before.
const mockStaleFindMany = jest.fn(async (..._a: any[]): Promise<any[]> => []);
const mockTransaction = jest.fn(async (fn: any) =>
  typeof fn === 'function'
    ? fn({
        codingSchedule: {
          create: (...a: any[]) => mockCreate(...a),
          findMany: (...a: any[]) => mockStaleFindMany(...a),
          updateMany: (...a: any[]) => mockUpdateMany(...a),
        },
      })
    : Promise.all(fn));

jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    codingSchedule: {
      create: (...a: any[]) => mockCreate(...a),
      count: (...a: any[]) => mockCount(...a),
      findMany: (...a: any[]) => mockFindMany(...a),
      findFirst: (...a: any[]) => mockFindFirst(...a),
      findUnique: (...a: any[]) => mockScheduleFindUnique(...a),
      update: (...a: any[]) => mockUpdate(...a),
      updateMany: (...a: any[]) => mockUpdateMany(...a),
      deleteMany: (...a: any[]) => mockDeleteMany(...a),
    },
    crossModelChat: { findUnique: (...a: any[]) => mockChatFindUnique(...a), update: (...a: any[]) => mockChatUpdate(...a) },
    crossModelMessage: { create: (...a: any[]) => mockMsgCreate(...a) },
    agentRun: {
      findFirst: (...a: any[]) => mockRunFindFirst(...a),
      create: (...a: any[]) => mockRunCreate(...a),
      count: (...a: any[]) => mockRunCount(...a),
    },
    schedulePromptHistory: {
      findFirst: (...a: any[]) => mockPromptHistoryFindFirst(...a),
      count: (...a: any[]) => mockPromptHistoryCount(...a),
      create: (...a: any[]) => mockPromptHistoryCreate(...a),
    },
    $transaction: (fn: any) => mockTransaction(fn),
  },
}));

// ── Redis stand-in: the daily-cap counter (INCR), cap gates (SET NX), the
//    notice consume (GETDEL) and the infra-blocker registry read (HGETALL). ──
const mockStore = new Map<string, string>();
const mockIncr = jest.fn(async (...args: any[]) => {
  const k = String(args[0]);
  const n = (parseInt(mockStore.get(k) ?? '0', 10) || 0) + 1;
  mockStore.set(k, String(n));
  return n;
});
const mockDecr = jest.fn(async (...args: any[]) => {
  const k = String(args[0]);
  const n = (parseInt(mockStore.get(k) ?? '0', 10) || 0) - 1;
  mockStore.set(k, String(n));
  return n;
});
jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: {
    incr: (...a: any[]) => mockIncr(...a),
    incrBy: jest.fn(async () => 1),
    decr: (...a: any[]) => mockDecr(...a),
    expire: jest.fn(async () => true),
    // store-backed NX semantics (FO firing 9's dead-source-alarm pin): the
    // once-per-crossing gate must be exercised honestly, not by stub returns.
    set: jest.fn(async (k: any, v: any, opts?: any) => {
      if (opts?.NX && mockStore.has(String(k))) return null;
      mockStore.set(String(k), String(v));
      return 'OK';
    }),
    del: jest.fn(async (k: any) => { mockStore.delete(String(k)); return 1; }),
    get: jest.fn(async () => null),
    getDel: jest.fn(async () => null),
    pTTL: jest.fn(async () => -2),
    publish: jest.fn(async () => 1),
    hGetAll: jest.fn(async () => ({})),
    hSet: jest.fn(async () => 1),
    hDel: jest.fn(async () => 0),
  },
}));

// fetchPremiseSource's SSRF guard DNS-checks every probe host — resolve them
// all to a public address (the guard's own matrix lives in
// premise-register.test.ts; here every probe host is legitimately public).
jest.mock('dns', () => ({
  promises: { lookup: jest.fn(async (..._a: any[]): Promise<any> => [{ address: '93.184.216.34', family: 4 }]) },
}));

// The daily-cap grant lookup (capForSession → autonomy.service dynamic import).
jest.mock('../platform/autonomy.service', () => ({
  __esModule: true,
  getChatAutonomy: jest.fn(async (..._a: any[]): Promise<any> => null),
}));

const mockEmitHookEvent = jest.fn(async (..._a: any[]): Promise<any> => {});
jest.mock('../platform/hooks.service', () => ({
  __esModule: true,
  emitHookEvent: (...a: any[]) => mockEmitHookEvent(...a),
  emitHookEventSafe: (...a: any[]) => mockEmitHookEvent(...a),
  sweepHookEvents: (...a: any[]) => mockEmitHookEvent(...a),
}));

// The coding fire path (dynamic import in fireScheduleTarget).
const mockStartScheduledRun = jest.fn(async (..._a: any[]): Promise<any> => ({ started: true }));
jest.mock('./coding-stream.controller', () => ({
  __esModule: true,
  startScheduledRun: (...a: any[]) => mockStartScheduledRun(...a),
}));

// Decision gate (delta_material) — OFF by default (hermetic, like the hooks
// suite); the WI-C outcome-label cases flip it to shadow per test.
const mockDecisionMode = jest.fn((): 'off' | 'shadow' | 'act' => 'off');
const mockDecide = jest.fn(async (..._a: any[]): Promise<any> => null);
const mockRecordDecisionOutcome = jest.fn();
jest.mock('../platform/decision-gate', () => ({
  __esModule: true,
  ...(jest.requireActual('../platform/decision-gate')),
  decide: (...a: any[]) => mockDecide(...a),
  decisionMode: () => mockDecisionMode(),
  decisionThreshold: (_p: string, fallback: number) => fallback,
  recordDecisionOutcome: (...a: any[]) => mockRecordDecisionOutcome(...a),
}));

// The plain-chat fire path (dynamic import in fireScheduleTarget).
const mockStartDetachedChatRun = jest.fn(async (..._a: any[]): Promise<boolean> => true);
jest.mock('../chat-agent/chat-agent.service', () => ({
  __esModule: true,
  startDetachedChatRun: (...a: any[]) => mockStartDetachedChatRun(...a),
  chatRunKey: (id: string) => `chat:${id}`,
}));

// The terminal-stop resolver seam — no closed-ticket refs in these prompts.
jest.mock('../feedback/feedback.service', () => ({
  __esModule: true,
  getFeedbackTicketById: jest.fn(async (..._a: any[]): Promise<any> => null),
}));

// The continuation staleness guard's plan re-read (never reached here — no
// [HARNESS CONTINUATION] prompts — but the import must resolve).
jest.mock('./plan.service', () => ({
  __esModule: true,
  ...(jest.requireActual('./plan.service')),
  getPlanStrict: jest.fn(async (..._a: any[]): Promise<any> => null),
}));

// Loop-metrics: fire-and-forget — silence it; kinds carry their REAL values
// (the delta-gate metrics are asserted below).
const mockRecordLoopMetric: jest.Mock = jest.fn();
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
  LOOP_METRIC_KINDS: {
    SWEEP_TICK: 'sweep_tick',
    WAKE_DELIVERED: 'wake_delivered',
    SCHEDULE_BUSY_SKIP: 'schedule_busy_skip',
    SCHEDULE_SWEEP_SKIP: 'schedule_sweep_skip',
  },
}));

// Sweep pre-triage (decision gate N2, 2026-09-25) — the leaf is mocked to the
// no-triage default; the wiring cases below drive it per test.
const mockPreTriageSweepFiring = jest.fn(async (..._a: any[]): Promise<any> => ({ sweep: null, decision: null, stash: null, skip: null }));
jest.mock('../platform/sweep-triage', () => ({
  __esModule: true,
  ...(jest.requireActual('../platform/sweep-triage')),
  preTriageSweepFiring: (...a: any[]) => mockPreTriageSweepFiring(...a),
}));

// The dormancy/goal gate (ticket b1d435fd) runs BEFORE the delta gate at fire
// time and in createSchedule for machine recurring arms — mocked live-work so
// these tests isolate the delta gate (its own suite covers the gate itself).
const mockEvaluateScheduleDormancy = jest.fn(async (..._a: any[]): Promise<any> => ({
  dormant: false, projectId: 'p1', reason: 'test: project has live work',
  signals: { activeGoals: 1, openTodos: 0, liveRuns: 0, watchedResources: 0 },
}));
jest.mock('./dormancy-gate.service', () => ({
  __esModule: true,
  DORMANT_LAST_STATUS: 'parked:dormant',
  evaluateScheduleDormancy: (...a: any[]) => mockEvaluateScheduleDormancy(...a),
}));

// The spend-cap gate also runs before the delta gate — default OFF (null).
// requireActual keeps the notice helpers real for the fire-path consume.
jest.mock('./spend-cap.service', () => ({
  __esModule: true,
  ...(jest.requireActual('./spend-cap.service')),
  checkSpendCap: jest.fn(async (..._a: any[]): Promise<any> => null),
  recordSpendCapSkip: jest.fn(async (..._a: any[]) => {}),
  maybeAskSpendCapQuestion: jest.fn(async (..._a: any[]) => {}),
  consumeSpendCapSkipNotice: jest.fn(async (..._a: any[]): Promise<number> => 0),
  restoreSpendCapSkipNotice: jest.fn(async (..._a: any[]) => {}),
}));

// Lane-revival auto-resolve (createSchedule recurring path, dynamic import).
jest.mock('../platform/owner-questions', () => ({
  __esModule: true,
  resolveStoppedScheduleDecisionsForSession: jest.fn(async (..._a: any[]): Promise<number> => 0),
  flagOwnerQuestion: jest.fn(async (..._a: any[]): Promise<any> => ({ kind: 'created', question: { id: 'oq_dg' } })),
}));

jest.mock('./stopped-schedule-alert', () => ({
  __esModule: true,
  queueStoppedScheduleAlert: jest.fn(),
  maybeFileStoppedScheduleDecision: jest.fn(async (..._a: any[]) => ({ filed: false, reason: 'lane_alive' })),
}));


const mockMaterialGateForSweep: jest.Mock = jest.fn(async (): Promise<any> => null);
const mockRecordAgreement: jest.Mock = jest.fn();
const mockCloseStashes: jest.Mock = jest.fn(async () => {});
jest.mock('../platform/supervisor-wake-ledger', () => ({
  __esModule: true,
  materialGateForSweep: (...a: any[]) => mockMaterialGateForSweep(...a),
  recordMaterialGateAgreement: (...a: any[]) => mockRecordAgreement(...a),
  closeStashesForGateSkip: (...a: any[]) => mockCloseStashes(...a),
}));

import { fireDue } from './schedule.service';

const liveRow = (over: Record<string, unknown> = {}) => ({
  id: 'sch_1', sessionId: 's1', userId: 'u1', prompt: 'watch the bench score', kind: 'recurring',
  intervalSec: 3600, nextRunAt: new Date(Date.now() - 1000), enabled: true,
  runsCount: 3, maxRuns: 500, expiresAt: new Date(Date.now() + 10 * 24 * 3600 * 1000),
  lastFiredAt: new Date(Date.now() - 3600_000), lastStatus: 'started', createdAt: new Date(),
  promptSetBy: 'system', deltaGate: null, ...over,
});

const SWEEP_PROMPT = 'Project Supervisor sweep for "Schooltime" (projectId b33a1283-ac14-44ab-a0e7-9db0eb853a18) — a GOAL LEDGER diff, not a status bulletin.';
const STASH = { id: 'st1', purpose: 'sweep_triage', mode: 'shadow', backend: 'TypeSafe Jev', answers: { needs_turn_now: { type: 'noul', noul: 0.6 } }, decidedAt: '2026-10-08T16:00:00.000Z' };
const skipVerdict = { origin: 'sweep', chatId: 's1', mode: 'act', skip: true, verdict: { material: false, reasons: [], heartbeat: false, sinceMin: 50, floorHours: 4 } };

beforeEach(() => {
  jest.clearAllMocks();
  mockStore.clear();
  mockFindMany.mockResolvedValue([liveRow({ prompt: SWEEP_PROMPT, intervalSec: 7200 })]);
  mockUpdateMany.mockResolvedValue({ count: 1 });
  mockUpdate.mockResolvedValue({});
  mockChatFindUnique.mockResolvedValue({ userId: 'u1', mode: 'auto', codingState: { id: 'cs1' } });
  mockStartScheduledRun.mockResolvedValue({ started: true });
  mockPreTriageSweepFiring.mockResolvedValue({ sweep: 'project', decision: { id: 'st1' }, stash: STASH, skip: null });
  mockMaterialGateForSweep.mockResolvedValue(null);
});

describe('W6-2 material gate × stock sweep firing', () => {
  it('a NON-material sweep is skipped: lastStatus skipped:no_material_change, no run, no budget, cap token refunded, the Jev stash closed + compared', async () => {
    mockMaterialGateForSweep.mockResolvedValue(skipVerdict);
    await fireDue();
    expect(mockMaterialGateForSweep).toHaveBeenCalledWith({ chatId: 's1' });
    expect(mockStartScheduledRun).not.toHaveBeenCalled();
    expect(mockStartDetachedChatRun).not.toHaveBeenCalled();
    expect(mockUpdate.mock.calls.some((c) => c[0]?.where?.id === 'sch_1' && c[0]?.data?.lastStatus === 'skipped:no_material_change')).toBe(true);
    expect(mockUpdateMany.mock.calls.map((c) => c[0]).filter((u) => u?.data?.runsCount != null)).toHaveLength(0);
    expect(mockDecr).toHaveBeenCalled();
    expect(mockRecordAgreement).toHaveBeenCalledWith(skipVerdict, [STASH, null]);
    expect(mockCloseStashes).toHaveBeenCalledWith([STASH, null], 's1', 'sweep');
  });

  it('a MATERIAL verdict fires exactly as before (the stash rides the run)', async () => {
    mockMaterialGateForSweep.mockResolvedValue({ ...skipVerdict, skip: false, verdict: { ...skipVerdict.verdict, material: true, reasons: ['stall'] } });
    await fireDue();
    expect(mockStartScheduledRun).toHaveBeenCalledTimes(1);
    expect(mockStartScheduledRun.mock.calls[0][2].decision).toEqual(STASH);
    expect(mockCloseStashes).not.toHaveBeenCalled();
  });

  it('a gate that throws fails open; a non-sweep prompt never consults the gate', async () => {
    mockMaterialGateForSweep.mockRejectedValue(new Error('boom'));
    await fireDue();
    expect(mockStartScheduledRun).toHaveBeenCalledTimes(1);

    jest.clearAllMocks();
    mockFindMany.mockResolvedValue([liveRow({ prompt: 'watch the bench score' })]);
    mockUpdateMany.mockResolvedValue({ count: 1 });
    mockChatFindUnique.mockResolvedValue({ userId: 'u1', mode: 'auto', codingState: { id: 'cs1' } });
    mockStartScheduledRun.mockResolvedValue({ started: true });
    mockPreTriageSweepFiring.mockResolvedValue({ sweep: null, decision: null, stash: null, skip: null });
    await fireDue();
    expect(mockMaterialGateForSweep).not.toHaveBeenCalled();
    expect(mockStartScheduledRun).toHaveBeenCalledTimes(1);
  });
});
