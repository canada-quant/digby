/**
 * SUPERVISOR RUN JOURNAL (ticket 9993f30c) — the chat-agent seams:
 *  - WRITE: a supervisor chat turn (machine wake OR owner-typed) finalizes →
 *    ONE deterministic, receipt-backed journal row (writeSupervisorTurnEntryAsync
 *    via dynamic import at the finalize cluster next to the wake-ledger hook).
 *    A plain (non-supervisor) chat turn writes NOTHING.
 *  - READ: a supervisor MACHINE wake carries [PREVIOUS SUPERVISOR TURNS IN
 *    THIS CHAT] in its composed wake prompt (supervisorStateBlock); the
 *    human-turn seam (loadChatContextNode) is pinned in
 *    chat-context.supervisor-journal.9993f30c.test.ts.
 *  - kill switch SUPERVISOR_RUN_JOURNAL_DISABLED=1 restores the pre-fix
 *    behavior on both sides.
 * The journal module is mocked at the module boundary (its renderer/writer are
 * pinned in run-journal.service.test.ts's supervisor suite).
 * Harness copied from chat-agent.lane-board.2c203dac.test.ts.
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
    constructor(public statusCode: number, public message: string, public isOperational = true) { super(message); Object.setPrototypeOf(this, AppError.prototype); }
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

jest.mock('../platform/board-digest.service', () => ({
  __esModule: true,
  ...jest.requireActual('../platform/board-digest.service'),
  buildLaneBoardBlock: jest.fn(async () => ''),
  buildBoardDigestBlock: jest.fn(async () => ''),
  buildProjectScheduleBlock: jest.fn(async () => ''),
}));

// THE SEAM UNDER TEST — the supervisor journal module, mocked at the module
// boundary (the writer/renderer are pinned in run-journal.service.test.ts's
// supervisor suite; here we pin WHO calls them, with WHAT).
const mockWriteSupervisorTurnEntry: jest.Mock = jest.fn();
const mockBuildSupervisorJournalBlock: jest.Mock = jest.fn(async () => '');
jest.mock('../coding/run-journal.service', () => ({
  __esModule: true,
  writeSupervisorTurnEntryAsync: (...a: any[]) => mockWriteSupervisorTurnEntry(...a),
  buildSupervisorJournalBlock: (...a: any[]) => mockBuildSupervisorJournalBlock(...a),
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

const JOURNAL_BLOCK = '[PREVIOUS SUPERVISOR TURNS IN THIS CHAT — your own run journal, harness-written; what earlier turns did and the receipt ids that back them; newest first]\n- 2026-10-16 21:02Z · trigger=machine\n  Goal: SUPERVISOR TURN — sweep the fleet for attention items\n  Outcome: One stalled lane re-queued; board cited verbatim.\n  receipt ids (verified tool calls): a1b2c3d4, e5f6a7b8';

const FLEET_SUP_ROW = { title: 'Fleet Supervisor', isSupervisor: true, isProjectSupervisor: false, userId: 'u1', projectId: null };
const PROJ_SUP_ROW = { title: 'Schooltime Supervisor', isSupervisor: false, isProjectSupervisor: true, userId: 'u1', projectId: 'p1' };
const PLAIN_ROW = { title: 'A plain lane chat', isSupervisor: false, isProjectSupervisor: false, userId: 'u1', projectId: 'p1' };

beforeEach(() => {
  redisStore.clear();
  redisLists.clear();
  (runCodingAgent as jest.Mock).mockClear();
  mockPrisma.crossModelMessage.create.mockClear();
  mockWriteSupervisorTurnEntry.mockReset();
  mockBuildSupervisorJournalBlock.mockReset().mockResolvedValue('');
  mockPrisma.crossModelChat.findUnique.mockImplementation(async () => FLEET_SUP_ROW);
  delete process.env.SUPERVISOR_RUN_JOURNAL_DISABLED;
});
afterEach(() => { delete process.env.SUPERVISOR_RUN_JOURNAL_DISABLED; });

describe('supervisor run journal wiring (9993f30c) — the write seam', () => {
  it('a supervisor MACHINE wake finalizes → ONE journal row via writeSupervisorTurnEntryAsync, trigger machine', async () => {
    const key = await startDetachedChatRun({ ...BASE, userId: 'u1', chatId: 'chat-sup-1', sessionId: null, machineWake: true, messageOrigin: 'schedule' });
    expect(key).toBe('chat:chat-sup-1');
    await waitFor(() => (runCodingAgent as jest.Mock).mock.calls.length > 0);
    await waitFor(() => !isRunActive('chat:chat-sup-1'));
    await waitFor(() => mockWriteSupervisorTurnEntry.mock.calls.length > 0);
    expect(mockWriteSupervisorTurnEntry).toHaveBeenCalledTimes(1);
    const payload = mockWriteSupervisorTurnEntry.mock.calls[0][0];
    expect(payload.chatId).toBe('chat-sup-1');
    expect(payload.triggerKind).toBe('schedule');
    expect(payload.failed).toBe(false);
    // The wake's ORIGINAL (pre-preamble) message is journaled, not the composed
    // machineWakePreamble+state-doc text.
    expect(String(payload.message)).toBe('the question');
  });

  it('an OWNER-TYPED supervisor turn (origin user) also journals — trigger user', async () => {
    const key = await startDetachedChatRun({ ...BASE, userId: 'u1', chatId: 'chat-sup-2', sessionId: null, messageOrigin: 'user' });
    expect(key).toBe('chat:chat-sup-2');
    await waitFor(() => (runCodingAgent as jest.Mock).mock.calls.length > 0);
    await waitFor(() => !isRunActive('chat:chat-sup-2'));
    await waitFor(() => mockWriteSupervisorTurnEntry.mock.calls.length > 0);
    const payload = mockWriteSupervisorTurnEntry.mock.calls[0][0];
    expect(payload.chatId).toBe('chat-sup-2');
    expect(payload.triggerKind).toBe('user');
  });

  it('a PROJECT supervisor turn journals too (both supervisor shapes)', async () => {
    mockPrisma.crossModelChat.findUnique.mockImplementation(async () => PROJ_SUP_ROW);
    const key = await startDetachedChatRun({ ...BASE, userId: 'u1', chatId: 'chat-sup-3', sessionId: null, machineWake: true, messageOrigin: 'schedule' });
    expect(key).toBe('chat:chat-sup-3');
    await waitFor(() => (runCodingAgent as jest.Mock).mock.calls.length > 0);
    await waitFor(() => !isRunActive('chat:chat-sup-3'));
    await waitFor(() => mockWriteSupervisorTurnEntry.mock.calls.length > 0);
    expect(mockWriteSupervisorTurnEntry.mock.calls[0][0].chatId).toBe('chat-sup-3');
  });

  it('a PLAIN (non-supervisor) chat turn writes NO journal row — the seam is supervisor-only', async () => {
    mockPrisma.crossModelChat.findUnique.mockImplementation(async () => PLAIN_ROW);
    const key = await startDetachedChatRun({ ...BASE, userId: 'u1', chatId: 'chat-plain-1', sessionId: null, machineWake: true, messageOrigin: 'schedule' });
    expect(key).toBe('chat:chat-plain-1');
    await waitFor(() => (runCodingAgent as jest.Mock).mock.calls.length > 0);
    await waitFor(() => !isRunActive('chat:chat-plain-1'));
    // fire-and-forget finalize hooks get a beat to (not) fire
    await new Promise(r => setTimeout(r, 150));
    expect(mockWriteSupervisorTurnEntry).not.toHaveBeenCalled();
  });

  it('the turn\'s tool receipts and tool names ride the journal payload (receipt-backed, per the ticket)', async () => {
    (runCodingAgent as jest.Mock).mockImplementationOnce(async () => ({
      finalText: 'Supervisor acted. ' + 'C'.repeat(400),
      receipts: [
        { id: 'a1b2c3d4-1111-2222-3333-444455556666', ok: true, tool: 'send_chat_message', ids: { chatId: 'lane-9' } },
        { id: 'e5f6a7b8-1111-2222-3333-444455556666', ok: true, tool: 'todo_update', ids: { ticketId: 't-1' } },
        { id: '00000000-0000-0000-0000-000000000000', ok: false, tool: 'git_push', ids: {} },
      ],
      parts: [
        { type: 'tool_call', name: 'send_chat_message' },
        { type: 'tool_call', name: 'list_owner_questions' },
        { type: 'text', text: 'done' },
      ],
    }));
    const key = await startDetachedChatRun({ ...BASE, userId: 'u1', chatId: 'chat-sup-4', sessionId: null, machineWake: true, messageOrigin: 'schedule' });
    expect(key).toBe('chat:chat-sup-4');
    await waitFor(() => (runCodingAgent as jest.Mock).mock.calls.length > 0);
    await waitFor(() => !isRunActive('chat:chat-sup-4'));
    await waitFor(() => mockWriteSupervisorTurnEntry.mock.calls.length > 0);
    const payload = mockWriteSupervisorTurnEntry.mock.calls[0][0];
    expect(payload.receipts).toHaveLength(3);
    // The wiring payload carries the parts-derived tool names; the writer
    // unions in the receipt tools (pinned in run-journal.service.test.ts s1).
    expect(payload.toolsUsed).toEqual(['send_chat_message', 'list_owner_questions']);
    expect(String(payload.finalNote)).toContain('Supervisor acted');
  });

  it('kill switch SUPERVISOR_RUN_JOURNAL_DISABLED=1: neither the write nor the read fires', async () => {
    process.env.SUPERVISOR_RUN_JOURNAL_DISABLED = '1';
    mockBuildSupervisorJournalBlock.mockResolvedValue(JOURNAL_BLOCK);
    const key = await startDetachedChatRun({ ...BASE, userId: 'u1', chatId: 'chat-sup-5', sessionId: null, machineWake: true, messageOrigin: 'schedule' });
    expect(key).toBe('chat:chat-sup-5');
    await waitFor(() => (runCodingAgent as jest.Mock).mock.calls.length > 0);
    await waitFor(() => !isRunActive('chat:chat-sup-5'));
    await new Promise(r => setTimeout(r, 150));
    expect(mockWriteSupervisorTurnEntry).not.toHaveBeenCalled();
    expect(mockBuildSupervisorJournalBlock).not.toHaveBeenCalled();
  });
});

describe('supervisor run journal wiring (9993f30c) — the machine-wake read seam', () => {
  it('a supervisor MACHINE wake carries the journal block in its composed wake prompt (persisted user row)', async () => {
    mockBuildSupervisorJournalBlock.mockResolvedValue(JOURNAL_BLOCK);
    const key = await startDetachedChatRun({ ...BASE, userId: 'u1', chatId: 'chat-sup-6', sessionId: null, machineWake: true, messageOrigin: 'schedule' });
    expect(key).toBe('chat:chat-sup-6');
    await waitFor(() => (runCodingAgent as jest.Mock).mock.calls.length > 0);
    await waitFor(() => !isRunActive('chat:chat-sup-6'));
    expect(mockBuildSupervisorJournalBlock).toHaveBeenCalledWith('chat-sup-6');
    const wakeRow = persistedUserRows().find((d: any) => String(d.content).includes('PREVIOUS SUPERVISOR TURNS IN THIS CHAT'));
    expect(wakeRow).toBeTruthy();
    expect(String(wakeRow?.content)).toContain('receipt ids (verified tool calls): a1b2c3d4, e5f6a7b8');
  });

  it('an empty journal (first journaled turn) leaves the wake prompt without the block', async () => {
    mockBuildSupervisorJournalBlock.mockResolvedValue('');
    const key = await startDetachedChatRun({ ...BASE, userId: 'u1', chatId: 'chat-sup-7', sessionId: null, machineWake: true, messageOrigin: 'schedule' });
    expect(key).toBe('chat:chat-sup-7');
    await waitFor(() => (runCodingAgent as jest.Mock).mock.calls.length > 0);
    await waitFor(() => !isRunActive('chat:chat-sup-7'));
    expect(mockBuildSupervisorJournalBlock).toHaveBeenCalledWith('chat-sup-7');
    expect(persistedUserRows().some((d: any) => String(d.content).includes('PREVIOUS SUPERVISOR TURNS IN THIS CHAT'))).toBe(false);
  });

  it('a PLAIN chat machine wake does not read the supervisor journal block', async () => {
    mockPrisma.crossModelChat.findUnique.mockImplementation(async () => PLAIN_ROW);
    const key = await startDetachedChatRun({ ...BASE, userId: 'u1', chatId: 'chat-plain-2', sessionId: null, machineWake: true, messageOrigin: 'schedule' });
    expect(key).toBe('chat:chat-plain-2');
    await waitFor(() => (runCodingAgent as jest.Mock).mock.calls.length > 0);
    await waitFor(() => !isRunActive('chat:chat-plain-2'));
    expect(mockBuildSupervisorJournalBlock).not.toHaveBeenCalled();
  });
});
