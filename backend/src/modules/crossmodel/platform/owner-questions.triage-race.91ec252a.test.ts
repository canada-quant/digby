/**
 * Replay + guard pins for ticket 91ec252a — "Supervisor triage answer raced
 * the owner's own resolution — no guard checks for newer owner posts in the
 * filing chat" (enhancement, filed 2026-09-21 from the CanLaw incident).
 *
 * THE INCIDENT (timestamps verbatim from the ticket): owner question
 * oq_3a84257b was filed 18:54:32Z ("Do you have a Z.ai key to paste, or should
 * the v3 teacher mix run without the Z.ai stream?"). At 19:13:03Z the OWNER
 * answered it themselves by pasting the key directly in the filing chat
 * (CanLaw Supervisor chat f5c2c1f4). At 19:25:45Z the Fleet Supervisor's
 * triage answer — "proceed WITHOUT the Z.ai stream" — still delivered via
 * answer_owner_question, 12 minutes AFTER the owner had already resolved it;
 * the owner's inbox card then contradicted what they had just done.
 *
 * THE GUARD (this ticket): a supervisor-provenance answerOwnerQuestion probes
 * the FILING chat for owner-authored rows (role 'user' whose metadata.origin
 * is absent/'user' — the latestOwnerRowsAfter idiom, ticket c6db9c72) NEWER
 * than the question's createdAt. Any such row → 'owner_engaged': nothing
 * flips, no transcript note, no wake, a refusal metric is recorded. An
 * explicit acknowledgeNewerOwnerPosts override delivers WITH a visible stamp
 * on the note + wake. Owner-provenance answers are the authority itself and
 * are never guarded; a probe hiccup degrades to no-guard (best-effort).
 *
 * Pins (through the REAL answerOwnerQuestion; mock discipline mirrors
 * owner-questions.590d368d.test.ts):
 *   - the incident replay: the supervisor's stale answer is REFUSED and leaves
 *     zero side effects (row open, no note, no wake, refusal metric);
 *   - the acked re-answer proceeds and the transcript note + wake are VISIBLY
 *     stamped (override metric);
 *   - machine-origin traffic (agent/schedule/hook/webhook) newer than the
 *     question never trips the guard;
 *   - an owner post OLDER than the question never trips it;
 *   - an owner-provenance answer is never guarded, even over newer owner posts;
 *   - a probe hiccup degrades to no-guard — the answer still lands.
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

// The incident's real instants (ticket 91ec252a).
const FILED_AT = new Date('2026-09-21T18:54:32.000Z');
const OWNER_POST_AT = new Date('2026-09-21T19:13:03.000Z');

const seedQuestion = (over: Record<string, any> = {}) => {
  const row = {
    id: 'oq_3a84257b-0000-4000-8000-000000000000',
    userId: 'u1',
    chatId: 'lane-canlaw',
    question: 'Do you have a Z.ai key to paste, or should the v3 teacher mix run without the Z.ai stream?',
    status: 'open',
    answer: null,
    createdAt: FILED_AT,
    resolvedAt: null,
    ...over,
  };
  mockQuestions.rows.push(row);
  return row;
};

const seedMessage = (over: Record<string, any>) => {
  const row = {
    chatId: 'lane-canlaw',
    role: 'user',
    createdAt: OWNER_POST_AT,
    metadata: null, // a human owner row (origin absent)
    ...over,
  };
  mockQuestions.messageRows.push(row);
  return row;
};

// recordOwnerQuestionMetric is fire-and-forget (void + dynamic import —
// telemetry never blocks the inbox), so a refusal's metric lands a microtask
// AFTER answerOwnerQuestion returns; flush before asserting on it.
const flushMetrics = () => new Promise((r) => setImmediate(r));

beforeEach(() => {
  mockQuestions.reset();
  mockFireScheduleTarget.mockReset().mockResolvedValue({ started: true });
  mockUnblockOwnerGatedItems.mockReset().mockResolvedValue({ todos: 0, goals: 0 });
  mockAppendAnsweredQuestionDirective.mockReset().mockResolvedValue(undefined);
  mockSupervisorFindFirst.mockReset().mockResolvedValue({ id: 'sup-1' });
  mockRecordLoopMetric.mockReset();
});

describe('ticket 91ec252a — supervisor triage answer never races newer owner posts', () => {
  it('INCIDENT REPLAY: a newer owner post in the filing chat REFUSES the supervisor answer with zero side effects', async () => {
    const q = seedQuestion();
    seedMessage({ content: 'the zai is in the digby settings as well here it is again' }); // 19:13:03Z, human row

    const r = await answerOwnerQuestion(q.id, 'u1', 'Option 2 — proceed WITHOUT the Z.ai stream', { answeredBy: 'supervisor' });

    expect(r).toBe('owner_engaged');
    // Nothing flipped, nothing delivered, nobody woken.
    expect(q.status).toBe('open');
    expect(q.answer).toBeNull();
    expect(mockQuestions.crossModelMessage.create).not.toHaveBeenCalled();
    expect(mockFireScheduleTarget).not.toHaveBeenCalled();
    await flushMetrics();
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({ kind: 'owner_answer_triage_race_refused' }));
  });

  it('the acked re-answer after the refusal proceeds and is VISIBLY stamped (note + wake) with an override metric', async () => {
    const q = seedQuestion();
    seedMessage({});

    const refused = await answerOwnerQuestion(q.id, 'u1', 'Option 2 — proceed WITHOUT the Z.ai stream', { answeredBy: 'supervisor' });
    expect(refused).toBe('owner_engaged');

    const ok = await answerOwnerQuestion(q.id, 'u1', 'Proceed with the Z.ai stream — the owner supplied the key', { answeredBy: 'supervisor', acknowledgeNewerOwnerPosts: true });
    expect(ok).toBe('ok');
    expect(q.status).toBe('answered');
    expect((q as any).answeredBy).toBe('supervisor');
    // The transcript note carries the visible stamp…
    expect(mockQuestions.crossModelMessage.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ content: expect.stringContaining('newer owner post') }),
    });
    // …and so does the wake prompt.
    expect(mockFireScheduleTarget).toHaveBeenCalledWith(expect.objectContaining({
      prompt: expect.stringContaining('acknowledged them before answering'),
    }));
    await flushMetrics();
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({ kind: 'owner_answer_triage_race_override' }));
  });

  it('machine-origin traffic (agent/schedule/hook/webhook) newer than the question NEVER trips the guard', async () => {
    const q = seedQuestion();
    for (const origin of ['agent', 'schedule', 'hook', 'webhook']) {
      seedMessage({ metadata: { origin } });
    }

    const r = await answerOwnerQuestion(q.id, 'u1', 'Approved under standing directives.', { answeredBy: 'supervisor' });
    expect(r).toBe('ok');
    expect(q.status).toBe('answered');
  });

  it('an owner post OLDER than the question never trips the guard', async () => {
    const q = seedQuestion();
    seedMessage({ createdAt: new Date('2026-09-21T18:00:00.000Z') }); // before FILED_AT

    const r = await answerOwnerQuestion(q.id, 'u1', 'Approved under standing directives.', { answeredBy: 'supervisor' });
    expect(r).toBe('ok');
  });

  it('an owner-provenance answer is never guarded, even over a newer owner post', async () => {
    const q = seedQuestion();
    seedMessage({});

    const r = await answerOwnerQuestion(q.id, 'u1', 'Here is the key — proceed with the Z.ai stream.', { answeredBy: 'owner' });
    expect(r).toBe('ok');
    expect(q.status).toBe('answered');
    expect(mockRecordLoopMetric).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'owner_answer_triage_race_refused' }));
  });

  it('a probe hiccup degrades to no-guard — the supervisor answer still lands (best-effort)', async () => {
    const q = seedQuestion();
    mockQuestions.crossModelMessage.findMany.mockImplementationOnce(async () => { throw new Error('db down'); });

    const r = await answerOwnerQuestion(q.id, 'u1', 'Approved under standing directives.', { answeredBy: 'supervisor' });
    expect(r).toBe('ok');
    expect(q.status).toBe('answered');
  });
});
