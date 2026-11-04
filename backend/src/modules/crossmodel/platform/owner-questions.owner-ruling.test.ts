/**
 * 2026-10-20 — owner RULINGS on flagged questions reach the supervisor ledger.
 *
 * Specimen oq_892c91ae: the owner's ruling ("no new Hyperstack IP, ever — the
 * account is shutting down; canlegalbench.com comes back from the stanne
 * lab") lived only as the note on the dismissed card, never as a ledger
 * directive, so other lanes kept acting on the old plan. Pins the WIRING:
 * an OWNER answer / an OWNER dismissal note is handed to
 * appendOwnerRulingDirective on the Fleet Supervisor's ledger; supervisor /
 * agent dismissals, counter-questions and typed option picks never are; the
 * kill switch and a non-ruling skip the supervisor lookup entirely. The
 * classifier itself is pinned in supervisor-state.owner-keep-ruling.test.ts.
 */

import { createOwnerQuestionTable } from './owner-questions.testkit';

const mockQuestions = createOwnerQuestionTable();
const mockSupervisorFindFirst: jest.Mock = jest.fn(async () => ({ id: 'sup-1' }));
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    ownerQuestion: mockQuestions.api,
    crossModelMessage: mockQuestions.crossModelMessage,
    crossModelChat: { ...mockQuestions.crossModelChat, findFirst: (...a: any[]) => mockSupervisorFindFirst(...a) },
    telegramLink: { findUnique: jest.fn(async () => null) },
  },
}));

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('../coding/schedule.service', () => ({
  __esModule: true,
  fireScheduleTarget: jest.fn(async () => ({ started: true })),
  dailyCapExceeded: jest.fn(async () => null),
  refundDailyCapToken: jest.fn(async () => {}),
}));

jest.mock('../telegram/telegram.service', () => ({
  __esModule: true,
  isConfigured: () => false,
  sendMessage: jest.fn(async () => {}),
}));

jest.mock('./goals.service', () => ({
  __esModule: true,
  unblockOwnerGatedItems: jest.fn(async () => ({ todos: 0, goals: 0 })),
}));

const RULING_RE = /\b(ever|always)\b/i;
const mockAppendOwnerRulingDirective: jest.Mock = jest.fn(async () => 'appended');
const mockAppendAnsweredQuestionDirective: jest.Mock = jest.fn(async () => {});
let mockCaptureDisabled = false;
jest.mock('./supervisor-state.service', () => ({
  __esModule: true,
  appendAnsweredQuestionDirective: (...a: any[]) => mockAppendAnsweredQuestionDirective(...a),
  appendOwnerRulingDirective: (...a: any[]) => mockAppendOwnerRulingDirective(...a),
  ownerRulingCaptureDisabled: () => mockCaptureDisabled,
  // Stand-in classifier — the real one is pinned in its own suite.
  classifyOwnerRuling: (t: string) => ({ ruling: RULING_RE.test(t), standing: RULING_RE.test(t) }),
}));

jest.mock('./loop-metrics.service', () => ({
  __esModule: true,
  ...jest.requireActual('./loop-metrics.service'),
  recordLoopMetric: jest.fn(),
}));

import { answerOwnerQuestion, dismissOwnerQuestion, flagOwnerQuestion } from './owner-questions';

const HYPERSTACK = 'no new Hyperstack IP, ever — the account is shutting down; canlegalbench.com comes back from the stanne lab';

beforeEach(() => {
  mockQuestions.reset();
  mockAppendOwnerRulingDirective.mockReset().mockResolvedValue('appended');
  mockAppendAnsweredQuestionDirective.mockReset().mockResolvedValue(undefined);
  mockSupervisorFindFirst.mockReset().mockResolvedValue({ id: 'sup-1' });
  mockCaptureDisabled = false;
});

let flagSeq = 0;
const flag = async (extra: Record<string, unknown> = {}) => {
  flagSeq += 1; // one chat per card — the per-chat rate / cap guards are not under test here
  const r = await flagOwnerQuestion({ chatId: `chat-${flagSeq}`, userId: 'u1', question: 'Should we re-provision a new Hyperstack IP for canlegalbench.com?', ...extra } as any);
  if (r.kind !== 'created') throw new Error(`expected created, got ${r.kind}`);
  return r.question;
};

describe('owner answer → ruling capture', () => {
  it('an OWNER free-text ruling is handed to the Fleet Supervisor ledger (after the DONE answer row)', async () => {
    const q = await flag();
    expect(await answerOwnerQuestion(q.id, 'u1', HYPERSTACK)).toBe('ok');
    expect(mockAppendAnsweredQuestionDirective).toHaveBeenCalledTimes(1);
    expect(mockAppendOwnerRulingDirective).toHaveBeenCalledTimes(1);
    const [chatId, userId, entry] = mockAppendOwnerRulingDirective.mock.calls[0] as any[];
    expect(chatId).toBe('sup-1');
    expect(userId).toBe('u1');
    expect(entry).toMatchObject({ questionId: q.id, ruling: HYPERSTACK, source: 'answer', question: q.question });
  });

  it('a non-ruling answer, a supervisor answer, a counter-question and the kill switch never capture', async () => {
    const a = await flag();
    expect(await answerOwnerQuestion(a.id, 'u1', 'yes go ahead')).toBe('ok');
    const b = await flag({ question: 'Ship the v2 eval pack this week?' });
    expect(await answerOwnerQuestion(b.id, 'u1', 'use the old host always', { answeredBy: 'supervisor' })).toBe('ok');
    const c = await flag({ question: 'Rebuild the SFT dataset now?' });
    expect(await answerOwnerQuestion(c.id, 'u1', 'would it always be cheaper to wait?')).toBe('ok');
    mockCaptureDisabled = true;
    const d = await flag({ question: 'Move the bench back to the lab?' });
    expect(await answerOwnerQuestion(d.id, 'u1', HYPERSTACK)).toBe('ok');
    expect(mockAppendOwnerRulingDirective).not.toHaveBeenCalled();
  });

  it('a typed option pick is a choice, never a ruling', async () => {
    const q = await flag({ options: [{ id: 'a', label: 'never re-provision' }, { id: 'b', label: 're-provision once' }] });
    expect(await answerOwnerQuestion(q.id, 'u1', 'never re-provision')).toBe('ok');
    expect(mockQuestions.rows[0].chosenOption).toBe('a');
    expect(mockAppendOwnerRulingDirective).not.toHaveBeenCalled();
  });
});

describe('owner dismissal note → ruling capture', () => {
  it('the oq_892c91ae shape: an OWNER dismissal with a ruling note is captured with source dismissal', async () => {
    const q = await flag();
    expect(await dismissOwnerQuestion(q.id, 'u1', { dismissedBy: 'owner', reason: HYPERSTACK })).toBe('ok');
    expect(mockAppendOwnerRulingDirective).toHaveBeenCalledTimes(1);
    expect(mockAppendOwnerRulingDirective.mock.calls[0][2]).toMatchObject({ questionId: q.id, ruling: HYPERSTACK, source: 'dismissal' });
  });

  it('supervisor / agent dismissals, a note-less dismissal and an owner with no supervisor chat capture nothing', async () => {
    const a = await flag();
    expect(await dismissOwnerQuestion(a.id, 'u1', { dismissedBy: 'supervisor', reason: HYPERSTACK })).toBe('ok');
    const b = await flag({ question: 'Keep the old IP warm?' });
    expect(await dismissOwnerQuestion(b.id, 'u1', { dismissedBy: 'agent', reason: HYPERSTACK })).toBe('ok');
    const c = await flag({ question: 'Archive the bench lane?' });
    expect(await dismissOwnerQuestion(c.id, 'u1')).toBe('ok');
    expect(mockAppendOwnerRulingDirective).not.toHaveBeenCalled();
    mockSupervisorFindFirst.mockResolvedValue(null);
    const d = await flag({ question: 'Try a different region?' });
    expect(await dismissOwnerQuestion(d.id, 'u1', { dismissedBy: 'owner', reason: HYPERSTACK })).toBe('ok');
    expect(mockAppendOwnerRulingDirective).not.toHaveBeenCalled();
  });
});
