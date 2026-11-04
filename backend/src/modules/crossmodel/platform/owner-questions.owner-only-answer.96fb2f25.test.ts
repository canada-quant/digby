/**
 * Replay + guard pins for framework-audit item #8, todo 96fb2f25 (2026-10-16)
 * — "no supervisor answers an owner gate on the owner's behalf" when the
 * question falls in an OWNER-ONLY class.
 *
 * THE INCIDENT (oq_e4869c75, filed 2026-10-15 16:45:04Z, live row verified
 * 2026-10-16): two nightly-query-suite bug tickets were HELD for admin review
 * with the platform hold note "Held for owner review — this ticket is on
 * another account (or quotes another user's chat), and framework lanes merge +
 * deploy, so it is not worked automatically. An admin approves it to
 * dispatch." The Fleet Supervisor answered the resulting approve-dispatch
 * owner question with answer_owner_question — "1 — Approve dispatch of both to
 * a fix lane under goal b3f240e4. Answered under the owner's standing
 * directives: 'clear gates always on my behalf' and rule money.grant …" —
 * converting a SECURITY/TRUST-BOUNDARY hold (another account's data) into a
 * supervisor call on its own judgment that the foreign account was synthetic.
 * Every layer was code-legal: OWNER_ONLY_QUESTION_CLASSES had no
 * another-account class, and answerOwnerQuestion never re-checked class at
 * answer time.
 *
 * THE GUARD (this todo): (1) a new owner-only class `another_account_security`
 * — regex over question + context for "another account/user/member", "other
 * users/accounts", "quotes another user's chat" — routes such questions to
 * the OWNER at flag time (never triaged); (2) answerOwnerQuestion re-runs the
 * PURE classifier over the stored row and REFUSES a supervisor-provenance
 * answer to ANY owner-only class (another-account security, cross-project
 * scope, credentials, irreversible, external send, physically-human) with
 * 'owner_only_class' + the owner_answer_owner_only_refused metric — the row
 * stays open on the owner's card. A user-present turn (userDirected — the
 * owner's own voice) is never refused. Kill switch
 * OWNER_ANSWER_OWNER_ONLY_DISABLED=1 disables both the refusal and the metric.
 *
 * Mock discipline mirrors owner-questions.triage-race.91ec252a.test.ts.
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

import { answerOwnerQuestion, classifyOwnerQuestionRouting, OWNER_ONLY_QUESTION_CLASSES } from './owner-questions';

// The specimen's shape, verbatim where it matters (oq_e4869c75).
const SPECIMEN_QUESTION =
  'Two nightly-query-suite bug tickets are HELD for review with the platform hold: "Held for owner review — this ticket is on another account (or quotes another user\'s chat), and framework lanes merge + deploy, so it is not worked automatically. An admin approves it to dispatch." Should I dispatch a fix lane for them?';

const seedQuestion = (over: Record<string, any> = {}) => {
  const row = {
    id: 'oq_e4869c75-0000-4000-8000-000000000000',
    userId: 'u1',
    chatId: 'lane-nightly-suite',
    question: SPECIMEN_QUESTION,
    context: 'Held tickets held-aaa and held-bbb; the hold note quotes the drain loop verbatim.',
    status: 'open',
    answer: null,
    createdAt: new Date('2026-10-15T16:45:04.000Z'),
    resolvedAt: null,
    ...over,
  };
  mockQuestions.rows.push(row);
  return row;
};

describe('classifyOwnerQuestionRouting — another_account_security class (audit 96fb2f25)', () => {
  it('the specimen hold wording routes owner with reason another_account_security — never supervisor triage', () => {
    const r = classifyOwnerQuestionRouting(SPECIMEN_QUESTION, 'held tickets context');
    expect(r.route).toBe('owner');
    expect(r.reason).toBe('another_account_security');
  });

  it('the class list carries another_account_security BEFORE cross_project_scope (the hold wording reports its own class)', () => {
    const reasons = OWNER_ONLY_QUESTION_CLASSES.map((c) => c.reason);
    expect(reasons).toContain('another_account_security');
    expect(reasons.indexOf('another_account_security')).toBeLessThan(reasons.indexOf('cross_project_scope'));
  });

  it('the other held-ticket phrasings route owner too; a plain lane approval question still routes supervisor', () => {
    expect(classifyOwnerQuestionRouting('Approve dispatch of the ticket quoting another user\'s chat?', null).route).toBe('owner');
    expect(classifyOwnerQuestionRouting('The ticket is on another account — approve the dispatch?', null).reason).toBe('another_account_security');
    expect(classifyOwnerQuestionRouting('Should I merge PR #42 into main now that CI is green?', null).route).toBe('supervisor');
  });
});

describe('answerOwnerQuestion — owner-only class guard (audit 96fb2f25)', () => {
  beforeEach(() => {
    mockQuestions.reset();
    mockRecordLoopMetric.mockClear();
    mockAppendAnsweredQuestionDirective.mockClear();
    mockUnblockOwnerGatedItems.mockClear();
    delete process.env.OWNER_ANSWER_OWNER_ONLY_DISABLED;
  });
  afterEach(() => { delete process.env.OWNER_ANSWER_OWNER_ONLY_DISABLED; });

  it('REPLAY oq_e4869c75: the supervisor answer over the another-account hold is REFUSED — row stays open, zero side effects, refusal metric', async () => {
    seedQuestion();
    const r = await answerOwnerQuestion('oq_e4869c75', 'u1', '1 — Approve dispatch of both to a fix lane under goal b3f240e4. Answered under the owner\'s standing directives: "clear gates always on my behalf" and rule money.grant.', { answeredBy: 'supervisor' });
    expect(r).toBe('owner_only_class');
    // nothing flipped, nothing woken, nothing appended
    const row = mockQuestions.rows[0];
    expect(row.status).toBe('open');
    expect(row.answer).toBeNull();
    expect(mockAppendAnsweredQuestionDirective).not.toHaveBeenCalled();
    expect(mockUnblockOwnerGatedItems).not.toHaveBeenCalled();
    expect(mockFireScheduleTarget).not.toHaveBeenCalled();
    await new Promise((res) => setTimeout(res, 0));
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'owner_answer_owner_only_refused',
      meta: expect.objectContaining({ questionId: 'oq_e4869c75', reason: 'another_account_security' }),
    }));
  });

  it('the OWNER (or a user-present turn, userDirected) answers the same question freely — the guard never refuses the owner\'s own hand', async () => {
    seedQuestion();
    const r = await answerOwnerQuestion('oq_e4869c75', 'u1', '1 — Approve dispatch.', { answeredBy: 'owner' });
    expect(r).toBe('ok');
    expect(mockQuestions.rows[0].status).toBe('answered');
  });

  it('a supervisor answer to a NON-owner-only question still goes through (the guard does not over-block triage)', async () => {
    seedQuestion({
      id: 'oq_plain-0000-4000-8000-000000000000',
      question: 'Should I merge PR #42 into main now that CI is green?',
      context: 'CI 6/6 green on head abc1234.',
    });
    const r = await answerOwnerQuestion('oq_plain', 'u1', 'Yes — merge it; CI is green and the blocker registry is empty.', { answeredBy: 'supervisor' });
    expect(r).toBe('ok');
    expect(mockQuestions.rows[0].status).toBe('answered');
    expect(mockRecordLoopMetric).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'owner_answer_owner_only_refused' }));
  });

  it('other established owner-only classes are guarded at answer time too (cross_project_scope specimen shape)', async () => {
    seedQuestion({
      id: 'oq_xproj-0000-4000-8000-000000000000',
      question: 'The owner said in ANOTHER project to pause all deploys — does that directive apply to this lane?',
      context: 'Quoted words scoped to project "schooltime".',
    });
    const r = await answerOwnerQuestion('oq_xproj', 'u1', 'Yes, it applies fleet-wide.', { answeredBy: 'supervisor' });
    expect(r).toBe('owner_only_class');
    expect(mockQuestions.rows[0].status).toBe('open');
  });

  it('kill switch OWNER_ANSWER_OWNER_ONLY_DISABLED=1 restores the legacy behaviour (answer lands, no refusal metric)', async () => {
    seedQuestion();
    process.env.OWNER_ANSWER_OWNER_ONLY_DISABLED = '1';
    const r = await answerOwnerQuestion('oq_e4869c75', 'u1', '1 — Approve dispatch.', { answeredBy: 'supervisor' });
    expect(r).toBe('ok');
    expect(mockQuestions.rows[0].status).toBe('answered');
    await new Promise((res) => setTimeout(res, 0));
    expect(mockRecordLoopMetric).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'owner_answer_owner_only_refused' }));
  });
});
