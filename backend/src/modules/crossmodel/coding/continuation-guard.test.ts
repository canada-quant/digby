/**
 * STOP MEANS STOP (2026-09-29) — the pure rules and the queued-row cancel of
 * coding/continuation-guard.ts. The run-executor wiring is pinned in
 * run-executor.test.ts ("stop means stop"); the two Stop entry points in
 * coding-stream.controller.test.ts and platform-tools.control-tools.test.ts.
 */
jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() } }));

const mockPrisma: any = {
  crossModelChat: { findUnique: jest.fn() },
  agentRun: { findMany: jest.fn(), updateMany: jest.fn() },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

import {
  continuationSuppressReasonFor, suppressedContinuationNote, isSessionArchived,
  isContinuationInput, cancelQueuedContinuations,
  parseZeroEditStreak, nextZeroEditStreak, zeroMutationSuppressReason,
  zeroMutationSuppressNote, continuationZeroMutationMaxRounds,
  MUTATING_FILE_TOOLS, ZERO_EDIT_STREAK_TOKEN,
} from './continuation-guard';

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.CONTINUATION_ZERO_MUTATION_MAX_ROUNDS;
});

describe('continuationSuppressReasonFor', () => {
  it('a clean machine run end may continue', () => {
    expect(continuationSuppressReasonFor({ shutdownInterrupted: false, cancelled: false, archived: false })).toBeNull();
  });
  it('an explicit stop suppresses', () => {
    expect(continuationSuppressReasonFor({ shutdownInterrupted: false, cancelled: true, archived: false })).toBe('stopped');
  });
  it('a deploy interrupt wins over the cancel flag it also trips', () => {
    expect(continuationSuppressReasonFor({ shutdownInterrupted: true, cancelled: true, archived: true })).toBe('shutdown');
  });
  it('an archived session suppresses', () => {
    expect(continuationSuppressReasonFor({ shutdownInterrupted: false, cancelled: false, archived: true })).toBe('archived');
  });
});

describe('suppressedContinuationNote', () => {
  it('names the stop and how to resume', () => {
    expect(suppressedContinuationNote('stopped')).toMatch(/run was stopped.*Send a message to resume/);
  });
  it('names the archive', () => {
    expect(suppressedContinuationNote('archived')).toBe('No continuation queued — the session is archived.');
  });
  it('writes nothing for a deploy interrupt (that run resumes)', () => {
    expect(suppressedContinuationNote('shutdown')).toBeNull();
  });
  it('MERGE-INTENT-AWAIT (2026-10-20): names the registered condition wake that resumes the run', () => {
    expect(suppressedContinuationNote('awaiting_condition')).toMatch(/waiting on a registered condition wake \(await_condition\).*wakes this chat/);
  });
});

describe('isSessionArchived', () => {
  it('reads archivedAt', async () => {
    mockPrisma.crossModelChat.findUnique.mockResolvedValueOnce({ archivedAt: new Date() });
    expect(await isSessionArchived('s1')).toBe(true);
    mockPrisma.crossModelChat.findUnique.mockResolvedValueOnce({ archivedAt: null });
    expect(await isSessionArchived('s1')).toBe(false);
  });
  it('fails open on a read error', async () => {
    mockPrisma.crossModelChat.findUnique.mockRejectedValueOnce(new Error('db down'));
    expect(await isSessionArchived('s1')).toBe(false);
  });
});

describe('isContinuationInput', () => {
  it('matches the harness marker anywhere in the message', () => {
    expect(isContinuationInput({ message: '[MACHINE-TRIGGERED RUN …] [HARNESS CONTINUATION r2/6] — not typed by the user.' })).toBe(true);
    expect(isContinuationInput({ message: 'build it' })).toBe(false);
    expect(isContinuationInput(null)).toBe(false);
  });
});

describe('zero-mutation streak (ticket 9a76855d)', () => {
  it('parses the streak token from a continuation prompt, 0 when absent/malformed', () => {
    expect(parseZeroEditStreak('[HARNESS CONTINUATION r2/6] [zero-edit streak: 2] — not typed by the user.')).toBe(2);
    expect(parseZeroEditStreak('[HARNESS CONTINUATION r1/6] — not typed by the user.')).toBe(0);
    expect(parseZeroEditStreak('[zero-edit streak: abc]')).toBe(0);
    expect(parseZeroEditStreak(null)).toBe(0);
    expect(parseZeroEditStreak(undefined)).toBe(0);
  });
  it('nextZeroEditStreak: an editing run resets to 0 regardless of origin', () => {
    expect(nextZeroEditStreak(2, 3, 'schedule')).toBe(0);
    expect(nextZeroEditStreak(2, 1, 'user')).toBe(0);
  });
  it('nextZeroEditStreak: a zero-edit MACHINE round increments; a zero-edit USER round is neutral', () => {
    expect(nextZeroEditStreak(2, 0, 'schedule')).toBe(3);
    expect(nextZeroEditStreak(2, 0, 'hook')).toBe(3);
    expect(nextZeroEditStreak(2, 0, 'user')).toBe(2);
  });
  it('zeroMutationSuppressReason trips at the threshold', () => {
    expect(zeroMutationSuppressReason(2)).toBeNull();
    expect(zeroMutationSuppressReason(3)).toBe('zero_mutation_streak');
    process.env.CONTINUATION_ZERO_MUTATION_MAX_ROUNDS = '5';
    expect(zeroMutationSuppressReason(4)).toBeNull();
    expect(zeroMutationSuppressReason(5)).toBe('zero_mutation_streak');
    delete process.env.CONTINUATION_ZERO_MUTATION_MAX_ROUNDS;
  });
  it('the suppress note names the streak, the rounds and the resume path', () => {
    expect(zeroMutationSuppressNote(3, 4)).toMatch(/last 3 consecutive continuation round\(s\) produced ZERO file edits.*r3\/6.*Send a message/);
  });
  it('MUTATING_FILE_TOOLS covers exactly the three edit tools, and the token round-trips the parser', () => {
    expect([...MUTATING_FILE_TOOLS].sort()).toEqual(['ast_rewrite', 'edit_file', 'write_file']);
    expect(ZERO_EDIT_STREAK_TOKEN).toBe('[zero-edit streak:');
    expect(parseZeroEditStreak(`[HARNESS CONTINUATION r2/6] ${ZERO_EDIT_STREAK_TOKEN} 2] — not typed by the user.`)).toBe(2);
  });
  it('continuationZeroMutationMaxRounds defaults to 3 and honours the env', () => {
    expect(continuationZeroMutationMaxRounds()).toBe(3);
    process.env.CONTINUATION_ZERO_MUTATION_MAX_ROUNDS = '1';
    expect(continuationZeroMutationMaxRounds()).toBe(1);
    process.env.CONTINUATION_ZERO_MUTATION_MAX_ROUNDS = '0';
    expect(continuationZeroMutationMaxRounds()).toBe(3);
    delete process.env.CONTINUATION_ZERO_MUTATION_MAX_ROUNDS;
  });
});

describe('cancelQueuedContinuations', () => {
  it('cancels only QUEUED continuation rows, conditionally on status, and returns their ids', async () => {
    mockPrisma.agentRun.findMany.mockResolvedValueOnce([
      { id: 'c1', input: { message: '[HARNESS CONTINUATION r1/6] resume' } },
      { id: 'u1', input: { message: 'a queued user message' } },
      { id: 'c2', input: { message: 'x [HARNESS CONTINUATION r3/6] y' } },
    ]);
    mockPrisma.agentRun.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });
    const ids = await cancelQueuedContinuations('s1', 'continuation cancelled: the session was stopped');
    expect(mockPrisma.agentRun.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { sessionId: 's1', status: 'queued' } }));
    expect(mockPrisma.agentRun.updateMany).toHaveBeenCalledTimes(2);
    expect(mockPrisma.agentRun.updateMany.mock.calls[0][0]).toMatchObject({ where: { id: 'c1', status: 'queued' }, data: { status: 'cancelled', error: 'continuation cancelled: the session was stopped' } });
    // c2 was claimed a moment earlier (count 0) — left to the cooperative cancel.
    expect(ids).toEqual(['c1']);
  });
  it('does nothing when no continuation is queued', async () => {
    mockPrisma.agentRun.findMany.mockResolvedValueOnce([{ id: 'u1', input: { message: 'hello' } }]);
    expect(await cancelQueuedContinuations('s1', 'why')).toEqual([]);
    expect(mockPrisma.agentRun.updateMany).not.toHaveBeenCalled();
  });
  it('never throws on a DB error', async () => {
    mockPrisma.agentRun.findMany.mockRejectedValueOnce(new Error('db down'));
    expect(await cancelQueuedContinuations('s1', 'why')).toEqual([]);
  });
});
