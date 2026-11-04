/**
 * instances.controller — Digby Edge (Phase 3) ADMIN gating + uniform errors.
 * Every management handler must 403 a non-admin (or missing) user BEFORE
 * touching the service; revoke 404s for missing/foreign ids; the OPEN
 * pair/complete + self-revoke answer any failure with the same 401. Service
 * layer is mocked.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockService = {
  startPairing: jest.fn(async () => ({ code: 'ABCD-2345', expiresAt: new Date() })),
  completePairing: jest.fn(async (): Promise<{ instanceId: string; token: string } | null> => ({ instanceId: 'i1', token: 'dgi_abc' })),
  listInstances: jest.fn(async () => []),
  revokeInstance: jest.fn(async () => true),
  revokeByToken: jest.fn(async () => true),
  redeemPairingCode: jest.fn(async (): Promise<{ pending: true; expiresAt: Date } | null> => ({ pending: true, expiresAt: new Date() })),
};
jest.mock('./instances.service', () => mockService);

import controller from './instances.controller';

const mkReq = (role?: string, extra: any = {}): any => ({
  user: role ? { id: 'u1', userId: 'u1', email: 'a@b.c', role } : undefined,
  params: { id: 'i1' },
  body: { code: 'ABCD-2345', instanceName: 'edge', protocolVersion: 1 },
  query: {},
  headers: {},
  ...extra,
});

const mkRes = () => {
  const res: any = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
};

const next = jest.fn();

beforeEach(() => jest.clearAllMocks());

const adminHandlers = ['startPair', 'list', 'revoke', 'redeemPair'] as const;

describe('admin gating', () => {
  for (const h of adminHandlers) {
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
  it('startPair returns the code + expiresAt', async () => {
    const res = mkRes();
    await controller.startPair(mkReq('ADMIN'), res, next);
    expect(mockService.startPairing).toHaveBeenCalledWith('u1');
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      data: { code: 'ABCD-2345', expiresAt: expect.any(Date) },
    });
  });

  it('list returns the sanitized envelope', async () => {
    const res = mkRes();
    await controller.list(mkReq('ADMIN'), res, next);
    expect(mockService.listInstances).toHaveBeenCalledWith('u1', { includeRevoked: false });
    expect(res.json).toHaveBeenCalledWith({ success: true, data: { instances: [] } });
  });

  it('list passes includeRevoked through only for ?includeRevoked=1/true', async () => {
    await controller.list(mkReq('ADMIN', { query: { includeRevoked: '1' } }), mkRes(), next);
    expect(mockService.listInstances).toHaveBeenCalledWith('u1', { includeRevoked: true });
    await controller.list(mkReq('ADMIN', { query: { includeRevoked: 'true' } }), mkRes(), next);
    expect(mockService.listInstances).toHaveBeenCalledWith('u1', { includeRevoked: true });
    await controller.list(mkReq('ADMIN', { query: { includeRevoked: 'yes' } }), mkRes(), next);
    expect(mockService.listInstances).toHaveBeenCalledWith('u1', { includeRevoked: false });
  });

  it('redeemPair parks the claim and returns pending + expiresAt', async () => {
    const res = mkRes();
    await controller.redeemPair(mkReq('ADMIN'), res, next);
    expect(mockService.redeemPairingCode).toHaveBeenCalledWith('ABCD-2345', 'u1');
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      data: { pending: true, expiresAt: expect.any(Date) },
    });
  });

  it('redeemPair 400s a malformed code', async () => {
    mockService.redeemPairingCode.mockResolvedValueOnce(null);
    const res = mkRes();
    await controller.redeemPair(mkReq('ADMIN', { body: { code: 'nope' } }), res, next);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('revoke 404s a missing or foreign id (no cross-owner enumeration)', async () => {
    mockService.revokeInstance.mockResolvedValueOnce(false);
    const res = mkRes();
    await controller.revoke(mkReq('ADMIN'), res, next);
    expect(mockService.revokeInstance).toHaveBeenCalledWith('i1', 'u1');
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('service errors flow to next(error)', async () => {
    const err = new Error('boom');
    mockService.listInstances.mockRejectedValueOnce(err);
    const res = mkRes();
    await controller.list(mkReq('ADMIN'), res, next);
    expect(next).toHaveBeenCalledWith(err);
  });
});

describe('open endpoints (no JWT — self-authenticating)', () => {
  it('completePair returns instanceId + token on success', async () => {
    const res = mkRes();
    await controller.completePair(mkReq(undefined), res, next);
    expect(mockService.completePairing).toHaveBeenCalledWith('ABCD-2345', 'edge', 1);
    expect(res.json).toHaveBeenCalledWith({ success: true, data: { instanceId: 'i1', token: 'dgi_abc' } });
  });

  it('completePair answers ANY bad code with the same 401', async () => {
    mockService.completePairing.mockResolvedValueOnce(null);
    const res = mkRes();
    await controller.completePair(mkReq(undefined), res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ success: false, error: 'Invalid or expired pairing code' });
  });

  it('selfRevoke revokes with the bearer token, uniform 401 otherwise', async () => {
    const res = mkRes();
    await controller.selfRevoke(mkReq(undefined, { headers: { authorization: 'Bearer dgi_x' } }), res, next);
    expect(mockService.revokeByToken).toHaveBeenCalledWith('dgi_x');
    expect(res.json).toHaveBeenCalledWith({ success: true });

    mockService.revokeByToken.mockResolvedValueOnce(false);
    const res2 = mkRes();
    await controller.selfRevoke(mkReq(undefined, { headers: { authorization: 'Bearer dgi_bad' } }), res2, next);
    expect(res2.status).toHaveBeenCalledWith(401);

    const res3 = mkRes();
    await controller.selfRevoke(mkReq(undefined), res3, next);
    expect(res3.status).toHaveBeenCalledWith(401);
  });
});
