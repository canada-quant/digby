/**
 * Project-supervisor spawn guard + circuit breaker (2026-09-14) — the
 * supervisor lane of start_coding_session (platform-tools.ts
 * projectSupervisorSpawnGuard). Owner doctrine: VERY HIGH, hardware-bound
 * fan-out caps — but a DETERMINISTIC breaker so a spawn+completion storm
 * (the 25-chat dispatch-storm shape) cannot self-amplify.
 *
 * Covered:
 *   - all-clear supervisor spawn proceeds (very-high caps, not the plain 8/h)
 *   - STORM SIMULATION (Project-supervisor preflight 2026-09-14: OBSERVE-ONLY by
 *     default): the Nth allowed spawn over the 10-min cap TRIPS the breaker —
 *     one metric row, cooldown key set — but the spawn PROCEEDS with an
 *     advisory appended; DIGBY_PROJECT_SUPERVISOR_STORM_ENFORCE=1 restores the
 *     refusal (and the cheapest-first trip-key refusal before any DB work)
 *   - a budget-reason trip key still refuses (that branch is owner opt-in)
 *   - token-budget circuit breaker: trailing-24h project spend over the daily
 *     envelope refuses AND trips (reason 'budget'), reported to the Fleet Supervisor
 *   - concurrent-active ceiling (2026-10-20 — tracks the coding box for real):
 *     explicit DIGBY_PROJECT_SUPERVISOR_MAX_ACTIVE_WORKERS wins → the coding
 *     worker's LIVE machine-claimable slots from the Redis slot registry
 *     (coding/worker-slots.ts: concurrency − the 1-slot interactive reserve,
 *     newest entry per box, boxes summed, stale entries ignored,
 *     WORKER_SLOT_REGISTRY_DISABLED=1 skips it) → this process's own
 *     CODING_WORKER_CONCURRENCY − 1 → 24; no 64 clamp; a refusal writes ONE
 *     project_supervisor_breaker row reason 'concurrency' {activeCount, cap,
 *     capSource} and no trip key; counts this supervisor's children in ANY
 *     project (hardening 2026-09-14 — the box's slots are shared, a
 *     per-project filter undercounted)
 *   - hourly-rate cap: OBSERVE-ONLY (hardening 2026-09-14 — a harness constant,
 *     not hardware): ONE metric row reason 'rate' + advisory, spawn proceeds,
 *     NO trip key; DIGBY_PROJECT_SUPERVISOR_RATE_ENFORCE=1 restores the refusal
 *   - storm-window hygiene (hardening 2026-09-14): a spawn that FAILS after the
 *     INCR gives the slot back (DECR); a lost EXPIRE self-heals (pTTL<0 → expire)
 *   - project-supervisor parent → NO per-child result hook for an IN-PROJECT
 *     child (the project-scope hook already covers it); a child that RESOLVED
 *     into another project gets the direct hook + an honest note (hardening
 *     2026-09-14); plain parents keep the hook
 *   - tool-description pins: no money/cost owner-card class in
 *     flag_owner_question / answer_owner_question; update_project says
 *     projectSupervisorEnabled is owner-only; start_coding_session documents
 *     the project-supervisor hook exception
 *   - fail-open doctrine: Redis/DB/ledger hiccups never freeze the fleet
 *   - plain (non-supervisor) parents keep the byte-identical 8/h guard
 *
 * Scaffolding mirrors platform-tools.subsessions.test.ts (do not modify that file).
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
// tools.ts transitively imports plan.service → context-store → DB/env (process.exit).
jest.mock('../memory/context-store', () => ({
  __esModule: true,
  storeGet: jest.fn(async () => null),
  storePut: jest.fn(async () => {}),
}));
jest.mock('../coding/coding-retrieval.service', () => ({
  __esModule: true,
  searchMemory: jest.fn(async () => []),
  storeFindings: jest.fn(async () => 0),
  clearSessionMemory: jest.fn(async () => {}),
}));
jest.mock('../coding/process.service', () => ({
  __esModule: true,
  startBackgroundProcess: jest.fn(async () => ({ handle: 'p1', name: 'cmd: x', pgid: 1, logPath: '/tmp/p1.log' })),
  waitForProcessOutput: jest.fn(async () => ({ outcome: 'exited', detail: '', exitCode: '0' })),
  readProcessOutput: jest.fn(async () => ({ chunk: 'ok', nextOffset: 2, status: 'exited', exitCode: '0' })),
  releaseHandle: jest.fn(),
  stopProcess: jest.fn(async () => ''),
  listProcesses: jest.fn(async () => ''),
  processSnapshot: jest.fn(() => []),
}));
jest.mock('../coding/code-index.service', () => ({
  __esModule: true,
  searchCodeSemantic: jest.fn(async () => []),
  syncCodeIndex: jest.fn(async () => ({ changed: 0, removed: 0, skipped: true })),
  kickCodeIndexSync: jest.fn(),
}));
jest.mock('../../../middleware/agent-auth', () => ({
  __esModule: true,
  AGENT_TOKEN_SCOPES: [
    'chats:read', 'chats:write', 'folders:read', 'folders:write', 'schedules:write', 'code:run',
  ] as const,
}));

// The service layer under the tools — fully mocked.
const svc = {
  listChats: jest.fn(),
  createChat: jest.fn(),
  getChatStatus: jest.fn(),
  getChatMessages: jest.fn(),
  sendChatMessage: jest.fn(),
  renameChat: jest.fn(),
  archiveChat: jest.fn(),
  moveChat: jest.fn(),
  deleteChat: jest.fn(),
  createProject: jest.fn(),
  getProject: jest.fn(),
  updateProject: jest.fn(),
  deleteProject: jest.fn(),
  moveFolder: jest.fn(),
  startCodingSession: jest.fn(),
  scheduleChatRun: jest.fn(),
  listSchedules: jest.fn(),
  cancelSchedule: jest.fn(),
};
jest.mock('./platform.service', () => ({ __esModule: true, ...svc }));

const fb = {
  FEEDBACK_TYPES: ['feature_request', 'bug_report', 'general_feedback', 'mishap', 'enhancement', 'research_idea'] as const,
  fileFeedbackTicket: jest.fn(),
  listFeedbackTickets: jest.fn(),
  updateFeedbackTicket: jest.fn(),
  isAdminUser: jest.fn(),
};
jest.mock('../feedback/feedback.service', () => ({ __esModule: true, ...fb }));

const autonomySvc = {
  AUTONOMY_GRANTABLE_TOOLS: ['send_chat_message', 'start_coding_session', 'schedule_message', 'cancel_schedule'] as const,
  DEFAULT_SCHEDULE_CAP: 48,
  MAX_SCHEDULE_CAP: 1440,
  getChatAutonomy: jest.fn(),
  setChatAutonomy: jest.fn(),
  auditAutonomousExecution: jest.fn(async () => {}),
  implicitParentAutonomyAllows: jest.fn(async () => false),
};
jest.mock('./autonomy.service', () => ({ __esModule: true, ...autonomySvc }));

// hooks.service is loaded via DYNAMIC import at the spawn seam — mock the helper.
const mockEnsureChildResultHook: jest.Mock = jest.fn();
jest.mock('./hooks.service', () => ({
  __esModule: true,
  ensureChildResultHook: (...a: any[]) => mockEnsureChildResultHook(...a),
}));

// run-journal.service is loaded via DYNAMIC import at the spawn seam.
const mockBuildParentContextBlock: jest.Mock = jest.fn(async () => '');
jest.mock('../coding/run-journal.service', () => ({
  __esModule: true,
  buildParentContextBlock: (...a: any[]) => mockBuildParentContextBlock(...a),
}));

// Redis — the guard's breaker state (dynamic import). Indirection consts so
// clearAllMocks doesn't kill the wiring (canonical pattern).
const mockRedisGet: jest.Mock = jest.fn(async () => null);
const mockRedisSet: jest.Mock = jest.fn(async () => 'OK');
const mockRedisIncr: jest.Mock = jest.fn(async () => 1);
const mockRedisExpire: jest.Mock = jest.fn(async () => 1);
const mockRedisTtl: jest.Mock = jest.fn(async () => -1);
// Hardening 2026-09-14: DECR (release on a failed spawn) + pTTL (lost-EXPIRE heal).
const mockRedisDecr: jest.Mock = jest.fn(async () => 0);
const mockRedisPttl: jest.Mock = jest.fn(async () => 300_000);
// 2026-10-20: the live worker-slot registry hash (coding/worker-slots.ts) the ceiling reads.
const mockRedisHGetAll: jest.Mock = jest.fn(async () => ({}));
const mockRedisHSet: jest.Mock = jest.fn(async () => 1);
const mockRedisHDel: jest.Mock = jest.fn(async () => 1);
jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: {
    get: (...a: any[]) => mockRedisGet(...a),
    set: (...a: any[]) => mockRedisSet(...a),
    incr: (...a: any[]) => mockRedisIncr(...a),
    expire: (...a: any[]) => mockRedisExpire(...a),
    ttl: (...a: any[]) => mockRedisTtl(...a),
    decr: (...a: any[]) => mockRedisDecr(...a),
    pTTL: (...a: any[]) => mockRedisPttl(...a),
    hGetAll: (...a: any[]) => mockRedisHGetAll(...a),
    hSet: (...a: any[]) => mockRedisHSet(...a),
    hDel: (...a: any[]) => mockRedisHDel(...a),
  },
}));

// The spend ledger (dynamic import in the guard).
const mockTrailingSpend: jest.Mock = jest.fn(async () => ({
  chatUsd: 0, projectUsd: 0, projectId: 'proj-1', chatCodingUsd: 0, projectCodingUsd: 0,
}));
jest.mock('../coding/spend-cap.service', () => ({
  __esModule: true,
  trailingSpend24h: (...a: any[]) => mockTrailingSpend(...a),
}));

// loop-metrics (dynamic import in the trip helper) — records breaker trips.
const mockRecordLoopMetric: jest.Mock = jest.fn();
/** Breaker rows only — the session-topology pre-check (2026-09-27) writes its own observe-only `session_topology` row per spawn. */
const breakerCalls = () => mockRecordLoopMetric.mock.calls.filter((c: any[]) => c[0]?.kind === 'project_supervisor_breaker');
jest.mock('./loop-metrics.service', () => ({
  __esModule: true,
  LOOP_METRIC_KINDS: { PROJECT_SUPERVISOR_BREAKER: 'project_supervisor_breaker' },
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
}));

import { createPendingConfirmationTable } from './pending-confirmations.testkit';

// config/database: the pending-confirmations registry PLUS the lineage reads/
// writes and the guard's DB checks (children findMany, coding states, live
// agent runs, hourly count).
const mockConfirmations = createPendingConfirmationTable();
const mockChatFindUnique: jest.Mock = jest.fn();
const mockChatUpdate: jest.Mock = jest.fn(async () => ({}));
const mockChatCount: jest.Mock = jest.fn(async () => 0);
const mockChatFindMany: jest.Mock = jest.fn(async () => []);
const mockCodingStateFindMany: jest.Mock = jest.fn(async () => []);
const mockAgentRunFindMany: jest.Mock = jest.fn(async () => []);
// Supervisor OFF switch (owner 2026-09-26): the SystemSetting read behind the
// spawn refusal — null (no row) = ON, every pre-existing test untouched.
const mockSettingFind: jest.Mock = jest.fn(async () => null);
// Session titles (2026-09-27): the goalId / todoId charter resolution in the spawn executor.
const mockTodoFindFirst: jest.Mock = jest.fn(async () => null);
const mockGoalFindFirst: jest.Mock = jest.fn(async () => null);
// audit 2026-10-06 T5-1: the ENABLED project-scope hook probe (default: a live hook — today's covered branch).
const mockEventHookFindFirst: jest.Mock = jest.fn(async () => ({ id: 'proj-hook-1' }));
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    pendingConfirmation: mockConfirmations.api,
    crossModelChat: {
      findUnique: (...a: any[]) => mockChatFindUnique(...a),
      update: (...a: any[]) => mockChatUpdate(...a),
      count: (...a: any[]) => mockChatCount(...a),
      findMany: (...a: any[]) => mockChatFindMany(...a),
    },
    chatCodingState: {
      findMany: (...a: any[]) => mockCodingStateFindMany(...a),
    },
    agentRun: {
      findMany: (...a: any[]) => mockAgentRunFindMany(...a),
    },
    systemSetting: {
      findUnique: (...a: any[]) => mockSettingFind(...a),
    },
    projectTodo: {
      findFirst: (...a: any[]) => mockTodoFindFirst(...a),
    },
    projectGoal: {
      findFirst: (...a: any[]) => mockGoalFindFirst(...a),
    },
    eventHook: {
      findFirst: (...a: any[]) => mockEventHookFindFirst(...a),
    },
  },
}));

import { executePlatformTool, PLATFORM_TOOL_SCHEMA, buildCharterFirstPrompt } from './platform-tools';
import { ToolContext } from '../coding/tools';

function makeCtx(overrides: Partial<ToolContext> = {}) {
  const ctx = {
    worktree: '/wt', sessionId: 'sess-sup', userId: 'u1', permissionMode: 'auto',
    emit: () => {}, alwaysAllow: new Set<string>(),
    requestApproval: async () => 'allow' as const,
    execShell: async () => ({ stdout: '', stderr: '' }),
    ...overrides,
  } as unknown as ToolContext;
  return ctx;
}

/** Auto-mode coding orchestrator — full autonomy, so consequential spawns
 *  execute in ONE call (the seams under test live in the dispatch case). */
const autoCodingCtx = () => makeCtx({ agentSurface: 'coding' } as any);

const SPAWNED = {
  id: 'sess-new', title: 'Worker task', projectId: 'proj-1',
  branch: 'digby/session-new', baseBranch: 'main', model: 'glm-5.3', permissionMode: 'auto',
};

/** The calling chat IS a project supervisor for proj-1 (the lane under test). */
const SUPERVISOR_CALLER = { id: 'sess-sup', userId: 'u1', isProjectSupervisor: true, projectId: 'proj-1' };

const GUARD_ENVS = [
  'DIGBY_PROJECT_SUPERVISOR_SPAWNS_PER_HOUR',
  'DIGBY_PROJECT_SUPERVISOR_MAX_ACTIVE_WORKERS',
  'DIGBY_PROJECT_SUPERVISOR_DAILY_BUDGET_USD',
  'DIGBY_PROJECT_SUPERVISOR_STORM_MAX_SPAWNS_10MIN',
  'DIGBY_PROJECT_SUPERVISOR_STORM_COOLDOWN_SEC',
  // Project-supervisor preflight 2026-09-14
  'DIGBY_PROJECT_SUPERVISOR_STORM_ENFORCE',
  // Hardening 2026-09-14: the hourly rate cap is observe-only unless armed.
  'DIGBY_PROJECT_SUPERVISOR_RATE_ENFORCE',
  'CODING_WORKER_CONCURRENCY',
  // 2026-10-20: the live slot registry's kill switch.
  'WORKER_SLOT_REGISTRY_DISABLED',
];

/** A worker-slot registry hash entry as coding/worker-slots.ts publishes it (default: box C's 32 slots, fresh). */
function slotEntry(over: Partial<{ workerId: string; box: string; concurrency: number; machineSlots: number; at: string }> = {}) {
  const concurrency = over.concurrency ?? 32;
  const e = {
    workerId: over.workerId ?? 'worker-c-1',
    box: over.box ?? 'box-c',
    concurrency,
    machineSlots: over.machineSlots ?? (concurrency > 1 ? concurrency - 1 : concurrency),
    at: over.at ?? new Date().toISOString(),
  };
  return [e.workerId, JSON.stringify(e)] as const;
}
function liveRegistry(...entries: ReadonlyArray<readonly [string, string]>) {
  mockRedisHGetAll.mockResolvedValue(Object.fromEntries(entries));
}

/** The trip-key value shape written by tripProjectSupervisorBreaker (JSON {at, reason}). */
const tripValue = (reason: 'storm' | 'budget', at = '2026-09-14T02:00:00.000Z') => JSON.stringify({ at, reason });

/** Fill the concurrency ceiling: N children, all with a live agent run. */
function fillActiveWorkers(n: number) {
  const ids = Array.from({ length: n }, (_, i) => `child-${i}`);
  mockChatFindMany.mockResolvedValue(ids.map((id) => ({ id })));
  mockAgentRunFindMany.mockResolvedValue(ids.map((id) => ({ sessionId: id })));
}

beforeEach(() => {
  jest.clearAllMocks();
  mockConfirmations.reset();
  for (const k of GUARD_ENVS) delete process.env[k];
  autonomySvc.getChatAutonomy.mockResolvedValue(null);
  svc.startCodingSession.mockResolvedValue({ ...SPAWNED });
  mockChatFindUnique.mockResolvedValue(SUPERVISOR_CALLER);
  mockChatUpdate.mockResolvedValue({});
  mockChatCount.mockResolvedValue(0);
  mockChatFindMany.mockResolvedValue([]);
  mockCodingStateFindMany.mockResolvedValue([]);
  mockAgentRunFindMany.mockResolvedValue([]);
  mockRedisGet.mockResolvedValue(null);
  mockRedisSet.mockResolvedValue('OK');
  mockRedisIncr.mockResolvedValue(1);
  mockRedisExpire.mockResolvedValue(1);
  mockRedisTtl.mockResolvedValue(-1);
  mockRedisDecr.mockResolvedValue(0);
  mockRedisPttl.mockResolvedValue(300_000); // a healthy window: TTL present
  mockRedisHGetAll.mockResolvedValue({}); // no worker has published its slots — the env / default chain applies
  mockTrailingSpend.mockResolvedValue({ chatUsd: 0, projectUsd: 0, projectId: 'proj-1', chatCodingUsd: 0, projectCodingUsd: 0 });
  mockEnsureChildResultHook.mockResolvedValue({ id: 'hook-1', sourceChatId: 'sess-new', targetChatId: 'sess-sup' });
  mockBuildParentContextBlock.mockResolvedValue('');
  mockEventHookFindFirst.mockResolvedValue({ id: 'proj-hook-1' });
  mockTodoFindFirst.mockResolvedValue(null);
  mockGoalFindFirst.mockResolvedValue(null);
  delete process.env.PAUSED_SUPERVISOR_CHILD_HOOK_DISABLED;
  delete process.env.SPAWN_CHARTER_FIRST_PROMPT_DISABLED;
});

describe('project-supervisor spawn lane — all clear', () => {
  it('a supervisor parent spawns under the very-high caps (not the plain 8/h)', async () => {
    // 10 children in the last hour — over the PLAIN cap (8) but far under the
    // supervisor cap (32): the lane split must take the supervisor path.
    mockChatCount.mockResolvedValue(10);
    const out = await executePlatformTool(autoCodingCtx(), 'start_coding_session', { projectId: 'proj-1', title: 'Worker task' });
    expect(out).not.toContain('spawn REFUSED');
    expect(svc.startCodingSession).toHaveBeenCalled();
    // Allowed spawn feeds the storm window (real fan-out velocity).
    expect(mockRedisIncr).toHaveBeenCalledWith('coding:proj-sup:storm:proj-1');
    expect(mockRedisExpire).toHaveBeenCalledWith('coding:proj-sup:storm:proj-1', 600);
    // Lineage still recorded on the child.
    expect(mockChatUpdate).toHaveBeenCalledWith({ where: { id: 'sess-new' }, data: { parentChatId: 'sess-sup' } });
  });

  it('a PLAIN (non-supervisor) parent keeps the byte-identical 8/h guard', async () => {
    mockChatFindUnique.mockResolvedValue({ id: 'sess-1', userId: 'u1', isProjectSupervisor: false, projectId: 'proj-1' });
    mockChatCount.mockResolvedValue(8);
    const out = await executePlatformTool(makeCtx({ agentSurface: 'coding', sessionId: 'sess-1' } as any), 'start_coding_session', { projectId: 'proj-1', title: 'Ninth child' });
    expect(out).toContain('spawn REFUSED');
    expect(out).toContain('DIGBY_MAX_CHILD_SPAWNS_PER_HOUR');
    // The supervisor lane's Redis breaker is never consulted for plain parents.
    expect(mockRedisIncr).not.toHaveBeenCalled();
    expect(mockRedisGet).not.toHaveBeenCalled();
  });
});

describe('project-supervisor spawn lane — STORM SIMULATION (OBSERVE-ONLY by default; Project-supervisor preflight 2026-09-14)', () => {
  it('DEFAULT: the allowed spawn that exceeds the 10-min storm cap TRIPS the breaker (one metric row + trip key) but PROCEEDS with an advisory', async () => {
    // Simulate a runaway: 12 spawns already landed inside the window (the cap),
    // this 13th is the spillover. The window only ever counts ALLOWED spawns.
    mockRedisIncr.mockResolvedValue(13);
    const out = await executePlatformTool(autoCodingCtx(), 'start_coding_session', { projectId: 'proj-1', title: 'Storm child 13' });
    // Observe-only: no refusal, the spawn happened …
    expect(out).not.toContain('spawn REFUSED');
    expect(out).toContain('Started coding session sess-new');
    expect(svc.startCodingSession).toHaveBeenCalledTimes(1);
    // … and the advisory rides the normal spawn result.
    expect(out).toContain('ADVISORY (observe-only anti-runaway breaker)');
    expect(out).toContain('13 supervisor-lane spawns in the last 10 minutes exceeded the storm cap 12');
    expect(out).toContain('DIGBY_PROJECT_SUPERVISOR_STORM_MAX_SPAWNS_10MIN');
    expect(out).toContain('DIGBY_PROJECT_SUPERVISOR_STORM_ENFORCE=1');
    expect(out).toContain('Fleet Supervisor');
    // Telemetry unchanged: cooldown key written NX with the cooldown TTL and the
    // reason encoded in the value …
    expect(mockRedisSet).toHaveBeenCalledWith(
      'coding:proj-sup:storm-tripped:proj-1',
      expect.stringContaining('"reason":"storm"'),
      { EX: 1800, NX: true },
    );
    // … and exactly ONE loop_metrics row, reason 'storm'.
    expect(breakerCalls()).toHaveLength(1);
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'project_supervisor_breaker',
      sessionId: 'sess-sup',
      meta: expect.objectContaining({ projectId: 'proj-1', reason: 'storm', cap: 12 }),
    }));
  });

  it('ENFORCE (DIGBY_PROJECT_SUPERVISOR_STORM_ENFORCE=1): the spillover spawn TRIPS and is REFUSED', async () => {
    process.env.DIGBY_PROJECT_SUPERVISOR_STORM_ENFORCE = '1';
    mockRedisIncr.mockResolvedValue(13);
    const out = await executePlatformTool(autoCodingCtx(), 'start_coding_session', { projectId: 'proj-1', title: 'Storm child 13' });
    expect(out).toContain('spawn REFUSED');
    expect(out).toContain('anti-runaway circuit breaker');
    expect(out).toContain('DIGBY_PROJECT_SUPERVISOR_STORM_MAX_SPAWNS_10MIN');
    expect(svc.startCodingSession).not.toHaveBeenCalled();
    expect(mockRedisSet).toHaveBeenCalledWith(
      'coding:proj-sup:storm-tripped:proj-1',
      expect.stringContaining('"reason":"storm"'),
      { EX: 1800, NX: true },
    );
    expect(breakerCalls()).toHaveLength(1);
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({
      meta: expect.objectContaining({ projectId: 'proj-1', reason: 'storm', cap: 12 }),
    }));
  });

  it('a concurrent trip race writes NO second metric row (NX loser; spawn still proceeds in observe mode)', async () => {
    // Two spawns both passed the trip-key GET before either tripped; this one
    // breaches too but LOSES the NX race — the trip is recorded exactly once
    // (by the winner). Observe-only: it still proceeds, advisory attached.
    mockRedisIncr.mockResolvedValue(14);
    mockRedisSet.mockResolvedValue(null); // NX lost — key already existed
    const out = await executePlatformTool(autoCodingCtx(), 'start_coding_session', { projectId: 'proj-1', title: 'Racing spawn' });
    expect(out).not.toContain('spawn REFUSED');
    expect(out).toContain('ADVISORY (observe-only anti-runaway breaker)');
    expect(svc.startCodingSession).toHaveBeenCalledTimes(1);
    expect(mockRedisSet).toHaveBeenCalledWith(
      'coding:proj-sup:storm-tripped:proj-1',
      expect.any(String),
      { EX: 1800, NX: true },
    );
    expect(breakerCalls()).toHaveLength(0);
  });

  it('DEFAULT: a subsequent spawn during a STORM cooldown proceeds with an advisory — the remaining checks still run', async () => {
    mockRedisGet.mockResolvedValue(tripValue('storm'));
    mockRedisTtl.mockResolvedValue(1700);
    const out = await executePlatformTool(autoCodingCtx(), 'start_coding_session', { projectId: 'proj-1', title: 'Post-trip attempt' });
    expect(out).not.toContain('spawn REFUSED');
    expect(out).toContain('ADVISORY (observe-only anti-runaway breaker)');
    expect(out).toContain('tripped until 2026-09-14T02:28:20.000Z');
    expect(out).toContain('DIGBY_PROJECT_SUPERVISOR_STORM_ENFORCE=1');
    expect(svc.startCodingSession).toHaveBeenCalledTimes(1);
    // Observe-only does not short-circuit: ceiling/hourly checks and the storm
    // window still ran (real velocity keeps being measured).
    expect(mockChatFindMany).toHaveBeenCalled();
    expect(mockChatCount).toHaveBeenCalled();
    expect(mockRedisIncr).toHaveBeenCalledWith('coding:proj-sup:storm:proj-1');
    // No fresh trip row while the key already exists (INCR=1 here — below cap).
    expect(breakerCalls()).toHaveLength(0);
  });

  it('DEFAULT: a LEGACY plain-ISO trip-key value (pre-preflight deploy) is read as a storm trip — advisory, not refusal', async () => {
    mockRedisGet.mockResolvedValue('2026-09-14T02:00:00.000Z');
    mockRedisTtl.mockResolvedValue(1700);
    const out = await executePlatformTool(autoCodingCtx(), 'start_coding_session', { projectId: 'proj-1', title: 'Post-trip attempt' });
    expect(out).not.toContain('spawn REFUSED');
    expect(out).toContain('ADVISORY (observe-only anti-runaway breaker)');
    expect(out).toContain('tripped until 2026-09-14T02:28:20.000Z');
    expect(svc.startCodingSession).toHaveBeenCalledTimes(1);
  });

  it('ENFORCE: a subsequent spawn during the cooldown is refused at the TRIP KEY — before any DB work', async () => {
    process.env.DIGBY_PROJECT_SUPERVISOR_STORM_ENFORCE = '1';
    mockRedisGet.mockResolvedValue(tripValue('storm'));
    mockRedisTtl.mockResolvedValue(1700);
    const out = await executePlatformTool(autoCodingCtx(), 'start_coding_session', { projectId: 'proj-1', title: 'Post-trip attempt' });
    expect(out).toContain('spawn REFUSED');
    expect(out).toContain('circuit breaker');
    expect(out).toContain('TRIPPED until 2026-09-14T02:28:20.000Z');
    expect(out).toContain('DIGBY_PROJECT_SUPERVISOR_STORM_COOLDOWN_SEC');
    expect(out).toContain('Fleet Supervisor');
    expect(svc.startCodingSession).not.toHaveBeenCalled();
    // Cheapest-first: no DB counts, no storm-window increment.
    expect(mockChatCount).not.toHaveBeenCalled();
    expect(mockChatFindMany).not.toHaveBeenCalled();
    expect(mockRedisIncr).not.toHaveBeenCalled();
  });

  it("a LEFTOVER 'budget'-reason trip key (the envelope breaker was DELETED 2026-09-27 — owner: no cost caps) no longer refuses: it reads as an observe-only storm trip, the spawn proceeds with an advisory", async () => {
    mockRedisGet.mockResolvedValue(tripValue('budget'));
    mockRedisTtl.mockResolvedValue(1700);
    const out = await executePlatformTool(autoCodingCtx(), 'start_coding_session', { projectId: 'proj-1', title: 'Post-stale-budget-trip attempt' });
    expect(out).not.toContain('spawn REFUSED');
    expect(out).toContain('ADVISORY (observe-only anti-runaway breaker)');
    expect(svc.startCodingSession).toHaveBeenCalled();
  });

  // Hardening 2026-09-14: this pin used to encode the 32/h REFUSAL — a harness-
  // bound blocking gate on the lane's own work (2026-09-11 gate flip forbids
  // it). Rewritten: the rate cap is observe-only by default.
  it('DEFAULT: at the hourly rate cap the spawn PROCEEDS with an advisory + ONE metric row (reason rate) and NO trip key; the storm window still counts it', async () => {
    mockChatCount.mockResolvedValue(32); // at the supervisor hourly cap
    const out = await executePlatformTool(autoCodingCtx(), 'start_coding_session', { projectId: 'proj-1', title: 'Over-cap child' });
    expect(out).not.toContain('spawn REFUSED');
    expect(out).toContain('Started coding session sess-new');
    expect(svc.startCodingSession).toHaveBeenCalledTimes(1);
    expect(out).toContain('ADVISORY (observe-only rate cap)');
    expect(out).toContain('32 children spawned in the last hour exceeded the hourly rate cap 32');
    expect(out).toContain('DIGBY_PROJECT_SUPERVISOR_SPAWNS_PER_HOUR');
    expect(out).toContain('DIGBY_PROJECT_SUPERVISOR_RATE_ENFORCE=1');
    // Telemetry: exactly ONE breaker row, reason 'rate', written DIRECTLY …
    expect(breakerCalls()).toHaveLength(1);
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'project_supervisor_breaker',
      sessionId: 'sess-sup',
      value: 32,
      meta: expect.objectContaining({ projectId: 'proj-1', reason: 'rate', count: 32, cap: 32, outcome: 'observed' }),
    }));
    // … and NO trip key (a rate trip would be read back as a STORM trip and
    // refuse every spawn for the cooldown under STORM_ENFORCE=1).
    expect(mockRedisSet).not.toHaveBeenCalled();
    // An allowed spawn IS real velocity — the storm window counts it.
    expect(mockRedisIncr).toHaveBeenCalledWith('coding:proj-sup:storm:proj-1');
  });

  it('ENFORCE (DIGBY_PROJECT_SUPERVISOR_RATE_ENFORCE=1): at the hourly cap the spawn is REFUSED and never feeds the storm window', async () => {
    process.env.DIGBY_PROJECT_SUPERVISOR_RATE_ENFORCE = '1';
    mockChatCount.mockResolvedValue(32);
    const out = await executePlatformTool(autoCodingCtx(), 'start_coding_session', { projectId: 'proj-1', title: 'Over-cap child' });
    expect(out).toContain('spawn REFUSED');
    expect(out).toContain('DIGBY_PROJECT_SUPERVISOR_SPAWNS_PER_HOUR');
    expect(out).toContain('DIGBY_PROJECT_SUPERVISOR_RATE_ENFORCE=1');
    expect(svc.startCodingSession).not.toHaveBeenCalled();
    expect(mockRedisIncr).not.toHaveBeenCalled();
    expect(mockRedisSet).not.toHaveBeenCalled();
    expect(mockRecordLoopMetric).not.toHaveBeenCalled();
  });

  it('rate + storm advisories co-occur on one spawn (joined, not overwritten)', async () => {
    mockChatCount.mockResolvedValue(32);
    mockRedisIncr.mockResolvedValue(13);
    const out = await executePlatformTool(autoCodingCtx(), 'start_coding_session', { projectId: 'proj-1', title: 'Busy child' });
    expect(out).not.toContain('spawn REFUSED');
    expect(out).toContain('ADVISORY (observe-only rate cap)');
    expect(out).toContain('ADVISORY (observe-only anti-runaway breaker)');
    // One 'rate' row + one 'storm' row.
    expect(breakerCalls()).toHaveLength(2);
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({ meta: expect.objectContaining({ reason: 'rate' }) }));
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({ meta: expect.objectContaining({ reason: 'storm' }) }));
  });
});

// Hardening 2026-09-14: the storm window measures REAL fan-out — a spawn that
// fails after the INCR is un-counted, and a lost EXPIRE self-heals.
describe('project-supervisor spawn lane — storm-window hygiene', () => {
  it('a spawn that 404s (project not found) after the INCR gives the storm slot back (DECR) and carries no advisory', async () => {
    const err: any = new Error('Project not found: proj-x');
    err.statusCode = 404;
    svc.startCodingSession.mockRejectedValue(err);
    const out = await executePlatformTool(autoCodingCtx(), 'start_coding_session', { projectId: 'proj-x', title: 'Mis-typed id' });
    expect(out).toContain('Project not found');
    expect(out).toContain('Re-call start_coding_session with the EXACT projectId');
    expect(mockRedisIncr).toHaveBeenCalledWith('coding:proj-sup:storm:proj-1');
    expect(mockRedisDecr).toHaveBeenCalledWith('coding:proj-sup:storm:proj-1');
    expect(out).not.toContain('ADVISORY');
    expect(mockRecordLoopMetric).not.toHaveBeenCalled();
  });

  it('a spawn that THROWS after the INCR gives the storm slot back and the error still propagates', async () => {
    svc.startCodingSession.mockRejectedValue(new Error('worker box unreachable'));
    await expect(executePlatformTool(autoCodingCtx(), 'start_coding_session', { projectId: 'proj-1', title: 'Doomed child' }))
      .rejects.toThrow('worker box unreachable');
    expect(mockRedisIncr).toHaveBeenCalledWith('coding:proj-sup:storm:proj-1');
    expect(mockRedisDecr).toHaveBeenCalledWith('coding:proj-sup:storm:proj-1');
  });

  it('fixer 2026-09-27: a todoId / goalId the executor cannot resolve is refused WITHOUT the spawn and gives the storm slot back (DECR)', async () => {
    mockTodoFindFirst.mockResolvedValue(null);
    const out = await executePlatformTool(autoCodingCtx(), 'start_coding_session', { projectId: 'proj-1', todoId: 'todo-typo' });
    expect(out).toContain('todo todo-typo not found');
    expect(svc.startCodingSession).not.toHaveBeenCalled();
    expect(mockRedisIncr).toHaveBeenCalledWith('coding:proj-sup:storm:proj-1');
    expect(mockRedisDecr).toHaveBeenCalledWith('coding:proj-sup:storm:proj-1');

    jest.clearAllMocks();
    mockRedisIncr.mockResolvedValue(1); mockRedisPttl.mockResolvedValue(300_000); mockRedisGet.mockResolvedValue(null);
    mockChatFindUnique.mockResolvedValue(SUPERVISOR_CALLER);
    mockTodoFindFirst.mockResolvedValue({ id: 'todo-other', title: 'Elsewhere', goalId: 'goal-x', projectId: 'proj-2' });
    const wrongProject = await executePlatformTool(autoCodingCtx(), 'start_coding_session', { projectId: 'proj-1', todoId: 'todo-other' });
    expect(wrongProject).toContain('belongs to project proj-2');
    expect(svc.startCodingSession).not.toHaveBeenCalled();
    expect(mockRedisDecr).toHaveBeenCalledWith('coding:proj-sup:storm:proj-1');

    jest.clearAllMocks();
    mockRedisIncr.mockResolvedValue(1); mockRedisPttl.mockResolvedValue(300_000); mockRedisGet.mockResolvedValue(null);
    mockChatFindUnique.mockResolvedValue(SUPERVISOR_CALLER);
    mockGoalFindFirst.mockResolvedValue(null);
    const goalMissing = await executePlatformTool(autoCodingCtx(), 'start_coding_session', { projectId: 'proj-1', goalId: 'goal-typo' });
    expect(goalMissing).toContain('goal goal-typo not found');
    expect(svc.startCodingSession).not.toHaveBeenCalled();
    expect(mockRedisDecr).toHaveBeenCalledWith('coding:proj-sup:storm:proj-1');
  });

  it('a DECR failure on release is swallowed (best-effort compensation)', async () => {
    const err: any = new Error('Project not found: proj-x');
    err.statusCode = 404;
    svc.startCodingSession.mockRejectedValue(err);
    mockRedisDecr.mockRejectedValue(new Error('redis down'));
    const out = await executePlatformTool(autoCodingCtx(), 'start_coding_session', { projectId: 'proj-x', title: 'Mis-typed id' });
    expect(out).toContain('Project not found');
  });

  it('a successful spawn never DECRs (the slot is real fan-out)', async () => {
    await executePlatformTool(autoCodingCtx(), 'start_coding_session', { projectId: 'proj-1', title: 'Worker task' });
    expect(svc.startCodingSession).toHaveBeenCalledTimes(1);
    expect(mockRedisDecr).not.toHaveBeenCalled();
  });

  it('a later INCR whose key has LOST its TTL (pTTL -1) re-issues the 600s EXPIRE (self-heal)', async () => {
    mockRedisIncr.mockResolvedValue(5);
    mockRedisPttl.mockResolvedValue(-1);
    const out = await executePlatformTool(autoCodingCtx(), 'start_coding_session', { projectId: 'proj-1', title: 'Worker task' });
    expect(out).not.toContain('spawn REFUSED');
    expect(mockRedisPttl).toHaveBeenCalledWith('coding:proj-sup:storm:proj-1');
    expect(mockRedisExpire).toHaveBeenCalledWith('coding:proj-sup:storm:proj-1', 600);
  });

  it('a later INCR whose key still has a TTL does NOT re-issue EXPIRE (the window is not extended)', async () => {
    mockRedisIncr.mockResolvedValue(5);
    mockRedisPttl.mockResolvedValue(240_000);
    await executePlatformTool(autoCodingCtx(), 'start_coding_session', { projectId: 'proj-1', title: 'Worker task' });
    expect(mockRedisPttl).toHaveBeenCalledWith('coding:proj-sup:storm:proj-1');
    expect(mockRedisExpire).not.toHaveBeenCalled();
  });

  it('a pTTL failure never skips the storm check (heal is best-effort)', async () => {
    mockRedisIncr.mockResolvedValue(13);
    mockRedisPttl.mockRejectedValue(new Error('redis hiccup'));
    const out = await executePlatformTool(autoCodingCtx(), 'start_coding_session', { projectId: 'proj-1', title: 'Storm child 13' });
    expect(out).not.toContain('spawn REFUSED');
    expect(out).toContain('ADVISORY (observe-only anti-runaway breaker)');
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({ meta: expect.objectContaining({ reason: 'storm' }) }));
  });
});

describe('project-supervisor spawn lane — NO cost cap (the token-budget circuit breaker was DELETED 2026-09-27; owner: no cost caps anywhere unless set by a user at the project settings level)', () => {
  it('REGRESSION PIN (no cap when no project cap is set): the retired env DIGBY_PROJECT_SUPERVISOR_DAILY_BUDGET_USD + heavy trailing-24h project spend NEVER refuses, trips or meters a budget reason — the spawn proceeds and the ledger is not even read', async () => {
    process.env.DIGBY_PROJECT_SUPERVISOR_DAILY_BUDGET_USD = '25';
    mockTrailingSpend.mockResolvedValue({ chatUsd: 40.1, projectUsd: 30.5, projectId: 'proj-1', chatCodingUsd: 30.5, projectCodingUsd: 30.5 });
    const out = await executePlatformTool(autoCodingCtx(), 'start_coding_session', { projectId: 'proj-1', title: 'Over-the-old-envelope child' });
    expect(out).not.toContain('spawn REFUSED');
    expect(out).not.toContain('token-budget circuit breaker');
    expect(out).not.toContain('DIGBY_PROJECT_SUPERVISOR_DAILY_BUDGET_USD');
    expect(svc.startCodingSession).toHaveBeenCalled();
    expect(mockTrailingSpend).not.toHaveBeenCalled();
    expect(mockRedisSet).not.toHaveBeenCalledWith('coding:proj-sup:storm-tripped:proj-1', expect.any(String), expect.anything());
    expect(mockRecordLoopMetric).not.toHaveBeenCalledWith(expect.objectContaining({ meta: expect.objectContaining({ reason: 'budget' }) }));
  });

  it('DEFAULT (nothing set — owner: hardware-bound, not harness-bound): heavy trailing spend never refuses or trips', async () => {
    mockTrailingSpend.mockResolvedValue({ chatUsd: 400, projectUsd: 310.5, projectId: 'proj-1', chatCodingUsd: 310.5, projectCodingUsd: 310.5 });
    const out = await executePlatformTool(autoCodingCtx(), 'start_coding_session', { projectId: 'proj-1', title: 'Busy project child' });
    expect(out).not.toContain('spawn REFUSED');
    expect(svc.startCodingSession).toHaveBeenCalled();
    expect(mockRecordLoopMetric).not.toHaveBeenCalledWith(expect.objectContaining({ meta: expect.objectContaining({ reason: 'budget' }) }));
  });

  it("a LEFTOVER Redis trip key written with the deleted reason 'budget' reads as an observe-only storm trip — an advisory, never a refusal", async () => {
    mockRedisGet.mockResolvedValue(JSON.stringify({ at: new Date().toISOString(), reason: 'budget' }));
    const out = await executePlatformTool(autoCodingCtx(), 'start_coding_session', { projectId: 'proj-1', title: 'After a stale budget trip' });
    expect(out).not.toContain('spawn REFUSED');
    expect(out).toContain('ADVISORY (observe-only anti-runaway breaker)');
    expect(svc.startCodingSession).toHaveBeenCalled();
  });
});

describe('project-supervisor spawn lane — concurrency + rate caps', () => {
  it('refuses at the concurrent-active ceiling (default 24 when nothing is configured and no worker has published) with steering doctrine — and leaves ONE project_supervisor_breaker row reason concurrency (2026-10-20), no trip key', async () => {
    fillActiveWorkers(24);
    const out = await executePlatformTool(autoCodingCtx(), 'start_coding_session', { projectId: 'proj-1', title: '25th active worker' });
    expect(out).toContain('spawn REFUSED');
    expect(out).toContain('24 active worker session(s)');
    expect(out).toContain('ceiling 24');
    expect(out).toContain('DIGBY_PROJECT_SUPERVISOR_MAX_ACTIVE_WORKERS');
    expect(out).toContain('no coding worker has published its slots');
    expect(svc.startCodingSession).not.toHaveBeenCalled();
    expect(mockRedisIncr).not.toHaveBeenCalled();
    // The ceiling binding is visible: one breaker row, reason 'concurrency' — before 2026-10-20 this refusal wrote nothing.
    expect(breakerCalls()).toHaveLength(1);
    expect(breakerCalls()[0][0]).toMatchObject({
      kind: 'project_supervisor_breaker', sessionId: 'sess-sup', value: 24,
      meta: { projectId: 'proj-1', reason: 'concurrency', count: 24, cap: 24, activeCount: 24, capSource: 'default', outcome: 'refused' },
    });
    // No trip key — a concurrency refusal is a ceiling, not a storm (parseProjectSupervisorTrip would read one as storm).
    expect(mockRedisSet).not.toHaveBeenCalledWith('coding:proj-sup:storm-tripped:proj-1', expect.any(String), expect.anything());
  });

  it('an ALLOWED spawn under the ceiling writes NO concurrency row', async () => {
    fillActiveWorkers(23);
    const out = await executePlatformTool(autoCodingCtx(), 'start_coding_session', { projectId: 'proj-1', title: '24th active worker' });
    expect(out).not.toContain('spawn REFUSED');
    expect(breakerCalls().filter((c: any[]) => c[0]?.meta?.reason === 'concurrency')).toHaveLength(0);
  });

  // 2026-10-20: the ceiling TRACKS the coding box — the worker publishes its slots to Redis and the guard
  // (which runs on the web boxes, where CODING_WORKER_CONCURRENCY is not forwarded) reads them live.
  describe('the LIVE worker-slot registry (coding/worker-slots.ts) — 2026-10-20', () => {
    it('box C publishes 32 slots ⇒ the ceiling is 31 MACHINE-claimable slots (the worker reserves its last slot for interactive runs): 30 active proceeds, 31 refuses, the row says capSource live', async () => {
      liveRegistry(slotEntry({ concurrency: 32 }));
      fillActiveWorkers(30); // over the old hard-coded 24, under the real bound → proceeds
      let out = await executePlatformTool(autoCodingCtx(), 'start_coding_session', { projectId: 'proj-1', title: '31st active worker' });
      expect(out).not.toContain('spawn REFUSED');
      expect(svc.startCodingSession).toHaveBeenCalledTimes(1);
      expect(mockRedisHGetAll).toHaveBeenCalledWith('coding:worker:slots');

      jest.clearAllMocks();
      svc.startCodingSession.mockResolvedValue({ ...SPAWNED });
      mockChatFindUnique.mockResolvedValue(SUPERVISOR_CALLER);
      mockChatCount.mockResolvedValue(0);
      mockCodingStateFindMany.mockResolvedValue([]);
      liveRegistry(slotEntry({ concurrency: 32 }));
      fillActiveWorkers(31); // at the machine-claimable bound → refused
      out = await executePlatformTool(autoCodingCtx(), 'start_coding_session', { projectId: 'proj-1', title: '32nd active worker' });
      expect(out).toContain('spawn REFUSED');
      expect(out).toContain('31 active worker session(s)');
      expect(out).toContain('ceiling 31');
      expect(out).toContain('LIVE machine-claimable slots');
      expect(out).toContain('32 worker slot(s) − 1 interactive reserve = 31 machine-claimable slot(s)');
      expect(out).toContain('box-c=32');
      expect(out).toContain('DIGBY_PROJECT_SUPERVISOR_MAX_ACTIVE_WORKERS overrides');
      expect(svc.startCodingSession).not.toHaveBeenCalled();
      expect(breakerCalls()[0][0].meta).toMatchObject({ reason: 'concurrency', activeCount: 31, cap: 31, capSource: 'live', outcome: 'refused' });
    });

    it('a blue-green deploy overlap (two workers on ONE box) never doubles the ceiling — the newest entry per box wins', async () => {
      const now = Date.now();
      liveRegistry(
        slotEntry({ workerId: 'worker-c-old', box: 'box-c', concurrency: 32, at: new Date(now - 20_000).toISOString() }),
        slotEntry({ workerId: 'worker-c-new', box: 'box-c', concurrency: 32, at: new Date(now).toISOString() }),
      );
      fillActiveWorkers(31);
      const out = await executePlatformTool(autoCodingCtx(), 'start_coding_session', { projectId: 'proj-1', title: 'During a deploy' });
      expect(out).toContain('spawn REFUSED');
      expect(out).toContain('ceiling 31');
      expect(out).toContain('2 live worker(s) / 1 box(es)');
    });

    it('two coding boxes SUM their machine-claimable slots (32 + 16 ⇒ 31 + 15 = 46)', async () => {
      liveRegistry(slotEntry({ workerId: 'worker-c', box: 'box-c', concurrency: 32 }), slotEntry({ workerId: 'worker-d', box: 'box-d', concurrency: 16 }));
      fillActiveWorkers(45);
      let out = await executePlatformTool(autoCodingCtx(), 'start_coding_session', { projectId: 'proj-1', title: '46th' });
      expect(out).not.toContain('spawn REFUSED');

      jest.clearAllMocks();
      svc.startCodingSession.mockResolvedValue({ ...SPAWNED });
      mockChatFindUnique.mockResolvedValue(SUPERVISOR_CALLER);
      mockChatCount.mockResolvedValue(0);
      mockCodingStateFindMany.mockResolvedValue([]);
      liveRegistry(slotEntry({ workerId: 'worker-c', box: 'box-c', concurrency: 32 }), slotEntry({ workerId: 'worker-d', box: 'box-d', concurrency: 16 }));
      fillActiveWorkers(46);
      out = await executePlatformTool(autoCodingCtx(), 'start_coding_session', { projectId: 'proj-1', title: '47th' });
      expect(out).toContain('spawn REFUSED');
      expect(out).toContain('ceiling 46');
      expect(out).toContain('2 box(es)');
    });

    it('a STALE entry (the coding worker died or wedged > 90 s ago) is ignored ⇒ the default 24 applies, capSource default', async () => {
      liveRegistry(slotEntry({ concurrency: 32, at: new Date(Date.now() - 5 * 60_000).toISOString() }));
      fillActiveWorkers(24);
      const out = await executePlatformTool(autoCodingCtx(), 'start_coding_session', { projectId: 'proj-1', title: '25th' });
      expect(out).toContain('spawn REFUSED');
      expect(out).toContain('ceiling 24');
      expect(breakerCalls()[0][0].meta).toMatchObject({ capSource: 'default' });
    });

    it('explicit DIGBY_PROJECT_SUPERVISOR_MAX_ACTIVE_WORKERS WINS over the live registry (the operator override), capSource env', async () => {
      process.env.DIGBY_PROJECT_SUPERVISOR_MAX_ACTIVE_WORKERS = '100';
      liveRegistry(slotEntry({ concurrency: 32 }));
      fillActiveWorkers(64); // over the live 31 → proceeds under the override
      let out = await executePlatformTool(autoCodingCtx(), 'start_coding_session', { projectId: 'proj-1', title: '65th' });
      expect(out).not.toContain('spawn REFUSED');
      expect(mockRedisHGetAll).not.toHaveBeenCalled(); // the override short-circuits the read

      jest.clearAllMocks();
      svc.startCodingSession.mockResolvedValue({ ...SPAWNED });
      mockChatFindUnique.mockResolvedValue(SUPERVISOR_CALLER);
      mockChatCount.mockResolvedValue(0);
      mockCodingStateFindMany.mockResolvedValue([]);
      fillActiveWorkers(100);
      out = await executePlatformTool(autoCodingCtx(), 'start_coding_session', { projectId: 'proj-1', title: '101st' });
      expect(out).toContain('spawn REFUSED');
      expect(out).toContain('ceiling 100 = env DIGBY_PROJECT_SUPERVISOR_MAX_ACTIVE_WORKERS (operator override)');
      expect(breakerCalls()[0][0].meta).toMatchObject({ capSource: 'env', cap: 100, activeCount: 100 });
    });

    it('a registry READ failure fails open to the env / default chain — never a frozen fleet, never a zero ceiling', async () => {
      mockRedisHGetAll.mockRejectedValue(new Error('redis down'));
      fillActiveWorkers(23);
      let out = await executePlatformTool(autoCodingCtx(), 'start_coding_session', { projectId: 'proj-1', title: '24th' });
      expect(out).not.toContain('spawn REFUSED');

      jest.clearAllMocks();
      svc.startCodingSession.mockResolvedValue({ ...SPAWNED });
      mockChatFindUnique.mockResolvedValue(SUPERVISOR_CALLER);
      mockChatCount.mockResolvedValue(0);
      mockCodingStateFindMany.mockResolvedValue([]);
      mockRedisHGetAll.mockRejectedValue(new Error('redis down'));
      fillActiveWorkers(24);
      out = await executePlatformTool(autoCodingCtx(), 'start_coding_session', { projectId: 'proj-1', title: '25th' });
      expect(out).toContain('spawn REFUSED');
      expect(out).toContain('ceiling 24');
    });

    it('kill switch WORKER_SLOT_REGISTRY_DISABLED=1: the live registry is not read; the pre-2026-10-20 env / default ceiling applies', async () => {
      process.env.WORKER_SLOT_REGISTRY_DISABLED = '1';
      liveRegistry(slotEntry({ concurrency: 32 }));
      fillActiveWorkers(24);
      const out = await executePlatformTool(autoCodingCtx(), 'start_coding_session', { projectId: 'proj-1', title: '25th' });
      expect(out).toContain('spawn REFUSED');
      expect(out).toContain('ceiling 24');
      expect(mockRedisHGetAll).not.toHaveBeenCalled();
    });
  });

  // Project-supervisor preflight 2026-09-14: hardware-bound default. 2026-10-20: this
  // process's own CODING_WORKER_CONCURRENCY is the THIRD rung (after the explicit env and
  // the live registry) and, like the registry, counts MACHINE-claimable slots — the worker
  // reserves its last slot for interactive runs, so 40 slots are 39 for a supervisor's children.
  it('with no registry entry the ceiling FOLLOWS this process\'s CODING_WORKER_CONCURRENCY minus the interactive reserve (40 ⇒ 39), capSource process', async () => {
    process.env.CODING_WORKER_CONCURRENCY = '40';
    fillActiveWorkers(24); // over the old constant, under the hardware bound → proceeds
    let out = await executePlatformTool(autoCodingCtx(), 'start_coding_session', { projectId: 'proj-1', title: '25th active worker' });
    expect(out).not.toContain('spawn REFUSED');
    expect(svc.startCodingSession).toHaveBeenCalledTimes(1);

    jest.clearAllMocks();
    svc.startCodingSession.mockResolvedValue({ ...SPAWNED });
    mockChatFindUnique.mockResolvedValue(SUPERVISOR_CALLER);
    mockChatCount.mockResolvedValue(0);
    mockCodingStateFindMany.mockResolvedValue([]);
    mockRedisHGetAll.mockResolvedValue({});
    fillActiveWorkers(39); // at the machine-claimable bound → refused
    out = await executePlatformTool(autoCodingCtx(), 'start_coding_session', { projectId: 'proj-1', title: '40th active worker' });
    expect(out).toContain('spawn REFUSED');
    expect(out).toContain('39 active worker session(s)');
    expect(out).toContain('ceiling 39');
    expect(out).toContain("this process's CODING_WORKER_CONCURRENCY=40 minus the interactive reserve");
    expect(svc.startCodingSession).not.toHaveBeenCalled();
    expect(breakerCalls()[0][0].meta).toMatchObject({ capSource: 'process', cap: 39 });
  });

  it('CODING_WORKER_CONCURRENCY=0 (a cron-only web box) falls back to 24, never a zero ceiling', async () => {
    process.env.CODING_WORKER_CONCURRENCY = '0';
    fillActiveWorkers(23);
    const out = await executePlatformTool(autoCodingCtx(), 'start_coding_session', { projectId: 'proj-1', title: '24th active worker' });
    expect(out).not.toContain('spawn REFUSED');
    expect(svc.startCodingSession).toHaveBeenCalledTimes(1);
  });

  it('explicit DIGBY_PROJECT_SUPERVISOR_MAX_ACTIVE_WORKERS wins over CODING_WORKER_CONCURRENCY and is NOT clamped at 64', async () => {
    process.env.CODING_WORKER_CONCURRENCY = '24';
    process.env.DIGBY_PROJECT_SUPERVISOR_MAX_ACTIVE_WORKERS = '100';
    fillActiveWorkers(64); // the old clamp would have refused here
    const out = await executePlatformTool(autoCodingCtx(), 'start_coding_session', { projectId: 'proj-1', title: '65th active worker' });
    expect(out).not.toContain('spawn REFUSED');
    expect(svc.startCodingSession).toHaveBeenCalledTimes(1);
  });

  it('provisioning children count toward the ceiling', async () => {
    const ids = Array.from({ length: 24 }, (_, i) => `child-${i}`);
    mockChatFindMany.mockResolvedValue(ids.map((id) => ({ id })));
    mockAgentRunFindMany.mockResolvedValue([]); // none running…
    mockCodingStateFindMany.mockResolvedValue(ids.map((id) => ({ id, status: 'provisioning' }))); // …but all still provisioning
    const out = await executePlatformTool(autoCodingCtx(), 'start_coding_session', { projectId: 'proj-1', title: 'One more' });
    expect(out).toContain('spawn REFUSED');
    expect(out).toContain('DIGBY_PROJECT_SUPERVISOR_MAX_ACTIVE_WORKERS');
  });

  // Hardening 2026-09-14: the ceiling is the BOX's slots — every child of this
  // supervisor holds one, whichever project it resolved into.
  it('the ceiling counts this supervisor\'s children in ANY project (no per-project filter)', async () => {
    const ids = Array.from({ length: 24 }, (_, i) => `child-${i}`);
    mockChatFindMany.mockResolvedValue(ids.map((id) => ({ id, projectId: 'proj-2' }))); // all landed in a sibling project
    mockAgentRunFindMany.mockResolvedValue(ids.map((id) => ({ sessionId: id })));
    const out = await executePlatformTool(autoCodingCtx(), 'start_coding_session', { projectId: 'proj-1', title: '25th active worker' });
    expect(out).toContain('spawn REFUSED');
    expect(out).toContain('24 active worker session(s)');
    expect(svc.startCodingSession).not.toHaveBeenCalled();
    // The lineage query is keyed on the supervisor alone.
    const where = mockChatFindMany.mock.calls[0][0].where;
    expect(where).toEqual({ parentChatId: 'sess-sup' });
    expect(where).not.toHaveProperty('projectId');
  });
});

// Project-supervisor preflight 2026-09-14: no double wake on a supervisor's own workers.
describe('project-supervisor spawn lane — child result hook', () => {
  it('a PROJECT-SUPERVISOR parent records lineage but wires NO per-child result hook (the project-scope hook already covers the child)', async () => {
    const out = await executePlatformTool(autoCodingCtx(), 'start_coding_session', { projectId: 'proj-1', title: 'Worker task' });
    expect(out).not.toContain('spawn REFUSED');
    expect(svc.startCodingSession).toHaveBeenCalledTimes(1);
    expect(mockChatUpdate).toHaveBeenCalledWith({ where: { id: 'sess-new' }, data: { parentChatId: 'sess-sup' } });
    expect(mockEnsureChildResultHook).not.toHaveBeenCalled();
    expect(out).toContain('SUB-SESSION of this chat (lineage recorded)');
    expect(out).toContain('project-scope supervisor hook already wakes this chat');
    expect(out).not.toContain('hook hook-1');
    expect(out).not.toContain('could not be wired');
  });

  it('a PLAIN parent keeps the per-child result hook', async () => {
    mockChatFindUnique.mockResolvedValue({ id: 'sess-1', userId: 'u1', isProjectSupervisor: false, projectId: 'proj-1' });
    const out = await executePlatformTool(makeCtx({ agentSurface: 'coding', sessionId: 'sess-1' } as any), 'start_coding_session', { projectId: 'proj-1', title: 'Worker task' });
    expect(out).not.toContain('spawn REFUSED');
    expect(mockEnsureChildResultHook).toHaveBeenCalledWith({ userId: 'u1', parentChatId: 'sess-1', childChatId: 'sess-new' });
    expect(out).toContain('hook hook-1');
  });

  // Hardening 2026-09-14: the project-scope hook delivers only when the child's
  // projectId matches — a child that RESOLVED elsewhere would never wake the
  // supervisor, while the old note promised it would.
  it('a child that RESOLVED into ANOTHER project gets the direct result hook + an honest note naming both projects', async () => {
    svc.startCodingSession.mockResolvedValue({ ...SPAWNED, projectId: 'proj-2' }); // e.g. a sibling, or the workspace ancestor rewrite
    const out = await executePlatformTool(autoCodingCtx(), 'start_coding_session', { projectId: 'proj-1', title: 'Worker task' });
    expect(out).not.toContain('spawn REFUSED');
    expect(mockChatUpdate).toHaveBeenCalledWith({ where: { id: 'sess-new' }, data: { parentChatId: 'sess-sup' } });
    expect(mockEnsureChildResultHook).toHaveBeenCalledWith({ userId: 'u1', parentChatId: 'sess-sup', childChatId: 'sess-new' });
    expect(out).toContain('hook hook-1');
    expect(out).toContain('landed in project proj-2');
    expect(out).toContain("OUTSIDE this supervisor's project proj-1");
    expect(out).toContain('project-scope hook does NOT cover it');
    expect(out).not.toContain('project-scope supervisor hook already wakes this chat');
  });

  it('an out-of-project child whose hook could not be wired says so (poll get_chat_status)', async () => {
    svc.startCodingSession.mockResolvedValue({ ...SPAWNED, projectId: 'proj-2' });
    mockEnsureChildResultHook.mockResolvedValue(null);
    const out = await executePlatformTool(autoCodingCtx(), 'start_coding_session', { projectId: 'proj-1', title: 'Worker task' });
    expect(mockEnsureChildResultHook).toHaveBeenCalled();
    expect(out).toContain('landed in project proj-2');
    expect(out).toContain('could not be wired');
    expect(out).toContain('poll get_chat_status');
  });

  it('a DETACHED supervisor (projectId null) keeps the no-hook note (nothing to compare against)', async () => {
    mockChatFindUnique.mockResolvedValue({ id: 'sess-sup', userId: 'u1', isProjectSupervisor: true, projectId: null });
    const out = await executePlatformTool(autoCodingCtx(), 'start_coding_session', { projectId: 'proj-1', title: 'Worker task' });
    expect(mockEnsureChildResultHook).not.toHaveBeenCalled();
    expect(out).toContain('project-scope supervisor hook already wakes this chat');
  });
});

// Hardening 2026-09-14: tool-schema text every wake carries — pins so the
// money/cost owner-card class and the hook/owner-only claims cannot drift back.
describe('project-supervisor hardening — tool description pins', () => {
  const descOf = (name: string): string => {
    const tool = (PLATFORM_TOOL_SCHEMA as any[]).find((t) => t.function?.name === name);
    expect(tool).toBeDefined();
    return String(tool.function.description);
  };

  it.each(['flag_owner_question', 'answer_owner_question'])(
    '%s no longer names money/cost as an owner-only class (standing directive: cost cards are forbidden)',
    (name) => {
      expect(descOf(name)).not.toMatch(/money beyond|spends money|approved cap/i);
    },
  );

  it('flag_owner_question says NEVER for spend/budget/cost and keeps the four real owner-only classes', () => {
    const desc = descOf('flag_owner_question');
    expect(desc).toContain('NEVER for spend, budget, cost, GPU hours or session count');
    expect(desc).toContain('pre-approved by standing owner directive');
    expect(desc).toContain('Owner-only classes (irreversible/destructive, external sends, credentials, physically-human)');
  });

  it('answer_owner_question tells the supervisor a cost question is never owner-only — answer it, never leave it to surface', () => {
    const desc = descOf('answer_owner_question');
    expect(desc).toMatch(/cost\/spend\/budget.*NEVER owner-only/);
    expect(desc).toContain('pre-approved budgets');
  });

  it('update_project says projectSupervisorEnabled is owner-only (the lane runs as the owner)', () => {
    const tool = (PLATFORM_TOOL_SCHEMA as any[]).find((t) => t.function?.name === 'update_project');
    expect(String(tool.function.description)).toContain('projectSupervisorEnabled is OWNER-only');
    expect(String(tool.function.parameters.properties.projectSupervisorEnabled.description)).toMatch(/^OWNER-ONLY/);
  });

  it('start_coding_session documents the project-supervisor hook exception without losing the pinned CHILD / result hook / [PARENT SESSION CONTEXT] substrings', () => {
    const desc = descOf('start_coding_session');
    expect(desc).toContain('CHILD');
    expect(desc).toContain('result hook');
    expect(desc).toContain('[PARENT SESSION CONTEXT]');
    expect(desc).toContain('except when the caller is a project supervisor');
    expect(desc).toContain('project-scope hook already covers the child');
    expect(desc).toContain('lands in ANOTHER project still gets the direct hook');
  });
});

describe('project-supervisor spawn lane — fail-open doctrine', () => {
  it('a Redis trip-key read failure never freezes the fleet', async () => {
    mockRedisGet.mockRejectedValue(new Error('redis down'));
    mockRedisIncr.mockRejectedValue(new Error('redis down'));
    const out = await executePlatformTool(autoCodingCtx(), 'start_coding_session', { projectId: 'proj-1', title: 'Worker task' });
    expect(out).not.toContain('spawn REFUSED');
    expect(svc.startCodingSession).toHaveBeenCalled();
  });

  it('a DB failure in the ceiling/hourly checks never freezes the fleet', async () => {
    mockChatFindMany.mockRejectedValue(new Error('db down'));
    mockChatCount.mockRejectedValue(new Error('db down'));
    const out = await executePlatformTool(autoCodingCtx(), 'start_coding_session', { projectId: 'proj-1', title: 'Worker task' });
    expect(out).not.toContain('spawn REFUSED');
    expect(svc.startCodingSession).toHaveBeenCalled();
  });

  it('a spend-ledger failure never freezes the fleet', async () => {
    mockTrailingSpend.mockRejectedValue(new Error('ledger down'));
    const out = await executePlatformTool(autoCodingCtx(), 'start_coding_session', { projectId: 'proj-1', title: 'Worker task' });
    expect(out).not.toContain('spawn REFUSED');
    expect(svc.startCodingSession).toHaveBeenCalled();
  });

  it('a detached supervisor (projectId null) degrades to the DB checks only', async () => {
    mockChatFindUnique.mockResolvedValue({ id: 'sess-sup', userId: 'u1', isProjectSupervisor: true, projectId: null });
    const out = await executePlatformTool(autoCodingCtx(), 'start_coding_session', { projectId: 'p1', title: 'Worker task' });
    expect(out).not.toContain('spawn REFUSED');
    // The Redis breaker is project-scoped by construction — skipped (no spend
    // envelope exists since 2026-09-27; the ledger is never read on a spawn).
    expect(mockRedisGet).not.toHaveBeenCalled();
    expect(mockRedisIncr).not.toHaveBeenCalled();
    expect(mockTrailingSpend).not.toHaveBeenCalled();
    expect(svc.startCodingSession).toHaveBeenCalled();
  });
});

// ── Supervisor OFF switch (owner 2026-09-26; platform/supervisor-switch.ts) ──
// The spawn guard refuses a spawn BY a supervisor-class caller whose admin
// switch is OFF — before the breaker/ceiling checks, with the reason and the
// way back on — and records one supervisor_switch skip (source spawn_guard).
// Plain callers and the other tier are untouched; a read error fails open.
import { invalidateSupervisorSwitchCache, resetSupervisorSwitchMetricWindowForTests } from './supervisor-switch';

describe('supervisor OFF switch × start_coding_session spawn guard', () => {
  const switchRows = () => mockRecordLoopMetric.mock.calls.map((c) => c[0]).filter((m) => m?.kind === 'supervisor_switch');
  const offRow = (key: string) => async ({ where }: any) => (where?.key === key ? { key, value: '0', updatedAt: new Date() } : null);
  beforeEach(() => {
    mockSettingFind.mockReset().mockResolvedValue(null);
    invalidateSupervisorSwitchCache();
    resetSupervisorSwitchMetricWindowForTests();
  });

  it('project OFF: a PROJECT supervisor spawn is REFUSED naming the switch + the admin path; nothing spawned, breaker untouched', async () => {
    mockSettingFind.mockImplementation(offRow('project_supervisors_enabled'));
    invalidateSupervisorSwitchCache();
    const out = await executePlatformTool(autoCodingCtx(), 'start_coding_session', { projectId: 'proj-1', title: 'Worker task' });
    expect(out).toContain('spawn REFUSED');
    expect(out).toContain('Project supervisors switch is OFF');
    expect(out).toContain('project_supervisors_enabled');
    expect(out).toContain('Account → Admin → Settings → Supervisors');
    expect(svc.startCodingSession).not.toHaveBeenCalled();
    expect(mockRedisIncr).not.toHaveBeenCalledWith('coding:proj-sup:storm:proj-1');
    expect(switchRows()).toEqual([expect.objectContaining({ sessionId: 'sess-sup', meta: expect.objectContaining({ target: 'project', action: 'skipped', source: 'spawn_guard', chatId: 'sess-sup' }) })]);
  });

  it('fleet OFF: a FLEET supervisor spawn is refused; project OFF alone does not gate the fleet caller', async () => {
    mockChatFindUnique.mockResolvedValue({ id: 'sess-fleet', userId: 'u1', isSupervisor: true, isProjectSupervisor: false, projectId: null });
    mockSettingFind.mockImplementation(offRow('project_supervisors_enabled'));
    invalidateSupervisorSwitchCache();
    let out = await executePlatformTool(makeCtx({ agentSurface: 'coding', sessionId: 'sess-fleet' } as any), 'start_coding_session', { projectId: 'proj-1', title: 'Worker task' });
    expect(out).not.toContain('spawn REFUSED');
    expect(svc.startCodingSession).toHaveBeenCalledTimes(1);

    svc.startCodingSession.mockClear();
    mockSettingFind.mockImplementation(offRow('fleet_supervisor_enabled'));
    invalidateSupervisorSwitchCache();
    out = await executePlatformTool(makeCtx({ agentSurface: 'coding', sessionId: 'sess-fleet' } as any), 'start_coding_session', { projectId: 'proj-1', title: 'Worker task' });
    expect(out).toContain('spawn REFUSED');
    expect(out).toContain('Fleet supervisor switch is OFF');
    expect(svc.startCodingSession).not.toHaveBeenCalled();
    expect(switchRows()[0].meta).toMatchObject({ target: 'fleet', source: 'spawn_guard', chatId: 'sess-fleet' });
  });

  it('a PLAIN parent spawns normally while both switches are OFF; a switch read error fails open for a supervisor', async () => {
    mockSettingFind.mockImplementation(async () => ({ key: 'x', value: '0', updatedAt: new Date() }));
    invalidateSupervisorSwitchCache();
    mockChatFindUnique.mockResolvedValue({ id: 'sess-1', userId: 'u1', isSupervisor: false, isProjectSupervisor: false, projectId: 'proj-1' });
    let out = await executePlatformTool(makeCtx({ agentSurface: 'coding', sessionId: 'sess-1' } as any), 'start_coding_session', { projectId: 'proj-1', title: 'Plain child' });
    expect(out).not.toContain('spawn REFUSED');
    expect(switchRows()).toHaveLength(0);

    mockSettingFind.mockRejectedValue(new Error('db down'));
    invalidateSupervisorSwitchCache();
    mockChatFindUnique.mockResolvedValue(SUPERVISOR_CALLER);
    out = await executePlatformTool(autoCodingCtx(), 'start_coding_session', { projectId: 'proj-1', title: 'Worker task' });
    expect(out).not.toContain('spawn REFUSED');
  });
});

// audit 2026-10-06 T5-1 (litellm F2): a PAUSED project supervisor's project-scope
// hook is disabled — its children must get the direct result hook, and the
// envelope must say supervision is paused.
describe('audit 2026-10-06 T5-1 — spawning from a PAUSED project supervisor', () => {
  it('no ENABLED project-scope hook ⇒ the direct child result hook is wired and the note says SUPERVISION IS PAUSED', async () => {
    mockEventHookFindFirst.mockResolvedValue(null);
    const out = await executePlatformTool(autoCodingCtx(), 'start_coding_session', { projectId: 'proj-1', title: 'Worker task' });
    expect(mockEventHookFindFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ userId: 'u1', targetChatId: 'sess-sup', sourceChatId: null, projectId: 'proj-1', enabled: true, eventTypes: { has: 'run_completed' } }),
    }));
    expect(mockEnsureChildResultHook).toHaveBeenCalledWith({ userId: 'u1', parentChatId: 'sess-sup', childChatId: 'sess-new' });
    expect(out).toContain('SUPERVISION IS PAUSED for project proj-1');
    expect(out).toContain('hook hook-1');
    expect(out).not.toContain('project-scope supervisor hook already wakes this chat');
  });

  it('paused + the direct hook cannot be wired ⇒ says nothing wakes it (poll get_chat_status)', async () => {
    mockEventHookFindFirst.mockResolvedValue(null);
    mockEnsureChildResultHook.mockResolvedValue(null);
    const out = await executePlatformTool(autoCodingCtx(), 'start_coding_session', { projectId: 'proj-1', title: 'Worker task' });
    expect(out).toContain('SUPERVISION IS PAUSED');
    expect(out).toContain('poll get_chat_status');
  });

  it('a live project-scope hook keeps the no-per-child-hook branch', async () => {
    const out = await executePlatformTool(autoCodingCtx(), 'start_coding_session', { projectId: 'proj-1', title: 'Worker task' });
    expect(mockEnsureChildResultHook).not.toHaveBeenCalled();
    expect(out).toContain('project-scope supervisor hook already wakes this chat');
  });

  it('a probe error fails open to the covered branch', async () => {
    mockEventHookFindFirst.mockRejectedValue(new Error('db down'));
    const out = await executePlatformTool(autoCodingCtx(), 'start_coding_session', { projectId: 'proj-1', title: 'Worker task' });
    expect(mockEnsureChildResultHook).not.toHaveBeenCalled();
    expect(out).toContain('project-scope supervisor hook already wakes this chat');
  });

  it('kill switch PAUSED_SUPERVISOR_CHILD_HOOK_DISABLED=1 restores the no-hook branch without probing', async () => {
    process.env.PAUSED_SUPERVISOR_CHILD_HOOK_DISABLED = '1';
    mockEventHookFindFirst.mockResolvedValue(null);
    const out = await executePlatformTool(autoCodingCtx(), 'start_coding_session', { projectId: 'proj-1', title: 'Worker task' });
    expect(mockEventHookFindFirst).not.toHaveBeenCalled();
    expect(mockEnsureChildResultHook).not.toHaveBeenCalled();
    expect(out).toContain('project-scope supervisor hook already wakes this chat');
  });
});

// audit 2026-10-06 T5-2 (ticket 2bae9728): a charter-only spawn starts its charter.
describe('audit 2026-10-06 T5-2 — a prompt-less spawn with a goalId / todoId charter starts it', () => {
  const TODO = { id: 'todo-7', title: 'Wire the MiMo routes', goalId: 'goal-3', projectId: 'proj-1' };

  it('todoId + no prompt ⇒ the harness writes the first prompt from the todo (agent origin), the envelope says so', async () => {
    mockTodoFindFirst.mockResolvedValue(TODO);
    mockGoalFindFirst.mockResolvedValue({ title: 'Gateway routes' });
    const out = await executePlatformTool(autoCodingCtx(), 'start_coding_session', { projectId: 'proj-1', todoId: 'todo-7' });
    const call = svc.startCodingSession.mock.calls[0][0];
    expect(call.prompt).toContain('[CHARTER — this session was started for todo todo-7 "Wire the MiMo routes" (goal goal-3 "Gateway routes")');
    expect(call.prompt).toContain('START it now');
    expect(call.promptOrigin).toMatchObject({ kind: 'agent', sourceChatId: 'sess-sup' });
    const env = JSON.parse(out);
    expect(env.ids.firstPrompt).toBe('charter');
    expect(env.message).toContain('the harness wrote the first prompt from the charter (todo todo-7)');
  });

  it('goalId + no prompt ⇒ a goal charter prompt; the parent context digest is prepended like a passed prompt', async () => {
    mockGoalFindFirst.mockResolvedValue({ id: 'goal-3', title: 'Gateway routes', projectId: 'proj-1' });
    mockBuildParentContextBlock.mockResolvedValue('[PARENT SESSION CONTEXT] digest');
    await executePlatformTool(autoCodingCtx(), 'start_coding_session', { projectId: 'proj-1', goalId: 'goal-3' });
    const prompt = svc.startCodingSession.mock.calls[0][0].prompt as string;
    expect(prompt.startsWith('[PARENT SESSION CONTEXT] digest\n\n[CHARTER — this session was started for goal goal-3 "Gateway routes"')).toBe(true);
  });

  it('neither prompt nor charter ⇒ no prompt rides, the envelope says IDLE', async () => {
    const out = await executePlatformTool(autoCodingCtx(), 'start_coding_session', { projectId: 'proj-1', title: 'Worker task' });
    expect(svc.startCodingSession.mock.calls[0][0].prompt).toBeUndefined();
    const env = JSON.parse(out);
    expect(env.ids.firstPrompt).toBe('none');
    expect(env.message).toContain('created IDLE');
  });

  it('kill switch SPAWN_CHARTER_FIRST_PROMPT_DISABLED=1: the charter binds but writes no prompt', async () => {
    process.env.SPAWN_CHARTER_FIRST_PROMPT_DISABLED = '1';
    mockTodoFindFirst.mockResolvedValue(TODO);
    const out = await executePlatformTool(autoCodingCtx(), 'start_coding_session', { projectId: 'proj-1', todoId: 'todo-7' });
    expect(svc.startCodingSession.mock.calls[0][0].prompt).toBeUndefined();
    const env = JSON.parse(out);
    expect(env.ids.firstPrompt).toBeUndefined();
    expect(env.message).not.toContain('IDLE');
    expect(env.message).not.toContain('CHARTER');
  });

  it('buildCharterFirstPrompt (pure): todo form re-reads before acting; goal form takes the first actionable todo', () => {
    const t = buildCharterFirstPrompt({ todo: { id: 't1', title: 'T' }, goal: { id: 'g1' } });
    expect(t).toContain('todo t1 "T" (goal g1)');
    expect(t).toContain('Re-read the todo with todo_get FIRST');
    const g = buildCharterFirstPrompt({ goal: { id: 'g1', title: 'G' } });
    expect(g).toContain('goal g1 "G"');
    expect(g).toContain('todo_list({goalId})');
  });
});
