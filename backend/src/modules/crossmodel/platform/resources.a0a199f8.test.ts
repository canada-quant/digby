/**
 * Ticket a0a199f8 (enhancement, 2026-09-14) — REPLAY: the watched-resource
 * registry had NO unregister/retire tool, so stale registrations ghost-alarmed
 * the owner after teardown. Concrete instance: AWS capacity block
 * cr-056fd55496e1beb3f accumulated FOUR duplicate registrations across lanes
 * (canonical b18d1c00, adopted orphan b53b93f4, plus fd18aeef and 47682830);
 * after the reservation ended (2026-09-14T11:30Z) every one of them would have
 * kept alarming the owner every 6h forever — the alarm-trust failure class of
 * ticket 25c5a7c3.
 *
 * Fix (ticket options a + c; b — silent auto-retire — deliberately NOT taken):
 *   (a) release_watched_resource — a lane/supervisor-callable retire tool
 *       (resource-tools.ts → resources.service.releaseWatchedResource), and
 *   (c) the watchdog NEVER alarms for a resource PAST its reservationEndsAt
 *       (resources.service.resourceAlarmReason).
 * Stale rows stay listed in get_account_overview → watchedResources until a
 * lane retires them explicitly — no silent row deletion.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockResourceFindFirst = jest.fn(async (..._a: any[]): Promise<any> => null);
const mockResourceFindMany = jest.fn(async (..._a: any[]): Promise<any[]> => []);
const mockResourceDelete = jest.fn(async (..._a: any[]) => ({}));
const mockTelegramLinkFindUnique = jest.fn(async (..._a: any[]): Promise<any> => null);
const mockChatFindFirst = jest.fn(async (..._a: any[]): Promise<any> => null);
const mockMsgCreate = jest.fn(async (..._a: any[]) => ({}));

jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    watchedResource: {
      findFirst: (...a: any[]) => mockResourceFindFirst(...a),
      findMany: (...a: any[]) => mockResourceFindMany(...a),
      delete: (...a: any[]) => mockResourceDelete(...a),
    },
    telegramLink: { findUnique: (...a: any[]) => mockTelegramLinkFindUnique(...a) },
    crossModelChat: { findFirst: (...a: any[]) => mockChatFindFirst(...a) },
    crossModelMessage: { create: (...a: any[]) => mockMsgCreate(...a) },
  },
}));

const mockRedisSet = jest.fn(async (..._a: any[]): Promise<any> => 'OK');
jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: { set: (...a: any[]) => mockRedisSet(...a) },
}));

const mockTelegramSend = jest.fn(async (..._a: any[]) => true);
jest.mock('../telegram/telegram.service', () => ({
  __esModule: true,
  isConfigured: () => true,
  sendMessage: (...a: any[]) => mockTelegramSend(...a),
}));

import { resourceAlarmReason, releaseWatchedResource, sweepWatchedResources } from './resources.service';

// The ticket's real timeline: the cr-056fd55496e1beb3f capacity-block
// reservation ended 2026-09-14T11:30Z; the ghost alarms would have fired from
// the next sweep after that.
const RESERVATION_END = new Date('2026-09-14T11:30:00Z');
const AFTER_END = new Date('2026-09-14T12:00:00Z'); // 30 min past the end
const BEFORE_END = new Date('2026-09-14T11:00:00Z'); // 30 min before the end

/** One of the FOUR duplicate registrations the ticket names. */
function staleDuplicate(idPrefix: string) {
  return {
    id: `${idPrefix}-0000-4000-8000-000000000000`,
    userId: 'u1', projectId: null,
    label: `AWS capacity block cr-056fd55496e1beb3f (${idPrefix})`,
    usdPerHour: 24, reservationEndsAt: RESERVATION_END,
    maxUnobservedMinutes: 240, lastObservedAt: new Date('2026-09-14T06:00:00Z'), // 6h stale — 'unobserved' would ALSO have fired
    notes: null, createdAt: new Date('2026-09-13T20:00:00Z'), updatedAt: new Date('2026-09-14T06:00:00Z'),
  };
}
const STALE_IDS = ['b18d1c00', 'b53b93f4', 'fd18aeef', '47682830'];

beforeEach(() => {
  jest.clearAllMocks();
  mockResourceFindMany.mockResolvedValue([]);
  mockResourceFindFirst.mockResolvedValue(null);
  mockRedisSet.mockResolvedValue('OK');
  mockTelegramLinkFindUnique.mockResolvedValue(null);
  mockChatFindFirst.mockResolvedValue(null);
  delete process.env.WATCHED_RESOURCE_SWEEP_DISABLED;
});

describe('resourceAlarmReason — the past-reservation-end suppression (option c)', () => {
  const base = { maxUnobservedMinutes: 60, lastObservedAt: null as Date | null, createdAt: new Date('2026-09-14T00:00:00Z') };

  it('a resource PAST its reservation end alarms NO MORE — even when long unobserved', () => {
    // The exact ghost: unobserved for 10h AND the reservation ended 30m ago.
    expect(resourceAlarmReason(
      { ...base, lastObservedAt: new Date('2026-09-14T02:00:00Z'), reservationEndsAt: RESERVATION_END }, AFTER_END,
    )).toBeNull();
    // Ended exactly now counts as past.
    expect(resourceAlarmReason(
      { ...base, lastObservedAt: new Date('2026-09-14T02:00:00Z'), reservationEndsAt: AFTER_END }, AFTER_END,
    )).toBeNull();
  });

  it('a reservation still in the FUTURE keeps its alarms (no overreach)', () => {
    // 30 min before the end: inside the 24h warn window ⇒ reservation_ending.
    expect(resourceAlarmReason(
      { ...base, lastObservedAt: new Date('2026-09-14T10:59:00Z'), reservationEndsAt: RESERVATION_END }, BEFORE_END,
    )).toBe('reservation_ending');
    // No reservation at all + stale ⇒ unobserved, exactly as before.
    expect(resourceAlarmReason(
      { ...base, lastObservedAt: new Date('2026-09-14T02:00:00Z'), reservationEndsAt: null }, AFTER_END,
    )).toBe('unobserved');
  });
});

describe('sweepWatchedResources — the ghost-alarm replay', () => {
  it('ALL FOUR stale cr-056fd55496e1beb3f duplicates past reservation end emit ZERO alarms', async () => {
    mockResourceFindMany.mockResolvedValue(STALE_IDS.map(staleDuplicate));
    mockTelegramLinkFindUnique.mockResolvedValue({ chatId: 'tg-1' });
    mockChatFindFirst.mockResolvedValue({ id: 'sup-1' });
    const emitted = await sweepWatchedResources({ now: AFTER_END });
    expect(emitted).toBe(0);
    expect(mockRedisSet).not.toHaveBeenCalled(); // no 6h dedupe claim is even staked
    expect(mockTelegramSend).not.toHaveBeenCalled(); // no Telegram ghost
    expect(mockMsgCreate).not.toHaveBeenCalled(); // no supervisor-thread ghost
  });

  it('a LIVE unobserved resource in the same fleet still alarms (suppression does not overreach)', async () => {
    const live = {
      ...staleDuplicate('c0ffee00'),
      label: 'brev 8xH100 still-training box',
      reservationEndsAt: null, // no reservation ⇒ suppression never applies
    };
    mockResourceFindMany.mockResolvedValue([...STALE_IDS.map(staleDuplicate), live]);
    mockTelegramLinkFindUnique.mockResolvedValue({ chatId: 'tg-1' });
    mockChatFindFirst.mockResolvedValue({ id: 'sup-1' });
    const emitted = await sweepWatchedResources({ now: AFTER_END });
    expect(emitted).toBe(1);
    const text = mockTelegramSend.mock.calls[0][1] as string;
    expect(text).toContain('brev 8xH100 still-training box');
    expect(text).not.toContain('cr-056fd55496e1beb3f');
  });
});

describe('releaseWatchedResource (option a) — the missing retire surface', () => {
  it('resolves (exact id AND ≥8-char prefix), deletes, and returns the released view', async () => {
    const row = staleDuplicate('b53b93f4');
    // Exact-id path.
    mockResourceFindFirst.mockResolvedValueOnce(row);
    const released = await releaseWatchedResource('u1', row.id, 'duplicate of b18d1c00');
    expect(mockResourceDelete).toHaveBeenCalledWith({ where: { id: row.id } });
    expect(released?.id).toBe(row.id);
    expect(released?.label).toContain('cr-056fd55496e1beb3f');
    // Prefix path (what a lane actually types from an alarm/overview listing).
    mockResourceFindFirst.mockResolvedValueOnce(null); // exact miss…
    mockResourceFindMany.mockResolvedValueOnce([row]); // …prefix hit
    const releasedByPrefix = await releaseWatchedResource('u1', 'fd18aeef');
    expect(releasedByPrefix?.id).toBe(row.id);
  });

  it('unknown ref ⇒ null and NO delete (the tool renders the 251e9329 rich refusal)', async () => {
    expect(await releaseWatchedResource('u1', 'deadbeef')).toBeNull();
    expect(mockResourceDelete).not.toHaveBeenCalled();
  });

  it('a delete FAILURE propagates (no silent success while the row keeps alarming)', async () => {
    mockResourceFindFirst.mockResolvedValueOnce(staleDuplicate('47682830'));
    mockResourceDelete.mockRejectedValueOnce(new Error('db down'));
    await expect(releaseWatchedResource('u1', '47682830-0000-4000-8000-000000000000')).rejects.toThrow('db down');
  });
});
