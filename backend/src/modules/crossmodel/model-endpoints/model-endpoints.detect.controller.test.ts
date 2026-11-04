/**
 * model-endpoints.controller — the `detect` handler (capability detection,
 * 2026-09-27): ADMIN-gated like every sibling, 404 for an unknown endpoint,
 * 400 for a :modelId that is not on the row, and the suite is called with
 * exactly { modelId, capabilities } (undefined when absent). The suite itself
 * (capability-detect.ts) is mocked — it is a dynamic import in the handler, so
 * its boundary is stubbed the way the verify battery is in the sibling test.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockService = {
  getEndpoint: jest.fn(async (..._a: any[]): Promise<any> => null),
};
jest.mock('./model-endpoints.service', () => mockService);
jest.mock('./model-roles.service', () => ({}));
jest.mock('../platform/decision-gate-modes', () => ({}));
jest.mock('../platform/decision-gate-readiness', () => ({}));
jest.mock('../platform/decision-gate-backends', () => ({}));
jest.mock('./endpoint-verifier', () => ({ __esModule: true, verifyEndpointModel: jest.fn() }));

const mockDetect = jest.fn(async (..._a: any[]): Promise<any> => ({ endpointId: 'e1', label: 'cql-litellm', detectedAt: 't', models: [] }));
jest.mock('./capability-detect', () => ({
  __esModule: true,
  detectEndpointCapabilities: (...a: any[]) => mockDetect(...a),
}));

import controller from './model-endpoints.controller';

const mkReq = (role: string | undefined, params: Record<string, string> = { id: 'e1' }, body: any = {}): any => ({
  user: role ? { id: 'u1', userId: 'u1', email: 'a@b.c', role } : undefined,
  params,
  body,
});
const mkRes = () => {
  const res: any = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
};
const next = jest.fn();
const endpoint = { id: 'e1', label: 'cql-litellm', models: [{ id: 'api-openai-gpt-6-astra' }, { id: 'agx-laya' }] };

beforeEach(() => { jest.clearAllMocks(); mockService.getEndpoint.mockResolvedValue(endpoint); });

describe('detect handler', () => {
  it('403 for a non-admin / missing user — nothing touched', async () => {
    for (const role of ['USER', undefined]) {
      const res = mkRes();
      await controller.detect(mkReq(role), res, next);
      expect(res.status).toHaveBeenCalledWith(403);
      expect(mockService.getEndpoint).not.toHaveBeenCalled();
      expect(mockDetect).not.toHaveBeenCalled();
    }
  });

  it('404 for an unknown endpoint', async () => {
    mockService.getEndpoint.mockResolvedValueOnce(null);
    const res = mkRes();
    await controller.detect(mkReq('ADMIN'), res, next);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(mockDetect).not.toHaveBeenCalled();
  });

  it('400 when :modelId is not one of the endpoint models', async () => {
    const res = mkRes();
    await controller.detect(mkReq('ADMIN', { id: 'e1', modelId: 'ghost' }), res, next);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: expect.stringContaining('not registered on endpoint "cql-litellm"') });
    expect(mockDetect).not.toHaveBeenCalled();
  });

  it('whole endpoint: calls the suite with modelId undefined and no capability filter', async () => {
    const res = mkRes();
    await controller.detect(mkReq('ADMIN'), res, next);
    expect(mockDetect).toHaveBeenCalledWith('e1', { modelId: undefined, capabilities: undefined });
    expect(res.json).toHaveBeenCalledWith({ success: true, data: expect.objectContaining({ endpointId: 'e1', label: 'cql-litellm' }) });
  });

  it('one model + a capability filter: both forwarded; non-string names coerced', async () => {
    const res = mkRes();
    await controller.detect(mkReq('ADMIN', { id: 'e1', modelId: 'agx-laya' }, { capabilities: ['typed_decisions', 7] }), res, next);
    expect(mockDetect).toHaveBeenCalledWith('e1', { modelId: 'agx-laya', capabilities: ['typed_decisions', '7'] });
    expect(res.json).toHaveBeenCalledWith({ success: true, data: expect.any(Object) });
  });

  it('a suite error (AppError) goes to next()', async () => {
    const err = Object.assign(new Error('Model endpoint not found'), { statusCode: 404 });
    mockDetect.mockRejectedValueOnce(err);
    const res = mkRes();
    await controller.detect(mkReq('ADMIN'), res, next);
    expect(next).toHaveBeenCalledWith(err);
    expect(res.json).not.toHaveBeenCalled();
  });
});
