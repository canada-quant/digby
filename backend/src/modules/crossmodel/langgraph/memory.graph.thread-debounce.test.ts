/**
 * THREAD_STATE_DEBOUNCE_FIX (2026-10-22, fs-durable-memory — rank #6 of the
 * Fleet Supervisor context map, affects every chat).
 *
 * The thread-extraction debounce computed the turn number from the STORED
 * thread messageCount (+2) and only an extraction save advanced it. From a
 * stored 12 every later turn computed messageCount 14 → turn 7 (odd) →
 * skipped → saved nothing → 14 again: the summary froze forever (and the full
 * user / project extraction, keyed on the same count — 14 % 6 ≠ 0 — froze with
 * it). These pins replay ten consecutive substantive turns from stored 12
 * against a store that persists what the pipeline writes.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
const mockFindUnique: jest.Mock = jest.fn(async () => null);
const mockUpsert: jest.Mock = jest.fn(async () => undefined);
// The chat row (review 2026-10-23: a thread save re-checks it — a chat deleted mid-extraction loses the row it just wrote).
const mockChatFind: jest.Mock = jest.fn(async ({ where }: any) => ({ id: where.id }));
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    userMemory: { findUnique: (...a: any[]) => mockFindUnique(...a), upsert: (...a: any[]) => mockUpsert(...a) },
    crossModelChat: { findUnique: (...a: any[]) => mockChatFind(...a) },
  },
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
jest.mock('../memory/user-facts.service', () => ({ selectRelevantFacts: jest.fn(), syncUserFactRows: jest.fn() }));
jest.mock('../memory/memory-audit', () => ({
  recordMemoryMutation: jest.fn(),
  recordExtractionOutcome: jest.fn(),
  parseModelJson: (text: unknown) => { const raw = String(text ?? '').replace(/```json\n?|\n?```/g, '').trim(); if (!raw) return null; try { return JSON.parse(raw); } catch {} const a = raw.indexOf('{'), b = raw.lastIndexOf('}'); if (a >= 0 && b > a) { try { return JSON.parse(raw.slice(a, b + 1)); } catch {} } return null; },
  countVisibleFacts: (facts: Record<string, unknown>) => Object.keys(facts || {}).filter((k) => !k.startsWith('__')).length,
}));
jest.mock('../memory/episodic.service', () => ({ buildEpisodicBlock: jest.fn() }));
jest.mock('../memory-relevance', () => ({ filterFactsByRelevance: jest.fn(), isTextRelevantToMessage: jest.fn() }));
jest.mock('../platform/folder-inheritance', () => ({ getMergedProjectStoreState: jest.fn() }));
// The memory_extract decision gate: OFF (the fleet default for this test) unless a test sets act.
const mockDecide: jest.Mock = jest.fn();
const mockMode: jest.Mock = jest.fn(() => 'off');
jest.mock('../platform/decision-gate', () => ({
  __esModule: true,
  decide: (...a: any[]) => mockDecide(...a),
  decisionMode: (...a: any[]) => mockMode(...a),
  decisionThreshold: (_p: string, fallback: number) => fallback,
  recordDecisionOutcome: jest.fn(),
}));

// A context store that PERSISTS what the pipeline writes — the bug lives in the read-back.
const store = new Map<string, any>();
const key = (ns: string[], k: string) => `${ns.join('/')}#${k}`;
const mockStorePut: jest.Mock = jest.fn(async (ns: string[], k: string, v: any) => { store.set(key(ns, k), JSON.parse(JSON.stringify(v))); });
// The atomic single-field raise (context-store storeAdvanceNumberField): touches ONLY `field`, only upward.
const mockStoreAdvance: jest.Mock = jest.fn(async (ns: string[], k: string, field: string, value: number) => {
  const cur = store.get(key(ns, k));
  if (!cur || typeof cur !== 'object') return false;
  if (typeof cur[field] === 'number' && cur[field] >= value) return false;
  store.set(key(ns, k), { ...cur, [field]: value });
  return true;
});
// Interleave hook: runs right AFTER a thread-state read returns its snapshot — an overlapping extraction landing mid-pipeline.
let afterThreadRead: (() => void) | null = null;
jest.mock('../memory/context-store', () => ({
  storeGet: async (ns: string[], k: string) => {
    const v = store.get(key(ns, k)) ?? null;
    const snap = v ? JSON.parse(JSON.stringify(v)) : null;
    if (ns[1] === 'thread' && afterThreadRead) { const f = afterThreadRead; afterThreadRead = null; f(); }
    return snap;
  },
  storePut: (...a: any[]) => mockStorePut(...a),
  storeAdvanceNumberField: (...a: any[]) => mockStoreAdvance(...a),
  storeDelete: async (ns: string[], k: string) => { store.delete(key(ns, k)); },
}));

import { runUpdateContextPipeline, threadCounterBookkeepingDue } from './memory.graph';
import { resetProfileExtractionThrottle } from '../memory/profile-guard';

const CHAT = 'chat-frozen-1';
/** ≥ 30 chars, no rejection cue; the answer < 300 chars so the distill makes no LLM call. */
const USER_MSG = 'What should we do next about the deploy pipeline speed?';
const ANSWER = 'Prebuild the stateless images and keep the builder cache; that cut the last wave to 18 minutes.';

let summaryN = 0;
function routeLLM() {
  mockUtilityChat.mockImplementation(async (messages: Array<{ content: string }>) => {
    const p = messages[0].content;
    if (p.includes('conversation thread summary')) {
      summaryN += 1;
      return JSON.stringify({ threadSummary: `summary v${summaryN}`, confirmedFacts: {}, openTopics: [], lastUserGoal: 'speed', messageCount: 0, lastUpdated: '' });
    }
    if (p.includes('maintain a user profile')) return JSON.stringify({ summary: 'engineer', preferences: '', currentFocus: '', recentTopics: [], communicationStyle: 'terse' });
    if (p.includes('memory manager')) return JSON.stringify({ add: {}, remove: [], reject: [] });
    return '{}';
  });
}

const threadPrompts = () => mockUtilityChat.mock.calls.filter((c) => String(c[0][0].content).includes('conversation thread summary'));
const fullPrompts = () => mockUtilityChat.mock.calls.filter((c) => String(c[0][0].content).includes('maintain a user profile'));
const storedThread = () => store.get(key([CHAT, 'thread'], 'state'));

async function turns(n: number, msg = USER_MSG): Promise<void> {
  for (let i = 0; i < n; i++) {
    await runUpdateContextPipeline({ userId: 'u1', projectId: null, chatId: CHAT, userMessage: msg, synthesis: ANSWER });
    resetProfileExtractionThrottle();
  }
}

beforeEach(() => {
  jest.clearAllMocks();
  afterThreadRead = null;
  delete process.env.THREAD_STATE_DEBOUNCE_FIX_DISABLED;
  resetProfileExtractionThrottle();
  mockMode.mockImplementation(() => 'off');
  store.clear();
  summaryN = 0;
  routeLLM();
  store.set(key([CHAT, 'thread'], 'state'), {
    threadSummary: 'stale summary from turn 6', confirmedFacts: {}, openTopics: [], lastUserGoal: 'old', messageCount: 12, lastUpdated: '2026-10-01T00:00:00.000Z',
  });
});
afterAll(() => { delete process.env.THREAD_STATE_DEBOUNCE_FIX_DISABLED; });

describe('thread-state debounce from a stored 12', () => {
  it('10 consecutive substantive turns re-extract the thread summary at least 4 times (every other turn)', async () => {
    await turns(10);
    expect(threadPrompts().length).toBeGreaterThanOrEqual(4);
    expect(threadPrompts()).toHaveLength(5); // turns 8, 10, 12, 14, 16
    const t = storedThread();
    expect(t.messageCount).toBe(32); // 12 + 10 turns × 2
    expect(t.threadSummary).toBe('summary v5');
  });

  it('the full user extraction resumes its designed cadence too (it keys on the same count)', async () => {
    await turns(10);
    // messageCount 14..32: % 6 === 0 at 18 (≤ 20); % 12 === 0 at 24 (> 20) → 2 runs.
    expect(fullPrompts()).toHaveLength(2);
  });

  it('a skipped turn persists ONLY the counter — summary, facts and lastUpdated untouched', async () => {
    await turns(1); // stored 12 → messageCount 14 → turn 7 (odd) → skipped
    expect(threadPrompts()).toHaveLength(0);
    const t = storedThread();
    expect(t.messageCount).toBe(14);
    expect(t.threadSummary).toBe('stale summary from turn 6');
    expect(t.lastUpdated).toBe('2026-10-01T00:00:00.000Z');
  });

  it('short messages (< 30 chars) never advance the counter — a long/short alternation still extracts', async () => {
    for (let i = 0; i < 4; i++) {
      await runUpdateContextPipeline({ userId: 'u1', projectId: null, chatId: CHAT, userMessage: USER_MSG, synthesis: ANSWER });
      await runUpdateContextPipeline({ userId: 'u1', projectId: null, chatId: CHAT, userMessage: 'ok thanks', synthesis: ANSWER });
      resetProfileExtractionThrottle();
    }
    expect(threadPrompts()).toHaveLength(2);
    expect(storedThread().messageCount).toBe(20);
  });

  it('a decision-gate (act) skip of the thread extractor also advances the counter', async () => {
    mockMode.mockImplementation(() => 'act');
    mockDecide.mockResolvedValue({ id: 'd1', backend: 'test', ms: 1, mode: 'act', answers: { thread_change: { type: 'noul', noul: 0.05 } } });
    await turns(2); // turn 7 debounce-skipped, turn 8 gate-skipped
    expect(threadPrompts()).toHaveLength(0);
    expect(storedThread().messageCount).toBe(16);
  });

  it('the RESTORED user/project cadence still goes through the memory_extract gate (act drops a confident no; shadow asks and runs)', async () => {
    // From stored 12: turn 7 (14) nothing due, turn 8 (16) thread, turn 9 (18) FULL only (odd turn; 18 % 6 === 0).
    mockMode.mockImplementation(() => 'act');
    mockDecide.mockResolvedValue({ id: 'd1', backend: 'test', ms: 1, mode: 'act', answers: { thread_change: { type: 'noul', noul: 0.95 }, user_fact: { type: 'noul', noul: 0.05 } } });
    await turns(3);
    const asked = mockDecide.mock.calls.map((c) => Object.keys(c[1]).sort());
    expect(asked).toEqual([['thread_change'], ['user_fact']]); // the restored full turn asks user_fact
    expect(fullPrompts()).toHaveLength(0); // … and act drops it on a confident no
    expect(threadPrompts()).toHaveLength(1);
    expect(storedThread().messageCount).toBe(18); // the gate-dropped turn still advanced the counter

    jest.clearAllMocks(); routeLLM(); resetProfileExtractionThrottle();
    store.set(key([CHAT, 'thread'], 'state'), { threadSummary: 's', confirmedFacts: {}, openTopics: [], lastUserGoal: 'g', messageCount: 12, lastUpdated: '' });
    mockMode.mockImplementation(() => 'shadow');
    mockDecide.mockResolvedValue({ id: 'd2', backend: 'test', ms: 1, mode: 'shadow', answers: { thread_change: { type: 'noul', noul: 0.05 }, user_fact: { type: 'noul', noul: 0.05 } } });
    await turns(3);
    expect(mockDecide).toHaveBeenCalledTimes(2); // asked on both due turns, never on the debounce-skipped one
    expect(fullPrompts()).toHaveLength(1); // shadow never skips
  });

  it('machine runs never touch the thread counter', async () => {
    await runUpdateContextPipeline({ userId: 'u1', projectId: null, chatId: CHAT, userMessage: USER_MSG, synthesis: ANSWER, machineRun: true });
    expect(storedThread().messageCount).toBe(12);
  });

  it('kill switch: the counter freezes at 12 again (old behaviour — zero re-extractions)', async () => {
    process.env.THREAD_STATE_DEBOUNCE_FIX_DISABLED = '1';
    await turns(10);
    expect(threadPrompts()).toHaveLength(0);
    expect(fullPrompts()).toHaveLength(0);
    expect(storedThread().messageCount).toBe(12);
    expect(storedThread().threadSummary).toBe('stale summary from turn 6');
  });

  it('RACE: the counter bookkeeping never clobbers a newer summary an overlapping extraction saved mid-turn', async () => {
    // This turn loads the stored 12 (→ turn 7, skipped); between that read and the bookkeeping write
    // another pipeline (an overlapping turn's extraction) saves a NEWER summary + open topic at 14.
    afterThreadRead = () => {
      store.set(key([CHAT, 'thread'], 'state'), {
        threadSummary: 'newer summary from the overlapping extraction', confirmedFacts: { k: 'v' }, openTopics: ['Q: ship it?'], lastUserGoal: 'newer', messageCount: 14, lastUpdated: '2026-10-22T12:00:00.000Z',
      });
    };
    await turns(1);
    expect(threadPrompts()).toHaveLength(0);
    const t = storedThread();
    expect(t.threadSummary).toBe('newer summary from the overlapping extraction');
    expect(t.openTopics).toEqual(['Q: ship it?']);
    expect(t.confirmedFacts).toEqual({ k: 'v' });
    expect(t.lastUpdated).toBe('2026-10-22T12:00:00.000Z');
    expect(t.messageCount).toBe(14);
    // Only the counter is ever written by the bookkeeping — never the whole loaded snapshot.
    expect(mockStorePut.mock.calls.filter((c) => c[0][1] === 'thread')).toHaveLength(0);
    expect(mockStoreAdvance).toHaveBeenCalledWith([CHAT, 'thread'], 'state', 'messageCount', 14);
  });

  it('RACE: a concurrent save that already advanced further is never lowered', async () => {
    afterThreadRead = () => {
      store.set(key([CHAT, 'thread'], 'state'), { ...store.get(key([CHAT, 'thread'], 'state')), threadSummary: 'v-from-turn-8', messageCount: 16 });
    };
    await turns(1); // computes 14 from the stale snapshot
    expect(storedThread().messageCount).toBe(16);
    expect(storedThread().threadSummary).toBe('v-from-turn-8');
  });

  it('threadCounterBookkeepingDue (pure)', () => {
    expect(threadCounterBookkeepingDue({ ran: false, hasState: true })).toBe(true);
    expect(threadCounterBookkeepingDue({ ran: true, hasState: true })).toBe(false);
    expect(threadCounterBookkeepingDue({ ran: false, hasState: false })).toBe(false);
    expect(threadCounterBookkeepingDue({ ran: false, hasState: true }, { THREAD_STATE_DEBOUNCE_FIX_DISABLED: '1' } as any)).toBe(false);
  });
});

// Review 2026-10-23: the debounce fix restarted the thread extraction on human-typed CODING turns, and nothing on the
// coding path reads that summary. run-executor marks a born-coding session's turns skipThreadState.
describe('skipThreadState (a born-coding session)', () => {
  const coding = (n: number) => (async () => {
    for (let i = 0; i < n; i++) {
      await runUpdateContextPipeline({ userId: 'u1', projectId: null, chatId: CHAT, userMessage: USER_MSG, synthesis: ANSWER, skipThreadState: true });
      resetProfileExtractionThrottle();
    }
  })();

  it('no thread LLM call, the counter still advances and the user cadence is the designed one (stored 12)', async () => {
    await coding(10);
    expect(threadPrompts()).toHaveLength(0);
    expect(storedThread().messageCount).toBe(32);
    expect(storedThread().threadSummary).toBe('stale summary from turn 6');
    expect(fullPrompts()).toHaveLength(2);
  });

  it('a session with NO thread row gets a counter-only row (empty summary) — never "turn 1" forever', async () => {
    store.clear();
    await coding(10);
    expect(threadPrompts()).toHaveLength(0);
    expect(storedThread()).toMatchObject({ messageCount: 20, threadSummary: '' });
    // Bootstrap (2, 4, 6) + 12 + 18 — not a full extraction on every turn.
    expect(fullPrompts()).toHaveLength(5);
  });

  it('THREAD_STATE_DEBOUNCE_FIX_DISABLED=1 ignores the flag (the previous behaviour)', async () => {
    process.env.THREAD_STATE_DEBOUNCE_FIX_DISABLED = '1';
    store.clear();
    await turns(3);
    const without = threadPrompts().length;
    const stateWithout = storedThread();
    expect(without).toBeGreaterThan(0);
    mockUtilityChat.mockClear(); store.clear(); summaryN = 0;
    await coding(3);
    expect(threadPrompts()).toHaveLength(without);
    expect(storedThread()).toEqual({ ...stateWithout, lastUpdated: storedThread().lastUpdated });
  });
});

// Review 2026-10-23 (privacy): updateContextAsync is fire-and-forget, so a thread extraction still in its
// utilityChat call when the user deletes the chat (or the account) used to re-create [chatId,'thread'] AFTER the
// delete path's storeDeleteChatScoped — an orphan summary of a deleted chat with no FK, no TTL and no sweep.
describe('a chat deleted while its thread extraction runs', () => {
  it('the late save removes the row it just wrote (write-then-check); a live chat keeps it; an unreadable chat row keeps it', async () => {
    store.set(key([CHAT, 'thread'], 'state'), { threadSummary: 'before', confirmedFacts: {}, openTopics: [], lastUserGoal: '', messageCount: 14, lastUpdated: '2026-10-01T00:00:00.000Z' });
    mockUtilityChat.mockImplementation(async (messages: Array<{ content: string }>) => {
      const p = messages[0].content;
      if (p.includes('conversation thread summary')) {
        // The user deletes the chat mid-extraction: the row is gone and the delete path already swept the store.
        mockChatFind.mockImplementation(async () => null);
        store.delete(key([CHAT, 'thread'], 'state'));
        return JSON.stringify({ threadSummary: 'summary of a deleted chat', confirmedFacts: { secret: 'value' }, openTopics: ['topic'], lastUserGoal: 'x', messageCount: 0, lastUpdated: '' });
      }
      return '{}';
    });
    try {
      await runUpdateContextPipeline({ userId: 'u1', projectId: null, chatId: CHAT, userMessage: USER_MSG, synthesis: ANSWER });
      expect(threadPrompts()).toHaveLength(1);
      expect(storedThread()).toBeUndefined();
    } finally {
      mockChatFind.mockImplementation(async ({ where }: any) => ({ id: where.id }));
    }
    // A live chat keeps its save; a chat lookup that FAILS keeps it too (never a delete on an unknown).
    routeLLM();
    store.set(key([CHAT, 'thread'], 'state'), { threadSummary: 'before', confirmedFacts: {}, openTopics: [], lastUserGoal: '', messageCount: 14, lastUpdated: '2026-10-01T00:00:00.000Z' });
    await runUpdateContextPipeline({ userId: 'u1', projectId: null, chatId: CHAT, userMessage: USER_MSG, synthesis: ANSWER });
    expect(storedThread()?.messageCount).toBe(16);
    mockChatFind.mockImplementationOnce(async () => { throw new Error('db blip'); });
    store.set(key([CHAT, 'thread'], 'state'), { threadSummary: 'before', confirmedFacts: {}, openTopics: [], lastUserGoal: '', messageCount: 14, lastUpdated: '2026-10-01T00:00:00.000Z' });
    await runUpdateContextPipeline({ userId: 'u1', projectId: null, chatId: CHAT, userMessage: USER_MSG, synthesis: ANSWER });
    expect(storedThread()?.messageCount).toBe(16);
  });
});
