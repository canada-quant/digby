/**
 * stream-registration — Redis-backed stream-query pre-registration.
 *
 * Pins the cross-instance contract that replaced the in-memory Map (2026-08-16
 * prod 410 class): registrations round-trip through Redis, consume is
 * single-use via GETDEL, the per-identity pending cap reserves/releases
 * correctly, and the failure postures hold (store fails closed, the anti-abuse
 * counter fails open).
 */

const mockRedis = {
  set: jest.fn(),
  getDel: jest.fn(),
  incr: jest.fn(),
  decr: jest.fn(),
  expire: jest.fn(),
  exists: jest.fn(),
  del: jest.fn(),
};
jest.mock('../../config/redis', () => ({ __esModule: true, default: mockRedis }));

import {
  StreamQueryRegistration,
  STREAM_REG_TTL_SEC,
  MAX_PENDING_PER_IDENTITY,
  registrationIdentity,
  reserveRegistrationSlot,
  releaseRegistrationSlot,
  storeRegistration,
  consumeRegistration,
} from './stream-registration';

const REG: StreamQueryRegistration = {
  message: 'a'.repeat(2000),
  chatId: 'chat-1',
  mode: 'thinking',
  webSearch: true,
  uploadIds: ['u1'],
  userId: 'user-1',
};

beforeEach(() => {
  jest.clearAllMocks();
  mockRedis.set.mockResolvedValue('OK');
  mockRedis.expire.mockResolvedValue(true);
  mockRedis.exists.mockResolvedValue(1);
  mockRedis.decr.mockResolvedValue(0);
  mockRedis.del.mockResolvedValue(1);
});

describe('registrationIdentity', () => {
  it('uses userId for authed and ip: prefix for anonymous', () => {
    expect(registrationIdentity('user-1', '1.2.3.4')).toBe('user-1');
    expect(registrationIdentity(undefined, '1.2.3.4')).toBe('ip:1.2.3.4');
  });
});

describe('storeRegistration / consumeRegistration', () => {
  it('stores under the token with the shared TTL', async () => {
    await storeRegistration('tok-1', REG);
    expect(mockRedis.set).toHaveBeenCalledWith(
      'cm:streamreg:tok-1',
      JSON.stringify(REG),
      { EX: STREAM_REG_TTL_SEC }
    );
  });

  it('store propagates Redis failure (caller fails closed with 503)', async () => {
    mockRedis.set.mockRejectedValue(new Error('redis down'));
    await expect(storeRegistration('tok-1', REG)).rejects.toThrow('redis down');
  });

  it('consume round-trips the registration via GETDEL (single-use, cross-instance)', async () => {
    mockRedis.getDel.mockResolvedValue(JSON.stringify(REG));
    const got = await consumeRegistration('tok-1');
    expect(mockRedis.getDel).toHaveBeenCalledWith('cm:streamreg:tok-1');
    expect(got).toEqual(REG);
  });

  it('consume returns null for a missing/expired token (caller 410s)', async () => {
    mockRedis.getDel.mockResolvedValue(null);
    expect(await consumeRegistration('tok-gone')).toBeNull();
  });

  it('consume returns null on Redis failure and on unparseable payloads', async () => {
    mockRedis.getDel.mockRejectedValue(new Error('redis down'));
    expect(await consumeRegistration('tok-1')).toBeNull();
    mockRedis.getDel.mockResolvedValue('{not json');
    expect(await consumeRegistration('tok-1')).toBeNull();
  });
});

describe('reserveRegistrationSlot', () => {
  it('allows under the cap and sets the TTL on the first reservation only', async () => {
    mockRedis.incr.mockResolvedValue(1);
    expect(await reserveRegistrationSlot('user-1')).toBe(true);
    expect(mockRedis.expire).toHaveBeenCalledWith('cm:streamreg:count:user-1', STREAM_REG_TTL_SEC);

    mockRedis.expire.mockClear();
    mockRedis.incr.mockResolvedValue(2);
    expect(await reserveRegistrationSlot('user-1')).toBe(true);
    expect(mockRedis.expire).not.toHaveBeenCalled();
  });

  it('rejects over the cap and undoes its own increment', async () => {
    mockRedis.incr.mockResolvedValue(MAX_PENDING_PER_IDENTITY + 1);
    expect(await reserveRegistrationSlot('user-1')).toBe(false);
    expect(mockRedis.decr).toHaveBeenCalledWith('cm:streamreg:count:user-1');
  });

  it('fails OPEN when Redis is down (route rate limiter still guards)', async () => {
    mockRedis.incr.mockRejectedValue(new Error('redis down'));
    expect(await reserveRegistrationSlot('user-1')).toBe(true);
  });
});

describe('releaseRegistrationSlot', () => {
  it('decrements an existing counter', async () => {
    mockRedis.decr.mockResolvedValue(3);
    await releaseRegistrationSlot('user-1');
    expect(mockRedis.decr).toHaveBeenCalledWith('cm:streamreg:count:user-1');
    expect(mockRedis.del).not.toHaveBeenCalled();
  });

  it('deletes the key when the count reaches zero or goes negative (no immortal -1 keys)', async () => {
    mockRedis.decr.mockResolvedValue(0);
    await releaseRegistrationSlot('user-1');
    expect(mockRedis.del).toHaveBeenCalledWith('cm:streamreg:count:user-1');
  });

  it('no-ops when the counter key is already gone', async () => {
    mockRedis.exists.mockResolvedValue(0);
    await releaseRegistrationSlot('user-1');
    expect(mockRedis.decr).not.toHaveBeenCalled();
  });

  it('swallows Redis failures (best-effort)', async () => {
    mockRedis.exists.mockRejectedValue(new Error('redis down'));
    await expect(releaseRegistrationSlot('user-1')).resolves.toBeUndefined();
  });
});
