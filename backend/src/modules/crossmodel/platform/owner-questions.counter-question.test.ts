/**
 * CanLaw stall 2026-09-15 — an owner reply that is ITSELF A QUESTION is not a
 * decision.
 *
 * The incident: the CanLaw coordinator lane pre-set its own "Sept-1 band
 * table" and auto-halted training; every card it filed asserted HALT as in
 * force and asked "which path?"; the owner's four replies were questions back
 * ("would #2 be the best…?", "well didn't we change the benchmark a ton?",
 * "don't you have to rebuild the SFT dataset now…? shouldn't you start that
 * now…?"). answerOwnerQuestion stored them as `answered` and relayed "the
 * OWNER just answered… act on this answer now"; the lane wrote "owner's
 * HALT-band decision MADE" into the todo; the new project supervisor copied it
 * into its ledger as an open owner directive and told the owner "it's your
 * gate — one word from you lifts it" for a day.
 *
 * Pins: the detector (the real CanLaw replies + decisive leads + typed
 * options), and the relay — transcript note, wake header/instruction, ledger
 * entry, gate release note, metric — all say "a question back, no decision".
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

import {
  COUNTER_QUESTION_INSTRUCTION,
  COUNTER_QUESTION_WAKE_HEADER,
  OWNER_WAIT_CLAIM_RE,
  answerOwnerQuestion,
  flagOwnerQuestion,
  isCounterQuestionAnswer,
  isCounterQuestionRow,
} from './owner-questions';

beforeEach(() => {
  mockQuestions.reset();
  mockFireScheduleTarget.mockReset().mockResolvedValue({ started: true });
  mockUnblockOwnerGatedItems.mockReset().mockResolvedValue({ todos: 0, goals: 0 });
  mockAppendAnsweredQuestionDirective.mockReset().mockResolvedValue(undefined);
  mockSupervisorFindFirst.mockReset().mockResolvedValue({ id: 'sup-1' });
  mockRecordLoopMetric.mockReset();
});

const flag = async () => {
  const r = await flagOwnerQuestion({
    chatId: 'chat-1', userId: 'u1',
    question: 'CANLAW HALT-BAND DECISION: the corrected score is 24.46% — what is your call on the path forward?',
  });
  if (r.kind !== 'created') throw new Error('expected created');
  return r.question;
};

// ── The detector ──────────────────────────────────────────────────────────────

describe('isCounterQuestionAnswer', () => {
  it.each<[string, boolean]>([
    // The four CanLaw replies that were laundered into an "owner HALT decision".
    ['would #2 be the best to get the highest quality scores after knowing exactly what it is missing for each question to build the best data set?', true],
    ['well didn’t we change the benchmark a ton in between this?', true],
    ['dont you have to rebuild the sft dataset now using all the failure and passing data ? shouldnt you start that now as you even said the tasks didnt change just scoring? cant you work with canlegal bench to help to as well? how much linger until the canlegal benchmark is all finished?', true],
    // …and the CanLaw replies that WERE decisions.
    ['yeah #2 figure out whats going on and work together with the canlegalbench agent sessions and supervisor for coordinating research and fixes and plans', false],
    ['yes go…obivoiusly', false],
    // A decisive lead wins even when a question follows.
    ['Yes — go ahead, but is the v2 pack ready?', false],
    ['No. Why would we?', false],
    ['Option 2 — and how long will it take?', false],
    ['#2?', false],
    ['2', false],
    ['HOLD until Friday?', false],
    ['proceed', false],
    ['ca-central-1', false],
    // Plain questions back.
    ['why?', true],
    ['Is that safe???', true],
    ['what does option 2 cost? (rough number is fine)', true],
    ['are we planning to sft-2 the post cpt or ontop of the sft-1? if we messed up that bad shouldnt we just use the post cpt ?', true],
    // Adversarial review 2026-09-15: a decision FOLLOWED by a question is a decision…
    ['Path C. But is the dataset ready?', false],
    ['Take both. ETA?', false],
    ['Pick option B. How long?', false],
    ['Use the post-CPT checkpoint. Okay?', false],
    ['Neither. Why did the score drop?', false],
    ['Kill it — how much did we burn?', false],
    ['Sure, why not?', false],
    ['Absolutely, and can you also add X?', false],
    ['Option B?', false],
    ['A?', false],
    ['b?', false],
    ['Approved (2 or 3?)', false],
    // …and a hedged lead is still a question back.
    ["no idea, what's the cost?", true],
    ['No clue — which one is cheaper?', true],
    ['okay so what changed?', true],
    ['ok but why?', true],
    ['Go where?', true],
    ['Stop what?', true],
    ['yes?', true],
    ['(why?)', true],
    ['why？', true],
    ['', false],
    ['   ', false],
  ])('%j → %s', (answer, expected) => {
    expect(isCounterQuestionAnswer(answer, null)).toBe(expected);
  });

  it('a reply that matched a typed option is never a counter-question, whatever its shape', () => {
    expect(isCounterQuestionAnswer('Option B — retry?', { id: 'b', label: 'Option B — retry?' })).toBe(false);
  });
});

describe('isCounterQuestionRow — the row-level form the sweeper / digest / watchdog / card read', () => {
  const q = "well didn't we change the benchmark a ton in between this?";
  it.each([
    [{ status: 'answered', answer: q, chosenOption: null, answeredBy: 'owner' }, true],
    [{ status: 'answered', answer: q, chosenOption: null, answeredBy: null }, true], // legacy rows (no provenance column)
    [{ status: 'answered', answer: q, chosenOption: 'b', answeredBy: 'owner' }, false], // a typed option was picked
    [{ status: 'answered', answer: q, chosenOption: null, answeredBy: 'supervisor' }, false], // rulings by contract
    [{ status: 'answered', answer: q, chosenOption: null, answeredBy: 'default' }, false], // the flagger's preset default
    [{ status: 'open', answer: null, chosenOption: null, answeredBy: null }, false],
    [{ status: 'dismissed', answer: null, chosenOption: null, answeredBy: null }, false],
    [{ status: 'answered', answer: 'yes go — use the post-CPT base', chosenOption: null, answeredBy: 'owner' }, false],
    [null, false],
  ])('%j → %s', (row, expected) => {
    expect(isCounterQuestionRow(row as any)).toBe(expected);
  });
});

// ── The relay ─────────────────────────────────────────────────────────────────

describe('answerOwnerQuestion with a counter-question', () => {
  it('flips the row to answered but relays "WITH A QUESTION, not a decision" — note, wake, ledger, gate release, metric', async () => {
    const q = await flag();
    const reply = "well didn't we change the benchmark a ton in between this?";
    expect(await answerOwnerQuestion(q.id, 'u1', reply)).toBe('ok');

    // The durable row: still an honest 'answered' flip (the card is closed), owner provenance.
    const row = mockQuestions.rows[0];
    expect(row.status).toBe('answered');
    expect(row.answeredBy).toBe('owner');
    expect(row.answer).toBe(reply);

    // Transcript note names the shape.
    const note = mockQuestions.crossModelMessage.create.mock.calls[0][0].data.content as string;
    expect(note).toContain('The owner replied to your flagged question WITH A QUESTION — not a decision');
    expect(note).toContain('no ruling was made; answer the owner\'s question and proceed under the standing directives');

    // The wake: header + instruction say "not a decision"; the classic "act on this answer now" is GONE.
    expect(mockFireScheduleTarget).toHaveBeenCalledTimes(1);
    const wake = mockFireScheduleTarget.mock.calls[0][0];
    expect(wake.sessionId).toBe('chat-1');
    expect(wake.prompt.startsWith(COUNTER_QUESTION_WAKE_HEADER)).toBe(true);
    expect(wake.prompt).toContain(`Owner asked back: "${reply}"`);
    expect(wake.prompt).toContain(COUNTER_QUESTION_INSTRUCTION);
    expect(wake.prompt).toContain("NO decision was made and none may be recorded as the owner's (not a GO, not a HALT)");
    expect(wake.prompt).toContain('Never park work as "waiting on the owner" citing this reply');
    expect(wake.prompt).not.toContain('OWNER just answered');
    expect(wake.prompt).not.toContain('Act on this answer now');

    // Ledger entry is flagged so supervisor-state records "asked back — no decision".
    expect(mockAppendAnsweredQuestionDirective).toHaveBeenCalledWith(
      'sup-1', 'u1', expect.objectContaining({ questionId: q.id, answer: reply, counterQuestion: true }),
    );
    // Derived gates release with the counter-question note (the card is closed; nothing may stay parked on it).
    expect(mockUnblockOwnerGatedItems).toHaveBeenCalledWith(expect.objectContaining({
      questionId: q.id, source: 'owner inbox answer', counterQuestion: true,
      skipWakeChatIds: ['chat-1'], // the asking chat already got THIS wake
    }));
  });

  it('a decisive reply keeps the classic relay ("OWNER just answered… Act on this answer now"); counterQuestion is false everywhere', async () => {
    const q = await flag();
    expect(await answerOwnerQuestion(q.id, 'u1', 'yeah #2 figure out whats going on and work together with the bench sessions')).toBe('ok');
    const wake = mockFireScheduleTarget.mock.calls[0][0];
    expect(wake.prompt).toContain('[Owner inbox — the OWNER just answered your flagged question]');
    expect(wake.prompt).toContain('Act on this answer now');
    expect(wake.prompt).not.toContain(COUNTER_QUESTION_WAKE_HEADER);
    const note = mockQuestions.crossModelMessage.create.mock.calls[0][0].data.content as string;
    expect(note).toContain('The owner answered your flagged question');
    expect(note).not.toContain('WITH A QUESTION');
    expect(mockAppendAnsweredQuestionDirective).toHaveBeenCalledWith('sup-1', 'u1', expect.objectContaining({ counterQuestion: false }));
    expect(mockUnblockOwnerGatedItems).toHaveBeenCalledWith(expect.objectContaining({ counterQuestion: false }));
  });

  it('a SUPERVISOR answer (answer_owner_question) is a ruling by contract even when phrased as a question', async () => {
    const q = await flag();
    expect(await answerOwnerQuestion(q.id, 'u1', "shouldn't the lane just proceed under directive 6187239a?", { answeredBy: 'supervisor' })).toBe('ok');
    const wake = mockFireScheduleTarget.mock.calls[0][0];
    expect(wake.prompt).toContain('FLEET SUPERVISOR answered your flagged question');
    expect(wake.prompt).not.toContain(COUNTER_QUESTION_WAKE_HEADER);
    expect(mockAppendAnsweredQuestionDirective).toHaveBeenCalledWith('sup-1', 'u1', expect.objectContaining({ counterQuestion: false }));
  });

  // Adversarial review 2026-09-15 (blocker): the lane is told to RE-FILE the
  // decision with its answer — a superset of the same question text. The
  // duplicate resolver must never close that re-filed card with the owner's
  // question; a real decision still resolves same-decision duplicates.
  it('a counter-question resolves NO open duplicate of the same decision; a real decision still does', async () => {
    const q1 = await flag();
    const r2 = await flagOwnerQuestion({
      chatId: 'chat-2', userId: 'u1',
      question: 'CANLAW HALT-BAND DECISION: the corrected score is 24.46% — what is your call on the path forward? (re-filed with my answer: the scoring changed, the exam did not)',
    });
    if (r2.kind !== 'created') throw new Error(`expected the re-filed question to be created, got ${r2.kind}`);
    expect(await answerOwnerQuestion(q1.id, 'u1', "well didn't we change the benchmark a ton in between this?")).toBe('ok');
    expect(mockQuestions.rows.find((r: any) => r.id === r2.question.id)!.status).toBe('open'); // untouched
    expect(mockFireScheduleTarget).toHaveBeenCalledTimes(1); // only the asking chat woke

    // Now a REAL decision on a third same-decision row (the original text, whose
    // normalized form the re-filed superset contains) closes the re-filed one too.
    const r3 = await flagOwnerQuestion({
      chatId: 'chat-3', userId: 'u1',
      question: 'CANLAW HALT-BAND DECISION: the corrected score is 24.46% — what is your call on the path forward?',
    });
    if (r3.kind !== 'created') throw new Error(`expected created, got ${r3.kind}`);
    expect(await answerOwnerQuestion(r3.question.id, 'u1', 'GO — train on the post-CPT base')).toBe('ok');
    expect(mockQuestions.rows.find((r: any) => r.id === r2.question.id)!.status).toBe('answered');
  });
});

// ── The claim regex now sees the CanLaw shapes ────────────────────────────────

describe('OWNER_WAIT_CLAIM_RE — possessive and "halted per the owner" forms (CanLaw 2026-09-15)', () => {
  it.each([
    "2026-09-14T05:04Z supervisor refresh: owner's HALT-band decision MADE — training stays stopped",
    "SFT-2 fork stays BLOCKED pending the owner's HALT-band decision, so RL-1 stays blocked too",
    'training HALTED per the owner until the re-derived fork clears',
    "waiting on the owner's GO/HOLD call",
    'Awaiting owner decision on the serving engine',
    'owner answer to the halt-band card as reported by Path C',
  ])('claims: %s', (reason) => {
    expect(OWNER_WAIT_CLAIM_RE.test(reason)).toBe(true);
  });

  it.each([
    '[deps] Waiting on 2 todos',
    'Provider connection dropped mid-run; needs restart',
    'the project owner renamed the repo last week',
    'owners of the bucket rotated the key',
  ])('does not claim: %s', (reason) => {
    expect(OWNER_WAIT_CLAIM_RE.test(reason)).toBe(false);
  });
});
