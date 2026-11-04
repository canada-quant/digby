/**
 * updateContext pipeline — machineRun + decisions → unified store (2026-09-14).
 *
 * Pins:
 *  - machineRun:true runs ONLY project-state extraction (no user facts, no
 *    thread state, no user-scope conversation distill — a wake prompt must never
 *    enter user memory) and labels the trigger as an automated prompt.
 *  - Newly extracted decisions are memStore'd once: scope project, source
 *    'decision', ref 'decision:<yyyy-mm-dd>:<slug>', short title, userId +
 *    skipGate; a second identical run (and a mere rephrase) writes nothing.
 *  - Chat runs (machineRun unset) keep the full user + thread + project path
 *    and ALSO file decisions.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
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

const mockMemStore: jest.Mock = jest.fn();
const mockEnforceScopeCap: jest.Mock = jest.fn(async () => {});
jest.mock('../memory/unified-memory.service', () => ({
  memStore: (...a: any[]) => mockMemStore(...a),
  enforceScopeCap: (...a: any[]) => mockEnforceScopeCap(...a),
}));

// Env-heavy transitive imports (user-facts → config/redis → config/env exits
// the process without env vars).
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
jest.mock('../memory/context-store', () => ({
  storeGet: (...a: any[]) => mockStoreGet(...a),
  storePut: (...a: any[]) => mockStorePut(...a),
}));
jest.mock('../platform/folder-inheritance', () => ({ getMergedProjectStoreState: jest.fn() }));

import {
  runUpdateContextPipeline,
  diffNewDecisions,
  decisionRef,
  decisionSlug,
  isSameDecision,
  buildDecisionMemoryItems,
  DECISION_SOURCE,
} from './memory.graph';
// The profile leg's per-user throttle is process state — each test starts clean (2026-10-20).
import { resetProfileExtractionThrottle } from '../memory/profile-guard';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const D1 = 'Adopted pgvector HNSW for the unified memory index';
const D2 = 'Coding runs read project decisions via search_memory source decision';
const D3 = 'Kill switches for new memory injection paths are env vars';

function projectState(decisions: string[]) {
  return {
    summary: 'Digby memory system work',
    recentDecisions: decisions,
    entities: { people: [], amounts: [], places: [], topics: ['memory'] },
    openItems: [],
    lastUpdated: '2026-09-14T00:00:00.000Z',
  };
}

const MACHINE_FINAL = [
  'Run report: indexed 27 projects into digby_memory (source code + learning), verified HNSW index present,',
  'and wired search_memory to read source decision. Files: unified-memory.service.ts, coding-retrieval.service.ts.',
  'Commands: npx jest memory — 41 passing. Decision: pgvector HNSW stays the unified index.',
].join(' ');

const CHAT_FINAL = 'A'.repeat(320) + ' — we decided to use pgvector HNSW for the unified index and to have coding runs read decisions via search_memory.';

/** Route the utility LLM by prompt so each extraction step gets a valid reply. */
function routeLLM(nextProjectState: unknown) {
  mockUtilityChat.mockImplementation(async (messages: Array<{ content: string }>) => {
    const p = messages[0].content;
    if (p.includes('maintaining a project knowledge base')) return JSON.stringify(nextProjectState);
    if (p.includes('maintain a user profile')) return JSON.stringify({ summary: 'engineer', preferences: '', currentFocus: '', recentTopics: [], communicationStyle: 'terse' });
    if (p.includes('memory manager')) return JSON.stringify({ add: {}, remove: [], reject: [] });
    if (p.includes('conversation thread summary')) return JSON.stringify({ threadSummary: 's', confirmedFacts: {}, openTopics: [], lastUserGoal: 'g', messageCount: 8, lastUpdated: '' });
    if (p.includes('Normalize this finished AI-chat exchange')) return JSON.stringify({ question: 'How is memory indexed?', summary: 'pgvector HNSW', resolution: 'HNSW', refs: [] });
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

const projectPuts = () => mockStorePut.mock.calls.filter(c => c[0][1] === 'context');
const userPuts = () => mockStorePut.mock.calls.filter(c => c[0][1] === 'memory');
const threadPuts = () => mockStorePut.mock.calls.filter(c => c[0][1] === 'thread');
const projectPrompts = () => mockUtilityChat.mock.calls.filter(c => c[0][0].content.includes('maintaining a project knowledge base'));
const decisionStores = () => mockMemStore.mock.calls.filter(c => c[1] === DECISION_SOURCE);
const conversationStores = () => mockMemStore.mock.calls.filter(c => c[1] === 'conversation');

const flush = () => new Promise(r => setImmediate(r));

beforeEach(() => {
  jest.clearAllMocks();
  resetProfileExtractionThrottle();
  mockMemStore.mockResolvedValue(1);
  mockStorePut.mockResolvedValue(undefined);
  mockFindUnique.mockResolvedValue(null);
  mockUpsert.mockResolvedValue(undefined);
});

// ── machineRun ────────────────────────────────────────────────────────────────

describe('runUpdateContextPipeline — machineRun', () => {
  const input = {
    userId: 'u1', projectId: 'p1', chatId: 'c1',
    userMessage: '[SCHEDULED WAKE] Run the nightly memory audit and report.',
    synthesis: MACHINE_FINAL,
    machineRun: true,
  };

  it('extracts project state ONLY — no user facts, no thread state, no conversation distill', async () => {
    storeReturns({ project: null });
    routeLLM(projectState([D1, D2]));

    await runUpdateContextPipeline(input);
    await flush();

    // Exactly one LLM call: the project extraction, with the trigger labeled as automated.
    expect(mockUtilityChat).toHaveBeenCalledTimes(1);
    const prompt: string = mockUtilityChat.mock.calls[0][0][0].content;
    expect(prompt).toContain('maintaining a project knowledge base');
    expect(prompt).toContain('AUTOMATED run prompt');
    expect(prompt).toContain('never plans, intentions or unverified claims');
    expect(prompt).not.toContain('maintain a user profile');

    // Project state saved; user + thread state neither loaded nor written.
    expect(projectPuts()).toHaveLength(1);
    expect(projectPuts()[0][0]).toEqual(['p1', 'context']);
    expect(userPuts()).toHaveLength(0);
    expect(threadPuts()).toHaveLength(0);
    expect(mockStoreGet.mock.calls.some(c => c[0][1] === 'memory' || c[0][1] === 'thread')).toBe(false);
    expect(mockFindUnique).not.toHaveBeenCalled();
    expect(mockUpsert).not.toHaveBeenCalled();

    // No user-scope conversation record from a machine prompt.
    expect(conversationStores()).toHaveLength(0);
  });

  it('files each new decision once into the project scope with source "decision"', async () => {
    storeReturns({ project: null });
    routeLLM(projectState([D1, D2]));

    await runUpdateContextPipeline(input);

    expect(decisionStores()).toHaveLength(1);
    const [scope, source, items, opts] = decisionStores()[0];
    expect(scope).toEqual({ type: 'project', id: 'p1' });
    expect(source).toBe('decision');
    // skipCap is load-bearing: the project scope is shared with the code index
    // (EOD review 2026-09-14 — the missing flag deleted ~17.6k rows in prod).
    expect(opts).toEqual({ userId: 'u1', skipGate: true, skipCap: true });
    expect(mockEnforceScopeCap).toHaveBeenCalledWith({ type: 'project', id: expect.any(String) }, 500, 'decision');
    expect(items).toHaveLength(2);
    for (const it of items) {
      expect(it.ref).toMatch(/^decision:\d{4}-\d{2}-\d{2}:[a-z0-9-]+$/);
      expect(it.title.length).toBeGreaterThan(0);
      expect(it.title.length).toBeLessThanOrEqual(90);
      expect(it.content).toContain("coding run's accepted final");
    }
    expect(items.map((i: any) => i.title)).toEqual([D1, D2]);
  });

  it('a second identical run writes NOTHING new to the unified store (state still refreshed)', async () => {
    storeReturns({ project: projectState([D1, D2]) });
    routeLLM(projectState([D1, D2]));

    await runUpdateContextPipeline(input);

    expect(projectPuts()).toHaveLength(1);
    expect(mockMemStore).not.toHaveBeenCalled();
  });

  it('a rephrased existing decision is not re-filed; only the genuinely new one is', async () => {
    storeReturns({ project: projectState([D1]) });
    routeLLM(projectState(['Adopted pgvector (HNSW) for the unified memory index.', D3]));

    await runUpdateContextPipeline(input);

    expect(decisionStores()).toHaveLength(1);
    const items = decisionStores()[0][2];
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe(D3);
  });

  it('reads a wider slice of the machine final than a chat answer gets', async () => {
    const marker = 'MARKER_AT_1500';
    const longFinal = 'x'.repeat(1500) + marker + 'y'.repeat(300);
    storeReturns({ project: null });
    routeLLM(projectState([]));

    await runUpdateContextPipeline({ ...input, synthesis: longFinal });
    expect(projectPrompts()[0][0][0].content).toContain(marker);

    jest.clearAllMocks();
    mockStorePut.mockResolvedValue(undefined);
    storeReturns({ project: null });
    routeLLM(projectState([]));
    await runUpdateContextPipeline({ ...input, machineRun: false, synthesis: longFinal });
    expect(projectPrompts()[0][0][0].content).not.toContain(marker);
  });

  it('outside a project a machine run extracts nothing at all', async () => {
    storeReturns({});
    routeLLM(projectState([D1]));

    await runUpdateContextPipeline({ ...input, projectId: null });
    await flush();

    expect(mockUtilityChat).not.toHaveBeenCalled();
    expect(mockStorePut).not.toHaveBeenCalled();
    expect(mockMemStore).not.toHaveBeenCalled();
  });

  it('a trivially short machine final skips the LLM call', async () => {
    storeReturns({ project: null });
    routeLLM(projectState([D1]));

    await runUpdateContextPipeline({ ...input, synthesis: 'No changes needed.' });

    expect(mockUtilityChat).not.toHaveBeenCalled();
    expect(mockMemStore).not.toHaveBeenCalled();
  });

  it('a memStore failure degrades recall, never the pipeline', async () => {
    storeReturns({ project: null });
    routeLLM(projectState([D1]));
    mockMemStore.mockRejectedValue(new Error('embed down'));

    await expect(runUpdateContextPipeline(input)).resolves.toBeUndefined();
    expect(projectPuts()).toHaveLength(1);
  });
});

// ── Chat runs (machineRun unset) keep the full path and also file decisions ────

describe('runUpdateContextPipeline — interactive chat run (machineRun unset)', () => {
  const input = {
    userId: 'u1', projectId: 'p1', chatId: 'c1',
    userMessage: 'Which index should the unified memory store use for vectors?',
    synthesis: CHAT_FINAL,
  };

  it('runs user + thread + project extraction and files decisions with chat provenance', async () => {
    storeReturns({ project: null, thread: null, user: null });
    routeLLM(projectState([D1]));

    await runUpdateContextPipeline(input);
    await flush();

    expect(userPuts()).toHaveLength(1);
    expect(threadPuts()).toHaveLength(1);
    expect(projectPuts()).toHaveLength(1);
    expect(projectPrompts()[0][0][0].content).not.toContain('AUTOMATED run prompt');

    expect(decisionStores()).toHaveLength(1);
    const [scope, , items, opts] = decisionStores()[0];
    expect(scope).toEqual({ type: 'project', id: 'p1' });
    expect(items[0].content).toContain('from a chat');
    // skipCap is load-bearing: the project scope is shared with the code index
    // (EOD review 2026-09-14 — the missing flag deleted ~17.6k rows in prod).
    expect(opts).toEqual({ userId: 'u1', skipGate: true, skipCap: true });
    expect(mockEnforceScopeCap).toHaveBeenCalledWith({ type: 'project', id: expect.any(String) }, 500, 'decision');

    // The user-scope conversation distill still runs for real chats.
    expect(conversationStores()).toHaveLength(1);
    expect(conversationStores()[0][0]).toEqual({ type: 'user', id: 'u1' });
  });
});

// ── 2026-10-20 real-user audit: a plain chat in the hidden user space writes no project memory ──

describe('runUpdateContextPipeline — skipProjectState (a plain user-space chat)', () => {
  const input = {
    userId: 'u1', projectId: 'userspace', chatId: 'c1',
    userMessage: 'make me a logo for Happy Tails dog walking, teal and orange',
    synthesis: CHAT_FINAL,
    skipProjectState: true,
  };

  it('a chat turn keeps user + thread memory but neither loads nor writes project state, and files no decision rows', async () => {
    storeReturns({ project: projectState([D3]), thread: null, user: null });
    routeLLM(projectState([D1]));

    await runUpdateContextPipeline(input);
    await flush();

    expect(userPuts()).toHaveLength(1);
    expect(threadPuts()).toHaveLength(1);
    expect(projectPrompts()).toHaveLength(0);
    expect(projectPuts()).toHaveLength(0);
    expect(decisionStores()).toHaveLength(0);
    expect(mockStoreGet.mock.calls.some(c => c[0][1] === 'context')).toBe(false);
    // The extractor's currentFocus guard still keys on projectId (set) — the global profile is not overwritten.
    expect(conversationStores()).toHaveLength(1);
  });

  it('a machine wake into such a chat extracts nothing', async () => {
    storeReturns({ project: null });
    routeLLM(projectState([D1, D2]));
    await runUpdateContextPipeline({ ...input, machineRun: true, synthesis: MACHINE_FINAL });
    await flush();
    expect(mockUtilityChat).not.toHaveBeenCalled();
    expect(mockStorePut).not.toHaveBeenCalled();
    expect(mockMemStore).not.toHaveBeenCalled();
  });
});

// ── Pure helpers ──────────────────────────────────────────────────────────────

describe('decision helpers', () => {
  it('diffNewDecisions: drops known, placeholder and stub entries; keeps the new one', () => {
    expect(diffNewDecisions(
      ['Use Postgres for the main DB'],
      ['Use Postgres for the main DB', 'none', 'N/A', '(no decisions yet)', 'short', 'Adopt Redis for the session cache'],
    )).toEqual(['Adopt Redis for the session cache']);
  });

  it('diffNewDecisions: tolerates non-arrays and dedupes within the batch', () => {
    expect(diffNewDecisions(undefined, 'not an array')).toEqual([]);
    expect(diffNewDecisions(null, [D1, `${D1}.`, D1.toUpperCase()])).toEqual([D1]);
  });

  it('isSameDecision: curly quotes, punctuation and case do not make a new decision', () => {
    expect(isSameDecision('Don’t use Cohere for rerank', "don't use cohere for rerank!")).toBe(true);
    expect(isSameDecision('Use pgvector HNSW for the unified index', 'Use pgvector HNSW for the unified memory index')).toBe(true);
    expect(isSameDecision('Use pgvector for vectors', 'Use Redis for the session cache')).toBe(false);
  });

  it('decisionRef: decision:<yyyy-mm-dd>:<slug>, slug cut at a word boundary', () => {
    const when = new Date('2026-09-14T12:00:00Z');
    expect(decisionRef(D1, when)).toBe('decision:2026-09-14:adopted-pgvector-hnsw-for-the-unified-memory');
    expect(decisionSlug('Use Redis')).toBe('use-redis');
    expect(decisionSlug('!!!')).toBe('decision');
  });

  it('buildDecisionMemoryItems: short title, provenance-stamped content, dated ref', () => {
    const when = new Date('2026-09-14T12:00:00Z');
    const long = 'We decided that every new memory injection path ships behind an environment kill switch so operators can disable it without a deploy';
    const [a, b] = buildDecisionMemoryItems([D1, long], { origin: 'machine_run', when });
    expect(a.title).toBe(D1);
    expect(a.ref).toBe('decision:2026-09-14:adopted-pgvector-hnsw-for-the-unified-memory');
    expect(a.content).toBe(`Project decision (recorded 2026-09-14 from a coding run's accepted final): ${D1}`);
    const bTitle = b.title ?? '';
    expect(bTitle.length).toBeGreaterThan(0);
    expect(bTitle.length).toBeLessThanOrEqual(90);
    expect(bTitle.endsWith('…')).toBe(true);
    expect(b.content).toContain(long);
    expect(buildDecisionMemoryItems([D1], { origin: 'chat', when })[0].content).toContain('from a chat');
  });
});
