/**
 * Ticket 356d21bb replay pins — an owner answer resolves ALL derived gates:
 *
 *   1. answerOwnerQuestion fans out to goals.service's unblockOwnerGatedItems
 *      choke point (todos/goals parked with gateQuestionId = the row id) —
 *      and dismissOwnerQuestion NEVER does (dismiss ≠ decision).
 *   2. CROSS-CHAT DUPLICATES: an OPEN same-user row whose question is the same
 *      decision (isSameDecisionQuestion) auto-resolves with the same answer,
 *      stamps answeredBy 'owner' (truthful provenance — the 992c8374 card path
 *      stamps nothing), wakes its own chat, and unblocks its own gated items.
 *   3. Non-matching OPEN rows are untouched (the 992c8374 B1 false-positive
 *      guard survives: a longer asked question does not close a shorter
 *      stored one).
 *   4. Card-answer extension (Q3): resolveOwnerQuestionsForChatAnswer ALSO
 *      unblocks the resolved rows' gated items through the same choke point.
 *
 * The goals.service seam is mocked at the boundary (the fan-out calls + args
 * are what's pinned here; the unblock mechanics themselves are pinned in
 * goals.service.356d21bb.test.ts).
 */

import { createOwnerQuestionTable } from './owner-questions.testkit';

const mockQuestions = createOwnerQuestionTable();
const mockTelegramLinkFindUnique: jest.Mock = jest.fn(async () => null);
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    ownerQuestion: mockQuestions.api,
    crossModelMessage: mockQuestions.crossModelMessage,
    crossModelChat: mockQuestions.crossModelChat,
    telegramLink: { findUnique: (...a: any[]) => mockTelegramLinkFindUnique(...a) },
  },
}));

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockFireScheduleTarget: jest.Mock = jest.fn(async () => ({ started: true }));
const mockDailyCapExceeded: jest.Mock = jest.fn(async () => null);
const mockRefundDailyCapToken: jest.Mock = jest.fn(async () => {});
jest.mock('../coding/schedule.service', () => ({
  __esModule: true,
  fireScheduleTarget: (...a: any[]) => mockFireScheduleTarget(...a),
  dailyCapExceeded: (...a: any[]) => mockDailyCapExceeded(...a),
  refundDailyCapToken: (...a: any[]) => mockRefundDailyCapToken(...a),
}));

jest.mock('../telegram/telegram.service', () => ({
  __esModule: true,
  isConfigured: () => false,
  sendMessage: jest.fn(async () => {}),
}));

const mockAppendAnswered: jest.Mock = jest.fn(async () => {});
jest.mock('./supervisor-state.service', () => ({
  __esModule: true,
  appendAnsweredQuestionDirective: (...a: any[]) => mockAppendAnswered(...a),
}));

// The ONE choke point — mocked at the boundary (the real module statically
// pulls middleware/error-handler → config/env → process.exit at import).
const mockUnblockOwnerGatedItems: jest.Mock = jest.fn(async () => ({ todos: 0, goals: 0 }));
jest.mock('./goals.service', () => ({
  __esModule: true,
  unblockOwnerGatedItems: (...a: any[]) => mockUnblockOwnerGatedItems(...a),
}));

import {
  answerOwnerQuestion,
  dismissOwnerQuestion,
  flagOwnerQuestion,
  resolveOwnerQuestionsForChatAnswer,
} from './owner-questions';

beforeEach(() => {
  mockQuestions.reset();
  mockFireScheduleTarget.mockReset().mockResolvedValue({ started: true });
  mockDailyCapExceeded.mockReset().mockResolvedValue(null);
  mockRefundDailyCapToken.mockReset().mockResolvedValue(undefined);
  mockTelegramLinkFindUnique.mockReset().mockResolvedValue(null);
  mockAppendAnswered.mockReset().mockResolvedValue(undefined);
  mockUnblockOwnerGatedItems.mockReset().mockResolvedValue({ todos: 0, goals: 0 });
});

afterEach(() => {
  jest.restoreAllMocks();
});

const flag = (over: Partial<Parameters<typeof flagOwnerQuestion>[0]> = {}) =>
  flagOwnerQuestion({ chatId: 'chat-1', userId: 'u1', question: 'Which region should we deploy to?', ...over });

describe('356d21bb — answerOwnerQuestion gate fan-out', () => {
  it('answering unblocks the row\'s gated todos/goals through the ONE choke point', async () => {
    const r = await flag();
    if (r.kind !== 'created') throw new Error('expected created');
    expect(await answerOwnerQuestion(r.question.id, 'u1', 'ca-central-1')).toBe('ok');
    expect(mockUnblockOwnerGatedItems).toHaveBeenCalledTimes(1);
    expect(mockUnblockOwnerGatedItems).toHaveBeenCalledWith({
      userId: 'u1',
      questionId: r.question.id,
      question: 'Which region should we deploy to?',
      answer: 'ca-central-1',
      source: 'owner inbox answer',
      // CanLaw 2026-09-15: a decisive answer releases the gate; the asking chat is never woken twice.
      counterQuestion: false,
      // fadc3563: provenance for the choke point's hold-classification note.
      answeredBy: 'owner',
      skipWakeChatIds: ['chat-1'],
    });
  });

  it('dismiss NEVER unblocks anything (dismiss ≠ decision)', async () => {
    const r = await flag();
    if (r.kind !== 'created') throw new Error('expected created');
    expect(await dismissOwnerQuestion(r.question.id, 'u1')).toBe('ok');
    expect(mockUnblockOwnerGatedItems).not.toHaveBeenCalled();
  });

  it('a lost-race answer (already resolved elsewhere) does NOT fan out', async () => {
    const r = await flag();
    if (r.kind !== 'created') throw new Error('expected created');
    expect(await answerOwnerQuestion(r.question.id, 'u1', 'ca-central-1')).toBe('ok');
    mockUnblockOwnerGatedItems.mockClear();
    expect(await answerOwnerQuestion(r.question.id, 'u1', 'us-east-1')).toBe('not_open');
    expect(mockUnblockOwnerGatedItems).not.toHaveBeenCalled();
  });
});

describe('356d21bb — cross-chat duplicate auto-resolve', () => {
  it('an OPEN same-decision row on ANOTHER chat resolves with the same answer + answeredBy owner + wakes its chat + unblocks its gates', async () => {
    const first = await flag(); // chat-1
    if (first.kind !== 'created') throw new Error('expected created');
    const dupe = await flag({ chatId: 'chat-2' }); // same decision, another chat
    if (dupe.kind !== 'created') throw new Error('expected created');
    mockFireScheduleTarget.mockClear();

    expect(await answerOwnerQuestion(first.question.id, 'u1', 'ca-central-1')).toBe('ok');

    const dupeRow = mockQuestions.rows.find((row) => row.id === dupe.question.id);
    expect(dupeRow).toMatchObject({
      status: 'answered',
      answer: 'ca-central-1',
      answeredBy: 'owner',
    });
    expect(dupeRow.resolvedAt).toBeTruthy();
    // Its chat was woken (the originating chat's own wake rides the direct path).
    expect(mockFireScheduleTarget).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'chat-2' }),
    );
    // …and BOTH rows' gated items went through the choke point.
    const gatedIds = mockUnblockOwnerGatedItems.mock.calls.map((c) => c[0].questionId).sort();
    expect(gatedIds).toEqual([dupe.question.id, first.question.id].sort());
    const dupeCall = mockUnblockOwnerGatedItems.mock.calls.find((c) => c[0].questionId === dupe.question.id);
    expect(dupeCall?.[0]).toMatchObject({ userId: 'u1', answer: 'ca-central-1', source: 'cross-chat duplicate answer' });
    // The duplicate's transcript got the auto-resolve note.
    expect(mockQuestions.crossModelMessage.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ chatId: 'chat-2', content: expect.stringContaining('auto-resolved') }),
      }),
    );
  });

  it('a cross-chat duplicate does NOT re-wake the originating chat (already woken by the direct path)', async () => {
    const first = await flag({ chatId: 'chat-1', forChatId: 'lane-9' });
    if (first.kind !== 'created') throw new Error('expected created');
    const dupe = await flag({ chatId: 'chat-2' });
    if (dupe.kind !== 'created') throw new Error('expected created');
    mockFireScheduleTarget.mockClear();

    expect(await answerOwnerQuestion(first.question.id, 'u1', 'ca')).toBe('ok');
    const woken = mockFireScheduleTarget.mock.calls.map((c) => c[0]?.sessionId);
    // chat-1 + lane-9 from the direct wake, chat-2 from the duplicate — each ONCE.
    expect(woken.filter((s) => s === 'chat-1')).toHaveLength(1);
    expect(woken.filter((s) => s === 'lane-9')).toHaveLength(1);
    expect(woken.filter((s) => s === 'chat-2')).toHaveLength(1);
  });

  it('non-matching OPEN rows are untouched (B1 false-positive guard stays green)', async () => {
    const first = await flag(); // "Which region should we deploy to?"
    if (first.kind !== 'created') throw new Error('expected created');
    // A genuinely different decision on another chat — must survive.
    const other = await flag({ chatId: 'chat-3', question: 'Refactor the landing page this sprint?' });
    if (other.kind !== 'created') throw new Error('expected created');
    // B1 asymmetry: the stored dupe is SHORTER than the answered question —
    // stored 'refactor the landing page?'.contains(asked) must not close rows
    // for a different, longer question either.
    const shorter = await flag({ chatId: 'chat-4', question: 'Which region' });
    if (shorter.kind !== 'created') throw new Error('expected created');

    expect(await answerOwnerQuestion(first.question.id, 'u1', 'ca-central-1')).toBe('ok');

    const otherRow = mockQuestions.rows.find((row) => row.id === other.question.id);
    const shorterRow = mockQuestions.rows.find((row) => row.id === shorter.question.id);
    expect(otherRow.status).toBe('open');
    // 'Which region should we deploy to?' — stored 'which region' contains the
    // asked norm? No: stored.contains(asked) with stored SHORTER is false → untouched.
    expect(shorterRow.status).toBe('open');
    expect(mockQuestions.crossModelMessage.create.mock.calls.filter(
      (c) => c[0]?.data?.chatId === 'chat-3' || c[0]?.data?.chatId === 'chat-4',
    )).toHaveLength(0);
  });

  it('an already-resolved duplicate (lost the race) is skipped — conditional flip only', async () => {
    const first = await flag();
    if (first.kind !== 'created') throw new Error('expected created');
    const dupe = await flag({ chatId: 'chat-2' });
    if (dupe.kind !== 'created') throw new Error('expected created');
    // The dupe was dismissed moments before the answer landed.
    expect(await dismissOwnerQuestion(dupe.question.id, 'u1')).toBe('ok');
    mockUnblockOwnerGatedItems.mockClear();

    expect(await answerOwnerQuestion(first.question.id, 'u1', 'ca')).toBe('ok');
    const dupeRow = mockQuestions.rows.find((row) => row.id === dupe.question.id);
    expect(dupeRow.status).toBe('dismissed'); // never resurrected by the fan-out
    expect(dupeRow.answeredBy ?? null).toBeNull();
    // Only the originating row's gates were unblocked.
    expect(mockUnblockOwnerGatedItems).toHaveBeenCalledTimes(1);
    expect(mockUnblockOwnerGatedItems.mock.calls[0][0].questionId).toBe(first.question.id);
  });
});

describe('356d21bb — card-answer fan-out extension (Q3)', () => {
  it('a card answer that resolves a flag row ALSO unblocks that row\'s gated items', async () => {
    const r = await flag({ question: 'Deploy to ca-central-1 this weekend?' });
    if (r.kind !== 'created') throw new Error('expected created');
    const out = await resolveOwnerQuestionsForChatAnswer({
      chatId: 'chat-1', userId: 'u1', askedQuestion: 'Deploy to ca-central-1', answer: 'yes — proceed',
    });
    expect(out.resolved).toBe(1);
    expect(out.ids).toEqual([r.question.id]);
    expect(mockUnblockOwnerGatedItems).toHaveBeenCalledTimes(1);
    expect(mockUnblockOwnerGatedItems).toHaveBeenCalledWith({
      userId: 'u1',
      questionId: r.question.id,
      question: 'Deploy to ca-central-1 this weekend?',
      answer: 'yes — proceed',
      source: 'in-chat card answer',
      counterQuestion: false, // "yes — proceed" is a decision (CanLaw 2026-09-15)
      answeredBy: 'owner', // fadc3563 provenance
    });
  });

  it('a card answer resolving NOTHING never touches the choke point', async () => {
    const r = await flag({ question: 'Deploy to ca-central-1 this weekend?' });
    if (r.kind !== 'created') throw new Error('expected created');
    const out = await resolveOwnerQuestionsForChatAnswer({
      chatId: 'chat-1', userId: 'u1', askedQuestion: 'Totally unrelated card', answer: 'whatever',
    });
    expect(out).toEqual({ resolved: 0, ids: [] });
    expect(mockUnblockOwnerGatedItems).not.toHaveBeenCalled();
  });
});
