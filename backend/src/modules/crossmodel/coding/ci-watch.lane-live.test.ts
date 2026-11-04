/**
 * r3 interactions fix (2026-10-20) — ci-watch isLaneLive vs the round-3
 * BACKSTOP one-shots. A merge intent (MERGE_INTENT_BACKSTOP_MS, 6 h 15 min)
 * and an await_condition wait (2–6 h horizons) each leave a pending,
 * FUTURE-dated todo_wake on the lane for the whole wait. isLaneLive counted
 * every pending todo_wake, so an idle lane read live: route() deferred its
 * red-CI wake and hooks.service withheld the supervisor's ci_failed row for up
 * to the 2 h hold. A not-yet-due delayed wake (payload.notBefore in the
 * future) no longer counts; a due pending row and a delivering row still do.
 */
jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
// The pass-free probe reads hook_events through prisma: both the old count()
// and the new findMany() answer from the same in-memory rows.
let mockRows: Array<{ status: string; payload: any }> = [];
const matches = (where: any) => (r: { status: string }) => (where?.status?.in ?? []).includes(r.status);
jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    hookEvent: {
      count: jest.fn(async ({ where }: any) => mockRows.filter(matches(where)).length),
      findMany: jest.fn(async ({ where, take }: any) => mockRows.filter(matches(where)).slice(0, take ?? Infinity)),
    },
  },
}));
const mockBusy = jest.fn(async () => false);
jest.mock('../chat-agent/chat-busy', () => ({ __esModule: true, isChatBusy: () => mockBusy() }));
// hooks.service's pure stamp check (pinned in hooks.service.test.ts) — mirrored so this probe test stays light.
jest.mock('../platform/hooks.service', () => ({
  __esModule: true,
  TODO_WAKE_EVENT_TYPE: 'todo_wake',
  hookRowNotYetDue: (r: any, nowMs: number = Date.now()) => {
    const nb = r?.payload?.notBefore;
    if (nb === undefined || nb === null || nb === '') return false;
    const t = new Date(String(nb)).getTime();
    return Number.isFinite(t) && t > nowMs;
  },
}));

import { isLaneLive, LANE_LIVE_WAKE_SCAN } from './ci-watch.service';

const future = () => new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();
const past = () => new Date(Date.now() - 60_000).toISOString();

beforeEach(() => {
  mockRows = [];
  mockBusy.mockReset();
  mockBusy.mockResolvedValue(false);
});

describe('isLaneLive — a not-yet-due backstop is no wake queued for the lane', () => {
  it('a merge-intent / await_condition BACKSTOP alone (pending, notBefore hours out) reads NOT live', async () => {
    mockRows = [
      { status: 'pending', payload: { wakeKind: 'merge_intent_backstop', notBefore: future() } },
      { status: 'pending', payload: { wakeKind: 'condition_backstop', notBefore: future() } },
    ];
    expect(await isLaneLive('lane-1')).toBe(false);
  });

  it('a due pending wake (no notBefore, or one already past) and a delivering row still read live', async () => {
    mockRows = [{ status: 'pending', payload: { wakeKind: 'merge_intent_backstop', notBefore: future() } }, { status: 'pending', payload: { origin: 'ci-watch' } }];
    expect(await isLaneLive('lane-1')).toBe(true);
    mockRows = [{ status: 'pending', payload: { notBefore: past() } }];
    expect(await isLaneLive('lane-1')).toBe(true);
    mockRows = [{ status: 'delivering', payload: { notBefore: future() } }];
    expect(await isLaneLive('lane-1')).toBe(true);
  });

  it('a busy chat is live whatever the rows; a full scan page reads live (the bound never hides a due wake); no rows ⇒ idle', async () => {
    mockBusy.mockResolvedValue(true);
    expect(await isLaneLive('lane-1')).toBe(true);
    mockBusy.mockResolvedValue(false);
    expect(await isLaneLive('lane-1')).toBe(false);
    mockRows = Array.from({ length: LANE_LIVE_WAKE_SCAN }, () => ({ status: 'pending', payload: { notBefore: future() } }));
    expect(await isLaneLive('lane-1')).toBe(true);
  });
});
