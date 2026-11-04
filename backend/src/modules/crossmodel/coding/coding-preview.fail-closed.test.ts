/**
 * 2026-10-20 (review of #1717): the live preview's curl must FAIL CLOSED in
 * container mode — a missing session container answers a 503 page, never a
 * `bash -lc curl …` inside the backend. Container mode off keeps the
 * in-process fallback.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../../config/database', () => ({ __esModule: true, default: {} }));
jest.mock('../../auth/auth-cookie', () => ({ __esModule: true, cookieSecure: () => false }));
jest.mock('./workspace.service', () => ({ __esModule: true, worktreePath: (id: string) => `/wt/${id}` }));
jest.mock('./coding-data.service', () => ({
  __esModule: true,
  getSessionForUser: jest.fn(async (id: string) => ({ id, worktreePath: `/wt/${id}` })),
}));
const mockEnsureSessionContainer = jest.fn(async (_id?: string) => false);
const mockExecInContainer = jest.fn(async (..._a: any[]) => ({ stdout: '200 text/plain\naGk=', stderr: '' }));
const mockHostExecFallbackAllowed = jest.fn(() => false);
jest.mock('./container.service', () => ({
  __esModule: true,
  ensureSessionContainer: (id: string) => mockEnsureSessionContainer(id),
  execInContainer: (...a: any[]) => mockExecInContainer(...a),
  hostExecFallbackAllowed: () => mockHostExecFallbackAllowed(),
}));
const mockExecFile = jest.fn((_c: string, _a: string[], _o: any, cb: any) => cb(null, { stdout: '200 text/plain\naGk=', stderr: '' }));
jest.mock('child_process', () => ({ __esModule: true, execFile: (...a: any[]) => (mockExecFile as any)(...a) }));

import previewController from './coding-preview.controller';

function fakeRes() {
  const res: any = { statusCode: 200, headers: {} as Record<string, string>, body: undefined as unknown };
  res.status = jest.fn((c: number) => { res.statusCode = c; return res; });
  res.type = jest.fn(() => res);
  res.setHeader = jest.fn((k: string, v: string) => { res.headers[k] = v; return res; });
  res.cookie = jest.fn(() => res);
  res.send = jest.fn((b: unknown) => { res.body = b; return res; });
  return res;
}
const req = () => ({ user: { id: 'u1' }, params: { id: 's1', port: '3000', splat: [] }, query: {}, headers: {} } as any);

beforeEach(() => {
  jest.clearAllMocks();
  mockEnsureSessionContainer.mockResolvedValue(false);
  mockHostExecFallbackAllowed.mockReturnValue(false);
});

describe('coding preview fail-closed (2026-10-20)', () => {
  it('container mode + no session container → 503 page, no host curl', async () => {
    const res = fakeRes();
    await previewController.preview(req(), res);
    expect(res.statusCode).toBe(503);
    expect(String(res.body)).toMatch(/isolated container is not reachable/);
    expect(mockExecFile).not.toHaveBeenCalled();
    expect(res.headers['Content-Security-Policy']).toBeDefined();
  });

  it('a healthy session container serves the preview from inside it', async () => {
    mockEnsureSessionContainer.mockResolvedValue(true);
    const res = fakeRes();
    await previewController.preview(req(), res);
    expect(mockExecInContainer).toHaveBeenCalled();
    expect(mockExecFile).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    expect(Buffer.isBuffer(res.body) ? (res.body as Buffer).toString() : res.body).toBe('hi');
  });

  it('container mode off (or the kill switch) keeps the in-process fallback', async () => {
    mockHostExecFallbackAllowed.mockReturnValue(true);
    const res = fakeRes();
    await previewController.preview(req(), res);
    expect(mockExecFile).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(200);
  });
});
