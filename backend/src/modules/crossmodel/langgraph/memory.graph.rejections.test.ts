/**
 * 2026-09-15 memory-wipe incident — the owner's personal memory went to ZERO facts.
 *
 * Chain: the extractor returned "reject" topics it never should have — parrots
 * of this prompt's own examples ("joint health", "plant-based", "ACL",
 * "vegan") and fleet chatter lifted from supervisor-chat answers ("steer
 * received 17:58Z", "ticket b216475a", "platform gate error"); every save
 * appended them to __rejections; buildRejectionKeywords turned every ≥3-char
 * word of every rejection into a scrub keyword ("time", "status", "project",
 * "chat", "side", "based"…); the programmatic scrub then deleted every real
 * fact on every save. Pins:
 *  - groundRejections keeps a rejection ONLY when the user's own message carries
 *    a forget/deny cue AND the topic's words; lists and sentences never qualify.
 *  - buildRejectionKeywords: the phrase always scrubs; single words only when
 *    specific (≥4 chars, not generic).
 *  - a real user turn in a SUPERVISOR chat never reaches personal extraction.
 *  - the rebuild reads the user's own exchanges (oldest first, machine text and
 *    supervisor/coding chats excluded) through the extractor.
 */

const mockLoggerError: jest.Mock = jest.fn();
jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: (...a: any[]) => mockLoggerError(...a), debug: jest.fn() },
}));

const mockFindUnique: jest.Mock = jest.fn();
const mockUpsert: jest.Mock = jest.fn();
const mockChatFindMany: jest.Mock = jest.fn();
const mockMessageFindMany: jest.Mock = jest.fn();
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    userMemory: { findUnique: (...a: any[]) => mockFindUnique(...a), upsert: (...a: any[]) => mockUpsert(...a) },
    crossModelChat: { findMany: (...a: any[]) => mockChatFindMany(...a) },
    crossModelMessage: { findMany: (...a: any[]) => mockMessageFindMany(...a) },
  },
}));
const mockRedisSet: jest.Mock = jest.fn(async () => 'OK');
const mockRedisDel: jest.Mock = jest.fn(async () => 1);
jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: { set: (...a: any[]) => mockRedisSet(...a), del: (...a: any[]) => mockRedisDel(...a), get: jest.fn(async () => null) },
}));
jest.mock('../context.service', () => ({
  __esModule: true,
  default: {
    loadChatContext: jest.fn(async () => ({ conversationHistory: [] })),
    getUserMemoryBlock: jest.fn(async () => ''),
  },
  capHistoryToCharBudget: jest.fn(),
  MACHINE_WAKE_HISTORY_CHAR_BUDGET: 0,
  MACHINE_WAKE_MAX_PAIRS: 0,
}));

const mockUtilityChat: jest.Mock = jest.fn();
jest.mock('../../../utils/utility-llm', () => ({ utilityChat: (...a: any[]) => mockUtilityChat(...a) }));

jest.mock('../memory/unified-memory.service', () => ({
  memStore: jest.fn(),
  enforceScopeCap: jest.fn(async () => {}),
}));
const mockSelectRelevantFacts: jest.Mock = jest.fn();
jest.mock('../memory/user-facts.service', () => ({
  selectRelevantFacts: (...a: any[]) => mockSelectRelevantFacts(...a),
  syncUserFactRows: jest.fn(),
}));
const mockBuildEpisodicBlock: jest.Mock = jest.fn();
jest.mock('../memory/episodic.service', () => ({ buildEpisodicBlock: (...a: any[]) => mockBuildEpisodicBlock(...a) }));
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
const mockRecordMemoryMutation: jest.Mock = jest.fn();
const mockRecordExtractionOutcome: jest.Mock = jest.fn();
jest.mock('../memory/memory-audit', () => ({
  recordMemoryMutation: (...a: any[]) => mockRecordMemoryMutation(...a),
  recordExtractionOutcome: (...a: any[]) => mockRecordExtractionOutcome(...a),
  parseModelJson: (text: unknown) => { const raw = String(text ?? '').replace(/```json\n?|\n?```/g, '').trim(); if (!raw) return null; try { return JSON.parse(raw); } catch {} const a = raw.indexOf('{'), b = raw.lastIndexOf('}'); if (a >= 0 && b > a) { try { return JSON.parse(raw.slice(a, b + 1)); } catch {} } return null; },
  countVisibleFacts: (facts: Record<string, unknown>) => Object.keys(facts || {}).filter((k) => !k.startsWith('__')).length,
}));

import {
  groundRejections,
  groundRemovals,
  buildRejectionKeywords,
  FORGET_CUE_RE,
  getEnrichedContext,
  runUpdateContextPipeline,
  loadRebuildExchanges,
  startUserMemoryRebuild,
  REBUILD_KEY,
} from './memory.graph';

const FLEET_JUNK = 'steer received 17:58Z,forward-stamped time,filed 3 framework tickets,fresh get_feedback,queue,ticket b216475a,github repo creation attempt,project attachment to chat,workspace attachment requirement,platform gate error,side project repo status,coding workspace attachment,movie interpretation,film analysis,joint health,ACL,plant-based,diet: plant based,diet: vegan,diet: vegetarian';

beforeEach(() => {
  jest.clearAllMocks();
  mockRedisSet.mockResolvedValue('OK');
  mockStoreGet.mockResolvedValue(null);
  mockStorePut.mockResolvedValue(undefined);
});

// ── groundRejections ──────────────────────────────────────────────────────────

describe('groundRejections — a rejection must be the USER\'s own decision', () => {
  it('drops everything when the user did not ask to forget/deny anything (the incident shape: fleet chatter + prompt-example parrots)', () => {
    const userMessage = 'why do i see zero sessions working…this is a very critical project and need all hands on deck';
    expect(groundRejections([FLEET_JUNK, 'joint health', 'ACL', 'plant-based', 'vegan', 'vegetarian'], userMessage)).toEqual([]);
  });

  it('keeps a topic the user explicitly denied, in their words', () => {
    expect(groundRejections(['ACL', 'joint health'], "stop talking about my joints/ACL, I'm fine now")).toEqual(['ACL', 'joint health']);
    expect(groundRejections(['plant-based', 'vegan'], "I'm not plant based anymore")).toEqual(['plant-based']);
  });

  it('a forget cue alone is not enough — the topic\'s words must be in the user\'s message (prompt-example parrots die here)', () => {
    expect(groundRejections(['joint health', 'ACL', 'plant-based'], 'forget what I said about my brother')).toEqual([]);
  });

  it('a comma-joined list or a sentence-length "topic" is never a rejection', () => {
    expect(groundRejections([FLEET_JUNK], 'forget the ticket b216475a and the queue')).toEqual([]);
    expect(groundRejections(['please stop mentioning the whole story about my move to montreal last year ok'], 'stop mentioning my move to montreal')).toEqual([]);
  });

  it('tolerates the model-written shapes normalizeRejections knows (bare string, object) and caps at 5', () => {
    expect(groundRejections('ACL', 'forget my ACL')).toEqual(['ACL']);
    expect(groundRejections({ a: 'ACL' }, 'forget my ACL')).toEqual(['ACL']);
    const many = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot'];
    expect(groundRejections(many, `forget alpha bravo charlie delta echo foxtrot`)).toHaveLength(5);
  });

  it.each([
    "I'm not vegan", 'forget that', "don't remember my address", 'stop talking about my joints', 'that\'s not me', 'remove my old job', 'I no longer live in Toronto', 'that is incorrect',
  ])('FORGET_CUE_RE recognizes: %s', (msg) => {
    expect(FORGET_CUE_RE.test(msg)).toBe(true);
  });
  it.each(['what is the weather in montreal', 'can we benchmark the dflash2E recipe', 'ok and how is the fleet supervisor doing'])('FORGET_CUE_RE does not fire on: %s', (msg) => {
    expect(FORGET_CUE_RE.test(msg)).toBe(false);
  });
});

// ── buildRejectionKeywords ────────────────────────────────────────────────────

describe('groundRemovals — a `remove` is the USER\'s decision, never the model\'s (2026-09-21: 3 facts left, no trail)', () => {
  const existing = { name: 'Paul', location: 'Oak Bay, Canada', annual_family_trip: 'Four Seasons Lanai every year', role: 'Head of AI Cloud' };

  it('drops every removal when the user said nothing about forgetting or correcting (the churn shape)', () => {
    const r = groundRemovals(['annual_family_trip', 'role'], existing, {}, 'can you spin up on this reservation aws - cr-0b6b6d0b6c80f6c7d');
    expect(r.kept).toEqual([]);
    expect(r.dropped).toEqual(['annual_family_trip', 'role']);
  });

  it('keeps a removal the user asked for in their own words (cue + the fact\'s words)', () => {
    const r = groundRemovals(['annual_family_trip'], existing, {}, "forget the Lanai trip, we don't go anymore");
    expect(r.kept).toEqual(['annual_family_trip']);
    expect(r.dropped).toEqual([]);
  });

  it('a cue alone is not enough — the removed fact must be named', () => {
    const r = groundRemovals(['role', 'annual_family_trip'], existing, {}, "I'm not vegan, stop saying that");
    expect(r.kept).toEqual([]);
    expect(r.dropped).toEqual(['role', 'annual_family_trip']);
  });

  it('an in-place correction (same key also added) is always honoured, no cue needed', () => {
    const r = groundRemovals(['location'], existing, { Location: 'Victoria, BC' }, 'we moved to Victoria last month');
    expect(r.kept).toEqual(['location']);
  });

  it('unknown keys and non-string junk are ignored; matching is case-insensitive', () => {
    const r = groundRemovals(['Role', 'nonexistent', 42 as any, null as any], existing, {}, 'forget my role as head of AI cloud, I left');
    expect(r.kept).toEqual(['role']);
    expect(r.dropped).toEqual([]);
  });

  it('never proposes deleting internal bookkeeping keys', () => {
    const r = groundRemovals(['__rejections', '__dream'], { ...existing, __dream: {}, __rejections: [] }, {}, 'forget the dream rejections');
    expect(r).toEqual({ kept: [], dropped: [] });
  });
});

describe('buildRejectionKeywords — the phrase scrubs; only specific words scrub on their own', () => {
  it('the incident list no longer yields generic scrub words', () => {
    const kw = buildRejectionKeywords([FLEET_JUNK]);
    for (const generic of ['time', 'status', 'project', 'chat', 'side', 'based', 'queue', 'ticket', 'error', 'gate', 'fresh', 'filed', 'attempt', 'analysis']) {
      expect(kw.has(generic)).toBe(false);
    }
    expect(kw.has(FLEET_JUNK.toLowerCase())).toBe(true); // the literal phrase still scrubs itself
  });

  it('keeps specific words and the phrase for a real rejection', () => {
    const kw = buildRejectionKeywords(['joint health', 'ACL', 'diet: vegan']);
    expect(kw.has('joint health')).toBe(true);
    expect(kw.has('joint')).toBe(true);
    expect(kw.has('health')).toBe(true);
    expect(kw.has('acl')).toBe(true); // single-word rejection survives as the phrase itself
    expect(kw.has('vegan')).toBe(true);
    expect(kw.has('diet')).toBe(true); // 4 chars, specific enough — "I'm not plant based → remove all diet facts"
  });
});

// ── supervisorChat skip ───────────────────────────────────────────────────────

describe('runUpdateContextPipeline — a real user turn in a supervisor chat never reaches personal extraction', () => {
  it('supervisorChat:true (no project) makes no user-memory read/write and no extraction call', async () => {
    mockFindUnique.mockResolvedValue({ facts: { name: 'Paul' } });
    await runUpdateContextPipeline({
      userId: 'u1', projectId: null, chatId: 'fleet-chat', supervisorChat: true,
      userMessage: 'why do i see zero sessions working…this is a very critical project',
      synthesis: 'Zero running sessions was the HALT working as designed — steer received 17:58Z; filed 3 framework tickets; ticket b216475a.',
    });
    // The user-scope conversation distill may call the utility model; the PERSONAL extractor must not have written.
    expect(mockUpsert).not.toHaveBeenCalled();
    const prompts = mockUtilityChat.mock.calls.map((c) => String(c[0]?.[0]?.content ?? ''));
    expect(prompts.some((p) => p.includes('You are a memory manager for an AI assistant'))).toBe(false);
  });
});

// ── rebuild ───────────────────────────────────────────────────────────────────

describe('memory rebuild from the user\'s own conversations', () => {
  const at = (s: string) => new Date(s);
  const rows = [
    // chat A: a real exchange
    { chatId: 'a', role: 'user', content: "My name is Paul and I live in Montreal — remember that.", createdAt: at('2026-09-01T10:00:00Z'), metadata: null },
    { chatId: 'a', role: 'assistant', content: 'Got it, Paul in Montreal.', createdAt: at('2026-09-01T10:00:05Z'), metadata: null },
    // chat A: a machine wake in a user role must never count
    { chatId: 'a', role: 'user', content: '[MACHINE-TRIGGERED RUN — no user is on this turn…] do the sweep', createdAt: at('2026-09-02T10:00:00Z'), metadata: { origin: 'schedule' } },
    { chatId: 'a', role: 'assistant', content: 'WAKE: no-op', createdAt: at('2026-09-02T10:00:05Z'), metadata: { origin: 'schedule' } },
    // chat A: a card in assistant role must not be the "answer"
    { chatId: 'a', role: 'user', content: 'and what do I usually drink in the morning?', createdAt: at('2026-09-03T10:00:00Z'), metadata: null },
    { chatId: 'a', role: 'assistant', content: '**Project status card**', createdAt: at('2026-09-03T10:00:01Z'), metadata: { origin: 'project_status' } },
    { chatId: 'a', role: 'assistant', content: 'You usually drink an espresso.', createdAt: at('2026-09-03T10:00:05Z'), metadata: null },
    // chat B: too-short user turn is skipped
    { chatId: 'b', role: 'user', content: 'ok', createdAt: at('2026-09-04T10:00:00Z'), metadata: null },
    { chatId: 'b', role: 'assistant', content: 'Sure.', createdAt: at('2026-09-04T10:00:05Z'), metadata: null },
  ];

  it('loadRebuildExchanges pairs real user turns with the next real answer, oldest first, from non-supervisor non-coding chats only', async () => {
    mockChatFindMany.mockResolvedValue([{ id: 'a' }, { id: 'b' }]);
    mockMessageFindMany.mockResolvedValue([...rows].reverse()); // the query orders newest first
    const pairs = await loadRebuildExchanges('u1');
    expect(mockChatFindMany).toHaveBeenCalledWith(expect.objectContaining({
      // ghostMode:false joined the exclusion (owner 2026-10-22): a ghost chat's exchanges are never re-mined.
      where: { userId: 'u1', isSupervisor: false, isProjectSupervisor: false, archivedAt: null, codingState: { is: null }, ghostMode: false },
    }));
    expect(pairs.map((p) => p.userMessage)).toEqual([
      'My name is Paul and I live in Montreal — remember that.',
      'and what do I usually drink in the morning?',
    ]);
    expect(pairs[1].synthesis).toBe('You usually drink an espresso.'); // the card was skipped, the real answer taken
  });

  it('startUserMemoryRebuild runs the extractor once per exchange under a per-user lock and records __rebuild bookkeeping', async () => {
    mockChatFindMany.mockResolvedValue([{ id: 'a' }]);
    mockMessageFindMany.mockResolvedValue([...rows].reverse());
    // The blob evolves as the job writes it.
    let facts: Record<string, any> = {};
    mockFindUnique.mockImplementation(async () => ({ facts }));
    mockUpsert.mockImplementation(async ({ update }: any) => { facts = update.facts; return { facts }; });
    mockUtilityChat
      .mockResolvedValueOnce(JSON.stringify({ add: { name: 'Paul', location: 'Montreal' }, remove: [], reject: [] }))
      .mockResolvedValueOnce(JSON.stringify({ add: { morning_drink: 'espresso' }, remove: ['location'], reject: ['joint health'] })); // an ungrounded parrot + an ungrounded removal — both must be dropped
    const r = await startUserMemoryRebuild('u1', { wait: true });
    expect(r.started).toBe(true);
    expect(r.total).toBe(2);
    // the second exchange never asked to forget the location — the removal is dropped and audited
    expect(facts.location).toBe('Montreal');
    expect(mockRecordMemoryMutation).toHaveBeenCalledWith(expect.objectContaining({ source: 'rebuild', added: ['morning_drink'], removed: [], droppedRemovals: ['location'], before: 2, after: 3 }));
    expect(mockRedisSet).toHaveBeenCalledWith('memory:rebuild:u1', expect.any(String), { NX: true, EX: 45 * 60 });
    expect(mockRedisDel).toHaveBeenCalledWith('memory:rebuild:u1');
    expect(facts.name).toBe('Paul');
    expect(facts.location).toBe('Montreal');
    expect(facts.morning_drink).toBe('espresso');
    expect(facts.__rejections).toBeUndefined(); // the parroted rejection never landed
    expect(facts[REBUILD_KEY]).toEqual(expect.objectContaining({ total: 2, processed: 2, factsBefore: 0, factsAfter: 3 }));
    expect(facts[REBUILD_KEY].finishedAt).toBeTruthy();
    expect(r.status?.factsAfter).toBe(3);
  });

  it('every extractor call records an outcome — changed / noop / parse_error (prose is tolerated when it wraps JSON)', async () => {
    mockChatFindMany.mockResolvedValue([{ id: 'a' }]);
    mockMessageFindMany.mockResolvedValue([...rows].reverse());
    let facts: Record<string, any> = {};
    mockFindUnique.mockImplementation(async () => ({ facts }));
    mockUpsert.mockImplementation(async ({ update }: any) => { facts = update.facts; return { facts }; });
    mockUtilityChat
      .mockResolvedValueOnce('Here is the update:\n```json\n{"add": {"name": "Paul"}, "remove": [], "reject": []}\n```') // prose + fence → still parsed
      .mockResolvedValueOnce('I could not determine any facts.'); // no JSON at all → parse_error, audited, not silent
    await startUserMemoryRebuild('u1', { wait: true });
    expect(facts.name).toBe('Paul');
    // proposals run in parallel per batch (parse_error is recorded at proposal time, 'changed' at apply time) — order-insensitive
    const outcomes = mockRecordExtractionOutcome.mock.calls.map((c: any[]) => c[0].outcome).sort();
    expect(outcomes).toEqual(['changed', 'parse_error']);
    const parseErr = mockRecordExtractionOutcome.mock.calls.find((c: any[]) => c[0].outcome === 'parse_error')![0];
    expect(parseErr).toEqual(expect.objectContaining({ source: 'rebuild', detail: expect.stringContaining('could not determine') }));
    // the extractor opts into the utility model's reasoning (thinking-off answered {"add":{}} on plain statements)
    expect(mockUtilityChat.mock.calls[0][1]).toEqual(expect.objectContaining({ thinking: true, timeout: 90000 }));
  });

  it('a failing utility call is audited as llm_error and never throws out of the rebuild', async () => {
    mockChatFindMany.mockResolvedValue([{ id: 'a' }]);
    mockMessageFindMany.mockResolvedValue([...rows].reverse());
    mockFindUnique.mockResolvedValue({ facts: {} });
    mockUpsert.mockResolvedValue({ facts: {} });
    mockUtilityChat.mockRejectedValue(new Error('DeepSeek deepseek-flash HTTP 429: rate limited'));
    const r = await startUserMemoryRebuild('u1', { wait: true });
    expect(r.status?.processed).toBe(2);
    expect(mockRecordExtractionOutcome.mock.calls.map((c: any[]) => c[0].outcome)).toEqual(['llm_error', 'llm_error']);
    expect(mockRecordExtractionOutcome.mock.calls[0][0].detail).toContain('HTTP 429');
  });

  it('a second start while one runs is refused (lock held) and never touches the blob', async () => {
    mockRedisSet.mockResolvedValueOnce(null);
    const r = await startUserMemoryRebuild('u1');
    expect(r).toEqual({ started: false, reason: 'already_running', total: 0 });
    expect(mockChatFindMany).not.toHaveBeenCalled();
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it('no eligible history → not started, lock released', async () => {
    mockChatFindMany.mockResolvedValue([]);
    const r = await startUserMemoryRebuild('u1');
    expect(r).toEqual({ started: false, reason: 'no_history', total: 0 });
    expect(mockRedisDel).toHaveBeenCalledWith('memory:rebuild:u1');
  });
});

// ── getEnrichedContext read path ──────────────────────────────────────────────

describe('getEnrichedContext — 2026-09-14 read-path incident: a malformed stored __rejections must never drop the whole memory block', () => {
  // Prod 2026-09-14 (63 errors over 12:00–13:48Z, app_error_log): the model had
  // written facts.__rejections as a BARE STRING; formatUserMemoryBlock called
  // rejections.map → "rejections.map is not a function" → the getEnrichedContext
  // catch fell back to basic context (no user facts, no banned-topics guardrail)
  // on EVERY turn of the affected chat. Fixed on main by normalizeRejections at
  // every read site (62173bd6e: loadUserContextState, formatUserMemoryBlock,
  // buildRejectionKeywords); these pins fail if any of those normalizations
  // regresses — the extraction-side pins above do NOT cover this read path.
  const input = { userId: 'u1', chatId: 'c1', projectId: null, userMessage: 'what time is it in montreal' };
  const fallbackCalls = () =>
    mockLoggerError.mock.calls.filter((c) => String(c[0]).includes('getEnrichedContext failed'));

  beforeEach(() => {
    mockSelectRelevantFacts.mockResolvedValue({
      relevant: { name: 'Paul' }, withheldCount: 0, recallBypass: false, semantic: false,
    });
    mockBuildEpisodicBlock.mockResolvedValue('');
  });

  it('bare-string __rejections (the exact prod shape): enriched block survives, ban listed, facts intact', async () => {
    mockFindUnique.mockResolvedValue({ facts: { name: 'Paul', __rejections: 'time' } });
    const ctx = await getEnrichedContext(input);
    expect(fallbackCalls()).toEqual([]);
    expect(ctx.userMemoryBlock).toContain('⛔ time');
    expect(ctx.userMemoryBlock).toContain('name: Paul');
  });

  it('object-shaped __rejections (also seen from the model): normalized, no fallback', async () => {
    mockFindUnique.mockResolvedValue({ facts: { name: 'Paul', __rejections: { a: 'ACL' } } });
    const ctx = await getEnrichedContext(input);
    expect(fallbackCalls()).toEqual([]);
    expect(ctx.userMemoryBlock).toContain('⛔ ACL');
    expect(ctx.userMemoryBlock).toContain('name: Paul');
  });

  it('array shape (control): unchanged behaviour, no fallback', async () => {
    mockFindUnique.mockResolvedValue({ facts: { name: 'Paul', __rejections: ['ACL'] } });
    const ctx = await getEnrichedContext(input);
    expect(fallbackCalls()).toEqual([]);
    expect(ctx.userMemoryBlock).toContain('⛔ ACL');
    expect(ctx.userMemoryBlock).toContain('name: Paul');
  });
});

describe('getEnrichedContext — skipProjectState (2026-10-20: a plain user-space chat reads no shared project state)', () => {
  const { getMergedProjectStoreState } = jest.requireMock('../platform/folder-inheritance') as { getMergedProjectStoreState: jest.Mock };
  const STATE = { summary: 'Happy Tails dog walking', recentDecisions: ['Logo is teal + orange'], entities: {}, openItems: [], lastUpdated: '' };
  beforeEach(() => {
    mockSelectRelevantFacts.mockResolvedValue({ relevant: {}, withheldCount: 0, recallBypass: false, semantic: false });
    mockBuildEpisodicBlock.mockResolvedValue('');
    mockFindUnique.mockResolvedValue({ facts: {} });
    getMergedProjectStoreState.mockImplementation(async (_id: string, kind: string) => (kind === 'context' ? STATE : null));
  });

  it('a project chat gets the shared block; the same project with skipProjectState gets none and never loads it', async () => {
    const base = { userId: 'u1', chatId: 'c1', projectId: 'U', userMessage: 'make me a logo' };
    expect((await getEnrichedContext(base)).projectStateBlock).toContain('Happy Tails');
    getMergedProjectStoreState.mockClear();
    const ctx = await getEnrichedContext({ ...base, skipProjectState: true });
    expect(ctx.projectStateBlock).toBe('');
    expect(getMergedProjectStoreState.mock.calls.some((c) => c[1] === 'context')).toBe(false);
  });
});
