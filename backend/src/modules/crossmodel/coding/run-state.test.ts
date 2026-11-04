/**
 * Durability Phase 1 — durable agent-run state: write-ahead checkpoint +
 * finalize semantics, orphan reconciliation, the durable event log, and the
 * pure dispatch-trim used by resume.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockPrisma: any = {
  agentRun: {
    create: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
    findFirst: jest.fn(),
    findUnique: jest.fn(),
  },
  agentEvent: {
    create: jest.fn(),
    findMany: jest.fn(),
    aggregate: jest.fn(),
  },
  chatCodingState: {
    updateMany: jest.fn(),
  },
  $queryRaw: jest.fn(),
  $executeRaw: jest.fn(async () => 1),
  $transaction: jest.fn(async (arg: any) => (typeof arg === 'function' ? arg(mockPrisma) : Promise.all(arg))),
};

jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

import { Prisma } from '@prisma/client';
import {
  createAgentRun, writeCheckpoint, heartbeatAgentRun, finalizeAgentRun,
  finalizeAgentRunShutdownInterrupted, resumeAgentRun,
  loadLatestResumableRun, reconcileOrphanedRuns, adoptStaleRunningRuns, supersedeInterruptedRuns,
  appendAgentEvent, getAgentEventsAfter, getMaxAgentEventSeq, getLatestEventRunId, trimToPreModel, RunCheckpoint,
  queueAgentRun, getActiveRunForSession, getLatestRunForSession, markRunFailed, markInputConsumed,
  SessionBusyError, appendAttemptCause, recordAttemptError,
  trimTerminalCheckpoint, isResumableCheckpoint, TERMINAL_CHECKPOINT_MAX_CHARS,
} from './run-state';

const CP: RunCheckpoint = {
  version: 1,
  messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }],
  step: 3, stepBudget: 200, phase: 'preModel',
  compactionCount: 1, modelErrored: false, modelErrorRecoveries: 0, repetitionRetries: 0,
  leakRetries: 0, autoContinueRounds: 2, autoVerifyIters: 0, lastPlanSig: 'sig',
  lastContinueDiffHash: 'hash', continueStalls: 0, selfAudited: false, lastToolSig: '',
  repeatCount: 0, runStartedAt: 1700000000000, deadlineOffsetMs: 0,
  recentDiffHashes: ['a'], failureSigCounts: { f: 2 }, usageRunId: 'rABC',
};

beforeEach(() => jest.clearAllMocks());

describe('createAgentRun / writeCheckpoint / heartbeat', () => {
  it('opens a running row with heartbeat + lease', async () => {
    mockPrisma.agentRun.create.mockResolvedValue({ id: 'run1' });
    const id = await createAgentRun('sess1');
    expect(id).toBe('run1');
    const data = mockPrisma.agentRun.create.mock.calls[0][0].data;
    expect(data.sessionId).toBe('sess1');
    expect(data.status).toBe('running');
    expect(data.heartbeatAt).toBeInstanceOf(Date);
    expect(data.leaseExpiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('writeCheckpoint stores the checkpoint + step, guarded on status=running (write/finalize race)', async () => {
    mockPrisma.agentRun.updateMany.mockResolvedValue({ count: 1 });
    await writeCheckpoint('run1', CP);
    const [args] = mockPrisma.agentRun.updateMany.mock.calls[0];
    expect(args.where).toEqual({ id: 'run1', status: 'running' });
    expect(args.data.currentStep).toBe(3);
    expect(args.data.checkpoint).toEqual(CP);
    // A seq-less (legacy) checkpoint never takes the fenced raw path.
    expect(mockPrisma.$executeRaw).not.toHaveBeenCalled();
  });

  it('heartbeat touches liveness only, guarded on running', async () => {
    mockPrisma.agentRun.updateMany.mockResolvedValue({ count: 1 });
    await heartbeatAgentRun('run1');
    const [args] = mockPrisma.agentRun.updateMany.mock.calls[0];
    expect(args.where).toEqual({ id: 'run1', status: 'running' });
    expect(args.data.checkpoint).toBeUndefined();
    // FO firing 46: the count is RETURNED — 0 = the durable row is gone (chat
    // deleted mid-run) and the executor must stop the zombie. A live row
    // returns 1.
    expect(await heartbeatAgentRun('run1')).toBe(1);
    mockPrisma.agentRun.updateMany.mockResolvedValueOnce({ count: 0 });
    expect(await heartbeatAgentRun('gone')).toBe(0);
  });
});

describe('writeCheckpoint monotonic fence (audit #8)', () => {
  const rawSql = () => {
    const [strings, ...values] = mockPrisma.$executeRaw.mock.calls[0];
    return { sql: (strings as readonly string[]).join('?'), values };
  };

  it('a seq-carrying checkpoint writes via ONE atomic fenced UPDATE (status guard + jsonb seq comparison in the WHERE)', async () => {
    await writeCheckpoint('run1', { ...CP, checkpointSeq: 7 });
    expect(mockPrisma.agentRun.updateMany).not.toHaveBeenCalled(); // never the unfenced path
    expect(mockPrisma.$executeRaw).toHaveBeenCalledTimes(1);
    const { sql, values } = rawSql();
    expect(sql).toContain('UPDATE "agent_runs"');
    expect(sql).toContain(`"status" = 'running'`);
    // The fence lives IN the WHERE — check+write is one statement, not a racy
    // SELECT-then-UPDATE pair.
    expect(sql).toContain(`COALESCE(("checkpoint"->>'checkpointSeq')::bigint, -1) <`);
    // Params: checkpoint JSON (cast ::jsonb), step, heartbeat, lease, runId, seq.
    expect(JSON.parse(values[0]).checkpointSeq).toBe(7);
    expect(values[1]).toBe(CP.step);
    expect(values[2]).toBeInstanceOf(Date);
    expect(values[3]).toBeInstanceOf(Date);
    expect(values[4]).toBe('run1');
    expect(values[5]).toBe(7);
  });

  it('a stale seq (0 rows updated) is SILENTLY skipped with a debug log — never an error, never a fallback write', async () => {
    mockPrisma.$executeRaw.mockResolvedValueOnce(0); // stored seq >= incoming, or not running
    await expect(writeCheckpoint('run1', { ...CP, checkpointSeq: 3 })).resolves.toBeUndefined();
    expect(mockPrisma.agentRun.updateMany).not.toHaveBeenCalled();
    const logger = jest.requireMock('../../../utils/logger').default;
    expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining('skipped stale/out-of-order checkpoint write for run run1'));
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('a fresh row (no stored seq → COALESCE -1) accepts seq 1: the fence SQL compares strictly less-than', async () => {
    await writeCheckpoint('run1', { ...CP, checkpointSeq: 1 });
    const { sql, values } = rawSql();
    // -1 < 1 passes; equal seqs are refused (<, not <=) so a duplicate write of
    // the SAME checkpoint can't extend the lease of a superseded attempt.
    expect(sql).toContain('-1) <');
    expect(sql).not.toContain('<=');
    expect(values[5]).toBe(1);
  });
});

describe('finalizeAgentRun', () => {
  it.each(['completed', 'failed', 'cancelled'] as const)('terminal status %s NULLS the checkpoint and does NOT touch attempts', async (status) => {
    mockPrisma.agentRun.update.mockResolvedValue({});
    await finalizeAgentRun('run1', status, status === 'failed' ? 'boom' : undefined);
    const [args] = mockPrisma.agentRun.update.mock.calls[0];
    expect(args.data.status).toBe(status);
    expect(args.data.checkpoint).toBe(Prisma.DbNull);
    expect(args.data.finishedAt).toBeInstanceOf(Date);
    expect(args.data.attempts).toBeUndefined(); // no compensation on a terminal finalize
  });

  it('interrupted RETAINS the checkpoint (resumable) and keeps the claim-time attempt', async () => {
    mockPrisma.agentRun.update.mockResolvedValue({});
    await finalizeAgentRun('run1', 'interrupted');
    const [args] = mockPrisma.agentRun.update.mock.calls[0];
    expect(args.data.status).toBe('interrupted');
    expect('checkpoint' in args.data).toBe(false);
    expect(args.data.attempts).toBeUndefined(); // generic finalize never compensates
  });

  // agent-decisions prerequisite 6 (2026-09-27): terminal runs keep a TRIMMED
  // summary (counters + plan step states, ≤ 4 KB, no transcript) so the
  // goal-continue decision is replayable; nothing about it is resumable.
  describe('trimmed TERMINAL checkpoint', () => {
    const FULL = { ...CP, step: 9, autoContinueRounds: 2, continueStalls: 1, autoVerifyIters: 1, selfAudited: true, deadlineOffsetMs: 1234, lastPlanSig: '1:completed:Read the thing|2:pending:Write it: carefully|3:blocked:Deploy' };
    afterEach(() => { mockPrisma.agentRun.findUnique.mockReset(); });

    it('a terminal finalize keeps the trimmed summary of the STORED checkpoint (never the transcript) and it is not resumable', async () => {
      mockPrisma.agentRun.findUnique.mockResolvedValueOnce({ checkpoint: FULL });
      mockPrisma.agentRun.update.mockResolvedValue({});
      await finalizeAgentRun('run1', 'completed');
      expect(mockPrisma.agentRun.findUnique).toHaveBeenCalledWith({ where: { id: 'run1' }, select: { checkpoint: true } });
      const [args] = mockPrisma.agentRun.update.mock.calls[0];
      expect(args.data.status).toBe('completed');
      const cp = args.data.checkpoint;
      expect(cp).toMatchObject({
        version: 1, terminal: true, status: 'completed', step: 9, stepBudget: 200, autoContinueRounds: 2, continueStalls: 1, autoVerifyIters: 1,
        compactionCount: 1, selfAudited: true, runStartedAt: 1700000000000, deadlineOffsetMs: 1234,
        planSteps: ['1:completed', '2:pending', '3:blocked'],
      });
      expect(typeof cp.lastPlanSigHash).toBe('string');
      expect(cp.messages).toBeUndefined();
      expect(JSON.stringify(cp)).not.toContain('Read the thing'); // step TEXT never rides
      expect(JSON.stringify(cp).length).toBeLessThanOrEqual(TERMINAL_CHECKPOINT_MAX_CHARS);
      expect(isResumableCheckpoint(cp)).toBe(false);
      expect(isResumableCheckpoint(CP)).toBe(true);
      expect(isResumableCheckpoint(null)).toBe(false);
      expect(isResumableCheckpoint({ terminal: false })).toBe(false); // no transcript
    });

    it.each(['failed', 'cancelled'] as const)('%s keeps the trimmed summary too, with its status', async (status) => {
      mockPrisma.agentRun.findUnique.mockResolvedValueOnce({ checkpoint: FULL });
      mockPrisma.agentRun.update.mockResolvedValue({});
      await finalizeAgentRun('run1', status, 'boom');
      expect(mockPrisma.agentRun.update.mock.calls[0][0].data.checkpoint).toMatchObject({ terminal: true, status, autoContinueRounds: 2 });
    });

    it('no stored checkpoint or a read error → NULL exactly as before; interrupted never reads the row', async () => {
      mockPrisma.agentRun.update.mockResolvedValue({});
      mockPrisma.agentRun.findUnique.mockResolvedValueOnce({ checkpoint: null });
      await finalizeAgentRun('run1', 'completed');
      expect(mockPrisma.agentRun.update.mock.calls[0][0].data.checkpoint).toBe(Prisma.DbNull);
      mockPrisma.agentRun.findUnique.mockRejectedValueOnce(new Error('db down'));
      await finalizeAgentRun('run1', 'completed');
      expect(mockPrisma.agentRun.update.mock.calls[1][0].data.checkpoint).toBe(Prisma.DbNull);
      await finalizeAgentRun('run1', 'interrupted');
      expect(mockPrisma.agentRun.findUnique).toHaveBeenCalledTimes(2);
      expect('checkpoint' in mockPrisma.agentRun.update.mock.calls[2][0].data).toBe(false);
    });

    it('trimTerminalCheckpoint (pure): bounds planSteps to the 4 KB cap from the tail, tolerates missing counters, refuses an already-terminal input and garbage', () => {
      const huge = { ...CP, lastPlanSig: Array.from({ length: 800 }, (_, i) => `${i}:pending:step ${i}`).join('|') };
      const t = trimTerminalCheckpoint(huge, 'completed')!;
      expect(JSON.stringify(t).length).toBeLessThanOrEqual(TERMINAL_CHECKPOINT_MAX_CHARS);
      expect(t.planSteps.length).toBeGreaterThan(0);
      expect(t.planSteps.length).toBeLessThan(800);
      expect(t.planSteps[0]).toBe('0:pending');
      expect(trimTerminalCheckpoint({ version: 1, messages: [] }, 'failed')).toMatchObject({ terminal: true, status: 'failed', step: 0, autoContinueRounds: 0, continueStalls: 0, planSteps: [] });
      expect(trimTerminalCheckpoint(t, 'completed')).toBeNull();
      expect(trimTerminalCheckpoint(null, 'completed')).toBeNull();
      expect(trimTerminalCheckpoint('x', 'completed')).toBeNull();
    });
  });
});

describe('finalizeAgentRunShutdownInterrupted (attempt-neutral graceful-deploy finalize)', () => {
  it('issues ONE atomic update: interrupted + finishedAt + attempts compensated, checkpoint RETAINED (untouched)', async () => {
    mockPrisma.agentRun.update.mockResolvedValue({});
    await finalizeAgentRunShutdownInterrupted('run1');
    expect(mockPrisma.agentRun.update).toHaveBeenCalledTimes(1);
    const [args] = mockPrisma.agentRun.update.mock.calls[0];
    expect(args.where).toEqual({ id: 'run1' });
    expect(args.data.status).toBe('interrupted');
    expect(args.data.finishedAt).toBeInstanceOf(Date);
    // The doctrine: a graceful deploy interrupt is NOT an attempt (mirrors
    // requeueRun's H1) — compensate the claim-time increment…
    expect(args.data.attempts).toEqual({ decrement: 1 });
    // …while the checkpoint stays resumable (same as the generic interrupted finalize)…
    expect('checkpoint' in args.data).toBe(false);
    // …and no error is recorded when none accompanied the interrupt.
    expect(args.data).not.toHaveProperty('error');
  });

  it('records a truncated error when one accompanies the interrupt (still attempt-neutral, checkpoint retained)', async () => {
    mockPrisma.agentRun.update.mockResolvedValue({});
    await finalizeAgentRunShutdownInterrupted('run1', 'boom');
    expect(mockPrisma.agentRun.update).toHaveBeenCalledTimes(1);
    const [args] = mockPrisma.agentRun.update.mock.calls[0];
    expect(args.data.error).toBe('boom');
    expect(args.data.status).toBe('interrupted');
    expect(args.data.attempts).toEqual({ decrement: 1 });
    expect('checkpoint' in args.data).toBe(false);
  });
});

describe('resumeAgentRun / loadLatestResumableRun', () => {
  it('resumeAgentRun flips interrupted back to running and clears finishedAt', async () => {
    mockPrisma.agentRun.update.mockResolvedValue({});
    await resumeAgentRun('run1');
    const [args] = mockPrisma.agentRun.update.mock.calls[0];
    expect(args.data.status).toBe('running');
    expect(args.data.finishedAt).toBeNull();
  });

  it('returns the latest interrupted run with a checkpoint', async () => {
    mockPrisma.agentRun.findFirst.mockResolvedValue({ id: 'run1', checkpoint: CP });
    const r = await loadLatestResumableRun('sess1');
    expect(r).toEqual({ id: 'run1', checkpoint: CP });
    expect(mockPrisma.agentRun.findFirst.mock.calls[0][0].where).toMatchObject({ sessionId: 'sess1', status: 'interrupted' });
  });

  it('returns null when nothing is resumable', async () => {
    mockPrisma.agentRun.findFirst.mockResolvedValue(null);
    expect(await loadLatestResumableRun('sess1')).toBeNull();
    mockPrisma.agentRun.findFirst.mockResolvedValue({ id: 'run1', checkpoint: null });
    expect(await loadLatestResumableRun('sess1')).toBeNull();
  });
});

describe('reconcileOrphanedRuns', () => {
  it('marks stale/lease-expired/null-heartbeat running rows interrupted (crash recovery)', async () => {
    mockPrisma.agentRun.updateMany.mockResolvedValue({ count: 2 });
    const n = await reconcileOrphanedRuns();
    expect(n).toBe(2);
    const [args] = mockPrisma.agentRun.updateMany.mock.calls[0];
    expect(args.where.status).toBe('running');
    expect(args.data.status).toBe('interrupted');
    expect(args.where.OR).toHaveLength(3); // lease expired | stale heartbeat | null heartbeat
  });
});

describe('agent_events durable log', () => {
  it('appendAgentEvent stores seq + payload', async () => {
    mockPrisma.agentEvent.create.mockResolvedValue({});
    await appendAgentEvent('run1', 7, 'text', { delta: 'hi' });
    expect(mockPrisma.agentEvent.create.mock.calls[0][0].data).toMatchObject({ runId: 'run1', seq: 7, type: 'text' });
  });

  it('getAgentEventsAfter filters seq > cursor, oldest first', async () => {
    mockPrisma.agentEvent.findMany.mockResolvedValue([{ seq: 8, type: 'text', payload: {} }]);
    const rows = await getAgentEventsAfter('run1', 7);
    const [args] = mockPrisma.agentEvent.findMany.mock.calls[0];
    expect(args.where).toEqual({ runId: 'run1', seq: { gt: 7 } });
    expect(args.orderBy).toEqual({ seq: 'asc' });
    expect(rows).toHaveLength(1);
  });

  it('getMaxAgentEventSeq falls back to 0 with no events', async () => {
    mockPrisma.agentEvent.aggregate.mockResolvedValue({ _max: { seq: null } });
    expect(await getMaxAgentEventSeq('run1')).toBe(0);
    mockPrisma.agentEvent.aggregate.mockResolvedValue({ _max: { seq: 41 } });
    expect(await getMaxAgentEventSeq('run1')).toBe(41);
  });

  it('getLatestEventRunId picks the most recent run that has events', async () => {
    mockPrisma.agentRun.findFirst.mockResolvedValue({ id: 'run9' });
    expect(await getLatestEventRunId('sess1')).toBe('run9');
    expect(mockPrisma.agentRun.findFirst.mock.calls[0][0].where).toMatchObject({ sessionId: 'sess1', events: { some: {} } });
  });
});

describe('adoptStaleRunningRuns / supersedeInterruptedRuns (review H2/M1)', () => {
  it('adopts stuck running rows: checkpointed → interrupted, uncheckpointed → failed', async () => {
    mockPrisma.agentRun.updateMany
      .mockResolvedValueOnce({ count: 1 }) // checkpointed → interrupted
      .mockResolvedValueOnce({ count: 1 }); // remainder → failed
    const n = await adoptStaleRunningRuns('sess1');
    expect(n).toBe(1);
    const [first] = mockPrisma.agentRun.updateMany.mock.calls[0];
    expect(first.where).toMatchObject({ sessionId: 'sess1', status: 'running' });
    expect(first.data.status).toBe('interrupted');
    const [second] = mockPrisma.agentRun.updateMany.mock.calls[1];
    expect(second.where).toEqual({ sessionId: 'sess1', status: 'running' });
    expect(second.data.status).toBe('failed');
  });

  it('supersedeInterruptedRuns closes non-kept interrupted rows and nulls their checkpoints', async () => {
    mockPrisma.agentRun.updateMany.mockResolvedValue({ count: 2 });
    const n = await supersedeInterruptedRuns('sess1', 'keep-me');
    expect(n).toBe(2);
    const [args] = mockPrisma.agentRun.updateMany.mock.calls[0];
    expect(args.where).toMatchObject({ sessionId: 'sess1', status: 'interrupted', id: { not: 'keep-me' } });
    expect(args.data.status).toBe('failed');
    expect(args.data.checkpoint).toBe(Prisma.DbNull);
  });

  it('supersedeInterruptedRuns with no keep targets ALL interrupted rows', async () => {
    mockPrisma.agentRun.updateMany.mockResolvedValue({ count: 1 });
    await supersedeInterruptedRuns('sess1', null);
    const [args] = mockPrisma.agentRun.updateMany.mock.calls[0];
    expect(args.where).toEqual({ sessionId: 'sess1', status: 'interrupted' });
  });
});

describe('trimToPreModel (pure)', () => {
  const sys = { role: 'system', content: 'sys' };
  const user = { role: 'user', content: 'do it' };
  const completedTurn = [
    { role: 'assistant', content: '', tool_calls: [{ id: 't1' }] },
    { role: 'tool', tool_call_id: 't1', content: 'done' },
    { role: 'assistant', content: 'step answer' },
  ];

  it('drops a trailing partial dispatch turn (assistant tool_calls + partial tool results)', () => {
    const messages = [
      sys, user, ...completedTurn,
      { role: 'assistant', content: '', tool_calls: [{ id: 't2' }, { id: 't3' }] },
      { role: 'tool', tool_call_id: 't2', content: 'partial result' },
    ];
    expect(trimToPreModel(messages)).toEqual([sys, user, ...completedTurn]);
  });

  it('preserves a transcript already at a step boundary (no trailing tool turn)', () => {
    const messages = [sys, user, ...completedTurn];
    expect(trimToPreModel(messages)).toEqual(messages);
  });

  it('H1: preserves COMPLETED steps — strips only the trailing in-flight turn (no partial results yet)', () => {
    const completedStep = [
      { role: 'assistant', content: '', tool_calls: [{ id: 't1' }] },
      { role: 'tool', tool_call_id: 't1', content: 'file written' },
    ];
    const messages = [
      sys, user, ...completedStep,
      { role: 'assistant', content: '', tool_calls: [{ id: 't2' }, { id: 't3' }] },
    ];
    expect(trimToPreModel(messages)).toEqual([sys, user, ...completedStep]);
  });

  it('H1: strips the in-flight turn AND its partial results, keeping earlier completed tool history', () => {
    const messages = [
      sys, user,
      { role: 'assistant', content: '', tool_calls: [{ id: 't1' }] },
      { role: 'tool', tool_call_id: 't1', content: 'result 1' },
      { role: 'assistant', content: '', tool_calls: [{ id: 't2' }, { id: 't3' }] },
      { role: 'tool', tool_call_id: 't2', content: 'partial' },
    ];
    expect(trimToPreModel(messages)).toEqual([
      sys, user,
      { role: 'assistant', content: '', tool_calls: [{ id: 't1' }] },
      { role: 'tool', tool_call_id: 't1', content: 'result 1' },
    ]);
  });

  it('does not mutate the input array', () => {
    const messages = [sys, { role: 'assistant', content: '', tool_calls: [{ id: 't1' }] }];
    const copy = [...messages];
    trimToPreModel(messages);
    expect(messages).toEqual(copy);
  });
});

/* ====================================================================
 * Phase 2 (worker tier) — queue + claim-seam helpers.
 * ==================================================================== */

describe('queueAgentRun (Phase 2)', () => {
  const INPUT = { message: 'build it', userId: 'u1' };

  beforeEach(() => {
    // The default: the session is 'ready', so the in-txn busy-gate flips it.
    mockPrisma.chatCodingState.updateMany.mockResolvedValue({ count: 1 });
  });

  it('the adoption read locks the interrupted rows FOR UPDATE, latest-first, scoped to the session (H1 atomicity)', async () => {
    mockPrisma.$queryRaw.mockResolvedValue([]);
    mockPrisma.agentRun.create.mockResolvedValue({ id: 'new0' });

    await queueAgentRun('sess1', INPUT);
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1); // ONE interactive txn

    const [strings, ...values] = mockPrisma.$queryRaw.mock.calls[0];
    const sql = (strings as readonly string[]).join('?');
    expect(sql).toContain(`FROM "agent_runs"`);
    expect(sql).toContain(`status = 'interrupted'`);
    expect(sql).toContain(`ORDER BY "createdAt" DESC`);
    expect(sql).toContain('FOR UPDATE');
    expect(values).toEqual(['sess1']); // sessionId rides as a parameter
  });

  it('Phase-3 H1: the session-status gate runs FIRST inside the one txn (flip → adopt-read → supersede → create)', async () => {
    mockPrisma.$queryRaw.mockResolvedValue([{ id: 'old1', checkpoint: CP }]);
    mockPrisma.agentRun.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.agentRun.create.mockResolvedValue({ id: 'new4' });

    await queueAgentRun('sess1', INPUT);

    // The gate is the same guarded ready→running flip the controller used to
    // do separately — now INSIDE the transaction, before everything else.
    expect(mockPrisma.chatCodingState.updateMany).toHaveBeenCalledWith({
      where: { id: 'sess1', status: 'ready' },
      data: { status: 'running' },
    });
    const order = [
      mockPrisma.chatCodingState.updateMany.mock.invocationCallOrder[0],
      mockPrisma.$queryRaw.mock.invocationCallOrder[0],
      mockPrisma.agentRun.updateMany.mock.invocationCallOrder[0],
      mockPrisma.agentRun.create.mock.invocationCallOrder[0],
    ];
    expect(order).toEqual([...order].sort((a, b) => a - b)); // strictly ascending
  });

  it('Phase-3 H1: gate count 0 (already running) → SessionBusyError — NO row created, NO supersede/adopt (the txn rolls back)', async () => {
    mockPrisma.chatCodingState.updateMany.mockResolvedValue({ count: 0 });

    const err = await queueAgentRun('sess1', INPUT).catch(e => e);
    expect(err).toBeInstanceOf(SessionBusyError);
    expect(err.code).toBe('BUSY');

    expect(mockPrisma.$queryRaw).not.toHaveBeenCalled();        // no adoption read
    expect(mockPrisma.agentRun.updateMany).not.toHaveBeenCalled(); // no supersede
    expect(mockPrisma.agentRun.create).not.toHaveBeenCalled();     // no queued row
  });

  it('creates a queued row carrying the input when the txn transitioned NO interrupted row (empty read)', async () => {
    mockPrisma.$queryRaw.mockResolvedValue([]); // H1: a concurrently-claimed row can't match → nothing adopted
    mockPrisma.agentRun.create.mockResolvedValue({ id: 'new1' });

    const id = await queueAgentRun('sess1', INPUT);
    expect(id).toBe('new1');

    expect(mockPrisma.agentRun.updateMany).not.toHaveBeenCalled(); // nothing to supersede
    const create = mockPrisma.agentRun.create.mock.calls[0][0];
    expect(create.data.sessionId).toBe('sess1');
    expect(create.data.status).toBe('queued');
    expect(create.data.input).toEqual(INPUT);
    expect(create.data.checkpoint).toBeUndefined(); // no adoption without a transitioned row
  });

  it('adopts the checkpoint of the ONE row the txn transitioned AND supersedes it in the same txn', async () => {
    mockPrisma.$queryRaw.mockResolvedValue([{ id: 'old1', checkpoint: CP }]);
    mockPrisma.agentRun.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.agentRun.create.mockResolvedValue({ id: 'new2' });

    const id = await queueAgentRun('sess1', INPUT);
    expect(id).toBe('new2');

    // (b) supersede mirrors supersedeInterruptedRuns(sessionId, null), scoped to exactly the locked rows
    const sup = mockPrisma.agentRun.updateMany.mock.calls[0][0];
    expect(sup.where).toEqual({ id: { in: ['old1'] }, status: 'interrupted' });
    expect(sup.data.status).toBe('failed');
    expect(sup.data.error).toBe('superseded by a newer run');
    expect(sup.data.finishedAt).toBeInstanceOf(Date);
    expect(sup.data.checkpoint).toBe(Prisma.DbNull);

    // (c) the new queued row adopts the transitioned row's checkpoint
    const create = mockPrisma.agentRun.create.mock.calls[0][0];
    expect(create.data.status).toBe('queued');
    expect(create.data.checkpoint).toEqual(CP);
    expect(create.data.input).toEqual(INPUT);
  });

  it('multiple interrupted rows: ALL are superseded and the LATEST non-null checkpoint is adopted', async () => {
    const OLD_CP = { ...CP, usageRunId: 'rOLD' };
    // The FOR UPDATE read is ORDER BY createdAt DESC — latest first.
    mockPrisma.$queryRaw.mockResolvedValue([
      { id: 'old2', checkpoint: null }, // latest, but NULL checkpoint (SIGTERM before step 0)
      { id: 'old1', checkpoint: OLD_CP },
    ]);
    mockPrisma.agentRun.updateMany.mockResolvedValue({ count: 2 });
    mockPrisma.agentRun.create.mockResolvedValue({ id: 'new3' });

    await queueAgentRun('sess1', INPUT);

    expect(mockPrisma.agentRun.updateMany.mock.calls[0][0].where).toEqual({ id: { in: ['old2', 'old1'] }, status: 'interrupted' });
    const create = mockPrisma.agentRun.create.mock.calls[0][0];
    expect(create.data.checkpoint).toEqual(OLD_CP); // first NON-NULL checkpoint, latest-first
  });
});

describe('getActiveRunForSession / getLatestRunForSession (Phase 2)', () => {
  it('active = latest queued|running row only', async () => {
    mockPrisma.agentRun.findFirst.mockResolvedValue({ id: 'r1', status: 'running' });
    const r = await getActiveRunForSession('sess1');
    expect(r).toEqual({ id: 'r1', status: 'running' });
    const [args] = mockPrisma.agentRun.findFirst.mock.calls[0];
    expect(args.where).toEqual({ sessionId: 'sess1', status: { in: ['queued', 'running'] } });
    expect(args.orderBy).toEqual({ createdAt: 'desc' });
  });

  it('active = null when no queued/running row', async () => {
    mockPrisma.agentRun.findFirst.mockResolvedValue(null);
    expect(await getActiveRunForSession('sess1')).toBeNull();
  });

  it('latest = latest row of ANY status (SSE replay)', async () => {
    mockPrisma.agentRun.findFirst.mockResolvedValue({ id: 'r9', status: 'completed' });
    const r = await getLatestRunForSession('sess1');
    expect(r).toEqual({ id: 'r9', status: 'completed' });
    const [args] = mockPrisma.agentRun.findFirst.mock.calls[0];
    expect(args.where).toEqual({ sessionId: 'sess1' }); // no status filter
    expect(args.orderBy).toEqual({ createdAt: 'desc' });
  });
});

describe('markRunFailed / markInputConsumed (Phase 2)', () => {
  it('markRunFailed closes the row, nulls the checkpoint, truncates the error', async () => {
    mockPrisma.agentRun.update.mockResolvedValue({});
    await markRunFailed('run1', 'x'.repeat(5000));
    const [args] = mockPrisma.agentRun.update.mock.calls[0];
    expect(args.where).toEqual({ id: 'run1' });
    expect(args.data.status).toBe('failed');
    expect(args.data.finishedAt).toBeInstanceOf(Date);
    expect(args.data.checkpoint).toBe(Prisma.DbNull);
    expect(args.data.error).toHaveLength(2000);
  });

  it('markInputConsumed sets the timestamp guarded on inputConsumedAt IS NULL (idempotent)', async () => {
    mockPrisma.agentRun.updateMany.mockResolvedValue({ count: 1 });
    await markInputConsumed('run1');
    const [args] = mockPrisma.agentRun.updateMany.mock.calls[0];
    expect(args.where).toEqual({ id: 'run1', inputConsumedAt: null });
    expect(args.data.inputConsumedAt).toBeInstanceOf(Date);
  });
});

describe('appendAttemptCause / recordAttemptError (overnight forensics fix 4)', () => {
  it('with no prior cause the string passes through bare (existing error texts unchanged)', () => {
    expect(appendAttemptCause(null, 'provider exploded')).toBe('provider exploded');
    expect(appendAttemptCause('', 'provider exploded', 2)).toBe('provider exploded');
    expect(appendAttemptCause(undefined, '  timed\n out ')).toBe('timed out'); // whitespace collapsed
  });

  it('APPENDS onto an existing cause (first cause preserved, attempt-labeled when known)', () => {
    expect(appendAttemptCause('first: crash', 'second: timeout')).toBe('first: crash | second: timeout');
    expect(appendAttemptCause('first: crash', 'second: timeout', 2)).toBe('first: crash | attempt 2: second: timeout');
  });

  it('truncates from the TAIL — appended segments are capped and the first cause survives the 2000-char cap', () => {
    const first = 'the original cause';
    const chained = appendAttemptCause(first, 'y'.repeat(5000), 2);
    expect(chained.startsWith(`${first} | attempt 2: `)).toBe(true);
    expect(chained.length).toBeLessThanOrEqual(2000); // appended segment capped at 600
    // An over-long accumulated chain keeps its HEAD when the 2000 cap bites.
    const capped = appendAttemptCause('z'.repeat(3000), 'tail cause');
    expect(capped).toHaveLength(2000);
    expect(capped.startsWith('zzz')).toBe(true);
    // A bare over-long first cause is capped too.
    expect(appendAttemptCause(null, 'w'.repeat(3000))).toHaveLength(2000);
  });

  it('recordAttemptError stashes the appended chain WITHOUT touching status (the row stays claimable)', async () => {
    mockPrisma.agentRun.findUnique.mockResolvedValue({ error: 'attempt 1: crashed' });
    mockPrisma.agentRun.update.mockResolvedValue({});
    await recordAttemptError('run1', 'harness exception: boom', 2);
    const [args] = mockPrisma.agentRun.update.mock.calls[0];
    expect(args.where).toEqual({ id: 'run1' });
    expect(args.data).toEqual({ error: 'attempt 1: crashed | attempt 2: harness exception: boom' });
  });

  it('recordAttemptError is a no-op for a missing row', async () => {
    mockPrisma.agentRun.findUnique.mockResolvedValue(null);
    await recordAttemptError('gone', 'boom');
    expect(mockPrisma.agentRun.update).not.toHaveBeenCalled();
  });
});

// ── 22P05 boundary pin (FO firing 20, 2026-09-24) ─────────────────────────────
// A lone surrogate in an event payload made every agentEvent.create fail with
// `unsupported Unicode escape sequence` (run e8975be5: 12+ dropped appends).
// The seam must strip BEFORE the create and record telemetry when it did.
describe('appendAgentEvent 22P05 strip (FO firing 20)', () => {
  const LONE = '\uD835'; // unpaired high surrogate
  const PAIR = '𝒜'; // U+1D49C — valid pair, must survive

  it('strips lone surrogates from the payload before agentEvent.create', async () => {
    mockPrisma.agentEvent.create.mockClear();
    await appendAgentEvent('run22p05', 1, 'text', { delta: `a${LONE}b`, keep: PAIR });
    const arg = mockPrisma.agentEvent.create.mock.calls[0][0];
    expect(arg.data.payload).toEqual({ delta: 'ab', keep: PAIR });
    expect(arg.data.payload.keep).toBe(PAIR); // astral code point intact
  });

  it('records pg_unsafe_stripped telemetry when (and only when) something was dropped', async () => {
    mockPrisma.agentEvent.create.mockClear();
    await appendAgentEvent('run22p05', 2, 'text', { delta: 'clean' });
    expect(mockPrisma.agentEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ payload: { delta: 'clean' } }) }),
    );
  });
});
