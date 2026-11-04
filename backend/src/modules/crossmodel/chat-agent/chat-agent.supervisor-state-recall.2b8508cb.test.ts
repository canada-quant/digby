/**
 * Ticket 2b8508cb — [SUPERVISOR STATE (retrieved)] on the MACHINE-wake compose
 * seam (chat-agent.service startDetachedChatRun): a supervisor machine wake's
 * composed prompt carries the semantic recall block built from the embedded
 * `supervisor_state` memory rows, queried with the wake's OWN original
 * message; a plain chat gets none; kill switch
 * SUPERVISOR_STATE_RECALL_DISABLED=1 restores the pre-fix behavior.
 * (The owner-typed seam is pinned in chat-context.recall.2b8508cb.test.ts.)
 * Harness copied from chat-agent.supervisor-journal.9993f30c.test.ts.
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
    mGet: jest.fn(async (keys: string[]) => keys.map((k: string) => redisStore.get(k) ?? null)),
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
    constructor(public statusCode: number, public message: string, isOperational = true) { super(message); Object.setPrototypeOf(this, AppError.prototype); }
  },
}));

jest.mock('../coding/coding-model', () => ({
  __esModule: true,
  ...jest.requireActual('../coding/coding-model'),
  seatUnservableReason: jest.fn(async () => null),
}));

const AGENT_RESULT: any = { finalText: 'Supervisor sweep complete. ' + 'B'.repeat(400), receipts: [], parts: [] };
jest.mock('../coding/agent', () => ({
  runCodingAgent: jest.fn(async () => ({ ...AGENT_RESULT })),
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
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
  recordLoopMetrics: jest.fn(),
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

jest.mock('../platform/board-digest.service', () => ({
  __esModule: true,
  ...jest.requireActual('../platform/board-digest.service'),
  buildLaneBoardBlock: jest.fn(async () => ''),
  buildBoardDigestBlock: jest.fn(async () => ''),
  buildProjectScheduleBlock: jest.fn(async () => ''),
}));

// The journal seam (9993f30c) — off, so only THIS seam's block composes.
jest.mock('../coding/run-journal.service', () => ({
  __esModule: true,
  writeSupervisorTurnEntryAsync: jest.fn(),
  buildSupervisorJournalBlock: jest.fn(async () => ''),
}));

// THE SEAM UNDER TEST — the supervisor-state memory bridge, mocked at the
// module boundary (its internals are pinned in
// supervisor-state-memory.test.ts; here we pin WHO calls it, with WHAT).
const mockBuildRecall: jest.Mock = jest.fn(async () => '');
const mockEmbedDoc: jest.Mock = jest.fn(async () => 0);
// MIND-HYGIENE (2026-10-20): the diff-keyed path is OFF unless a test turns it
// on — the 2b8508cb pins below cover the trigger-text call shape.
let mockRecallHygieneOn = false;
jest.mock('../platform/supervisor-state-memory', () => ({
  __esModule: true,
  buildSupervisorStateRecallBlock: (...a: any[]) => mockBuildRecall(...a),
  embedSupervisorStateDoc: (...a: any[]) => mockEmbedDoc(...a),
  searchSupervisorStateMem: jest.fn(async () => []),
  supervisorRecallDiffQueryDisabled: () => !mockRecallHygieneOn,
  recallQueryFromLedgerDiff: (diff: string, fallback: string) => (diff ? `DIFF-QUERY<${diff.split('\n')[1] ?? ''}>` : fallback),
}));

import { startDetachedChatRun } from './chat-agent.service';
import { runCodingAgent } from '../coding/agent';
import { isRunActive } from '../coding/live-runs';

const BASE = { message: 'the question about the backup budget', mode: 'single_thinking' as const };

async function waitFor(pred: () => boolean, ms = 3000): Promise<void> {
  const t0 = Date.now();
  while (!pred() && Date.now() - t0 < ms) await new Promise(r => setTimeout(r, 10));
  if (!pred()) throw new Error('timed out waiting for run events');
}

const persistedUserRows = () => mockPrisma.crossModelMessage.create.mock.calls.map((c: any[]) => c[0]?.data).filter((d: any) => d?.role === 'user');

const FLEET_SUP_ROW = { title: 'Fleet Supervisor', isSupervisor: true, isProjectSupervisor: false, userId: 'u1', projectId: null };
const PROJ_SUP_ROW = { title: 'Schooltime Supervisor', isSupervisor: false, isProjectSupervisor: true, userId: 'u1', projectId: 'p1' };
const PLAIN_ROW = { title: 'A plain lane chat', isSupervisor: false, isProjectSupervisor: false, userId: 'u1', projectId: 'p1' };

const RECALL_BLOCK = '[SUPERVISOR STATE (retrieved) — semantic hits from your durable state doc]\n- (directive dir-old) Directive dir-old (2026-09-20): keep the backup budget under 40 dollars a day — status: open';

beforeEach(() => {
  redisStore.clear();
  redisLists.clear();
  (runCodingAgent as jest.Mock).mockClear();
  mockPrisma.crossModelMessage.create.mockClear();
  mockBuildRecall.mockReset().mockResolvedValue('');
  mockEmbedDoc.mockReset().mockResolvedValue(0);
  mockPrisma.crossModelChat.findUnique.mockImplementation(async () => FLEET_SUP_ROW);
  delete process.env.SUPERVISOR_STATE_RECALL_DISABLED;
});
afterEach(() => { delete process.env.SUPERVISOR_STATE_RECALL_DISABLED; });

describe('supervisor-state recall wiring (2b8508cb) — the machine-wake compose seam', () => {
  it('a supervisor MACHINE wake carries the recall block in its composed wake prompt', async () => {
    mockBuildRecall.mockResolvedValue(RECALL_BLOCK);
    const key = await startDetachedChatRun({ ...BASE, userId: 'u1', chatId: 'chat-sup-1', sessionId: null, machineWake: true, messageOrigin: 'schedule' });
    expect(key).toBe('chat:chat-sup-1');
    await waitFor(() => (runCodingAgent as jest.Mock).mock.calls.length > 0);
    await waitFor(() => !isRunActive('chat:chat-sup-1'));
    // queried with the wake's OWN original message (pre-preamble), k=5
    expect(mockBuildRecall).toHaveBeenCalledWith('chat-sup-1', 'the question about the backup budget', 5);
    const wakeRow = persistedUserRows().find((d: any) => String(d.content).includes('SUPERVISOR STATE (retrieved)'));
    expect(wakeRow).toBeTruthy();
    expect(String(wakeRow?.content)).toContain('keep the backup budget under 40 dollars a day');
  });

  it('a PROJECT supervisor machine wake gets the same recall block (both supervisor shapes)', async () => {
    mockPrisma.crossModelChat.findUnique.mockImplementation(async () => PROJ_SUP_ROW);
    mockBuildRecall.mockResolvedValue(RECALL_BLOCK);
    const key = await startDetachedChatRun({ ...BASE, userId: 'u1', chatId: 'chat-sup-2', sessionId: null, machineWake: true, messageOrigin: 'schedule' });
    expect(key).toBe('chat:chat-sup-2');
    await waitFor(() => (runCodingAgent as jest.Mock).mock.calls.length > 0);
    await waitFor(() => !isRunActive('chat:chat-sup-2'));
    expect(mockBuildRecall).toHaveBeenCalledWith('chat-sup-2', 'the question about the backup budget', 5);
  });

  it('an empty recall (no hits) leaves the composed wake exactly as before', async () => {
    mockBuildRecall.mockResolvedValue('');
    const key = await startDetachedChatRun({ ...BASE, userId: 'u1', chatId: 'chat-sup-3', sessionId: null, machineWake: true, messageOrigin: 'schedule' });
    expect(key).toBe('chat:chat-sup-3');
    await waitFor(() => (runCodingAgent as jest.Mock).mock.calls.length > 0);
    await waitFor(() => !isRunActive('chat:chat-sup-3'));
    expect(mockBuildRecall).toHaveBeenCalledWith('chat-sup-3', 'the question about the backup budget', 5);
    expect(persistedUserRows().some((d: any) => String(d.content).includes('SUPERVISOR STATE (retrieved)'))).toBe(false);
  });

  it('a PLAIN chat machine wake does not query the recall block', async () => {
    mockPrisma.crossModelChat.findUnique.mockImplementation(async () => PLAIN_ROW);
    const key = await startDetachedChatRun({ ...BASE, userId: 'u1', chatId: 'chat-plain-1', sessionId: null, machineWake: true, messageOrigin: 'schedule' });
    expect(key).toBe('chat:chat-plain-1');
    await waitFor(() => (runCodingAgent as jest.Mock).mock.calls.length > 0);
    await waitFor(() => !isRunActive('chat:chat-plain-1'));
    expect(mockBuildRecall).not.toHaveBeenCalled();
  });

  it('kill switch SUPERVISOR_STATE_RECALL_DISABLED=1: the recall block is not queried', async () => {
    process.env.SUPERVISOR_STATE_RECALL_DISABLED = '1';
    mockBuildRecall.mockResolvedValue(RECALL_BLOCK);
    const key = await startDetachedChatRun({ ...BASE, userId: 'u1', chatId: 'chat-sup-4', sessionId: null, machineWake: true, messageOrigin: 'schedule' });
    expect(key).toBe('chat:chat-sup-4');
    await waitFor(() => (runCodingAgent as jest.Mock).mock.calls.length > 0);
    await waitFor(() => !isRunActive('chat:chat-sup-4'));
    expect(mockBuildRecall).not.toHaveBeenCalled();
  });
});

describe('MIND-HYGIENE (2026-10-20) — the machine-wake recall is keyed on the ledger diff and told what the wake shows', () => {
  const wl = jest.requireMock('../platform/supervisor-wake-ledger') as { buildWakeLedgerBlock: jest.Mock };
  beforeEach(() => { mockRecallHygieneOn = true; });
  afterEach(() => { mockRecallHygieneOn = false; wl.buildWakeLedgerBlock.mockReset().mockResolvedValue(null); });

  it('queries the rendered [SINCE YOUR LAST WAKE] diff and passes the composed wake as visibleText', async () => {
    wl.buildWakeLedgerBlock.mockResolvedValue({ block: '[SINCE YOUR LAST WAKE — diff]\nOwner messages: in this chat 11:40Z "raise the GPU budget"', at: new Date().toISOString(), since: new Date().toISOString() });
    mockBuildRecall.mockResolvedValue(RECALL_BLOCK);
    const key = await startDetachedChatRun({ ...BASE, userId: 'u1', chatId: 'chat-sup-h1', sessionId: null, machineWake: true, messageOrigin: 'schedule' });
    expect(key).toBe('chat:chat-sup-h1');
    await waitFor(() => (runCodingAgent as jest.Mock).mock.calls.length > 0);
    await waitFor(() => !isRunActive('chat:chat-sup-h1'));
    const call = mockBuildRecall.mock.calls[0] as any[];
    expect(call[0]).toBe('chat-sup-h1');
    expect(call[1]).toBe('DIFF-QUERY<Owner messages: in this chat 11:40Z "raise the GPU budget">');
    expect(call[2]).toBe(5);
    expect(String(call[3]?.visibleText)).toContain('[SINCE YOUR LAST WAKE — diff]');
  });

  it('no ledger diff: falls back to the wake\'s own trigger text', async () => {
    const key = await startDetachedChatRun({ ...BASE, userId: 'u1', chatId: 'chat-sup-h2', sessionId: null, machineWake: true, messageOrigin: 'schedule' });
    expect(key).toBe('chat:chat-sup-h2');
    await waitFor(() => (runCodingAgent as jest.Mock).mock.calls.length > 0);
    await waitFor(() => !isRunActive('chat:chat-sup-h2'));
    const call = mockBuildRecall.mock.calls[0] as any[];
    expect(call[1]).toBe('the question about the backup budget');
    expect(call[3]).toHaveProperty('visibleText');
  });

  // Review fix (2026-10-20): the [OPEN OWNER ASKS] block renders asks WITHOUT ids, and hideAskIds
  // also names answered-not-closed asks kept out on purpose — the recall must treat both as shown.
  it("passes the owner-asks wake's hideAskIds as hiddenIds", async () => {
    const asks = require('../platform/owner-asks');
    const spy = jest.spyOn(asks, 'buildOpenOwnerAsksWake').mockResolvedValue({ block: '[OPEN OWNER ASKS — ANSWER FIRST]\n- (2h ago) is the GPU budget raised?', hideAskIds: ['a5a5a5a5-1111-2222-3333-444455556666'], reconciledAskIds: [] });
    try {
      const key = await startDetachedChatRun({ ...BASE, userId: 'u1', chatId: 'chat-sup-h3', sessionId: null, machineWake: true, messageOrigin: 'schedule' });
      expect(key).toBe('chat:chat-sup-h3');
      await waitFor(() => (runCodingAgent as jest.Mock).mock.calls.length > 0);
      await waitFor(() => !isRunActive('chat:chat-sup-h3'));
      const call = mockBuildRecall.mock.calls[0] as any[];
      expect(call[3]?.hiddenIds).toEqual(['a5a5a5a5-1111-2222-3333-444455556666']);
      expect(String(call[3]?.visibleText)).toContain('[OPEN OWNER ASKS — ANSWER FIRST]');
    } finally {
      spy.mockRestore();
    }
  });
});
