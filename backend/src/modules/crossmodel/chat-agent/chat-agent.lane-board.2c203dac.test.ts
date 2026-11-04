/**
 * LANE BOARD wiring (ticket 2c203dac) — the chat-agent seam of the lane board.
 * The lane board itself is pinned in board-digest.lane-board.2c203dac.test.ts;
 * this file pins WHO gets it:
 *  - a NON-supervisor MACHINE-ORIGIN run (the mishap shape: an agent steer on
 *    a plain lane) carries the [BOARD] lane block in its wake prompt;
 *  - a schedule-firing machine wake (machineWake: true) carries it too;
 *  - a supervisor chat keeps its own [BOARD] (project/fleet scope) and does
 *    NOT get the lane board appended;
 *  - a USER-anchored run (origin 'user') gets no lane board at all — the
 *    read-don't-recall doctrine is a machine-wake contract (the user turn has
 *    the human present);
 *  - kill switch LANE_BOARD_BLOCK_DISABLED=1 restores the pre-fix wake.
 * Harness copied from chat-agent.wake-ledger.w6.test.ts.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockPrisma: any = {
  crossModelMessage: {
    create: jest.fn(async () => ({})),
    count: jest.fn(async ({ where }: any) => (where?.OR ? 0 : 2)),
  },
  crossModelChat: {
    update: jest.fn(async () => ({})),
    updateMany: jest.fn(async () => ({ count: 1 })),
    findUnique: jest.fn(async () => ({ title: 'A proper existing title' })),
  },
  pendingChatMessage: {
    findFirst: jest.fn(async () => null), delete: jest.fn(async () => ({})),
    count: jest.fn(async () => 0), create: jest.fn(async (a: any) => ({ id: 'pend-1', ...a.data })),
  },
  agentRun: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

// message-queue.service's origin stash imports config/redis (whose chain also
// reaches config/env → process.exit at import) — mock the boundary.
const redisStore = new Map<string, string>();
const redisLists = new Map<string, string[]>();
jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: {
    set: jest.fn(async (k: string, v: string, opts?: { NX?: boolean }) => {
      if (opts?.NX && redisStore.has(k)) return null;
      redisStore.set(k, v);
      return 'OK';
    }),
    del: jest.fn(async (k: string) => (redisStore.delete(k) || redisLists.delete(k)) ? 1 : 0),
    get: jest.fn(async (k: string) => redisStore.get(k) ?? null),
    exists: jest.fn(async (k: string) => (redisStore.has(k) ? 1 : 0)),
    mGet: jest.fn(async (keys: string[]) => keys.map((k) => redisStore.get(k) ?? null)),
    rPush: jest.fn(async (k: string, v: string) => { const l = redisLists.get(k) ?? []; l.push(v); redisLists.set(k, l); return l.length; }),
    lTrim: jest.fn(async (k: string, start: number, stop: number) => { const l = redisLists.get(k); if (l) redisLists.set(k, l.slice(start < 0 ? Math.max(0, l.length + start) : start, stop < 0 ? l.length + stop + 1 : stop + 1)); return 'OK'; }),
    lRange: jest.fn(async (k: string) => redisLists.get(k) ?? []),
    expire: jest.fn(async () => 1),
    getClient: () => ({
      set: jest.fn(async (k: string, v: string) => { redisStore.set(k, v); return 'OK'; }),
      setNx: jest.fn(async (k: string, v: string) => (redisStore.has(k) ? 0 : (redisStore.set(k, v), 1))),
      get: jest.fn(async (k: string) => redisStore.get(k) ?? null),
      del: jest.fn(async (k: string) => (redisStore.delete(k) || redisLists.delete(k)) ? 1 : 0),
      exists: jest.fn(async (k: string) => (redisStore.has(k) ? 1 : 0)),
      rPush: jest.fn(async (k: string, v: string) => { const l = redisLists.get(k) ?? []; l.push(v); redisLists.set(k, l); return l.length; }),
      lRange: jest.fn(async (k: string) => redisLists.get(k) ?? []),
      expire: jest.fn(async () => 1),
    }),
  },
}));

jest.mock('../../../middleware/error-handler', () => ({
  __esModule: true,
  AppError: class AppError extends Error {
    constructor(public statusCode: number, public message: string, public isOperational = true) { super(message); Object.setPrototypeOf(this, AppError.prototype); }
  },
}));

jest.mock('../coding/coding-model', () => ({
  __esModule: true,
  ...jest.requireActual('../coding/coding-model'),
  seatUnservableReason: jest.fn(async () => null),
}));

jest.mock('../coding/agent', () => ({
  runCodingAgent: jest.fn(async () => ({ finalText: 'A'.repeat(500) })),
  runChatWorker: jest.fn(async () => ({ finalText: '' })),
}));

const mockLatestHandoff: jest.Mock = jest.fn(async () => null);
jest.mock('../coding/deliverable-handoff', () => ({
  __esModule: true,
  ...jest.requireActual('../coding/deliverable-handoff'),
  latestDeliverableHandoff: (...a: any[]) => mockLatestHandoff(...a),
}));
jest.mock('../mcp-search', () => ({ searchWithBrightData: jest.fn(async () => ''), SEARCH_UNAVAILABLE_NOTE: '[search unavailable]' }));
jest.mock('../langgraph/memory.graph', () => ({ updateContextAsync: jest.fn() }));
const mockDecide: jest.Mock = jest.fn();
jest.mock('../platform/decision-gate', () => ({
  __esModule: true,
  ...jest.requireActual('../platform/decision-gate'),
  decide: (...a: any[]) => mockDecide(...a),
}));
const mockRecordCheckerOutcome: jest.Mock = jest.fn();
jest.mock('./checker-route-gate', () => ({
  __esModule: true,
  ...jest.requireActual('./checker-route-gate'),
  recordCheckerRouteOutcome: (...a: any[]) => mockRecordCheckerOutcome(...a),
}));
jest.mock('../context.service', () => ({ __esModule: true, default: { saveToSessionHistory: jest.fn(async () => {}) } }));
jest.mock('../integrations/moonshot.integration', () => ({ __esModule: true, default: { generateTitle: jest.fn(async () => 'A Generated Title') } }));

const mockVerifySupervisorRunAsync = jest.fn();
const mockVerifyRunActionClaimsAsync = jest.fn();
const mockGuardMachineWakeFinalAnswer = jest.fn(async (...a: any[]) => ({ finalText: a[0].finalText, notice: '', struck: false, phantoms: [] as any[] }));
const mockFindUnreadProductionState: jest.Mock = jest.fn((): any[] => []);
jest.mock('../platform/action-verifier', () => ({
  __esModule: true,
  verifySupervisorRunAsync: (...a: any[]) => mockVerifySupervisorRunAsync(...a),
  verifyRunActionClaimsAsync: (...a: any[]) => mockVerifyRunActionClaimsAsync(...a),
  guardMachineWakeFinalAnswer: (...a: any[]) => mockGuardMachineWakeFinalAnswer(...a),
  findFutureObservedTimestamps: () => [],
  findUnreadProductionStateClaims: (...a: any[]) => mockFindUnreadProductionState(...a),
  PRODUCTION_STATE_STRIKE: 'production_state_unread',
  PRODUCTION_STATE_SEAM: 'machine_wake_production_state',
  isCitationClassClaim: (claim: any) =>
    claim?.fabricatedId === true || ['[evidence citation]', '[owner chat ref]', '[vanished artifact]'].some((tag) => String(claim?.detail ?? '').startsWith(tag)),
  claimAuditExcerpts: (phantoms: any[]) => (Array.isArray(phantoms) ? phantoms : []).slice(0, 4).map((p: any) => ({ kind: String(p?.kind ?? ''), detail: String(p?.detail ?? '').slice(0, 120), ...(p?.id ? { id: String(p.id).slice(0, 24) } : {}) })),
  toolResultTextsFromParts: (parts: any[]) => (Array.isArray(parts) ? parts : []).filter((p: any) => p && p.type === 'tool_result' && typeof p.result === 'string' && p.result).map((p: any) => p.result),
}));

const mockApplyClaimsBlockLane: jest.Mock = jest.fn((opts: any): any => ({
  finalText: opts.guarded.finalText, notes: opts.guarded.notes, verdict: opts.guarded.verdict,
  lane: { present: false, verified: [], unverified: [], coveredKinds: [] },
}));
jest.mock('../coding/run-evidence-guard', () => ({ __esModule: true, applyClaimsBlockLane: (...a: any[]) => mockApplyClaimsBlockLane(...a) }));

const mockGenerateOwnerBriefing = jest.fn(async (..._a: any[]): Promise<boolean> => true);
jest.mock('../fleet/owner-briefing.service', () => ({ __esModule: true, OWNER_BRIEFING_KIND: 'owner_briefing', generateOwnerBriefing: (...a: any[]) => mockGenerateOwnerBriefing(...a) }));

const mockDescribeImage = jest.fn(async (..._a: any[]) => 'a described image');
jest.mock('../image-describe', () => ({
  __esModule: true,
  describeImageWithVision: (...a: any[]) => mockDescribeImage(...a),
  VISION_UTILITY_MODEL: 'glm-5.3-flash',
  resolveVisionDescribeModel: async () => 'glm-5.3-flash',
}));

const mockEmitHookEventSafe = jest.fn(async (..._a: any[]) => {});
const mockClearHookDepth = jest.fn(async (..._a: any[]) => {});
const mockStampHookDepth = jest.fn(async (..._a: any[]) => {});
const mockOldestPendingHookAgeMs: jest.Mock = jest.fn(async () => 0);
const mockDrainHookEventsForTarget = jest.fn();
const mockHookBacklogStarving: jest.Mock = jest.fn(async () => false);
const mockDrainHookEventsForTargetNow: jest.Mock = jest.fn(async () => true);
const mockHooksFirstVerdict: jest.Mock = jest.fn(async () => ({ hooksFirst: false, reason: 'no_hooks', hookAgeMs: 0, queueHeadAgeMs: 0 }));
jest.mock('../platform/hooks.service', () => ({
  __esModule: true,
  emitHookEventSafe: (...a: any[]) => mockEmitHookEventSafe(...a),
  clearHookDepth: (...a: any[]) => mockClearHookDepth(...a),
  stampHookDepth: (...a: any[]) => mockStampHookDepth(...a),
  oldestPendingHookAgeMs: (...a: any[]) => mockOldestPendingHookAgeMs(...a),
  drainHookEventsForTarget: (...a: any[]) => mockDrainHookEventsForTarget(...a),
  hookBacklogStarving: (...a: any[]) => mockHookBacklogStarving(...a),
  drainHookEventsForTargetNow: (...a: any[]) => mockDrainHookEventsForTargetNow(...a),
  hooksFirstVerdict: (...a: any[]) => mockHooksFirstVerdict(...a),
}));

const mockOnSupervisorRunFinalized = jest.fn(async (_a?: any) => {});
jest.mock('../platform/supervisor-wake-ledger', () => ({
  __esModule: true,
  buildWakeLedgerBlock: jest.fn(async () => null),
  onSupervisorRunFinalized: (...a: any[]) => mockOnSupervisorRunFinalized(...a),
  materialGateForDrain: jest.fn(async () => null),
  ackMaterialGateDrain: jest.fn(async () => true),
  recordMaterialGateAgreement: jest.fn(),
  closeStashesForGateSkip: jest.fn(async () => {}),
}));
void mockOnSupervisorRunFinalized;

const mockRecordLoopMetric: jest.Mock = jest.fn();
const mockRecordRunSpend: jest.Mock = jest.fn();
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
  recordLoopMetrics: jest.fn(),
  recordRunSpend: (...a: any[]) => mockRecordRunSpend(...a),
  LOOP_METRIC_KINDS: {
    GUARD_STRIKE: 'guard_strike', GUARD_MISS: 'guard_miss',
    QUEUE_FAIRNESS_PREEMPT: 'queue_fairness_preempt',
    FINALIZE_HOOKS_FIRST: 'finalize_hooks_first',
    CHAT_SEARCH_USAGE: 'chat_search_usage',
    CHAT_PLATFORM_USAGE: 'chat_platform_usage',
    SUPERVISOR_DEFERRAL_UNARMED: 'supervisor_deferral_unarmed',
    DEPLOY_RETIRE_NUDGE: 'deploy_retire_nudge',
    TURN_CONTINUATION: 'turn_continuation',
    SPAWN_TURN_END: 'spawn_turn_end',
  },
}));

jest.mock('./chat-context', () => ({
  buildChatQueryContext: jest.fn(async () => ({
    queryMessage: 'the question',
    systemContext: '',
    conversationHistory: [{ role: 'user', content: 'earlier' }],
    projectId: null,
  })),
  persistAndEmitCanvases: jest.fn(async () => []),
}));

// THE SEAM UNDER TEST — the lane board builder, mocked at the module boundary
// (the real module's chain reaches prisma/redis; its renderer is pinned in its
// own suite).
const mockBuildLaneBoardBlock: jest.Mock = jest.fn(async () => '');
jest.mock('../platform/board-digest.service', () => ({
  __esModule: true,
  ...jest.requireActual('../platform/board-digest.service'),
  buildLaneBoardBlock: (...a: any[]) => mockBuildLaneBoardBlock(...a),
  // the supervisor [BOARD] builder stays the real stub-free default? No — the
  // real buildBoardDigestBlock reads prisma; return '' so the supervisor tests
  // here only pin the LANE board seam.
  buildBoardDigestBlock: jest.fn(async () => ''),
  buildProjectScheduleBlock: jest.fn(async () => ''),
}));

import { startDetachedChatRun } from './chat-agent.service';
import { runCodingAgent } from '../coding/agent';
import { isRunActive } from '../coding/live-runs';

const BASE = { message: 'the question', mode: 'single_thinking' as const };

async function waitFor(pred: () => boolean, ms = 3000): Promise<void> {
  const t0 = Date.now();
  while (!pred() && Date.now() - t0 < ms) await new Promise(r => setTimeout(r, 10));
  if (!pred()) throw new Error('timed out waiting for run events');
}

const persistedUserRows = () => mockPrisma.crossModelMessage.create.mock.calls.map((c: any[]) => c[0]?.data).filter((d: any) => d?.role === 'user');

const LANE_BLOCK = '[BOARD — this lane\'s live ledger, read from Postgres at compose time (2026-10-16T12:39Z). This is the ONLY source for owner-question and todo STATUS claims in your note: cite these ids and statuses verbatim. A status you remember that differs from this block is WRONG — the block wins. If you need a status not listed here, read it with a tool (list_owner_questions / todo_get), never recall it.]\nOWNER QUESTIONS linked to this chat: 0 open · 3 answered/dismissed (ledger, read 2026-10-16T12:39Z)\n- OPEN owner questions: NONE — nothing is waiting on the owner; never write that something is "owner-gated" or "awaiting the owner\'s decision" unless you file the question this wake (flag_owner_question).\n- oq_3dab2289 ANSWERED 10-09 02:00Z by owner — NOT open; cite it as answered\n- oq_c620c908 ANSWERED 10-11 22:00Z by owner — NOT open; cite it as answered\n- oq_dcc88817 ANSWERED 10-12 19:00Z by owner — NOT open; cite it as answered';

const PLAIN_LANE_ROW = { title: 'Sunday Market digest lane', isSupervisor: false, isProjectSupervisor: false, userId: 'u1', projectId: 'p1' };
const PROJ_SUP_ROW = { title: 'Schooltime Supervisor', isSupervisor: false, isProjectSupervisor: true, userId: 'u1', projectId: 'p1' };

beforeEach(() => {
  redisStore.clear();
  redisLists.clear();
  (runCodingAgent as jest.Mock).mockClear();
  mockPrisma.crossModelMessage.create.mockClear();
  mockBuildLaneBoardBlock.mockReset().mockResolvedValue('');
  mockPrisma.crossModelChat.findUnique.mockImplementation(async () => PLAIN_LANE_ROW);
  delete process.env.LANE_BOARD_BLOCK_DISABLED;
});
afterEach(() => { delete process.env.LANE_BOARD_BLOCK_DISABLED; });

describe('lane board wiring (2c203dac) — the wake prompt seam', () => {
  it('a NON-supervisor MACHINE-ORIGIN run (agent steer — the mishap shape) carries the lane board in its system context', async () => {
    mockBuildLaneBoardBlock.mockResolvedValue(LANE_BLOCK);
    const key = await startDetachedChatRun({ ...BASE, userId: 'u1', chatId: 'chat-lane-1', sessionId: null, machineWake: false, messageOrigin: 'agent' });
    expect(key).toBe('chat:chat-lane-1');
    await waitFor(() => (runCodingAgent as jest.Mock).mock.calls.length > 0);
    await waitFor(() => !isRunActive('chat:chat-lane-1'));
    expect(mockBuildLaneBoardBlock).toHaveBeenCalledWith('chat-lane-1');
    // the drained-steer seam: the block rides the DOCTRINE the lead runs with
    // (chatDoctrine/councilLeadDoctrine systemContext → doctrineOverride), not
    // the persisted wake prompt.
    const doctrine = String((runCodingAgent as jest.Mock).mock.calls[0][0].doctrineOverride ?? '');
    expect(doctrine).toContain('this lane\'s live ledger');
    expect(doctrine).toContain('oq_dcc88817 ANSWERED');
  });

  it('a schedule-firing machine wake (machineWake: true, plain chat) carries it too', async () => {
    mockBuildLaneBoardBlock.mockResolvedValue(LANE_BLOCK);
    const key = await startDetachedChatRun({ ...BASE, userId: 'u1', chatId: 'chat-lane-2', sessionId: null, machineWake: true, messageOrigin: 'schedule' });
    expect(key).toBe('chat:chat-lane-2');
    await waitFor(() => (runCodingAgent as jest.Mock).mock.calls.length > 0);
    await waitFor(() => !isRunActive('chat:chat-lane-2'));
    const wakeRow = persistedUserRows().find((d: any) => String(d.content).includes('this lane\'s live ledger'));
    expect(wakeRow).toBeTruthy();
  });

  it('a USER-anchored run (origin user) gets NO lane board — the doctrine is a machine-wake contract', async () => {
    mockBuildLaneBoardBlock.mockResolvedValue(LANE_BLOCK);
    const key = await startDetachedChatRun({ ...BASE, userId: 'u1', chatId: 'chat-lane-3', sessionId: null, messageOrigin: 'user' });
    expect(key).toBe('chat:chat-lane-3');
    await waitFor(() => (runCodingAgent as jest.Mock).mock.calls.length > 0);
    await waitFor(() => !isRunActive('chat:chat-lane-3'));
    expect(mockBuildLaneBoardBlock).not.toHaveBeenCalled();
    expect(persistedUserRows().some((d: any) => String(d.content).includes('this lane\'s live ledger'))).toBe(false);
  });

  it('a supervisor chat does not get the lane board appended (its [BOARD] is already the project/fleet one)', async () => {
    mockBuildLaneBoardBlock.mockResolvedValue(LANE_BLOCK);
    mockPrisma.crossModelChat.findUnique.mockImplementation(async () => PROJ_SUP_ROW);
    const key = await startDetachedChatRun({ ...BASE, userId: 'u1', chatId: 'chat-sup-1', sessionId: null, machineWake: true, messageOrigin: 'schedule' });
    expect(key).toBe('chat:chat-sup-1');
    await waitFor(() => (runCodingAgent as jest.Mock).mock.calls.length > 0);
    await waitFor(() => !isRunActive('chat:chat-sup-1'));
    expect(mockBuildLaneBoardBlock).not.toHaveBeenCalled();
  });

  it('kill switch LANE_BOARD_BLOCK_DISABLED=1 restores the pre-fix wake (builder never called)', async () => {
    process.env.LANE_BOARD_BLOCK_DISABLED = '1';
    mockBuildLaneBoardBlock.mockResolvedValue(LANE_BLOCK);
    const key = await startDetachedChatRun({ ...BASE, userId: 'u1', chatId: 'chat-lane-4', sessionId: null, machineWake: false, messageOrigin: 'agent' });
    expect(key).toBe('chat:chat-lane-4');
    await waitFor(() => (runCodingAgent as jest.Mock).mock.calls.length > 0);
    await waitFor(() => !isRunActive('chat:chat-lane-4'));
    expect(mockBuildLaneBoardBlock).not.toHaveBeenCalled();
  });

  it('an empty lane board (no linked rows) leaves the wake prompt byte-identical to before', async () => {
    mockBuildLaneBoardBlock.mockResolvedValue('');
    const key = await startDetachedChatRun({ ...BASE, userId: 'u1', chatId: 'chat-lane-5', sessionId: null, machineWake: false, messageOrigin: 'agent' });
    expect(key).toBe('chat:chat-lane-5');
    await waitFor(() => (runCodingAgent as jest.Mock).mock.calls.length > 0);
    await waitFor(() => !isRunActive('chat:chat-lane-5'));
    const rows = persistedUserRows().filter((d: any) => String(d.content).includes('the question'));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((d: any) => String(d.content).includes('lane\'s live ledger'))).toBe(false);
  });
});
