/**
 * token-manager — honest token resolution (ticket fa956f09, 2026-09-24).
 *
 * The 2026-09-22 incident class: a CONNECTED user whose X refresh token died
 * (expired/revoked) got "User has not connected their X account" from the
 * write tools — a lie that sent them to re-auth for a platform-side problem
 * or made the model claim the user never connected. resolveXToken now
 * discriminates: not_connected / label_not_found / no_refresh_token /
 * refresh_failed / error, each with an actionable message. getValidToken
 * stays a thin token-or-null wrapper (all callers keep their behavior).
 *
 * Boundaries mocked per .digby/notes/learnings.md (config/database pulls
 * config/env, which exits the process at import; crypto mocked at the google
 * leaf — see xero/token-manager.test.ts for the pattern).
 */

jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    xOAuthToken: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
    },
  },
}));
jest.mock('axios');
jest.mock('../google/crypto', () => ({
  encrypt: jest.fn((s: string) => `enc:${s}`),
  decrypt: jest.fn((s: string) => s.replace(/^enc:/, '')),
  encryptWith: jest.fn((s: string) => `enc:${s}`),
  decryptWith: jest.fn((s: string) => s.replace(/^enc:/, '')),
}));
jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import prisma from '../../../config/database';
import axios from 'axios';
import { resolveXToken, getValidToken } from './token-manager';

const db = (prisma as any).xOAuthToken;
const mockPost = axios.post as jest.Mock;

const NOW = Date.now();
const FRESH_ROW = {
  id: 'row1',
  userId: 'u1',
  label: 'Personal',
  accessToken: 'enc:tok-fresh',
  refreshToken: 'enc:refresh',
  expiresAt: new Date(NOW + 60 * 60 * 1000), // 1h out — past the 60s refresh buffer
  scopes: ['tweet.read'],
};
const EXPIRED_ROW = {
  ...FRESH_ROW,
  accessToken: 'enc:tok-stale',
  expiresAt: new Date(NOW - 60 * 60 * 1000), // expired 1h ago
};

beforeEach(() => {
  jest.clearAllMocks();
  process.env.X_OAUTH_CLIENT_ID = 'cid';
  process.env.X_OAUTH_CLIENT_SECRET = 'csecret';
});

describe('resolveXToken — honest failure classes (fa956f09)', () => {
  it('not_connected vs refresh_failed are DIFFERENT outcomes with different messages', async () => {
    // No row at all → not connected (the honest old behavior).
    db.findFirst.mockResolvedValue(null);
    const noAccount = await resolveXToken('u1');
    expect(noAccount).toMatchObject({ ok: false, reason: 'not_connected' });
    expect(noAccount.ok ? '' : noAccount.message).toContain('has not connected');

    // Row exists but refresh fails → stale auth, message says RECONNECT, never
    // "not connected" — this is the fa956f09 misattribution class.
    db.findFirst.mockResolvedValue({ ...EXPIRED_ROW, refreshToken: 'enc:refresh' });
    mockPost.mockRejectedValue(new Error('400 invalid_grant'));
    const stale = await resolveXToken('u1');
    expect(stale).toMatchObject({ ok: false, reason: 'refresh_failed' });
    expect(stale.ok ? '' : stale.message).toContain('reconnect X');
    expect(stale.ok ? '' : stale.message).not.toContain('has not connected');
  });

  it('label_not_found names the label (multi-account)', async () => {
    db.findUnique.mockResolvedValue(null);
    const out = await resolveXToken('u1', 'Work');
    expect(out).toMatchObject({ ok: false, reason: 'label_not_found' });
    expect(out.ok ? '' : out.message).toContain('"Work"');
  });

  it('no_refresh_token (expired, offline.access never granted) asks the user to reconnect', async () => {
    db.findFirst.mockResolvedValue({ ...EXPIRED_ROW, refreshToken: null });
    const out = await resolveXToken('u1');
    expect(out).toMatchObject({ ok: false, reason: 'no_refresh_token' });
    expect(out.ok ? '' : out.message).toContain('reconnect X');
  });

  it('a fresh token resolves without any refresh call', async () => {
    db.findFirst.mockResolvedValue(FRESH_ROW);
    const out = await resolveXToken('u1');
    expect(out).toMatchObject({ ok: true, token: 'tok-fresh' });
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('a successful refresh persists the rotated tokens and returns the new access token', async () => {
    db.findFirst.mockResolvedValue(EXPIRED_ROW);
    mockPost.mockResolvedValue({
      data: { access_token: 'tok-new', refresh_token: 'refresh-new', expires_in: 7200, scope: 'tweet.read' },
    });
    const out = await resolveXToken('u1');
    expect(out).toMatchObject({ ok: true, token: 'tok-new' });
    expect(db.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'row1' } }),
    );
  });

  it('getValidToken stays a thin token-or-null wrapper over resolveXToken', async () => {
    db.findFirst.mockResolvedValue(FRESH_ROW);
    expect(await getValidToken('u1')).toBe('tok-fresh');
    db.findFirst.mockResolvedValue(null);
    expect(await getValidToken('u1')).toBeNull();
  });
});
