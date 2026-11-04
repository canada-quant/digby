/**
 * Phase 2 — cross-process cancel + steer channels on top of the session run
 * lock. Redis is mocked with a small in-memory store/list so the round-trips
 * (request→take, push→drain, LTRIM bound) are exercised for real.
 */

const mockStore = new Map<string, string>();
const mockLists = new Map<string, string[]>();

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: jest.fn(async () => {}),
  LOOP_METRIC_KINDS: { RUN_LOCK_REACQUIRED: 'run_lock_reacquired' },
}));

jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: {
    // Real NX semantics (audit #8 fenced-lock tests): a held key refuses the SET.
    set: jest.fn(async (k: string, v: string, opts?: any) => {
      if (opts?.NX && mockStore.has(k)) return null;
      mockStore.set(k, v);
      return 'OK';
    }),
    get: jest.fn(async (k: string) => mockStore.get(k) ?? null),
    del: jest.fn(async (k: string) => { mockStore.delete(k); return 1; }),
    exists: jest.fn(async (k: string) => (mockStore.has(k) ? 1 : 0)),
    expire: jest.fn(async () => true),
    rPush: jest.fn(async (k: string, v: string) => {
      const l = mockLists.get(k) ?? [];
      l.push(v);
      mockLists.set(k, l);
      return l.length;
    }),
    lPop: jest.fn(async (k: string) => {
      const l = mockLists.get(k) ?? [];
      const v = l.shift();
      if (l.length) mockLists.set(k, l); else mockLists.delete(k);
      return v ?? null;
    }),
    lTrim: jest.fn(async (k: string, start: number, stop: number) => {
      const l = mockLists.get(k) ?? [];
      const len = l.length;
      const s = start < 0 ? Math.max(len + start, 0) : start;
      const e = stop < 0 ? len + stop : stop;
      mockLists.set(k, l.slice(s, e + 1));
      return 'OK';
    }),
  },
}));

// Fleet supervisor (slice B): the attention_needed emission rides a dynamic
// import of hooks.service from the pending-publish functions — mocked at the
// module boundary (the real module's chain reaches config/env, which exits the
// jest worker at import).
const mockEmitHookEventSafe = jest.fn(async (..._a: any[]) => {});
jest.mock('../platform/hooks.service', () => ({
  __esModule: true,
  emitHookEventSafe: (...a: any[]) => mockEmitHookEventSafe(...a),
}));

import {
  requestRunCancel, readRunCancelActor, takeRunCancelRequest, pushSteerMessage, drainSteerMessages,
  publishApprovalPending, getApprovalPendingSession, unpublishApprovalPending,
  publishQuestionPending, getQuestionPendingSession, unpublishQuestionPending, refreshQuestionPending,
  publishApprovalResolution, publishQuestionResolution, drainResolutions,
  isSessionRunLockedStrict,
  acquireSessionRunLock, refreshSessionRunLock, releaseSessionRunLock, runLockOwnerToken, LOCK_TTL_SEC,
} from './session-run-lock';
import { ChatImage, MAX_IMAGES } from './chat-images';
import mockLogger from '../../../utils/logger';

const IMG = (n: number): ChatImage => ({ mediaType: 'image/png', data: `aW1hZ2U=${n}`, name: `i${n}.png` });

beforeEach(() => {
  mockStore.clear();
  mockLists.clear();
  jest.clearAllMocks();
});

describe('fenced session run-lock (audit #8 — owner token via SET NX + GET-compare)', () => {
  const LOCK_KEY = 'coding:session:run:s1';
  const OWNER = 'worker-box-1:runA';
  const OTHER = 'worker-box-2:runB';
  const warn = () => (mockLogger as any).warn as jest.Mock;

  it('runLockOwnerToken composes worker identity + runId (workerId:runId fencing shape)', () => {
    const token = runLockOwnerToken('run-42');
    expect(token).toMatch(/^worker-.+-\d+:run-42$/);
    expect(token).toContain(String(process.pid));
  });

  it('acquire stores the OWNER TOKEN under NX+TTL; a held lock refuses a second acquire', async () => {
    expect(await acquireSessionRunLock('s1', OWNER)).toBe(true);
    expect(mockStore.get(LOCK_KEY)).toBe(OWNER);
    const redis = (await import('../../../config/redis')).default;
    expect(redis.set).toHaveBeenCalledWith(LOCK_KEY, OWNER, { NX: true, EX: LOCK_TTL_SEC });
    expect(await acquireSessionRunLock('s1', OTHER)).toBe(false); // NX: held → refused
    expect(mockStore.get(LOCK_KEY)).toBe(OWNER); // the holder's token survives
  });

  it('refresh by the OWNER re-arms the TTL (identical TTL semantics), token unchanged', async () => {
    await acquireSessionRunLock('s1', OWNER);
    const redis = (await import('../../../config/redis')).default;
    (redis.set as jest.Mock).mockClear();
    await refreshSessionRunLock('s1', OWNER);
    expect(redis.set).toHaveBeenCalledWith(LOCK_KEY, OWNER, { EX: LOCK_TTL_SEC });
    expect(mockStore.get(LOCK_KEY)).toBe(OWNER);
    expect(warn()).not.toHaveBeenCalled();
  });

  it('refresh by a NON-OWNER warns and no-ops — the holder token is never overwritten (lock steal refused)', async () => {
    await acquireSessionRunLock('s1', OWNER);
    const redis = (await import('../../../config/redis')).default;
    (redis.set as jest.Mock).mockClear();
    await refreshSessionRunLock('s1', OTHER);
    expect(redis.set).not.toHaveBeenCalled(); // no write at all
    expect(mockStore.get(LOCK_KEY)).toBe(OWNER);
    expect(warn()).toHaveBeenCalledWith(expect.stringContaining('refresh refused for session s1'));
  });

  it('refresh of a MISSING lock RE-ACQUIRES it for the live owner (NX) and warns — evicted / Redis-restarted locks come back (loop #14)', async () => {
    const redis = (await import('../../../config/redis')).default;
    (redis.set as jest.Mock).mockClear();
    await refreshSessionRunLock('s1', OWNER);
    expect(mockStore.get(LOCK_KEY)).toBe(OWNER);
    expect(redis.set).toHaveBeenCalledWith(LOCK_KEY, OWNER, { NX: true, EX: LOCK_TTL_SEC });
    expect(warn()).toHaveBeenCalledWith(expect.stringContaining('was MISSING'));
    expect(warn()).toHaveBeenCalledWith(expect.stringContaining('re-acquired by its live owner'));
  });

  it('a MISSING-lock re-acquire that LOSES the NX race (another owner took the session in between) is refused — the new holder is never overwritten', async () => {
    const redis = (await import('../../../config/redis')).default;
    // GET sees nothing (evicted), but by the time we SET NX the other worker's fresh claim holds it.
    (redis.get as jest.Mock).mockResolvedValueOnce(null);
    mockStore.set(LOCK_KEY, OTHER);
    await refreshSessionRunLock('s1', OWNER);
    expect(mockStore.get(LOCK_KEY)).toBe(OTHER);
    expect(warn()).toHaveBeenCalledWith(expect.stringContaining('lost the race'));
    expect(warn()).not.toHaveBeenCalledWith(expect.stringContaining('re-acquired'));
  });

  it('release by the OWNER deletes the lock', async () => {
    await acquireSessionRunLock('s1', OWNER);
    await releaseSessionRunLock('s1', OWNER);
    expect(mockStore.has(LOCK_KEY)).toBe(false);
    expect(warn()).not.toHaveBeenCalled();
  });

  it('release by a NON-OWNER warns and no-ops — the live lock survives (the two-runs-one-worktree hole stays closed)', async () => {
    await acquireSessionRunLock('s1', OWNER);
    await releaseSessionRunLock('s1', OTHER);
    expect(mockStore.get(LOCK_KEY)).toBe(OWNER);
    expect(warn()).toHaveBeenCalledWith(expect.stringContaining('release refused for session s1'));
  });

  it('release of an already-expired lock is a silent idempotent no-op', async () => {
    await releaseSessionRunLock('s1', OWNER);
    expect(warn()).not.toHaveBeenCalled();
  });

  it('legacy no-token callers keep working: default token is process-scoped and self-consistent', async () => {
    expect(await acquireSessionRunLock('s1')).toBe(true);
    expect(mockStore.get(LOCK_KEY)).toBe(String(process.pid));
    await refreshSessionRunLock('s1'); // same default token → owner refresh
    expect(warn()).not.toHaveBeenCalled();
    await releaseSessionRunLock('s1');
    expect(mockStore.has(LOCK_KEY)).toBe(false);
  });

  it('a Redis GET error degrades to a silent best-effort no-op (never a thrown 500, never a blind DEL)', async () => {
    await acquireSessionRunLock('s1', OWNER);
    const redis = (await import('../../../config/redis')).default;
    (redis.get as jest.Mock).mockRejectedValueOnce(new Error('redis down'));
    await expect(releaseSessionRunLock('s1', OWNER)).resolves.toBeUndefined();
    expect(mockStore.get(LOCK_KEY)).toBe(OWNER); // uncertainty never deletes
  });
});

describe('isSessionRunLockedStrict (Phase-3 H1 — the fail-closed sweep variant)', () => {
  it('reflects the lock exactly like the fail-open variant', async () => {
    expect(await isSessionRunLockedStrict('s1')).toBe(false); // no lock key
    mockStore.set('coding:session:run:s1', '1234');
    expect(await isSessionRunLockedStrict('s1')).toBe(true);
  });

  it('a Redis error PROPAGATES (no catch-to-0) so the orphan sweep fails closed', async () => {
    const redis = (await import('../../../config/redis')).default;
    (redis.exists as jest.Mock).mockRejectedValueOnce(new Error('redis down'));
    await expect(isSessionRunLockedStrict('s1')).rejects.toThrow('redis down');
  });
});

describe('cross-process cancel channel', () => {
  it('round-trips: absent → false, request → take true, taken → false again', async () => {
    expect(await takeRunCancelRequest('s1')).toBe(false); // nothing requested
    await requestRunCancel('s1');
    expect(mockStore.get('coding:session:cancel:s1')).toBe('1');
    expect(await takeRunCancelRequest('s1')).toBe(true);  // observed once…
    expect(await takeRunCancelRequest('s1')).toBe(false); // …then consumed (GET+DEL)
  });

  it('is per-session', async () => {
    await requestRunCancel('s1');
    expect(await takeRunCancelRequest('s2')).toBe(false);
    expect(await takeRunCancelRequest('s1')).toBe(true);
  });

  // ALARM-CAUSE-AWARE (supervisor SOTA 2026-10-20): stop_run's requester rides cancel-actor:<runId>.
  it('cancel-actor round trip: stop_run writes the requester (1 h TTL), the finalize reads it back; the owner Stop button writes none', async () => {
    const redis = (await import('../../../config/redis')).default;
    await requestRunCancel('s1', { runId: 'run-9', actorChatId: 'sup-1' });
    expect(mockStore.get('coding:session:cancel:s1')).toBe('1'); // the cancel itself is unchanged
    expect(redis.set).toHaveBeenCalledWith('cancel-actor:run-9', 'sup-1', { EX: 3600 });
    expect(await readRunCancelActor('run-9')).toBe('sup-1');
    expect(await readRunCancelActor('run-other')).toBeNull();
    await requestRunCancel('s2'); // the owner's Stop button: no actor
    expect([...mockStore.keys()].filter((k) => k.startsWith('cancel-actor:'))).toEqual(['cancel-actor:run-9']);
    await requestRunCancel('s3', { runId: 'run-3' }); // no requester ⇒ nothing written
    expect(await readRunCancelActor('run-3')).toBeNull();
  });

  it('HOOK_ALARM_CAUSE_AWARE_DISABLED=1: no actor is written or read', async () => {
    process.env.HOOK_ALARM_CAUSE_AWARE_DISABLED = '1';
    try {
      await requestRunCancel('s1', { runId: 'run-9', actorChatId: 'sup-1' });
      expect(mockStore.has('cancel-actor:run-9')).toBe(false);
      mockStore.set('cancel-actor:run-9', 'sup-1');
      expect(await readRunCancelActor('run-9')).toBeNull();
    } finally { delete process.env.HOOK_ALARM_CAUSE_AWARE_DISABLED; }
  });
});

describe('cross-process steer channel', () => {
  it('empty → null', async () => {
    expect(await drainSteerMessages('s1')).toBeNull();
  });

  it('drains in FIFO order, texts joined with \\n\\n, images concatenated', async () => {
    await pushSteerMessage('s1', { text: 'first', images: [IMG(1)] });
    await pushSteerMessage('s1', { text: 'second' });
    await pushSteerMessage('s1', { text: 'third', images: [IMG(2)] });

    const drained = await drainSteerMessages('s1');
    expect(drained?.text).toBe('first\n\nsecond\n\nthird');
    expect(drained?.images.map(i => i.name)).toEqual(['i1.png', 'i2.png']);
    expect(await drainSteerMessages('s1')).toBeNull(); // fully drained
  });

  it('caps combined images at MAX_IMAGES with a drop note appended', async () => {
    await pushSteerMessage('s1', { text: 'a', images: [IMG(1), IMG(2), IMG(3)] });
    await pushSteerMessage('s1', { text: 'b', images: [IMG(4), IMG(5)] });

    const drained = await drainSteerMessages('s1');
    expect(drained?.images).toHaveLength(MAX_IMAGES); // 5 pushed → 4 kept
    expect(drained?.text).toContain(`[1 attached image(s) dropped — a steer carries at most ${MAX_IMAGES}]`);
  });

  // audit 2026-10-08 W2-9: the sender's origin round-trips through the mailbox.
  it('entries carry each steer\'s origin + sending chat in FIFO order; `text` is unchanged', async () => {
    await pushSteerMessage('s1', { text: 'owner turn' });
    await pushSteerMessage('s1', { text: 'lane idle — resume', origin: 'agent', sourceChatId: 'c0e22e36-x' });
    await pushSteerMessage('s1', { text: 'firing', origin: 'schedule' });
    await pushSteerMessage('s1', { text: 'odd', origin: 'bogus' as any });
    const drained = await drainSteerMessages('s1');
    expect(drained?.text).toBe('owner turn\n\nlane idle — resume\n\nfiring\n\nodd');
    expect(drained?.entries).toEqual([
      { text: 'owner turn' },
      { text: 'lane idle — resume', origin: 'agent', sourceChatId: 'c0e22e36-x' },
      { text: 'firing', origin: 'schedule' },
      { text: 'odd' }, // an unknown origin reads as the owner (never crashes the drain)
    ]);
  });

  it('the image-cap note rides the LAST entry (the merged text keeps it as before)', async () => {
    await pushSteerMessage('s1', { text: 'a', images: [IMG(1), IMG(2), IMG(3)], origin: 'agent' });
    await pushSteerMessage('s1', { text: 'b', images: [IMG(4), IMG(5)], origin: 'agent' });
    const drained = await drainSteerMessages('s1');
    expect(drained?.entries?.[1].text).toContain('attached image(s) dropped');
    expect(drained?.entries?.[0].text).toBe('a');
  });

  it('keeps only the newest 20 queued messages (LTRIM on push)', async () => {
    for (let i = 1; i <= 25; i++) await pushSteerMessage('s1', { text: `m${i}` });
    const drained = await drainSteerMessages('s1');
    const texts = drained!.text.split('\n\n');
    expect(texts).toHaveLength(20);
    expect(texts[0]).toBe('m6');  // oldest 5 dropped
    expect(texts[19]).toBe('m25');
  });
});

/* ====================================================================
 * LEG 2c — approval/question pending-presence keys (web ownership check)
 * ==================================================================== */
describe('approval pending-presence keys', () => {
  it('round-trips: publish → get returns the session, unpublish → null', async () => {
    expect(await getApprovalPendingSession('a1')).toBeNull(); // nothing pending
    await publishApprovalPending('a1', 's1');
    expect(mockStore.get('coding:approval:pending:a1')).toBe('s1');
    expect(await getApprovalPendingSession('a1')).toBe('s1');
    await unpublishApprovalPending('a1');
    expect(await getApprovalPendingSession('a1')).toBeNull();
  });

  it('publishes with a TTL above the 14-min auto-deny', async () => {
    const redis = (await import('../../../config/redis')).default;
    await publishApprovalPending('a1', 's1');
    expect(redis.set).toHaveBeenCalledWith('coding:approval:pending:a1', 's1', { EX: 900 });
  });

  it('is per-approval', async () => {
    await publishApprovalPending('a1', 's1');
    expect(await getApprovalPendingSession('a2')).toBeNull();
    expect(await getApprovalPendingSession('a1')).toBe('s1');
  });
});

/* ====================================================================
 * Fleet supervisor (slice B) — attention_needed emission where the keys SET
 * ==================================================================== */
describe('attention_needed hook emission (fleet supervisor §3)', () => {
  it('publishing an approval pending key emits attention_needed with the approval summary', async () => {
    await publishApprovalPending('a1', 's1', 'Allow exec_shell: npm test?');
    expect(mockEmitHookEventSafe).toHaveBeenCalledWith(
      's1', 'attention_needed', 'Run needs input: Allow exec_shell: npm test?',
    );
  });

  it('publishing a question pending key emits attention_needed with the question text', async () => {
    await publishQuestionPending('q1', 's1', 'Which environment should I deploy to?');
    expect(mockEmitHookEventSafe).toHaveBeenCalledWith(
      's1', 'attention_needed', 'Run needs input: Which environment should I deploy to?',
    );
  });

  it('falls back to the bare id when no summary is threaded through', async () => {
    await publishApprovalPending('a9', 's2');
    expect(mockEmitHookEventSafe).toHaveBeenCalledWith('s2', 'attention_needed', 'Run needs input: approval a9');
    await publishQuestionPending('q9', 's2');
    expect(mockEmitHookEventSafe).toHaveBeenCalledWith('s2', 'attention_needed', 'Run needs input: question q9');
  });

  it('normalizes whitespace and truncates a long summary', async () => {
    await publishQuestionPending('q1', 's1', `line one\n\nline two   ${'x'.repeat(400)}`);
    const summary = mockEmitHookEventSafe.mock.calls[0][2] as string;
    expect(summary).not.toContain('\n');
    expect(summary.length).toBeLessThanOrEqual('Run needs input: '.length + 300);
    expect(summary).toContain('line one line two');
  });

  it('an emission failure never breaks the pending publish', async () => {
    mockEmitHookEventSafe.mockRejectedValueOnce(new Error('hooks down'));
    await expect(publishApprovalPending('a1', 's1', 'Allow x?')).resolves.toBeUndefined();
    expect(mockStore.get('coding:approval:pending:a1')).toBe('s1'); // the key still landed
  });

  it('unpublishing does NOT emit (only the SET side signals attention)', async () => {
    await unpublishApprovalPending('a1');
    await unpublishQuestionPending('q1');
    expect(mockEmitHookEventSafe).not.toHaveBeenCalled();
  });
});

describe('question pending-presence keys', () => {
  it('round-trips: publish → get returns the session, unpublish → null', async () => {
    expect(await getQuestionPendingSession('q1')).toBeNull();
    await publishQuestionPending('q1', 's1');
    expect(mockStore.get('coding:question:pending:q1')).toBe('s1');
    expect(await getQuestionPendingSession('q1')).toBe('s1');
    await unpublishQuestionPending('q1');
    expect(await getQuestionPendingSession('q1')).toBeNull();
  });

  it('publishes with a TTL above the 60-min question timeout + 2-min answer grace', async () => {
    const redis = (await import('../../../config/redis')).default;
    await publishQuestionPending('q1', 's1');
    expect(redis.set).toHaveBeenCalledWith('coding:question:pending:q1', 's1', { EX: 3960 });
  });

  it('refresh extends the pending key into the grace window WITHOUT re-emitting attention', async () => {
    const redis = (await import('../../../config/redis')).default;
    await publishQuestionPending('q1', 's1');
    mockEmitHookEventSafe.mockClear();
    await refreshQuestionPending('q1', 150);
    expect(redis.expire).toHaveBeenCalledWith('coding:question:pending:q1', 150);
    expect(mockStore.get('coding:question:pending:q1')).toBe('s1'); // value + ownership unchanged
    expect(mockEmitHookEventSafe).not.toHaveBeenCalled(); // grace is invisible to clients
  });
});

/* ====================================================================
 * LEG 2c — the per-session resolution mailbox (web → worker)
 * ==================================================================== */
describe('resolution mailbox', () => {
  it('empty → empty array', async () => {
    expect(await drainResolutions('s1')).toEqual([]);
  });

  it('drains approvals + questions in FIFO order off ONE per-session list', async () => {
    await publishApprovalResolution('s1', 'a1', 'allow');
    await publishQuestionResolution('s1', 'q1', 'use option B');
    await publishApprovalResolution('s1', 'a2', 'deny');

    const drained = await drainResolutions('s1');
    expect(drained).toEqual([
      { kind: 'approval', id: 'a1', decision: 'allow' },
      { kind: 'question', id: 'q1', answer: 'use option B' },
      { kind: 'approval', id: 'a2', decision: 'deny' },
    ]);
    expect(await drainResolutions('s1')).toEqual([]); // fully drained
  });

  it('refreshes the mailbox TTL on every push', async () => {
    const redis = (await import('../../../config/redis')).default;
    await publishApprovalResolution('s1', 'a1', 'always');
    expect(redis.expire).toHaveBeenCalledWith('coding:session:resolve:s1', 3600);
  });

  it('is per-session', async () => {
    await publishApprovalResolution('s1', 'a1', 'allow');
    expect(await drainResolutions('s2')).toEqual([]);
    expect(await drainResolutions('s1')).toHaveLength(1);
  });

  it('skips malformed entries without poisoning the drain', async () => {
    mockLists.set('coding:session:resolve:s1', [
      'not json at all',
      JSON.stringify({ kind: 'approval' }),                 // missing id/decision
      JSON.stringify({ kind: 'question', id: 'q1' }),       // missing answer
      JSON.stringify({ kind: 'alien', id: 'x1' }),          // unknown kind
      JSON.stringify({ kind: 'approval', id: 'a1', decision: 'deny' }),
    ]);
    const drained = await drainResolutions('s1');
    expect(drained).toEqual([{ kind: 'approval', id: 'a1', decision: 'deny' }]);
  });

  it('drains at most 20 entries per tick (the rest wait for the next tick)', async () => {
    for (let i = 1; i <= 25; i++) await publishQuestionResolution('s1', `q${i}`, `ans${i}`);
    const first = await drainResolutions('s1');
    expect(first).toHaveLength(20);
    expect((first[0] as any).id).toBe('q1');
    expect((first[19] as any).id).toBe('q20');
    const rest = await drainResolutions('s1');
    expect(rest).toHaveLength(5);
    expect((rest[0] as any).id).toBe('q21');
  });
});
