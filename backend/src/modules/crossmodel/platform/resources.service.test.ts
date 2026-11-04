/**
 * Watched resources + training artifacts (remediation P7 S1b) — CRUD
 * validation, the pure alarm predicate, and the watchdog sweep (6h NX dedupe,
 * Telegram + supervisor-note delivery, kill switch).
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockResourceCreate = jest.fn(async (...args: any[]) => ({ id: 'wr-1', createdAt: new Date(), updatedAt: new Date(), ...args[0]?.data }));
const mockResourceCount = jest.fn(async (..._a: any[]) => 0);
const mockResourceFindFirst = jest.fn(async (..._a: any[]): Promise<any> => null);
const mockResourceFindMany = jest.fn(async (..._a: any[]): Promise<any[]> => []);
const mockResourceUpdate = jest.fn(async (...args: any[]) => ({ id: args[0]?.where?.id, label: 'gpu box', maxUnobservedMinutes: 240, createdAt: new Date(), ...args[0]?.data }));
const mockResourceDelete = jest.fn(async (..._a: any[]) => ({}));
const mockArtifactCreate = jest.fn(async (...args: any[]) => ({ id: 'ta-1', createdAt: new Date(), ...args[0]?.data }));
const mockArtifactCount = jest.fn(async (..._a: any[]) => 0);
const mockArtifactFindFirst = jest.fn(async (..._a: any[]): Promise<any> => null);
const mockArtifactFindMany = jest.fn(async (..._a: any[]): Promise<any[]> => []);
const mockArtifactUpdate = jest.fn(async (...args: any[]) => ({ id: args[0]?.where?.id, kind: 'checkpoint', label: 'ckpt', uri: 's3://b/ckpt', createdAt: new Date(), ...args[0]?.data }));
const mockTelegramLinkFindUnique = jest.fn(async (..._a: any[]): Promise<any> => null);
const mockChatFindFirst = jest.fn(async (..._a: any[]): Promise<any> => null);
const mockMsgCreate = jest.fn(async (..._a: any[]) => ({}));

jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    watchedResource: {
      create: (...a: any[]) => mockResourceCreate(...a),
      count: (...a: any[]) => mockResourceCount(...a),
      findFirst: (...a: any[]) => mockResourceFindFirst(...a),
      findMany: (...a: any[]) => mockResourceFindMany(...a),
      update: (...a: any[]) => mockResourceUpdate(...a),
      delete: (...a: any[]) => mockResourceDelete(...a),
    },
    trainingArtifact: {
      create: (...a: any[]) => mockArtifactCreate(...a),
      count: (...a: any[]) => mockArtifactCount(...a),
      findFirst: (...a: any[]) => mockArtifactFindFirst(...a),
      findMany: (...a: any[]) => mockArtifactFindMany(...a),
      update: (...a: any[]) => mockArtifactUpdate(...a),
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
const mockTelegramConfigured = jest.fn(() => true);
jest.mock('../telegram/telegram.service', () => ({
  __esModule: true,
  isConfigured: () => mockTelegramConfigured(),
  sendMessage: (...a: any[]) => mockTelegramSend(...a),
}));

import {
  registerWatchedResource, observeResource, registerArtifact, verifyArtifactDurable,
  resourceAlarmReason, resourceAlarmText, sweepWatchedResources,
  RESOURCE_ALARM_KEY, MAX_UNOBSERVED_MINUTES_DEFAULT,
} from './resources.service';

const NOW = new Date('2026-09-09T12:00:00Z');
const minAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);

beforeEach(() => {
  jest.clearAllMocks();
  mockResourceCount.mockResolvedValue(0);
  mockArtifactCount.mockResolvedValue(0);
  mockResourceFindMany.mockResolvedValue([]);
  mockArtifactFindMany.mockResolvedValue([]);
  mockResourceFindFirst.mockResolvedValue(null);
  mockArtifactFindFirst.mockResolvedValue(null);
  mockRedisSet.mockResolvedValue('OK');
  mockTelegramConfigured.mockReturnValue(true);
  mockTelegramLinkFindUnique.mockResolvedValue(null);
  mockChatFindFirst.mockResolvedValue(null);
  delete process.env.WATCHED_RESOURCE_SWEEP_DISABLED;
});

describe('register/observe/verify', () => {
  it('registration validates the label, defaults+clamps maxUnobservedMinutes, and stamps the first observation', async () => {
    await expect(registerWatchedResource('u1', { label: '' })).rejects.toThrow(/label is required/);
    const r = await registerWatchedResource('u1', { label: 'brev 8xH100', usdPerHour: 24 });
    expect(r.maxUnobservedMinutes).toBe(MAX_UNOBSERVED_MINUTES_DEFAULT);
    expect(r.lastObservedAt).toBeTruthy(); // registration IS the first observation
    const clamped = await registerWatchedResource('u1', { label: 'x', maxUnobservedMinutes: 1 });
    expect(clamped.maxUnobservedMinutes).toBe(5);
  });

  it('observeResource resolves id → prefix → label and stamps lastObservedAt', async () => {
    mockResourceFindFirst.mockResolvedValue({ id: 'wr-abcdef12', label: 'gpu box', maxUnobservedMinutes: 240, createdAt: NOW });
    const r = await observeResource('u1', 'wr-abcdef12');
    expect(mockResourceUpdate).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'wr-abcdef12' },
      data: expect.objectContaining({ lastObservedAt: expect.any(Date) }),
    }));
    expect(r.lastObservedAt).toBeTruthy();
  });

  it('observeResource on an unknown ref throws an actionable error', async () => {
    await expect(observeResource('u1', 'nope')).rejects.toThrow(/register_watched_resource first/);
  });

  it('registerArtifact validates kind + uri; verifyArtifactDurable stamps durableVerifiedAt', async () => {
    await expect(registerArtifact('u1', { kind: 'weights', label: 'x', uri: 's3://b/x' })).rejects.toThrow(/kind must be one of/);
    await expect(registerArtifact('u1', { kind: 'checkpoint', label: 'x', uri: '' })).rejects.toThrow(/uri is required/);
    const a = await registerArtifact('u1', { kind: 'checkpoint', label: 'epoch 3', uri: 's3://b/ckpt-3', bytes: 123 });
    expect(a.kind).toBe('checkpoint');
    mockArtifactFindFirst.mockResolvedValue({ id: 'ta-1', uri: 's3://b/ckpt-3' });
    const v = await verifyArtifactDurable('u1', 'ta-1');
    expect(mockArtifactUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: { durableVerifiedAt: expect.any(Date) },
    }));
    expect(v.durableVerifiedAt).toBeTruthy();
  });
});

describe('resourceAlarmReason (pure)', () => {
  const base = { maxUnobservedMinutes: 60, lastObservedAt: null as Date | null, createdAt: minAgo(30), reservationEndsAt: null as Date | null };

  it('fresh observation + far reservation ⇒ quiet', () => {
    expect(resourceAlarmReason({ ...base, lastObservedAt: minAgo(10) }, NOW)).toBeNull();
  });

  it('unobserved past maxUnobservedMinutes alarms (createdAt seeds the clock when never observed)', () => {
    expect(resourceAlarmReason({ ...base, lastObservedAt: minAgo(61) }, NOW)).toBe('unobserved');
    expect(resourceAlarmReason({ ...base, createdAt: minAgo(90) }, NOW)).toBe('unobserved');
  });

  it('a reservation ending within 24h alarms even when freshly observed', () => {
    expect(resourceAlarmReason(
      { ...base, lastObservedAt: minAgo(1), reservationEndsAt: new Date(NOW.getTime() + 3 * 3600_000) }, NOW,
    )).toBe('reservation_ending');
  });

  it('the alarm text carries the burn math and the verify-durable doctrine', () => {
    const text = resourceAlarmText(
      {
        id: 'wr-1', projectId: null, label: 'brev 8xH100', usdPerHour: 24, reservationEndsAt: null,
        maxUnobservedMinutes: 60, lastObservedAt: minAgo(120).toISOString(), notes: null, createdAt: minAgo(300).toISOString(),
      },
      'unobserved', NOW,
    );
    expect(text).toContain('UNOBSERVED for ~2h');
    expect(text).toContain('$24/h');
    expect(text).toContain('verify_durable');
    expect(text).toContain('once per 6h');
  });
});

describe('sweepWatchedResources', () => {
  const overdue = {
    id: 'wr-1', userId: 'u1', projectId: null, label: 'gpu box', usdPerHour: 10,
    reservationEndsAt: null, maxUnobservedMinutes: 60, lastObservedAt: minAgo(120),
    notes: null, createdAt: minAgo(600), updatedAt: minAgo(120),
  };

  it('alarms an overdue resource ONCE per 6h: Telegram DM + supervisor note', async () => {
    mockResourceFindMany.mockResolvedValue([overdue]);
    mockTelegramLinkFindUnique.mockResolvedValue({ chatId: 'tg-1' });
    mockChatFindFirst.mockResolvedValue({ id: 'sup-1' });
    const emitted = await sweepWatchedResources({ now: NOW });
    expect(emitted).toBe(1);
    expect(mockRedisSet).toHaveBeenCalledWith(RESOURCE_ALARM_KEY('wr-1'), NOW.toISOString(), { NX: true, EX: 6 * 3600 });
    expect(mockTelegramSend).toHaveBeenCalledWith('tg-1', expect.stringContaining('gpu box'));
    expect(mockMsgCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        chatId: 'sup-1', role: 'assistant',
        metadata: { origin: 'attention-watchdog', kind: 'watched-resource' },
      }),
    }));
  });

  it('the NX loss (already alarmed in the window) emits nothing', async () => {
    mockResourceFindMany.mockResolvedValue([overdue]);
    mockRedisSet.mockResolvedValue(null);
    expect(await sweepWatchedResources({ now: NOW })).toBe(0);
    expect(mockTelegramSend).not.toHaveBeenCalled();
    expect(mockMsgCreate).not.toHaveBeenCalled();
  });

  it('no Telegram link ⇒ the supervisor note says it is the only delivery', async () => {
    mockResourceFindMany.mockResolvedValue([overdue]);
    mockChatFindFirst.mockResolvedValue({ id: 'sup-1' });
    await sweepWatchedResources({ now: NOW });
    const content = mockMsgCreate.mock.calls[0][0].data.content as string;
    expect(content).toContain('only delivery');
  });

  it('kill switch WATCHED_RESOURCE_SWEEP_DISABLED=1 stops everything', async () => {
    process.env.WATCHED_RESOURCE_SWEEP_DISABLED = '1';
    mockResourceFindMany.mockResolvedValue([overdue]);
    expect(await sweepWatchedResources({ now: NOW })).toBe(0);
    expect(mockResourceFindMany).not.toHaveBeenCalled();
  });

  it('a quiet fleet emits nothing (fresh resources never alarm)', async () => {
    mockResourceFindMany.mockResolvedValue([{ ...overdue, lastObservedAt: minAgo(5) }]);
    expect(await sweepWatchedResources({ now: NOW })).toBe(0);
  });
});
