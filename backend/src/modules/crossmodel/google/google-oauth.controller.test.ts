/**
 * Google OAuth — PATCH /accounts/:id/label (feedback abeb36a2: let users rename
 * a connected Google account's display label, e.g. "Work" → "Sunday Market Media").
 *
 * Covers: 400 invalid label · 404 when the id is not one of the user's accounts
 * (ownership scoping) · 409 when another of the user's accounts already uses the
 * label (labels are unique per user) · no-op rename · successful relabel.
 *
 * Boundaries mocked per .digby/notes/learnings.md (config/database and
 * config/redis pull config/env, which exits the process at import).
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockPrisma: any = {
  googleOAuthToken: { findFirst: jest.fn(), update: jest.fn() },
};
jest.mock('../../../config/database', () => ({ __esModule: true, default: mockPrisma }));

jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: { get: jest.fn(), setEx: jest.fn(), del: jest.fn() },
}));

// Side-effect-heavy module imports pulled in by the controller — not exercised
// by the label endpoint.
jest.mock('./crypto', () => ({ encrypt: jest.fn(), decrypt: jest.fn() }));
jest.mock('./google-mcp', () => ({ sendGmailEmail: jest.fn() }));
jest.mock('../langgraph/integration-status-cache', () => ({
  invalidateIntegrationStatusCache: jest.fn(async () => undefined),
}));

import controller from './google-oauth.controller';

const mockRes = () => {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

const ACCOUNT = {
  id: 'a1',
  userId: 'u1',
  label: 'Work',
  email: 'example-user@example.com',
  scopes: ['gmail.readonly'],
  expiresAt: new Date('2026-09-01T00:00:00Z'),
  createdAt: new Date('2026-01-01T00:00:00Z'),
};

beforeEach(() => jest.clearAllMocks());

describe('updateAccountLabel', () => {
  it('400 when the label is empty or whitespace-only — no DB calls', async () => {
    const res = mockRes();
    await controller.updateAccountLabel(
      { user: { id: 'u1' }, params: { id: 'a1' }, body: { label: '   ' } } as any, res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockPrisma.googleOAuthToken.findFirst).not.toHaveBeenCalled();
  });

  it('400 when the label exceeds 40 chars', async () => {
    const res = mockRes();
    await controller.updateAccountLabel(
      { user: { id: 'u1' }, params: { id: 'a1' }, body: { label: 'x'.repeat(41) } } as any, res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('404 when the id does not resolve to one of THIS user\'s accounts (ownership-scoped query)', async () => {
    mockPrisma.googleOAuthToken.findFirst.mockResolvedValue(null);
    const res = mockRes();
    await controller.updateAccountLabel(
      { user: { id: 'u1' }, params: { id: 'a1' }, body: { label: 'Sunday Market Media' } } as any, res, jest.fn());
    expect(mockPrisma.googleOAuthToken.findFirst).toHaveBeenCalledWith({ where: { id: 'a1', userId: 'u1' } });
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('409 when another of the user\'s accounts already uses the label', async () => {
    mockPrisma.googleOAuthToken.findFirst
      .mockResolvedValueOnce(ACCOUNT)                                   // ownership lookup
      .mockResolvedValueOnce({ id: 'a2', label: 'Sunday Market Media' }); // conflict lookup
    const res = mockRes();
    await controller.updateAccountLabel(
      { user: { id: 'u1' }, params: { id: 'a1' }, body: { label: 'Sunday Market Media' } } as any, res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(409);
    expect(mockPrisma.googleOAuthToken.update).not.toHaveBeenCalled();
  });

  it('no-op rename to the same label returns 200 without updating', async () => {
    mockPrisma.googleOAuthToken.findFirst.mockResolvedValue(ACCOUNT);
    const res = mockRes();
    await controller.updateAccountLabel(
      { user: { id: 'u1' }, params: { id: 'a1' }, body: { label: 'Work' } } as any, res, jest.fn());
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      data: expect.objectContaining({ id: 'a1', label: 'Work' }),
    }));
    expect(mockPrisma.googleOAuthToken.update).not.toHaveBeenCalled();
  });

  it('renames successfully and returns the updated account shape', async () => {
    mockPrisma.googleOAuthToken.findFirst
      .mockResolvedValueOnce(ACCOUNT)  // ownership lookup
      .mockResolvedValueOnce(null);    // no conflict
    mockPrisma.googleOAuthToken.update.mockResolvedValue({ ...ACCOUNT, label: 'Sunday Market Media' });
    const res = mockRes();
    await controller.updateAccountLabel(
      { user: { id: 'u1' }, params: { id: 'a1' }, body: { label: '  Sunday Market Media  ' } } as any, res, jest.fn());
    expect(mockPrisma.googleOAuthToken.update).toHaveBeenCalledWith({
      where: { id: 'a1' },
      data: { label: 'Sunday Market Media' },
    });
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      data: expect.objectContaining({
        id: 'a1',
        label: 'Sunday Market Media',
        email: 'example-user@example.com',
        scopes: ['gmail.readonly'],
      }),
    }));
  });
});
