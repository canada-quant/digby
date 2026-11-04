/**
 * Phase 2 LEG 2c — question registry pending-key transport: awaitAnswer
 * publishes a Redis pending-presence key (the web endpoint's ownership check),
 * and EVERY exit from the wait (resolve / timeout / resolvePendingForSession)
 * unpublishes it. The in-memory semantics (soft 60-min deadline → 2-min answer
 * grace → hard-stop null; unknown-id → false) are covered with fake timers.
 * Redis is mocked with the leg-1 in-memory stand-in.
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

// Fleet supervisor (slice B): publishQuestionPending's attention emission
// dynamically imports hooks.service — mocked at the module boundary (the real
// module's chain reaches config/env, which exits the jest worker at import).
jest.mock('../platform/hooks.service', () => ({
  __esModule: true,
  emitHookEventSafe: jest.fn(async () => {}),
}));

import {
  awaitAnswer, questionSession, resolveAnswer, applyQuestionResolution, resolvePendingForSession,
} from './question-registry';
import { fingerprintFor } from './pending-durable';

const KEY = (id: string) => `coding:question:pending:${id}`;
const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

beforeEach(() => {
  mockStore.clear();
  jest.clearAllMocks();
});

describe('awaitAnswer pending-key lifecycle', () => {
  it('publishes the pending key (→ owning session) when the wait starts', async () => {
    const p = awaitAnswer('q-await', 's1');
    await flush();
    expect(mockStore.get(KEY('q-await'))).toBe('s1');
    resolveAnswer('q-await', 'option B'); // don't leak the 60-min timer
    await expect(p).resolves.toBe('option B');
  });

  it('resolveAnswer resolves with the answer AND unpublishes the key', async () => {
    const p = awaitAnswer('q-resolve', 's1');
    await flush();
    expect(resolveAnswer('q-resolve', 'the human said this')).toBe(true);
    await expect(p).resolves.toBe('the human said this');
    expect(mockStore.has(KEY('q-resolve'))).toBe(false);
  });

  it('the soft deadline enters GRACE (still answerable, key retained); the hard stop resolves null + unpublishes', async () => {
    jest.useFakeTimers();
    try {
      const p = awaitAnswer('q-timeout', 's1');
      await flush();
      expect(mockStore.has(KEY('q-timeout'))).toBe(true);
      // Soft deadline (60 min): NOT resolved yet — the grace window keeps the
      // question answerable so in-flight answers still land.
      jest.advanceTimersByTime(60 * 60 * 1000);
      await flush();
      expect(questionSession('q-timeout')).toBe('s1');
      expect(mockStore.has(KEY('q-timeout'))).toBe(true);
      // Hard stop (soft + 2-min grace): resolves null, key gone.
      jest.advanceTimersByTime(2 * 60 * 1000);
      await expect(p).resolves.toBeNull();
      expect(mockStore.has(KEY('q-timeout'))).toBe(false);
      expect(questionSession('q-timeout')).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  it('an answer landing DURING the grace window still resolves (the tap-at-T-1s race)', async () => {
    jest.useFakeTimers();
    try {
      const p = awaitAnswer('q-grace', 's1');
      await flush();
      jest.advanceTimersByTime(60 * 60 * 1000 + 30 * 1000); // 30s into grace
      await flush();
      expect(resolveAnswer('q-grace', 'just made it')).toBe(true);
      await expect(p).resolves.toBe('just made it');
      expect(mockStore.has(KEY('q-grace'))).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  it('an answer landing AFTER the hard stop is a no-op (unknown/expired)', async () => {
    jest.useFakeTimers();
    try {
      const p = awaitAnswer('q-late', 's1');
      await flush();
      jest.advanceTimersByTime(62 * 60 * 1000);
      await expect(p).resolves.toBeNull();
      expect(resolveAnswer('q-late', 'too late')).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  it('applyQuestionResolution (the executor drain entrypoint) applies an answer like resolveAnswer', async () => {
    const p = awaitAnswer('q-apply', 's1');
    await flush();
    expect(applyQuestionResolution('q-apply', 'mailbox answer')).toBe(true);
    await expect(p).resolves.toBe('mailbox answer');
    expect(mockStore.has(KEY('q-apply'))).toBe(false);
  });

  it('an unknown/expired id is a no-op (a late answer resolves nothing)', () => {
    expect(applyQuestionResolution('q-gone', 'too late')).toBe(false);
  });
});

describe('resolvePendingForSession', () => {
  it('resolves (null) + unpublishes every pending of the session, returns the count', async () => {
    const p1 = awaitAnswer('q-s1-1', 's1');
    const p2 = awaitAnswer('q-s1-2', 's1');
    const pOther = awaitAnswer('q-s2', 's2');
    await flush();

    expect(resolvePendingForSession('s1')).toBe(2);

    await expect(p1).resolves.toBeNull();
    await expect(p2).resolves.toBeNull();
    expect(mockStore.has(KEY('q-s1-1'))).toBe(false);
    expect(mockStore.has(KEY('q-s1-2'))).toBe(false);
    // s2's pending is untouched — still awaiting, key still published.
    expect(mockStore.get(KEY('q-s2'))).toBe('s2');
    expect(questionSession('q-s2')).toBe('s2');
    resolveAnswer('q-s2', 'cleanup'); // cleanup
    await expect(pOther).resolves.toBe('cleanup');
  });
});

/* ====================================================================
 * Phase 4 — durable records + fingerprint replay/alias (pending-durable.ts)
 * ==================================================================== */
const REC = (id: string) => `coding:pend:question:${id}`;
const FP = (sessionId: string, seed: string) => `coding:pendfp:question:${sessionId}:${fingerprintFor('question', seed)}`;
const readRec = (id: string): any => JSON.parse(mockStore.get(REC(id)) ?? 'null');
// The Phase-4 async block chains several mocked-Redis awaits — deeper than the
// LEG-2c flush. Microtask-only, so it is safe under fake timers too.
const flushDeep = async () => { for (let i = 0; i < 25; i++) await Promise.resolve(); };

describe('Phase 4 durable records', () => {
  it('awaitAnswer with a seed writes a pending record + fingerprint pointer', async () => {
    const p = awaitAnswer('q-dur', 's1', 'Deploy to prod?', 'qseed-1');
    await flushDeep();
    const rec = readRec('q-dur');
    expect(rec.status).toBe('pending');
    expect(rec.detail).toBe('Deploy to prod?');
    expect(mockStore.get(FP('s1', 'qseed-1'))).toBe('q-dur');
    resolveAnswer('q-dur', 'yes'); // don't leak the timer
    await expect(p).resolves.toBe('yes');
  });

  it('resolveAnswer marks the record answered with the answer text', async () => {
    const p = awaitAnswer('q-mark', 's1', 'q', 'qseed-2');
    await flushDeep();
    resolveAnswer('q-mark', 'blue');
    await expect(p).resolves.toBe('blue');
    await flushDeep();
    expect(readRec('q-mark')).toMatchObject({ status: 'answered', resolution: 'blue' });
  });

  it('the hard stop marks the record expired', async () => {
    jest.useFakeTimers();
    try {
      const p = awaitAnswer('q-exp', 's1', 'q', 'qseed-3');
      await flushDeep();
      jest.advanceTimersByTime(62 * 60 * 1000);
      await expect(p).resolves.toBeNull();
      await flushDeep();
      expect(readRec('q-exp').status).toBe('expired');
    } finally {
      jest.useRealTimers();
    }
  });

  it('REPLAY: a restarted run re-asking an answered question resolves with the recorded answer — no re-prompt', async () => {
    const p1 = awaitAnswer('q-old', 's1', 'q', 'qseed-4');
    await flushDeep();
    resolveAnswer('q-old', 'option B');
    await expect(p1).resolves.toBe('option B');
    await flushDeep();
    const p2 = awaitAnswer('q-new', 's1', 'q', 'qseed-4');
    await expect(p2).resolves.toBe('option B'); // replayed — no human involved
    expect(questionSession('q-new')).toBeNull();
    expect(mockStore.has(KEY('q-new'))).toBe(false);
  });

  it('ALIAS: a re-asked still-pending question re-points the fingerprint at the new id', async () => {
    void awaitAnswer('q-old2', 's1', 'q', 'qseed-5');
    await flushDeep();
    expect(mockStore.get(FP('s1', 'qseed-5'))).toBe('q-old2');
    const p2 = awaitAnswer('q-new2', 's1', 'q', 'qseed-5');
    await flushDeep();
    expect(mockStore.get(FP('s1', 'qseed-5'))).toBe('q-new2');
    resolveAnswer('q-new2', 'live answer');
    await expect(p2).resolves.toBe('live answer');
    resolveAnswer('q-old2', 'cleanup'); // release the abandoned wait's timer
  });

  it('a stop (resolvePendingForSession) marks expired and never replays', async () => {
    const p1 = awaitAnswer('q-stop', 's9', 'q', 'qseed-6');
    await flushDeep();
    expect(resolvePendingForSession('s9')).toBe(1);
    await expect(p1).resolves.toBeNull();
    await flushDeep();
    expect(readRec('q-stop').status).toBe('expired');
    const p2 = awaitAnswer('q-stop2', 's9', 'q', 'qseed-6');
    await flushDeep();
    expect(questionSession('q-stop2')).toBe('s9'); // a fresh wait, no replay
    resolveAnswer('q-stop2', 'ok');
    await expect(p2).resolves.toBe('ok');
  });
});
