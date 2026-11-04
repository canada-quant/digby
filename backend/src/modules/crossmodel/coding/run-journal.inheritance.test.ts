/**
 * Sub-session promotion (2026-09-02, piece 4) — buildParentContextBlock unit
 * tests: the spawn-time READ helper that distills the parent chat's newest
 * run-journal entries into the [PARENT SESSION CONTEXT] block prepended to a
 * child session's first prompt.
 *
 * Pins: newest-first content, decisions/failures lines, the ~1,500-char cap
 * (oldest entries drop WHOLE; an oversized newest entry hard-trims), '' on an
 * empty journal, and read-failure degradation to '' (never a throw).
 *
 * Scaffolding mirrors run-journal.service.test.ts (do not modify that file).
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockCreate: jest.Mock = jest.fn(async () => ({}));
const mockFindMany: jest.Mock = jest.fn(async () => []);
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: { runJournalEntry: { create: (...a: any[]) => mockCreate(...a), findMany: (...a: any[]) => mockFindMany(...a) } },
}));

jest.mock('../../../utils/utility-llm', () => ({
  __esModule: true,
  utilityChat: jest.fn(async () => ''),
}));

import {
  buildParentContextBlock, PARENT_CONTEXT_ENTRIES_N, PARENT_CONTEXT_BLOCK_CAP, RunJournalEntryShape,
} from './run-journal.service';

const entry = (over: Partial<RunJournalEntryShape> = {}): RunJournalEntryShape => ({
  id: 'j1', runId: 'r1', triggerKind: 'user',
  goal: 'Fix the reaper', outcome: 'Shipped the fix and its tests.',
  keyDecisions: [], failures: [], observations: null, tokensUsed: null,
  createdAt: new Date('2026-09-01T10:00:00Z'),
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockFindMany.mockResolvedValue([]);
});

describe('buildParentContextBlock', () => {
  it('builds the header + one compact line per entry (goal → outcome, newest first)', async () => {
    mockFindMany.mockResolvedValue([
      entry({ id: 'j2', goal: 'Newest goal', outcome: 'Newest outcome', createdAt: new Date('2026-09-02T09:00:00Z') }),
      entry({ id: 'j1', goal: 'Older goal', outcome: 'Older outcome', keyDecisions: ['kept the soft ref'], failures: ['flaky test'] }),
    ]);
    const block = await buildParentContextBlock('parent-1');
    expect(block.startsWith('[PARENT SESSION CONTEXT')).toBe(true);
    expect(block).toContain('- 2026-09-02: Newest goal → Newest outcome');
    expect(block).toContain('- 2026-09-01: Older goal → Older outcome');
    expect(block).toContain('Decisions: kept the soft ref');
    expect(block).toContain('Failures: flaky test');
    expect(block.indexOf('Newest goal')).toBeLessThan(block.indexOf('Older goal'));
    // The default read asks for exactly N entries of the PARENT chat.
    expect(mockFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { chatId: 'parent-1' },
      orderBy: { createdAt: 'desc' },
      take: PARENT_CONTEXT_ENTRIES_N,
    }));
  });

  it("returns '' when the parent has no journal", async () => {
    mockFindMany.mockResolvedValue([]);
    await expect(buildParentContextBlock('parent-1')).resolves.toBe('');
  });

  it("returns '' when the journal read fails (never throws into the spawn path)", async () => {
    mockFindMany.mockRejectedValue(new Error('db down'));
    await expect(buildParentContextBlock('parent-1')).resolves.toBe('');
  });

  it('caps the whole block at PARENT_CONTEXT_BLOCK_CAP by dropping OLDEST entries whole', async () => {
    const big = (i: number) => entry({
      id: `j${i}`,
      goal: `Goal ${i} ${'g'.repeat(300)}`,
      outcome: `Outcome ${i} ${'o'.repeat(400)}`,
      createdAt: new Date(Date.UTC(2026, 8, 2, 12 - i)),
    });
    mockFindMany.mockResolvedValue([big(1), big(2), big(3), big(4)]); // newest first
    const block = await buildParentContextBlock('parent-1');
    expect(block.length).toBeLessThanOrEqual(PARENT_CONTEXT_BLOCK_CAP);
    expect(block).toContain('Goal 1'); // the newest entry always survives
    expect(block).not.toContain('Goal 4'); // the oldest dropped whole
  });

  it('hard-trims a single OVERSIZED newest entry so the block never exceeds the cap', async () => {
    mockFindMany.mockResolvedValue([
      entry({ goal: 'G'.repeat(500), outcome: 'O'.repeat(1000), keyDecisions: ['d'.repeat(200)], failures: ['f'.repeat(300)] }),
    ]);
    const block = await buildParentContextBlock('parent-1');
    expect(block.length).toBeLessThanOrEqual(PARENT_CONTEXT_BLOCK_CAP);
    expect(block.endsWith('…')).toBe(true);
    expect(block.startsWith('[PARENT SESSION CONTEXT')).toBe(true);
  });

  it('honors a caller-supplied entry count and cap', async () => {
    mockFindMany.mockResolvedValue([entry()]);
    const block = await buildParentContextBlock('parent-1', 2, 200);
    expect(mockFindMany).toHaveBeenCalledWith(expect.objectContaining({ take: 2 }));
    expect(block.length).toBeLessThanOrEqual(200);
  });
});
