/**
 * Ticket 1a56f816 (2026-10-30): owner-only (physically-human) cards entered
 * supervisor triage and were held behind a 2 h triageUntil the owner could not
 * see past — with no lawful release path (a Fleet Supervisor may not ANSWER an
 * owner-only card and may not SURFACE one).
 *
 * THE MISHAP REPLAY: specimen oq_3c246863 (filed 2026-10-30T16:56:51Z on chat
 * daee2916): the owner asked for literal step-by-step instructions ("you need
 * to provide step by step instructions dont know what you just said to to run
 * agents enable?"), the lane re-filed with the copy-paste steps, and the card —
 * whose own typed options were "Done — ran it, output pasted below" / "Error —
 * it printed something odd" / "Defer" / "I don't have the sudo password / not
 * at that machine right now" — was triaged (triageUntil 18:56:51Z, ~2 h). The
 * prose regex allowlist (classifyOwnerQuestionRouting) had no cue for it; the
 * class was decidable only from the card's own PAYLOAD.
 *
 * Pins:
 *   - ownerOnlyPayloadClass: the specimen's exact option labels and its
 *     device+sudo wording class physically_human; ordinary approval cards do
 *     not (no over-match: the b32e0da5 lesson, N1);
 *   - flagOwnerQuestion: the replayed card is NOT triaged (no triage, no
 *     triageUntil, DM sent) — the flag-time admission;
 *   - flagOwnerQuestion: the same card with the kill switch set IS triaged
 *     (OWNER_QUESTION_PAYLOAD_CLASS_DISABLED=1 → pre-fix routing);
 *   - answerOwnerQuestion: a supervisor may NOT answer a payload-classed card
 *     (owner_only_class refusal — same guard, stored-row payload);
 *   - checkSupervisorDismissRails: a supervisor may NOT withdraw one either;
 *   - surfaceTriagedOwnerQuestions: EARLY RELEASE — a card still inside its
 *     triage window whose owner posted in the filing chat after filing is
 *     flipped to 'surfaced' and DM'd at once (the release path the incident
 *     lacked), while an unengaged card stays held; and the kill switch
 *     OWNER_QUESTION_TRIAGE_EARLY_RELEASE_DISABLED=1 holds it again.
 */

import { createOwnerQuestionTable } from './owner-questions.testkit';

const mockQuestions = createOwnerQuestionTable();
const mockTelegramLinkFindUnique: jest.Mock = jest.fn(async (): Promise<any> => null);
const mockChatFindUnique: jest.Mock = jest.fn(async (): Promise<any> => ({ isSupervisor: false, projectId: null }));
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    ownerQuestion: mockQuestions.api,
    crossModelMessage: mockQuestions.crossModelMessage,
    crossModelChat: {
      ...mockQuestions.crossModelChat,
      findUnique: (...a: any[]) => mockChatFindUnique(...a),
      findFirst: jest.fn(async () => ({ id: 'sup-chat' })),
    },
    telegramLink: { findUnique: (...a: any[]) => mockTelegramLinkFindUnique(...a) },
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
  dailyCapExceeded: jest.fn(async (): Promise<number | null> => null),
  refundDailyCapToken: jest.fn(async () => {}),
  armOwnerAnswerRetrySchedule: jest.fn(async () => ({ ok: true, scheduleId: 'sched-retry-1' })),
}));

const mockTelegramSendMessage: jest.Mock = jest.fn(async () => true);
jest.mock('../telegram/telegram.service', () => ({
  __esModule: true,
  isConfigured: () => true,
  sendMessage: (...a: any[]) => mockTelegramSendMessage(...a),
}));

jest.mock('./goals.service', () => ({
  __esModule: true,
  unblockOwnerGatedItems: jest.fn(async () => ({ unblockedTodos: 0, unblockedGoals: 0 })),
}));
jest.mock('./supervisor-state.service', () => ({
  __esModule: true,
  appendAnsweredQuestionDirective: jest.fn(async () => {}),
}));

const mockEmitHookEventSafe: jest.Mock = jest.fn(async () => {});
jest.mock('./hooks.service', () => ({
  __esModule: true,
  emitHookEventSafe: (...a: any[]) => mockEmitHookEventSafe(...a),
}));
const mockRecordLoopMetric: jest.Mock = jest.fn();
jest.mock('./loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
  LOOP_METRIC_KINDS: {
    OWNER_QUESTION_TRIAGED: 'owner_question_triaged',
    OWNER_QUESTION_SURFACED: 'owner_question_surfaced',
    OWNER_QUESTION_SUPERVISOR_ANSWERED: 'owner_question_supervisor_answered',
  },
}));

import {
  answerOwnerQuestion,
  checkSupervisorDismissRails,
  flagOwnerQuestion,
  ownerOnlyPayloadClass,
  surfaceTriagedOwnerQuestions,
} from './owner-questions';

/** The specimen card's own typed options (oq_3c246863, quoted from the ticket). */
const SPECIMEN_OPTIONS = [
  { id: 'done', label: 'Done — ran it, output pasted below' },
  { id: 'error', label: 'Error — it printed something odd' },
  { id: 'defer', label: 'Defer' },
  { id: 'no_sudo', label: "I don't have the sudo password / not at that machine right now" },
];

/** The specimen's question shape: a named physical machine + sudo + paste-back,
 *  with NO prose cue the regex allowlist matches (no click/tap/sign/physically). */
const SPECIMEN_QUESTION =
  'Run the agents-enable steps on the Mac mini and paste what steps 4 and 5 print. ' +
  'The Windows PC cannot run this yet.';

const flagInput = (overrides: Record<string, unknown> = {}) => ({
  chatId: 'lane-1',
  userId: 'u1',
  machineTriggered: true,
  question: SPECIMEN_QUESTION,
  options: SPECIMEN_OPTIONS,
  expectedAnswerType: 'choice',
  ...overrides,
});

const ENV_KEYS = ['OWNER_QUESTION_PAYLOAD_CLASS_DISABLED', 'OWNER_QUESTION_TRIAGE_EARLY_RELEASE_DISABLED', 'OWNER_ANSWER_OWNER_ONLY_DISABLED', 'OWNER_DISMISS_RAILS_DISABLED'];

beforeEach(() => {
  mockQuestions.reset();
  mockChatFindUnique.mockReset().mockResolvedValue({ isSupervisor: false, projectId: null });
  mockTelegramLinkFindUnique.mockReset().mockResolvedValue({ chatId: 'tg-owner' });
  mockTelegramSendMessage.mockClear();
  mockEmitHookEventSafe.mockClear();
  mockRecordLoopMetric.mockClear();
  for (const k of ENV_KEYS) delete process.env[k];
});
afterEach(() => { for (const k of ENV_KEYS) delete process.env[k]; });

const flush = () => new Promise((r) => setTimeout(r, 10));

describe('1a56f816 — ownerOnlyPayloadClass (the pure classifier)', () => {
  it('classes the specimen card from its typed options alone (no prose cue)', () => {
    // The prose alone is a plain instruction the allowlist does not match…
    expect(ownerOnlyPayloadClass({ question: SPECIMEN_QUESTION, context: null, options: null })).not.toBeNull();
    // …and the options alone class it even with a bland question.
    expect(ownerOnlyPayloadClass({ question: 'Agents enable?', context: null, options: SPECIMEN_OPTIONS })).toBe('physically_human');
  });

  it('classes device + unobtainable credential / run-and-paste wording', () => {
    expect(ownerOnlyPayloadClass({ question: 'On the Mac mini, enter the sudo password when prompted, then paste the output', context: null, options: null })).toBe('physically_human');
    expect(ownerOnlyPayloadClass({ question: 'On your MacBook, paste what the command prints', context: null, options: null })).toBe('physically_human');
  });

  it('does NOT class ordinary approval cards (no over-match — the b32e0da5 N1 lesson)', () => {
    expect(ownerOnlyPayloadClass({ question: 'Scale out to 3 boxes tonight?', context: null, options: [{ id: 'go', label: 'GO' }, { id: 'hold', label: 'HOLD' }] })).toBeNull();
    expect(ownerOnlyPayloadClass({ question: 'Which checkpoint for tonight\'s eval?', context: null, options: [{ id: '8b', label: 'The 8B' }, { id: '14b', label: 'The 14B' }] })).toBeNull();
    // A cloud box the fleet drives is NOT a person-only device, even with sudo wording.
    expect(ownerOnlyPayloadClass({ question: 'Restart the EC2 box with sudo systemctl restart backend', context: null, options: null })).toBeNull();
    // "Defer" alone (injected on every console card) never classes anything.
    expect(ownerOnlyPayloadClass({ question: 'Approve the staging window?', context: null, options: [{ id: 'defer', label: 'Defer' }] })).toBeNull();
    // The prose-only regex classes still win first (precedence unchanged).
    expect(ownerOnlyPayloadClass({ question: 'Tap the button to confirm', context: null, options: null })).toBeNull(); // handled by the allowlist, not this leg
  });

  // REVIEW FIX (adversarial finding 1 — BLOCKING, caught before merge): the
  // first cut shared one alternation with the IMPERATIVE "run it" and therefore
  // owner-routed the commonest affirmative option label in the fleet — every
  // ordinary "Run it" / "Go ahead and run it" approval would have skipped
  // supervisor triage entirely. The discriminator is tense and shape: an
  // imperative is an instruction the lane executes; only a PAST-TENSE report or
  // an inability report proves the card is waiting on a person. This pin is the
  // finding, replayed — it fails on the shipped-then-fixed expression.
  it('REGRESSION (review finding 1): imperative approve-the-action labels are NOT the human-action class', () => {
    const IMPERATIVES = [
      'Run it', 'Run it now', 'Go ahead and run it', 'Re-run it', 'yes, run it',
      'Run it and paste the output', 'Run the tests', 'Retry', 'Approve', 'Deploy',
      'GO', 'Hold', 'Stop the run', 'Kill the run',
    ];
    for (const label of IMPERATIVES) {
      expect(ownerOnlyPayloadClass({ question: 'Proceed with the deploy?', context: null, options: [{ id: 'x', label }] }))
        .toBeNull();
    }
    // …and the specimen's THREE independent alternatives still class it.
    for (const label of [
      'Done — ran it, output pasted below',
      'Error — it printed something odd',
      "I don't have the sudo password / not at that machine right now",
    ]) {
      expect(ownerOnlyPayloadClass({ question: 'Agents enable?', context: null, options: [{ id: 'x', label }] }))
        .toBe('physically_human');
    }
  });
});

describe('1a56f816 — flag-time admission (the mishap replay)', () => {
  it('REPLAY oq_3c246863: the specimen card is NOT triaged — no triage, no triageUntil, owner DM sent', async () => {
    const r = await flagOwnerQuestion(flagInput() as any);
    expect(r.kind).toBe('created');
    if (r.kind !== 'created') return;
    expect((r.question as any).triage).toBeUndefined();
    expect((r.question as any).triageUntil).toBeUndefined();
    expect(r.delivery).not.toBe('triage');
    await flush();
    expect(mockEmitHookEventSafe).not.toHaveBeenCalled();
    expect(mockTelegramSendMessage).toHaveBeenCalled();
  });

  it('kill switch OWNER_QUESTION_PAYLOAD_CLASS_DISABLED=1 → the specimen IS triaged again (pre-fix routing)', async () => {
    process.env.OWNER_QUESTION_PAYLOAD_CLASS_DISABLED = '1';
    const r = await flagOwnerQuestion(flagInput() as any);
    expect(r.kind).toBe('created');
    if (r.kind !== 'created') return;
    expect((r.question as any).triage).toBe('supervisor');
    expect((r.question as any).triageUntil).toBeInstanceOf(Date);
    expect(r.delivery).toBe('triage');
  });

  it('an ordinary machine-lane approval still triages (the standing directive is untouched)', async () => {
    const r = await flagOwnerQuestion(flagInput({
      question: 'Scale out to 3 boxes tonight?',
      options: [{ id: 'go', label: 'GO' }, { id: 'hold', label: 'HOLD' }],
      expectedAnswerType: 'choice',
    }) as any);
    expect(r.kind).toBe('created');
    if (r.kind !== 'created') return;
    expect((r.question as any).triage).toBe('supervisor');
  });
});

describe('1a56f816 — answer / dismiss guards read the stored payload', () => {
  it('a supervisor may not ANSWER a payload-classed card (owner_only_class)', async () => {
    const r = await flagOwnerQuestion(flagInput({ machineTriggered: false }) as any);
    expect(r.kind).toBe('created');
    if (r.kind !== 'created') return;
    // The row was filed as owner-only (machineTriggered false ⇒ no triage either way);
    // the answer-time guard must refuse a supervisor answer on the PAYLOAD class.
    const res = await answerOwnerQuestion(r.question.id, 'u1', 'Done — ran it', { answeredBy: 'supervisor' });
    expect(res).toBe('owner_only_class');
    await flush(); // the refusal metric is fire-and-forget
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'owner_answer_owner_only_refused', meta: expect.objectContaining({ reason: 'physically_human' }) }),
    );
  });

  it('a supervisor may not DISMISS a payload-classed card (dismiss rails)', async () => {
    const r = await flagOwnerQuestion(flagInput({ machineTriggered: false }) as any);
    expect(r.kind).toBe('created');
    if (r.kind !== 'created') return;
    const row: any = mockQuestions.rows.find((x: any) => x.id === r.question.id);
    const verdict = await checkSupervisorDismissRails(
      {
        id: row.id, chatId: row.chatId, question: row.question, context: row.context ?? null,
        createdAt: row.createdAt, forChatId: row.forChatId ?? null,
        options: row.options, expectedAnswerType: row.expectedAnswerType, consoleAction: row.consoleAction,
      },
      { role: 'fleet' },
    );
    expect(verdict).toEqual({ ok: false, reason: 'owner_only_class', detail: 'physically_human' });
  });
});

describe('1a56f816 — early release on owner engagement (the missing release path)', () => {
  const seedTriaged = (id: string, untilMs: number) => {
    mockQuestions.rows.push({
      id, userId: 'u1', chatId: 'lane-1', status: 'open',
      question: 'Scale out to 3 boxes tonight?',
      context: null, answer: null, options: [{ id: 'go', label: 'GO' }],
      expectedAnswerType: 'choice',
      triage: 'supervisor', triageUntil: new Date(untilMs),
      createdAt: new Date(Date.now() - 30 * 60_000),
      resolvedAt: null,
    } as any);
  };

  it('an owner post in the filing chat AFTER filing releases the window early (flip + immediate DM + metric)', async () => {
    seedTriaged('oq_engaged', Date.now() + 60 * 60_000); // 1 h of SLA left
    // The owner posted in the filing chat after the card was filed.
    mockQuestions.messageRows.push({
      id: 'm1', chatId: 'lane-1', role: 'user',
      createdAt: new Date(Date.now() - 5 * 60_000),
      metadata: { origin: 'user' },
    } as any);
    const n = await surfaceTriagedOwnerQuestions();
    expect(n).toBe(1);
    const row: any = mockQuestions.rows.find((x: any) => x.id === 'oq_engaged');
    expect(row.triage).toBe('surfaced');
    await flush();
    expect(mockTelegramSendMessage).toHaveBeenCalledTimes(1);
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'owner_question_triage_early_released', meta: expect.objectContaining({ questionId: 'oq_engaged' }) }),
    );
  });

  it('no owner post → the card stays held for the SLA (the standing directive keeps working)', async () => {
    seedTriaged('oq_quiet', Date.now() + 60 * 60_000);
    const n = await surfaceTriagedOwnerQuestions();
    expect(n).toBe(0);
    const row: any = mockQuestions.rows.find((x: any) => x.id === 'oq_quiet');
    expect(row.triage).toBe('supervisor');
    expect(mockTelegramSendMessage).not.toHaveBeenCalled();
  });

  it('a MACHINE-origin post (a wake, a schedule firing) never counts as engagement', async () => {
    seedTriaged('oq_machine', Date.now() + 60 * 60_000);
    mockQuestions.messageRows.push({
      id: 'm2', chatId: 'lane-1', role: 'user',
      createdAt: new Date(Date.now() - 5 * 60_000),
      metadata: { origin: 'schedule' },
    } as any);
    const n = await surfaceTriagedOwnerQuestions();
    expect(n).toBe(0);
    const row: any = mockQuestions.rows.find((x: any) => x.id === 'oq_machine');
    expect(row.triage).toBe('supervisor');
  });

  it('kill switch OWNER_QUESTION_TRIAGE_EARLY_RELEASE_DISABLED=1 holds the card (pre-fix behaviour)', async () => {
    process.env.OWNER_QUESTION_TRIAGE_EARLY_RELEASE_DISABLED = '1';
    seedTriaged('oq_held', Date.now() + 60 * 60_000);
    mockQuestions.messageRows.push({
      id: 'm3', chatId: 'lane-1', role: 'user',
      createdAt: new Date(Date.now() - 5 * 60_000),
      metadata: { origin: 'user' },
    } as any);
    const n = await surfaceTriagedOwnerQuestions();
    expect(n).toBe(0);
    const row: any = mockQuestions.rows.find((x: any) => x.id === 'oq_held');
    expect(row.triage).toBe('supervisor');
  });

  // REVIEW FIX (adversarial finding 2 — BLOCKING): the class admission stops a
  // NEW card from triaging, but a card ALREADY sitting in a triage window that
  // classes owner-only was unreachable by every seat — a supervisor may not
  // answer it (the answer guard refuses) and may not withdraw it (the dismiss
  // rails refuse), so the window could only ever burn down to the SLA. That is
  // the specimen's own shape, and it is also what any card filed before this
  // deploy looks like. The sweep now releases it on the next pass.
  it('REGRESSION (review finding 2): an owner-only card ALREADY in triage is released with no owner post at all', async () => {
    mockQuestions.rows.push({
      id: 'oq_unanswerable', userId: 'u1', chatId: 'lane-1', status: 'open',
      question: SPECIMEN_QUESTION, context: null, answer: null,
      options: SPECIMEN_OPTIONS, expectedAnswerType: 'choice',
      triage: 'supervisor', triageUntil: new Date(Date.now() + 90 * 60_000),
      createdAt: new Date(Date.now() - 10 * 60_000), resolvedAt: null,
    } as any);
    // No owner post anywhere in the filing chat — engagement is NOT the trigger.
    expect(mockQuestions.messageRows).toHaveLength(0);
    const n = await surfaceTriagedOwnerQuestions();
    expect(n).toBe(1);
    const row: any = mockQuestions.rows.find((x: any) => x.id === 'oq_unanswerable');
    expect(row.triage).toBe('surfaced');
    await flush();
    expect(mockTelegramSendMessage).toHaveBeenCalledTimes(1);
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'owner_question_triage_early_released', meta: expect.objectContaining({ questionId: 'oq_unanswer', reason: 'owner_only' }) }),
    );
  });

  it('an ordinary triaged approval is NOT released by the owner-only arm (unchanged behaviour)', async () => {
    seedTriaged('oq_ordinary', Date.now() + 60 * 60_000);
    const n = await surfaceTriagedOwnerQuestions();
    expect(n).toBe(0);
    const row: any = mockQuestions.rows.find((x: any) => x.id === 'oq_ordinary');
    expect(row.triage).toBe('supervisor');
  });
});
