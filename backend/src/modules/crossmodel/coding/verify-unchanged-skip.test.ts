/**
 * A1 (2026-10-04 coding quick wins) — the pure helpers of the auto-verify
 * unchanged-skip, plus the verify-state round trip of the skip key (chainSig +
 * stages) against an in-memory context store. The agent seam itself is pinned
 * in agent-verify-unchanged-skip.test.ts.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../../config/database', () => ({ __esModule: true, default: {} }));
const memStore = new Map<string, any>();
jest.mock('../memory/context-store', () => ({
  __esModule: true,
  storeGet: jest.fn(async (ns: string[], key: string) => memStore.get(`${ns.join('/')}/${key}`) ?? null),
  storePut: jest.fn(async (ns: string[], key: string, value: any) => { memStore.set(`${ns.join('/')}/${key}`, value); }),
}));

import {
  autoVerifyUnchangedSkipDisabled, verifyChainSignature, greenCoversChain, unchangedSinceGreenText,
} from './verify-unchanged-skip';
import { recordVerify, getVerifyState } from './verify-state';

const CHAIN = [{ key: 'typecheck', command: 'tsc --noEmit' }, { key: 'test', command: 'jest' }];
const SIG = verifyChainSignature(CHAIN);
const GREEN = { passed: true, at: '2026-10-03T22:15:30.000Z', sha: 'abc123def4567890', tree: 'tree-1', chainSig: SIG, stages: ['typecheck', 'test'] };

afterEach(() => { delete process.env.AUTO_VERIFY_UNCHANGED_SKIP_DISABLED; memStore.clear(); });

describe('verifyChainSignature', () => {
  it('is stable, 16 hex, and changes with a key, a command or the order', () => {
    expect(SIG).toMatch(/^[0-9a-f]{16}$/);
    expect(verifyChainSignature(CHAIN.map((c) => ({ ...c })))).toBe(SIG);
    expect(verifyChainSignature([CHAIN[0]])).not.toBe(SIG); // a verify({only}) subset
    expect(verifyChainSignature([CHAIN[0], { key: 'test', command: 'jest --ci' }])).not.toBe(SIG); // edited command
    expect(verifyChainSignature([CHAIN[1], CHAIN[0]])).not.toBe(SIG); // reordered
  });
});

describe('greenCoversChain', () => {
  it('true only for a REAL green of exactly this chain with a tree', () => {
    expect(greenCoversChain(GREEN, SIG)).toBe(true);
    expect(greenCoversChain(null, SIG)).toBe(false);
    expect(greenCoversChain({ ...GREEN, passed: false }, SIG)).toBe(false);
    expect(greenCoversChain({ ...GREEN, unverified: true }, SIG)).toBe(false);
    expect(greenCoversChain({ ...GREEN, deferred: true }, SIG)).toBe(false);
    expect(greenCoversChain({ ...GREEN, environmental: true }, SIG)).toBe(false);
    expect(greenCoversChain({ ...GREEN, tree: null }, SIG)).toBe(false);
    expect(greenCoversChain({ ...GREEN, chainSig: undefined }, SIG)).toBe(false); // legacy record
    expect(greenCoversChain(GREEN, verifyChainSignature([CHAIN[0]]))).toBe(false);
    expect(greenCoversChain(GREEN, '')).toBe(false);
  });
});

describe('unchangedSinceGreenText', () => {
  it('names the earlier green (stages, minute stamp, short sha) and never says "passed"', () => {
    const t = unchangedSinceGreenText(GREEN, ['typecheck', 'test']);
    expect(t).toContain("unchanged since this session's last GREEN verify (typecheck, test at 2026-10-03T22:15Z on abc123def456)");
    expect(t).not.toMatch(/Auto-verify passed/);
    expect(unchangedSinceGreenText({ ...GREEN, at: undefined, sha: null }, ['test'])).toContain('GREEN verify (test).');
  });
});

describe('kill switch', () => {
  it('AUTO_VERIFY_UNCHANGED_SKIP_DISABLED accepts 1 / true / on', () => {
    expect(autoVerifyUnchangedSkipDisabled()).toBe(false);
    for (const v of ['1', 'true', 'on']) {
      process.env.AUTO_VERIFY_UNCHANGED_SKIP_DISABLED = v;
      expect(autoVerifyUnchangedSkipDisabled()).toBe(true);
    }
    process.env.AUTO_VERIFY_UNCHANGED_SKIP_DISABLED = '0';
    expect(autoVerifyUnchangedSkipDisabled()).toBe(false);
  });
});

describe('verify-state round trip of the skip key', () => {
  it('recordVerify persists chainSig + stages and getVerifyState returns a record greenCoversChain accepts', async () => {
    await recordVerify('s-rt', true, undefined, { fingerprint: { sha: 'sha1', tree: 'tree-1' }, chainSig: SIG, stages: ['typecheck', 'test'] });
    const vs = await getVerifyState('s-rt');
    expect(vs).toMatchObject({ passed: true, sha: 'sha1', tree: 'tree-1', chainSig: SIG, stages: ['typecheck', 'test'] });
    expect(greenCoversChain(vs, SIG)).toBe(true);
  });

  it('a record written without the key (kill switch / legacy) has neither field and never covers', async () => {
    await recordVerify('s-legacy', true, undefined, { fingerprint: { sha: 'sha1', tree: 'tree-1' } });
    const vs = await getVerifyState('s-legacy');
    expect(vs).not.toHaveProperty('chainSig');
    expect(vs).not.toHaveProperty('stages');
    expect(greenCoversChain(vs, SIG)).toBe(false);
  });
});
