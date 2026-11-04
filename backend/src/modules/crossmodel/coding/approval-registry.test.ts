/**
 * Phase 2 LEG 2c — approval registry pending-key transport: awaitApproval
 * publishes a Redis pending-presence key (the web endpoint's ownership check),
 * and EVERY exit from the wait (resolve / timeout / denyPendingForSession)
 * unpublishes it. The in-memory semantics (14-min auto-deny, unknown-id →
 * false) are unchanged. Redis is mocked with the leg-1 in-memory stand-in.
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

// Fleet supervisor (slice B): publishApprovalPending's attention emission
// dynamically imports hooks.service — mocked at the module boundary (the real
// module's chain reaches config/env, which exits the jest worker at import).
jest.mock('../platform/hooks.service', () => ({
  __esModule: true,
  emitHookEventSafe: jest.fn(async () => {}),
}));

import {
  awaitApproval, approvalSession, resolveApproval, applyApprovalResolution, denyPendingForSession,
} from './approval-registry';
import { fingerprintFor } from './pending-durable';

const KEY = (id: string) => `coding:approval:pending:${id}`;
const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

beforeEach(() => {
  mockStore.clear();
  jest.clearAllMocks();
});

describe('awaitApproval pending-key lifecycle', () => {
  it('publishes the pending key (→ owning session) when the wait starts', async () => {
    const p = awaitApproval('a-await', 's1');
    await flush();
    expect(mockStore.get(KEY('a-await'))).toBe('s1');
    resolveApproval('a-await', 'allow'); // don't leak the 14-min timer
    await expect(p).resolves.toBe('allow');
  });

  it('resolveApproval resolves with the decision AND unpublishes the key', async () => {
    const p = awaitApproval('a-resolve', 's1');
    await flush();
    expect(resolveApproval('a-resolve', 'always')).toBe(true);
    await expect(p).resolves.toBe('always');
    expect(mockStore.has(KEY('a-resolve'))).toBe(false);
  });

  it('the timeout auto-denies AND unpublishes the key (no stale pending)', async () => {
    jest.useFakeTimers();
    try {
      const p = awaitApproval('a-timeout', 's1');
      await flush();
      expect(mockStore.has(KEY('a-timeout'))).toBe(true);
      jest.advanceTimersByTime(14 * 60 * 1000);
      await expect(p).resolves.toBe('deny');
      expect(mockStore.has(KEY('a-timeout'))).toBe(false);
      expect(approvalSession('a-timeout')).toBeNull(); // gone from the local map too
    } finally {
      jest.useRealTimers();
    }
  });

  it('applyApprovalResolution (the executor drain entrypoint) applies a decision like resolveApproval', async () => {
    const p = awaitApproval('a-apply', 's1');
    await flush();
    expect(applyApprovalResolution('a-apply', 'deny')).toBe(true);
    await expect(p).resolves.toBe('deny');
    expect(mockStore.has(KEY('a-apply'))).toBe(false);
  });

  it('an unknown/expired id is a no-op (a late click resolves nothing)', () => {
    expect(applyApprovalResolution('a-gone', 'allow')).toBe(false);
  });
});

describe('denyPendingForSession', () => {
  it('denies + unpublishes every pending of the session, leaving other sessions alone', async () => {
    const p1 = awaitApproval('a-s1-1', 's1');
    const p2 = awaitApproval('a-s1-2', 's1');
    const pOther = awaitApproval('a-s2', 's2');
    await flush();

    denyPendingForSession('s1');

    await expect(p1).resolves.toBe('deny');
    await expect(p2).resolves.toBe('deny');
    expect(mockStore.has(KEY('a-s1-1'))).toBe(false);
    expect(mockStore.has(KEY('a-s1-2'))).toBe(false);
    // s2's pending is untouched — still awaiting, key still published.
    expect(mockStore.get(KEY('a-s2'))).toBe('s2');
    expect(approvalSession('a-s2')).toBe('s2');
    resolveApproval('a-s2', 'allow'); // cleanup
    await expect(pOther).resolves.toBe('allow');
  });
});

/* ====================================================================
 * Phase 4 — durable records + fingerprint replay/alias (pending-durable.ts)
 * ==================================================================== */
const REC = (id: string) => `coding:pend:approval:${id}`;
const FP = (sessionId: string, seed: string) => `coding:pendfp:approval:${sessionId}:${fingerprintFor('approval', seed)}`;
const readRec = (id: string): any => JSON.parse(mockStore.get(REC(id)) ?? 'null');
// The Phase-4 async block chains several mocked-Redis awaits — deeper than the
// LEG-2c flush. Microtask-only, so it is safe under fake timers too.
const flushDeep = async () => { for (let i = 0; i < 25; i++) await Promise.resolve(); };

describe('Phase 4 durable records', () => {
  it('awaitApproval with a seed writes a pending record + fingerprint pointer', async () => {
    const p = awaitApproval('a-dur', 's1', 'Allow run_command: ls?', 'seed-1');
    await flushDeep();
    const rec = readRec('a-dur');
    expect(rec.status).toBe('pending');
    expect(rec.sessionId).toBe('s1');
    expect(rec.detail).toBe('Allow run_command: ls?');
    expect(mockStore.get(FP('s1', 'seed-1'))).toBe('a-dur');
    resolveApproval('a-dur', 'allow'); // don't leak the timer
    await expect(p).resolves.toBe('allow');
  });

  it('resolveApproval marks the record answered with the decision', async () => {
    const p = awaitApproval('a-mark', 's1', 'prompt', 'seed-2');
    await flushDeep();
    resolveApproval('a-mark', 'always');
    await expect(p).resolves.toBe('always');
    await flushDeep();
    expect(readRec('a-mark')).toMatchObject({ status: 'answered', resolution: 'always' });
  });

  it('the timeout marks the record expired (never replayed)', async () => {
    jest.useFakeTimers();
    try {
      const p = awaitApproval('a-exp', 's1', 'prompt', 'seed-3');
      await flushDeep();
      jest.advanceTimersByTime(14 * 60 * 1000);
      await expect(p).resolves.toBe('deny');
      await flushDeep();
      expect(readRec('a-exp').status).toBe('expired');
    } finally {
      jest.useRealTimers();
    }
  });

  it('REPLAY: a restarted run re-asking a decided call resolves with the recorded decision — no re-prompt', async () => {
    // Run 1: the human decides.
    const p1 = awaitApproval('a-old', 's1', 'prompt', 'seed-4');
    await flushDeep();
    resolveApproval('a-old', 'always');
    await expect(p1).resolves.toBe('always');
    await flushDeep();
    // "Restart": run 2 re-asks the identical call (same seed) under a new id.
    const p2 = awaitApproval('a-new', 's1', 'prompt', 'seed-4');
    await expect(p2).resolves.toBe('always'); // replayed — no human involved
    expect(approvalSession('a-new')).toBeNull(); // never left pending
    expect(mockStore.has(KEY('a-new'))).toBe(false);
  });

  it('ALIAS: a restarted run re-asking a still-pending call re-points the fingerprint at the new id', async () => {
    // Run 1 parks (the "process death" leaves its durable record pending).
    void awaitApproval('a-old2', 's1', 'prompt', 'seed-5');
    await flushDeep();
    expect(mockStore.get(FP('s1', 'seed-5'))).toBe('a-old2');
    // Run 2 re-asks under a new id → the fingerprint aliases.
    const p2 = awaitApproval('a-new2', 's1', 'prompt', 'seed-5');
    await flushDeep();
    expect(mockStore.get(FP('s1', 'seed-5'))).toBe('a-new2');
    resolveApproval('a-new2', 'allow');
    await expect(p2).resolves.toBe('allow');
    resolveApproval('a-old2', 'deny'); // release the abandoned wait's timer
  });

  it('a stop (denyPendingForSession) marks expired, and a later re-ask does NOT replay it', async () => {
    const p1 = awaitApproval('a-stop', 's9', 'prompt', 'seed-6');
    await flushDeep();
    denyPendingForSession('s9');
    await expect(p1).resolves.toBe('deny');
    await flushDeep();
    expect(readRec('a-stop').status).toBe('expired');
    // Re-ask after restart: expired is not a human decision → a fresh wait.
    const p2 = awaitApproval('a-stop2', 's9', 'prompt', 'seed-6');
    await flushDeep();
    expect(approvalSession('a-stop2')).toBe('s9'); // genuinely pending again
    resolveApproval('a-stop2', 'allow');
    await expect(p2).resolves.toBe('allow');
  });
});
