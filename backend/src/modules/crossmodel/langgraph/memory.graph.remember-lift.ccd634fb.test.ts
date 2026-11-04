/**
 * Ticket ccd634fb — nightly query suite 2026-10-06, case 02-memory-remember-recall-forget:
 *   "please remember that my favourite spice is saffron." → remember_fact stored favourite_spice
 *   "what is my favourite spice?" → "That's one I have to pass on — you've asked me to stop
 *   bringing up that topic".
 * The test account's blob carried __rejections ["favourite bird", "favourite season",
 * "favourite spice", "favourite board game"] from earlier nightly "please forget my favourite X"
 * turns; the ban rode every prompt as [BANNED TOPICS] beside the fact the user had just asked for.
 * And on 2026-10-04 15:39 the turn extractor's scrub deleted a freshly remembered favourite_spice
 * because the ban on "favourite bird" made the bare word "favourite" a scrub keyword.
 * Pins:
 *  - "favourite" / "favorite" are qualifiers, never a scrub word on their own (the phrase still is);
 *  - an explicit remember lifts exactly the bans that would scrub the stored fact;
 *  - the extractor lifts a ban only when the user's own message asks to remember it;
 *  - MEMORY_REMEMBER_LIFTS_REJECTION_DISABLED=1 restores the old behaviour.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockFindUnique: jest.Mock = jest.fn();
const mockUpsert: jest.Mock = jest.fn();
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    userMemory: { findUnique: (...a: any[]) => mockFindUnique(...a), upsert: (...a: any[]) => mockUpsert(...a) },
  },
}));
jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: { set: jest.fn(async () => 'OK'), del: jest.fn(async () => 1), get: jest.fn(async () => null) },
}));
jest.mock('../context.service', () => ({
  __esModule: true,
  default: { loadChatContext: jest.fn(async () => ({ conversationHistory: [] })), getUserMemoryBlock: jest.fn(async () => '') },
  capHistoryToCharBudget: jest.fn(),
  MACHINE_WAKE_HISTORY_CHAR_BUDGET: 0,
  MACHINE_WAKE_MAX_PAIRS: 0,
}));
jest.mock('../../../utils/utility-llm', () => ({ utilityChat: jest.fn() }));
jest.mock('../memory/unified-memory.service', () => ({ memStore: jest.fn(), enforceScopeCap: jest.fn(async () => {}) }));
jest.mock('../memory/user-facts.service', () => ({ selectRelevantFacts: jest.fn(), syncUserFactRows: jest.fn() }));
jest.mock('../memory/episodic.service', () => ({ buildEpisodicBlock: jest.fn() }));
jest.mock('../memory-relevance', () => ({ filterFactsByRelevance: jest.fn(), isTextRelevantToMessage: jest.fn() }));
jest.mock('../memory/context-store', () => ({ storeGet: jest.fn(async () => null), storePut: jest.fn(async () => undefined) }));
jest.mock('../platform/folder-inheritance', () => ({ getMergedProjectStoreState: jest.fn() }));
const mockRecordMemoryMutation: jest.Mock = jest.fn();
jest.mock('../memory/memory-audit', () => ({
  recordMemoryMutation: (...a: any[]) => mockRecordMemoryMutation(...a),
  recordExtractionOutcome: jest.fn(),
  parseModelJson: (text: unknown) => { try { return JSON.parse(String(text)); } catch { return null; } },
  countVisibleFacts: (facts: Record<string, unknown>) => Object.keys(facts || {}).filter((k) => !k.startsWith('__')).length,
}));

import {
  buildRejectionKeywords,
  factMatchesRejection,
  liftRejectionsForFact,
  groundRejectionLifts,
  applyFlatFactProposal,
} from './memory.graph';

/** The test account's real blob bans (prod user_memory, read 2026-10-06). */
const PROD_BANS = ['favourite bird', 'favourite season', 'favourite spice', 'favourite board game'];

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.MEMORY_REMEMBER_LIFTS_REJECTION_DISABLED;
});
afterAll(() => { delete process.env.MEMORY_REMEMBER_LIFTS_REJECTION_DISABLED; });

describe('buildRejectionKeywords — "favourite" is a qualifier, not a topic', () => {
  it('a ban on "favourite bird" scrubs the phrase and "bird", never the bare word "favourite"', () => {
    const kw = buildRejectionKeywords(['favourite bird', 'favorite color']);
    expect(kw.has('favourite bird')).toBe(true);
    expect(kw.has('bird')).toBe(true);
    expect(kw.has('color')).toBe(true);
    expect(kw.has('favourite')).toBe(false);
    expect(kw.has('favorite')).toBe(false);
  });

  it('kill switch restores the old keyword set', () => {
    process.env.MEMORY_REMEMBER_LIFTS_REJECTION_DISABLED = '1';
    expect(buildRejectionKeywords(['favourite bird']).has('favourite')).toBe(true);
  });

  it('the 2026-10-04 scrub shape: a ban on "favourite bird" no longer matches a remembered favourite_spice', () => {
    expect(factMatchesRejection('favourite bird', 'favourite_spice', 'saffron')).toBe(false);
    expect(factMatchesRejection('favourite season', 'favourite_spice', 'saffron')).toBe(false);
    expect(factMatchesRejection('favourite spice', 'favourite_spice', 'saffron')).toBe(true);
    expect(factMatchesRejection('favourite spice', 'cooking', 'loves saffron as a spice')).toBe(true);
  });
});

describe('liftRejectionsForFact — an explicit remember lifts exactly the bans it collides with', () => {
  it('the nightly saffron case: only "favourite spice" is lifted; the other bans stay', () => {
    expect(liftRejectionsForFact(PROD_BANS, 'favourite_spice', 'saffron')).toEqual({
      lifted: ['favourite spice'],
      kept: ['favourite bird', 'favourite season', 'favourite board game'],
    });
  });

  it('a space-keyed fact (the remember_fact key "favourite board game") is matched too', () => {
    expect(liftRejectionsForFact(PROD_BANS, 'favourite board game', 'Catan').lifted).toEqual(['favourite board game']);
  });

  it('an unrelated fact lifts nothing; malformed stored shapes are tolerated', () => {
    expect(liftRejectionsForFact(PROD_BANS, 'city', 'Toronto')).toEqual({ lifted: [], kept: PROD_BANS });
    expect(liftRejectionsForFact('favourite spice', 'favourite_spice', 'saffron').lifted).toEqual(['favourite spice']);
    expect(liftRejectionsForFact(null, 'favourite_spice', 'saffron')).toEqual({ lifted: [], kept: [] });
  });
});

describe('groundRejectionLifts — the extractor lifts a ban only on the user\'s own remember', () => {
  const add = { favourite_spice: 'saffron' };
  it('remember cue + the topic in the user\'s words + a colliding add ⇒ lifted', () => {
    expect(groundRejectionLifts(PROD_BANS, add, 'please remember that my favourite spice is saffron.')).toEqual(['favourite spice']);
  });
  it('no remember cue ⇒ nothing lifted (a passing mention never undoes a ban)', () => {
    expect(groundRejectionLifts(PROD_BANS, add, 'my favourite spice is saffron by the way')).toEqual([]);
  });
  it('a mixed remember/forget message never lifts', () => {
    expect(groundRejectionLifts(PROD_BANS, add, "remember that I no longer care about my favourite spice")).toEqual([]);
  });
  it('the ban\'s words must be in the user\'s message', () => {
    expect(groundRejectionLifts(['favourite spice'], { favourite_spice: 'saffron' }, 'remember this for me please')).toEqual([]);
  });
  it('kill switch ⇒ nothing lifted', () => {
    process.env.MEMORY_REMEMBER_LIFTS_REJECTION_DISABLED = '1';
    expect(groundRejectionLifts(PROD_BANS, add, 'please remember that my favourite spice is saffron.')).toEqual([]);
  });
});

describe('extractor apply — a live remember turn keeps the fact and lifts its ban', () => {
  const USER_MSG = 'please remember that my favourite spice is saffron.';
  const proposal = { add: { favourite_spice: 'saffron' }, remove: [], reject: [], llmMs: 5, budgetTokens: 2000 };

  async function apply(source: 'turn' | 'rebuild', message = USER_MSG): Promise<{ facts: Record<string, any>; outcome: string }> {
    let facts: Record<string, any> = { name: 'Sam', __rejections: [...PROD_BANS] };
    mockFindUnique.mockImplementation(async () => ({ facts }));
    mockUpsert.mockImplementation(async ({ update }: any) => { facts = update.facts; return { facts }; });
    const outcome = await applyFlatFactProposal('u1', { ...proposal, add: { ...proposal.add } }, message, source, 'chat-1');
    return { facts, outcome };
  }

  it('the fact survives the scrub and only its own ban is lifted (audited)', async () => {
    const { facts, outcome } = await apply('turn');
    expect(outcome).toBe('changed');
    expect(facts.favourite_spice).toBe('saffron');
    expect(facts.__rejections).toEqual(['favourite bird', 'favourite season', 'favourite board game']);
    expect(mockRecordMemoryMutation).toHaveBeenCalledWith(expect.objectContaining({ source: 'turn', added: ['favourite_spice'], liftedRejections: ['favourite spice'] }));
  });

  it('a REBUILD never lifts: an old "remember X" must not undo a newer "forget X" (the ban stays, the add is scrubbed)', async () => {
    const { facts } = await apply('rebuild');
    expect(facts.favourite_spice).toBeUndefined();
    expect(facts.__rejections).toEqual(PROD_BANS);
  });

  it('a turn without a remember cue never lifts (the add is scrubbed by its ban, as before)', async () => {
    const { facts } = await apply('turn', 'my favourite spice is saffron, what goes well with it?');
    expect(facts.favourite_spice).toBeUndefined();
    expect(facts.__rejections).toEqual(PROD_BANS);
  });

  it('kill switch: the old behaviour — the ban stays and the scrub deletes the fact', async () => {
    process.env.MEMORY_REMEMBER_LIFTS_REJECTION_DISABLED = '1';
    const { facts } = await apply('turn');
    expect(facts.favourite_spice).toBeUndefined();
    expect(facts.__rejections).toEqual(PROD_BANS);
  });
});
