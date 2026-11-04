/**
 * Memory extraction × decision gate (2026-09-24, purpose 'memory_extract').
 *
 * In extractAllParallelNode, outside the bootstrap window (messageCount > 6)
 * and never on an explicit rejection, ONE decide() asks up to three nouls —
 * user_fact / project_decision (only with a projectId) / thread_change — but
 * only for the extractors that WOULD run under today's debounce:
 *  - off    → nothing new; every extractor runs as before.
 *  - shadow → gate consulted; every extractor runs; one outcome per question
 *             (acted:false, actual:true, note 'ran').
 *  - act    → an extractor whose noul ≤ 1 − threshold (default 0.8 → ≤ 0.2)
 *             is dropped (acted:true, actual:null); the rest run (acted:false).
 *  - bootstrap window / rejection / machine run → the gate is never consulted.
 *  - the gate fails open: a null or throwing decide() skips nothing.
 */
const mockDebug: jest.Mock = jest.fn();
jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: (...a: any[]) => mockDebug(...a) },
}));

const mockFindUnique: jest.Mock = jest.fn();
const mockUpsert: jest.Mock = jest.fn();
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: { userMemory: { findUnique: (...a: any[]) => mockFindUnique(...a), upsert: (...a: any[]) => mockUpsert(...a) } },
}));
jest.mock('../context.service', () => ({
  __esModule: true,
  default: {},
  capHistoryToCharBudget: jest.fn(),
  MACHINE_WAKE_HISTORY_CHAR_BUDGET: 0,
  MACHINE_WAKE_MAX_PAIRS: 0,
}));

const mockUtilityChat: jest.Mock = jest.fn();
jest.mock('../../../utils/utility-llm', () => ({ utilityChat: (...a: any[]) => mockUtilityChat(...a) }));

jest.mock('../memory/unified-memory.service', () => ({
  memStore: jest.fn(async () => 1),
  enforceScopeCap: jest.fn(async () => {}),
}));
jest.mock('../memory/user-facts.service', () => ({
  selectRelevantFacts: jest.fn(),
  syncUserFactRows: jest.fn(),
}));
jest.mock('../memory/memory-audit', () => ({
  recordMemoryMutation: jest.fn(),
  recordExtractionOutcome: jest.fn(),
  parseModelJson: (text: unknown) => { const raw = String(text ?? '').replace(/```json\n?|\n?```/g, '').trim(); if (!raw) return null; try { return JSON.parse(raw); } catch {} const a = raw.indexOf('{'), b = raw.lastIndexOf('}'); if (a >= 0 && b > a) { try { return JSON.parse(raw.slice(a, b + 1)); } catch {} } return null; },
  countVisibleFacts: (facts: Record<string, unknown>) => Object.keys(facts || {}).filter((k) => !k.startsWith('__')).length,
}));
jest.mock('../memory/episodic.service', () => ({ buildEpisodicBlock: jest.fn() }));
jest.mock('../memory-relevance', () => ({
  filterFactsByRelevance: jest.fn(),
  isTextRelevantToMessage: jest.fn(),
}));

const mockStoreGet: jest.Mock = jest.fn();
const mockStorePut: jest.Mock = jest.fn();
const mockStoreAdvance: jest.Mock = jest.fn(async () => true);
jest.mock('../memory/context-store', () => ({
  storeGet: (...a: any[]) => mockStoreGet(...a),
  storePut: (...a: any[]) => mockStorePut(...a),
  storeAdvanceNumberField: (...a: any[]) => mockStoreAdvance(...a),
}));
jest.mock('../platform/folder-inheritance', () => ({ getMergedProjectStoreState: jest.fn() }));

const mockDecide: jest.Mock = jest.fn();
const mockMode: jest.Mock = jest.fn();
const mockRecord: jest.Mock = jest.fn();
jest.mock('../platform/decision-gate', () => ({
  __esModule: true,
  decide: (...a: any[]) => mockDecide(...a),
  decisionMode: (...a: any[]) => mockMode(...a),
  decisionThreshold: (_p: string, fallback: number) => fallback,
  recordDecisionOutcome: (d: unknown, ...rest: any[]) => { if (d) mockRecord(d, ...rest); },
}));

import { runUpdateContextPipeline, consultMemoryExtractGate, MEMORY_EXTRACT_QUESTION } from './memory.graph';
// The profile leg's per-user throttle is process state — each test starts clean (2026-10-20).
import { resetProfileExtractionThrottle } from '../memory/profile-guard';

// ── Fixtures ──────────────────────────────────────────────────────────────────

/** ≥ 30 chars (not "too short"), no rejection cue. */
const USER_MSG = 'Which index should the unified memory store use for vectors?';
/** < 300 chars so the fire-and-forget conversation distill makes no LLM call — every utilityChat call below is an extractor. */
const ANSWER = 'Use pgvector HNSW for the unified index; it beats IVFFlat on recall at this size and needs no retraining.';
const REJECTION = 'I told you many times to stop talking about my joint health and my diet.';

const threadState = (messageCount: number) => ({
  threadSummary: 'Discussing the memory index.', confirmedFacts: {}, openTopics: [], lastUserGoal: 'pick an index', messageCount, lastUpdated: '',
});

function routeLLM() {
  mockUtilityChat.mockImplementation(async (messages: Array<{ content: string }>) => {
    const p = messages[0].content;
    if (p.includes('maintaining a project knowledge base')) return JSON.stringify({ summary: 's', recentDecisions: [], entities: { people: [], amounts: [], places: [], topics: [] }, openItems: [], lastUpdated: '' });
    if (p.includes('maintain a user profile')) return JSON.stringify({ summary: 'engineer', preferences: '', currentFocus: '', recentTopics: [], communicationStyle: 'terse' });
    if (p.includes('memory manager')) return JSON.stringify({ add: {}, remove: [], reject: [] });
    if (p.includes('conversation thread summary')) return JSON.stringify({ threadSummary: 's', confirmedFacts: {}, openTopics: [], lastUserGoal: 'g', messageCount: 12, lastUpdated: '' });
    return '{}';
  });
}

/** storeGet by namespace kind: project context state, thread state, user context state. */
function storeReturns(opts: { project?: unknown; thread?: unknown; user?: unknown }) {
  mockStoreGet.mockImplementation(async (ns: string[]) => {
    if (ns[1] === 'context') return opts.project ?? null;
    if (ns[1] === 'thread') return opts.thread ?? null;
    if (ns[1] === 'memory') return opts.user ?? null;
    return null;
  });
}

const prompts = () => mockUtilityChat.mock.calls.map(c => String(c[0][0].content));
const threadPrompts = () => prompts().filter(p => p.includes('conversation thread summary'));
const userPrompts = () => prompts().filter(p => p.includes('maintain a user profile'));
const projectPrompts = () => prompts().filter(p => p.includes('maintaining a project knowledge base'));
const puts = (kind: string) => mockStorePut.mock.calls.filter(c => c[0][1] === kind);
const flush = () => new Promise(r => setImmediate(r));

const nouls = (v: Partial<Record<'user_fact' | 'project_decision' | 'thread_change', number>>, mode: 'shadow' | 'act' = 'act') => ({
  id: 'dec1', backend: 'test', ms: 11, mode,
  answers: Object.fromEntries(Object.entries(v).map(([k, noul]) => [k, { type: 'noul', noul }])),
});
const outcomes = () => mockRecord.mock.calls.map(c => c[2]);

/** Existing thread state at 10 → this turn is messageCount 12 / turn 6: thread (even turn) AND full (12 % 6 === 0) both due. */
const input = { userId: 'u1', projectId: 'p1', chatId: 'c1', userMessage: USER_MSG, synthesis: ANSWER };

beforeEach(() => {
  jest.clearAllMocks();
  resetProfileExtractionThrottle();
  mockStorePut.mockResolvedValue(undefined);
  mockFindUnique.mockResolvedValue(null);
  mockUpsert.mockResolvedValue(undefined);
  routeLLM();
  storeReturns({ project: null, thread: threadState(10), user: null });
});

// ── act ───────────────────────────────────────────────────────────────────────

describe('memory_extract gate — act', () => {
  it('all three confidently false (outside the bootstrap window, no rejection) → NO extractor runs; three acted:true outcomes; one debug line names the skips', async () => {
    mockMode.mockReturnValue('act');
    mockDecide.mockResolvedValue(nouls({ user_fact: 0.05, project_decision: 0.1, thread_change: 0.2 }));

    await runUpdateContextPipeline(input);
    await flush();

    expect(mockDecide).toHaveBeenCalledTimes(1);
    const [state, questions, opts] = mockDecide.mock.calls[0];
    expect(state).toEqual({ user_message: USER_MSG, assistant_answer: ANSWER });
    expect(Object.keys(questions).sort()).toEqual(['project_decision', 'thread_change', 'user_fact']);
    expect(Object.values(questions).every((q: any) => q.type === 'noul')).toBe(true);
    expect(opts).toEqual({ purpose: 'memory_extract', timeoutMs: 3000, sessionId: 'c1' });

    expect(mockUtilityChat).not.toHaveBeenCalled();
    // THREAD_STATE_DEBOUNCE_FIX (2026-10-22): the gate-skipped thread extractor still
    // advances the stored turn counter — ONE atomic single-field raise (never a rewrite
    // of the loaded snapshot); nothing else is written.
    expect(mockStorePut).not.toHaveBeenCalled();
    expect(mockStoreAdvance).toHaveBeenCalledTimes(1);
    expect(mockStoreAdvance).toHaveBeenCalledWith(['c1', 'thread'], 'state', 'messageCount', 12);

    expect(outcomes()).toHaveLength(3);
    for (const o of outcomes()) expect(o).toMatchObject({ actual: null, acted: true, sessionId: 'c1' });
    expect(outcomes().map(o => o.question).sort()).toEqual(['project_decision', 'thread_change', 'user_fact']);
    const skipLine = mockDebug.mock.calls.map(c => String(c[0])).find(l => l.includes('decision gate skipped'));
    expect(skipLine).toContain('user');
    expect(skipLine).toContain('project');
    expect(skipLine).toContain('thread');
  });

  it('in the bootstrap window (messageCount ≤ 6) → the gate is NOT consulted and extraction runs', async () => {
    mockMode.mockReturnValue('act');
    storeReturns({ project: null, thread: threadState(2), user: null }); // this turn = 4
    await runUpdateContextPipeline(input);
    await flush();
    expect(mockDecide).not.toHaveBeenCalled();
    expect(userPrompts()).toHaveLength(1);
    expect(projectPrompts()).toHaveLength(1);
    expect(puts('thread')).toHaveLength(1); // ≤ 4 messages: minimal thread state, no LLM
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it('an explicit rejection outside the bootstrap window → the gate is NOT consulted; full extraction runs', async () => {
    mockMode.mockReturnValue('act');
    storeReturns({ project: null, thread: threadState(14), user: null }); // turn 8: nothing due by debounce, but a rejection forces everything
    await runUpdateContextPipeline({ ...input, userMessage: REJECTION });
    await flush();
    expect(mockDecide).not.toHaveBeenCalled();
    expect(threadPrompts()).toHaveLength(1);
    expect(userPrompts()).toHaveLength(1);
    expect(projectPrompts()).toHaveLength(1);
  });

  it('only the confidently-false extractor is dropped; the uncertain ones run and record acted:false', async () => {
    mockMode.mockReturnValue('act');
    mockDecide.mockResolvedValue(nouls({ user_fact: 0.6, project_decision: 0.45, thread_change: 0.1 }));
    await runUpdateContextPipeline(input);
    await flush();
    expect(threadPrompts()).toHaveLength(0);
    // 2026-10-22: the only thread write is the counter bookkeeping (summary untouched).
    expect(puts('thread')).toHaveLength(0);
    expect(mockStoreAdvance).toHaveBeenCalledWith(['c1', 'thread'], 'state', 'messageCount', 12);
    expect(userPrompts()).toHaveLength(1);
    expect(projectPrompts()).toHaveLength(1);
    const byQ = Object.fromEntries(outcomes().map(o => [o.question, o]));
    expect(byQ.thread_change).toMatchObject({ actual: null, acted: true });
    // E5 honest labels: a first extraction (no prior state) persists content ⇒ 'changed' ⇒ actual:true.
    expect(byQ.user_fact).toMatchObject({ actual: true, acted: false, note: 'ran: changed' });
    expect(byQ.project_decision).toMatchObject({ actual: true, acted: false, note: 'ran: changed' });
  });

  it('asks only for extractors the debounce WOULD run: turn 9 (odd) → no thread question, full extraction due', async () => {
    mockMode.mockReturnValue('act');
    storeReturns({ project: null, thread: threadState(16), user: null }); // this turn 18: thread off (odd turn), full on (18 % 6 === 0)
    mockDecide.mockResolvedValue(nouls({ user_fact: 0.9, project_decision: 0.9 }));
    await runUpdateContextPipeline(input);
    await flush();
    expect(Object.keys(mockDecide.mock.calls[0][1]).sort()).toEqual(['project_decision', 'user_fact']);
    expect(threadPrompts()).toHaveLength(0);
    expect(userPrompts()).toHaveLength(1);
  });

  it('no extractor due under the debounce → the gate is not consulted at all', async () => {
    mockMode.mockReturnValue('act');
    storeReturns({ project: null, thread: threadState(12), user: null }); // this turn 14 / turn 7: thread off, full off
    await runUpdateContextPipeline(input);
    await flush();
    expect(mockDecide).not.toHaveBeenCalled();
    expect(mockUtilityChat).not.toHaveBeenCalled();
  });

  it('without a projectId the project_decision question is not asked', async () => {
    mockMode.mockReturnValue('act');
    mockDecide.mockResolvedValue(nouls({ user_fact: 0.5, thread_change: 0.5 }));
    await runUpdateContextPipeline({ ...input, projectId: null });
    await flush();
    expect(Object.keys(mockDecide.mock.calls[0][1]).sort()).toEqual(['thread_change', 'user_fact']);
    expect(projectPrompts()).toHaveLength(0);
  });

  it('a machine run never reaches the gate', async () => {
    mockMode.mockReturnValue('act');
    await runUpdateContextPipeline({ ...input, userMessage: '[SCHEDULED WAKE] audit memory', synthesis: 'A'.repeat(400), machineRun: true });
    await flush();
    expect(mockDecide).not.toHaveBeenCalled();
  });

  it('a null gate answer skips nothing and records nothing', async () => {
    mockMode.mockReturnValue('act');
    mockDecide.mockResolvedValue(null);
    await runUpdateContextPipeline(input);
    await flush();
    expect(threadPrompts()).toHaveLength(1);
    expect(userPrompts()).toHaveLength(1);
    expect(projectPrompts()).toHaveLength(1);
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it('a throwing gate fails OPEN — everything runs', async () => {
    mockMode.mockImplementation(() => { throw new Error('boom'); });
    await runUpdateContextPipeline(input);
    await flush();
    expect(threadPrompts()).toHaveLength(1);
    expect(userPrompts()).toHaveLength(1);
    expect(projectPrompts()).toHaveLength(1);
  });
});

// ── shadow / off ──────────────────────────────────────────────────────────────

describe('memory_extract gate — shadow and off', () => {
  it('shadow: extractors run even when every noul is confidently false; outcomes acted:false with the MEASURED actual (first extraction ⇒ changed ⇒ true)', async () => {
    mockMode.mockReturnValue('shadow');
    mockDecide.mockResolvedValue(nouls({ user_fact: 0.01, project_decision: 0.01, thread_change: 0.01 }, 'shadow'));
    await runUpdateContextPipeline(input);
    await flush();
    expect(mockDecide).toHaveBeenCalledTimes(1);
    expect(threadPrompts()).toHaveLength(1);
    expect(userPrompts()).toHaveLength(1);
    expect(projectPrompts()).toHaveLength(1);
    expect(puts('thread')).toHaveLength(1);
    expect(puts('memory')).toHaveLength(1);
    expect(puts('context')).toHaveLength(1);
    expect(outcomes()).toHaveLength(3);
    for (const o of outcomes()) expect(o).toMatchObject({ actual: true, acted: false, note: 'ran: changed' });
    expect(mockRecord.mock.calls[0][0].id).toBe('dec1');
    expect(mockRecord.mock.calls[0][1]).toBe('memory_extract');
  });

  // E5 (2026-09-25): the label is what the extractor MEASURABLY did, not a constant.
  it('shadow + an extraction that re-saves the SAME content → actual:false ("ran: noop") for thread + project; the rows land AFTER the extractors settle', async () => {
    mockMode.mockReturnValue('shadow');
    mockDecide.mockResolvedValue(nouls({ user_fact: 0.5, project_decision: 0.5, thread_change: 0.5 }, 'shadow'));
    // Existing states equal to what routeLLM() answers (bookkeeping fields differ — ignored by the content diff).
    storeReturns({
      project: { summary: 's', recentDecisions: [], entities: { people: [], amounts: [], places: [], topics: [] }, openItems: [], lastUpdated: 'old' },
      thread: { threadSummary: 's', confirmedFacts: {}, openTopics: [], lastUserGoal: 'g', messageCount: 10, lastUpdated: 'old' },
      user: null,
    });
    await runUpdateContextPipeline(input);
    await flush();
    const byQ = Object.fromEntries(outcomes().map(o => [o.question, o]));
    expect(byQ.thread_change).toMatchObject({ actual: false, acted: false, note: 'ran: noop' });
    expect(byQ.project_decision).toMatchObject({ actual: false, acted: false, note: 'ran: noop' });
    expect(byQ.user_fact).toMatchObject({ actual: true, acted: false, note: 'ran: changed' }); // no prior profile ⇒ the save is a change
    // Ordering: every outcome row was recorded after the extractor LLM calls ran.
    expect(mockUtilityChat.mock.invocationCallOrder.every(n => n < Math.min(...mockRecord.mock.invocationCallOrder))).toBe(true);
  });

  it('shadow + an extractor whose LLM leg fails → actual:null (the extractor evidences nothing)', async () => {
    mockMode.mockReturnValue('shadow');
    mockDecide.mockResolvedValue(nouls({ user_fact: 0.5, project_decision: 0.5, thread_change: 0.5 }, 'shadow'));
    mockUtilityChat.mockImplementation(async (messages: Array<{ content: string }>) => {
      const p = messages[0].content;
      if (p.includes('conversation thread summary')) throw new Error('provider down');
      if (p.includes('maintaining a project knowledge base')) return 'not json at all';
      if (p.includes('maintain a user profile')) return JSON.stringify({ summary: 'engineer', preferences: '', currentFocus: '', recentTopics: [], communicationStyle: 'terse' });
      if (p.includes('memory manager')) return JSON.stringify({ add: {}, remove: [], reject: [] });
      return '{}';
    });
    await runUpdateContextPipeline(input);
    await flush();
    const byQ = Object.fromEntries(outcomes().map(o => [o.question, o]));
    expect(byQ.thread_change).toMatchObject({ actual: null, acted: false, note: 'ran: llm_error — outcome unknown' });
    expect(byQ.project_decision).toMatchObject({ actual: null, acted: false, note: 'ran: parse_error — outcome unknown' });
  });

  it('off: the gate is never consulted; every extractor runs byte-identically', async () => {
    mockMode.mockReturnValue('off');
    await runUpdateContextPipeline(input);
    await flush();
    expect(mockDecide).not.toHaveBeenCalled();
    expect(threadPrompts()).toHaveLength(1);
    expect(userPrompts()).toHaveLength(1);
    expect(projectPrompts()).toHaveLength(1);
    expect(mockRecord).not.toHaveBeenCalled();
  });
});

// ── the pure helper ───────────────────────────────────────────────────────────

describe('consultMemoryExtractGate (pure)', () => {
  const wantedAll = { thread: true, user: true, project: true };

  it('act: skips at the cutoff (noul ≤ 1 − 0.8) and not above it', async () => {
    mockMode.mockReturnValue('act');
    mockDecide.mockResolvedValue(nouls({ user_fact: 0.2, project_decision: 0.21, thread_change: 0.0 }));
    const r = await consultMemoryExtractGate({ userMessage: USER_MSG, synthesis: ANSWER, wanted: wantedAll });
    expect(r.mode).toBe('act');
    expect(r.skip).toEqual({ user: true, project: false, thread: true });
  });

  it('shadow: never skips, even on certainty', async () => {
    mockMode.mockReturnValue('shadow');
    mockDecide.mockResolvedValue(nouls({ user_fact: 0, project_decision: 0, thread_change: 0 }, 'shadow'));
    const r = await consultMemoryExtractGate({ userMessage: USER_MSG, synthesis: ANSWER, wanted: wantedAll });
    expect(r.gate?.id).toBe('dec1');
    expect(r.skip).toEqual({ user: false, project: false, thread: false });
  });

  it('off: no decide() call, no skips', async () => {
    mockMode.mockReturnValue('off');
    const r = await consultMemoryExtractGate({ userMessage: USER_MSG, synthesis: ANSWER, wanted: wantedAll });
    expect(mockDecide).not.toHaveBeenCalled();
    expect(r).toEqual({ gate: null, mode: 'off', skip: { user: false, project: false, thread: false } });
  });

  it('nothing wanted → no decide() call', async () => {
    mockMode.mockReturnValue('act');
    await consultMemoryExtractGate({ userMessage: USER_MSG, synthesis: ANSWER, wanted: { thread: false, user: false, project: false } });
    expect(mockDecide).not.toHaveBeenCalled();
  });

  it('state is bounded: 2000 chars of user message, 3000 of the answer; question keys match the vocabulary', async () => {
    mockMode.mockReturnValue('act');
    mockDecide.mockResolvedValue(null);
    await consultMemoryExtractGate({ userMessage: 'u'.repeat(9000), synthesis: 'a'.repeat(9000), wanted: wantedAll, sessionId: 'c9' });
    const [state, questions, opts] = mockDecide.mock.calls[0];
    expect(state.user_message).toHaveLength(2000);
    expect(state.assistant_answer).toHaveLength(3000);
    expect(Object.keys(questions).sort()).toEqual(Object.values(MEMORY_EXTRACT_QUESTION).sort());
    expect(opts.sessionId).toBe('c9');
  });

  it('a rejecting decide() (contract violation) → no skips', async () => {
    mockMode.mockReturnValue('act');
    mockDecide.mockRejectedValue(new Error('boom'));
    const r = await consultMemoryExtractGate({ userMessage: USER_MSG, synthesis: ANSWER, wanted: wantedAll });
    expect(r.skip).toEqual({ user: false, project: false, thread: false });
  });
});
