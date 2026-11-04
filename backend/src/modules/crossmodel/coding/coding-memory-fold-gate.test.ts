/**
 * coding-memory-fold-gate.ts — decision-gate purpose 'coding_memory_fold' (N3, 2026-09-25).
 *
 *  - the kill switch and mode 'off' never touch the seat;
 *  - ONE decide() over the legs' nouls, state = the prompts' own slices + heads of the existing docs;
 *  - shadow → no leg is skipped; every leg records a HARNESS-MEASURED label
 *    (did the stored doc actually change?) — changed / noop / failed(unlabelled);
 *  - act (designed, not enabled) → a leg at noul ≤ 1 − τ is skipped (no utility
 *    call, doc untouched, acted:true); an uncalibrated 'shadow' RESULT never skips;
 *  - every failure (decide throws / null) fails OPEN — every leg runs.
 * Boundary-mocked like coding-memory.test.ts + run-journal.service.test.ts; the
 * REAL gate module, memory service and journal writer execute.
 */

jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const mockStoreGet: jest.Mock = jest.fn(async (..._a: any[]): Promise<any> => null);
const mockStorePut: jest.Mock = jest.fn(async (..._a: any[]): Promise<void> => {});
jest.mock('../memory/context-store', () => ({
  __esModule: true,
  storeGet: (...a: any[]) => mockStoreGet(...a),
  storePut: (...a: any[]) => mockStorePut(...a),
}));

const mockUtilityChat: jest.Mock = jest.fn(async (..._a: any[]): Promise<string> => '');
jest.mock('../../../utils/utility-llm', () => ({ __esModule: true, utilityChat: (...a: any[]) => mockUtilityChat(...a) }));

const mockJournalCreate: jest.Mock = jest.fn(async (..._a: any[]): Promise<any> => ({}));
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    chatCodingState: { findMany: jest.fn(async () => []) },
    runJournalEntry: { create: (...a: any[]) => mockJournalCreate(...a), findMany: jest.fn(async () => []) },
  },
}));
jest.mock('../rag.service', () => ({ __esModule: true, embedTexts: jest.fn(), rerankTexts: jest.fn() }));
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: jest.fn(),
  LOOP_METRIC_KINDS: { MEMORY_SHRUNK: 'memory_shrunk', DECISION_GATE: 'decision_gate' },
}));
jest.mock('../memory/memory-audit', () => ({
  recordExtractionOutcome: jest.fn(),
  extractionDetailOf: (raw: unknown) => String(raw ?? '').slice(0, 240),
  parseModelJson: (text: unknown) => { const raw = String(text ?? '').trim(); if (!raw) return null; try { return JSON.parse(raw); } catch { return null; } },
}));

const mockDecide: jest.Mock = jest.fn(async (..._a: any[]): Promise<any> => null);
const mockMode: jest.Mock = jest.fn((): 'off' | 'shadow' | 'act' => 'off');
const mockRecord: jest.Mock = jest.fn();
jest.mock('../platform/decision-gate', () => ({
  __esModule: true,
  decide: (...a: any[]) => mockDecide(...a),
  decisionMode: (...a: any[]) => mockMode(...a),
  decisionThreshold: (_p: string, fallback: number) => fallback,
  recordDecisionOutcome: (d: unknown, ...rest: any[]) => { if (d) mockRecord(d, ...rest); },
}));

import {
  buildCodingMemoryFoldState, consultCodingMemoryFoldGate, memoryDocChanged,
  recordCodingMemoryFoldOutcome, CODING_MEMORY_FOLD_QUESTION, CODING_MEMORY_FOLD_DEFAULT_THRESHOLD, CODING_MEMORY_LEGS,
} from './coding-memory-fold-gate';
import { updateCodingMemoryAsync } from './coding-memory.service';
import { writeRunJournalEntryAsync } from './run-journal.service';

const flush = async () => { for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0)); };

const noul = (n: number) => ({ type: 'noul', noul: n });
const gateAnswer = (mode: 'shadow' | 'act', answers: Record<string, number>) => ({
  id: 'd1', mode, backend: 'TypeSafe Jev', ms: 12,
  answers: Object.fromEntries(Object.entries(answers).map(([k, v]) => [k, noul(v)])),
});

const INPUT = {
  legs: ['session', 'project', 'user'] as const,
  userMessage: 'add a lint step to CI', assistantSummary: 'ran npm run lint; it works — added the CI step', toolsUsed: ['run_command', 'edit_file'],
  sessionId: 's1',
  existing: { sessionSummary: 'Session is wiring CI.', projectCommands: ['npm test'], projectNotes: [], userPreferences: ['use pnpm'] },
};

const EXISTING_USER = { preferences: ['use pnpm'], notes: [], updatedAt: '' };
const EXISTING_PROJECT = { overview: 'A repo.', commands: ['npm test'], notes: [], updatedAt: '' };
const seedStore = () => {
  mockStoreGet.mockImplementation(async (ns: string[]) => {
    if (ns[1] === 'coding-user') return { ...EXISTING_USER };
    if (ns[1] === 'coding-project') return { ...EXISTING_PROJECT };
    if (ns[1] === 'coding-session') return { summary: 'Session is wiring CI.', updatedAt: '' };
    return null;
  });
};

beforeEach(() => {
  jest.clearAllMocks();
  mockMode.mockReturnValue('off');
  mockDecide.mockResolvedValue(null);
  mockUtilityChat.mockResolvedValue('');
  seedStore();
});

describe('pure pieces', () => {
  it('one question key per leg; the state carries the prompts\' slices, counts first, prose last, undefineds dropped', () => {
    expect(CODING_MEMORY_LEGS).toEqual(['session', 'project', 'user', 'journal']);
    expect(Object.values(CODING_MEMORY_FOLD_QUESTION)).toEqual(['session_state_change', 'project_fact', 'user_preference', 'journal_worthy']);
    const state = buildCodingMemoryFoldState(INPUT);
    expect(state.legs_asked).toBe('session, project, user');
    expect(state.tools_used).toBe('run_command, edit_file');
    expect(state.existing_project_commands).toEqual(['npm test']);
    expect(state.existing_user_preferences).toEqual(['use pnpm']);
    expect(state.existing_session_summary_head).toBe('Session is wiring CI.');
    expect(state).not.toHaveProperty('existing_project_notes'); // empty → dropped
    expect(state).not.toHaveProperty('trigger');
    expect(state.assistant_did).toBe('ran npm run lint; it works — added the CI step');
    // The journal-only ask names the final as such and carries the trigger.
    const j = buildCodingMemoryFoldState({ legs: ['journal'], userMessage: '', assistantSummary: 'x'.repeat(2000), toolsUsed: [], trigger: 'machine' });
    expect(j.trigger).toBe('machine');
    expect(j.user_message).toBe('(machine-triggered run — no user message)');
    expect(String(j.run_final_output)).toHaveLength(1500);
    expect(j).not.toHaveProperty('assistant_did');
  });

  it('memoryDocChanged compares content only (updatedAt excluded)', () => {
    expect(memoryDocChanged({ a: 1, updatedAt: 'x' }, { a: 1, updatedAt: 'y' })).toBe(false);
    expect(memoryDocChanged({ commands: ['a'] }, { commands: ['a', 'b'] })).toBe(true);
    expect(memoryDocChanged(null, { a: 1 })).toBe(true);
  });

  it('memoryDocChanged is KEY-ORDER independent (jsonb reads keys back (length, bytes)-sorted) but array-order sensitive', () => {
    // Postgres jsonb order for a project doc: {notes, commands, overview, updatedAt}; the code builds {overview, commands, notes, updatedAt}.
    const fromJsonb = { notes: ['n1'], commands: ['npm test'], overview: 'A repo.', updatedAt: '2026-09-25T00:00:00Z' };
    const built = { overview: 'A repo.', commands: ['npm test'], notes: ['n1'], updatedAt: '2026-09-25T01:00:00Z' };
    expect(memoryDocChanged(fromJsonb, built)).toBe(false);
    // …and for a user doc: {notes, updatedAt, preferences} vs {preferences, notes, updatedAt}.
    expect(memoryDocChanged({ notes: [], updatedAt: 'x', preferences: ['use pnpm'] }, { preferences: ['use pnpm'], notes: [], updatedAt: 'y' })).toBe(false);
    // Nested objects canonicalise too; array ORDER is content.
    expect(memoryDocChanged({ a: { y: 1, x: 2 } }, { a: { x: 2, y: 1 } })).toBe(false);
    expect(memoryDocChanged({ commands: ['a', 'b'] }, { commands: ['b', 'a'] })).toBe(true);
    // A real content change under jsonb order still reads changed.
    expect(memoryDocChanged(fromJsonb, { ...built, commands: ['npm test', 'npm run lint'] })).toBe(true);
    // undefined members are dropped the way JSON.stringify drops them (never a spurious diff).
    expect(memoryDocChanged({ a: 1, b: undefined }, { a: 1 })).toBe(false);
  });

  it('recordCodingMemoryFoldOutcome: skipped = acted, changed/noop = measured actual, failed = unlabelled', () => {
    const gated = { gate: gateAnswer('shadow', { project_fact: 0.5 }) as any, skip: { session: false, project: false, user: false, journal: false } };
    recordCodingMemoryFoldOutcome(gated, 'project', 'skipped', 's1');
    recordCodingMemoryFoldOutcome(gated, 'project', 'changed', 's1', 'budget=1500');
    recordCodingMemoryFoldOutcome(gated, 'project', 'noop', 's1');
    recordCodingMemoryFoldOutcome(gated, 'project', 'failed', 's1');
    const rows = mockRecord.mock.calls.map((c) => c[2]);
    expect(rows[0]).toMatchObject({ question: 'project_fact', actual: null, acted: true });
    expect(rows[1]).toMatchObject({ question: 'project_fact', actual: true, acted: false, note: 'ran: changed budget=1500' });
    expect(rows[2]).toMatchObject({ actual: false, acted: false });
    expect(rows[3]).toMatchObject({ actual: null, acted: false });
    expect(rows[3].note).toMatch(/failed/);
    recordCodingMemoryFoldOutcome({ gate: null, skip: gated.skip }, 'project', 'changed');
    expect(mockRecord).toHaveBeenCalledTimes(4); // no gate → no row
  });
});

describe('consultCodingMemoryFoldGate', () => {
  it('mode off / no legs → no decide()', async () => {
    mockMode.mockReturnValue('off');
    expect((await consultCodingMemoryFoldGate(INPUT)).gate).toBeNull();
    mockMode.mockReturnValue('shadow');
    expect((await consultCodingMemoryFoldGate({ ...INPUT, legs: [] })).gate).toBeNull();
    expect(mockDecide).not.toHaveBeenCalled();
  });

  it('shadow: one decide() with a noul per leg under the purpose; nothing is skipped', async () => {
    mockMode.mockReturnValue('shadow');
    mockDecide.mockResolvedValue(gateAnswer('shadow', { session_state_change: 0.1, project_fact: 0.05, user_preference: 0.02 }));
    const r = await consultCodingMemoryFoldGate(INPUT);
    expect(mockDecide).toHaveBeenCalledTimes(1);
    const [state, questions, opts] = mockDecide.mock.calls[0];
    expect(Object.keys(questions)).toEqual(['session_state_change', 'project_fact', 'user_preference']);
    for (const q of Object.values(questions) as any[]) { expect(q.type).toBe('noul'); expect(q.criteria.true).toBeTruthy(); }
    expect(state.legs_asked).toBe('session, project, user');
    expect(opts).toMatchObject({ purpose: 'coding_memory_fold', sessionId: 's1' });
    expect(r.skip).toEqual({ session: false, project: false, user: false, journal: false });
  });

  it('act (RESULT mode act): a leg at noul ≤ 1 − τ is skipped; an uncalibrated shadow result never skips; a throw fails open', async () => {
    mockMode.mockReturnValue('act');
    mockDecide.mockResolvedValue(gateAnswer('act', { session_state_change: 0.9, project_fact: 1 - CODING_MEMORY_FOLD_DEFAULT_THRESHOLD, user_preference: 0.5 }));
    expect((await consultCodingMemoryFoldGate(INPUT)).skip).toEqual({ session: false, project: true, user: false, journal: false });
    mockDecide.mockResolvedValue(gateAnswer('shadow', { session_state_change: 0.01, project_fact: 0.01, user_preference: 0.01 }));
    expect((await consultCodingMemoryFoldGate(INPUT)).skip).toEqual({ session: false, project: false, user: false, journal: false });
    mockDecide.mockRejectedValue(new Error('boom'));
    const r = await consultCodingMemoryFoldGate(INPUT);
    expect(r.gate).toBeNull();
    expect(r.skip).toEqual({ session: false, project: false, user: false, journal: false });
  });
});

describe('updateCodingMemoryAsync wiring', () => {
  const RUN = { userId: 'u1', projectId: 'p1', sessionId: 's1', userMessage: 'add a lint step to CI', assistantSummary: 'ran npm run lint; added the CI step', toolsUsed: ['run_command'] };

  it('mode off: the three legs run exactly as before and no outcome row is written', async () => {
    mockUtilityChat
      .mockResolvedValueOnce('New summary.')
      .mockResolvedValueOnce(JSON.stringify({ overview: 'A repo.', commands: ['npm test', 'npm run lint'], notes: [] }))
      .mockResolvedValueOnce(JSON.stringify({ preferences: ['use pnpm'], notes: [] }));
    updateCodingMemoryAsync(RUN);
    await flush();
    expect(mockDecide).not.toHaveBeenCalled();
    expect(mockUtilityChat).toHaveBeenCalledTimes(3);
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it('shadow: every leg runs; labels are the measured doc diff — session changed, project changed, user noop', async () => {
    mockMode.mockReturnValue('shadow');
    mockDecide.mockResolvedValue(gateAnswer('shadow', { session_state_change: 0.7, project_fact: 0.2, user_preference: 0.1 }));
    mockUtilityChat
      .mockResolvedValueOnce('New summary.')
      .mockResolvedValueOnce(JSON.stringify({ overview: 'A repo.', commands: ['npm test', 'npm run lint'], notes: [] }))
      .mockResolvedValueOnce(JSON.stringify({ preferences: ['use pnpm'], notes: [] }));
    updateCodingMemoryAsync(RUN);
    await flush();
    expect(mockUtilityChat).toHaveBeenCalledTimes(3);
    // The gate sees the existing docs' heads (so "new" is judged against what is stored).
    expect(mockDecide.mock.calls[0][0]).toMatchObject({ existing_project_commands: ['npm test'], existing_user_preferences: ['use pnpm'] });
    const byQ = Object.fromEntries(mockRecord.mock.calls.map((c) => [c[2].question, c[2]]));
    expect(byQ.session_state_change).toMatchObject({ actual: true, acted: false });
    expect(byQ.project_fact).toMatchObject({ actual: true, acted: false });
    expect(byQ.project_fact.note).toMatch(/budget=\d+/);
    expect(byQ.user_preference).toMatchObject({ actual: false, acted: false, note: 'ran: noop' });
    expect(mockStorePut.mock.calls.map((c) => c[0][1])).toEqual(['coding-session', 'coding-project', 'coding-user']);
  });

  it('shadow: a store doc in jsonb key order + an identical echo from the extractor labels NOOP for project and user (never a constant-true label)', async () => {
    mockMode.mockReturnValue('shadow');
    mockDecide.mockResolvedValue(gateAnswer('shadow', { session_state_change: 0.7, project_fact: 0.2, user_preference: 0.1 }));
    // Postgres jsonb returns object keys sorted by (length, bytes) — NOT the order the code wrote them.
    mockStoreGet.mockImplementation(async (ns: string[]) => {
      if (ns[1] === 'coding-user') return { notes: ['n'], updatedAt: '2026-09-24T00:00:00Z', preferences: ['use pnpm'] };
      if (ns[1] === 'coding-project') return { notes: ['keep tests green'], commands: ['npm test'], overview: 'A repo.', updatedAt: '2026-09-24T00:00:00Z' };
      if (ns[1] === 'coding-session') return { summary: 'Session is wiring CI.', updatedAt: '' };
      return null;
    });
    mockUtilityChat
      .mockResolvedValueOnce('New summary.')
      // The fold prompt says "preserve still-valid existing entries" — the model echoes the lists unchanged.
      .mockResolvedValueOnce(JSON.stringify({ overview: 'A repo.', commands: ['npm test'], notes: ['keep tests green'] }))
      .mockResolvedValueOnce(JSON.stringify({ preferences: ['use pnpm'], notes: ['n'] }));
    updateCodingMemoryAsync(RUN);
    await flush();
    expect(mockStorePut.mock.calls.map((c) => c[0][1])).toEqual(['coding-session', 'coding-project', 'coding-user']); // the legs still write
    const byQ = Object.fromEntries(mockRecord.mock.calls.map((c) => [c[2].question, c[2]]));
    expect(byQ.project_fact).toMatchObject({ actual: false, acted: false });
    expect(byQ.project_fact.note).toMatch(/^ran: noop/);
    expect(byQ.user_preference).toMatchObject({ actual: false, acted: false, note: 'ran: noop' });
  });

  it('shadow: the legs never WAIT on the gate — every utility call has run before the gate answers; the labels land when it does', async () => {
    mockMode.mockReturnValue('shadow');
    let releaseGate: (v: any) => void = () => {};
    mockDecide.mockImplementation(() => new Promise((r) => { releaseGate = r; }));
    mockUtilityChat
      .mockResolvedValueOnce('New summary.')
      .mockResolvedValueOnce(JSON.stringify({ overview: 'A repo.', commands: ['npm test', 'npm run lint'], notes: [] }))
      .mockResolvedValueOnce(JSON.stringify({ preferences: ['use pnpm'], notes: [] }));
    updateCodingMemoryAsync(RUN);
    await flush();
    expect(mockDecide).toHaveBeenCalledTimes(1);
    expect(mockUtilityChat).toHaveBeenCalledTimes(3); // all three legs ran while the gate was still pending
    expect(mockStorePut).toHaveBeenCalledTimes(3);
    expect(mockRecord).not.toHaveBeenCalled(); // no answer yet → no rows yet
    releaseGate(gateAnswer('shadow', { session_state_change: 0.7, project_fact: 0.2, user_preference: 0.1 }));
    await flush();
    const byQ = Object.fromEntries(mockRecord.mock.calls.map((c) => [c[2].question, c[2]]));
    expect(byQ.session_state_change).toMatchObject({ actual: true, acted: false });
    expect(byQ.project_fact).toMatchObject({ actual: true, acted: false });
    expect(byQ.user_preference).toMatchObject({ actual: false, acted: false });
  });

  it('shadow: an LLM failure on a leg is UNLABELLED (actual null), never a noop', async () => {
    mockMode.mockReturnValue('shadow');
    mockDecide.mockResolvedValue(gateAnswer('shadow', { session_state_change: 0.7, project_fact: 0.2, user_preference: 0.1 }));
    mockUtilityChat.mockResolvedValue(''); // every utility call fails
    updateCodingMemoryAsync(RUN);
    await flush();
    const byQ = Object.fromEntries(mockRecord.mock.calls.map((c) => [c[2].question, c[2]]));
    expect(byQ.session_state_change).toMatchObject({ actual: null, acted: false });
    expect(byQ.project_fact).toMatchObject({ actual: null, acted: false });
    expect(byQ.user_preference).toMatchObject({ actual: null, acted: false });
    expect(mockStorePut).not.toHaveBeenCalled();
  });

  it('act: confidently empty legs are skipped — no utility call, doc untouched, acted:true; the session leg still runs', async () => {
    mockMode.mockReturnValue('act');
    mockDecide.mockResolvedValue(gateAnswer('act', { session_state_change: 0.9, project_fact: 0.05, user_preference: 0.02 }));
    mockUtilityChat.mockResolvedValueOnce('New summary.');
    updateCodingMemoryAsync(RUN);
    await flush();
    expect(mockUtilityChat).toHaveBeenCalledTimes(1); // session only
    expect(mockStorePut.mock.calls.map((c) => c[0][1])).toEqual(['coding-session']);
    const byQ = Object.fromEntries(mockRecord.mock.calls.map((c) => [c[2].question, c[2]]));
    expect(byQ.project_fact).toMatchObject({ actual: null, acted: true });
    expect(byQ.user_preference).toMatchObject({ actual: null, acted: true });
    expect(byQ.session_state_change).toMatchObject({ actual: true, acted: false });
  });
});

describe('writeRunJournalEntryAsync wiring (journal leg)', () => {
  const RUN = { chatId: 'c1', runId: 'r1', triggerKind: 'machine', userMessage: 'sweep the lanes', assistantFinal: 'SWEEP: no-op — nothing moved.', toolsUsed: [] as string[] };
  const DISTILLED = { goal: 'Sweep', outcome: 'Nothing happened; no action taken.', keyDecisions: [], filesTouched: [], failures: [], observations: '' };

  it('shadow: a machine no-op that writes no row labels noop; a written row labels changed; an empty answer is unlabelled', async () => {
    mockMode.mockReturnValue('shadow');
    mockDecide.mockResolvedValue(gateAnswer('shadow', { journal_worthy: 0.3 }));
    mockUtilityChat.mockResolvedValueOnce(JSON.stringify(DISTILLED));
    writeRunJournalEntryAsync(RUN);
    await flush();
    expect(mockJournalCreate).not.toHaveBeenCalled();
    expect(mockDecide.mock.calls[0][1]).toHaveProperty('journal_worthy');
    expect(mockDecide.mock.calls[0][0]).toMatchObject({ trigger: 'machine', run_final_output: 'SWEEP: no-op — nothing moved.' });
    expect(mockRecord.mock.calls[0][2]).toMatchObject({ question: 'journal_worthy', actual: false, acted: false, note: 'ran: noop trigger=machine' });

    jest.clearAllMocks();
    mockMode.mockReturnValue('shadow');
    mockDecide.mockResolvedValue(gateAnswer('shadow', { journal_worthy: 0.9 }));
    mockUtilityChat.mockResolvedValueOnce(JSON.stringify({ ...DISTILLED, outcome: 'Fixed the flaky test.', filesTouched: ['a.ts'] }));
    writeRunJournalEntryAsync({ ...RUN, triggerKind: 'user', assistantFinal: 'Fixed the flaky test in a.ts.' });
    await flush();
    expect(mockJournalCreate).toHaveBeenCalledTimes(1);
    expect(mockRecord.mock.calls[0][2]).toMatchObject({ question: 'journal_worthy', actual: true, acted: false });

    jest.clearAllMocks();
    mockMode.mockReturnValue('shadow');
    mockDecide.mockResolvedValue(gateAnswer('shadow', { journal_worthy: 0.9 }));
    mockUtilityChat.mockResolvedValueOnce('');
    writeRunJournalEntryAsync(RUN);
    await flush();
    expect(mockRecord.mock.calls[0][2]).toMatchObject({ question: 'journal_worthy', actual: null, acted: false });
  });

  it('act: a confidently not-journal-worthy run skips the distillation (no utility call, no row, acted:true); junk never reaches the gate', async () => {
    mockMode.mockReturnValue('act');
    mockDecide.mockResolvedValue(gateAnswer('act', { journal_worthy: 0.05 }));
    writeRunJournalEntryAsync(RUN);
    await flush();
    expect(mockUtilityChat).not.toHaveBeenCalled();
    expect(mockJournalCreate).not.toHaveBeenCalled();
    expect(mockRecord.mock.calls[0][2]).toMatchObject({ question: 'journal_worthy', actual: null, acted: true });
    jest.clearAllMocks();
    writeRunJournalEntryAsync({ ...RUN, userMessage: '', assistantFinal: 'ok' });
    await flush();
    expect(mockDecide).not.toHaveBeenCalled();
  });
});
