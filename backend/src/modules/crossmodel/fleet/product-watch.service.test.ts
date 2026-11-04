/**
 * Product watch (2026-09-18) — user-turn follow-up chips per level become a
 * [PRODUCT ALERT] wake when a level's zero-chip share crosses the line on
 * meaningful volume. Pure halves pinned; the wake seam injected.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
const redisStore = new Map<string, string>();
jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: {
    get: jest.fn(async (k: string) => redisStore.get(k) ?? null),
    set: jest.fn(async (k: string, v: string) => { redisStore.set(k, v); return 'OK'; }),
  },
}));
const mockPrisma: any = {
  crossModelChat: { findMany: jest.fn(async () => [{ id: 'fleet-sup-1', userId: 'owner-1' }]) },
  loopMetric: { findMany: jest.fn(async () => []) },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));
const mockRecordLoopMetric: jest.Mock = jest.fn();
jest.mock('../platform/loop-metrics.service', () => ({
  __esModule: true,
  ...jest.requireActual('../platform/loop-metrics.service'),
  recordLoopMetric: (...a: any[]) => mockRecordLoopMetric(...a),
}));

import {
  isUserTurnRow,
  summarizeFollowUps,
  classifyFollowUps,
  renderFollowUpAlert,
  sweepProductWatch,
  FOLLOWUP_MIN_USER_TURNS,
  FOLLOWUP_ZERO_SHARE,
} from './product-watch.service';

const NOW = new Date('2026-09-18T20:00:00.000Z');
const row = (mode: string, followUps: number | undefined, extra: any = {}) => ({ meta: { mode, ...(followUps === undefined ? {} : { followUps }), ...extra } });

beforeEach(() => {
  jest.clearAllMocks();
  redisStore.clear();
  delete process.env.PRODUCT_WATCH_DISABLED;
  mockPrisma.crossModelChat.findMany.mockResolvedValue([{ id: 'fleet-sup-1', userId: 'owner-1' }]);
  mockPrisma.loopMetric.findMany.mockResolvedValue([]);
});

describe('user-turn detection + summary', () => {
  it('machine runs and machine trigger kinds are not user turns; absent flags are', () => {
    expect(isUserTurnRow({ machine: true })).toBe(false);
    expect(isUserTurnRow({ machine: false, triggerKind: 'hook' })).toBe(false);
    expect(isUserTurnRow({ machine: false, triggerKind: 'schedule' })).toBe(false);
    expect(isUserTurnRow({ machine: false, triggerKind: 'user' })).toBe(true);
    expect(isUserTurnRow({ mode: 'thinking' })).toBe(true);
    expect(isUserTurnRow(null)).toBe(false);
  });

  it('summarizes per mode over USER turns only and skips rows that predate the followUps key', () => {
    const rows = [
      row('thinking', 3, { machine: false, triggerKind: 'user' }),
      row('thinking', 0, { machine: false, triggerKind: 'user' }),
      row('thinking', 0, { machine: false, triggerKind: 'user' }),
      row('thinking', 0, { machine: true, triggerKind: 'hook' }), // machine — excluded
      row('thinking', undefined, { machine: false }),             // pre-metric — skipped
      row('single_thinking', 2, { machine: false }),
    ];
    expect(summarizeFollowUps(rows)).toEqual([
      { mode: 'thinking', n: 3, zero: 2, share: 0.667 },
      { mode: 'single_thinking', n: 1, zero: 0, share: 0 },
    ]);
  });
});

describe('classification', () => {
  it('alerts only on meaningful volume AND a share at/over the line', () => {
    expect(classifyFollowUps([{ mode: 'thinking', n: 8, zero: 8, share: 1 }])).toEqual([]);            // 7-of-8 day: too few turns
    expect(classifyFollowUps([{ mode: 'thinking', n: 20, zero: 14, share: 0.7 }])).toEqual([]);        // under the line
    expect(classifyFollowUps([{ mode: 'thinking', n: 20, zero: 15, share: FOLLOWUP_ZERO_SHARE }])).toHaveLength(1);
    expect(classifyFollowUps([{ mode: 'single_thinking', n: FOLLOWUP_MIN_USER_TURNS, zero: 12, share: 1 }])).toHaveLength(1);
  });
});

describe('render', () => {
  it('names the level for the owner, keeps the mode id for the lane, carries the numbers, the code path, the playbook and the verify step', () => {
    const text = renderFollowUpAlert({ mode: 'thinking', n: 20, zero: 16, share: 0.8 }, NOW);
    expect(text).toContain('[PRODUCT ALERT — follow-ups missing at Level 2 (Thinking)] In the last 24 h, 16 of 20 user-turn answers');
    expect(text).toContain("(mode 'thinking')");
    expect(text).toContain('(80%;');
    expect(text).toContain('parseFollowUps');
    expect(text).toContain('dispatch_platform_task "Follow-up chips missing at Level 2 (Thinking) — 16/20 user turns in 24 h"');
    expect(text).toContain("get_fleet_telemetry view 'metrics' kind 'chat_platform_usage'");
    expect(text).toContain('Never ask the owner whether the UI looks right');
  });
});

describe('sweep', () => {
  const badDay = () => Array.from({ length: 20 }, (_, i) => row('thinking', i < 16 ? 0 : 3, { machine: false, triggerKind: 'user' }));

  it('raises one deduped wake per failing mode with a product_alert metric row', async () => {
    mockPrisma.loopMetric.findMany.mockResolvedValue([...badDay(), ...Array.from({ length: 30 }, () => row('thinking', 0, { machine: true, triggerKind: 'hook' }))]);
    const wake = jest.fn(async (_o: any) => ({ ok: true }));
    const first = await sweepProductWatch({ now: NOW, enqueueDirectWake: wake });
    expect(first.alerts).toBe(1);
    const call = (wake.mock.calls[0] as any[])[0];
    expect(call.targetChatId).toBe('fleet-sup-1');
    expect(String(call.prompt)).toContain('[PRODUCT ALERT — follow-ups missing at Level 2 (Thinking)] In the last 24 h, 16 of 20');
    expect(call.meta).toMatchObject({ origin: 'infra-watch', kind: 'followups', mode: 'thinking', n: 20, zero: 16 });
    expect(mockRecordLoopMetric).toHaveBeenCalledWith(expect.objectContaining({ kind: 'product_alert', sessionId: 'fleet-sup-1' }));
    const second = await sweepProductWatch({ now: NOW, enqueueDirectWake: wake });
    expect(second.alerts).toBe(0); // 24 h dedupe
  });

  it('is silent on a healthy day, on thin volume, and when disabled', async () => {
    const wake = jest.fn(async (_o: any) => ({ ok: true }));
    mockPrisma.loopMetric.findMany.mockResolvedValue(Array.from({ length: 20 }, (_, i) => row('thinking', i < 3 ? 0 : 3, { machine: false })));
    expect((await sweepProductWatch({ now: NOW, enqueueDirectWake: wake })).alerts).toBe(0);
    mockPrisma.loopMetric.findMany.mockResolvedValue(Array.from({ length: 8 }, () => row('thinking', 0, { machine: false })));
    expect((await sweepProductWatch({ now: NOW, enqueueDirectWake: wake })).alerts).toBe(0);
    process.env.PRODUCT_WATCH_DISABLED = '1';
    mockPrisma.loopMetric.findMany.mockResolvedValue(badDay());
    expect((await sweepProductWatch({ now: NOW, enqueueDirectWake: wake })).alerts).toBe(0);
    expect(wake).not.toHaveBeenCalled();
  });
});
