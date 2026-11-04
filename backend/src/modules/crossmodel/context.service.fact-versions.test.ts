/**
 * 2026-10-20 memory upgrade — context.service's explicit writers record fact
 * versions (memory/fact-versions.ts):
 *  - updateMemoryFact (Memory tab PUT / remember_fact / profile): a changed value
 *    keeps the OLD value as a closed version (replacedBy = the new value) and the
 *    new version carries the source chat — before this, the old value was simply
 *    overwritten (regression: no history existed at all);
 *  - deleteMemoryFact (Memory tab DELETE / forget_fact): forgotten means gone —
 *    every version of the key is purged;
 *  - clearUserMemory: every version of every key is purged;
 *  - FACT_VERSIONS_DISABLED=1: no version reads or writes.
 */
jest.mock('../../config/database', () => {
  const { createFactVersionTable } = jest.requireActual('./memory/fact-versions.testkit');
  const versions = createFactVersionTable();
  const blobs = new Map<string, Record<string, any>>();
  return {
    __esModule: true,
    default: {
      ...versions.prismaModels(),
      userMemory: {
        findUnique: jest.fn(async ({ where }: any) => (blobs.has(where.userId) ? { facts: { ...blobs.get(where.userId) } } : null)),
        upsert: jest.fn(async ({ where, create, update }: any) => { blobs.set(where.userId, { ...(blobs.has(where.userId) ? update.facts : create.facts) }); return {}; }),
        update: jest.fn(async ({ where, data }: any) => { blobs.set(where.userId, { ...data.facts }); return {}; }),
      },
      __versions: versions,
      __blobs: blobs,
    },
  };
});
jest.mock('../../config/redis', () => ({ __esModule: true, default: { get: jest.fn(), del: jest.fn(), set: jest.fn(), setEx: jest.fn(), expire: jest.fn() } }));
jest.mock('../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock('axios', () => ({ __esModule: true, default: { post: jest.fn(), get: jest.fn() } }));
jest.mock('./memory-relevance', () => ({ filterFactsByRelevance: jest.fn(() => []) }));
jest.mock('./memory/user-facts.service', () => ({ syncUserFactRows: jest.fn(), deleteAllFactRows: jest.fn(async () => undefined) }));
jest.mock('./platform/pending-confirmations', () => ({ getActivePendingForSession: jest.fn(() => null) }));
jest.mock('./memory/memory-audit', () => ({
  recordMemoryMutation: jest.fn(),
  countVisibleFacts: (facts: Record<string, unknown>) => Object.keys(facts || {}).filter((k) => !k.startsWith('__')).length,
}));
jest.mock('./suggested-questions.service', () => ({ invalidateQuestionsCache: jest.fn(async () => undefined) }));
jest.mock('./langgraph/memory.graph', () => ({
  rememberLiftsRejectionDisabled: () => true,
  liftRejectionsForFact: () => ({ lifted: [], kept: [] }),
  clearUserContextState: jest.fn(async () => undefined),
}));

import prisma from '../../config/database';
import contextService from './context.service';
import type { FactVersionTable } from './memory/fact-versions.testkit';

const versions = (prisma as any).__versions as FactVersionTable;
const blobs = (prisma as any).__blobs as Map<string, Record<string, any>>;
/** The version write is fire-and-forget after the blob write — let it settle. */
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)); };

beforeEach(() => {
  jest.clearAllMocks(); // keeps the testkit implementations, drops call history
  versions.reset();
  blobs.clear();
  delete process.env.FACT_VERSIONS_DISABLED;
});
afterAll(() => { delete process.env.FACT_VERSIONS_DISABLED; });

it('a value change keeps the old value as a closed version with replacedBy; the new one names its source chat', async () => {
  await contextService.updateMemoryFact('u1', 'city', 'Montreal', 'api');
  await settle();
  await contextService.updateMemoryFact('u1', 'city', 'Victoria', 'tool', { liftRejections: true, chatId: 'chat-7' });
  await settle();
  expect(blobs.get('u1')).toEqual({ city: 'Victoria' }); // the blob stays canonical
  const h = versions.history('u1', 'city');
  expect(h.map((v) => ({ value: v.value, endedReason: v.endedReason, replacedBy: v.replacedBy, open: v.validTo === null }))).toEqual([
    { value: 'Montreal', endedReason: 'replaced', replacedBy: 'Victoria', open: false },
    { value: 'Victoria', endedReason: null, replacedBy: null, open: true },
  ]);
  expect(h[1]).toMatchObject({ source: 'tool', sourceChatId: 'chat-7' });
});

it('a fact stored before versions existed is backfilled then closed when it changes', async () => {
  blobs.set('u1', { job: 'teacher' }); // predates the table: no version rows
  await contextService.updateMemoryFact('u1', 'job', 'principal', 'api');
  await settle();
  expect(versions.history('u1', 'job').map((v) => [v.value, v.source, v.replacedBy])).toEqual([
    ['teacher', 'backfill', 'principal'],
    ['principal', 'api', null],
  ]);
});

it('a forget (deleteMemoryFact) purges every version of the key — other keys keep theirs', async () => {
  await contextService.updateMemoryFact('u1', 'diet', 'vegan', 'api');
  await settle();
  await contextService.updateMemoryFact('u1', 'diet', 'pescatarian', 'api');
  await contextService.updateMemoryFact('u1', 'city', 'Montreal', 'api');
  await settle();
  expect(versions.history('u1', 'diet')).toHaveLength(2);
  await contextService.deleteMemoryFact('u1', 'diet', 'tool');
  await settle();
  expect(blobs.get('u1')).toEqual({ city: 'Montreal' });
  expect(versions.history('u1', 'diet')).toEqual([]);
  expect(versions.open('u1', 'city')).toHaveLength(1);
});

it('clearUserMemory purges every version', async () => {
  await contextService.updateMemoryFact('u1', 'a', '1', 'api');
  await contextService.updateMemoryFact('u1', 'b', '2', 'api');
  await settle();
  expect(versions.rows.length).toBe(2);
  await contextService.clearUserMemory('u1');
  expect(versions.rows).toEqual([]);
});

it('FACT_VERSIONS_DISABLED=1: the writers record nothing', async () => {
  process.env.FACT_VERSIONS_DISABLED = '1';
  await contextService.updateMemoryFact('u1', 'city', 'Montreal', 'api');
  await contextService.updateMemoryFact('u1', 'city', 'Victoria', 'api');
  await contextService.deleteMemoryFact('u1', 'city', 'api');
  await settle();
  expect(versions.rows).toEqual([]);
  expect(versions.api.findMany).not.toHaveBeenCalled();
});
