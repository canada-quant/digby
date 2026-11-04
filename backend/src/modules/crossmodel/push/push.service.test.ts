/**
 * Push service unit tests (M1 — todo 7cbf46a4).
 *
 * Pins the env-gating contract (module INERT without credentials — no throw,
 * no fetch), provider normalization, and the Expo send path (batching, token
 * formatting, dead-token cleanup). The DB layer is mocked; fetch is stubbed.
 */

jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    pushToken: {
      upsert: jest.fn().mockResolvedValue({}),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      findMany: jest.fn().mockResolvedValue([]),
    },
  },
}));
jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import {
  registerPushToken,
  unregisterPushToken,
  pushToUserDevices,
  pushTransportsConfigured,
  resetPushEnvCacheForTests,
} from './push.service';
import prisma from '../../../config/database';

const realFetch = global.fetch;

describe('push.service (M1)', () => {
  beforeEach(() => {
    resetPushEnvCacheForTests();
    jest.clearAllMocks();
    delete process.env.APNS_KEY_P8;
    delete process.env.APNS_KEY_ID;
    delete process.env.APNS_TEAM_ID;
    delete process.env.APNS_BUNDLE_ID;
    delete process.env.FCM_SERVICE_ACCOUNT_JSON;
    delete process.env.EXPO_ACCESS_TOKEN;
  });

  afterAll(() => {
    global.fetch = realFetch;
  });

  it('is INERT without credentials: transports report expo-only, sends never fetch', async () => {
    expect(pushTransportsConfigured()).toEqual({ expo: true, apns: false, fcm: false });
    const fetchSpy = jest.fn();
    global.fetch = fetchSpy as any;
    // No registered tokens → no fetch at all.
    await pushToUserDevices('u1', { title: 't', body: 'b' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('registers a token with provider normalization (unknown → expo)', async () => {
    await registerPushToken({ userId: 'u1', token: 'x'.repeat(40), provider: 'weird' as any });
    expect(prisma.pushToken.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId_token: { userId: 'u1', token: 'x'.repeat(40) } } })
    );
    const createArg = (prisma.pushToken.upsert as jest.Mock).mock.calls[0][0].create;
    expect(createArg.provider).toBe('expo');
  });

  it('unregisters idempotently (deleteMany)', async () => {
    await unregisterPushToken('u1', 'tok');
    expect(prisma.pushToken.deleteMany).toHaveBeenCalledWith({ where: { userId: 'u1', token: 'tok' } });
  });

  it('sends via Expo for expo-provider tokens, batching and formatting them', async () => {
    (prisma.pushToken.findMany as jest.Mock).mockResolvedValue([
      { token: 'abc', provider: 'expo' },
      { token: 'ExponentPushToken[def]', provider: 'expo' },
    ]);
    const calls: Array<{ url: string; body: any }> = [];
    global.fetch = (async (url: any, init: any) => {
      calls.push({ url: String(url), body: JSON.parse(init.body) });
      return { ok: true, status: 200, json: async () => ({ data: [{ status: 'ok' }, { status: 'ok' }] }) } as any;
    }) as any;
    await pushToUserDevices('u1', { title: 'Digby', body: 'done', chatId: 'c1' });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://exp.host/--/api/v2/push/send');
    expect(calls[0].body[0].to).toBe('ExponentPushToken[abc]');
    expect(calls[0].body[1].to).toBe('ExponentPushToken[def]'); // already-formed token untouched
    expect(calls[0].body[0].data.chatId).toBe('c1');
    expect(calls[0].body[0].data.digbyPush).toBe('1');
  });

  it('drops dead Expo tokens (DeviceNotKnown) so the table self-cleans', async () => {
    (prisma.pushToken.findMany as jest.Mock).mockResolvedValue([{ token: 'dead', provider: 'expo' }]);
    global.fetch = (async () => ({
      ok: true, status: 200,
      json: async () => ({ data: [{ status: 'error', message: 'DeviceNotKnown' }] }),
    })) as any;
    await pushToUserDevices('u1', { title: 't', body: 'b' });
    expect(prisma.pushToken.deleteMany).toHaveBeenCalledWith({ where: { token: 'dead' } });
  });

  it('skips apns/fcm tokens whose transports are not configured (no throw, no send)', async () => {
    (prisma.pushToken.findMany as jest.Mock).mockResolvedValue([
      { token: 'raw-apns-token', provider: 'apns' },
      { token: 'raw-fcm-token', provider: 'fcm' },
    ]);
    const fetchSpy = jest.fn();
    global.fetch = fetchSpy as any;
    await pushToUserDevices('u1', { title: 't', body: 'b' });
    expect(fetchSpy).not.toHaveBeenCalled(); // neither transport configured
  });

  it('never throws when a transport fetch fails (fire-and-forget contract)', async () => {
    (prisma.pushToken.findMany as jest.Mock).mockResolvedValue([{ token: 'abc', provider: 'expo' }]);
    global.fetch = (async () => { throw new Error('network down'); }) as any;
    await expect(pushToUserDevices('u1', { title: 't', body: 'b' })).resolves.toBeUndefined();
  });
});
