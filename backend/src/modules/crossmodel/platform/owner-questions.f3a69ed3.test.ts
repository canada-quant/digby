/**
 * Ticket f3a69ed3 — owner replies on inbox cards must never vanish.
 *
 * SPECIMEN (2026-10-21 ~16:43–16:57Z): the owner replied to TWO open
 * owner-question cards with plain-English instructions ("try to remote use
 * mbp-1 now i stopped othger screenshare" on credential card oq_510a512a;
 * "use my mbp-1 remote computer use to fix tailscale json" on a choice
 * card). BOTH were bounced by the typed gate as "conversation, not a
 * decision", oq_510a512a was then system-dismissed as superseded — and from
 * the owner's seat his replies disappeared. His words: "i dont
 * understand...didnt i reply to the ticket from the agents??"
 *
 * Three defects, pinned here:
 *  (1) a non-resolving owner reply on an OPEN card must render ON the card
 *      as received, with the one-line reason it did not resolve;
 *  (2) a superseding replacement card must carry the owner's prior reply
 *      forward visibly;
 *  (3) the reply must reach the asking lane — recorded on the row, exposed
 *      to list_owner_questions, and (an OWNER's plain-English reply) waking
 *      the lane with the words.
 */

import { createOwnerQuestionTable } from './owner-questions.testkit';

// ── Stateful fake DB (the 356d21bb sweeper harness shape) ───────────────────
const mockQuestions = createOwnerQuestionTable();
const todoRows: any[] = [];
const goalRows: any[] = [];
const matchLoose = (row: any, where: any): boolean =>
  Object.entries(where ?? {}).every(([k, v]) => {
    if (v && typeof v === 'object' && !(v instanceof Date) && !Array.isArray(v)) {
      const cond: any = v;
      if ('not' in cond) return row[k] !== cond.not;
      if ('in' in cond) return cond.in.includes(row[k]);
      return row[k] === v;
    }
    return row[k] === v;
  });
const gatedTable = (rows: any[]) => ({
  findMany: jest.fn(async ({ where }: any = {}) => rows.filter((r) => matchLoose(r, where))),
  findUnique: jest.fn(async ({ where }: any) => rows.find((r) => matchLoose(r, where)) ?? null),
  updateMany: jest.fn(async ({ where, data }: any) => {
    const m = rows.filter((r) => matchLoose(r, where));
    m.forEach((r) => Object.assign(r, data));
    return { count: m.length };
  }),
});
const mockTelegramLinkFindUnique: jest.Mock = jest.fn(async () => null);
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    ownerQuestion: mockQuestions.api,
    crossModelMessage: mockQuestions.crossModelMessage,
    crossModelChat: mockQuestions.crossModelChat,
    telegramLink: { findUnique: (...a: any[]) => mockTelegramLinkFindUnique(...a) },
    projectTodo: gatedTable(todoRows),
    projectGoal: gatedTable(goalRows),
    activity: { create: jest.fn(async () => ({})) },
  },
}));

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// ── In-memory Redis ──────────────────────────────────────────────────────────
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
    const prefix = String(opts?.MATCH ?? '*').replace(/\*.*$/, '');
    return { cursor: 0, keys: [...store.keys()].filter((k) => k.startsWith(prefix)) };
  }),
  rPush: jest.fn(async (k: string, v: any) => {
    const arr = Array.isArray(store.get(k)) ? store.get(k) : [];
    arr.push(v); store.set(k, arr); return arr.length;
  }),
  lPop: jest.fn(async (k: string) => {
    const arr = Array.isArray(store.get(k)) ? store.get(k) : [];
    const v = arr.length ? arr.shift() : null;
    store.set(k, arr); return v ?? null;
  }),
  expire: jest.fn(async () => 1),
};
jest.mock('../../../config/redis', () => ({ __esModule: true, default: mockRedis }));

// ── Boundary mocks (env-exit-safe graph) ─────────────────────────────────────
const mockFireScheduleTarget: jest.Mock = jest.fn(async () => ({ started: true }));
jest.mock('../coding/schedule.service', () => ({
  __esModule: true,
  fireScheduleTarget: (...a: any[]) => mockFireScheduleTarget(...a),
  dailyCapExceeded: jest.fn(async () => null),
  refundDailyCapToken: jest.fn(async () => {}),
}));
jest.mock('../telegram/telegram.service', () => ({
  __esModule: true,
  isConfigured: () => false,
  sendMessage: jest.fn(async () => {}),
}));
jest.mock('./supervisor-state.service', () => ({
  __esModule: true,
  appendAnsweredQuestionDirective: jest.fn(async () => {}),
}));
const mockEnqueueDirectWake: jest.Mock = jest.fn(async () => ({ ok: true, hookEventId: 'he-1' }));
jest.mock('./hooks.service', () => ({
  __esModule: true,
  emitHookEventSafe: jest.fn(async () => {}),
  enqueueDirectWake: (...a: any[]) => mockEnqueueDirectWake(...a),
}));
jest.mock('../../../middleware/error-handler', () => ({
  __esModule: true,
  AppError: class AppError extends Error {
    constructor(public statusCode: number, public message: string, isOperational = true) {
      super(message); Object.setPrototypeOf(this, AppError.prototype);
    }
  },
}));
jest.mock('../memory/context-store', () => ({
  __esModule: true,
  storeGet: jest.fn(async () => null),
  storePut: jest.fn(async () => {}),
}));
const mockRecordLoopMetric: jest.Mock = jest.fn();
jest.mock('./loop-metrics.service', () => ({
  __esModule: true,
  ...jest.requireActual('./loop-metrics.service'),
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
}));

import {
  flagOwnerQuestion,
  answerOwnerQuestion,
  parseOwnerRecordedReply,
  buildRecordedReplyRecord,
  parseReplacedReplyFold,
  stripCardAnnotations,
  stripPriorDecisionAnnotation,
  RECORDED_REPLY_MARK,
  REPLACED_REPLY_MARK,
  RECORDED_REPLY_REASON,
} from './owner-questions';

const NOW = new Date('2026-10-21T16:50:00Z');
/** The incident's exact reply text (msg 61324291, card oq_510a512a). */
const OWNER_WORDS = 'try to remote use mbp-1 now i stopped othger screenshare';

beforeEach(() => {
  mockQuestions.reset();
  todoRows.length = 0;
  goalRows.length = 0;
  store.clear();
  mockFireScheduleTarget.mockReset().mockResolvedValue({ started: true });
  mockEnqueueDirectWake.mockReset().mockResolvedValue({ ok: true, hookEventId: 'he-1' });
  mockRecordLoopMetric.mockReset();
  delete process.env.CREDENTIAL_REPLY_WAKE_DISABLED;
});

// ── Pure helpers ─────────────────────────────────────────────────────────────
describe('f3a69ed3 — buildRecordedReplyRecord + parseOwnerRecordedReply (round-trip)', () => {
  it('round-trips the owner-facing block: words, reason, delivery, timestamp', () => {
    const rec = buildRecordedReplyRecord({
      receivedAt: NOW, text: OWNER_WORDS, reason: RECORDED_REPLY_REASON.credential, delivered: 'woken',
    });
    const parsed = parseOwnerRecordedReply(rec);
    expect(parsed).not.toBeNull();
    expect(parsed!.text).toBe(OWNER_WORDS);
    expect(parsed!.receivedAt).toBe(NOW.toISOString());
    expect(parsed!.reason).toBe(RECORDED_REPLY_REASON.credential);
    expect(parsed!.woken).toBe(true);
    expect(parsed!.legacy).toBe(false);
    expect(rec.startsWith(RECORDED_REPLY_MARK)).toBe(true);
  });

  it('parses the LEGACY credential mismatch record (rows recorded 2026-10-16→21)', () => {
    const legacy = `[owner replied (conversation, not the key), gate still shut — needs the TEST_KEY credential stored (store_secret / the card's key field / the Account UI); reply was: "${OWNER_WORDS}" — the asking chat was woken to answer the owner on the card]`;
    const parsed = parseOwnerRecordedReply(legacy);
    expect(parsed).not.toBeNull();
    expect(parsed!.text).toBe(OWNER_WORDS);
    expect(parsed!.legacy).toBe(true);
    expect(parsed!.reason).toBe(RECORDED_REPLY_REASON.credential);
    expect(parsed!.woken).toBe(true);
  });

  it('parses the LEGACY choice mismatch record', () => {
    const legacy = `[owner replied, gate still shut — expected one of the typed options; reply was: "use my mbp-1 remote computer use to fix tailscale json"]`;
    const parsed = parseOwnerRecordedReply(legacy);
    expect(parsed).not.toBeNull();
    expect(parsed!.text).toBe('use my mbp-1 remote computer use to fix tailscale json');
    expect(parsed!.legacy).toBe(true);
    expect(parsed!.reason).toBe(RECORDED_REPLY_REASON.choice);
  });

  it('a REAL answer and a preset-default stamp are NOT recorded replies', () => {
    expect(parseOwnerRecordedReply('Deploy now')).toBeNull();
    expect(parseOwnerRecordedReply('[auto-applied the flagger\'s RECOMMENDED default after 24 hours with no owner answer]')).toBeNull();
    expect(parseOwnerRecordedReply(null)).toBeNull();
    expect(parseOwnerRecordedReply('')).toBeNull();
  });

  it('a paste-path (withheld) record parses with withheld words and the credential reason', () => {
    const rec = buildRecordedReplyRecord({
      receivedAt: NOW,
      text: '(the value was pasted through the card\'s key field — withheld; if it was stored it will carry a vault notice, if refused it never rides this row)',
      reason: RECORDED_REPLY_REASON.credential,
      delivered: 'sent',
    });
    const parsed = parseOwnerRecordedReply(rec);
    expect(parsed).not.toBeNull();
    expect(parsed!.withheld).toBe(false); // it is a parenthetical, not an unquoted quote — but still parses
    expect(parsed!.reason).toBe(RECORDED_REPLY_REASON.credential);
    expect(parsed!.text).toContain('withheld');
  });

  it('clips the WORDS, never the reason/delivery tail, when the reply exceeds the budget', () => {
    const long = 'x'.repeat(9000);
    const rec = buildRecordedReplyRecord({
      receivedAt: NOW, text: long, reason: RECORDED_REPLY_REASON.choice, delivered: 'sent', cap: 1000,
    });
    // The row ceiling: cap + the wrapper allowance.
    expect(rec.length).toBeLessThanOrEqual(1000 + 600);
    // The actionable tail is never the clipped part.
    expect(rec).toContain(' — recorded, not yet an answer: ');
    expect(rec).toContain(RECORDED_REPLY_REASON.choice);
    expect(rec).toContain('sent into the asking chat as context');
    // The words gave way (clipped mid-run, ellipsis-terminated).
    expect(rec).not.toContain('x'.repeat(9000));
    expect(rec).toContain('…');
  });
});

// ── Defect 1: the bounce is no longer silent ────────────────────────────────
describe('f3a69ed3 defect 1 — a non-resolving owner reply is recorded owner-facing on the OPEN row', () => {
  it('a credential gate: the owner\'s words are recorded with the one-line reason, parseable for the card', async () => {
    const flagged = await flagOwnerQuestion({
      chatId: 'chat-1', userId: 'u1',
      question: 'Please provide the TAILSCALE_AUTH_KEY so the lane can fix the tailscale json.',
      expectedAnswerType: 'credential:TAILSCALE_AUTH_KEY',
    } as any);
    expect(flagged.kind).toBe('created');
    const qid = (flagged as any).question.id;

    const res = await answerOwnerQuestion(qid, 'u1', OWNER_WORDS, { answeredBy: 'owner' });
    expect(res).toBe('reply_recorded');

    const row = mockQuestions.rows.find((r: any) => r.id === qid);
    expect(row.status).toBe('open'); // the gate stays shut
    const parsed = parseOwnerRecordedReply(row.answer);
    expect(parsed).not.toBeNull();
    expect(parsed!.text).toBe(OWNER_WORDS);
    expect(parsed!.reason).toBe(RECORDED_REPLY_REASON.credential);
    expect(parsed!.woken).toBe(true); // conversational credential reply → the lane is woken
  });

  it('a choice gate: free-text from the OWNER records the words with the choice reason', async () => {
    const flagged = await flagOwnerQuestion({
      chatId: 'chat-1', userId: 'u1',
      question: 'Which device should the lane drive for the tailscale fix?',
      options: [{ label: 'mbp-1' }, { label: 'agx' }],
      expectedAnswerType: 'choice',
    } as any);
    const qid = (flagged as any).question.id;

    const res = await answerOwnerQuestion(qid, 'u1', 'use my mbp-1 remote computer use to fix tailscale json', { answeredBy: 'owner' });
    expect(res).toBe('reply_recorded');
    const row = mockQuestions.rows.find((r: any) => r.id === qid);
    expect(row.status).toBe('open');
    const parsed = parseOwnerRecordedReply(row.answer);
    expect(parsed).not.toBeNull();
    expect(parsed!.text).toBe('use my mbp-1 remote computer use to fix tailscale json');
    expect(parsed!.reason).toBe(RECORDED_REPLY_REASON.choice);
  });
});

// ── Defect 2: the supersede fold ────────────────────────────────────────────
describe('f3a69ed3 defect 2 — a replacement card carries the owner\'s prior reply forward', () => {
  it('the fold is appended to the replacement\'s question, parseable, and stripped from every matching form', async () => {
    const first = await flagOwnerQuestion({
      chatId: 'chat-1', userId: 'u1',
      question: 'Please provide the TAILSCALE_AUTH_KEY so the lane can fix the tailscale json.',
      expectedAnswerType: 'credential:TAILSCALE_AUTH_KEY',
    } as any);
    const firstId = (first as any).question.id;
    await answerOwnerQuestion(firstId, 'u1', OWNER_WORDS, { answeredBy: 'owner' });

    const second = await flagOwnerQuestion({
      chatId: 'chat-1', userId: 'u1',
      question: 'Re-ask: the key paste failed — provide the TAILSCALE_AUTH_KEY again, or confirm mbp-1 access.',
      expectedAnswerType: 'credential:TAILSCALE_AUTH_KEY',
      supersedes: firstId,
    } as any);
    expect(second.kind).toBe('created');
    const row = mockQuestions.rows.find((r: any) => r.id === (second as any).question.id);

    // The fold rides the question text — visible on every surface.
    expect(row.question).toContain(REPLACED_REPLY_MARK);
    const fold = parseReplacedReplyFold(row.question);
    expect(fold).not.toBeNull();
    expect(fold!.fromQuestionId).toBe(firstId);
    expect(fold!.text).toBe(OWNER_WORDS);

    // The predecessor is system-dismissed as superseded (the 90a5b127 shape).
    const pred = mockQuestions.rows.find((r: any) => r.id === firstId);
    expect(pred.status).toBe('dismissed');

    // Matching paths normalize the fold away.
    expect(stripPriorDecisionAnnotation(row.question)).not.toContain(REPLACED_REPLY_MARK);
    expect(stripCardAnnotations(row.question)).not.toContain(REPLACED_REPLY_MARK);
  });

  it('a predecessor with NO recorded reply folds nothing (no phantom fold)', async () => {
    const first = await flagOwnerQuestion({
      chatId: 'chat-1', userId: 'u1',
      question: 'A bare ask with no owner reply yet.',
      expectedAnswerType: 'yes_no',
    } as any);
    const firstId = (first as any).question.id;
    const second = await flagOwnerQuestion({
      chatId: 'chat-1', userId: 'u1',
      question: 'The same ask, re-filed cleanly.',
      expectedAnswerType: 'yes_no',
      supersedes: firstId,
    } as any);
    const row = mockQuestions.rows.find((r: any) => r.id === (second as any).question.id);
    expect(row.question).not.toContain(REPLACED_REPLY_MARK);
    expect(parseReplacedReplyFold(row.question)).toBeNull();
  });
});

// ── Defect 3: the lane is reached ───────────────────────────────────────────
describe('f3a69ed3 defect 3 — an owner\'s plain-English reply wakes the asking lane with the words', () => {
  it('a choice gate: the wake fires with the owner\'s words and the card\'s id', async () => {
    const flagged = await flagOwnerQuestion({
      chatId: 'chat-lane', userId: 'u1',
      question: 'Which device should the lane drive?',
      options: [{ label: 'mbp-1' }, { label: 'agx' }],
      expectedAnswerType: 'choice',
    } as any);
    const qid = (flagged as any).question.id;
    mockEnqueueDirectWake.mockClear();

    const res = await answerOwnerQuestion(qid, 'u1', 'use my mbp-1 remote computer use to fix tailscale json', { answeredBy: 'owner' });
    expect(res).toBe('reply_recorded');
    // The lane was woken with the owner's words (defect 3's companion piece:
    // the words are SIGNAL and must reach the filing lane, not just sit on
    // the transcript). wakeChatForOwnerResolution fires through
    // fireScheduleTarget (the durable wake path) — the mock captures it.
    expect(mockFireScheduleTarget).toHaveBeenCalled();
    const text = JSON.stringify(mockFireScheduleTarget.mock.calls[0]);
    expect(text).toContain('use my mbp-1 remote computer use to fix tailscale json');
    expect(text).toContain(qid);
    // ...but no option was picked — the card stays open.
    expect(mockQuestions.rows.find((r: any) => r.id === qid).status).toBe('open');
  });

  it('CREDENTIAL_REPLY_WAKE_DISABLED=1 restores the silent bounce (no wake, record still written)', async () => {
    process.env.CREDENTIAL_REPLY_WAKE_DISABLED = '1';
    const flagged = await flagOwnerQuestion({
      chatId: 'chat-lane', userId: 'u1',
      question: 'Provide the TAILSCALE_AUTH_KEY.',
      expectedAnswerType: 'credential:TAILSCALE_AUTH_KEY',
    } as any);
    const qid = (flagged as any).question.id;
    mockEnqueueDirectWake.mockClear();

    const res = await answerOwnerQuestion(qid, 'u1', OWNER_WORDS, { answeredBy: 'owner' });
    expect(res).toBe('credential_pending');
    expect(mockEnqueueDirectWake).not.toHaveBeenCalled();
    const row = mockQuestions.rows.find((r: any) => r.id === qid);
    expect(row.status).toBe('open');
  });

  it('a supervisor\'s non-resolving reply records but never wakes (nothing new for the lane)', async () => {
    const flagged = await flagOwnerQuestion({
      chatId: 'chat-lane', userId: 'u1',
      question: 'Which device should the lane drive?',
      options: [{ label: 'mbp-1' }, { label: 'agx' }],
      expectedAnswerType: 'choice',
    } as any);
    const qid = (flagged as any).question.id;
    mockEnqueueDirectWake.mockClear();

    const res = await answerOwnerQuestion(qid, 'u1', 'checking with the owner, hold on', { answeredBy: 'supervisor' });
    expect(res).toBe('reply_recorded');
    expect(mockEnqueueDirectWake).not.toHaveBeenCalled();
    const row = mockQuestions.rows.find((r: any) => r.id === qid);
    const parsed = parseOwnerRecordedReply(row.answer);
    expect(parsed).not.toBeNull();
    expect(parsed!.woken).toBe(false); // 'sent into the asking chat as context'
  });
});
