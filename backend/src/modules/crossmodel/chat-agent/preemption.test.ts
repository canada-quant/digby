/**
 * F1 — owner preemption of replayable machine runs (owner incident 2026-09-04,
 * supervisor chat c0e22e36: the owner's typed question sat 12 minutes behind
 * machine traffic while the UI said "Idle").
 *
 * Pins, against the REAL chat-agent.service + chat-busy + live-runs:
 *   - startDetachedChatRun stamps the `:machine` marker on the Redis liveness
 *     claim for machineWake / schedule / hook / agent / webhook runs — and
 *     NEVER for user-triggered runs;
 *   - preemptMachineRunForUserMessage cancels a MACHINE run (local cancel +
 *     parked-ask_user release + cross-process stop flag), waits for teardown,
 *     and records a chat_preemption loop metric;
 *   - a USER-triggered run is NEVER cancelled; coding-lane busy (agent_runs,
 *     no liveness marker) is never preempted;
 *   - end-to-end incident replay: user send preempts the machine run, and the
 *     cancelled run's finalize drain delivers the USER row before an OLDER
 *     queued machine row (F1 + F2a + the immediate finalize drain together).
 *
 * Replayability note (asserted by design, not by a table write): preemption
 * only cancels the RUN — it touches no codingSchedule/hook_events state, so
 * the machine work's own re-fire machinery (schedule cadence, hook outbox
 * retry, orphan-recovery bb2eca92) is untouched.
 *
 * Mocking pattern mirrors message-queue.test.ts (real live-runs registry +
 * map-backed Redis with real SET NX semantics; agent loop and persistence
 * mocked so runs complete in milliseconds).
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
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

/** In-memory pending_chat_messages table (the incident-replay test drains it). */
const pendingRows: Array<{
  id: string; chatId: string; userId: string; content: string;
  mode: string | null; source: string; createdAt: Date; uploadIds?: string[];
}> = [];
let pendingSeq = 0;

const redisStore = new Map<string, string>();
const mockRedis = {
  set: jest.fn(async (k: string, v: string, opts?: { NX?: boolean }) => {
    if (opts?.NX && redisStore.has(k)) return null;
    redisStore.set(k, String(v));
    return 'OK';
  }),
  get: jest.fn(async (k: string) => redisStore.get(k) ?? null),
  del: jest.fn(async (k: string) => (redisStore.delete(k) ? 1 : 0)),
  exists: jest.fn(async (k: string) => (redisStore.has(k) ? 1 : 0)),
  mGet: jest.fn(async (keys: string[]) => keys.map((k) => redisStore.get(k) ?? null)),
  expire: jest.fn(async (..._a: any[]) => 1),
};
jest.mock('../../../config/redis', () => ({ __esModule: true, default: mockRedis }));

const mockPrisma: any = {
  pendingChatMessage: {
    count: jest.fn(async ({ where }: any) =>
      pendingRows.filter(r => r.chatId === where.chatId && (where.source == null || r.source === where.source)).length),
    create: jest.fn(async ({ data }: any) => {
      pendingSeq += 1;
      const row = { id: `p${pendingSeq}`, createdAt: new Date(Date.now() + pendingSeq), ...data };
      pendingRows.push(row);
      return row;
    }),
    findFirst: jest.fn(async ({ where }: any) =>
      pendingRows
        .filter(r => r.chatId === where.chatId && (where.source == null || r.source === where.source))
        .sort((a, b) => (a.createdAt.getTime() - b.createdAt.getTime()) || a.id.localeCompare(b.id))[0] ?? null),
    delete: jest.fn(async ({ where }: any) => {
      const i = pendingRows.findIndex(r => r.id === where.id);
      if (i >= 0) pendingRows.splice(i, 1);
      return {};
    }),
  },
  crossModelMessage: { create: jest.fn(async () => ({})) },
  crossModelChat: {
    update: jest.fn(async () => ({})),
    updateMany: jest.fn(async () => ({ count: 1 })),
    findUnique: jest.fn(async ({ select }: any) => {
      // a5b36dc6: the IN-FLIGHT stamp reads supervisor-class flags (markPreemptedInflight).
      if (select?.isSupervisor) return { userId: 'u-owner', isSupervisor: true, isProjectSupervisor: false };
      return { title: 'A proper existing title' };
    }),
  },
  // a5b36dc6: markPreemptedInflight's doc write chain (fail-open — upsert stubbed).
  supervisorState: { findUnique: jest.fn(async () => null), upsert: jest.fn(async () => ({})) },
  // a5b36dc6: buildInflightPreemptBlock's LIVE journal read (fail-open).
  toolIntent: { findMany: jest.fn(async () => []) },
  // chat-busy's durable layer — the coding-lane test overrides findFirst per-case.
  agentRun: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

// Seat pre-flight (keyless jest env — see message-queue.test.ts).
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
  buildChatQueryContext: jest.fn(async (a: any) => ({
    queryMessage: a.message,
    systemContext: '',
    conversationHistory: [{ role: 'user', content: 'earlier' }],
    projectId: null,
  })),
  persistAndEmitCanvases: jest.fn(async () => []),
}));
jest.mock('../upload.controller', () => ({
  attachmentKey: (id: string) => `cm:upload:${id}`,
  loadAttachment: jest.fn(async () => null),
  combineAttachments: jest.fn(() => undefined),
}));
jest.mock('./chat-gate', () => ({ mapAttachmentForAgent: jest.fn(() => ({})) }));

// Boundary mocks THIS suite asserts on: the parked-ask_user release the local
// cancel applies (stop-endpoint parity) and the chat_preemption loop metric.
const mockResolvePendingForSession = jest.fn();
jest.mock('../coding/question-registry', () => ({
  __esModule: true,
  resolvePendingForSession: (...a: any[]) => mockResolvePendingForSession(...a),
  applyQuestionResolution: jest.fn(),
}));
const mockRecordLoopMetric = jest.fn();
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  ...jest.requireActual('../platform/loop-metrics.service'),
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
}));

import {
  startDetachedChatRun, preemptMachineRunForUserMessage, chatRunKey,
} from './chat-agent.service';
import { isChatRunMachineTriggered } from './chat-busy';
import { enqueueChatMessage } from './message-queue.service';
import { runCodingAgent } from '../coding/agent';
import { isRunActive, isRunCancelled, startLiveRun, endLiveRun } from '../coding/live-runs';

const mockRunCodingAgent = runCodingAgent as jest.Mock;

async function waitFor(pred: () => boolean, ms = 3000): Promise<void> {
  const t0 = Date.now();
  while (!pred() && Date.now() - t0 < ms) await new Promise(r => setTimeout(r, 10));
  if (!pred()) throw new Error('timed out waiting for condition');
}

/** A run body that ends ONLY on cancellation — the graceful-teardown shape. */
function cancelResponsiveRun(runKey: string) {
  return async () => {
    await waitFor(() => isRunCancelled(runKey), 5000);
    return { finalText: 'partial (cancelled)' };
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  pendingRows.length = 0;
  pendingSeq = 0;
  redisStore.clear();
  mockPrisma.agentRun.findFirst.mockResolvedValue(null);
});

describe('machine-origin marker on the liveness claim', () => {
  it.each([
    ['machineWake', { machineWake: true as const }],
    ['origin schedule', { messageOrigin: 'schedule' as const }],
    ['origin hook', { messageOrigin: 'hook' as const }],
    ['origin agent', { messageOrigin: 'agent' as const }],
    ['origin webhook', { messageOrigin: 'webhook' as const, machineWake: true as const }],
  ])('a %s run claims MARKED — isChatRunMachineTriggered true while it lives', async (_label, extra) => {
    const chatId = `mk-${_label.replace(/\s/g, '')}`;
    const key = await startDetachedChatRun({
      userId: 'u1', chatId, message: 'wake note', mode: 'single_thinking', ...extra,
    } as any);
    expect(key).toBe(chatRunKey(chatId));
    expect(redisStore.get(`cm:liverun:${chatId}`)).toMatch(/:machine$/);
    await expect(isChatRunMachineTriggered(chatId)).resolves.toBe(true);
    await waitFor(() => !isRunActive(key!));
    // The finally released the claim — the marker dies with the run.
    await expect(isChatRunMachineTriggered(chatId)).resolves.toBe(false);
  });

  it.each([
    ['undefined origin (interactive stream path)', {}],
    ['explicit user origin', { messageOrigin: 'user' as const }],
    // Owner-dispatch (2026-10-01): an agent send stamped ownerDispatch beside the owner anchor is a USER run.
    ['owner-dispatched agent send', { messageOrigin: 'agent' as const, ownerDispatch: true, originSourceChatId: 'ps-1' }],
  ])('a user-triggered run (%s) claims UNMARKED — never a preemption target', async (_label, extra) => {
    const chatId = `uk-${_label.length}`;
    const key = await startDetachedChatRun({
      userId: 'u1', chatId, message: 'a question', mode: 'single_thinking', userTurnAt: new Date(), ...extra,
    } as any);
    expect(redisStore.get(`cm:liverun:${chatId}`)).not.toMatch(/:machine/);
    await expect(isChatRunMachineTriggered(chatId)).resolves.toBe(false);
    await waitFor(() => !isRunActive(key!));
  });
});

describe('preemptMachineRunForUserMessage', () => {
  it('cancels an ACTIVE machine run (local cancel + parked-ask_user release + stop flag), waits for teardown, records the metric', async () => {
    const chatId = 'pm1';
    const key = chatRunKey(chatId);
    mockRunCodingAgent.mockImplementationOnce(cancelResponsiveRun(key));
    await startDetachedChatRun({ userId: 'u1', chatId, message: 'hourly check', mode: 'single_thinking', machineWake: true });
    expect(isRunActive(key)).toBe(true);

    const res = await preemptMachineRunForUserMessage(chatId);
    expect(res).toEqual({ preempted: true, freed: true });
    expect(isRunCancelled(key)).toBe(true);
    // Stop-endpoint parity: the local cancel releases any parked ask_user wait.
    expect(mockResolvePendingForSession).toHaveBeenCalledWith(chatId);
    // Observability: one chat_preemption row, stamped local.
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'chat_preemption', sessionId: chatId, meta: { local: true } }),
    );
    // Teardown really completed — the slot is claimable again.
    await waitFor(() => !isRunActive(key));
    expect(redisStore.has(`cm:liverun:${chatId}`)).toBe(false);
  });

  it('a5b36dc6 (review P1): the preempt stamps the IN-FLIGHT intents marker at the CHOKE POINT — every preempt route (REST + the SSE stream controller) checkpoints the interrupted run', async () => {
    const chatId = 'pm-inflight';
    const key = chatRunKey(chatId);
    mockRunCodingAgent.mockImplementationOnce(cancelResponsiveRun(key));
    await startDetachedChatRun({ userId: 'u1', chatId, message: 'hourly check', mode: 'single_thinking', machineWake: true });
    expect(isRunActive(key)).toBe(true);

    // The crossModelChat mock serves the supervisor-class row (isSupervisor
    // select) — markPreemptedInflight takes its write path. NOTE: a
    // supervisor-class machine wake ALSO writes the doc (directive capture),
    // so the pin asserts on a call carrying a NON-EMPTY marker specifically.
    const res = await preemptMachineRunForUserMessage(chatId);
    expect(res).toEqual({ preempted: true, freed: true });
    const markerCalls = mockPrisma.supervisorState.upsert.mock.calls
      .map((c: any[]) => c[0]?.update?.state?.inflightPreemptAt ?? c[0]?.create?.state?.inflightPreemptAt)
      .filter((v: unknown) => typeof v === 'string' && v !== '');
    expect(markerCalls.length).toBeGreaterThanOrEqual(1);
    expect(Number.isFinite(Date.parse(markerCalls[markerCalls.length - 1]))).toBe(true);
    // Observability (a5b36dc6 acceptance bar): one inflight_preempt_mark row.
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'inflight_preempt_mark', sessionId: chatId }),
    );

    await waitFor(() => !isRunActive(key));
  });

  it('a5b36dc6 (review F2 — the machine-wake seam): a live marker renders the ACTION-IN-FLIGHT block into the wake prompt', async () => {
    // Seed a fresh marker + a live unsettled journal row, then drive a REAL
    // machine wake on a supervisor-class chat and assert the guard reaches
    // the composed run message (the seam the claim→retraction loop died on).
    const chatId = 'pm-wake-seam';
    const markerAt = new Date().toISOString();
    mockPrisma.supervisorState.findUnique.mockImplementation(async ({ where }: any) =>
      where.chatId === chatId
        ? { state: { directives: [], archived: [], dispatches: [], projects: [], notes: '', refutations: [], inflightPreemptAt: markerAt } }
        : null);
    mockPrisma.toolIntent.findMany.mockResolvedValueOnce([
      { tool: 'notify_user', state: 'pending', slot: '0', receiptId: null, createdAt: new Date(Date.now() - 120_000) },
    ]);
    // The wake gate: supervisor-class chat row.
    mockPrisma.crossModelChat.findUnique.mockImplementation(async ({ select }: any) => {
      if (select?.isSupervisor) return { userId: 'u1', isSupervisor: true, isProjectSupervisor: false };
      return { title: 'A proper existing title' };
    });
    const key = chatRunKey(chatId);
    mockRunCodingAgent.mockImplementationOnce(async (input: any) => {
      // THE assertion: the guard block is inside the wake's message.
      expect(String(input.message)).toContain('PREEMPTED RUN — ACTION IN FLIGHT');
      expect(String(input.message)).toContain('notify_user');
      return { finalText: 'ok' };
    });
    await startDetachedChatRun({ userId: 'u1', chatId, message: 'hourly check', mode: 'single_thinking', machineWake: true });
    await waitFor(() => !isRunActive(key));
    expect(mockPrisma.toolIntent.findMany).toHaveBeenCalled();
  });

  it('a5b36dc6 (review F2 — no marker, no block): a wake on an unpreempted supervisor chat is byte-identical to pre-fix', async () => {
    const chatId = 'pm-wake-seam-clean';
    mockPrisma.supervisorState.findUnique.mockResolvedValue(null); // no marker
    mockPrisma.toolIntent.findMany.mockClear();
    const key = chatRunKey(chatId);
    mockRunCodingAgent.mockImplementationOnce(async (input: any) => {
      expect(String(input.message)).not.toContain('PREEMPTED RUN');
      expect(String(input.message)).not.toContain('ACTION IN FLIGHT');
      return { finalText: 'ok' };
    });
    await startDetachedChatRun({ userId: 'u1', chatId, message: 'hourly check', mode: 'single_thinking', machineWake: true });
    await waitFor(() => !isRunActive(key));
    expect(mockPrisma.toolIntent.findMany).not.toHaveBeenCalled();
  });

  it('a5b36dc6 (review P1): the kill switch suppresses the choke-point stamp', async () => {
    process.env.SUPERVISOR_INFLIGHT_PREEMPT_DISABLED = '1';
    try {
      const chatId = 'pm-inflight-off';
      const key = chatRunKey(chatId);
      mockRunCodingAgent.mockImplementationOnce(cancelResponsiveRun(key));
      await startDetachedChatRun({ userId: 'u1', chatId, message: 'hourly check', mode: 'single_thinking', machineWake: true });
      const res = await preemptMachineRunForUserMessage(chatId);
      expect(res).toEqual({ preempted: true, freed: true });
      const markerCalls = mockPrisma.supervisorState.upsert.mock.calls
        .map((c: any[]) => c[0]?.update?.state?.inflightPreemptAt ?? c[0]?.create?.state?.inflightPreemptAt)
        .filter((v: unknown) => typeof v === 'string' && v !== '');
      expect(markerCalls).toHaveLength(0);
      await waitFor(() => !isRunActive(key));
    } finally {
      delete process.env.SUPERVISOR_INFLIGHT_PREEMPT_DISABLED;
    }
  });

  it('NEVER cancels a user-triggered run — no cancel, no stop flag, no metric', async () => {
    const chatId = 'pu1';
    const key = chatRunKey(chatId);
    let release!: () => void;
    const gate = new Promise<void>(res => { release = res; });
    mockRunCodingAgent.mockImplementationOnce(async () => { await gate; return { finalText: 'A'.repeat(500) }; });
    await startDetachedChatRun({ userId: 'u1', chatId, message: 'my question', mode: 'single_thinking', userTurnAt: new Date() });
    expect(isRunActive(key)).toBe(true);

    const res = await preemptMachineRunForUserMessage(chatId);
    expect(res).toEqual({ preempted: false, freed: false });
    expect(isRunCancelled(key)).toBe(false); // the run was NOT touched
    expect(redisStore.has(`cm:liverun:stop:${chatId}`)).toBe(false);
    expect(mockResolvePendingForSession).not.toHaveBeenCalled();
    expect(mockRecordLoopMetric).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'chat_preemption' }));

    release();
    await waitFor(() => !isRunActive(key));
  });

  it('never touches a CODING-lane run (durable agent_runs busy, no liveness marker)', async () => {
    const chatId = 'pc1';
    mockPrisma.agentRun.findFirst.mockResolvedValue({ id: 'run-1' }); // worker-executed coding run
    const res = await preemptMachineRunForUserMessage(chatId);
    expect(res).toEqual({ preempted: false, freed: false });
    expect(redisStore.has(`cm:liverun:stop:${chatId}`)).toBe(false);
    expect(mockResolvePendingForSession).not.toHaveBeenCalled();
  });

  it('idle chat (no run anywhere) → { preempted:false } — nothing to do', async () => {
    await expect(preemptMachineRunForUserMessage('p-idle')).resolves.toEqual({ preempted: false, freed: false });
  });

  it('withdraws the stop flag when the machine run ended between the marker read and the stop write (never poisons the next run)', async () => {
    const chatId = 'pw1';
    // Plant a machine-marked liveness key with NO live run behind it (the run
    // ended right after the caller's marker read) — the preempt's re-check
    // must withdraw the stop request it just planted.
    redisStore.set(`cm:liverun:${chatId}`, `${process.pid}:machine`);
    // First re-check read sees the key gone (simulate the run's finally
    // deleting it between our two reads).
    let reads = 0;
    mockRedis.get.mockImplementation(async (k: string) => {
      if (k === `cm:liverun:${chatId}`) {
        reads += 1;
        if (reads >= 2) return null; // the run ended after the first read
      }
      return redisStore.get(k) ?? null;
    });
    const res = await preemptMachineRunForUserMessage(chatId, { waitMs: 50 });
    expect(res.preempted).toBe(true);
    expect(redisStore.has(`cm:liverun:stop:${chatId}`)).toBe(false); // withdrawn
    mockRedis.get.mockImplementation(async (k: string) => redisStore.get(k) ?? null);
  });

  it('teardown slower than the bounded wait → freed:false (the caller queues with priority — F2 is the guarantee)', async () => {
    const chatId = 'ps1';
    // A run that ignores cancellation for longer than the wait window.
    startLiveRun(chatRunKey(chatId));
    redisStore.set(`cm:liverun:${chatId}`, `${process.pid}:machine`);
    try {
      const res = await preemptMachineRunForUserMessage(chatId, { waitMs: 120 });
      expect(res).toEqual({ preempted: true, freed: false });
      expect(isRunCancelled(chatRunKey(chatId))).toBe(true); // the request stands
    } finally {
      endLiveRun(chatRunKey(chatId));
      redisStore.delete(`cm:liverun:${chatId}`);
    }
  });
});

describe('incident replay — F1 + F2a + the immediate finalize drain, together', () => {
  it('user send preempts the machine run; the finalize drain delivers the USER row before an OLDER machine row', async () => {
    const chatId = 'e2e1';
    const key = chatRunKey(chatId);
    // The occupying machine run (the 14:41 owner-inbox relay) — cancel-responsive.
    mockRunCodingAgent.mockImplementationOnce(cancelResponsiveRun(key));
    // The SECOND agent call is the drained owner run — hold it open so the
    // "machine row still queued behind it" state is observable (not a race
    // against the ms-fast default mock whose finally drains the next row).
    let releaseOwnerRun!: () => void;
    const ownerGate = new Promise<void>(res => { releaseOwnerRun = res; });
    mockRunCodingAgent.mockImplementationOnce(async () => { await ownerGate; return { finalText: 'A'.repeat(500) }; });
    await startDetachedChatRun({ userId: 'u1', chatId, message: 'relay wake', mode: 'single_thinking', machineWake: true });
    expect(isRunActive(key)).toBe(true);

    // While it runs, MORE machine traffic queues, then the owner types.
    await enqueueChatMessage({
      chatId, userId: 'u1', content: 'queued relay', mode: 'single_thinking', source: 'agent',
      origin: { kind: 'agent', sourceChatId: 'sup-1', depth: 0 },
    });
    await enqueueChatMessage({ chatId, userId: 'u1', content: 'owner question', mode: 'single_thinking', source: 'user' });

    // The send path preempts the machine run. Short waitMs: the cancelled
    // run's finalize drain wins the freed slot with the queued OWNER row
    // faster than the preempt's idle poll — the chat goes busy again WITH THE
    // USER'S RUN (exactly the goal), so `freed` stays false for the whole
    // bounded wait; the default 5s would eat jest's test timeout.
    const res = await preemptMachineRunForUserMessage(chatId, { waitMs: 500 });
    expect(res.preempted).toBe(true);

    // …and the cancelled run's own finalize drain starts the OWNER's message
    // first (F2a), with the older machine row waiting behind it.
    await waitFor(() => mockRunCodingAgent.mock.calls.some(c => String(c[0]?.userMessage).includes('owner question')));
    const atOwnerStart = mockRunCodingAgent.mock.calls.map(c => String(c[0]?.userMessage));
    expect(atOwnerStart.filter(m => m.includes('queued relay'))).toHaveLength(0);
    expect(pendingRows.some(r => r.content === 'queued relay')).toBe(true); // still queued, not lost

    // The chain still delivers the machine row afterwards — nothing is lost.
    releaseOwnerRun();
    await waitFor(() => mockRunCodingAgent.mock.calls.some(c => String(c[0]?.userMessage).includes('queued relay')));
    await waitFor(() => !isRunActive(key) && pendingRows.filter(r => r.chatId === chatId).length === 0);
    const carried = mockRunCodingAgent.mock.calls.map(c => String(c[0]?.userMessage));
    expect(carried.findIndex(m => m.includes('owner question'))).toBeLessThan(carried.findIndex(m => m.includes('queued relay')));
  });
});
