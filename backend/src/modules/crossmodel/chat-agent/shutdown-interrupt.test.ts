/**
 * shutdown-interrupt (feedback 56159c5a) — the SIGTERM deploy-interrupt ritual
 * for detached chat runs. Pins:
 *   - an active chat run whose chat's LATEST row is the unanswered user row
 *     gets: the honest deploy-interrupt ASSISTANT row (origin +
 *     interruptedMessageId + reason), a durable Redis requeue entry
 *     (DEPLOY_REQUEUE_KEY), and the chat_run_interrupted loop metric with
 *     reason 'deploy' — and the metric buffer is FLUSHED in-line (the process
 *     is about to die; the 2s micro-batch would lose it);
 *   - an active run whose turn is already ANSWERED (latest = plain assistant)
 *     is telemetry-only — no row, no requeue (the requeue consumer's
 *     still-unanswered re-check is the other half of this race);
 *   - a chat whose latest row is ALREADY a deploy-interrupt row (repeated
 *     interrupts) requeues the REFERENCED message without stacking a second
 *     notice row;
 *   - anonymous (chat:session:) / ephemeral runs are telemetry-only (no
 *     durable transcript exists to requeue);
 *   - a failed RPUSH still writes the interrupt row (the Rule-C DB backstop
 *     owns that turn);
 *   - zero active runs is a no-op (no flush, no prisma).
 *
 * prisma + redis + live-runs + loop-metrics are all mocked at the module
 * boundary — the ritual's logic is what is under test, not the stores.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockRedis = {
  rPush: jest.fn(async (..._a: any[]) => 1),
};
jest.mock('../../../config/redis', () => ({ __esModule: true, default: mockRedis }));

const mockPrisma: any = {
  crossModelMessage: {
    findFirst: jest.fn(async () => null),
    create: jest.fn(async () => ({})),
  },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

const mockListActiveRunIds = jest.fn((): string[] => []);
const mockGetRunMeta = jest.fn((_k: string): any => ({}));
jest.mock('../coding/live-runs', () => ({
  __esModule: true,
  listActiveRunIds: () => mockListActiveRunIds(),
  getRunMeta: (k: string) => mockGetRunMeta(k),
  runStartedAt: () => null,
}));

const mockRecordLoopMetric = jest.fn();
const mockFlushLoopMetrics = jest.fn(async () => {});
jest.mock('../platform/loop-metrics.service', () => {
  const actual = jest.requireActual('../platform/loop-metrics.service');
  return {
    __esModule: true,
    ...actual,
    recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
    flushLoopMetrics: () => mockFlushLoopMetrics(),
  };
});

import {
  interruptActiveChatRunsForShutdown,
  DEPLOY_INTERRUPT_ORIGIN,
  DEPLOY_REQUEUE_KEY,
  isDeployInterruptMeta,
} from './shutdown-interrupt';
import { LOOP_METRIC_KINDS } from '../platform/loop-metrics.service';

const USER_ROW = { id: 'm-user-1', role: 'user', metadata: null };
const ANSWER_ROW = { id: 'm-asst-1', role: 'assistant', metadata: { origin: 'user' } };
const INTERRUPT_ROW = {
  id: 'm-int-1',
  role: 'assistant',
  metadata: { origin: DEPLOY_INTERRUPT_ORIGIN, interruptedMessageId: 'm-user-1', reason: 'deploy' },
};

beforeEach(() => {
  jest.clearAllMocks();
  mockRedis.rPush.mockResolvedValue(1);
  mockPrisma.crossModelMessage.findFirst.mockResolvedValue(null);
  mockPrisma.crossModelMessage.create.mockResolvedValue({});
  mockListActiveRunIds.mockReturnValue([]);
  mockFlushLoopMetrics.mockResolvedValue(undefined);
});

describe('interruptActiveChatRunsForShutdown', () => {
  it('active chat run + latest-is-user → interrupt row + requeue entry + telemetry, flushed in-line', async () => {
    mockListActiveRunIds.mockReturnValue(['chat:c1']);
    mockPrisma.crossModelMessage.findFirst.mockResolvedValue(USER_ROW);
    await interruptActiveChatRunsForShutdown('deploy');
    // Honest assistant row.
    expect(mockPrisma.crossModelMessage.create).toHaveBeenCalledTimes(1);
    const created = mockPrisma.crossModelMessage.create.mock.calls[0][0].data;
    expect(created.chatId).toBe('c1');
    expect(created.role).toBe('assistant');
    expect(created.content).toMatch(/interrupted by a deploy/i);
    expect(created.metadata.origin).toBe(DEPLOY_INTERRUPT_ORIGIN);
    expect(created.metadata.interruptedMessageId).toBe('m-user-1');
    expect(created.metadata.reason).toBe('deploy');
    // Durable requeue entry.
    expect(mockRedis.rPush).toHaveBeenCalledTimes(1);
    const [listKey, raw] = mockRedis.rPush.mock.calls[0];
    expect(listKey).toBe(DEPLOY_REQUEUE_KEY);
    const entry = JSON.parse(raw);
    expect(entry.chatId).toBe('c1');
    expect(entry.userMessageId).toBe('m-user-1');
    expect(entry.reason).toBe('deploy');
    expect(typeof entry.at).toBe('string');
    // Telemetry — chat_run_interrupted { reason:'deploy' } …
    expect(mockRecordLoopMetric).toHaveBeenCalledTimes(1);
    const metric = mockRecordLoopMetric.mock.calls[0][0];
    expect(metric.kind).toBe(LOOP_METRIC_KINDS.CHAT_RUN_INTERRUPTED);
    expect(metric.kind).toBe('chat_run_interrupted');
    expect(metric.meta.reason).toBe('deploy');
    expect(metric.meta.chatId).toBe('c1');
    // … flushed in-line (the process is about to die).
    expect(mockFlushLoopMetrics).toHaveBeenCalledTimes(1);
  });

  it('active run but the turn is already ANSWERED (latest = plain assistant) → telemetry only, no row, no requeue', async () => {
    mockListActiveRunIds.mockReturnValue(['chat:c1']);
    mockPrisma.crossModelMessage.findFirst.mockResolvedValue(ANSWER_ROW);
    await interruptActiveChatRunsForShutdown('deploy');
    expect(mockRecordLoopMetric).toHaveBeenCalledTimes(1);
    expect(mockPrisma.crossModelMessage.create).not.toHaveBeenCalled();
    expect(mockRedis.rPush).not.toHaveBeenCalled();
    expect(mockFlushLoopMetrics).toHaveBeenCalledTimes(1);
  });

  it('latest is ALREADY a deploy-interrupt row (repeated interrupts) → requeues the REFERENCED message, no second notice row', async () => {
    mockListActiveRunIds.mockReturnValue(['chat:c1']);
    mockPrisma.crossModelMessage.findFirst.mockResolvedValue(INTERRUPT_ROW);
    await interruptActiveChatRunsForShutdown('deploy');
    expect(mockPrisma.crossModelMessage.create).not.toHaveBeenCalled();
    expect(mockRedis.rPush).toHaveBeenCalledTimes(1);
    const entry = JSON.parse(mockRedis.rPush.mock.calls[0][1]);
    expect(entry.userMessageId).toBe('m-user-1');
  });

  it('anonymous + ephemeral runs are telemetry-only — no prisma, no requeue', async () => {
    mockListActiveRunIds.mockReturnValue(['chat:session:sess-1', 'chat:ephemeral:eph-1']);
    await interruptActiveChatRunsForShutdown('deploy');
    expect(mockRecordLoopMetric).toHaveBeenCalledTimes(2);
    expect(mockRecordLoopMetric.mock.calls[0][0].meta.runKey).toBe('chat:session:sess-1');
    expect(mockPrisma.crossModelMessage.findFirst).not.toHaveBeenCalled();
    expect(mockPrisma.crossModelMessage.create).not.toHaveBeenCalled();
    expect(mockRedis.rPush).not.toHaveBeenCalled();
    expect(mockFlushLoopMetrics).toHaveBeenCalledTimes(1);
  });

  it('a failed RPUSH still writes the interrupt row (the Rule-C DB backstop owns that turn)', async () => {
    mockListActiveRunIds.mockReturnValue(['chat:c1']);
    mockPrisma.crossModelMessage.findFirst.mockResolvedValue(USER_ROW);
    mockRedis.rPush.mockRejectedValue(new Error('redis down'));
    await interruptActiveChatRunsForShutdown('deploy');
    expect(mockPrisma.crossModelMessage.create).toHaveBeenCalledTimes(1);
    expect(mockFlushLoopMetrics).toHaveBeenCalledTimes(1);
  });

  it('a chat whose ritual branch throws does not block the other runs (per-run isolation)', async () => {
    mockListActiveRunIds.mockReturnValue(['chat:c-bad', 'chat:c-good']);
    mockPrisma.crossModelMessage.findFirst
      .mockRejectedValueOnce(new Error('db hiccup'))
      .mockResolvedValueOnce(USER_ROW);
    await interruptActiveChatRunsForShutdown('deploy');
    expect(mockRedis.rPush).toHaveBeenCalledTimes(1);
    const entry = JSON.parse(mockRedis.rPush.mock.calls[0][1]);
    expect(entry.chatId).toBe('c-good');
  });

  it('zero active runs is a no-op — no prisma, no redis, no flush', async () => {
    mockListActiveRunIds.mockReturnValue([]);
    await interruptActiveChatRunsForShutdown('deploy');
    expect(mockRecordLoopMetric).not.toHaveBeenCalled();
    expect(mockPrisma.crossModelMessage.findFirst).not.toHaveBeenCalled();
    expect(mockRedis.rPush).not.toHaveBeenCalled();
    expect(mockFlushLoopMetrics).not.toHaveBeenCalled();
  });
});

describe('isDeployInterruptMeta', () => {
  it('accepts the ritual’s row shape, rejects everything else', () => {
    expect(isDeployInterruptMeta(INTERRUPT_ROW.metadata)).toBe(true);
    expect(isDeployInterruptMeta({ origin: DEPLOY_INTERRUPT_ORIGIN })).toBe(false); // no interruptedMessageId
    expect(isDeployInterruptMeta({ origin: 'orphan-recovery', interruptedMessageId: 'x' })).toBe(false);
    expect(isDeployInterruptMeta(null)).toBe(false);
    expect(isDeployInterruptMeta('deploy-interrupt')).toBe(false);
    expect(isDeployInterruptMeta(['deploy-interrupt'])).toBe(false);
  });
});

describe('audit 2026-09-26 (routing-unify-4 / sse-ui-restore-1 / tests-gaps-1): a Dig-deeper rung cut by the deploy', () => {
  const ORIG_ID = 'm-orig-asst';
  const ORIG = { id: ORIG_ID, chatId: 'c1', createdAt: new Date('2026-09-26T20:00:00Z'), metadata: { depth: { plan: { preset: 'thinking' }, escalations: [{ rung: 'research', at: '2026-09-26T20:35:00Z', status: 'running' }] } } };
  beforeEach(() => {
    mockPrisma.crossModelMessage.findUnique = jest.fn(async () => ORIG);
    mockPrisma.crossModelMessage.update = jest.fn(async () => ({}));
    mockGetRunMeta.mockReturnValue({ chatId: 'c1', machineTriggered: false, escalation: { ofMessageId: ORIG_ID, rung: 'research' } });
    // the chat's latest row is the ESCALATED answer itself (an escalation persists no user row)
    mockPrisma.crossModelMessage.findFirst.mockImplementation(async (q: any) => (q?.where?.role === 'user' ? { id: 'm-user-q' } : ANSWER_ROW));
  });
  it('is re-queued AS AN ESCALATION (entry.escalation + the original question row), the original row reads interrupted, telemetry names the rung — no interrupt row, no plain re-ask', async () => {
    mockListActiveRunIds.mockReturnValue(['chat:c1']);
    await interruptActiveChatRunsForShutdown('deploy');
    expect(mockRedis.rPush).toHaveBeenCalledTimes(1);
    const entry = JSON.parse(mockRedis.rPush.mock.calls[0][1]);
    expect(entry).toMatchObject({ chatId: 'c1', userMessageId: 'm-user-q', reason: 'deploy', escalation: { ofMessageId: ORIG_ID, rung: 'research' } });
    expect(mockPrisma.crossModelMessage.create).not.toHaveBeenCalled();
    const upd = mockPrisma.crossModelMessage.update.mock.calls[0][0];
    expect(upd.where).toEqual({ id: ORIG_ID });
    expect(upd.data.metadata.depth.escalations).toEqual([expect.objectContaining({ rung: 'research', status: 'interrupted' })]);
    const metric = mockRecordLoopMetric.mock.calls[0][0];
    expect(metric.meta).toMatchObject({ reason: 'deploy', chatId: 'c1', escalationRung: 'research', escalationOf: ORIG_ID });
  });
});

describe('cohesive-chat wave 2026-09-28 (review fix 3): a turn-continuation ROUND cut by the deploy', () => {
  const STASH = { taskId: 't-1', round: 2, maxRounds: 3, reason: 'deadline_mid_task', ofMessageId: 'm-orig-asst', askMessageId: 'm-user-ask', startedAt: '2026-09-28T00:00:00.000Z', askText: 'find the thread' };
  const PROMPT = '[HARNESS CONTINUATION r2/3 task=t-1 of=m-orig-asst reason=deadline_mid_task since=2026-09-28T00:00:00.000Z ask=m-user-ask] — resume';
  beforeEach(() => {
    mockPrisma.crossModelMessage.update = jest.fn(async () => ({}));
    mockGetRunMeta.mockReturnValue({ chatId: 'c1', machineTriggered: true, continuation: { stash: STASH, prompt: PROMPT, mode: 'thinking' } });
    // the chat's latest row is the REWRITTEN answer (a round persists no user row) — the plain shape would drop it
    mockPrisma.crossModelMessage.findFirst.mockResolvedValue(ANSWER_ROW);
  });
  it('is re-queued AS A CONTINUATION (entry.continuation = stash + prompt + mode) — no interrupt row, no plain re-ask; telemetry names the round', async () => {
    mockListActiveRunIds.mockReturnValue(['chat:c1']);
    await interruptActiveChatRunsForShutdown('deploy');
    expect(mockRedis.rPush).toHaveBeenCalledTimes(1);
    const entry = JSON.parse(mockRedis.rPush.mock.calls[0][1]);
    expect(entry).toMatchObject({ chatId: 'c1', userMessageId: 'm-user-ask', reason: 'deploy', continuation: { stash: STASH, prompt: PROMPT, mode: 'thinking' } });
    expect(entry.escalation).toBeUndefined();
    expect(mockPrisma.crossModelMessage.create).not.toHaveBeenCalled();
    expect(mockPrisma.crossModelMessage.findFirst).not.toHaveBeenCalled(); // decided from the run meta, never the latest-row shape
    const metric = mockRecordLoopMetric.mock.calls[0][0];
    expect(metric.meta).toMatchObject({ reason: 'deploy', chatId: 'c1', continuationRound: 2, continuationTaskId: 't-1' });
  });
  it('a stash without askMessageId anchors userMessageId on the original answer row (never read as a user row by the consumer)', async () => {
    const { askMessageId: _drop, ...noAsk } = STASH;
    mockGetRunMeta.mockReturnValue({ chatId: 'c1', continuation: { stash: noAsk, prompt: PROMPT, mode: 'thinking' } });
    mockListActiveRunIds.mockReturnValue(['chat:c1']);
    await interruptActiveChatRunsForShutdown('deploy');
    expect(JSON.parse(mockRedis.rPush.mock.calls[0][1])).toMatchObject({ userMessageId: 'm-orig-asst', continuation: { stash: noAsk } });
  });
});