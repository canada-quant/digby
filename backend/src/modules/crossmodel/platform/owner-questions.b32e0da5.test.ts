/**
 * Ticket b32e0da5 (2026-09-18) — REPLAY TEST: cross_project_scope guard
 * tuning (adversarial-review follow-up to the 661fb494 directive-scoping
 * guard, filed from the review of PR #855 / head f7b367fe — chat 1eef209f,
 * msg bcdb84e8).
 *
 * N1 (regex over-breadth): the shipped "should we|i also <verb>" alternation
 * included start/keep/use/follow/comply/adopt/apply — far beyond the
 * incident verbs (stop/pause). The reviewer's probe owner-routed 7/16
 * ORDINARY approvals, bypassing supervisor triage and cutting against the
 * "stop asking me — figure it out" standing directive. THE FIX pinned here:
 * the alternation is narrowed to the incident verbs stop/pause/halt —
 * benign-verb approvals triage again (both at the classifier and through
 * flagOwnerQuestion), while the stop-shaped generalization ask (the
 * mis-scope risk class — both 661fb494 incidents were stops) keeps failing
 * toward the human.
 *
 * N2 (coverage gap): the /i guard cannot class a BARE project name, so the
 * doctrine's own prescribed shape ("file ONE owner question whose first
 * sentence names BOTH projects") missed deterministically — the reviewer's
 * probes "…does that directive apply to CanLaw?", "Does it bind CanLaw
 * too?", "Should the inference project follow it?" all routed to fleet
 * triage. THE FIX pinned here: the roster-backed
 * questionNamesAnotherOwnerProject check at flag time — the filing project
 * already rides the question's [Project] prefix, so ONE more named sibling
 * project alongside a directive/applicability cue completes the pair and the
 * route upgrades to owner with the same cross_project_scope reason. A
 * sibling project named WITHOUT a cue still triages (no N1-style
 * over-breadth one layer down), and an empty/unreadable roster keeps the
 * regex route (best-effort).
 *
 * Scaffolding mirrors owner-questions.scope.661fb494.test.ts (same combined
 * database mock + boundary mocks), trimmed to what the flag path imports.
 */

import { createOwnerQuestionTable } from './owner-questions.testkit';

const mockQuestions = createOwnerQuestionTable();

// ── Combined Prisma mock ─────────────────────────────────────────────────────
const mockChatFindUnique: jest.Mock = jest.fn();
const mockTelegramLinkFindUnique: jest.Mock = jest.fn(async (): Promise<any> => null);
const mockProjectFindMany: jest.Mock = jest.fn();
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    ownerQuestion: mockQuestions.api,
    crossModelMessage: mockQuestions.crossModelMessage,
    crossModelChat: {
      ...mockQuestions.crossModelChat,
      findUnique: (...a: any[]) => mockChatFindUnique(...a),
      // The supervisor-ledger probe (appendAnswerToSupervisorLedger) looks the
      // owner's supervisor chat up with findFirst.
      findFirst: jest.fn(async () => ({ id: 'sup-chat' })),
    },
    telegramLink: { findUnique: (...a: any[]) => mockTelegramLinkFindUnique(...a) },
    crossModelProject: { findMany: (...a: any[]) => mockProjectFindMany(...a) },
  },
}));

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockFireScheduleTarget: jest.Mock = jest.fn(async () => ({ started: true }));
const mockDailyCapExceeded: jest.Mock = jest.fn(async (): Promise<number | null> => null);
const mockRefundDailyCapToken: jest.Mock = jest.fn(async () => {});
const mockArmRetry: jest.Mock = jest.fn(async () => ({ ok: true, scheduleId: 'sched-retry-1' }));
jest.mock('../coding/schedule.service', () => ({
  __esModule: true,
  fireScheduleTarget: (...a: any[]) => mockFireScheduleTarget(...a),
  dailyCapExceeded: (...a: any[]) => mockDailyCapExceeded(...a),
  refundDailyCapToken: (...a: any[]) => mockRefundDailyCapToken(...a),
  armOwnerAnswerRetrySchedule: (...a: any[]) => mockArmRetry(...a),
  emitScheduleDisabled: jest.fn(async () => undefined),
}));

const mockTelegramSendMessage: jest.Mock = jest.fn(async () => true);
jest.mock('../telegram/telegram.service', () => ({
  __esModule: true,
  isConfigured: () => true,
  sendMessage: (...a: any[]) => mockTelegramSendMessage(...a),
}));

// goals.service pulls env.ts at import (the answer path imports it
// dynamically) — mock the boundary exactly as the triage suite does.
jest.mock('./goals.service', () => ({
  __esModule: true,
  unblockOwnerGatedItems: jest.fn(async () => ({ unblockedTodos: 0, unblockedGoals: 0 })),
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
  classifyOwnerQuestionRouting,
  flagOwnerQuestion,
  questionNamesAnotherOwnerProject,
} from './owner-questions';

const CHAT = 'lane-chat-1';
const UID = 'u1';
const flush = () => new Promise((r) => setTimeout(r, 10)); // fire-and-forget DM / wake / metric

/** The owner's roster in the incident geometry (661fb494): the two projects
 *  the contamination crossed. */
const ROSTER = [
  { id: 'proj-inference', name: 'Inference' },
  { id: 'proj-canlaw', name: 'CanLaw' },
];

beforeEach(() => {
  jest.clearAllMocks();
  mockQuestions.reset();
  // Default filing chat: a non-supervisor lane chat in the INFERENCE project
  // (the N2 probe asks whether a directive binds the SIBLING, CanLaw).
  mockChatFindUnique.mockImplementation(async () => ({
    isSupervisor: false,
    projectId: 'proj-inference',
    title: 'Inference Lane',
    project: { name: 'Inference' },
  }));
  // The owner has a linked Telegram — the DM assertions exercise the real path.
  mockTelegramLinkFindUnique.mockImplementation(async () => ({ chatId: 'tg-owner-1' }));
  mockProjectFindMany.mockImplementation(async () => ROSTER);
});

// ── 1. N1 — the benign "should we also <verb>" approvals triage again ────────

describe('classifyOwnerQuestionRouting — N1 verb narrowing (b32e0da5)', () => {
  it.each([
    // The reviewer probe shapes that owner-routed 7/16 ordinary approvals.
    'Should we also start the migration now?',
    'Should we also keep the legacy flag for a week?',
    'Should we also use the new endpoint?',
    'Should we also follow the new logging convention?',
    'Should we also comply with the updated schema policy?',
    'Should we also adopt the shared queue?',
    'Should we also apply the patch to staging?',
    'Should I also start the second worker?',
  ])('benign-verb approval routes to supervisor triage: %s', (q) => {
    const r = classifyOwnerQuestionRouting(q);
    expect(r.route).toBe('supervisor');
    expect(r.reason).toBe('machine_lane_approval');
  });

  it.each([
    // The mis-scope risk class keeps failing toward the human — both 661fb494
    // incidents were stop-shaped generalizations.
    'Another project got told to stop; should we also stop our canaries?',
    'The owner paused the spark deploy — should we also pause ours?',
    'Should we also halt the rollout?',
    // The 661fb494 incident-2 replay shape must keep its owner route.
    'The owner posted "Stop all work on glm5.3 and all future goals and tasks" in the spark-cluster Supervisor chat. Should we also pause the inference GLM-5.3-Flash instance?',
  ])('INCIDENT VERB keeps routing to the owner: %s', (q) => {
    const r = classifyOwnerQuestionRouting(q);
    expect(r.route).toBe('owner');
    expect(r.reason).toBe('cross_project_scope');
  });
});

// ── 2. N2 — the roster-backed named-project scope check ──────────────────────

describe('questionNamesAnotherOwnerProject — N2 (b32e0da5)', () => {
  const fakePrisma = (chat: any, projects: any) => ({
    crossModelChat: { findUnique: async () => chat },
    crossModelProject: { findMany: async () => projects },
  });
  const FILING = { chatId: CHAT, userId: UID };
  const INFERENCE_CHAT = { projectId: 'proj-inference' };

  it.each([
    // The reviewer's missed probes (4/6 of the N2 battery), replayed.
    'The owner posted "stop nebius" here — does that directive apply to CanLaw?',
    'Does it bind CanLaw too?',
    'Does the nebius stay-off govern CanLaw?',
    'Is the SFT-2 pack covered by the CanLaw ruling?',
  ])('named sibling project + applicability cue → scope ask: %s', async (q) => {
    await expect(questionNamesAnotherOwnerProject(fakePrisma(INFERENCE_CHAT, ROSTER), FILING, q)).resolves.toBe(true);
  });

  it('REVIEWER PROBE: "Should the inference project follow it?" — filed FROM CanLaw, the sibling is Inference', async () => {
    await expect(
      questionNamesAnotherOwnerProject(
        fakePrisma({ projectId: 'proj-canlaw' }, ROSTER),
        FILING,
        'Should the inference project follow it?',
      ),
    ).resolves.toBe(true);
  });

  it('the FILING project never counts as its own sibling (the [Project] prefix names it already)', async () => {
    await expect(
      questionNamesAnotherOwnerProject(
        fakePrisma(INFERENCE_CHAT, ROSTER),
        FILING,
        '[Inference] Does that directive apply to the inference team?',
      ),
    ).resolves.toBe(false);
  });

  it('a sibling project named WITHOUT a cue word is not a scope ask', async () => {
    await expect(
      questionNamesAnotherOwnerProject(fakePrisma(INFERENCE_CHAT, ROSTER), FILING, 'The CanLaw build is red — should I rerun it?'),
    ).resolves.toBe(false);
  });

  it('no cue anywhere short-circuits BEFORE the roster read', async () => {
    const findMany = jest.fn(async () => ROSTER);
    const prisma = { crossModelChat: { findUnique: async () => INFERENCE_CHAT }, crossModelProject: { findMany } };
    await expect(questionNamesAnotherOwnerProject(prisma, FILING, 'CanLaw status?')).resolves.toBe(false);
    expect(findMany).not.toHaveBeenCalled();
  });

  it('an empty roster keeps the regex route (best-effort)', async () => {
    await expect(
      questionNamesAnotherOwnerProject(fakePrisma(INFERENCE_CHAT, []), FILING, 'does that directive apply to CanLaw?'),
    ).resolves.toBe(false);
  });

  it('an unreadable roster keeps the regex route (best-effort)', async () => {
    const throwing = {
      crossModelChat: { findUnique: async () => { throw new Error('db down'); } },
      crossModelProject: { findMany: async () => ROSTER },
    };
    await expect(
      questionNamesAnotherOwnerProject(throwing, FILING, 'does that directive apply to CanLaw?'),
    ).resolves.toBe(false);
  });

  it('tiny project names (<3 chars) are too collision-prone to match', async () => {
    const roster = [...ROSTER, { id: 'proj-ml', name: 'ML' }];
    await expect(
      questionNamesAnotherOwnerProject(fakePrisma(INFERENCE_CHAT, roster), FILING, 'does that directive apply to ML?'),
    ).resolves.toBe(false);
  });
});

// ── 3. The flag path end-to-end ──────────────────────────────────────────────

describe('flagOwnerQuestion — b32e0da5 end-to-end', () => {
  it('N2 REPLAY: "…does that directive apply to CanLaw?" is created WITHOUT a triage stamp, DMs the owner, never wakes triage', async () => {
    const r = await flagOwnerQuestion({
      chatId: CHAT,
      userId: UID,
      question: 'The owner posted "stop nebius" in this chat — does that directive apply to CanLaw?',
      machineTriggered: true,
    });
    expect(r.kind).toBe('created');
    await flush();
    const row = mockQuestions.rows[mockQuestions.rows.length - 1];
    expect(row.triage ?? null).not.toBe('supervisor');
    expect(mockTelegramSendMessage).toHaveBeenCalled();
    expect(mockEmitHookEventSafe).not.toHaveBeenCalled();
  });

  it('N2 REPLAY: "Does it bind CanLaw too?" bypasses triage', async () => {
    const r = await flagOwnerQuestion({
      chatId: CHAT,
      userId: UID,
      question: 'Does it bind CanLaw too?',
      machineTriggered: true,
    });
    expect(r.kind).toBe('created');
    await flush();
    const row = mockQuestions.rows[mockQuestions.rows.length - 1];
    expect(row.triage ?? null).not.toBe('supervisor');
    expect(mockTelegramSendMessage).toHaveBeenCalled();
    expect(mockEmitHookEventSafe).not.toHaveBeenCalled();
  });

  it('N2 REPLAY: "Should the inference project follow it?" (filed FROM CanLaw) bypasses triage', async () => {
    mockChatFindUnique.mockImplementation(async () => ({
      isSupervisor: false,
      projectId: 'proj-canlaw',
      title: 'CanLaw Path C',
      project: { name: 'CanLaw' },
    }));
    const r = await flagOwnerQuestion({
      chatId: CHAT,
      userId: UID,
      question: 'Should the inference project follow it?',
      machineTriggered: true,
    });
    expect(r.kind).toBe('created');
    await flush();
    const row = mockQuestions.rows[mockQuestions.rows.length - 1];
    expect(row.triage ?? null).not.toBe('supervisor');
    expect(mockTelegramSendMessage).toHaveBeenCalled();
    expect(mockEmitHookEventSafe).not.toHaveBeenCalled();
  });

  it('N1 REPLAY: a benign-verb "should we also" approval IS triaged again — the wake names the filing project', async () => {
    const r = await flagOwnerQuestion({
      chatId: CHAT,
      userId: UID,
      question: 'Should we also start the migration now?',
      machineTriggered: true,
    });
    expect(r.kind).toBe('created');
    await flush();
    const row = mockQuestions.rows[mockQuestions.rows.length - 1];
    expect(row.triage).toBe('supervisor');
    expect(mockTelegramSendMessage).not.toHaveBeenCalled();
    expect(mockEmitHookEventSafe).toHaveBeenCalledTimes(1);
    const [srcChat, eventType, summary] = mockEmitHookEventSafe.mock.calls[0];
    expect(srcChat).toBe(CHAT);
    expect(eventType).toBe('attention_needed');
    expect(summary).toContain('[OWNER-QUESTION TRIAGE');
    expect(summary).toContain('— filed from chat "Inference Lane" (project: Inference)');
  });

  it('INCIDENT CLASS HELD: "should we also stop …" still routes straight to the owner', async () => {
    const r = await flagOwnerQuestion({
      chatId: CHAT,
      userId: UID,
      question: 'Another project got told to stop; should we also stop our canaries?',
      machineTriggered: true,
    });
    expect(r.kind).toBe('created');
    await flush();
    const row = mockQuestions.rows[mockQuestions.rows.length - 1];
    expect(row.triage ?? null).not.toBe('supervisor');
    expect(mockTelegramSendMessage).toHaveBeenCalled();
    expect(mockEmitHookEventSafe).not.toHaveBeenCalled();
  });

  it('a sibling project named WITHOUT a cue still triages (no N1-style over-breadth one layer down)', async () => {
    const r = await flagOwnerQuestion({
      chatId: CHAT,
      userId: UID,
      question: 'The CanLaw build is red — should I rerun it?',
      machineTriggered: true,
    });
    expect(r.kind).toBe('created');
    await flush();
    const row = mockQuestions.rows[mockQuestions.rows.length - 1];
    expect(row.triage).toBe('supervisor');
    expect(mockTelegramSendMessage).not.toHaveBeenCalled();
    expect(mockEmitHookEventSafe).toHaveBeenCalledTimes(1);
  });

  it('an EMPTY roster keeps the regex route — the bare-name ask triages exactly as before the fix', async () => {
    mockProjectFindMany.mockImplementation(async () => []);
    const r = await flagOwnerQuestion({
      chatId: CHAT,
      userId: UID,
      question: 'does that directive apply to CanLaw?',
      machineTriggered: true,
    });
    expect(r.kind).toBe('created');
    await flush();
    const row = mockQuestions.rows[mockQuestions.rows.length - 1];
    expect(row.triage).toBe('supervisor');
    expect(mockEmitHookEventSafe).toHaveBeenCalledTimes(1);
  });
});
