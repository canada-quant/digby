/**
 * 2026-10-20 memory upgrade — the flat-facts extractor (turn + rebuild) records
 * fact versions and shows the model each fact's date:
 *  - applyFlatFactProposal: a corrected value keeps the old one as a closed
 *    version (replacedBy = the new value, source chat stamped) instead of
 *    overwriting it with no trace;
 *  - a grounded removal ("forget my diet") purges every version of the key;
 *  - the extractor prompt renders `key: value (since YYYY-MM-DD)` plus ONE
 *    recency rule line; FACT_VERSIONS_DISABLED=1 (or no known date) renders the
 *    exact old fact lines and no rule;
 *  - the rebuild stamps the exchange's chat as the version's source chat.
 */
jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
const mockChatFindMany: jest.Mock = jest.fn();
const mockMessageFindMany: jest.Mock = jest.fn();
jest.mock('../../../config/database', () => {
  const { createFactVersionTable } = jest.requireActual('../memory/fact-versions.testkit');
  const versions = createFactVersionTable();
  const blobs = new Map<string, Record<string, any>>();
  return {
    __esModule: true,
    default: {
      ...versions.prismaModels(),
      userMemory: {
        findUnique: jest.fn(async ({ where }: any) => (blobs.has(where.userId) ? { facts: { ...blobs.get(where.userId) } } : null)),
        upsert: jest.fn(async ({ where, create, update }: any) => { blobs.set(where.userId, { ...(blobs.has(where.userId) ? update.facts : create.facts) }); return {}; }),
      },
      crossModelChat: { findMany: (...a: any[]) => mockChatFindMany(...a) },
      crossModelMessage: { findMany: (...a: any[]) => mockMessageFindMany(...a) },
      __versions: versions,
      __blobs: blobs,
    },
  };
});
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
const mockUtilityChat: jest.Mock = jest.fn();
jest.mock('../../../utils/utility-llm', () => ({ utilityChat: (...a: any[]) => mockUtilityChat(...a) }));
jest.mock('../memory/unified-memory.service', () => ({ memStore: jest.fn(), enforceScopeCap: jest.fn(async () => {}) }));
jest.mock('../memory/user-facts.service', () => ({ selectRelevantFacts: jest.fn(), syncUserFactRows: jest.fn() }));
jest.mock('../memory/episodic.service', () => ({ buildEpisodicBlock: jest.fn() }));
jest.mock('../memory-relevance', () => ({ filterFactsByRelevance: jest.fn(), isTextRelevantToMessage: jest.fn() }));
jest.mock('../memory/context-store', () => ({ storeGet: jest.fn(async () => null), storePut: jest.fn(async () => undefined) }));
jest.mock('../platform/folder-inheritance', () => ({ getMergedProjectStoreState: jest.fn() }));
jest.mock('../memory/memory-audit', () => ({
  recordMemoryMutation: jest.fn(),
  recordExtractionOutcome: jest.fn(),
  parseModelJson: (text: unknown) => { const raw = String(text ?? '').replace(/```json\n?|\n?```/g, '').trim(); if (!raw) return null; try { return JSON.parse(raw); } catch {} const a = raw.indexOf('{'), b = raw.lastIndexOf('}'); if (a >= 0 && b > a) { try { return JSON.parse(raw.slice(a, b + 1)); } catch {} } return null; },
  salvageTruncatedJson: () => null,
  countVisibleFacts: (facts: Record<string, unknown>) => Object.keys(facts || {}).filter((k) => !k.startsWith('__')).length,
}));

import prisma from '../../../config/database';
import { applyFlatFactProposal, startUserMemoryRebuild } from './memory.graph';
import { FACT_RECENCY_RULE } from '../memory/fact-versions';
import type { FactVersionTable } from '../memory/fact-versions.testkit';

const versions = (prisma as any).__versions as FactVersionTable;
const blobs = (prisma as any).__blobs as Map<string, Record<string, any>>;
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)); };
const proposal = (p: { add?: Record<string, string>; remove?: string[]; reject?: string[] }) => ({ add: p.add ?? {}, remove: p.remove ?? [], reject: p.reject ?? [], llmMs: 5, budgetTokens: 2000 });

beforeEach(() => {
  jest.clearAllMocks();
  versions.reset();
  blobs.clear();
  delete process.env.FACT_VERSIONS_DISABLED;
});
afterAll(() => { delete process.env.FACT_VERSIONS_DISABLED; });

describe('applyFlatFactProposal records fact versions', () => {
  it('a corrected value keeps the old one as a closed version with replacedBy (it used to be overwritten with no trace)', async () => {
    blobs.set('u1', { city: 'Montreal', name: 'Paul' });
    versions.seed({ userId: 'u1', key: 'city', value: 'Montreal', validFrom: new Date('2026-09-01T00:00:00Z') });
    const out = await applyFlatFactProposal('u1', proposal({ add: { city: 'Victoria' } }), 'I moved to Victoria last month', 'turn', 'chat-42');
    await settle();
    expect(out).toBe('changed');
    expect(blobs.get('u1')!.city).toBe('Victoria');
    expect(versions.history('u1', 'city').map((v) => ({ value: v.value, endedReason: v.endedReason, replacedBy: v.replacedBy, open: v.validTo === null, chat: v.sourceChatId }))).toEqual([
      { value: 'Montreal', endedReason: 'replaced', replacedBy: 'Victoria', open: false, chat: null },
      { value: 'Victoria', endedReason: null, replacedBy: null, open: true, chat: 'chat-42' },
    ]);
    expect(versions.history('u1', 'name')).toEqual([]); // untouched facts are not versioned on this write
  });

  it('a grounded forget purges every version of the key', async () => {
    blobs.set('u1', { diet: 'pescatarian', city: 'Victoria' });
    versions.seed({ userId: 'u1', key: 'diet', value: 'vegan', validFrom: new Date('2026-08-01T00:00:00Z'), validTo: new Date('2026-09-01T00:00:00Z'), endedReason: 'replaced', replacedBy: 'pescatarian' });
    versions.seed({ userId: 'u1', key: 'diet', value: 'pescatarian', validFrom: new Date('2026-09-01T00:00:00Z') });
    versions.seed({ userId: 'u1', key: 'city', value: 'Victoria' });
    const out = await applyFlatFactProposal('u1', proposal({ remove: ['diet'] }), 'please forget my diet, stop bringing it up', 'turn', 'chat-1');
    await settle();
    expect(out).toBe('changed');
    expect(blobs.get('u1')!.diet).toBeUndefined();
    expect(versions.history('u1', 'diet')).toEqual([]);
    expect(versions.open('u1', 'city')).toHaveLength(1);
  });
});

describe('the extractor prompt shows each fact\'s date', () => {
  const rows = [
    { chatId: 'chat-a', role: 'user', content: 'My favourite drink is a flat white these days.', createdAt: new Date('2026-09-01T10:00:00Z'), metadata: null },
    { chatId: 'chat-a', role: 'assistant', content: 'Noted — flat white.', createdAt: new Date('2026-09-01T10:00:05Z'), metadata: null },
  ];
  const runRebuild = async () => {
    mockChatFindMany.mockResolvedValue([{ id: 'chat-a' }]);
    mockMessageFindMany.mockResolvedValue([...rows].reverse());
    mockUtilityChat.mockResolvedValue(JSON.stringify({ add: { favourite_drink: 'flat white' }, remove: [], reject: [] }));
    await startUserMemoryRebuild('u1', { wait: true });
    await settle();
    return String(mockUtilityChat.mock.calls[0][0][0].content);
  };

  it('renders "(since YYYY-MM-DD)" + the recency rule, and the rebuild stamps the exchange chat on the new version', async () => {
    blobs.set('u1', { favourite_drink: 'espresso', name: 'Paul' });
    versions.seed({ userId: 'u1', key: 'favourite_drink', value: 'espresso', validFrom: new Date('2026-03-04T00:00:00Z') });
    const prompt = await runRebuild();
    expect(prompt).toContain('  favourite_drink: espresso (since 2026-03-04)');
    expect(prompt).toContain('  name: Paul\n'); // no known date → no suffix
    expect(prompt).toContain(`${FACT_RECENCY_RULE}\n\nLATEST CONVERSATION:`);
    expect(versions.open('u1', 'favourite_drink')).toEqual([expect.objectContaining({ value: 'flat white', source: 'rebuild', sourceChatId: 'chat-a' })]);
  });

  it('FACT_VERSIONS_DISABLED=1: the exact old fact lines, no rule, no version rows', async () => {
    process.env.FACT_VERSIONS_DISABLED = '1';
    blobs.set('u1', { favourite_drink: 'espresso', name: 'Paul' });
    versions.seed({ userId: 'u1', key: 'favourite_drink', value: 'espresso', validFrom: new Date('2026-03-04T00:00:00Z') });
    const prompt = await runRebuild();
    expect(prompt).toContain('CURRENT STORED FACTS:\n  favourite_drink: espresso\n  name: Paul\n\nLATEST CONVERSATION:');
    expect(prompt).not.toContain('(since');
    expect(prompt).not.toContain(FACT_RECENCY_RULE);
    expect(versions.rows).toHaveLength(1); // only the seed
  });

  it('no known dates → the prompt is byte-identical to the disabled one', async () => {
    blobs.set('u1', { favourite_drink: 'espresso', name: 'Paul' });
    const enabled = await runRebuild();
    jest.clearAllMocks();
    versions.reset();
    blobs.set('u1', { favourite_drink: 'espresso', name: 'Paul' });
    process.env.FACT_VERSIONS_DISABLED = '1';
    const disabled = await runRebuild();
    const strip = (p: string) => p.replace(/Today's date: \S+/, '');
    expect(strip(enabled)).toBe(strip(disabled));
  });
});
