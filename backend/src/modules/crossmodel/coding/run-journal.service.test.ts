/**
 * Tests for the run journal (cross-run memory): the fire-and-forget writer
 * (distill → insert, with junk/no-op guards), the newest-first reader, and the
 * budgeted [PREVIOUS RUNS IN THIS CHAT] prompt block.
 *
 * Boundary-mocked: prisma (config/database) + the utility LLM are stubs; the
 * REAL service executes. Never import config/env transitively here.
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

const mockUtilityChat: jest.Mock = jest.fn(async () => '');
jest.mock('../../../utils/utility-llm', () => ({
  __esModule: true,
  utilityChat: (...a: any[]) => mockUtilityChat(...a),
}));

import {
  writeRunJournalEntryAsync, getRecentJournalEntries, formatJournalBlock, RunJournalEntryShape, writeGuardVerdictEntryAsync,
  writeSupervisorTurnEntryAsync, buildSupervisorJournalBlock,
  formatSupervisorJournalCompact, isNoopSupervisorJournalRow, supervisorJournalIds, SUPERVISOR_JOURNAL_SCAN_N,
} from './run-journal.service';
import logger from '../../../utils/logger';

/** Flush the writer's fire-and-forget async IIFE (microtask chain only — no timers). */
const flush = () => new Promise((r) => setImmediate(r));

const DISTILLED = {
  goal: 'Add the run journal workstream',
  outcome: 'Shipped the schema, service, and both wire points.',
  keyDecisions: ['runId kept as a soft ref'],
  filesTouched: ['backend/prisma/schema.prisma', 'backend/src/modules/crossmodel/coding/run-journal.service.ts'],
  failures: [],
};

const WRITE_INPUT = {
  chatId: 'c1',
  runId: 'run-1234',
  triggerKind: 'user',
  userMessage: 'Implement the run journal workstream in this repo',
  assistantFinal: 'Done — schema, service, writer + injection wires, tests.',
  toolsUsed: ['edit_file', 'run_command'],
  tokensUsed: 4321,
};

const entry = (over: Partial<RunJournalEntryShape> = {}): RunJournalEntryShape => ({
  id: 'e1',
  runId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  triggerKind: 'user',
  goal: 'Ship the feature',
  outcome: 'Shipped it; all checks green.',
  keyDecisions: [],
  failures: [],
  observations: null,
  tokensUsed: null,
  createdAt: new Date('2026-08-16T14:03:00Z'),
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockUtilityChat.mockResolvedValue(JSON.stringify(DISTILLED));
});

describe('writeRunJournalEntryAsync', () => {
  it('(a) success: distills via the utility model and inserts ONE row with the distilled fields', async () => {
    writeRunJournalEntryAsync(WRITE_INPUT);
    await flush();

    expect(mockUtilityChat).toHaveBeenCalledTimes(1);
    const [messages, opts] = mockUtilityChat.mock.calls[0];
    expect(messages[0].content).toContain('Implement the run journal workstream');
    expect(messages[0].content).toContain('edit_file, run_command');
    expect(opts).toMatchObject({ maxTokens: 500, temperature: 0.2, timeout: 45000 });

    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockCreate).toHaveBeenCalledWith({
      data: {
        chatId: 'c1',
        runId: 'run-1234',
        triggerKind: 'user',
        goal: DISTILLED.goal,
        outcome: DISTILLED.outcome,
        keyDecisions: DISTILLED.keyDecisions,
        filesTouched: DISTILLED.filesTouched,
        failures: [],
        observations: null,
        tokensUsed: 4321,
      },
    });
  });

  it('(b) utilityChat throw: resolves without throwing, inserts nothing, logs a warning', async () => {
    mockUtilityChat.mockRejectedValue(new Error('provider down'));
    expect(() => writeRunJournalEntryAsync(WRITE_INPUT)).not.toThrow();
    await flush();

    expect(mockCreate).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('run-journal'));
  });

  it('(c1) junk input (<20 chars combined): skipped before ever calling the model', async () => {
    writeRunJournalEntryAsync({ ...WRITE_INPUT, userMessage: 'ok', assistantFinal: '' });
    await flush();
    expect(mockUtilityChat).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('(c2) machine-triggered no-op run: not journaled (high-signal policy)', async () => {
    mockUtilityChat.mockResolvedValue(JSON.stringify({
      goal: 'Wake on schedule and check for work', outcome: 'Nothing to do — no changes were needed.',
      keyDecisions: [], filesTouched: [], failures: [],
    }));
    writeRunJournalEntryAsync({
      ...WRITE_INPUT, triggerKind: 'machine', userMessage: '', assistantFinal: 'Scheduled wake: nothing to do this time.',
    });
    await flush();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('(c3) a USER run with a no-op-looking outcome still records (the guard is machine/hook-only)', async () => {
    mockUtilityChat.mockResolvedValue(JSON.stringify({
      goal: 'Check for drift', outcome: 'Nothing to do — no changes were needed.',
      keyDecisions: [], filesTouched: [], failures: [],
    }));
    writeRunJournalEntryAsync(WRITE_INPUT);
    await flush();
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it('(c4) empty distillation (utility model returned "") inserts no row', async () => {
    mockUtilityChat.mockResolvedValue('');
    writeRunJournalEntryAsync(WRITE_INPUT);
    await flush();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('(c5, P6 v1#36) an idle MACHINE run that OBSERVED metrics IS journaled — the observation is the signal', async () => {
    mockUtilityChat.mockResolvedValue(JSON.stringify({
      goal: 'Wake on schedule and check for work', outcome: 'Nothing to do — no changes were needed.',
      keyDecisions: [], filesTouched: [], failures: [],
      observations: 'Queue depth 3, zero stalls; deploy #418 still green.',
    }));
    writeRunJournalEntryAsync({
      ...WRITE_INPUT, triggerKind: 'machine', userMessage: '', assistantFinal: 'Scheduled wake: queue depth 3, zero stalls, nothing to do.',
    });
    await flush();
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockCreate.mock.calls[0][0].data.observations).toBe('Queue depth 3, zero stalls; deploy #418 still green.');
  });

  it('(c6, P6 v1#36) the distill prompt asks for observations, and an idle run WITHOUT any still skips', async () => {
    mockUtilityChat.mockResolvedValue(JSON.stringify({
      goal: 'Wake', outcome: 'Nothing to do.', keyDecisions: [], filesTouched: [], failures: [], observations: '',
    }));
    writeRunJournalEntryAsync({ ...WRITE_INPUT, triggerKind: 'machine', userMessage: '', assistantFinal: 'Scheduled wake: nothing to do at all this time.' });
    await flush();
    expect(String(mockUtilityChat.mock.calls[0][0][0].content)).toContain('"observations"');
    expect(mockCreate).not.toHaveBeenCalled();
  });
});

describe('getRecentJournalEntries', () => {
  it('(d1) queries newest-first with the requested take', async () => {
    await getRecentJournalEntries('c1', 4);
    expect(mockFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { chatId: 'c1' },
      orderBy: { createdAt: 'desc' },
      take: 4,
    }));
  });

  it('(d2) read failure degrades to [] (never throws into prompt assembly)', async () => {
    mockFindMany.mockRejectedValueOnce(new Error('db down'));
    await expect(getRecentJournalEntries('c1')).resolves.toEqual([]);
  });
});

describe('formatJournalBlock', () => {
  it("(e1) empty → ''", () => {
    expect(formatJournalBlock([])).toBe('');
  });

  it('(e2) renders newest-first with runId pointers, decisions, and failures', () => {
    const newer = entry({
      id: 'e2', goal: 'Second run goal', outcome: 'Second outcome', runId: 'bbbbbbbb-0000-0000-0000-000000000000',
      keyDecisions: ['kept the soft ref'], failures: ['jest glob miss'], createdAt: new Date('2026-08-16T15:00:00Z'),
    });
    const older = entry({ id: 'e1', goal: 'First run goal', createdAt: new Date('2026-08-16T14:00:00Z') });
    const out = formatJournalBlock([newer, older]); // getRecentJournalEntries order (newest first)

    expect(out).toContain('[PREVIOUS RUNS IN THIS CHAT');
    expect(out.indexOf('Second run goal')).toBeLessThan(out.indexOf('First run goal'));
    expect(out).toContain('trigger=user');
    expect(out).toContain('run bbbbbbbb'); // runId pointer
    // Full run id, never a truncated prefix (nightly-lane postmortem 2026-08-27:
    // an 8-char citation dead-ended every tool lookup the lane tried).
    expect(out).toContain('run bbbbbbbb-0000-0000-0000-000000000000');
    expect(out).toContain('Decisions: kept the soft ref');
    expect(out).toContain('Failures: jest glob miss');
  });

  it('(e2b, P6 v1#36) renders an Observed: line when the entry carries observations', () => {
    const block = formatJournalBlock([entry({ observations: 'queue depth 3, zero stalls' })]);
    expect(block).toContain('Observed: queue depth 3, zero stalls');
    expect(formatJournalBlock([entry()])).not.toContain('Observed:');
  });

  it('(e4, P6 G4b) machine budget constants pinned (10 rows / 4,000 chars) and the cap param widens the block', () => {
    const { MACHINE_JOURNAL_ENTRIES_N, MACHINE_JOURNAL_BLOCK_CAP, JOURNAL_ENTRIES_N, JOURNAL_BLOCK_CAP } = require('./run-journal.service');
    expect(JOURNAL_ENTRIES_N).toBe(6);
    expect(JOURNAL_BLOCK_CAP).toBe(2400);
    expect(MACHINE_JOURNAL_ENTRIES_N).toBe(10);
    expect(MACHINE_JOURNAL_BLOCK_CAP).toBe(4000);
    // 10 chunky entries: the default cap drops older ones; the machine cap keeps more.
    const entries = Array.from({ length: 10 }, (_, i) => entry({
      id: `e${i}`, goal: `Goal ${i} ${'g'.repeat(180)}`, outcome: `Outcome ${i} ${'o'.repeat(180)}`,
      createdAt: new Date(Date.UTC(2026, 8, 1, 10 - i)),
    }));
    const defaultBlock = formatJournalBlock(entries);
    const machineBlock = formatJournalBlock(entries, MACHINE_JOURNAL_BLOCK_CAP);
    expect(machineBlock.length).toBeGreaterThan(defaultBlock.length);
    expect(machineBlock.length).toBeLessThanOrEqual(MACHINE_JOURNAL_BLOCK_CAP + 200);
  });

  it('(e3) the block is hard-capped: oldest entries drop out whole, never truncated mid-entry', () => {
    // ~700-char outcomes → the 2400-char cap fits the header + ~3 entries.
    const fat = 'x'.repeat(700);
    const entries = [3, 2, 1, 0].map((h) => entry({ // newest-first input
      id: `e${h}`, goal: `goal-${h}`, outcome: `${h}:${fat}`, createdAt: new Date(`2026-08-16T1${h}:00:00Z`),
    }));
    const out = formatJournalBlock(entries);

    expect(out.length).toBeLessThanOrEqual(2400);
    expect(out).toContain('goal-3'); // newest always kept
    expect(out).not.toContain('goal-0'); // oldest dropped…
    expect(out).not.toContain('0:' + fat.slice(0, 40)); // …whole, not mid-entry
  });
});


// ── Deterministic guard-verdict rows (two-lane hardening, 2026-08-22) ────────
describe('writeGuardVerdictEntryAsync', () => {
  const flush = async () => { for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r)); };

  it('writes a harness-owned row with the structured verdict — NO LLM involved', async () => {
    writeGuardVerdictEntryAsync({
      chatId: 'chat-1', runId: 'run-9', triggerKind: 'schedule',
      unprovenKinds: ['pr_merged', 'probe'], fabricatedPrs: [250], refutedMergePrs: [44],
    });
    await flush();
    expect(mockUtilityChat).not.toHaveBeenCalled();
    expect(mockCreate).toHaveBeenCalledTimes(1);
    const row = mockCreate.mock.calls[0][0].data;
    expect(row.chatId).toBe('chat-1');
    expect(row.runId).toBe('run-9');
    expect(row.goal).toContain('HARNESS EVIDENCE GUARD');
    expect(row.goal).toContain('this row cannot');
    expect(row.outcome).toContain('NOT DONE');
    expect(row.failures).toEqual([
      'zero-evidence completion claims: pr_merged, probe',
      'fabricated PR claims (GitHub 404): #250',
      'merge claims refuted by GitHub (PR not merged): #44',
    ]);
  });

  it('an empty verdict writes nothing; a DB failure never throws', async () => {
    writeGuardVerdictEntryAsync({ chatId: 'c', triggerKind: 'hook', unprovenKinds: [], fabricatedPrs: [], refutedMergePrs: [] });
    await flush();
    expect(mockCreate).not.toHaveBeenCalled();

    mockCreate.mockRejectedValueOnce(new Error('db down'));
    writeGuardVerdictEntryAsync({ chatId: 'c', triggerKind: 'hook', unprovenKinds: ['deploy'], fabricatedPrs: [], refutedMergePrs: [] });
    await flush(); // resolves without an unhandled rejection
  });

  it('carries the forgery lane as a failures line (forgedFooter alone still writes)', async () => {
    writeGuardVerdictEntryAsync({
      chatId: 'chat-1', runId: 'run-9', triggerKind: 'machine',
      unprovenKinds: [], fabricatedPrs: [], refutedMergePrs: [], forgedFooter: true,
    });
    await flush();
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockCreate.mock.calls[0][0].data.failures).toEqual([
      "forged harness markers in the final answer — the model imitated the guard's own verification footer/replacement banner",
    ]);
  });

  it('carries guard-4 quoted-output findings as a failures line (fabricatedQuotes ALONE still writes — ticket 7cb26cb0)', async () => {
    writeGuardVerdictEntryAsync({
      chatId: 'chat-1', runId: 'run-9', triggerKind: 'schedule',
      unprovenKinds: [], fabricatedPrs: [], refutedMergePrs: [],
      fabricatedQuotes: ['[34/55] gpqa-100 r0 TRUNC 3719.4s'],
    });
    await flush();
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockCreate.mock.calls[0][0].data.failures).toEqual([
      'quoted "verbatim output" no tool result of the run produced: [34/55] gpqa-100 r0 TRUNC 3719.4s',
    ]);
  });

  it('maximal verdict: failures.slice(0, 4) keeps the guard-4 line (pushed FIRST, review round-8 F3) and drops the last-pushed ones — documented truncation', async () => {
    writeGuardVerdictEntryAsync({
      chatId: 'chat-1', runId: 'run-9', triggerKind: 'schedule',
      unprovenKinds: ['deploy'], fabricatedPrs: [224], refutedMergePrs: [225],
      futureDated: ['12:18:13Z (+5m ahead)'], forgedFooter: true,
      fabricatedShas: ['84fe3ae0deadbeef'], fabricatedQuotes: ['[34/55] gpqa-100 r0 TRUNC 3719.4s'],
    });
    await flush();
    expect(mockCreate).toHaveBeenCalledTimes(1);
    const failures: string[] = mockCreate.mock.calls[0][0].data.failures;
    expect(failures).toHaveLength(4);
    expect(failures[0]).toContain('verbatim output'); // guard-4 exhibits survive the cap
    expect(failures.join(' ')).not.toContain('no such commit on origin'); // fabricatedShas line truncated away
  });

  it('carries guard-5/6 deploy-run + ticket-id findings as failures lines (ticket 8e9d6496)', async () => {
    writeGuardVerdictEntryAsync({
      chatId: 'chat-1', runId: 'run-9', triggerKind: 'schedule',
      unprovenKinds: [], fabricatedPrs: [], refutedMergePrs: [],
      fabricatedDeployRuns: ['33236656591'], refutedDeployRuns: ['33236939738'], fabricatedTicketIds: ['01226f89'],
    });
    await flush();
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockCreate.mock.calls[0][0].data.failures).toEqual([
      'fabricated deploy-run claims (no such GitHub Actions run): 33236656591',
      'deploy-completion claims refuted by GitHub Actions: 33236939738',
      'fabricated feedback-ticket ids (no such ticket): 01226f89',
    ]);
  });

  it('orders the new hard-class lines after refutedMergePrs and before futureDated', async () => {
    writeGuardVerdictEntryAsync({
      chatId: 'c', triggerKind: 'schedule',
      unprovenKinds: [], fabricatedPrs: [], refutedMergePrs: [225], futureDated: ['12:18:13Z (+5m ahead)'],
      fabricatedTicketIds: ['01226f89'],
    });
    await flush();
    expect(mockCreate.mock.calls[0][0].data.failures).toEqual([
      'merge claims refuted by GitHub (PR not merged): #225',
      'fabricated feedback-ticket ids (no such ticket): 01226f89',
      'future-dated observation claims: 12:18:13Z (+5m ahead)',
    ]);
  });

  it('carries claims-block-lane findings as a failures line (unverifiedBlockClaims ALONE still writes — audit #6 rider)', async () => {
    writeGuardVerdictEntryAsync({
      chatId: 'chat-1', runId: 'run-9', triggerKind: 'schedule',
      unprovenKinds: [], fabricatedPrs: [], refutedMergePrs: [],
      unverifiedBlockClaims: ['pr https://github.com/o/r/pull/999', 'push 84fe3ae0'],
    });
    await flush();
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockCreate.mock.calls[0][0].data.failures).toEqual([
      'typed claims-block entries with no matching receipt: pr https://github.com/o/r/pull/999, push 84fe3ae0',
    ]);
  });
});

// ── SUPERVISOR TURN JOURNAL (ticket 9993f30c) ────────────────────────────────
// One deterministic, receipt-backed row per supervisor chat turn (the chat-agent
// finalize calls writeSupervisorTurnEntryAsync) + the supervisor read block.
describe('writeSupervisorTurnEntryAsync (9993f30c)', () => {
  const RECEIPTS = [
    { id: 'a1b2c3d4-1111-2222-3333-444455556666', ok: true, tool: 'send_chat_message', ids: { chatId: 'lane-9' } },
    { id: 'e5f6a7b8-1111-2222-3333-444455556666', ok: true, tool: 'git_push', ids: { sha: '88c3c879', branch: 'digby/session-x' } },
    { id: 'deadbeef-0000-0000-0000-000000000000', ok: false, tool: 'git_push', ids: { sha: 'zzz' } },
  ];

  it('(s1) writes ONE harness row with receipt ids + entity ids — NO LLM involved', async () => {
    writeSupervisorTurnEntryAsync({
      chatId: 'sup-chat-1', triggerKind: 'machine',
      message: '[SCHEDULE] Fleet supervisor sweep — check the board and act',
      finalNote: 'Re-queued one stalled lane; cited the board verbatim.',
      receipts: [
        ...RECEIPTS,
        // The planning tools' minted keys (review MAJOR 88d85d8e): goalId /
        // todoId are the EXACT id class the ticket exists for — a cited todo
        // id must be structurally present in the journal.
        { id: '11223344-1111-2222-3333-444455556666', ok: true, tool: 'todo_update', ids: { todoId: 'todo-9f8e7d6c' } },
        { id: '55667788-1111-2222-3333-444455556666', ok: true, tool: 'goal_premise_set', ids: { goalId: 'goal-1a2b3c4d' } },
      ], toolsUsed: ['list_owner_questions'], tokensUsed: 12345,
    });
    await flush();
    expect(mockUtilityChat).not.toHaveBeenCalled();
    expect(mockCreate).toHaveBeenCalledTimes(1);
    const data = mockCreate.mock.calls[0][0].data;
    expect(data.chatId).toBe('sup-chat-1');
    expect(data.runId).toBeNull(); // chat turns create no agent_runs row
    expect(data.triggerKind).toBe('machine');
    expect(data.goal).toContain('SUPERVISOR TURN');
    expect(data.goal).toContain('Fleet supervisor sweep');
    // ok receipts only (the failed git_push never rides the evidence line);
    // FULL uuids (review M2 — the formatJournalBlock "never a prefix" convention)
    expect(data.keyDecisions[0]).toBe('receipt ids (verified tool calls): a1b2c3d4-1111-2222-3333-444455556666, e5f6a7b8-1111-2222-3333-444455556666, 11223344-1111-2222-3333-444455556666, 55667788-1111-2222-3333-444455556666');
    expect(data.keyDecisions).toHaveLength(2);
    // entity ids named by receipts — INCLUDING goalId/todoId (review MAJOR).
    // MIND-HYGIENE (2026-10-20): they ride keyDecisions beside the receipt
    // ids — never under `failures` (every id read as a failure).
    expect(data.keyDecisions[1]).toBe('entity ids named by receipts (PR/sha/schedule/ticket/goal): lane-9, 88c3c879, digby/session-x, todo-9f8e7d6c, goal-1a2b3c4d');
    expect(data.failures).toEqual([]);
    expect(data.observations).toContain('send_chat_message');
    expect(data.observations).toContain('list_owner_questions');
    expect(data.observations).toContain('12345 tok');
    expect(data.tokensUsed).toBe(12345);
  });

  it('(s2) a failed/empty turn still records — with the failed shape in the outcome', async () => {
    writeSupervisorTurnEntryAsync({
      chatId: 'sup-chat-2', triggerKind: 'hook',
      message: '[HOOK] todo_done wake', finalNote: '',
      receipts: [{ id: 'b2c3d4e5-1111-2222-3333-444455556666', ok: true, tool: 'todo_get', ids: {} }],
      failed: true,
    });
    await flush();
    expect(mockCreate).toHaveBeenCalledTimes(1);
    const data = mockCreate.mock.calls[0][0].data;
    expect(data.outcome).toContain('finalized EMPTY/failed');
    expect(data.outcome).toContain('1 receipt-backed tool call');
  });

  it('(s3) junk guard: no message, no note, no receipts → no row', async () => {
    writeSupervisorTurnEntryAsync({ chatId: 'sup-chat-3', triggerKind: 'machine', message: '', finalNote: '', receipts: [] });
    await flush();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('(s4) kill switch SUPERVISOR_RUN_JOURNAL_DISABLED=1 → no row (checked BEFORE any work)', async () => {
    writeSupervisorTurnEntryAsync({
      chatId: 'sup-chat-4', triggerKind: 'user',
      message: 'owner asked for a fleet status', finalNote: 'Reported.',
      receipts: [], killEnv: { SUPERVISOR_RUN_JOURNAL_DISABLED: '1' },
    });
    await flush();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('(s5) a DB failure never throws into the finalize path', async () => {
    mockCreate.mockRejectedValueOnce(new Error('db down'));
    expect(() => writeSupervisorTurnEntryAsync({
      chatId: 'sup-chat-5', triggerKind: 'machine', message: 'sweep', finalNote: 'note here', receipts: [],
    })).not.toThrow();
    await flush();
    expect((logger as any).warn).toHaveBeenCalled();
  });

  it('(s6) message and note are whitespace-squashed and length-capped (goal 500 / outcome 1000)', async () => {
    writeSupervisorTurnEntryAsync({
      chatId: 'sup-chat-6', triggerKind: 'user',
      message: `owner  status\n\n${'x'.repeat(600)}`, finalNote: `${'y'.repeat(1200)}`, receipts: [],
    });
    await flush();
    const data = mockCreate.mock.calls[0][0].data;
    expect(data.goal.length).toBeLessThanOrEqual(500 + 'SUPERVISOR TURN — '.length);
    expect(data.goal).not.toContain('\n');
    expect(data.outcome.length).toBeLessThanOrEqual(1000);
  });

  it('(s7) SUPERVISOR_JOURNAL_COMPACT_DISABLED=1 restores the legacy row shape (entity ids under failures)', async () => {
    writeSupervisorTurnEntryAsync({
      chatId: 'sup-chat-7', triggerKind: 'machine', message: 'sweep', finalNote: 'acted',
      receipts: [RECEIPTS[0]], killEnv: { SUPERVISOR_JOURNAL_COMPACT_DISABLED: '1' },
    });
    await flush();
    const data = mockCreate.mock.calls[0][0].data;
    expect(data.keyDecisions).toEqual(['receipt ids (verified tool calls): a1b2c3d4-1111-2222-3333-444455556666']);
    expect(data.failures).toEqual(['entity ids named by receipts (PR/sha/schedule/ticket/goal): lane-9']);
  });
});

describe('buildSupervisorJournalBlock (9993f30c) — legacy block under SUPERVISOR_JOURNAL_COMPACT_DISABLED=1', () => {
  beforeEach(() => { process.env.SUPERVISOR_JOURNAL_COMPACT_DISABLED = '1'; });
  afterEach(() => { delete process.env.SUPERVISOR_JOURNAL_COMPACT_DISABLED; });

  it('(r1) empty journal → no block', async () => {
    mockFindMany.mockResolvedValueOnce([]);
    expect(await buildSupervisorJournalBlock('sup-chat-1')).toBe('');
  });

  it('(r2) renders newest-first under its own header, with receipt-id lines', async () => {
    mockFindMany.mockResolvedValueOnce([
      entry({ id: 'e2', triggerKind: 'machine', goal: 'SUPERVISOR TURN — sweep', outcome: 'Acted.', keyDecisions: ['receipt ids (verified tool calls): a1b2c3d4'], createdAt: new Date('2026-10-18T02:00:00Z') }),
      entry({ id: 'e1', triggerKind: 'user', goal: 'SUPERVISOR TURN — owner check-in', outcome: 'Reported.', failures: ['entity ids named by receipts (PR/sha/schedule/ticket/goal): #1508'], createdAt: new Date('2026-10-17T22:00:00Z') }),
    ]);
    const block = await buildSupervisorJournalBlock('sup-chat-2');
    expect(block).toContain('[PREVIOUS SUPERVISOR TURNS IN THIS CHAT');
    expect(block.indexOf('sweep')).toBeLessThan(block.indexOf('owner check-in'));
    expect(block).toContain('receipt ids (verified tool calls): a1b2c3d4');
    expect(block).toContain('entity ids named by receipts');
    expect(block).toContain('trigger=machine');
  });

  it('(r3) asks for the ticket-specified slice: 10 entries', async () => {
    mockFindMany.mockResolvedValueOnce([]);
    await buildSupervisorJournalBlock('sup-chat-3');
    expect(mockFindMany.mock.calls[0][0]).toMatchObject({ where: { chatId: 'sup-chat-3' }, take: 10 });
  });

  it('(r4) the block is hard-capped at 4000: oldest entries drop WHOLE, never truncated mid-entry', async () => {
    // Array order = the reader's newest-first contract (findMany createdAt desc):
    // index 0 is the NEWEST turn, index 39 the oldest.
    const many = Array.from({ length: 40 }, (_, i) => entry({
      id: `e${i}`, goal: `G${i} ${'g'.repeat(400)}`, outcome: `O${i} ${'o'.repeat(400)}`,
      createdAt: new Date(Date.parse('2026-10-18T01:00:00Z') - i * 60_000),
    }));
    mockFindMany.mockResolvedValueOnce(many);
    const block = await buildSupervisorJournalBlock('sup-chat-4', 10, 4000);
    expect(block.length).toBeLessThanOrEqual(4000);
    // the NEWEST entry survived whole
    expect(block).toContain('G0');
    // older entries that did not fit are absent ENTIRELY (no mid-entry cut)
    expect(block).not.toContain('G9');
  });
});

// ── MIND-HYGIENE (2026-10-20): the compact supervisor journal block ──────────
// The 4-line block fit 2–3 of its 10 rows in 4,000 chars and most rows were
// no-op wakes journaled in full. One line per real row; no-op turns fold into
// "+N no-op" on the real row that came after them.
describe('compact supervisor journal (MIND-HYGIENE)', () => {
  const sup = (over: Partial<RunJournalEntryShape>) => entry({ runId: null, triggerKind: 'schedule', ...over });
  const noop = (minute: number) => sup({ id: `n${minute}`, goal: 'SUPERVISOR TURN — [SCHEDULE] stock sweep prompt', outcome: 'SWEEP: no-op — nothing moved since the last sweep.', createdAt: new Date(Date.parse('2026-10-20T00:00:00Z') + minute * 60_000) });

  it('isNoopSupervisorJournalRow: the no-op close with no receipts / ids — never a failed turn, a receipted turn or a harness row', () => {
    expect(isNoopSupervisorJournalRow(noop(1))).toBe(true);
    expect(isNoopSupervisorJournalRow(sup({ goal: 'SUPERVISOR TURN — x', outcome: '(no final note)' }))).toBe(true);
    expect(isNoopSupervisorJournalRow(sup({ goal: 'SUPERVISOR TURN — x', outcome: 'WAKE: no-op', keyDecisions: ['receipt ids (verified tool calls): r1'] }))).toBe(false);
    expect(isNoopSupervisorJournalRow(sup({ goal: 'SUPERVISOR TURN — x', outcome: 'Turn finalized EMPTY/failed (orchestrator produced no answer). 0 receipt-backed tool call(s) still executed.' }))).toBe(false);
    expect(isNoopSupervisorJournalRow(sup({ goal: 'HARNESS EVIDENCE GUARD — verdict', outcome: 'WAKE: no-op' }))).toBe(false);
  });

  it('supervisorJournalIds reads both shapes: compact keyDecisions and legacy failures', () => {
    expect(supervisorJournalIds({ keyDecisions: ['receipt ids (verified tool calls): r1, r2', 'entity ids named by receipts (PR/sha/schedule/ticket/goal): g1, t2'], failures: [] }))
      .toEqual({ receiptIds: ['r1', 'r2'], entityIds: ['g1', 't2'], failures: [] });
    expect(supervisorJournalIds({ keyDecisions: [], failures: ['entity ids named by receipts (PR/sha/schedule/ticket/goal): #1508', 'a real failure'] }))
      .toEqual({ receiptIds: [], entityIds: ['#1508'], failures: ['a real failure'] });
  });

  it('one line per real row, newest first; no-ops fold onto the NEXT real row (chronologically) and a leading line counts the newest ones', () => {
    // newest-first: N(10) N(9) R(8) N(7) N(6) R(5) N(4)
    const rows = [
      noop(10), noop(9),
      sup({ id: 'r8', goal: 'SUPERVISOR TURN — owner asked for status', outcome: 'Answered; dispatched one lane.', keyDecisions: ['receipt ids (verified tool calls): aaaa1111-0000-0000-0000-000000000000', 'entity ids named by receipts (PR/sha/schedule/ticket/goal): lane-9'], observations: 'tools: send_chat_message', createdAt: new Date('2026-10-20T00:08:00Z') }),
      noop(7), noop(6),
      sup({ id: 'r5', goal: 'SUPERVISOR TURN — [HOOK] run_failed', outcome: 'Re-queued the lane.', failures: ['entity ids named by receipts (PR/sha/schedule/ticket/goal): sched-1'], createdAt: new Date('2026-10-20T00:05:00Z') }),
      noop(4),
    ];
    const block = formatSupervisorJournalCompact(rows);
    const lines = block.split('\n');
    expect(lines[0]).toMatch(/^\[PREVIOUS SUPERVISOR TURNS IN THIS CHAT/);
    expect(lines[1]).toBe('- +2 no-op turns since the newest line below (latest 2026-10-20 00:10Z)');
    expect(lines[2]).toMatch(/^- 2026-10-20 00:08Z · schedule · owner asked for status → Answered; dispatched one lane\. · receipts: aaaa1111-0000-0000-0000-000000000000 · ids: lane-9 · tools: send_chat_message · \+2 no-op turns before it$/);
    expect(lines[3]).toMatch(/^- 2026-10-20 00:05Z · schedule · \[HOOK\] run_failed → Re-queued the lane\. · ids: sched-1 · \+1 no-op turn before it$/);
    expect(lines).toHaveLength(4);
    expect(block).not.toContain('stock sweep prompt'); // no-op rows never render in full
    expect(lines.slice(1).join('\n')).not.toContain('SUPERVISOR TURN'); // the redundant goal prefix is stripped
  });

  it('caps at n real rows and the char cap (the newest line always renders; older lines drop whole)', () => {
    const many = Array.from({ length: 30 }, (_, i) => sup({ id: `x${i}`, goal: `SUPERVISOR TURN — G${i} ${'g'.repeat(200)}`, outcome: `O${i} ${'o'.repeat(400)}`, keyDecisions: ['receipt ids (verified tool calls): r1, r2, r3, r4, r5'], createdAt: new Date(Date.parse('2026-10-20T01:00:00Z') - i * 60_000) }));
    const block = formatSupervisorJournalCompact(many, 10, 4000);
    expect(block.length).toBeLessThanOrEqual(4000);
    expect(block).toContain('G0 ');
    expect(block).toContain('receipts: r1, r2, r3 (+2 more)');
    const shown = block.split('\n').length - 1;
    expect(shown).toBeGreaterThanOrEqual(6); // ~420-char lines: 9 fit where the 4-line block fit 2–3
    expect(shown).toBeLessThanOrEqual(10);
    expect(formatSupervisorJournalCompact(many, 3, 100_000).split('\n')).toHaveLength(4);
    expect(formatSupervisorJournalCompact([])).toBe('');
  });

  it('buildSupervisorJournalBlock scans the deeper slice by default and renders the compact block', async () => {
    mockFindMany.mockResolvedValueOnce([noop(2), sup({ goal: 'SUPERVISOR TURN — owner check-in', outcome: 'Reported.', createdAt: new Date('2026-10-20T00:01:00Z') })]);
    const block = await buildSupervisorJournalBlock('sup-chat-c1');
    expect(mockFindMany.mock.calls[0][0]).toMatchObject({ where: { chatId: 'sup-chat-c1' }, take: SUPERVISOR_JOURNAL_SCAN_N });
    expect(block).toContain('+1 no-op turn since the newest line below');
    expect(block).toContain('owner check-in → Reported.');
    expect(block).not.toContain('trigger=');
  });
});
