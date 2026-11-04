/**
 * L2 cross-check reconcile tests (2026-08-18, ticket 9e6950d1).
 *
 * The cross-check gate lives in injectSystem(step), which deliberately returns
 * null at step 0 (research-overlap window) and only delivers drafts from step
 * ≥ 1. When the orchestrator answers with NO tool round, the loop exits at
 * step 0 and the drafts never reach it — prod logged ~10 "finalized before
 * reconciling" warns/day and the answer shipped unreconciled. The fix waits
 * for the late draft (bounded) and runs ONE bounded reconcile pass with the
 * same orchestrator model.
 *
 * Harness mirrors chat-agent.service.test.ts: real in-memory live-runs
 * registry, everything else mocked at the module boundary.
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
  pendingChatMessage: { findFirst: jest.fn(async () => null), delete: jest.fn(async () => ({})) },
  agentRun: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

const redisStore = new Map<string, string>();
jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: {
    set: jest.fn(async (k: string, v: string, opts?: { NX?: boolean }) => {
      if (opts?.NX && redisStore.has(k)) return null;
      redisStore.set(k, v);
      return 'OK';
    }),
    get: jest.fn(async (k: string) => redisStore.get(k) ?? null),
    del: jest.fn(async (k: string) => (redisStore.delete(k) ? 1 : 0)),
    exists: jest.fn(async (k: string) => (redisStore.has(k) ? 1 : 0)),
    mGet: jest.fn(async (keys: string[]) => keys.map((k) => redisStore.get(k) ?? null)),
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

// Seat pre-flight (2026-09-04): the REAL seatUnservableReason reads provider
// env keys, and this jest env is keyless — every run would fail fast with
// SeatUnservableError before reaching the mocked workers. Keep the rest of
// coding-model REAL (resolveRoleModelForRun etc. are exercised).
jest.mock('../coding/coding-model', () => ({
  __esModule: true,
  ...jest.requireActual('../coding/coding-model'),
  seatUnservableReason: jest.fn(async () => null),
}));

jest.mock('../coding/agent', () => ({
  runCodingAgent: jest.fn(async () => ({ finalText: 'A'.repeat(500) })),
  runChatWorker: jest.fn(async () => ({ finalText: '' })),
}));
jest.mock('../mcp-search', () => ({
  searchWithBrightData: jest.fn(async () => ''),
  SEARCH_UNAVAILABLE_NOTE: '[search unavailable]',
}));
jest.mock('../langgraph/memory.graph', () => ({ updateContextAsync: jest.fn() }));
jest.mock('../context.service', () => ({
  __esModule: true,
  default: { saveToSessionHistory: jest.fn(async () => {}) },
}));
jest.mock('../integrations/moonshot.integration', () => ({
  __esModule: true,
  default: { generateTitle: jest.fn(async () => 'A Generated Title') },
}));
jest.mock('../platform/hooks.service', () => ({
  __esModule: true,
  emitHookEventSafe: jest.fn(async () => {}),
  clearHookDepth: jest.fn(async () => {}),
  stampHookDepth: jest.fn(async () => {}),
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

import { startDetachedChatRun } from './chat-agent.service';
import { runCodingAgent, runChatWorker } from '../coding/agent';
import { isRunActive, subscribeRun } from '../coding/live-runs';

const mockRunCodingAgent = runCodingAgent as jest.Mock;
const mockRunChatWorker = runChatWorker as jest.Mock;

async function waitFor(pred: () => boolean, ms = 5000): Promise<void> {
  const t0 = Date.now();
  while (!pred() && Date.now() - t0 < ms) await new Promise(r => setTimeout(r, 10));
  if (!pred()) throw new Error('timed out waiting for run events');
}

function persistedAssistantContent(chatId: string): string | null {
  const call = mockPrisma.crossModelMessage.create.mock.calls.find(
    ([arg]: any[]) => arg?.data?.chatId === chatId && arg?.data?.role === 'assistant',
  );
  return call ? String(call[0].data.content) : null;
}

beforeEach(() => {
  jest.clearAllMocks(); // clears call history only — factory implementations survive
  redisStore.clear();
});

// Compute policy (2026-09-26, cp/harness): the step-0 INLINE reconcile below is
// the PRE-answer-first contract — under the default answer-first policy the
// same pass now starts here and finishes INTO the persisted row through
// late-crosscheck.ts (pinned in chat-agent.compute-policy.test.ts). This suite
// keeps pinning the inline path, which ANSWER_FIRST_DISABLED=1 restores
// byte-for-byte.
beforeAll(() => { process.env.ANSWER_FIRST_DISABLED = '1'; });
afterAll(() => { delete process.env.ANSWER_FIRST_DISABLED; });

describe('L2 cross-check reconcile (step-0 fast answers)', () => {
  it('reconciles with the late draft via ONE extra pass on the SAME orchestrator model', async () => {
    mockRunCodingAgent.mockImplementation(async () => ({ finalText: 'ORCH-DRAFT-ALPHA' }));
    mockRunChatWorker.mockImplementation(async (input: any) =>
      String(input.userMessage).includes('YOUR DRAFT ANSWER')
        ? { finalText: 'RECONCILED-FINAL-OMEGA' }
        : { finalText: 'CHECKER-DRAFT-X' });

    const key = await startDetachedChatRun({ message: 'the question', mode: 'thinking' as const, userId: 'u1', chatId: 'chat-rc-1', sessionId: null });
    expect(key).toBe('chat:chat-rc-1');
    const events: Array<{ type: string; data: any }> = [];
    subscribeRun(key!, e => events.push(e));
    await waitFor(() => !isRunActive(key!));

    // Exactly two worker calls: the checker draft + the reconcile pass.
    expect(mockRunChatWorker).toHaveBeenCalledTimes(2);
    const inputs = mockRunChatWorker.mock.calls.map(([i]: any[]) => i);
    const reconcile = inputs.find((i: any) => String(i.userMessage).includes('YOUR DRAFT ANSWER'));
    const checker = inputs.find((i: any) => !String(i.userMessage).includes('YOUR DRAFT ANSWER'));
    expect(checker).toBeTruthy();
    expect(reconcile).toBeTruthy();
    // The reconcile pass carries the orchestrator's draft AND the checker block…
    expect(String(reconcile.userMessage)).toContain('ORCH-DRAFT-ALPHA');
    expect(String(reconcile.userMessage)).toContain('CHECKER-DRAFT-X');
    // …on the SAME model the orchestrator ran (not the utility tier, not the checker).
    expect(reconcile.model).toBe(mockRunCodingAgent.mock.calls[0][0].model);
    // …and the persisted assistant row is the reconciled answer.
    expect(persistedAssistantContent('chat-rc-1')).toContain('RECONCILED-FINAL-OMEGA');
    // WIRE PARITY (adversarial review B1): the client rendered the unreconciled
    // text from chunks, so 'complete' must carry the reconciled full text.
    const complete = events.find(e => e.type === 'complete');
    expect(complete).toBeTruthy();
    expect(String(complete!.data?.finalText ?? '')).toContain('RECONCILED-FINAL-OMEGA');
  });

  it('ships the original draft when the reconcile pass returns empty', async () => {
    mockRunCodingAgent.mockImplementation(async () => ({ finalText: 'ORCH-DRAFT-BETA' }));
    mockRunChatWorker.mockImplementation(async (input: any) =>
      String(input.userMessage).includes('YOUR DRAFT ANSWER')
        ? { finalText: '' }
        : { finalText: 'CHECKER-DRAFT-Y' });

    const key = await startDetachedChatRun({ message: 'the question', mode: 'thinking' as const, userId: 'u1', chatId: 'chat-rc-2', sessionId: null });
    const events: Array<{ type: string; data: any }> = [];
    subscribeRun(key!, e => events.push(e));
    await waitFor(() => !isRunActive(key!));

    expect(mockRunChatWorker).toHaveBeenCalledTimes(2);
    expect(persistedAssistantContent('chat-rc-2')).toContain('ORCH-DRAFT-BETA');
    // No wire finalText when nothing was reconciled — the chunk accumulator
    // (which matches the DB) stays authoritative on the client.
    const complete = events.find(e => e.type === 'complete');
    expect(complete).toBeTruthy();
    expect(complete!.data?.finalText).toBeUndefined();
  });

  it('skips the reconcile pass when the drafts were delivered in-loop (step ≥ 1)', async () => {
    let injected: unknown = null;
    mockRunCodingAgent.mockImplementation(async (opts: any) => {
      injected = await opts.injectSystem(1); // orchestrator took a tool round → gate fires
      return { finalText: 'INLOOP-ANSWER-GAMMA' };
    });
    mockRunChatWorker.mockImplementation(async () => ({ finalText: 'CHECKER-DRAFT-Z' }));

    const key = await startDetachedChatRun({ message: 'the question', mode: 'thinking' as const, userId: 'u1', chatId: 'chat-rc-3', sessionId: null });
    await waitFor(() => !isRunActive(key!));

    expect(mockRunChatWorker).toHaveBeenCalledTimes(1); // the checker only — no reconcile
    expect(String(injected)).toContain('CHECKER-DRAFT-Z');
    expect(persistedAssistantContent('chat-rc-3')).toContain('INLOOP-ANSWER-GAMMA');
  });
});

describe('reconcile pass — user-space isolation (2026-10-20 re-review)', () => {
  it('a plain user-space chat: the checker AND the reconcile worker carry projectMemoryIsolated (a granted tool round cannot read the space)', async () => {
    const { buildChatQueryContext } = jest.requireMock('./chat-context') as { buildChatQueryContext: jest.Mock };
    buildChatQueryContext.mockResolvedValueOnce({ queryMessage: 'the question', systemContext: '', conversationHistory: [{ role: 'user', content: 'earlier' }], projectId: 'userspace', projectMemoryIsolated: true });
    mockRunCodingAgent.mockImplementation(async () => ({ finalText: 'ORCH-DRAFT-ISO' }));
    mockRunChatWorker.mockImplementation(async (input: any) =>
      String(input.userMessage).includes('YOUR DRAFT ANSWER') ? { finalText: 'RECONCILED-ISO' } : { finalText: 'CHECKER-DRAFT-ISO' });
    const key = await startDetachedChatRun({ message: 'the question', mode: 'thinking' as const, userId: 'u1', chatId: 'chat-rc-iso', sessionId: null });
    await waitFor(() => !isRunActive(key!));
    const inputs = mockRunChatWorker.mock.calls.map(([i]: any[]) => i);
    const reconcile = inputs.find((i: any) => String(i.userMessage).includes('YOUR DRAFT ANSWER'));
    expect(reconcile).toMatchObject({ projectId: 'userspace', projectMemoryIsolated: true });
    expect(inputs.every((i: any) => i.projectMemoryIsolated === true)).toBe(true);
  });
});
