/**
 * Replay for ticket 590d368d — "3× tool-failure streak: answer_owner_question
 * on 'Fleet Supervisor' — framework or model?" (P0 mishap; not_found streak in
 * the Fleet Supervisor chat c0e22e36, tripped 2026-09-17T05:46Z).
 *
 * THE STREAK: the Fleet Supervisor tried to answer three owner questions using
 * the oq_-prefixed SHORT ids carried verbatim by its triage events
 * (oq_3936085b, oq_72405c29, oq_8281cb0d — the fleet's first-8-chars relay
 * idiom, exactly what the tool's own not_found message tells it to copy). All
 * three rows EXISTED and were open (created 05:27–05:36Z; later answered by
 * the supervisor once full ids were used), but answerOwnerQuestion resolved
 * the id with a full-id-only findUnique — every verbatim triage id missed and
 * the refusal falsely claimed "No owner question with that id belongs to this
 * owner". Framework bug, not model error: list_owner_questions has resolved
 * unique ≥8-char prefixes since ticket 8bae9959 (#754); the ANSWER path was
 * never given the same treatment.
 *
 * THE FIX (this ticket): an exact-id miss on a ≥8-char input retries as an
 // owner-scoped unique prefix (the list-path resolver's semantics); an
 * ambiguous prefix refuses with a distinct 'ambiguous' reason instead of
 * answering the wrong gate.
 *
 * Pins (through the REAL answerOwnerQuestion, testkit seams — mock discipline
 * mirrors owner-questions.counter-question.test.ts):
 *   - the streak replay: the verbatim triage prefix answers the open row;
 *   - full ids keep working (a full id never touches the prefix lane);
 *   - an already-answered row via prefix is 'not_open', NOT the misleading
 *     not_found that sent the lane hunting for a "wrong" id;
 *   - a phantom prefix is still an honest not_found;
 *   - a <8-char prefix does NOT resolve (sibling-tool contract);
 *   - an ambiguous prefix refuses 'ambiguous' and flips NOTHING;
 *   - prefix resolution stays owner-scoped (another owner's row never resolves).
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

const mockUnblockOwnerGatedItems: jest.Mock = jest.fn(async () => ({ todos: 0, goals: 0 }));
jest.mock('./goals.service', () => ({
  __esModule: true,
  unblockOwnerGatedItems: (...a: any[]) => mockUnblockOwnerGatedItems(...a),
}));

const mockAppendAnsweredQuestionDirective: jest.Mock = jest.fn(async () => {});
jest.mock('./supervisor-state.service', () => ({
  __esModule: true,
  appendAnsweredQuestionDirective: (...a: any[]) => mockAppendAnsweredQuestionDirective(...a),
}));

const mockRecordLoopMetric: jest.Mock = jest.fn();
jest.mock('./loop-metrics.service', () => ({
  __esModule: true,
  ...jest.requireActual('./loop-metrics.service'),
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
}));

import { answerOwnerQuestion } from './owner-questions';

// The streak's REAL ids (verbatim from the ticket's failure texts, 2026-09-17T05:46Z).
const STREAK_ID = 'oq_3936085b-329f-4ace-82ce-c833520e19b2';
const STREAK_PREFIX = 'oq_3936085b';
const ANSWERED_ID = 'oq_72405c29-0654-484a-a88d-ac4dd5605150';
const ANSWERED_PREFIX = 'oq_72405c29';

const seed = (over: Record<string, any>) => {
  const row = {
    id: 'oq_00000000-0000-4000-8000-000000000000',
    userId: 'u1',
    chatId: 'lane-1',
    question: 'Recharge the suspended provider account?',
    status: 'open',
    answer: null,
    createdAt: new Date(Date.now()),
    resolvedAt: null,
    ...over,
  };
  mockQuestions.rows.push(row);
  return row;
};

beforeEach(() => {
  mockQuestions.reset();
  mockFireScheduleTarget.mockReset().mockResolvedValue({ started: true });
  mockUnblockOwnerGatedItems.mockReset().mockResolvedValue({ todos: 0, goals: 0 });
  mockAppendAnsweredQuestionDirective.mockReset().mockResolvedValue(undefined);
  mockSupervisorFindFirst.mockReset().mockResolvedValue({ id: 'sup-1' });
  mockRecordLoopMetric.mockReset();
});

describe('ticket 590d368d — answerOwnerQuestion resolves the verbatim triage prefix', () => {
  it('REPLAY: the 8-char oq_ prefix from the triage event answers the OPEN row (pre-fix: not_found)', async () => {
    seed({ id: STREAK_ID });
    // Exactly what the Fleet Supervisor passed at 05:46Z — the verbatim
    // triage-form id — as the supervisor, under standing directives.
    const r = await answerOwnerQuestion(STREAK_PREFIX, 'u1', 'Approved under standing directives — recharge path; lanes auto-resume.', { answeredBy: 'supervisor' });
    expect(r).toBe('ok');
    const row = mockQuestions.rows.find((x: any) => x.id === STREAK_ID);
    expect(row.status).toBe('answered');
    expect(row.answeredBy).toBe('supervisor');
    expect(String(row.answer)).toContain('Approved under standing directives');
  });

  it('a full id keeps working (the exact-id lane is untouched)', async () => {
    seed({ id: STREAK_ID });
    const r = await answerOwnerQuestion(STREAK_ID, 'u1', 'yes — recharge it', { answeredBy: 'owner' });
    expect(r).toBe('ok');
    expect(mockQuestions.rows.find((x: any) => x.id === STREAK_ID).status).toBe('answered');
  });

  it("an already-answered row via prefix is 'not_open' — NOT the misleading not_found from the streak", async () => {
    seed({ id: ANSWERED_ID, status: 'answered', answer: 'option 2', resolvedAt: new Date(Date.now() - 500) });
    const r = await answerOwnerQuestion(ANSWERED_PREFIX, 'u1', 'duplicate answer', { answeredBy: 'supervisor' });
    expect(r).toBe('not_open');
    // …and the recorded answer is NOT overwritten.
    expect(mockQuestions.rows.find((x: any) => x.id === ANSWERED_ID).answer).toBe('option 2');
  });

  it('a phantom prefix is still an honest not_found', async () => {
    seed({ id: STREAK_ID });
    const r = await answerOwnerQuestion('oq_ffffffff', 'u1', 'answer', { answeredBy: 'supervisor' });
    expect(r).toBe('not_found');
  });

  it('a prefix SHORTER than 8 chars never resolves (sibling-tool contract: unique ≥8-char prefix)', async () => {
    seed({ id: STREAK_ID });
    const r = await answerOwnerQuestion('oq_3936', 'u1', 'answer', { answeredBy: 'supervisor' });
    expect(r).toBe('not_found');
    expect(mockQuestions.rows.find((x: any) => x.id === STREAK_ID).status).toBe('open');
  });

  it("an ambiguous prefix refuses 'ambiguous' and flips NOTHING (never answers the wrong gate)", async () => {
    seed({ id: 'oq_aaaaaaaa-1111-4000-8000-000000000001' });
    seed({ id: 'oq_aaaaaaaa-2222-4000-8000-000000000002' });
    const r = await answerOwnerQuestion('oq_aaaaaaaa', 'u1', 'answer', { answeredBy: 'supervisor' });
    expect(r).toBe('ambiguous');
    expect(mockQuestions.rows.every((x: any) => x.status === 'open')).toBe(true);
  });

  it("prefix resolution stays OWNER-SCOPED — another owner's row never resolves", async () => {
    seed({ id: 'oq_bbbbbbbb-3333-4000-8000-000000000003', userId: 'u2' });
    const r = await answerOwnerQuestion('oq_bbbbbbbb', 'u1', 'answer', { answeredBy: 'supervisor' });
    expect(r).toBe('not_found');
    expect(mockQuestions.rows.find((x: any) => x.userId === 'u2').status).toBe('open');
  });
});
