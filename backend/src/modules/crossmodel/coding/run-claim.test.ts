/**
 * Durability Phase 2 — run claiming: the pure row-shape classifier and the
 * SKIP LOCKED claim transaction (empty queue, successful claim, requeue).
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockPrisma: any = {
  agentRun: {
    update: jest.fn(),
  },
  $queryRaw: jest.fn(),
  $transaction: jest.fn(async (arg: any) => (typeof arg === 'function' ? arg(mockPrisma) : Promise.all(arg))),
};

jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

import {
  ATTEMPTS_CAP, LEASE_MS, RunCheckpoint,
} from './run-state';
import { claimNextRun, classifyClaim, requeueRun, REQUEUE_BACKOFF_MS, workerGenerationOf } from './run-claim';
import logger from '../../../utils/logger';

const mockLoggerWarn = logger.warn as jest.Mock;

const CP: RunCheckpoint = {
  version: 1,
  messages: [{ role: 'system', content: 'sys' }],
  step: 1, stepBudget: 200, phase: 'preModel',
  compactionCount: 0, modelErrored: false, modelErrorRecoveries: 0, repetitionRetries: 0,
  leakRetries: 0, autoContinueRounds: 0, autoVerifyIters: 0, lastPlanSig: '',
  lastContinueDiffHash: '', continueStalls: 0, selfAudited: false, lastToolSig: '',
  repeatCount: 0, runStartedAt: 1700000000000, deadlineOffsetMs: 0,
  recentDiffHashes: [], failureSigCounts: {}, usageRunId: 'rABC',
};

beforeEach(() => jest.clearAllMocks());

describe('classifyClaim (pure, exhaustive)', () => {
  it('queued + checkpoint → resume (adopted at queue time)', () => {
    expect(classifyClaim({ preStatus: 'queued', checkpoint: CP, attempts: 1 })).toBe('resume');
  });

  it('agent-decisions prerequisite 6 (2026-09-27): a trimmed TERMINAL summary (no transcript) is never a resumable checkpoint — every status reads it as "no checkpoint"', () => {
    const terminal = { version: 1, terminal: true, status: 'completed', step: 9, stepBudget: 200, autoContinueRounds: 1, continueStalls: 0, planSteps: ['1:completed'] };
    expect(classifyClaim({ preStatus: 'queued', checkpoint: terminal, attempts: 1 })).toBe('fresh');
    expect(classifyClaim({ preStatus: 'interrupted', checkpoint: terminal, input: { message: 'go', userId: 'u1' }, attempts: 1 })).toBe('fresh');
    expect(classifyClaim({ preStatus: 'interrupted', checkpoint: terminal, attempts: 1 })).toBe('fail');
    expect(classifyClaim({ preStatus: 'running', checkpoint: { ...CP, messages: undefined }, input: null, attempts: 1 })).toBe('fail'); // a transcript-less shape
    expect(classifyClaim({ preStatus: 'running', checkpoint: { ...CP, terminal: true }, input: { message: 'go', userId: 'u1' }, attempts: 1 })).toBe('fresh');
  });

  it('queued without checkpoint → fresh', () => {
    expect(classifyClaim({ preStatus: 'queued', checkpoint: null, attempts: 1 })).toBe('fresh');
  });

  it('interrupted + checkpoint → resume', () => {
    expect(classifyClaim({ preStatus: 'interrupted', checkpoint: CP, attempts: 1 })).toBe('resume');
  });

  it('interrupted + NO checkpoint + input → fresh (H2: SIGTERM before the first checkpoint cold-restarts)', () => {
    expect(classifyClaim({ preStatus: 'interrupted', checkpoint: null, input: { message: 'go', userId: 'u1' }, attempts: 1 })).toBe('fresh');
  });

  it('interrupted + NO checkpoint + NO input → fail (H2: nothing to resume or restart — fails → session ready, no brick)', () => {
    expect(classifyClaim({ preStatus: 'interrupted', checkpoint: null, attempts: 1 })).toBe('fail');
    expect(classifyClaim({ preStatus: 'interrupted', checkpoint: null, input: null, attempts: 1 })).toBe('fail');
  });

  it('stale running + checkpoint → resume (crash recovery)', () => {
    expect(classifyClaim({ preStatus: 'running', checkpoint: CP, attempts: 2 })).toBe('resume');
  });

  it('stale running without checkpoint + input → fresh (crashed before the first checkpoint)', () => {
    expect(classifyClaim({ preStatus: 'running', checkpoint: null, input: { message: 'go', userId: 'u1' }, attempts: 2 })).toBe('fresh');
  });

  it('stale running without checkpoint + NO input → fail (H2: same no-input guard as interrupted)', () => {
    expect(classifyClaim({ preStatus: 'running', checkpoint: null, attempts: 2 })).toBe('fail');
    expect(classifyClaim({ preStatus: 'running', checkpoint: null, input: null, attempts: 2 })).toBe('fail');
  });

  it('attempts over the cap → fail REGARDLESS of shape', () => {
    for (const preStatus of ['queued', 'interrupted', 'running']) {
      for (const checkpoint of [CP, null]) {
        expect(classifyClaim({ preStatus, checkpoint, attempts: ATTEMPTS_CAP + 1 })).toBe('fail');
      }
    }
  });

  it('attempts AT the cap still claims (boundary: only ABOVE the cap fails)', () => {
    expect(classifyClaim({ preStatus: 'queued', checkpoint: null, attempts: ATTEMPTS_CAP })).toBe('fresh');
    expect(classifyClaim({ preStatus: 'interrupted', checkpoint: CP, attempts: ATTEMPTS_CAP })).toBe('resume');
  });

  it('unknown status → fail (defensive default)', () => {
    expect(classifyClaim({ preStatus: 'completed', checkpoint: null, attempts: 0 })).toBe('fail');
  });
});

describe('claimNextRun', () => {
  it('the claim SQL carries the H1/H2 predicates: queued not-before gate + UNCONDITIONED interrupted branch', async () => {
    mockPrisma.$queryRaw.mockResolvedValue([]);
    await claimNextRun('worker-1');
    const sql = (mockPrisma.$queryRaw.mock.calls[0][0] as readonly string[]).join('?');
    // queued branch: only rows whose NOT-BEFORE passed (requeue backoff rides leaseExpiresAt)
    expect(sql).toContain(`(status = 'queued' AND ("leaseExpiresAt" IS NULL OR "leaseExpiresAt" < now()))`);
    // interrupted branch: every interrupted row is claimable (no checkpoint condition — H2)
    expect(sql).toContain(`OR status = 'interrupted'`);
    expect(sql).not.toContain(`status = 'interrupted' AND checkpoint IS NOT NULL`);
    // stale-running branch unchanged
    expect(sql).toContain(`(status = 'running' AND "leaseExpiresAt" < now())`);
    expect(sql).toContain('FOR UPDATE SKIP LOCKED');
  });

  it('returns null when no claimable row exists (and does not update)', async () => {
    mockPrisma.$queryRaw.mockResolvedValue([]);
    const r = await claimNextRun('worker-1');
    expect(r).toBeNull();
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
    expect(mockPrisma.agentRun.update).not.toHaveBeenCalled();
  });

  it('claims a row: flips it running with workerId/lease/attempts+1 and preserves preStatus', async () => {
    const before = Date.now();
    mockPrisma.$queryRaw.mockResolvedValue([{
      id: 'run1', sessionId: 'sess1', status: 'queued',
      checkpoint: null, input: { message: 'hi', userId: 'u1' }, inputConsumedAt: null, attempts: 0,
    }]);
    mockPrisma.agentRun.update.mockResolvedValue({
      id: 'run1', sessionId: 'sess1', status: 'running',
      checkpoint: null, input: { message: 'hi', userId: 'u1' }, inputConsumedAt: null, attempts: 1,
    });

    const r = await claimNextRun('worker-1');
    expect(r).toEqual({
      id: 'run1',
      sessionId: 'sess1',
      preStatus: 'queued', // the SELECTed row's status, not the post-update 'running'
      checkpoint: null,
      input: { message: 'hi', userId: 'u1' },
      attempts: 1,
      inputConsumed: false,
      lastError: null,
      startedAt: null, // deadline anchor field (2026-09-09) — null in this mock's post-update row
      createdAt: null, // queue-wait field (todo 89df978b) — null in this mock's raw row
    });

    const [args] = mockPrisma.agentRun.update.mock.calls[0];
    expect(args.where).toEqual({ id: 'run1' });
    expect(args.data.status).toBe('running');
    expect(args.data.workerId).toBe('worker-1');
    expect(args.data.attempts).toEqual({ increment: 1 });
    expect(args.data.heartbeatAt).toBeInstanceOf(Date);
    // A plain queued claim never touches the attempt-cause stash (fix 4).
    expect(args.data).not.toHaveProperty('error');
    const leaseMs = args.data.leaseExpiresAt.getTime() - before;
    expect(leaseMs).toBeGreaterThanOrEqual(LEASE_MS);
    expect(leaseMs).toBeLessThan(LEASE_MS + 60_000);
  });

  it('forensics fix 4: a stale-RUNNING claim stamps the lost attempt as a cause, APPENDED onto the prior stash, and returns the chain as lastError', async () => {
    mockPrisma.$queryRaw.mockResolvedValue([{
      id: 'run3', sessionId: 'sess3', status: 'running',
      checkpoint: CP, input: { message: 'go', userId: 'u1' }, inputConsumedAt: new Date(), attempts: 1,
      error: 'harness exception: boom', finishedAt: null,
    }]);
    mockPrisma.agentRun.update.mockImplementation(async ({ data }: any) => ({
      id: 'run3', sessionId: 'sess3', status: 'running',
      checkpoint: CP, input: { message: 'go', userId: 'u1' }, inputConsumedAt: new Date(), attempts: 2,
      error: data.error,
    }));

    const r = await claimNextRun('worker-1');
    const [args] = mockPrisma.agentRun.update.mock.calls[0];
    // The dead attempt's cause is recorded (attempt number = the pre-increment
    // value), appended after the earlier harness-exception record.
    expect(args.data.error).toBe('harness exception: boom | attempt 1 lost its worker (lease expired with no finalizer — process crash/OOM, hang, or a harness exception)');
    expect(r?.lastError).toBe(args.data.error);
  });

  it('forensics fix 4: a crash-adopted INTERRUPTED row (no finishedAt — no finalizer ever ran) is stamped; a gracefully finalized one is not', async () => {
    // Crash-adopted (reconcile sweep flips running→interrupted without finishedAt).
    mockPrisma.$queryRaw.mockResolvedValueOnce([{
      id: 'run4', sessionId: 'sess4', status: 'interrupted',
      checkpoint: CP, input: { message: 'go', userId: 'u1' }, inputConsumedAt: new Date(), attempts: 1,
      error: null, finishedAt: null,
    }]);
    mockPrisma.agentRun.update.mockResolvedValueOnce({
      id: 'run4', sessionId: 'sess4', status: 'running', checkpoint: CP,
      input: { message: 'go', userId: 'u1' }, inputConsumedAt: new Date(), attempts: 2,
      error: 'attempt 1 lost its worker (lease expired with no finalizer — process crash/OOM, hang, or a harness exception)',
    });
    await claimNextRun('worker-1');
    expect(mockPrisma.agentRun.update.mock.calls[0][0].data.error)
      .toContain('attempt 1 lost its worker');

    // Graceful deploy interrupt (finalizeAgentRunShutdownInterrupted set
    // finishedAt): healthy resume — no crash stamp.
    mockPrisma.$queryRaw.mockResolvedValueOnce([{
      id: 'run5', sessionId: 'sess5', status: 'interrupted',
      checkpoint: CP, input: { message: 'go', userId: 'u1' }, inputConsumedAt: new Date(), attempts: 1,
      error: null, finishedAt: new Date(),
    }]);
    mockPrisma.agentRun.update.mockResolvedValueOnce({
      id: 'run5', sessionId: 'sess5', status: 'running', checkpoint: CP,
      input: { message: 'go', userId: 'u1' }, inputConsumedAt: new Date(), attempts: 2, error: null,
    });
    const r = await claimNextRun('worker-1');
    expect(mockPrisma.agentRun.update.mock.calls[1][0].data).not.toHaveProperty('error');
    expect(r?.lastError).toBeNull();
  });

  it('maps checkpoint + inputConsumed from the claimed row', async () => {
    mockPrisma.$queryRaw.mockResolvedValue([{
      id: 'run2', sessionId: 'sess2', status: 'interrupted',
      checkpoint: CP, input: { message: 'go', userId: 'u2' }, inputConsumedAt: new Date(), attempts: 1,
    }]);
    mockPrisma.agentRun.update.mockResolvedValue({
      id: 'run2', sessionId: 'sess2', status: 'running',
      checkpoint: CP, input: { message: 'go', userId: 'u2' }, inputConsumedAt: new Date(), attempts: 2,
    });

    const r = await claimNextRun('worker-1');
    expect(r?.preStatus).toBe('interrupted');
    expect(r?.checkpoint).toEqual(CP);
    expect(r?.attempts).toBe(2);
    expect(r?.inputConsumed).toBe(true);
  });
});

// ── worker-replacement attempt compensation (feedback d64f6f08) ─────────────
describe('workerGenerationOf (pure)', () => {
  it('parses the hostname segment out of worker-<hostname>-<pid>', () => {
    expect(workerGenerationOf('worker-abc123-1')).toBe('abc123');
    // A hostname containing dashes keeps them all (greedy middle group).
    expect(workerGenerationOf('worker-my-host-42')).toBe('my-host');
  });

  it('returns null for non-conforming / missing worker ids', () => {
    expect(workerGenerationOf('worker-1')).toBeNull(); // no -<pid> segment
    expect(workerGenerationOf('garbage')).toBeNull();
    expect(workerGenerationOf('')).toBeNull();
    expect(workerGenerationOf(null)).toBeNull();
    expect(workerGenerationOf(undefined)).toBeNull();
  });
});

describe('claimNextRun worker-replacement compensation (d64f6f08)', () => {
  it('a stale-running row claimed by a NEW worker generation is attempt-neutral: no increment, compensated stamp', async () => {
    mockPrisma.$queryRaw.mockResolvedValue([{
      id: 'runW1', sessionId: 'sessW1', status: 'running',
      checkpoint: CP, input: { message: 'go', userId: 'u1' }, inputConsumedAt: new Date(), attempts: 1,
      error: null, finishedAt: null, workerId: 'worker-hostA-1',
    }]);
    mockPrisma.agentRun.update.mockImplementation(async ({ data }: any) => ({
      id: 'runW1', sessionId: 'sessW1', status: 'running',
      checkpoint: CP, input: { message: 'go', userId: 'u1' }, inputConsumedAt: new Date(),
      attempts: 1, // NOT incremented — the mock echoes the pre-claim value
      error: data.error ?? null,
    }));

    const r = await claimNextRun('worker-hostB-1');
    const [args] = mockPrisma.agentRun.update.mock.calls[0];
    // Compensated: the attempts key is omitted ENTIRELY (no increment).
    expect(args.data).not.toHaveProperty('attempts');
    expect(args.data.error).toContain('attempt 1 lost its worker to a worker replacement');
    expect(args.data.error).toContain('attempt compensated');
    expect(r?.attempts).toBe(1);
    // …and the swap is warned (run id + both worker ids ride the log line).
    const warnLine = mockLoggerWarn.mock.calls.map(c => String(c[0]))
      .find(m => m.includes('lost its worker to a worker replacement'));
    expect(warnLine).toBeDefined();
    expect(warnLine).toContain('runW1');
    expect(warnLine).toContain('sessW1');
    expect(warnLine).toContain('worker-hostA-1');
    expect(warnLine).toContain('worker-hostB-1');
  });

  it('the SAME worker generation (in-place restart / crash loop) keeps the increment + the existing crash stamp', async () => {
    mockPrisma.$queryRaw.mockResolvedValue([{
      id: 'runW2', sessionId: 'sessW2', status: 'running',
      checkpoint: CP, input: { message: 'go', userId: 'u1' }, inputConsumedAt: new Date(), attempts: 1,
      error: null, finishedAt: null, workerId: 'worker-hostA-1',
    }]);
    mockPrisma.agentRun.update.mockImplementation(async ({ data }: any) => ({
      id: 'runW2', sessionId: 'sessW2', status: 'running',
      checkpoint: CP, input: { message: 'go', userId: 'u1' }, inputConsumedAt: new Date(),
      attempts: 2, error: data.error ?? null,
    }));

    await claimNextRun('worker-hostA-2'); // same generation, different pid
    const [args] = mockPrisma.agentRun.update.mock.calls[0];
    expect(args.data.attempts).toEqual({ increment: 1 });
    expect(args.data.error).toBe('attempt 1 lost its worker (lease expired with no finalizer — process crash/OOM, hang, or a harness exception)');
    expect(mockLoggerWarn).not.toHaveBeenCalled();
  });

  it('a crash-adopted interrupted row (no finishedAt) claimed by a NEW generation is compensated too', async () => {
    mockPrisma.$queryRaw.mockResolvedValue([{
      id: 'runW3', sessionId: 'sessW3', status: 'interrupted',
      checkpoint: CP, input: { message: 'go', userId: 'u1' }, inputConsumedAt: new Date(), attempts: 1,
      error: null, finishedAt: null, workerId: 'worker-hostA-1',
    }]);
    mockPrisma.agentRun.update.mockImplementation(async ({ data }: any) => ({
      id: 'runW3', sessionId: 'sessW3', status: 'running',
      checkpoint: CP, input: { message: 'go', userId: 'u1' }, inputConsumedAt: new Date(),
      attempts: 1, error: data.error ?? null,
    }));

    await claimNextRun('worker-hostB-1');
    const [args] = mockPrisma.agentRun.update.mock.calls[0];
    expect(args.data).not.toHaveProperty('attempts');
    expect(args.data.error).toContain('attempt 1 lost its worker to a worker replacement');
    expect(args.data.error).toContain('attempt compensated');
  });

  it('a gracefully finalized interrupted row (finishedAt set) keeps the increment even across generations — no double compensation', async () => {
    mockPrisma.$queryRaw.mockResolvedValue([{
      id: 'runW4', sessionId: 'sessW4', status: 'interrupted',
      checkpoint: CP, input: { message: 'go', userId: 'u1' }, inputConsumedAt: new Date(), attempts: 1,
      error: null, finishedAt: new Date(), workerId: 'worker-hostA-1',
    }]);
    mockPrisma.agentRun.update.mockResolvedValue({
      id: 'runW4', sessionId: 'sessW4', status: 'running', checkpoint: CP,
      input: { message: 'go', userId: 'u1' }, inputConsumedAt: new Date(), attempts: 2, error: null,
    });

    await claimNextRun('worker-hostB-1');
    const [args] = mockPrisma.agentRun.update.mock.calls[0];
    // Healthy resume of an already-compensated row: workerReplaced must only
    // fire on priorAttemptCrashed shapes.
    expect(args.data.attempts).toEqual({ increment: 1 });
    expect(args.data).not.toHaveProperty('error');
    expect(mockLoggerWarn).not.toHaveBeenCalled();
  });
});

describe('requeueRun', () => {
  it('lock contention is not an attempt: compensates the claim increment + backs off ~15 s (not-before)', async () => {
    mockPrisma.agentRun.update.mockResolvedValue({});
    const before = Date.now();
    await requeueRun('run1');
    const [args] = mockPrisma.agentRun.update.mock.calls[0];
    expect(args.where).toEqual({ id: 'run1' });
    expect(args.data.status).toBe('queued');
    expect(args.data.workerId).toBeNull();
    expect(args.data.heartbeatAt).toBeNull();
    expect(args.data.startedAt).toBeNull(); // loop #8: a parked row must not keep the claim's start stamp
    // H1: compensate the claim-time attempts+1 so spinning behind a held lock
    // can never reach 'attempts exhausted'…
    expect(args.data.attempts).toEqual({ decrement: 1 });
    // …and leaseExpiresAt becomes a NOT-BEFORE ≈ now+15 s (the claim query's
    // queued branch skips the row until then — no 2 s claim-tick spin).
    const backoffMs = args.data.leaseExpiresAt.getTime() - before;
    expect(backoffMs).toBeGreaterThanOrEqual(REQUEUE_BACKOFF_MS);
    expect(backoffMs).toBeLessThan(REQUEUE_BACKOFF_MS + 5_000);
  });

  it('the decrement is UNCONDITIONAL — after a compensated claim it refunds the STRANDED prior-generation charge (transfer semantics, d64f6f08)', async () => {
    // Bounce + lock-contention lifecycle (reviewer B1): genA claims (+1), is
    // deploy-killed with no finalizer (stranded +1), genB's claim is
    // compensated (+0 — the stranded charge transfers to genB's attempt), and
    // genB then hits lock contention. The requeue MUST decrement: it returns
    // the stranded charge, leaving the row attempt-neutral for the whole
    // bounce+contention sequence. Guarding this decrement re-created the
    // exact pre-fix burn the ticket is about.
    mockPrisma.agentRun.update.mockResolvedValue({});
    await requeueRun('run1');
    const [args] = mockPrisma.agentRun.update.mock.calls[0];
    expect(args.data.attempts).toEqual({ decrement: 1 });
  });
});

// ── interactive priority (2026-08-26: user messages starved behind machine runs) ──
describe('interactive claim priority', () => {
  it('the claim query orders user-origin rows before machine-origin rows', async () => {
    mockPrisma.$queryRaw.mockResolvedValue([]);
    await claimNextRun('w1');
    const sql = (mockPrisma.$queryRaw.mock.calls[0][0] as readonly string[]).join('?');
    // The owner-dispatch rank (2026-10-01) travels as the `?` fragment in front of the machine WHEN.
    expect(sql).toMatch(/CASE \?WHEN input->>'origin' IN \('schedule','hook','agent','webhook'\) THEN 1 ELSE 0 END/);
    expect(sql).toMatch(/ORDER BY \(CASE/);
  });

  const fragText = (frag: any): string => String(frag?.sql ?? (Array.isArray(frag?.strings) ? frag.strings.join('') : frag ?? ''));

  // Owner-dispatch (2026-10-01): an agent row stamped ownerDispatch + an owner
  // anchor claims as a USER run (rank 0, reserved last slot allowed).
  const OWNER_DISPATCH_PRED = "(input->>'origin' = 'agent' AND input->>'ownerDispatch' = 'true' AND input->>'userTurnAt' IS NOT NULL)";
  it('owner-dispatch rows rank with user rows (the ORDER BY fragment) and pass the interactiveOnly filter', async () => {
    mockPrisma.$queryRaw.mockResolvedValue([]);
    await claimNextRun('w1', { interactiveOnly: true });
    const rank = fragText(mockPrisma.$queryRaw.mock.calls[0][3]);
    expect(rank).toContain(`WHEN ${OWNER_DISPATCH_PRED} THEN 0`);
    const filter = fragText(mockPrisma.$queryRaw.mock.calls[0][1]);
    expect(filter).toContain(`OR input IS NULL OR ${OWNER_DISPATCH_PRED})`);
    // The plain (non-interactive) claim carries the same rank, no filter.
    mockPrisma.$queryRaw.mockClear();
    await claimNextRun('w1');
    expect(fragText(mockPrisma.$queryRaw.mock.calls[0][1])).toBe('');
    expect(fragText(mockPrisma.$queryRaw.mock.calls[0][3])).toContain(`WHEN ${OWNER_DISPATCH_PRED} THEN 0`);
  });

  it('DURABLE SESSION MUTEX (loop #14): the claim skips a row whose session has ANOTHER run running with a live lease', async () => {
    mockPrisma.$queryRaw.mockResolvedValue([]);
    await claimNextRun('w1');
    // travels as the SECOND Prisma.sql VALUE (after interactiveFilter)
    const mutex = fragText(mockPrisma.$queryRaw.mock.calls[0][2]);
    expect(mutex).toMatch(/AND NOT EXISTS \(/);
    expect(mutex).toMatch(/r2\."sessionId" = "agent_runs"\."sessionId"/);
    expect(mutex).toMatch(/r2\.id <> "agent_runs"\.id/);
    expect(mutex).toMatch(/r2\.status = 'running'/);
    expect(mutex).toMatch(/r2\."leaseExpiresAt" > now\(\)/); // a LAPSED lease (dead run) does not block the session
  });

  it('interactiveOnly restricts the claim to user-origin (or legacy null) rows', async () => {
    mockPrisma.$queryRaw.mockResolvedValue([]);
    await claimNextRun('w1', { interactiveOnly: true });
    // The filter travels as a Prisma.sql VALUE interpolated into the template —
    // inspect the passed fragment, not the raw strings.
    const frag: any = mockPrisma.$queryRaw.mock.calls[0][1];
    const fragSql = String(frag?.sql ?? (Array.isArray(frag?.strings) ? frag.strings.join('') : frag ?? ''));
    expect(fragSql).toMatch(/input->>'origin' = 'user' OR input->>'origin' IS NULL OR input IS NULL/);
  });
});
