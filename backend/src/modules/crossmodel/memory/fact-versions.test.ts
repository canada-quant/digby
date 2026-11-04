/**
 * memory/fact-versions.ts — value history for user-memory facts (2026-10-20).
 * Pins: a change CLOSES the old version (replacedBy = new value) instead of
 * overwriting; a 'purge' removal deletes every version of the key; a
 * 'supersede' (dream) removal closes it as 'consolidated' with `key:<into>`;
 * a fact that predates the table gets a lazy 'backfill' version anchored at its
 * user_memory_facts createdAt; internal `__` keys never version; meta + history
 * reads; FACT_VERSIONS_DISABLED=1 = no reads, no writes; never throws.
 */
jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../../config/database', () => {
  const { createFactVersionTable } = jest.requireActual('./fact-versions.testkit');
  const versions = createFactVersionTable();
  return { __esModule: true, default: { ...versions.prismaModels(), __versions: versions } };
});

import prisma from '../../../config/database';
import type { FactVersionTable } from './fact-versions.testkit';
import {
  recordFactVersions, purgeAllFactVersions, getFactMeta, getFactHistory, factVersionsEnabled,
  factSinceSuffix, factSinceDates, visibleFactValues,
} from './fact-versions';

const versions = (prisma as any).__versions as FactVersionTable;

beforeEach(() => {
  versions.reset();
  delete process.env.FACT_VERSIONS_DISABLED;
  jest.clearAllMocks();
});
afterAll(() => { delete process.env.FACT_VERSIONS_DISABLED; });

describe('recordFactVersions', () => {
  it('a new key opens a version with source + source chat', async () => {
    const r = await recordFactVersions({ userId: 'u1', before: {}, after: { city: 'Montreal', __rejections: ['x'] }, source: 'turn', chatId: 'chat-9', removal: 'purge' });
    expect(r).toEqual({ opened: 1, closed: 0, purgedKeys: 0, backfilled: 0 });
    expect(versions.open('u1')).toEqual([expect.objectContaining({ key: 'city', value: 'Montreal', source: 'turn', sourceChatId: 'chat-9', validTo: null })]);
    expect(versions.rows.some((v) => v.key.startsWith('__'))).toBe(false); // bookkeeping never versions
  });

  it('a changed value closes the old version (replaced, replacedBy = new value) and opens the new one — the old value is KEPT', async () => {
    await recordFactVersions({ userId: 'u1', before: {}, after: { city: 'Montreal' }, source: 'turn', removal: 'purge' });
    await recordFactVersions({ userId: 'u1', before: { city: 'Montreal' }, after: { city: 'Victoria' }, source: 'tool', chatId: 'c2', removal: 'purge' });
    const h = versions.history('u1', 'city');
    expect(h).toHaveLength(2);
    expect(h[0]).toMatchObject({ value: 'Montreal', endedReason: 'replaced', replacedBy: 'Victoria' });
    expect(h[0].validTo).toBeInstanceOf(Date);
    expect(h[1]).toMatchObject({ value: 'Victoria', validTo: null, source: 'tool', sourceChatId: 'c2' });
    // the chain links exactly: the old version ends when the new one starts
    expect(h[0].validTo!.getTime()).toBe(h[1].validFrom.getTime());
  });

  it("removal 'purge' (a user forget) deletes EVERY version of the key, other keys untouched", async () => {
    await recordFactVersions({ userId: 'u1', before: {}, after: { diet: 'vegan', city: 'Montreal' }, source: 'turn', removal: 'purge' });
    await recordFactVersions({ userId: 'u1', before: { diet: 'vegan', city: 'Montreal' }, after: { diet: 'pescatarian', city: 'Montreal' }, source: 'turn', removal: 'purge' });
    expect(versions.history('u1', 'diet')).toHaveLength(2);
    const r = await recordFactVersions({ userId: 'u1', before: { diet: 'pescatarian', city: 'Montreal' }, after: { city: 'Montreal' }, source: 'tool', removal: 'purge' });
    expect(r).toMatchObject({ purgedKeys: 1 });
    expect(versions.history('u1', 'diet')).toEqual([]);
    expect(versions.open('u1', 'city')).toHaveLength(1);
  });

  it("removal 'supersede' (dream) closes a merged-away key as consolidated with replacedBy key:<into>, and the target as replaced", async () => {
    await recordFactVersions({ userId: 'u1', before: {}, after: { location: 'Victoria', lives_in: 'Victoria, BC' }, source: 'turn', removal: 'purge' });
    await recordFactVersions({
      userId: 'u1', before: { location: 'Victoria', lives_in: 'Victoria, BC' }, after: { location: 'Victoria, BC' },
      source: 'dream', removal: 'supersede', mergedInto: { lives_in: 'location' },
    });
    expect(versions.history('u1', 'lives_in')).toEqual([expect.objectContaining({ value: 'Victoria, BC', endedReason: 'consolidated', replacedBy: 'key:location' })]);
    expect(versions.history('u1', 'location').map((v) => [v.value, v.endedReason, v.replacedBy])).toEqual([
      ['Victoria', 'replaced', 'Victoria, BC'],
      ['Victoria, BC', null, null],
    ]);
  });

  it("'supersede' still purges the keys named in purgeKeys (a banned-topic scrub is the user's forget)", async () => {
    await recordFactVersions({ userId: 'u1', before: {}, after: { injury: 'ACL', city: 'X' }, source: 'turn', removal: 'purge' });
    await recordFactVersions({ userId: 'u1', before: { injury: 'ACL', city: 'X' }, after: { city: 'X' }, source: 'dream', removal: 'supersede', purgeKeys: ['injury'] });
    expect(versions.history('u1', 'injury')).toEqual([]);
  });

  it('a fact that predates the table gets a lazy backfill version (validFrom = its user_memory_facts createdAt) so the replacement links', async () => {
    const createdAt = new Date('2026-07-10T00:00:00Z');
    versions.indexRows.push({ userId: 'u1', key: 'job', createdAt });
    const r = await recordFactVersions({ userId: 'u1', before: { job: 'teacher', pet: 'cat' }, after: { job: 'principal', pet: 'cat' }, source: 'api', removal: 'purge' });
    expect(r).toEqual({ opened: 1, closed: 1, purgedKeys: 0, backfilled: 1 });
    const h = versions.history('u1', 'job');
    expect(h[0]).toMatchObject({ value: 'teacher', source: 'backfill', validFrom: createdAt, endedReason: 'replaced', replacedBy: 'principal' });
    expect(h[1]).toMatchObject({ value: 'principal', validTo: null, source: 'api' });
    expect(versions.history('u1', 'pet')).toEqual([]); // unchanged keys are never touched
  });

  it('re-recording the same state is a no-op; a dangling extra open version is healed', async () => {
    await recordFactVersions({ userId: 'u1', before: {}, after: { a: '1' }, source: 'turn', removal: 'purge' });
    expect(await recordFactVersions({ userId: 'u1', before: { a: '1' }, after: { a: '1' }, source: 'turn', removal: 'purge' })).toBeNull();
    versions.seed({ userId: 'u1', key: 'a', value: 'stale-dup' }); // a race left two open rows
    await recordFactVersions({ userId: 'u1', before: { a: '1' }, after: { a: '2' }, source: 'turn', removal: 'purge' });
    expect(versions.open('u1', 'a').map((v) => v.value)).toEqual(['2']);
  });

  it('non-string values stringify like the readers do; empty values are not facts', () => {
    expect([...visibleFactValues({ a: { x: 1 }, b: 2, c: '  ', d: null, __dream: { lastRunAt: 'x' } })]).toEqual([['a', '{"x":1}'], ['b', '2']]);
  });

  it('never throws — a failing table answers null', async () => {
    versions.api.findMany.mockRejectedValueOnce(new Error('relation does not exist'));
    await expect(recordFactVersions({ userId: 'u1', before: { a: '1' }, after: { a: '2' }, source: 'turn', removal: 'purge' })).resolves.toBeNull();
  });

  it('FACT_VERSIONS_DISABLED=1: no reads, no writes', async () => {
    process.env.FACT_VERSIONS_DISABLED = '1';
    expect(factVersionsEnabled()).toBe(false);
    expect(await recordFactVersions({ userId: 'u1', before: {}, after: { a: '1' }, source: 'turn', removal: 'purge' })).toBeNull();
    expect(await getFactMeta('u1')).toEqual({});
    expect(await getFactHistory('u1')).toEqual([]);
    expect(await purgeAllFactVersions('u1')).toBe(0);
    expect(versions.api.findMany).not.toHaveBeenCalled();
    expect(versions.api.createMany).not.toHaveBeenCalled();
    expect(versions.api.deleteMany).not.toHaveBeenCalled();
  });
});

describe('reads', () => {
  it('getFactMeta: the open version (newest wins), falling back to the index createdAt as backfill', async () => {
    versions.seed({ userId: 'u1', key: 'city', value: 'Victoria', source: 'tool', sourceChatId: 'c1', validFrom: new Date('2026-10-01T12:00:00Z') });
    versions.seed({ userId: 'u1', key: 'old', value: 'v', validFrom: new Date('2026-01-01T00:00:00Z'), validTo: new Date('2026-02-01T00:00:00Z') });
    versions.indexRows.push({ userId: 'u1', key: 'name', createdAt: new Date('2026-07-10T00:00:00Z') });
    versions.indexRows.push({ userId: 'u1', key: 'city', createdAt: new Date('2026-07-10T00:00:00Z') });
    const meta = await getFactMeta('u1');
    expect(meta).toEqual({
      city: { since: '2026-10-01T12:00:00.000Z', source: 'tool', sourceChatId: 'c1' },
      name: { since: '2026-07-10T00:00:00.000Z', source: 'backfill', sourceChatId: null },
    });
    expect(factSinceSuffix(meta, 'city')).toBe(' (since 2026-10-01)');
    expect(factSinceSuffix(meta, 'unknown')).toBe('');
    expect(factSinceDates(meta)).toEqual({ city: '2026-10-01', name: '2026-07-10' });
  });

  it('getFactHistory: newest first, per key, bounded', async () => {
    await recordFactVersions({ userId: 'u1', before: {}, after: { a: '1', b: 'x' }, source: 'turn', removal: 'purge' });
    await new Promise((r) => setTimeout(r, 5));
    await recordFactVersions({ userId: 'u1', before: { a: '1', b: 'x' }, after: { a: '2', b: 'x' }, source: 'turn', removal: 'purge' });
    const h = await getFactHistory('u1', 'a');
    expect(h.map((v) => v.value)).toEqual(['2', '1']);
    expect((await getFactHistory('u1', undefined, 1))).toHaveLength(1);
  });

  it('purgeAllFactVersions wipes the user, never another user', async () => {
    await recordFactVersions({ userId: 'u1', before: {}, after: { a: '1' }, source: 'turn', removal: 'purge' });
    await recordFactVersions({ userId: 'u2', before: {}, after: { a: '1' }, source: 'turn', removal: 'purge' });
    expect(await purgeAllFactVersions('u1')).toBe(1);
    expect(versions.rows.map((v) => v.userId)).toEqual(['u2']);
  });
});
