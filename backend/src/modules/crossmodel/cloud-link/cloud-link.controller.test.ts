/**
 * cloud-link.controller — Digby Edge (Phase 3) ADMIN gating for the edge-side
 * link REST surface. Every handler must 403 a non-admin (or missing) user
 * BEFORE touching the service, and let an ADMIN through. Service is mocked.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockService = {
  getCloudLinkStatus: jest.fn(async () => ({ state: 'unlinked', cloudUrl: null, instanceName: null, connected: false, lastError: null })),
  pairToCloud: jest.fn(async () => ({ state: 'linked', cloudUrl: 'https://digby.example.com', instanceName: 'x', connected: false, lastError: null })),
  unlinkFromCloud: jest.fn(async () => ({ state: 'unlinked', cloudUrl: null, instanceName: null, connected: false, lastError: null })),
  receiveCloudMessage: jest.fn(async (): Promise<any> => ({ delivery: 'started' })),
  startEdgePairingCode: jest.fn(async () => ({ code: 'ABCD-2345', expiresAt: new Date() })),
};
jest.mock('./cloud-link.service', () => mockService);

import controller from './cloud-link.controller';

const mkReq = (role?: string): any => ({
  user: role ? { id: 'u1', userId: 'u1', email: 'a@b.c', role } : undefined,
  body: { cloudUrl: 'https://digby.example.com', pairingCode: 'ABCD-2345' },
});

const mkRes = () => {
  const res: any = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
};

const next = jest.fn();

beforeEach(() => jest.clearAllMocks());

const handlers = ['status', 'pair', 'unlink', 'startCode'] as const;

describe('admin gating', () => {
  for (const h of handlers) {
    it(`${h}: 403 for a non-admin, service never called`, async () => {
      const res = mkRes();
      await (controller as any)[h](mkReq('USER'), res, next);
      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith({ error: 'Forbidden: admin access required' });
      expect(next).not.toHaveBeenCalled();
      for (const fn of Object.values(mockService)) expect(fn).not.toHaveBeenCalled();
    });

    it(`${h}: 403 when req.user is missing entirely`, async () => {
      const res = mkRes();
      await (controller as any)[h](mkReq(undefined), res, next);
      expect(res.status).toHaveBeenCalledWith(403);
      for (const fn of Object.values(mockService)) expect(fn).not.toHaveBeenCalled();
    });
  }
});

describe('ADMIN passes through', () => {
  it('status returns the sanitized envelope', async () => {
    const res = mkRes();
    await controller.status(mkReq('ADMIN'), res, next);
    expect(mockService.getCloudLinkStatus).toHaveBeenCalledTimes(1);
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      data: { state: 'unlinked', cloudUrl: null, instanceName: null, connected: false, lastError: null },
    });
  });

  it('pair passes the body + caller id to the service', async () => {
    const res = mkRes();
    await controller.pair(mkReq('ADMIN'), res, next);
    expect(mockService.pairToCloud).toHaveBeenCalledWith('u1', 'https://digby.example.com', 'ABCD-2345', undefined);
    expect(res.json).toHaveBeenCalledWith({ success: true, data: expect.objectContaining({ state: 'linked' }) });
  });

  it('startCode mints the device code + starts the pending dial', async () => {
    const res = mkRes();
    await controller.startCode(mkReq('ADMIN'), res, next);
    expect(mockService.startEdgePairingCode).toHaveBeenCalledWith('u1', 'https://digby.example.com', undefined);
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      data: { code: 'ABCD-2345', expiresAt: expect.any(Date) },
    });
  });

  it('service errors flow to next(error)', async () => {
    const err = new Error('boom');
    mockService.unlinkFromCloud.mockRejectedValueOnce(err);
    const res = mkRes();
    await controller.unlink(mkReq('ADMIN'), res, next);
    expect(next).toHaveBeenCalledWith(err);
  });
});

describe('receive (Phase 5 cloud→edge messaging)', () => {
  const mkReceiveReq = (role?: string, relayHeader?: string): any => ({
    user: role ? { id: 'u1', userId: 'u1', email: 'a@b.c', role } : undefined,
    headers: relayHeader ? { 'x-cloud-relay': relayHeader } : {},
    body: { chatId: 'c1', message: 'hello edge', sourceLabel: 'cloud instance "home-lab"', depth: 1 },
  });

  it('403s a non-admin BEFORE any header check or service call', async () => {
    const res = mkRes();
    await controller.receive(mkReceiveReq('USER', '1'), res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: 'Forbidden: admin access required' });
    expect(mockService.receiveCloudMessage).not.toHaveBeenCalled();
  });

  it('403s when x-cloud-relay is missing or not "1" — even for an ADMIN (uniform)', async () => {
    for (const header of [undefined, '0', 'yes']) {
      const res = mkRes();
      await controller.receive(mkReceiveReq('ADMIN', header), res, next);
      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith({ error: 'Forbidden: cloud-relay tunnel only' });
    }
    expect(mockService.receiveCloudMessage).not.toHaveBeenCalled();
  });

  it('ADMIN + x-cloud-relay: 1 → service call with the body, { success, data } envelope', async () => {
    mockService.receiveCloudMessage.mockResolvedValueOnce({ delivery: 'queued', position: 2 });
    const res = mkRes();
    await controller.receive(mkReceiveReq('ADMIN', '1'), res, next);
    expect(mockService.receiveCloudMessage).toHaveBeenCalledWith({
      chatId: 'c1', message: 'hello edge', sourceLabel: 'cloud instance "home-lab"', depth: 1,
    });
    expect(res.json).toHaveBeenCalledWith({ success: true, data: { delivery: 'queued', position: 2 } });
    expect(next).not.toHaveBeenCalled();
  });

  it('service errors (409 unlinked / 400 depth) flow to next(error)', async () => {
    const err = new Error('This instance is not linked to a cloud');
    mockService.receiveCloudMessage.mockRejectedValueOnce(err);
    const res = mkRes();
    await controller.receive(mkReceiveReq('ADMIN', '1'), res, next);
    expect(next).toHaveBeenCalledWith(err);
  });
});
