/**
 * Tests for user-facts.service.ts — semantic fact retrieval + row reconciliation.
 * Prisma / rag.service (embeddings) / logger are mocked; no network or DB.
 */

jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    userMemory: { findUnique: jest.fn() },
    userMemoryFact: { findMany: jest.fn(), deleteMany: jest.fn(), count: jest.fn() },
    $executeRawUnsafe: jest.fn(),
    $queryRawUnsafe: jest.fn(),
  },
}));
// logger transitively imports config/env, whose Zod validation process.exit(1)s
// in a keyless test environment — mock it out like the other suites do.
jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../rag.service', () => ({
  __esModule: true,
  embedTexts: jest.fn(),
}));
// The fact-sync now drops the home-screen questions cache on change (feedback
// 93fa84af) — mock the service out so the suite never touches redis.
jest.mock('../suggested-questions.service', () => ({
  __esModule: true,
  invalidateQuestionsCache: jest.fn(async () => {}),
}));

import prisma from '../../../config/database';
import { embedTexts } from '../rag.service';
import { selectRelevantFacts, syncUserFactRows, deleteAllFactRows } from './user-facts.service';
import { invalidateQuestionsCache } from '../suggested-questions.service';

const mockedInvalidate = invalidateQuestionsCache as jest.Mock;

const mockedPrisma = prisma as unknown as {
  userMemory: { findUnique: jest.Mock };
  userMemoryFact: { findMany: jest.Mock; deleteMany: jest.Mock; count: jest.Mock };
  $executeRawUnsafe: jest.Mock;
  $queryRawUnsafe: jest.Mock;
};
const mockedEmbed = embedTexts as jest.Mock;

const VEC = Array(1536).fill(0.01);

beforeEach(() => {
  jest.clearAllMocks();
  mockedEmbed.mockResolvedValue([VEC]);
});

describe('selectRelevantFacts', () => {
  test('empty facts → empty selection, no DB calls', async () => {
    const r = await selectRelevantFacts('u1', {}, 'hello there');
    expect(r.relevant).toEqual({});
    expect(r.semantic).toBe(false);
    expect(mockedPrisma.userMemoryFact.count).not.toHaveBeenCalled();
  });

  test('memory-recall question injects everything without embedding', async () => {
    const facts = { diet: 'pescatarian', hobby: 'sailing' };
    const r = await selectRelevantFacts('u1', facts, 'what do you know about me?');
    expect(r.recallBypass).toBe(true);
    expect(r.relevant).toEqual(facts);
    expect(mockedEmbed).not.toHaveBeenCalled();
  });

  test('semantic path: injects facts above similarity floor, withholds the rest', async () => {
    mockedPrisma.userMemoryFact.count.mockResolvedValue(2);
    mockedPrisma.$queryRawUnsafe.mockResolvedValue([
      { key: 'diet', score: 0.62, lastSeenAt: new Date() },
      { key: 'hobby', score: 0.08, lastSeenAt: new Date() }, // below floor
    ]);
    const facts = { diet: 'pescatarian', hobby: 'sailing' };
    const r = await selectRelevantFacts('u1', facts, 'what should I cook for dinner tonight?');
    expect(r.semantic).toBe(true);
    expect(r.relevant).toEqual({ diet: 'pescatarian' });
    expect(r.withheldCount).toBe(1);
  });

  test('identity keys always pass even when semantically unrelated', async () => {
    mockedPrisma.userMemoryFact.count.mockResolvedValue(2);
    mockedPrisma.$queryRawUnsafe.mockResolvedValue([]); // nothing semantically related
    const facts = { name: 'Verity', timezone: 'America/Halifax', diet: 'pescatarian' };
    const r = await selectRelevantFacts('u1', facts, 'explain quicksort');
    expect(r.semantic).toBe(true);
    expect(r.relevant.name).toBe('Verity');
    expect(r.relevant.timezone).toBe('America/Halifax');
    expect(r.relevant.diet).toBeUndefined();
  });

  test('empty index → keyword fallback + background backfill kick', async () => {
    mockedPrisma.userMemoryFact.count.mockResolvedValue(0);
    // the backfill sync reads the blob
    mockedPrisma.userMemory.findUnique.mockResolvedValue({ facts: { diet: 'pescatarian' } });
    mockedPrisma.userMemoryFact.findMany.mockResolvedValue([]);
    const facts = { diet: 'pescatarian eats seafood' };
    const r = await selectRelevantFacts('u1', facts, 'best seafood recipes?');
    expect(r.semantic).toBe(false);
    expect(r.relevant.diet).toBeDefined(); // keyword overlap: seafood
    // Let the fire-and-forget backfill sync settle so jest exits cleanly
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(mockedPrisma.userMemory.findUnique).toHaveBeenCalled(); // backfill kicked
  });

  test('embedding failure → keyword fallback, never throws', async () => {
    mockedPrisma.userMemoryFact.count.mockResolvedValue(3);
    mockedEmbed.mockRejectedValue(new Error('DashScope down'));
    const facts = { diet: 'pescatarian' };
    const r = await selectRelevantFacts('u1', facts, 'unrelated question about rust lifetimes');
    expect(r.semantic).toBe(false);
    expect(r.withheldCount).toBe(1); // keyword gate withholds unrelated diet fact
  });
});

describe('syncUserFactRows', () => {
  test('embeds only new/changed facts, deletes stale rows', async () => {
    mockedPrisma.userMemory.findUnique.mockResolvedValue({
      facts: { diet: 'pescatarian', city: 'Halifax', __rejections: ['acl'] },
    });
    mockedPrisma.userMemoryFact.findMany.mockResolvedValue([
      { key: 'diet', content: 'diet: pescatarian' },   // unchanged → skip
      { key: 'old_job', content: 'old job: welder' },  // gone from blob → delete
    ]);
    mockedEmbed.mockResolvedValue([VEC]);

    await syncUserFactRows('u1');

    expect(mockedPrisma.userMemoryFact.deleteMany).toHaveBeenCalledWith({
      where: { userId: 'u1', key: { in: ['old_job'] } },
    });
    // Only "city" is new → exactly one embed batch of one content, one upsert
    expect(mockedEmbed).toHaveBeenCalledWith(['city: Halifax']);
    expect(mockedPrisma.$executeRawUnsafe).toHaveBeenCalledTimes(1);
  });

  test('internal __keys never become rows', async () => {
    mockedPrisma.userMemory.findUnique.mockResolvedValue({
      facts: { __rejections: ['x'], __dream: { lastRunAt: 'now' } },
    });
    mockedPrisma.userMemoryFact.findMany.mockResolvedValue([]);
    await syncUserFactRows('u1');
    expect(mockedEmbed).not.toHaveBeenCalled();
    expect(mockedPrisma.$executeRawUnsafe).not.toHaveBeenCalled();
  });

  test('never throws on DB failure', async () => {
    mockedPrisma.userMemory.findUnique.mockRejectedValue(new Error('db down'));
    await expect(syncUserFactRows('u1')).resolves.toBeUndefined();
  });

  test('drops the home-screen questions cache when facts actually change (feedback 93fa84af)', async () => {
    mockedPrisma.userMemory.findUnique.mockResolvedValue({ facts: { diet: 'vegan' } });
    mockedPrisma.userMemoryFact.findMany.mockResolvedValue([{ key: 'diet', content: 'diet: pescatarian' }]); // changed value
    mockedEmbed.mockResolvedValue([VEC]);
    await syncUserFactRows('u1');
    expect(mockedInvalidate).toHaveBeenCalledWith('u1', expect.objectContaining({ hard: expect.any(Boolean) }));
  });

  test('does NOT touch the questions cache when nothing changed', async () => {
    mockedPrisma.userMemory.findUnique.mockResolvedValue({ facts: { diet: 'pescatarian' } });
    mockedPrisma.userMemoryFact.findMany.mockResolvedValue([{ key: 'diet', content: 'diet: pescatarian' }]); // identical
    await syncUserFactRows('u1');
    expect(mockedInvalidate).not.toHaveBeenCalled();
  });

  test('NUL bytes in fact key/value are stripped before the raw upsert (issue #90)', async () => {
    const NUL = String.fromCharCode(0);
    mockedPrisma.userMemory.findUnique.mockResolvedValue({
      facts: { [`di${NUL}et`]: `pesca${NUL}tarian` },
    });
    mockedPrisma.userMemoryFact.findMany.mockResolvedValue([]);
    mockedEmbed.mockResolvedValue([VEC]);

    await syncUserFactRows('u1');

    // Content is sanitized BEFORE embedding + comparison, so the whole pipeline is NUL-free…
    expect(mockedEmbed).toHaveBeenCalledWith(['diet: pescatarian']);
    // …and the raw upsert binds a sanitized key + content (Postgres rejects 0x00, error 22021).
    expect(mockedPrisma.$executeRawUnsafe).toHaveBeenCalledTimes(1);
    const bindArgs = mockedPrisma.$executeRawUnsafe.mock.calls[0].slice(1);
    for (const arg of bindArgs) {
      if (typeof arg === 'string') expect(arg.includes(NUL)).toBe(false);
    }
    expect(bindArgs[1]).toBe('diet');
    expect(bindArgs[2]).toBe('diet: pescatarian');
  });
});

describe('deleteAllFactRows', () => {
  test('wipes rows for the user, swallows failures', async () => {
    mockedPrisma.userMemoryFact.deleteMany.mockResolvedValue({ count: 3 });
    await deleteAllFactRows('u1');
    expect(mockedPrisma.userMemoryFact.deleteMany).toHaveBeenCalledWith({ where: { userId: 'u1' } });

    mockedPrisma.userMemoryFact.deleteMany.mockRejectedValue(new Error('db down'));
    await expect(deleteAllFactRows('u1')).resolves.toBeUndefined();
  });
});
