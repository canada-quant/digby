/**
 * model-endpoints.controller — the `refresh` handler (model-list sync, ticket
 * 780cd7a4): ADMIN-gated like every sibling; the service is called with
 * exactly { id } from :params and its result is handed straight back; an
 * AppError goes to next(). The service itself (refreshEndpointModels) is
 * covered in model-endpoints.service.test.ts — mocked here the way the
 * sibling detect-controller test stubs its suite.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockService = {
  refreshEndpointModels: jest.fn(async (..._a: any[]): Promise<any> => ({ id: 'e1', label: 'llm-cql', models: [], sync: { added: [], retired: [], backButKeptRetired: [], unchanged: [] } })),
};
jest.mock('./model-endpoints.service', () => mockService);
jest.mock('./model-roles.service', () => ({}));
jest.mock('../platform/decision-gate-modes', () => ({}));
jest.mock('../platform/decision-gate-readiness', () => ({}));
jest.mock('../platform/decision-gate-backends', () => ({}));
jest.mock('./endpoint-verifier', () => ({ __esModule: true, verifyEndpointModel: jest.fn() }));

import controller from './model-endpoints.controller';

const mkReq = (role: string | undefined, params: Record<string, string> = { id: 'e1' }): any => ({
  user: role ? { id: 'u1', userId: 'u1', email: 'a@b.c', role } : undefined,
  params,
});
const mkRes = () => {
  const res: any = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
};
const next = jest.fn();

beforeEach(() => { jest.clearAllMocks(); });

describe('refresh handler (model-list sync, ticket 780cd7a4)', () => {
  it('403 for a non-admin / missing user — the service is never touched', async () => {
    for (const role of ['USER', undefined]) {
      const res = mkRes();
      await controller.refresh(mkReq(role), res, next);
      expect(res.status).toHaveBeenCalledWith(403);
      expect(mockService.refreshEndpointModels).not.toHaveBeenCalled();
    }
  });

  it('ADMIN: calls the service with the :id and returns its endpoint + sync diff', async () => {
    const res = mkRes();
    await controller.refresh(mkReq('ADMIN', { id: 'e9' }), res, next);
    expect(mockService.refreshEndpointModels).toHaveBeenCalledWith('e9');
    expect(res.json).toHaveBeenCalledWith({ success: true, data: expect.objectContaining({ id: 'e1', sync: expect.objectContaining({ added: [], retired: [] }) }) });
  });

  it('a service AppError (404 unknown endpoint / 502 dark server / 400 kill switch) goes to next() verbatim', async () => {
    const err = Object.assign(new Error('Model endpoint not found'), { statusCode: 404 });
    mockService.refreshEndpointModels.mockRejectedValueOnce(err);
    const res = mkRes();
    await controller.refresh(mkReq('ADMIN'), res, next);
    expect(next).toHaveBeenCalledWith(err);
    expect(res.json).not.toHaveBeenCalled();
  });
});
