/**
 * Ticket 4ac547de — follow-up chips missing at Level 2 (Thinking).
 *
 * MEASURED (prod probe, 2026-10-17): 126/126 zero-chip `chat_platform_usage`
 * rows in the alert window were HUMAN-typed turns in SUPERVISOR chats on the
 * kimi-k3 lead; plain chats were at the healthy band. Mechanism: on a
 * supervisor owner turn the stored supervisor doctrine's wake-close contract
 * ("CLOSE with exactly ONE of: 'WAKE: no-op' / 'ACTIONS TAKEN' …") and the
 * answer-first split notice ("End with ONE line … 'Follow-through: …'")
 * outcompete the chat playbook's single `[FOLLOWUPS]` line, so the lead's
 * final text carries no block; supervisor chats also skip the Double Checker
 * (supervisorNoChecker), so the step-0 reconcile safety net
 * (chat-agent.service.ts ~5103) has no draft chips to re-append, and the old
 * utility fallback `generateFollowUps` (moonshot.integration.ts — "Called as
 * a fallback when Kimi's synthesis didn't produce [FOLLOWUPS] tags") had
 * ZERO callers. Result: `metadata.followUps` never persisted, the reload
 * shows no chips, the usage metric reads followUps:0.
 *
 * THE FIX (this suite pins it): a deterministic, bounded, fail-open backstop
 * at the finalize parse seam — when a SIGNED-IN, human-typed, non-continuation
 * Level 2 ('thinking') answer parses ZERO chips, the dormant
 * `moonshotIntegration.generateFollowUps` utility generates them and the
 * result rides the SAME variable the model's own block would have (metric +
 * 'followups' event + metadata.followUps persist all flow from it).
 * Machine wakes stay chip-free by design; the model's own block always wins;
 * a utility failure fails open (answer persists, no chips, no crash).
 *
 * Harness copied from owner-answer-first.chat-agent.test.ts (itself from
 * chat-agent.service.test.ts).
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
    get: jest.fn(async (k: string) => redisStore.get(k) ?? null),
    del: jest.fn(async (k: string) => {
      const had = redisStore.delete(k) || redisLists.delete(k);
      return had ? 1 : 0;
    }),
    exists: jest.fn(async (k: string) => (redisStore.has(k) ? 1 : 0)),
    mGet: jest.fn(async (keys: string[]) => keys.map((k) => redisStore.get(k) ?? null)),
    rPush: jest.fn(async (k: string, v: string) => {
      const l = redisLists.get(k) ?? [];
      l.push(v);
      redisLists.set(k, l);
      return l.length;
    }),
    lTrim: jest.fn(async (k: string, start: number, stop: number) => {
      const l = redisLists.get(k);
      if (l) redisLists.set(k, l.slice(start < 0 ? Math.max(0, l.length + start) : start, stop < 0 ? l.length + stop + 1 : stop + 1));
      return 'OK';
    }),
    lRange: jest.fn(async (k: string) => redisLists.get(k) ?? []),
    expire: jest.fn(async () => 1),
  },
}));

jest.mock('../../../middleware/error-handler', () => ({
  __esModule: true,
  AppError: class AppError extends Error {
    constructor(
      public statusCode: number,
      public message: string,
      public isOperational = true,
    ) {
      super(message);
      Object.setPrototypeOf(this, AppError.prototype);
    }
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
jest.mock('../mcp-search', () => ({
  searchWithBrightData: jest.fn(async () => ''),
  SEARCH_UNAVAILABLE_NOTE: '[search unavailable]',
}));
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
jest.mock('../context.service', () => ({
  __esModule: true,
  default: { saveToSessionHistory: jest.fn(async () => {}) },
}));

// ── THE SEAM UNDER TEST (ticket 4ac547de) ──────────────────────────────────
// The backstop calls the dormant moonshotIntegration.generateFollowUps
// (moonshot.integration.ts — "Called as a fallback when Kimi's synthesis
// didn't produce [FOLLOWUPS] tags"). Mocked at the module boundary like the
// neighboring suites; controllable per test.
const mockGenerateFollowUps: jest.Mock = jest.fn(async () => [
  'What moved on the Schooltime goal since the last sweep?',
  'Check the lane board again tomorrow morning',
]);
jest.mock('../integrations/moonshot.integration', () => ({
  __esModule: true,
  default: {
    generateTitle: jest.fn(async () => 'A Generated Title'),
    generateFollowUps: (...a: any[]) => mockGenerateFollowUps(...a),
  },
  cleanQuestionForTitle: jest.fn((q: string) => q),
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
  claimAuditExcerpts: (phantoms: any[]) =>
    (Array.isArray(phantoms) ? phantoms : []).slice(0, 4).map((p: any) => ({
      kind: String(p?.kind ?? ''),
      detail: String(p?.detail ?? '').slice(0, 120),
      ...(p?.id ? { id: String(p.id).slice(0, 24) } : {}),
      ...(p?.nearMiss?.length ? { nearMiss: p.nearMiss.slice(0, 4).map((x: any) => String(x).slice(0, 24)) } : {}),
    })),
  toolResultTextsFromParts: (parts: any[]) =>
    (Array.isArray(parts) ? parts : [])
      .filter((p: any) => p && p.type === 'tool_result' && typeof p.result === 'string' && p.result)
      .map((p: any) => p.result),
}));

const mockApplyClaimsBlockLane: jest.Mock = jest.fn((opts: any): any => ({
  finalText: opts.guarded.finalText, notes: opts.guarded.notes, verdict: opts.guarded.verdict,
  lane: { present: false, verified: [], unverified: [], coveredKinds: [] },
}));
jest.mock('../coding/run-evidence-guard', () => ({
  __esModule: true,
  applyClaimsBlockLane: (...a: any[]) => mockApplyClaimsBlockLane(...a),
}));

const mockGenerateOwnerBriefing = jest.fn(async (..._a: any[]): Promise<boolean> => true);
jest.mock('../fleet/owner-briefing.service', () => ({
  __esModule: true,
  OWNER_BRIEFING_KIND: 'owner_briefing',
  generateOwnerBriefing: (...a: any[]) => mockGenerateOwnerBriefing(...a),
}));

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
const mockDrainHookEventsForTarget: jest.Mock = jest.fn();
const mockHookBacklogStarving: jest.Mock = jest.fn(async () => false);
const mockDrainHookEventsForTargetNow: jest.Mock = jest.fn(async () => true);
const mockHooksFirstVerdict: jest.Mock = jest.fn(async (chatId: string, head: any) => {
  const age = Number(await mockOldestPendingHookAgeMs(chatId)) || 0;
  const q = Number(head?.ageMs) || 0;
  if (age < 5 * 60 * 1000) return { hooksFirst: false, reason: age ? 'young' : 'no_hooks', hookAgeMs: age, queueHeadAgeMs: q };
  if (head?.source === 'user') return { hooksFirst: false, reason: 'user_waiting', hookAgeMs: age, queueHeadAgeMs: q };
  if (q > age) return { hooksFirst: false, reason: 'queue_older', hookAgeMs: age, queueHeadAgeMs: q };
  return { hooksFirst: true, reason: 'hooks_first', hookAgeMs: age, queueHeadAgeMs: q };
});
const mockUnparkHookEventsForTarget: jest.Mock = jest.fn(async () => 0);
const mockEnqueueDirectWake: jest.Mock = jest.fn(async (): Promise<any> => ({ ok: true, hookEventId: 'hook-evt-0001' }));
jest.mock('../platform/hooks.service', () => ({
  __esModule: true,
  enqueueDirectWake: (...a: any[]) => mockEnqueueDirectWake(...a),
  emitHookEventSafe: (...a: any[]) => mockEmitHookEventSafe(...a),
  clearHookDepth: (...a: any[]) => mockClearHookDepth(...a),
  stampHookDepth: (...a: any[]) => mockStampHookDepth(...a),
  HOOK_STARVATION_MS: 5 * 60 * 1000,
  oldestPendingHookAgeMs: (...a: any[]) => mockOldestPendingHookAgeMs(...a),
  drainHookEventsForTarget: (...a: any[]) => mockDrainHookEventsForTarget(...a),
  hookBacklogStarving: (...a: any[]) => mockHookBacklogStarving(...a),
  hooksFirstVerdict: (...a: any[]) => mockHooksFirstVerdict(...a),
  drainHookEventsForTargetNow: (...a: any[]) => mockDrainHookEventsForTargetNow(...a),
  unparkHookEventsForTarget: (...a: any[]) => mockUnparkHookEventsForTarget(...a),
}));

const mockCreateSchedule: jest.Mock = jest.fn(async (input: any) => ({
  ok: true,
  schedule: { id: 'sched-deferred-1234', kind: input?.kind, prompt: input?.prompt },
}));
jest.mock('../coding/schedule.service', () => ({
  __esModule: true,
  createSchedule: (...a: any[]) => mockCreateSchedule(...a),
}));

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
    FOLLOWUP_BACKSTOP: 'followup_backstop', // ticket 4ac547de
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

const mockBuildWakeLedgerBlock: jest.Mock = jest.fn(async (): Promise<any> => null);
const mockOnSupervisorRunFinalized: jest.Mock = jest.fn(async () => {});
const mockMaterialGateForDrain: jest.Mock = jest.fn(async (): Promise<any> => null);
const mockAckMaterialGateDrain: jest.Mock = jest.fn(async () => true);
const mockRecordAgreement: jest.Mock = jest.fn();
const mockCloseStashes: jest.Mock = jest.fn(async () => {});
jest.mock('../platform/supervisor-wake-ledger', () => ({
  __esModule: true,
  buildWakeLedgerBlock: (...a: any[]) => mockBuildWakeLedgerBlock(...a),
  onSupervisorRunFinalized: (...a: any[]) => mockOnSupervisorRunFinalized(...a),
  materialGateForDrain: (...a: any[]) => mockMaterialGateForDrain(...a),
  ackMaterialGateDrain: (...a: any[]) => mockAckMaterialGateDrain(...a),
  recordMaterialGateAgreement: (...a: any[]) => mockRecordAgreement(...a),
  closeStashesForGateSkip: (...a: any[]) => mockCloseStashes(...a),
}));

const mockCloseAskOnReply: jest.Mock = jest.fn(async () => true);
jest.mock('../platform/supervisor-state.service', () => ({
  __esModule: true,
  ...jest.requireActual('../platform/supervisor-state.service'),
  closeAskOnReply: (...a: any[]) => mockCloseAskOnReply(...a),
}));

import { startDetachedChatRun } from './chat-agent.service';
import { runCodingAgent } from '../coding/agent';
import { isRunActive } from '../coding/live-runs';

async function waitFor(pred: () => boolean, iterations = 400): Promise<void> {
  for (let i = 0; i < iterations && !pred(); i += 1) await new Promise((r) => setTimeout(r, 10));
  if (!pred()) throw new Error('timed out waiting for the run');
}

const SUP = 'abcdef12-1111-4111-8111-000000000001'; // a project supervisor chat
const SUP_ROW = { id: SUP, title: 'Schooltime Supervisor', isSupervisor: false, isProjectSupervisor: true, userId: 'u1', projectId: 'p1', leadModel: null };
const PLAIN = 'b1c2d3e4-2222-4222-8222-000000000002';
const PLAIN_ROW = { id: PLAIN, title: 'A plain chat', isSupervisor: false, isProjectSupervisor: false, userId: 'u1', projectId: null, leadModel: null };
const QUESTION = 'where are we on the schooltime cameras plan?';

// The measured failing shape (prod tail, chat c0e22e36 2026-10-17T15:48Z): a
// supervisor answer that closes with the wake-close contract instead of the
// [FOLLOWUPS] block — no chip markup anywhere in the text.
const SUPERVISOR_ANSWER = [
  'Board reads clean: all four lanes are idle and the ticket queue is empty as of 20:40Z.',
  '',
  'ACTIONS TAKEN',
  '',
  '- Verified lane 645b39f6 archive state — sched 2b2eac8b',
  '- Banked the queue verdict — supervisor state save acked this wake',
].join('\n');

const PLAIN_ANSWER = 'The restock opens Friday 9am PT at Hobbiesville; 401 Games expects its EB-05 allocation next week.';

const BLOCK_ANSWER = 'The restock opens Friday 9am PT.\n\n[FOLLOWUPS]\n- When does the EB-05 restock go live at 401 Games?\n- Which Victoria shops get allocation first?\n[/FOLLOWUPS]';

let created: any[] = [];
const writes = () => created;
const assistantRow = () => writes().filter((d: any) => d?.role === 'assistant').pop();
const metrics = (kind: string) => mockRecordLoopMetric.mock.calls.map((c: any[]) => c[0]).filter((r: any) => r?.kind === kind);
const usageRow = () => metrics('chat_platform_usage').pop();
const backstopRows = () => metrics('followup_backstop');

beforeEach(() => {
  redisStore.clear();
  redisLists.clear();
  delete process.env.FOLLOWUP_BACKSTOP_DISABLED;
  process.env.FOLLOWUP_BACKSTOP_TIMEOUT_MS = '2000';
  (runCodingAgent as jest.Mock).mockReset().mockImplementation(async () => ({ finalText: 'A'.repeat(500) }));
  mockRecordLoopMetric.mockClear();
  mockGenerateFollowUps.mockReset().mockImplementation(async () => [
    'What moved on the Schooltime goal since the last sweep?',
    'Check the lane board again tomorrow morning',
  ]);
  let n = 0;
  created = [];
  mockPrisma.crossModelMessage.create.mockReset().mockImplementation(async (a: any) => {
    const r = { id: a?.data?.id ?? `row-${a?.data?.role}-${++n}`, createdAt: new Date(), ...(a?.data ?? {}) };
    created.push(r);
    return r;
  });
  mockPrisma.crossModelMessage.findFirst = jest.fn(async (a: any) => ({ id: a?.where?.id ?? 'row-x', content: 'x', parts: [], metadata: {} }));
  mockPrisma.crossModelMessage.findMany = jest.fn(async () => []);
  mockPrisma.crossModelMessage.findUnique = jest.fn(async () => null);
  mockPrisma.crossModelMessage.update = jest.fn(async () => ({}));
  mockPrisma.pendingChatMessage.create.mockClear();
  mockPrisma.pendingChatMessage.findFirst.mockReset().mockResolvedValue(null);
  mockPrisma.pendingChatMessage.delete.mockClear();
  mockPrisma.crossModelChat.findUnique.mockImplementation(async () => SUP_ROW);
  mockPrisma.crossModelChat.update.mockClear();
});
afterEach(() => {
  mockPrisma.crossModelChat.findUnique.mockImplementation(async () => ({ title: 'A proper existing title' }));
  mockPrisma.crossModelMessage.create.mockReset().mockImplementation(async () => ({}));
  mockPrisma.crossModelChat.update.mockReset().mockImplementation(async () => ({}));
  for (const k of ['findFirst', 'findMany', 'findUnique', 'update']) delete mockPrisma.crossModelMessage[k];
  delete process.env.FOLLOWUP_BACKSTOP_DISABLED;
  delete process.env.FOLLOWUP_BACKSTOP_TIMEOUT_MS;
});

/** Drive one owner-typed turn on `chatId` with the given lead answer and mode. */
async function ownerTurn(chatId: string, answer: string, mode: 'thinking' | 'single_thinking' = 'thinking', extra: Record<string, unknown> = {}) {
  (runCodingAgent as jest.Mock).mockImplementationOnce(async () => ({
    finalText: answer,
    parts: [{ type: 'text', text: answer }],
  }));
  const key = await startDetachedChatRun({ message: QUESTION, mode, userId: 'u1', chatId, ...extra });
  expect(key).toBe(`chat:${chatId}`);
  await waitFor(() => (runCodingAgent as jest.Mock).mock.calls.length > 0);
  await waitFor(() => !isRunActive(key!));
  await new Promise((r) => setTimeout(r, 50));
  return key!;
}

describe('ticket 4ac547de — the deterministic follow-ups backstop at the L2 finalize parse seam', () => {
  it('a supervisor-chat OWNER turn at Level 2 whose lead closed with the wake-close contract (no [FOLLOWUPS] block) still persists followUps metadata and counts chips in the usage metric', async () => {
    await ownerTurn(SUP, SUPERVISOR_ANSWER);

    // the backstop fired exactly once, seeded with the user's question + the clean answer
    expect(mockGenerateFollowUps).toHaveBeenCalledTimes(1);
    expect(String(mockGenerateFollowUps.mock.calls[0][0] ?? '').length).toBeGreaterThan(0);
    expect(String(mockGenerateFollowUps.mock.calls[0][1] ?? '')).toContain('ACTIONS TAKEN');

    // the persisted assistant row carries the chips (the reload parity contract)
    const row = assistantRow();
    expect(row).toBeTruthy();
    expect(Array.isArray(row.metadata?.followUps)).toBe(true);
    expect(row.metadata.followUps).toHaveLength(2);
    expect(row.metadata.followUps[0]).toContain('Schooltime');

    // the usage metric row the product alert reads shows followUps > 0
    const usage = usageRow();
    expect(usage).toBeTruthy();
    expect(usage.meta.followUps).toBe(2);

    // one backstop observability row
    expect(backstopRows()).toHaveLength(1);
    expect(backstopRows()[0].meta.got).toBe(2);
  });

  it('a PLAIN chat at Level 2 with no block gets the backstop too (the alert measured all user turns, machine false)', async () => {
    mockPrisma.crossModelChat.findUnique.mockImplementation(async () => PLAIN_ROW);
    await ownerTurn(PLAIN, PLAIN_ANSWER);

    expect(mockGenerateFollowUps).toHaveBeenCalledTimes(1);
    const row = assistantRow();
    expect(row.metadata?.followUps).toHaveLength(2);
    expect(usageRow().meta.followUps).toBe(2);
  });

  it("the model's own [FOLLOWUPS] block always wins — the backstop never runs when chips parsed", async () => {
    await ownerTurn(SUP, BLOCK_ANSWER);

    expect(mockGenerateFollowUps).not.toHaveBeenCalled();
    const row = assistantRow();
    expect(row.metadata?.followUps).toEqual([
      'When does the EB-05 restock go live at 401 Games?',
      'Which Victoria shops get allocation first?',
    ]);
    expect(usageRow().meta.followUps).toBe(2);
  });

  it('machine wakes stay chip-free by design — no backstop call, no chips persisted', async () => {
    await ownerTurn(SUP, SUPERVISOR_ANSWER, 'thinking', { messageOrigin: 'schedule' });

    expect(mockGenerateFollowUps).not.toHaveBeenCalled();
    const row = assistantRow();
    expect(row?.metadata?.followUps ?? []).toHaveLength(0);
    expect(usageRow().meta.followUps).toBe(0);
    expect(backstopRows()).toHaveLength(0);
  });

  it('Level 1 (single_thinking) is out of scope — no backstop', async () => {
    await ownerTurn(SUP, SUPERVISOR_ANSWER, 'single_thinking');

    expect(mockGenerateFollowUps).not.toHaveBeenCalled();
  });

  it('a GUEST (anonymous) Level 2 turn gets the backstop too — the doctrine mandates question chips for signed-out users and the product alert counts their rows (adversarial review F2)', async () => {
    mockPrisma.crossModelChat.findUnique.mockImplementation(async () => PLAIN_ROW);
    // guests have no userId; the anon session rides args.sessionId
    await ownerTurn(PLAIN, PLAIN_ANSWER, 'thinking', { userId: null, sessionId: 'cm_session-guest-1' });

    expect(mockGenerateFollowUps).toHaveBeenCalledTimes(1);
    const usage = usageRow();
    expect(usage).toBeTruthy();
    expect(usage.meta.followUps).toBe(2);
  });

  it('the bench account is excluded — E2E load never pays the utility call (adversarial review F6)', async () => {
    // isBenchAccountUser probes prisma.user.findUnique by email, compares ids,
    // and MEMOIZES the bench id at module scope — earlier tests in this file
    // already latched the memo to null (the mock has no `user` model, the
    // sync property access throws into the catch). A fresh module registry
    // for this one test re-runs the probe against the mocked prisma.user.
    mockPrisma.user = { findUnique: jest.fn(async () => ({ id: 'u1' })) };
    (runCodingAgent as jest.Mock).mockImplementationOnce(async () => ({
      finalText: SUPERVISOR_ANSWER,
      parts: [{ type: 'text', text: SUPERVISOR_ANSWER }],
    }));
    let start: ((a: any) => Promise<string | null>) | null = null;
    await jest.isolateModulesAsync(async () => {
      start = (await import('./chat-agent.service')).startDetachedChatRun;
    });
    const key = await start!({ message: QUESTION, mode: 'thinking', userId: 'u1', chatId: SUP });
    expect(key).toBe(`chat:${SUP}`);
    // wait for the assistant row (persist happens after the gate decision)
    await waitFor(() => !!assistantRow(), 600);
    await new Promise((r) => setTimeout(r, 150));
    expect(mockGenerateFollowUps).not.toHaveBeenCalled();
    delete mockPrisma.user;
  });

  it('a continuation round never arms the backstop (the answer row owns the chips)', async () => {
    await ownerTurn(SUP, SUPERVISOR_ANSWER, 'thinking', {
      continuation: { taskId: 'task-1', round: 1, maxRounds: 3, ofMessageId: 'row-user-1', reason: 'unfinished_plan', startedAt: new Date().toISOString() },
    });

    expect(mockGenerateFollowUps).not.toHaveBeenCalled();
  });

  it('FOLLOWUP_BACKSTOP_DISABLED=1 is the kill switch — no call, no chips, run unaffected', async () => {
    process.env.FOLLOWUP_BACKSTOP_DISABLED = '1';
    await ownerTurn(SUP, SUPERVISOR_ANSWER);

    expect(mockGenerateFollowUps).not.toHaveBeenCalled();
    expect(assistantRow()).toBeTruthy(); // the answer still persisted
    expect(usageRow().meta.followUps).toBe(0);
  });

  it('a utility failure fails OPEN — the answer persists with no chips and nothing throws', async () => {
    mockGenerateFollowUps.mockReset().mockRejectedValueOnce(new Error('utility seat unreachable'));
    await ownerTurn(SUP, SUPERVISOR_ANSWER);

    expect(mockGenerateFollowUps).toHaveBeenCalledTimes(1);
    const row = assistantRow();
    expect(row).toBeTruthy();
    expect(row?.metadata?.followUps ?? []).toHaveLength(0);
    expect(usageRow().meta.followUps).toBe(0);
    // the backstop observability row records the failure honestly
    expect(backstopRows()).toHaveLength(1);
    expect(backstopRows()[0].meta.got).toBe(0);
  });

  it('a utility timeout fails OPEN — the race resolves empty, the answer still persists', async () => {
    mockGenerateFollowUps.mockReset().mockImplementationOnce(() => new Promise<string[]>(() => { /* never resolves */ }));
    await ownerTurn(SUP, SUPERVISOR_ANSWER);

    expect(mockGenerateFollowUps).toHaveBeenCalledTimes(1);
    const row = assistantRow();
    expect(row).toBeTruthy();
    expect(row?.metadata?.followUps ?? []).toHaveLength(0);
  });
});
