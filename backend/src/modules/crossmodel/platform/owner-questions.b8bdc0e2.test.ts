/**
 * Ticket b8bdc0e2 — "Fleet supervisor ask dedupe gap: near-duplicate owner
 * cards 3 min apart for one stale approval" (2026-09-09).
 *
 * The mishap: the fleet supervisor flagged owner questions at 12:50 AND 12:53
 * about the SAME waiting run_command approval on one lane chat. The N8
 * machine-ask preflight topic dedupe (normalized-token Jaccard ≥ 0.6) should
 * have suppressed the second but did not: the re-ask kept the ENTITY (the
 * lane's chat title) and reworded everything else, landing just under the 0.6
 * bar. These tests replay that shape against representative reconstructions of
 * the two asks (the incident questions themselves were free-text; the numbers
 * below are computed from the texts in this file, not asserted from memory):
 *
 *   - the replay pair's plain Jaccard is < TOPIC_OVERLAP_THRESHOLD (proves the
 *     old bar missed them — the bug), AND
 *   - questionTopicDedupeMatch now calls them the same topic via the
 *     entity-anchored path (a contiguous shared token run with at least one
 *     distinctive token, over a 0.25 Jaccard floor), AND
 *   - the service-level preflight returns 'deduped' for the second ask
 *     (pre-fix it returned 'created' — the second owner card).
 *
 * Guards pin the precision side: an anchor with near-zero other overlap does
 * NOT dedupe (floor), a single shared distinctive token does NOT dedupe
 * (run minimum), a genuinely different machine ask still creates, and a
 * non-machine (user-turn-anchored) re-ask still creates — the anchor path
 * stays inside the machine-only N8 preflight.
 *
 * Also covers the ticket's secondary observation (19:03): two resume-schedule
 * asks for two different schedules on ONE lane share the lane anchor and
 * dedupe into a single owner card (the "compose" behavior).
 */

import { createOwnerQuestionTable } from './owner-questions.testkit';

const mockQuestions = createOwnerQuestionTable();
const mockTelegramLinkFindUnique: jest.Mock = jest.fn(async () => null);
const mockChatFindUnique: jest.Mock = jest.fn(async (): Promise<any> => undefined);
const mockChatFindFirst: jest.Mock = jest.fn(async (): Promise<any> => null);
const mockChatFindMany: jest.Mock = jest.fn(async (): Promise<any[]> => []);
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    ownerQuestion: mockQuestions.api,
    crossModelMessage: mockQuestions.crossModelMessage,
    crossModelChat: {
      ...mockQuestions.crossModelChat,
      findUnique: (...a: any[]) => mockChatFindUnique(...a),
      findFirst: (...a: any[]) => mockChatFindFirst(...a),
      findMany: (...a: any[]) => mockChatFindMany(...a),
    },
    telegramLink: { findUnique: (...a: any[]) => mockTelegramLinkFindUnique(...a) },
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
}));

const mockTelegramSendMessage: jest.Mock = jest.fn(async () => true);
jest.mock('../telegram/telegram.service', () => ({
  __esModule: true,
  isConfigured: () => true,
  sendMessage: (...a: any[]) => mockTelegramSendMessage(...a),
}));

const mockAppendAnswered: jest.Mock = jest.fn(async () => {});
jest.mock('./supervisor-state.service', () => ({
  __esModule: true,
  appendAnsweredQuestionDirective: (...a: any[]) => mockAppendAnswered(...a),
}));

import {
  flagOwnerQuestion,
  questionTopicOverlap,
  questionTopicAnchorRun,
  questionTopicDedupeMatch,
  TOPIC_OVERLAP_THRESHOLD,
  TOPIC_ANCHOR_RUN_MIN,
  TOPIC_ANCHOR_OVERLAP_FLOOR,
} from './owner-questions';

beforeEach(() => {
  mockQuestions.reset();
  mockFireScheduleTarget.mockReset().mockResolvedValue({ started: true });
  mockDailyCapExceeded.mockReset().mockResolvedValue(null);
  mockRefundDailyCapToken.mockReset().mockResolvedValue(undefined);
  mockArmRetry.mockReset().mockResolvedValue({ ok: true, scheduleId: 'sched-retry-1' });
  mockTelegramSendMessage.mockReset().mockResolvedValue(true);
  mockTelegramLinkFindUnique.mockReset().mockResolvedValue(null);
  mockChatFindUnique.mockReset().mockResolvedValue(undefined);
  mockChatFindFirst.mockReset().mockResolvedValue(null);
  mockChatFindMany.mockReset().mockResolvedValue([]);
  mockAppendAnswered.mockReset().mockResolvedValue(undefined);
});

const flag = (over: Partial<Parameters<typeof flagOwnerQuestion>[0]> = {}) =>
  flagOwnerQuestion({ chatId: 'chat-1', userId: 'u1', question: 'Which region should we deploy to?', ...over });

// ── Representative reconstructions of the 12:50 / 12:53 incident asks ────────
// Both name the same lane chat title and the same waiting approval; everything
// else is reworded — the exact shape the ticket describes.
const INCIDENT_Q1 =
  "Chat 'Conversation Update: Learning Company Follow-Up' is waiting on a run_command approval — the staged restart command needs your Confirm. Approve it?";
const INCIDENT_Q2 =
  "The run_command approval on chat 'Conversation Update: Learning Company Follow-Up' is still pending your decision — approve or let it lapse?";

describe('ticket b8bdc0e2 — entity-anchored topic dedupe (unit)', () => {
  it('the incident pair lands UNDER the old 0.6 Jaccard bar (the bug), but the anchor path matches it', () => {
    const overlap = questionTopicOverlap(INCIDENT_Q1, INCIDENT_Q2);
    // The gap: reworded-everything-else puts the pair just under the old bar.
    expect(overlap).toBeLessThan(TOPIC_OVERLAP_THRESHOLD);
    // …but they share the contiguous entity run "chat conversation update
    // learning company follow up is" — with distinctive tokens — far over the
    // run minimum and the floor.
    expect(questionTopicAnchorRun(INCIDENT_Q1, INCIDENT_Q2)).toBeGreaterThanOrEqual(TOPIC_ANCHOR_RUN_MIN);
    expect(overlap).toBeGreaterThanOrEqual(TOPIC_ANCHOR_OVERLAP_FLOOR);
    expect(questionTopicDedupeMatch(INCIDENT_Q1, INCIDENT_Q2)).toBe(true);
  });

  it('the plain Jaccard path still matches high-overlap pairs (unchanged behavior)', () => {
    expect(
      questionTopicDedupeMatch(
        'Which serving engine should the bench use?',
        'Which serving engine should the bench use tonight?',
      ),
    ).toBe(true);
  });

  it('FLOOR GUARD: an anchored run with near-zero other overlap does NOT dedupe', () => {
    const a = 'learning company follow up needs your decision on the staged restart';
    const b = 'learning company follow up alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo mike november';
    // Shares only the 4-token entity run: Jaccard ≈ 4/24 ≈ 0.167 < 0.25.
    expect(questionTopicAnchorRun(a, b)).toBeGreaterThanOrEqual(TOPIC_ANCHOR_RUN_MIN);
    expect(questionTopicOverlap(a, b)).toBeLessThan(TOPIC_ANCHOR_OVERLAP_FLOOR);
    expect(questionTopicDedupeMatch(a, b)).toBe(false);
  });

  it('RUN-MIN GUARD: a single shared distinctive token (no contiguous run) does NOT dedupe', () => {
    const a = 'deploy the kubernetes cluster to ca central tonight';
    const b = 'kubernetes cost report for ca central region';
    // Jaccard = 3/12 = 0.25 (floor met); shared tokens are kubernetes + "ca
    // central" — but "ca central" has no distinctive token and "kubernetes"
    // stands alone: no ANCHORED run of ≥2.
    expect(questionTopicOverlap(a, b)).toBeGreaterThanOrEqual(TOPIC_ANCHOR_OVERLAP_FLOOR);
    expect(questionTopicAnchorRun(a, b)).toBeLessThan(TOPIC_ANCHOR_RUN_MIN);
    expect(questionTopicDedupeMatch(a, b)).toBe(false);
  });

  it('NO-ANCHOR GUARD: common short words never anchor, however long the run', () => {
    const a = 'waiting for the owner to approve the restart plan';
    const b = 'waiting for the owner on the budget question';
    // Shared run "waiting for the owner" is 4 tokens but none is distinctive.
    expect(questionTopicAnchorRun(a, b)).toBe(0);
    expect(questionTopicDedupeMatch(a, b)).toBe(false);
  });

  it('ids and digit-bearing tokens anchor (ticket/schedule/run references)', () => {
    const a = 'resume the dead watcher schedule 7c7e5134 on the nightly lane';
    const b = 'schedule 7c7e5134 is still dead — resume it now';
    expect(questionTopicAnchorRun(a, b)).toBeGreaterThanOrEqual(1);
  });
});

describe('ticket b8bdc0e2 — machine-ask preflight (service replay)', () => {
  it('REPLAY: the second (reworded) machine ask about the same waiting approval dedupes onto the first card', async () => {
    const first = await flag({ question: INCIDENT_Q1, machineTriggered: true });
    if (first.kind !== 'created') throw new Error(`expected created, got ${JSON.stringify(first)}`);
    const second = await flag({ question: INCIDENT_Q2, machineTriggered: true });
    // Pre-fix this was 'created' — the duplicate 12:53 owner card.
    expect(second.kind).toBe('deduped');
    if (second.kind === 'deduped') expect(second.question.id).toBe(first.question.id);
    expect(mockQuestions.rows).toHaveLength(1);
  });

  it('COMPOSE (ticket secondary observation): two resume-schedule asks for two schedules on ONE lane dedupe into one card', async () => {
    const first = await flag({
      question: "Lane 'Nightly Self-Improvement Engineer' has a dead schedule — resume the PR watcher schedule 7c7e5134?",
      machineTriggered: true,
    });
    if (first.kind !== 'created') throw new Error(`expected created, got ${JSON.stringify(first)}`);
    const second = await flag({
      question: "Also on lane 'Nightly Self-Improvement Engineer' — resume the daily digest schedule fa5be938?",
      machineTriggered: true,
    });
    expect(second.kind).toBe('deduped');
    if (second.kind === 'deduped') expect(second.question.id).toBe(first.question.id);
    expect(mockQuestions.rows).toHaveLength(1);
  });

  it('GUARD: a genuinely different machine ask on the same chat still creates', async () => {
    const first = await flag({ question: INCIDENT_Q1, machineTriggered: true });
    if (first.kind !== 'created') throw new Error('expected created');
    await expect(
      flag({ question: 'Which region should we deploy to?', machineTriggered: true }),
    ).resolves.toMatchObject({ kind: 'created' });
    expect(mockQuestions.rows).toHaveLength(2);
  });

  it('MACHINE-ONLY: the same reworded re-ask from a user-turn-anchored run still creates (N8 stays machine-scoped)', async () => {
    const first = await flag({ question: INCIDENT_Q1, machineTriggered: true });
    if (first.kind !== 'created') throw new Error('expected created');
    await expect(flag({ question: INCIDENT_Q2 })).resolves.toMatchObject({ kind: 'created' });
    expect(mockQuestions.rows).toHaveLength(2);
  });
});
