/**
 * 2026-10-20: two refresh tokens minted for the same user in the same second
 * must differ — identical tokens collided on refresh_tokens.token (unique) and
 * POST /api/auth/login answered 500 on a double-clicked sign-in.
 */
jest.mock('../config/env', () => ({
  env: { JWT_SECRET: 'a'.repeat(40), JWT_REFRESH_SECRET: 'b'.repeat(40), JWT_EXPIRES_IN: '15m', JWT_REFRESH_EXPIRES_IN: '7d' },
}));

import { generateRefreshToken, verifyRefreshToken } from './jwt';

describe('generateRefreshToken', () => {
  it('two tokens for the same payload in the same second are distinct', () => {
    const payload = { userId: 'u1', email: 'a@b.c', role: 'USER' };
    const now = Date.now;
    Date.now = () => 1_800_000_000_000; // freeze iat/exp
    try {
      const a = generateRefreshToken(payload);
      const b = generateRefreshToken(payload);
      expect(a).not.toBe(b);
    } finally {
      Date.now = now;
    }
  });

  it('still verifies and keeps the claims', () => {
    const t = generateRefreshToken({ userId: 'u2', email: 'x@y.z', role: 'ADMIN' });
    const p = verifyRefreshToken(t) as any;
    expect(p.userId).toBe('u2');
    expect(p.role).toBe('ADMIN');
    expect(typeof p.jti).toBe('string');
  });
});
