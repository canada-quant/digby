/**
 * sched-terminal-stop.test.ts — fireScheduleTarget wiring of the machine-lane
 * terminal-stop contract (feedback 065caccb).
 *
 * The failure: after a dispatched ticket/batch was closed done WITH evidence,
 * later scheduled firings of the lane's own (days-old, machine-authored)
 * prompts re-audited the closed work — nothing in the wake said it was
 * terminal (2026-09-15: lane b92ef13f re-audited the done 6fac1460 batch twice;
 * lane e8b27fcd looped 4 echo continuations on done 7503189b).
 *
 * The fix, pinned here: at fire time, every prompt that references a
 * status=done ticket rides the wake with a [TERMINAL-STOP] block appended —
 * for coding lanes AND plain-chat lanes, schedule firings AND hook wakes —
 * while open tickets, unresolvable refs, a resolver failure, and the
 * kill-switch env all leave the prompt untouched (and never skip the firing).
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../../config/env', () => ({
  __esModule: true,
  env: { NODE_ENV: 'test' },
}));

// ── Prisma: the fire-path reads (chat lookup + stale-firing schedule re-read)
//    + the continuation fast-lane reads (agentRun queue/cap gates). ──
const mockChatFindUnique = jest.fn(async (..._a: any[]): Promise<any> => null);
const mockAgentRunCreate = jest.fn(async (..._a: any[]): Promise<any> => ({ id: 'run-1' }));
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    chatSchedule: {
      update: jest.fn(async () => ({})),
      findUnique: jest.fn(async () => ({
        enabled: true, kind: 'recurring', runsCount: 0, maxRuns: null, expiresAt: null, lastFiredAt: null,
      })),
      count: jest.fn(async () => 0),
    },
    crossModelChat: { findUnique: (...a: any[]) => mockChatFindUnique(...a) },
    schedulePromptHistory: { findFirst: jest.fn(async () => null), count: jest.fn(async () => 0) },
    agentRun: {
      findFirst: jest.fn(async () => null),
      create: (...a: any[]) => mockAgentRunCreate(...a),
      count: jest.fn(async () => 0),
    },
  },
}));

// ── Redis stand-in (cap state + probe-notice consume). ──
const mockStore = new Map<string, string>();
jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: {
    incr: jest.fn(async (k: string) => {
      const n = (parseInt(mockStore.get(k) ?? '0', 10) || 0) + 1;
      mockStore.set(k, String(n));
      return n;
    }),
    expire: jest.fn(async () => true),
    set: jest.fn(async () => 'OK'),
    del: jest.fn(async () => 1),
    get: jest.fn(async (k: string) => mockStore.get(k) ?? null),
    getDel: jest.fn(async () => null),
    pTTL: jest.fn(async () => -2),
    publish: jest.fn(async () => 1),
  },
}));

const mockEmitHookEvent = jest.fn(async (..._a: any[]): Promise<any> => {});
jest.mock('../platform/hooks.service', () => ({
  __esModule: true,
  emitHookEvent: (...a: any[]) => mockEmitHookEvent(...a),
  emitHookEventSafe: (...a: any[]) => mockEmitHookEvent(...a),
}));

// The coding fire path (dynamic import in fireScheduleTarget).
const mockStartScheduledRun = jest.fn(async (..._a: any[]): Promise<any> => ({ started: true }));
jest.mock('./coding-stream.controller', () => ({
  __esModule: true,
  startScheduledRun: (...a: any[]) => mockStartScheduledRun(...a),
}));

// The plain-chat fire path (dynamic import in fireScheduleTarget).
const mockStartDetachedChatRun = jest.fn(async (..._a: any[]): Promise<boolean> => true);
jest.mock('../chat-agent/chat-agent.service', () => ({
  __esModule: true,
  startDetachedChatRun: (...a: any[]) => mockStartDetachedChatRun(...a),
}));

// The terminal-stop resolver seam (dynamic import in schedule.service).
const mockResolve = jest.fn(async (..._a: any[]): Promise<any> => null);
jest.mock('../feedback/feedback.service', () => ({
  __esModule: true,
  getFeedbackTicketById: (...a: any[]) => mockResolve(...a),
}));

// The continuation fast lane's plan re-read (dynamic import) — one pending
// step so the obsolete guard passes and the queue proceeds.
jest.mock('./plan.service', () => ({
  __esModule: true,
  getPlan: jest.fn(async () => null),
  getPlanStrict: jest.fn(async () => ({ steps: [{ status: 'in_progress' }] })),
  applyPlan: jest.fn(),
  planToUpdate: jest.fn(),
  renderPlanReminder: jest.fn(() => ''),
}));

// recordLoopMetric is fire-and-forget in the queue path — silence it.
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: jest.fn(),
  LOOP_METRIC_KINDS: new Proxy({}, { get: (_t, k) => String(k) }),
}));

import { fireScheduleTarget, queueContinuationRun } from './schedule.service';

const DONE_TICKET = {
  id: '6fac1460-1111-2222-3333-444455556666',
  status: 'done',
  title: 'probe.sh custom.js verbatim ship',
  adminNote: 'closed with evidence: PR #803',
  updatedAt: new Date('2026-09-15T18:50:00.000Z'),
};

beforeEach(() => {
  jest.clearAllMocks();
  mockStore.clear();
  mockChatFindUnique.mockResolvedValue({ userId: 'u1', mode: 'fast', codingState: { id: 'cs1' } });
  mockStartScheduledRun.mockResolvedValue({ started: true });
  mockStartDetachedChatRun.mockResolvedValue(true);
  mockResolve.mockResolvedValue({ ok: true, ticket: DONE_TICKET });
});

describe('fireScheduleTarget — [TERMINAL-STOP] injection', () => {
  it('a schedule firing whose prompt references a DONE ticket fires WITH the terminal-stop block', async () => {
    const res = await fireScheduleTarget({
      id: 'sch_1', sessionId: 's1',
      prompt: 'probe gate → check artifacts → re-chain. Ticket batch 6fac1460 was closed earlier.',
    });
    expect(res).toEqual({ started: true });
    expect(mockResolve).toHaveBeenCalledWith('6fac1460');
    const prompt = mockStartScheduledRun.mock.calls[0][1] as string;
    expect(prompt).toContain('[TERMINAL-STOP');
    expect(prompt).toContain('6fac1460');
    expect(prompt).toContain('TERMINAL');
    expect(prompt).toContain('still OPEN');
  });

  it('a firing referencing an OPEN ticket gets NO block (the resolver says open)', async () => {
    mockResolve.mockResolvedValue({ ok: true, ticket: { ...DONE_TICKET, status: 'in_progress' } });
    await fireScheduleTarget({ id: 'sch_2', sessionId: 's1', prompt: 'work ticket 6fac1460 now' });
    expect(mockStartScheduledRun.mock.calls[0][1]).not.toContain('[TERMINAL-STOP');
  });

  it('a firing with NO ticket refs never calls the resolver and never decorates', async () => {
    await fireScheduleTarget({ id: 'sch_3', sessionId: 's1', prompt: 'check the monitor dashboard' });
    expect(mockResolve).not.toHaveBeenCalled();
    expect(mockStartScheduledRun.mock.calls[0][1]).not.toContain('[TERMINAL-STOP');
  });

  it('an unresolvable ref (not_found) leaves the prompt untouched', async () => {
    mockResolve.mockResolvedValue({ ok: false, reason: 'not_found' });
    await fireScheduleTarget({ id: 'sch_4', sessionId: 's1', prompt: 'ticket 6fac1460 mentioned' });
    expect(mockStartScheduledRun.mock.calls[0][1]).not.toContain('[TERMINAL-STOP');
  });

  it('a resolver FAILURE never drops the firing (fail-open) and injects nothing', async () => {
    mockResolve.mockRejectedValue(new Error('db down'));
    const res = await fireScheduleTarget({ id: 'sch_5', sessionId: 's1', prompt: 'ticket 6fac1460 mentioned' });
    expect(res).toEqual({ started: true });
    expect(mockStartScheduledRun.mock.calls[0][1]).not.toContain('[TERMINAL-STOP');
  });

  it('HOOK WAKES get the block too — the re-audit exposure is identical there', async () => {
    const res = await fireScheduleTarget({ id: 'hook-42', sessionId: 's1', prompt: 'wake: ticket 7503189b closed yesterday', origin: 'hook' });
    expect(res).toEqual({ started: true });
    expect(mockResolve).toHaveBeenCalledWith('7503189b');
    expect(mockStartScheduledRun.mock.calls[0][1]).toContain('[TERMINAL-STOP');
  });

  it('PLAIN-CHAT lanes get the block on the detached-run message', async () => {
    mockChatFindUnique.mockResolvedValue({ userId: 'u1', mode: 'fast', codingState: null });
    const res = await fireScheduleTarget({ id: 'sch_7', sessionId: 's1', prompt: 'digest run; ticket 6fac1460 closed' });
    expect(res).toEqual({ started: true });
    expect(mockStartScheduledRun).not.toHaveBeenCalled();
    const message = mockStartDetachedChatRun.mock.calls[0][0].message as string;
    expect(message).toContain('[TERMINAL-STOP');
  });

  it('dedupes several refs to the SAME done ticket into one lookup + one block', async () => {
    await fireScheduleTarget({
      id: 'sch_8', sessionId: 's1',
      prompt: 'ticket 6fac1460 done; also 6fac1460-1111-2222-3333-444455556666 closed',
    });
    // two ref forms resolve to one ticket id → one listed entry
    const prompt = mockStartScheduledRun.mock.calls[0][1] as string;
    expect(prompt.match(/\[TERMINAL-STOP/g)).toHaveLength(1);
    expect(prompt.indexOf('6fac1460 ·')).toBe(prompt.lastIndexOf('6fac1460 ·'));
  });
});

describe('queueContinuationRun — fast-lane terminal-stop parity', () => {
  it('a continuation prompt referencing a DONE ticket queues WITH the block (the e8b27fcd lane)', async () => {
    const res = await queueContinuationRun({
      sessionId: 's1', userId: 'u1',
      prompt: '[HARNESS CONTINUATION] finish ticket 7503189b leftovers',
    });
    expect(res.ok).toBe(true);
    expect(mockResolve).toHaveBeenCalledWith('7503189b');
    const input = mockAgentRunCreate.mock.calls[0][0].data.input as any;
    expect(input.message).toContain('[TERMINAL-STOP');
    expect(input.message).toContain('7503189b');
  });

  it('a continuation naming only OPEN tickets queues UNDECORATED', async () => {
    mockResolve.mockResolvedValue({ ok: true, ticket: { ...DONE_TICKET, status: 'in_progress' } });
    const res = await queueContinuationRun({
      sessionId: 's1', userId: 'u1',
      prompt: '[HARNESS CONTINUATION] finish ticket 7503189b leftovers',
    });
    expect(res.ok).toBe(true);
    const input = mockAgentRunCreate.mock.calls[0][0].data.input as any;
    expect(input.message).not.toContain('[TERMINAL-STOP');
  });

  it('a resolver failure never blocks a continuation queue (fail-open)', async () => {
    mockResolve.mockRejectedValue(new Error('db down'));
    const res = await queueContinuationRun({
      sessionId: 's1', userId: 'u1',
      prompt: '[HARNESS CONTINUATION] finish ticket 7503189b leftovers',
    });
    expect(res.ok).toBe(true);
    const input = mockAgentRunCreate.mock.calls[0][0].data.input as any;
    expect(input.message).not.toContain('[TERMINAL-STOP');
  });
});
