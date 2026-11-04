/**
 * Ticket 356d21bb replay pins — message-as-answer (message-as-answer.ts):
 * an inbound owner/user message at a chat with a LIVE ask_user wait IS the
 * answer. Near-integration: the REAL confirm-pending presence keys, the REAL
 * question-registry, the REAL pending-durable records, and the REAL
 * session-run-lock resolution mailbox all run over one in-memory Redis fake —
 * only the owner-questions store seam is mocked (its own suites pin it).
 *
 *   1. chat-USER-parked (Gap B): the wait resolves with the FULL text in-
 *      process (via 'local') — not queued, not null — and the flagged
 *      owner-question rows close via resolveOwnerQuestionsForChatAnswer.
 *   2. chat-MACHINE-preempt (Gap A): the answer is stamped 'answered' BEFORE
 *      the preempt's cancel can write 'expired' — first-writer-wins means the
 *      durable record survives as the owner's answer, never null/'expired'.
 *   3. cross-process: the answer rides the session's resolution mailbox
 *      (via 'mailbox') exactly like the card endpoints deliver it.
 *   4. guards: no live entry / approval-kind entry / blank text → not
 *      resolved, nothing touched.
 */

// ── In-memory Redis (the whole cross-process surface these modules use) ──────
const store = new Map<string, any>();
const mockRedis = {
  set: jest.fn(async (k: string, v: any, opts?: any) => {
    if (opts?.NX && store.has(k)) return null;
    store.set(k, String(v));
    return 'OK';
  }),
  get: jest.fn(async (k: string) => store.get(k) ?? null),
  del: jest.fn(async (k: string) => { store.delete(k); return 1; }),
  mGet: jest.fn(async (keys: string[]) => keys.map((k) => store.get(k) ?? null)),
  scan: jest.fn(async (_cursor: number, opts?: any) => {
    const match = String(opts?.MATCH ?? '*');
    const prefix = match.replace(/\*.*$/, '');
    return { cursor: 0, keys: [...store.keys()].filter((k) => k.startsWith(prefix)) };
  }),
  rPush: jest.fn(async (k: string, v: string) => {
    const arr = Array.isArray(store.get(k)) ? store.get(k) : [];
    arr.push(v);
    store.set(k, arr);
    return arr.length;
  }),
  lPop: jest.fn(async (k: string) => {
    const arr = Array.isArray(store.get(k)) ? store.get(k) : [];
    const v = arr.length ? arr.shift() : null;
    store.set(k, arr);
    return v ?? null;
  }),
  expire: jest.fn(async () => 1),
};
jest.mock('../../config/redis', () => ({ __esModule: true, default: mockRedis }));
jest.mock('../../config/database', () => ({ __esModule: true, default: {} }));
jest.mock('../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// The flag-row closure seam — mocked (owner-questions' own suites pin it).
const mockResolveOwnerQuestions: jest.Mock = jest.fn(async () => ({ resolved: 1, ids: ['oq_1'] }));
jest.mock('./platform/owner-questions', () => ({
  __esModule: true,
  resolveOwnerQuestionsForChatAnswer: (...a: any[]) => mockResolveOwnerQuestions(...a),
}));

// awaitAnswer's attention emission dynamically imports hooks.service — mocked
// at the boundary (the real module statically pulls middleware/error-handler →
// config/env → process.exit at import).
jest.mock('./platform/hooks.service', () => ({
  __esModule: true,
  emitHookEventSafe: jest.fn(async () => {}),
  enqueueDirectWake: jest.fn(async () => ({ ok: true, hookEventId: 'he-1' })),
}));

import { publishConfirmPending } from './confirm-pending';
import { awaitAnswer, resolvePendingForSession } from './coding/question-registry';
import { loadDurablePending, markDurableResolved, saveDurablePending } from './coding/pending-durable';
import { drainResolutions } from './coding/session-run-lock';
import { resolveParkedQuestionWithOwnerText } from './message-as-answer';

/** Let the fire-and-forget durable writes land (resolveAnswer stamps async). */
const flush = async () => { await new Promise((r) => setTimeout(r, 5)); };

beforeEach(() => {
  store.clear();
  mockRedis.set.mockClear();
  mockResolveOwnerQuestions.mockReset().mockResolvedValue({ resolved: 1, ids: ['oq_1'] });
});

describe('356d21bb — chat lane, USER run parked (Gap B)', () => {
  it('resolves the live wait with the FULL text in-process, closes the flag rows, and never touches the mailbox', async () => {
    const parked = awaitAnswer('q-local-1', 'chat-1', 'Proceed with the deploy?');
    await publishConfirmPending('chat-1', {
      kind: 'question', id: 'q-local-1', question: 'Proceed with the deploy?', options: [], ts: Date.now(),
    });

    const res = await resolveParkedQuestionWithOwnerText({ chatId: 'chat-1', userId: 'u1', text: 'yes — deploy to ca' });

    expect(res).toMatchObject({ resolved: true, questionId: 'q-local-1', via: 'local' });
    // The parked run receives the message text AS the answer — not null.
    await expect(parked).resolves.toBe('yes — deploy to ca');
    // Flag rows closed against the CARD's question text (the 992c8374 match anchor).
    expect(mockResolveOwnerQuestions).toHaveBeenCalledWith({
      chatId: 'chat-1', userId: 'u1', askedQuestion: 'Proceed with the deploy?', answer: 'yes — deploy to ca',
    });
    // In-process resolve — nothing rode the cross-process mailbox.
    expect(await drainResolutions('chat-1')).toEqual([]);
  });
});

describe('356d21bb — chat lane, MACHINE run preempt (Gap A)', () => {
  it("the answer is stamped 'answered' BEFORE the cancel — first-writer-wins keeps it, never null/'expired'", async () => {
    const parked = awaitAnswer('q-mach-1', 'chat-9', 'Ship it?');
    await publishConfirmPending('chat-9', {
      kind: 'question', id: 'q-mach-1', question: 'Ship it?', options: [], ts: Date.now(),
    });

    // The message-as-answer hook runs BEFORE preemptMachineRunForUserMessage
    // (the controller's busy-branch order — pinned here at the mechanism level).
    const res = await resolveParkedQuestionWithOwnerText({ chatId: 'chat-9', userId: 'u1', text: 'ship to prod' });
    expect(res.resolved).toBe(true);
    await expect(parked).resolves.toBe('ship to prod');

    // NOW the preempt lands: cancel + resolvePendingForSession (nothing left
    // pending) and its 'expired' stamp — first-writer-wins must refuse it.
    resolvePendingForSession('chat-9');
    await markDurableResolved('question', 'q-mach-1', 'expired');
    await flush();

    const rec = await loadDurablePending('question', 'q-mach-1');
    expect(rec).toMatchObject({ status: 'answered', resolution: 'ship to prod' });
    expect(mockResolveOwnerQuestions).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: 'chat-9', answer: 'ship to prod' }),
    );
  });
});

describe('356d21bb — cross-process delivery (the peer-instance lane)', () => {
  it("publishes the answer on the session's resolution mailbox and stamps the worker's durable record", async () => {
    // The wait lives in ANOTHER process: no local registry entry — but the
    // worker's durable record + the presence key are visible here.
    await saveDurablePending({
      id: 'q-remote-1', kind: 'question', sessionId: 'chat-2', fingerprint: null,
      detail: 'Pick a model', status: 'pending', createdAt: Date.now(),
    });
    await publishConfirmPending('chat-2', {
      kind: 'question', id: 'q-remote-1', question: 'Pick a model', options: ['A', 'B'], ts: Date.now(),
    });

    const res = await resolveParkedQuestionWithOwnerText({ chatId: 'chat-2', userId: 'u1', text: 'model B' });

    expect(res).toMatchObject({ resolved: true, questionId: 'q-remote-1', via: 'mailbox' });
    const drained = await drainResolutions('chat-2');
    expect(drained).toEqual([{ kind: 'question', id: 'q-remote-1', answer: 'model B' }]);
    const rec = await loadDurablePending('question', 'q-remote-1');
    expect(rec).toMatchObject({ status: 'answered', resolution: 'model B' });
    expect(mockResolveOwnerQuestions).toHaveBeenCalledWith({
      chatId: 'chat-2', userId: 'u1', askedQuestion: 'Pick a model', answer: 'model B',
    });
  });
});

describe('356d21bb — guards', () => {
  it('no live confirm-pending entry → not resolved, nothing touched', async () => {
    const res = await resolveParkedQuestionWithOwnerText({ chatId: 'chat-quiet', userId: 'u1', text: 'hello' });
    expect(res).toEqual({ resolved: false });
    expect(mockResolveOwnerQuestions).not.toHaveBeenCalled();
    expect(await drainResolutions('chat-quiet')).toEqual([]);
  });

  it("an APPROVAL-kind entry is not a question — not resolved (message-as-answer never decides 'allow')", async () => {
    await publishConfirmPending('chat-3', {
      kind: 'approval', id: 'ap-1', question: 'Allow run_command?', options: ['allow', 'deny'], tool: 'run_command', ts: Date.now(),
    });
    const res = await resolveParkedQuestionWithOwnerText({ chatId: 'chat-3', userId: 'u1', text: 'allow it' });
    expect(res).toEqual({ resolved: false });
    expect(await drainResolutions('chat-3')).toEqual([]);
    expect(mockResolveOwnerQuestions).not.toHaveBeenCalled();
  });

  it('blank text is not an answer', async () => {
    await publishConfirmPending('chat-4', {
      kind: 'question', id: 'q-blank', question: 'Proceed?', options: [], ts: Date.now(),
    });
    expect(await resolveParkedQuestionWithOwnerText({ chatId: 'chat-4', userId: 'u1', text: '   ' })).toEqual({ resolved: false });
    expect(await resolveParkedQuestionWithOwnerText({ chatId: 'chat-4', userId: '', text: 'yes' })).toEqual({ resolved: false });
    expect(mockResolveOwnerQuestions).not.toHaveBeenCalled();
  });
});
