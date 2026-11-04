/**
 * f129 (FS disposition 2026-10-13) — the api-client dead-session refresh gate.
 * Once a token refresh was REFUSED (401/403 → markSessionDead) and no fresh
 * login stored a new access token, a 401 must NOT fire another
 * POST /api/auth/refresh: the dead refresh cookie cannot revive, and
 * re-presenting it was the post-rotation invalid-signature stream (~550
 * 401s/h — the supervisor side panels polling on a corpse session every
 * 60 s). The gate rejects immediately; a fresh login stores a token (the gate
 * lifts) and the next Bearer success clears the latch (markSessionAlive).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

type RejectedHandler = (error: unknown) => Promise<unknown>;

const h = vi.hoisted(() => ({
  postMock: vi.fn(),
  rejected: null as RejectedHandler | null,
}));

vi.mock('axios', () => ({
  default: {
    create: vi.fn(() => Object.assign(
      // the instance itself is callable (the refresh-success path re-issues
      // the original request through it)
      vi.fn(() => Promise.resolve({ data: {}, config: { headers: {} } })),
      {
        interceptors: {
          request: { use: vi.fn() },
          response: {
            use: vi.fn((_fulfilled: unknown, rejected: RejectedHandler) => { h.rejected = rejected; }),
          },
        },
        get: vi.fn(() => Promise.resolve({ data: {}, config: { headers: {} } })),
      },
    )),
    post: (...args: unknown[]) => h.postMock(...args),
  },
}));
vi.mock('./visitor-analytics', () => ({ VISITOR_HEADER: 'x-dg-visitor', visitorIdForHeader: () => null }));

import { __resetSessionLatchForTest, isSessionDead, markSessionDead } from './session-latch';
import './api-client'; // registers the interceptors on the stub instance

const storage = {
  getItem: vi.fn((_key: string): string | null => null),
  setItem: vi.fn(),
  removeItem: vi.fn(),
};

function unauthorized(): { config: Record<string, unknown>; response: { status: number } } {
  return { config: { url: '/crossmodel/projects/p1/usage', headers: {} }, response: { status: 401 } };
}

describe('api-client dead-session refresh gate (f129)', () => {
  beforeEach(() => {
    __resetSessionLatchForTest();
    h.postMock.mockReset();
    storage.getItem.mockReset().mockReturnValue(null);
    storage.setItem.mockReset();
    vi.stubGlobal('localStorage', storage);
  });

  it('latched dead + no stored token ⇒ rejects immediately, never re-presents the dead refresh cookie', async () => {
    markSessionDead();
    expect(h.rejected).toBeTypeOf('function');
    const err = unauthorized();
    await expect(h.rejected!(err)).rejects.toBe(err);
    expect(h.postMock).not.toHaveBeenCalled();
  });

  it('latched dead but a fresh login stored a token ⇒ the gate lifts and refresh IS attempted', async () => {
    markSessionDead();
    storage.getItem.mockReturnValue('fresh-access-token');
    h.postMock.mockRejectedValue({ response: { status: 401 } });
    await expect(h.rejected!(unauthorized())).rejects.toMatchObject({ response: { status: 401 } });
    expect(h.postMock).toHaveBeenCalledWith('/api/auth/refresh', {}, expect.objectContaining({ withCredentials: true }));
    expect(isSessionDead()).toBe(true); // the refused refresh re-latches the session
  });

  it('alive session ⇒ the normal 401 → refresh dance still runs (no gate)', async () => {
    storage.getItem.mockReturnValue('expired-access-token');
    h.postMock.mockResolvedValue({ data: { data: { accessToken: 'new-access-token' } } });
    await h.rejected!(unauthorized());
    expect(h.postMock).toHaveBeenCalledWith('/api/auth/refresh', {}, expect.objectContaining({ withCredentials: true }));
    expect(storage.setItem).toHaveBeenCalledWith('accessToken', 'new-access-token');
    expect(isSessionDead()).toBe(false);
  });

  it('auth endpoints are untouched by the gate — a failed login keeps its own error', async () => {
    markSessionDead();
    const err = { config: { url: '/auth/login', headers: {} }, response: { status: 401 } };
    await expect(h.rejected!(err)).rejects.toBe(err);
    expect(h.postMock).not.toHaveBeenCalled();
  });
});
