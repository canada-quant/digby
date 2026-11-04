/**
 * Ticket ccd634fb — context.service.updateMemoryFact wiring for the explicit-remember ban lift.
 * The pure matching (liftRejectionsForFact) is pinned in
 * langgraph/memory.graph.remember-lift.ccd634fb.test.ts; here: an explicit remember
 * (`liftRejections: true` — remember_fact / the Memory tab) writes the blob WITHOUT the lifted
 * bans and audits them, while a model-proposed write (no flag) never touches __rejections.
 */

const mockFindUnique = jest.fn();
const mockUpsert = jest.fn();
jest.mock('../../config/database', () => ({
  __esModule: true,
  default: { userMemory: { findUnique: (...a: any[]) => mockFindUnique(...a), upsert: (...a: any[]) => mockUpsert(...a) } },
}));
jest.mock('../../config/redis', () => ({ __esModule: true, default: { get: jest.fn(), del: jest.fn(), set: jest.fn(), setEx: jest.fn(), expire: jest.fn() } }));
jest.mock('../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock('axios', () => ({ __esModule: true, default: { post: jest.fn(), get: jest.fn() } }));
jest.mock('./memory-relevance', () => ({ filterFactsByRelevance: jest.fn(() => []) }));
jest.mock('./memory/user-facts.service', () => ({ syncUserFactRows: jest.fn(), deleteAllFactRows: jest.fn() }));
jest.mock('./platform/pending-confirmations', () => ({ getActivePendingForSession: jest.fn(() => null) }));
const mockRecordMemoryMutation = jest.fn();
jest.mock('./memory/memory-audit', () => ({
  recordMemoryMutation: (...a: any[]) => mockRecordMemoryMutation(...a),
  countVisibleFacts: (facts: Record<string, unknown>) => Object.keys(facts || {}).filter((k) => !k.startsWith('__')).length,
}));
// The pure split is pinned elsewhere — a faithful stand-in keeps this test off memory.graph's import graph.
jest.mock('./langgraph/memory.graph', () => ({
  rememberLiftsRejectionDisabled: () => process.env.MEMORY_REMEMBER_LIFTS_REJECTION_DISABLED === '1',
  liftRejectionsForFact: (rejections: string[], key: string) => {
    const k = key.replace(/_/g, ' ');
    return { lifted: rejections.filter((r) => k.includes(r)), kept: rejections.filter((r) => !k.includes(r)) };
  },
}));

import contextService from './context.service';

const BLOB = { name: 'Sam', __rejections: ['favourite bird', 'favourite spice'] };

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.MEMORY_REMEMBER_LIFTS_REJECTION_DISABLED;
  mockFindUnique.mockResolvedValue({ facts: { ...BLOB, __rejections: [...BLOB.__rejections] } });
  mockUpsert.mockResolvedValue({});
});
afterAll(() => { delete process.env.MEMORY_REMEMBER_LIFTS_REJECTION_DISABLED; });

const written = () => mockUpsert.mock.calls[0][0].update.facts;

it('an explicit remember lifts the colliding ban, keeps the others, and audits the lift', async () => {
  const r = await contextService.updateMemoryFact('u1', 'favourite_spice', 'saffron', 'tool', { liftRejections: true });
  expect(r).toEqual({ liftedRejections: ['favourite spice'] });
  expect(written()).toEqual({ name: 'Sam', favourite_spice: 'saffron', __rejections: ['favourite bird'] });
  expect(mockRecordMemoryMutation).toHaveBeenCalledWith(expect.objectContaining({ source: 'tool', added: ['favourite_spice'], liftedRejections: ['favourite spice'] }));
});

it('the last ban lifted removes the __rejections key entirely (no empty [BANNED TOPICS] block)', async () => {
  mockFindUnique.mockResolvedValue({ facts: { name: 'Sam', __rejections: ['favourite spice'] } });
  await contextService.updateMemoryFact('u1', 'favourite_spice', 'saffron', 'api', { liftRejections: true });
  expect(written()).toEqual({ name: 'Sam', favourite_spice: 'saffron' });
});

it('a model-proposed write (no flag — profile interview, consolidation) never lifts a ban', async () => {
  const r = await contextService.updateMemoryFact('u1', 'favourite_spice', 'saffron');
  expect(r).toEqual({ liftedRejections: [] });
  expect(written().__rejections).toEqual(['favourite bird', 'favourite spice']);
  expect(mockRecordMemoryMutation.mock.calls[0][0].liftedRejections).toBeUndefined();
});

it('kill switch MEMORY_REMEMBER_LIFTS_REJECTION_DISABLED=1: the ban outlives the remember (old behaviour)', async () => {
  process.env.MEMORY_REMEMBER_LIFTS_REJECTION_DISABLED = '1';
  const r = await contextService.updateMemoryFact('u1', 'favourite_spice', 'saffron', 'tool', { liftRejections: true });
  expect(r.liftedRejections).toEqual([]);
  expect(written().__rejections).toEqual(['favourite bird', 'favourite spice']);
});
