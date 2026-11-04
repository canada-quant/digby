/**
 * A4 (2026-09-27 spark-cluster audit): the "no verify chain" session marker.
 *
 * `recordVerifyAbsent` / `getVerifyAbsent` live under their OWN store key so
 * the PR gate's `state` record (getVerifyState — fail-open on absence) is
 * never touched; the marker counts hits across both seams; the env kill
 * seam is observed unconditionally (the kill switch retired 2026-11-02).
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const memStore = new Map<string, any>();
jest.mock('../memory/context-store', () => ({
  __esModule: true,
  storeGet: jest.fn(async (ns: string[], key: string) => memStore.get(`${ns.join('/')}/${key}`) ?? null),
  storePut: jest.fn(async (ns: string[], key: string, value: any) => { memStore.set(`${ns.join('/')}/${key}`, value); }),
}));
jest.mock('./verify.service', () => ({
  __esModule: true,
  consumeEnvironmentalRed: jest.fn(() => null),
  noteEnvironmentalVerifyRed: jest.fn(async () => {}),
}));
jest.mock('./workspace.service', () => ({ __esModule: true, git: jest.fn() }));

import { getVerifyAbsent, getVerifyState, recordVerifyAbsent } from './verify-state';

beforeEach(() => {
  memStore.clear();
});

describe('A4 verify-absent marker (2026-09-27)', () => {
  it('records reason/seam/configPresent/at and counts across seams; the PR-gate state stays untouched', async () => {
    expect(await getVerifyAbsent('s1')).toBeNull();
    await recordVerifyAbsent('s1', { seam: 'tool', configPresent: false });
    const first = await getVerifyAbsent('s1');
    expect(first).toMatchObject({ reason: 'no_chain', seam: 'tool', configPresent: false, count: 1 });
    expect(Date.parse(first!.at)).toBeGreaterThan(0);

    await recordVerifyAbsent('s1', { seam: 'auto', configPresent: true });
    expect(await getVerifyAbsent('s1')).toMatchObject({ reason: 'no_chain', seam: 'auto', configPresent: true, count: 2 });

    // Own key: the gate record is still absent (fail-open contract intact).
    expect(await getVerifyState('s1')).toBeNull();
    expect(Array.from(memStore.keys())).toEqual(['s1/coding-verify/absent']);
  });

  it('is per session', async () => {
    await recordVerifyAbsent('s1', { seam: 'auto', configPresent: false });
    expect(await getVerifyAbsent('s2')).toBeNull();
  });

  it('never throws when the store is down', async () => {
    const cs = jest.requireMock('../memory/context-store');
    cs.storePut.mockRejectedValueOnce(new Error('pg down'));
    await expect(recordVerifyAbsent('s1', { seam: 'auto', configPresent: false })).resolves.toBeUndefined();
    cs.storeGet.mockRejectedValueOnce(new Error('pg down'));
    expect(await getVerifyAbsent('s1')).toBeNull();
  });
});
