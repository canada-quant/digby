/**
 * Ticket 6fd4663a (nightly suite 2026-10-15, run 38756194630, seed 20261015, case 02-memory):
 * the remember turn "please remember that my favourite tea is oolong." ran list_memory ONLY —
 * remember_fact never ran — and the answer asked "do you want to lift that ban?" instead of
 * acting. Root cause: the test account's persistent __rejections ("favourite tea", planted by an
 * EARLIER suite run's own forget turn "please forget my favourite tea" — the suite cleans its
 * chats but never its memory writes) rode the prompt as [BANNED TOPICS — NEVER MENTION THESE
 * … under ANY circumstances … permanent bans — not suggestions]. The model obeyed the
 * absolutist doctrine and refused the user's own explicit remember — even though calling
 * remember_fact is exactly what lifts the ban server-side (context.service updateMemoryFact
 * liftRejections, ticket ccd634fb).
 *
 * This pins the FIXED doctrine: the ban keeps its force for unprompted mentions, and the
 * user's OWN explicit ask is named as the lift path. Case 14 of the same run (Catan) shows the
 * ambiguous-intent route stays legitimate: asking ONE clarifying question when the remember ask
 * collides with a ban is a WARN, not a FAIL — the carve-out must keep that route open.
 */
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
jest.mock('../memory/memory-audit', () => ({
  recordMemoryMutation: jest.fn(),
  recordExtractionOutcome: jest.fn(),
  parseModelJson: (text: unknown) => { try { return JSON.parse(String(text)); } catch { return null; } },
  countVisibleFacts: (facts: Record<string, unknown>) => Object.keys(facts || {}).filter((k) => !k.startsWith('__')).length,
}));

import { formatUserMemoryBlock, normalizeRejections } from './memory.graph';

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

describe('BANNED TOPICS doctrine carve-out (ticket 6fd4663a)', () => {
  const noFacts = { relevant: {}, withheldCount: 0, recallBypass: false, semantic: false };

  it('keeps the ban block and its force for unprompted mentions', () => {
    const block = formatUserMemoryBlock(noFacts, null, undefined, ['favourite tea'], false, '', []);
    expect(block).toMatch(/\[BANNED TOPICS[^\]]*\]/);
    expect(block).toMatch(/⛔ favourite tea/);
    expect(block).toMatch(/STOP talking about these topics/);
    expect(block).toMatch(/on your own/);
  });

  it('names the user\'s own explicit ask as the lift path (the 6fd4663a regression)', () => {
    const block = formatUserMemoryBlock(noFacts, null, undefined, ['favourite tea'], false, '', []);
    expect(block).toMatch(/the user's OWN explicit request wins/);
    expect(block).toMatch(/remember_fact/);
    expect(block).toMatch(/lifts the ban server-side/);
  });

  it('calls out the failure mode the nightly case hit: asking to lift instead of acting', () => {
    const block = formatUserMemoryBlock(noFacts, null, undefined, ['favourite tea'], false, '', []);
    expect(block).toMatch(/FAILURE MODE/);
  });

  it('keeps ONE clarifying question legitimate for genuinely ambiguous intent (case-14 route)', () => {
    const block = formatUserMemoryBlock(noFacts, null, undefined, ['favourite board game'], false, '', []);
    expect(block).toMatch(/genuinely ambiguous/);
  });

  it('no rejections → no ban block at all (unchanged shape)', () => {
    const block = formatUserMemoryBlock(noFacts, null, undefined, [], false, '', []);
    expect(block).not.toMatch(/BANNED TOPICS/);
  });

  it('the old absolutist wording never returns ("under ANY circumstances" is the bug)', () => {
    const block = formatUserMemoryBlock(noFacts, null, undefined, ['favourite tea'], false, '', []);
    expect(block).not.toMatch(/under ANY circumstances/);
  });

  it('normalizeRejections still feeds the block from the stored __rejections shape', () => {
    expect(normalizeRejections(['favourite tea', '', 42 as unknown as string])).toEqual(['favourite tea']);
    expect(normalizeRejections(undefined)).toEqual([]);
  });
});
