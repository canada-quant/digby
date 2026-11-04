import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';
import { env } from '../config/env';

export interface TokenPayload {
  userId: string;
  email: string;
  role: string;
  // Digby Kids: present (true) on child sub-account tokens. parentId is the
  // owning parent's user id. Both optional so legacy/adult tokens are unaffected.
  isChild?: boolean;
  parentId?: string | null;
}

export const generateAccessToken = (payload: TokenPayload): string => {
  return jwt.sign(payload, env.JWT_SECRET, {
    expiresIn: env.JWT_EXPIRES_IN as string,
  } as jwt.SignOptions);
};

/**
 * Every refresh token carries a random `jti` (2026-10-20). Without it two
 * logins (or two refreshes) by the same user inside one second signed the
 * IDENTICAL token — same claims, same iat/exp — and the second insert into
 * refresh_tokens hit the unique constraint on `token`: an HTTP 500 on
 * POST /api/auth/login for a double-clicked sign-in or two tabs.
 */
export const generateRefreshToken = (payload: TokenPayload): string => {
  return jwt.sign(payload, env.JWT_REFRESH_SECRET, {
    expiresIn: env.JWT_REFRESH_EXPIRES_IN as string,
    jwtid: randomUUID(),
  } as jwt.SignOptions);
};

export const verifyAccessToken = (token: string): TokenPayload => {
  return jwt.verify(token, env.JWT_SECRET) as TokenPayload;
};

export const verifyRefreshToken = (token: string): TokenPayload => {
  return jwt.verify(token, env.JWT_REFRESH_SECRET) as TokenPayload;
};
