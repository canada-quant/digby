/**
 * Phase 4 — durable pending records (pending-durable.ts): save/load roundtrip,
 * fingerprint pointer follow + alias, first-writer-wins terminal transition,
 * stableStringify key-order independence, fail-open Redis behavior.
 * Redis is mocked with the leg-1 in-memory stand-in (same shape as the
 * registry tests).
 */

const mockStore = new Map<string, string>();

jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: {
    set: jest.fn(async (k: string, v: string) => { mockStore.set(k, v); return 'OK'; }),
    get: jest.fn(async (k: string) => mockStore.get(k) ?? null),
    del: jest.fn(async (k: string) => { mockStore.delete(k); return 1; }),
    exists: jest.fn(async (k: string) => (mockStore.has(k) ? 1 : 0)),
    expire: jest.fn(async () => true),
    rPush: jest.fn(async () => 1),
    lPop: jest.fn(async () => null),
    lTrim: jest.fn(async () => 'OK'),
  },
}));

import redisClient from '../../../config/redis';
import {
  stableStringify, fingerprintFor, saveDurablePending, loadDurablePending,
  currentIdForFingerprint, findDurableByFingerprint, aliasDurableFingerprint, markDurableResolved,
  DurablePendingRecord,
} from './pending-durable';

const rec = (over: Partial<DurablePendingRecord> = {}): DurablePendingRecord => ({
  id: 'a1', kind: 'approval', sessionId: 's1', fingerprint: null,
  detail: 'Allow run_command: ls?', status: 'pending', createdAt: 123, ...over,
});

beforeEach(() => {
  mockStore.clear();
  jest.clearAllMocks();
});

describe('stableStringify / fingerprintFor', () => {
  it('is key-order independent (recursively), so identical re-asks hash identically', () => {
    const a = stableStringify({ tool: 'run_command', args: { command: 'ls', timeout: 5, nested: { b: 2, a: 1 } } });
    const b = stableStringify({ args: { nested: { a: 1, b: 2 }, timeout: 5, command: 'ls' }, tool: 'run_command' });
    expect(a).toBe(b);
  });

  it('distinguishes values, arrays, and kinds', () => {
    expect(stableStringify({ a: [1, 2] })).not.toBe(stableStringify({ a: [2, 1] }));
    expect(fingerprintFor('approval', 'same')).not.toBe(fingerprintFor('question', 'same'));
    expect(fingerprintFor('approval', 'same')).toBe(fingerprintFor('approval', 'same'));
  });
});

describe('save / load roundtrip', () => {
  it('persists the record and the fingerprint pointer', async () => {
    await saveDurablePending(rec({ fingerprint: 'fp1' }));
    const loaded = await loadDurablePending('approval', 'a1');
    expect(loaded).toMatchObject({ id: 'a1', sessionId: 's1', status: 'pending', detail: 'Allow run_command: ls?' });
    expect(await currentIdForFingerprint('approval', 's1', 'fp1')).toBe('a1');
  });

  it('a null fingerprint writes no pointer', async () => {
    await saveDurablePending(rec());
    expect(await loadDurablePending('approval', 'a1')).not.toBeNull();
    expect(mockStore.has('coding:pendfp:approval:s1:null')).toBe(false);
  });

  it('unknown id / malformed JSON → null (never a throw)', async () => {
    expect(await loadDurablePending('approval', 'nope')).toBeNull();
    mockStore.set('coding:pend:approval:bad', '{not json');
    expect(await loadDurablePending('approval', 'bad')).toBeNull();
  });
});

describe('fingerprint follow + alias', () => {
  it('findDurableByFingerprint follows the pointer; alias re-points it', async () => {
    await saveDurablePending(rec({ id: 'old', fingerprint: 'fp1' }));
    expect((await findDurableByFingerprint('approval', 's1', 'fp1'))?.id).toBe('old');
    await saveDurablePending(rec({ id: 'new', fingerprint: 'fp1' }));
    await aliasDurableFingerprint('approval', 's1', 'fp1', 'new');
    expect(await currentIdForFingerprint('approval', 's1', 'fp1')).toBe('new');
    expect((await findDurableByFingerprint('approval', 's1', 'fp1'))?.id).toBe('new');
  });

  it('a dangling pointer (record expired away) → null', async () => {
    await saveDurablePending(rec({ id: 'gone', fingerprint: 'fp1' }));
    mockStore.delete('coding:pend:approval:gone');
    expect(await findDurableByFingerprint('approval', 's1', 'fp1')).toBeNull();
  });
});

describe('markDurableResolved (first-writer-wins)', () => {
  it('moves pending → terminal with resolution + resolvedAt', async () => {
    await saveDurablePending(rec());
    await markDurableResolved('approval', 'a1', 'answered', 'always');
    const loaded = await loadDurablePending('approval', 'a1');
    expect(loaded?.status).toBe('answered');
    expect(loaded?.resolution).toBe('always');
    expect(typeof loaded?.resolvedAt).toBe('number');
  });

  it('a second transition is a no-op — a late timeout cannot clobber a human decision', async () => {
    await saveDurablePending(rec());
    await markDurableResolved('approval', 'a1', 'answered', 'allow');
    await markDurableResolved('approval', 'a1', 'expired', 'deny');
    const loaded = await loadDurablePending('approval', 'a1');
    expect(loaded?.status).toBe('answered');
    expect(loaded?.resolution).toBe('allow');
  });

  it('an absent record is a no-op; the resolution is sliced to 8000', async () => {
    await markDurableResolved('approval', 'nope', 'answered', 'x');
    expect(await loadDurablePending('approval', 'nope')).toBeNull();
    await saveDurablePending(rec());
    await markDurableResolved('approval', 'a1', 'answered', 'y'.repeat(9000));
    expect((await loadDurablePending('approval', 'a1'))?.resolution).toHaveLength(8000);
  });
});

describe('fail-open (a Redis hiccup degrades, never throws)', () => {
  it('save/load/mark swallow a rejected client', async () => {
    (redisClient.set as jest.Mock).mockRejectedValueOnce(new Error('redis down'));
    await expect(saveDurablePending(rec({ fingerprint: 'fp1' }))).resolves.toBeUndefined();
    (redisClient.get as jest.Mock).mockRejectedValueOnce(new Error('redis down'));
    await expect(loadDurablePending('approval', 'a1')).resolves.toBeNull();
    (redisClient.get as jest.Mock).mockRejectedValueOnce(new Error('redis down'));
    await expect(markDurableResolved('approval', 'a1', 'answered', 'allow')).resolves.toBeUndefined();
  });
});
