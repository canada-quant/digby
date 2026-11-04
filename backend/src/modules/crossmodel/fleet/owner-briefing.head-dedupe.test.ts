/**
 * Owner briefing head dedupe + empty "nothing new" posts (owner 2026-10-21, Fleet Supervisor chat: "what are
 * these messages over and over again? if bug please fix"). The 03:40 and 07:43 fleet briefings each carried the
 * SAME "Decision gate (auto-rollout ON): set off by the registry lifecycle this week: …" paragraph (it describes the
 * whole week) and then "Nothing new on any project since the last update." Now a head line is carried only when it
 * changed since it was last POSTED in that chat or its repeat window passed (informational 24 h, alarm-class 12 h),
 * and a fleet briefing that is only the nothing-new line under an empty head is not posted.
 * BRIEFING_HEAD_DEDUPE_DISABLED=1 restores both.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockPrisma: any = {
  crossModelMessage: { create: jest.fn(async ({ data }: any) => ({ id: 'brief-row-1', ...data })) },
  systemSetting: { findUnique: jest.fn(async () => null) },
  crossModelChat: { findUnique: jest.fn(async () => ({ isProjectSupervisor: false })) },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

const redisStore = new Map<string, string>();
const mockRedisGet: jest.Mock = jest.fn(async (k: string) => redisStore.get(k) ?? null);
const mockRedisSet: jest.Mock = jest.fn(async (k: string, v: string, opts?: { NX?: boolean }) => {
  if (opts?.NX && redisStore.has(k)) return null;
  redisStore.set(k, v);
  return 'OK';
});
jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: { set: (...a: any[]) => mockRedisSet(...a), get: (...a: any[]) => mockRedisGet(...a) },
}));
jest.mock('../../../utils/utility-llm', () => ({ __esModule: true, utilityChat: jest.fn(async () => '') }));
jest.mock('../platform/supervisor-state.service', () => ({ __esModule: true, getFleetLivenessSnapshot: jest.fn(async () => null) }));
jest.mock('../platform/loop-metrics.service', () => ({ __esModule: true, listActiveSeatLatches: jest.fn(async () => []), recordLoopMetric: jest.fn(async () => undefined) }));

// The prod lines of the complaint (shortened).
const ROLLOUT = 'Decision gate (auto-rollout ON): set off by the registry lifecycle this week: self_audit (past its review date with the bar unmet), wake_triage (non-converging — 357 errors in 1280 labels; re-pose ticket 14c26769).';
const AUDIT = 'Live-chat audit (last 24 h): 13 human turns · replay agreement 100 % · no regressions';
const mockRolloutLine: jest.Mock = jest.fn(async (): Promise<string | null> => ROLLOUT);
const mockAuditLine: jest.Mock = jest.fn(async (): Promise<string | null> => AUDIT);
const mockRefusalLine: jest.Mock = jest.fn(async (): Promise<string | null> => null);
jest.mock('../platform/decision-gate-rollout', () => ({ __esModule: true, rolloutBriefingLine: (...a: any[]) => mockRolloutLine(...a) }));
jest.mock('../platform/live-chat-audit', () => ({ __esModule: true, liveChatAuditBriefingLine: (...a: any[]) => mockAuditLine(...a) }));
jest.mock('../coding/renew-refusal-surface', () => ({ __esModule: true, renewRefusalLine: (...a: any[]) => mockRefusalLine(...a) }));

import { generateOwnerBriefing, briefingLockKey, NOTHING_NEW_LINE } from './owner-briefing.service';
import logger from '../../../utils/logger';

const CHAT = 'fleet-sup';
const HEAD_KEY = `fleet:briefing:head:${CHAT}`;
const MOVE = '**canlegal-bench** — gold rebuild: 3 of 8 shards done → shards 4-8 queued → about a day\nWAKE: actions taken.';
const MOVE_LINE = 'canlegal-bench: gold rebuild: 3 of 8 shards done → shards 4-8 queued → about a day';
const NO_OP = 'WAKE: no-op — nothing moved on any project (msg 7fc2d4e7)';
const T0 = Date.parse('2026-10-21T10:40:00Z');
const HOUR = 60 * 60_000;

/** One briefing attempt `hoursLater` after T0 — the 90-min lock is treated as expired between attempts. */
async function briefAt(hoursLater: number, noteContent: string): Promise<boolean> {
  jest.spyOn(Date, 'now').mockReturnValue(T0 + hoursLater * HOUR);
  redisStore.delete(briefingLockKey(CHAT));
  mockPrisma.crossModelMessage.create.mockClear();
  return generateOwnerBriefing({ chatId: CHAT, userId: 'u-admin', noteContent });
}
const posted = (): string | null => mockPrisma.crossModelMessage.create.mock.calls[0]?.[0].data.content ?? null;

beforeEach(() => {
  jest.clearAllMocks();
  redisStore.clear();
  mockRolloutLine.mockImplementation(async () => ROLLOUT);
  mockAuditLine.mockImplementation(async () => AUDIT);
  mockRefusalLine.mockImplementation(async () => null);
  mockRedisGet.mockImplementation(async (k: string) => redisStore.get(k) ?? null);
  mockPrisma.crossModelMessage.create.mockImplementation(async ({ data }: any) => ({ id: 'brief-row-1', ...data }));
});
afterEach(() => {
  jest.restoreAllMocks();
  delete process.env.BRIEFING_HEAD_DEDUPE_DISABLED;
});

describe('REPLAY 2026-10-21 — the same head paragraph and a bare "Nothing new" every briefing', () => {
  it('03:40 carries the rollout + audit lines over the nothing-new line; 07:43 (same lines, no movement) posts nothing', async () => {
    expect(await briefAt(0, NO_OP)).toBe(true);
    expect(posted()).toBe(`${ROLLOUT}\n${AUDIT}\n\n${NOTHING_NEW_LINE}`);
    expect(await briefAt(4, NO_OP)).toBe(false);
    expect(posted()).toBeNull();
    expect(redisStore.has(briefingLockKey(CHAT))).toBe(true); // the lock holds the window, as for any skip
    expect((logger.info as jest.Mock).mock.calls.some((c) => String(c[0]).includes('nothing new on any project and no new head line (repeats held back: rollout, audit)'))).toBe(true);
  });

  it('a briefing WITH movement inside the window posts the body without the repeated lines (the info log names them)', async () => {
    expect(await briefAt(0, MOVE)).toBe(true);
    expect(posted()).toBe(`${ROLLOUT}\n${AUDIT}\n\n${MOVE_LINE}`);
    expect(await briefAt(2, MOVE)).toBe(true);
    expect(posted()).toBe(MOVE_LINE);
    expect(logger.info).toHaveBeenLastCalledWith(expect.stringContaining('headSuppressed=rollout,audit'), expect.objectContaining({ headSuppressed: ['rollout', 'audit'] }));
  });

  it('a no-op wake under a NEW head line still posts — the line, with the nothing-new line under it', async () => {
    mockAuditLine.mockImplementation(async () => null);
    expect(await briefAt(0, NO_OP)).toBe(true);
    expect(posted()).toBe(`${ROLLOUT}\n\n${NOTHING_NEW_LINE}`);
    mockAuditLine.mockImplementation(async () => AUDIT);
    expect(await briefAt(3, NO_OP)).toBe(true);
    expect(posted()).toBe(`${AUDIT}\n\n${NOTHING_NEW_LINE}`);
  });
});

describe('what counts as new', () => {
  it('a CHANGED line is carried at once; the unchanged one stays out', async () => {
    await briefAt(0, MOVE);
    const audit2 = 'Live-chat audit (last 24 h): 15 human turns · replay agreement 96 % · 1 regression ticket';
    mockAuditLine.mockImplementation(async () => audit2);
    expect(await briefAt(2, MOVE)).toBe(true);
    expect(posted()).toBe(`${audit2}\n\n${MOVE_LINE}`);
  });

  it('a relative age ticking ("3 h ago" → "5 h ago") is not a change', async () => {
    mockAuditLine.mockImplementation(async () => null);
    mockRolloutLine.mockImplementation(async () => 'Decision gate (auto-rollout ON): 1 purpose moved to act by the rollout automaton this week (wake_triage 3 h ago).');
    await briefAt(0, MOVE);
    mockRolloutLine.mockImplementation(async () => 'Decision gate (auto-rollout ON): 1 purpose moved to act by the rollout automaton this week (wake_triage 5 h ago).');
    expect(await briefAt(2, MOVE)).toBe(true);
    expect(posted()).toBe(MOVE_LINE);
  });

  it('an informational line repeats after 24 h, an alarm-class line (refused renewals) after 12 h', async () => {
    mockAuditLine.mockImplementation(async () => null);
    const refusal = 'Self-armed watches stopped (last 24 h, harness-measured): 2 — canlaw watch';
    mockRefusalLine.mockImplementation(async () => refusal);
    expect(await briefAt(0, MOVE)).toBe(true);
    expect(posted()).toBe(`${refusal}\n${ROLLOUT}\n\n${MOVE_LINE}`);
    expect(await briefAt(6, MOVE)).toBe(true);
    expect(posted()).toBe(MOVE_LINE);
    expect(await briefAt(12, MOVE)).toBe(true);
    expect(posted()).toBe(`${refusal}\n\n${MOVE_LINE}`);
    expect(await briefAt(24, MOVE)).toBe(true);
    expect(posted()).toBe(`${refusal}\n${ROLLOUT}\n\n${MOVE_LINE}`);
  });

  it('a changed alarm-class line is never held back, even an hour later', async () => {
    mockRefusalLine.mockImplementation(async () => 'Self-armed watches stopped (last 24 h, harness-measured): 1 — canlaw watch');
    await briefAt(0, MOVE);
    mockRefusalLine.mockImplementation(async () => 'Self-armed watches stopped (last 24 h, harness-measured): 2 — canlaw watch, spark watch');
    expect(await briefAt(1.6, NO_OP)).toBe(true);
    expect(posted()).toBe(`Self-armed watches stopped (last 24 h, harness-measured): 2 — canlaw watch, spark watch\n\n${NOTHING_NEW_LINE}`);
  });
});

describe('fail toward delivery', () => {
  it('the memory is stamped only after the row lands — a failed post carries the lines again next time', async () => {
    mockPrisma.crossModelMessage.create.mockImplementationOnce(async () => { throw new Error('db down'); });
    jest.spyOn(Date, 'now').mockReturnValue(T0);
    expect(await generateOwnerBriefing({ chatId: CHAT, userId: 'u-admin', noteContent: MOVE })).toBe(false);
    expect(redisStore.has(HEAD_KEY)).toBe(false);
    expect(await briefAt(2, MOVE)).toBe(true);
    expect(posted()).toBe(`${ROLLOUT}\n${AUDIT}\n\n${MOVE_LINE}`);
  });

  it('an unreadable memory carries every line (today\'s head), and a nothing-new body then still posts under it', async () => {
    mockRedisGet.mockImplementation(async () => { throw new Error('redis down'); });
    expect(await briefAt(0, NO_OP)).toBe(true);
    expect(await briefAt(2, NO_OP)).toBe(true);
    expect(posted()).toBe(`${ROLLOUT}\n${AUDIT}\n\n${NOTHING_NEW_LINE}`);
  });
});

describe('kill switch BRIEFING_HEAD_DEDUPE_DISABLED=1', () => {
  it('every briefing carries every line, a no-op posts the nothing-new line, and the head memory is never read or written', async () => {
    process.env.BRIEFING_HEAD_DEDUPE_DISABLED = '1';
    expect(await briefAt(0, NO_OP)).toBe(true);
    expect(await briefAt(4, NO_OP)).toBe(true);
    expect(posted()).toBe(`${ROLLOUT}\n${AUDIT}\n\n${NOTHING_NEW_LINE}`);
    mockAuditLine.mockImplementation(async () => null);
    mockRolloutLine.mockImplementation(async () => null);
    expect(await briefAt(6, NO_OP)).toBe(true);
    expect(posted()).toBe(NOTHING_NEW_LINE);
    expect(mockRedisGet.mock.calls.some(([k]) => k === HEAD_KEY)).toBe(false);
    expect(mockRedisSet.mock.calls.some(([k]) => k === HEAD_KEY)).toBe(false);
  });
});
