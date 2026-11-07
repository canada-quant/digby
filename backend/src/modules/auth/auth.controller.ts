import { Request, Response, NextFunction } from 'express';
import authService from './auth.service';
import { registerSchema, loginSchema, refreshSchema, deleteAccountSchema, changePasswordSchema } from './auth.validation';
import { AuthRequest } from '../../middleware/auth';
import { ACCESS_COOKIE, cookieSecure, issueAccessCookie } from './auth-cookie';
import contextService from '../crossmodel/context.service';
import logger from '../../utils/logger';
import { chooseFbc, eventSourceUrlFrom, resolveMetaEventId, sendMetaCompleteRegistration } from './meta-capi';
import { cookieTouch, FIRST_TOUCH_COOKIE, LAST_TOUCH_COOKIE, recordAuthVisit } from '../crossmodel/visitors/visitor.service';
// Phase 2 Cloud: email verification surfaces (todo ea95fa0b leg 1 item 1).
import { consumeEmailVerification, resendEmailVerification } from '../crossmodel/org/email-verification.service';

/** Cookie name for anonymous CrossModel session */
const CM_SESSION_COOKIE = 'cm_session';

// ACCESS_COOKIE / accessCookieOpts live in ./auth-cookie (shared with the auth
// middleware, which re-issues the cookie sliding-style on Bearer requests).

export class AuthController {
  async register(req: Request, res: Response, next: NextFunction) {
    try {
      const validatedData = registerSchema.parse(req.body);
      const result = await authService.register(validatedData);

      res.cookie('refreshToken', result.refreshToken, {
        httpOnly: true,
        secure: cookieSecure(),
        sameSite: 'strict',
        maxAge: 7 * 24 * 60 * 60 * 1000,
      });
      issueAccessCookie(res, result.accessToken);

      res.status(201).json({
        success: true,
        data: {
          user: result.user,
          accessToken: result.accessToken,
        },
        message: 'Registration successful',
      });

      // First-party visitor analytics (owner 2026-10-07): stitch this browser's visitor id to the new account +
      // the authoritative signup_complete. A Digby Kids account erases the visitor instead. Fire-and-forget.
      void recordAuthVisit(req, result.user, 'signup_complete');
      // Fire-and-forget: Meta Conversions API CompleteRegistration (inert without META_CAPI_ACCESS_TOKEN), sharing the
      // browser pixel's event id (body `metaEventId`) so Meta counts the sign-up once — ./meta-capi.ts.
      void sendMetaCompleteRegistration({
        email: result.user.email,
        userId: result.user.id,
        eventId: resolveMetaEventId(req.body?.metaEventId),
        eventSourceUrl: eventSourceUrlFrom(req.get('referer')),
        clientUserAgent: req.get('user-agent') || undefined,
        clientIpAddress: req.ip || undefined,
        fbp: typeof req.cookies?._fbp === 'string' ? req.cookies._fbp : undefined,
        // Meta ClickID: the _fbc cookie, the browser's copy, else built from our own fbclid capture (meta-capi chooseFbc).
        fbc: chooseFbc({ cookie: req.cookies?._fbc, body: req.body?.metaFbc, touches: [cookieTouch(req, LAST_TOUCH_COOKIE), cookieTouch(req, FIRST_TOUCH_COOKIE)] }),
      });

      // Fire-and-forget: migrate anonymous session to the new account
      const sessionId = req.cookies?.[CM_SESSION_COOKIE];
      if (sessionId) {
        contextService.migrateSessionToChat(sessionId, result.user.id).catch(err => {
          logger.warn('Session migration after register failed:', err);
        });
      }
    } catch (error) {
      next(error);
    }
  }

  async login(req: Request, res: Response, next: NextFunction) {
    try {
      const validatedData = loginSchema.parse(req.body);
      const result = await authService.login(validatedData);

      res.cookie('refreshToken', result.refreshToken, {
        httpOnly: true,
        secure: cookieSecure(),
        sameSite: 'strict',
        maxAge: 7 * 24 * 60 * 60 * 1000,
      });
      issueAccessCookie(res, result.accessToken);

      logger.info(`User logged in: ${result.user.email}`);

      res.json({
        success: true,
        data: {
          user: result.user,
          accessToken: result.accessToken,
        },
        message: 'Login successful',
      });

      // First-party visitor analytics (owner 2026-10-07): stitch visitor → user + the authoritative login event.
      void recordAuthVisit(req, result.user, 'login');

      // Fire-and-forget: migrate anonymous session to their account
      const sessionId = req.cookies?.[CM_SESSION_COOKIE];
      if (sessionId) {
        contextService.migrateSessionToChat(sessionId, result.user.id).catch(err => {
          logger.warn('Session migration after login failed:', err);
        });
      }
    } catch (error) {
      next(error);
    }
  }

  async refresh(req: Request, res: Response, next: NextFunction) {
    try {
      // body-parser 2 (Express 5) leaves req.body UNDEFINED when nothing parsed —
      // a bodiless POST without the cookie must 401, not TypeError→500.
      const refreshToken = req.cookies.refreshToken || req.body?.refreshToken;

      if (!refreshToken) {
        res.status(401).json({ error: 'Refresh token not provided' });
        return;
      }

      const result = await authService.refresh(refreshToken);

      res.cookie('refreshToken', result.refreshToken, {
        httpOnly: true,
        secure: cookieSecure(),
        sameSite: 'strict',
        maxAge: 7 * 24 * 60 * 60 * 1000,
      });
      issueAccessCookie(res, result.accessToken);

      res.json({
        success: true,
        data: {
          accessToken: result.accessToken,
        },
      });
    } catch (error) {
      next(error);
    }
  }

  async logout(req: Request, res: Response, next: NextFunction) {
    try {
      const refreshToken = req.cookies.refreshToken;

      if (refreshToken) {
        await authService.logout(refreshToken);
      }

      res.clearCookie('refreshToken');
      res.clearCookie(ACCESS_COOKIE, { path: '/' });

      res.json({
        success: true,
        message: 'Logout successful',
      });
    } catch (error) {
      next(error);
    }
  }

  async me(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      if (!req.user) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      const user = await authService.me(req.user.userId);

      res.json({
        success: true,
        data: user,
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /api/auth/change-password — { currentPassword, newPassword }.
   * Inline `authenticate` (the /api/auth router mounts BEFORE the app-level
   * guard, like /me). The service revokes every refresh token of the user and
   * mints a fresh pair; this handler sets both cookies and returns the new
   * access token exactly like login, so the caller's tab stays signed in
   * while every other device is signed out. Rate-limited with login/register
   * (app.ts authRateLimit).
   */
  async changePassword(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      if (!req.user) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      const validated = changePasswordSchema.parse(req.body);
      const result = await authService.changePassword(req.user.userId, validated);

      res.cookie('refreshToken', result.refreshToken, {
        httpOnly: true,
        secure: cookieSecure(),
        sameSite: 'strict',
        maxAge: 7 * 24 * 60 * 60 * 1000,
      });
      issueAccessCookie(res, result.accessToken);

      res.json({
        success: true,
        data: {
          accessToken: result.accessToken,
          refreshTokensRevoked: result.refreshTokensRevoked,
          // false = Redis did not take the cutoff: other devices cannot refresh,
          // but an access token they already hold works until it expires.
          accessTokensCutOff: result.accessTokensCutOff,
        },
        message: 'Password changed',
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * DELETE /api/auth/account — permanent account deletion (App Store 5.1.1(v),
   * Play Data-deletion; the mobile Settings screen's destructive action).
   * Inline `authenticate` (the /api/auth router mounts BEFORE the app-level
   * guard, like /me). Password re-auth in the service layer.
   */
  async deleteAccount(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      if (!req.user) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      const validated = deleteAccountSchema.parse(req.body);
      const result = await authService.deleteAccount(req.user.userId, validated);

      // Tear down the web session's cookies too (belt-and-braces — the
      // refresh-token rows are already gone via the user cascade).
      res.clearCookie('refreshToken');
      res.clearCookie(ACCESS_COOKIE, { path: '/' });

      res.json({
        success: true,
        data: result,
        message: 'Account deleted',
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /api/auth/verify-email — consume a verification token (public).
   *
   * Unauthenticated on purpose: the link is often opened in a different browser
   * or on a phone than the one that signed up, so requiring a session would
   * strand exactly the users verification exists to serve. The token itself is
   * the credential (32 random bytes, sha256-stored, single-use, 24 h).
   */
  async verifyEmail(req: Request, res: Response, next: NextFunction) {
    try {
      const rawToken = typeof req.body?.token === 'string' ? req.body.token : '';
      const result = await consumeEmailVerification(rawToken);
      res.json({
        success: true,
        data: { alreadyVerified: result.alreadyVerified },
        message: result.alreadyVerified ? 'This email address is already verified.' : 'Email verified',
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /api/auth/resend-verification — re-send the link to a signed-in,
   * still-unverified user. Inline `authenticate` (this router mounts before the
   * app-level guard, like /me and DELETE /account).
   */
  async resendVerification(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      if (!req.user) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
      const result = await resendEmailVerification(req.user.userId);
      res.json({
        success: true,
        data: { mailed: result.mailed, ...(result.error ? { error: result.error } : {}) },
        message: result.mailed
          ? 'Verification email sent'
          : 'We could not send the verification email right now.',
      });
    } catch (error) {
      next(error);
    }
  }
}

export default new AuthController();
