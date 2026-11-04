/**
 * X (Twitter) OAuth 2.0 Controller — PKCE flow
 *
 * Key differences from GitHub:
 *   - X uses OAuth 2.0 with PKCE (S256 code challenge)
 *   - X tokens expire (~2h) and ROTATE the refresh token on every refresh
 *   - X requires HTTP Basic auth (client_id:client_secret) at the token endpoint
 *   - X has a revoke endpoint (POST /2/oauth2/revoke)
 *
 * Endpoints:
 *   GET    /api/crossmodel/x/auth        — Start OAuth flow (redirect to X)
 *   GET    /api/crossmodel/x/callback    — Handle code exchange
 *   GET    /api/crossmodel/x/status      — Is connected? (auth required)
 *   DELETE /api/crossmodel/x/disconnect  — Revoke + delete token (auth required)
 */

import { Request, Response, NextFunction } from 'express';
import { randomBytes, createHash } from 'crypto';
import axios from 'axios';
import prisma from '../../../config/database';
import redisClient from '../../../config/redis';
import { encryptWith, decryptWith } from './crypto';
import { EncryptionKeyError } from '../google/crypto';
import { invalidateIntegrationStatusCache } from '../langgraph/integration-status-cache';
import { getReadHealth } from '../integration-health';
import logger from '../../../utils/logger';

const X_AUTH_URL    = 'https://x.com/i/oauth2/authorize';
const X_TOKEN_URL   = 'https://api.x.com/2/oauth2/token';
const X_REVOKE_URL  = 'https://api.x.com/2/oauth2/revoke';
const X_ME_URL      = 'https://api.x.com/2/users/me';

const SCOPES = [
  'tweet.read',
  'tweet.write',
  'users.read',
  'like.read',
  'like.write',
  'follows.read',
  'follows.write',
  'offline.access', // required to receive a refresh_token
].join(' ');

/** True when the OAuth app is configured on this instance (the Integrations tab reads it as `configured`). */
function oauthConfigured(): boolean {
  return !!(process.env.X_OAUTH_CLIENT_ID && process.env.X_OAUTH_CLIENT_SECRET);
}

function getConfig() {
  const clientId     = process.env.X_OAUTH_CLIENT_ID;
  const clientSecret = process.env.X_OAUTH_CLIENT_SECRET;
  const frontendUrl  = (process.env.FRONTEND_URL || 'https://digby.example.com').split(',')[0].trim();
  // The callback derives from THIS instance's public URL (self-host setup
  // hardening 2026-10-20); on production FRONTEND_URL's first entry is
  // https://digby.example.com, so the derived value is byte-identical.
  const redirectUri  = process.env.X_OAUTH_REDIRECT_URI ||
    `${frontendUrl}/api/crossmodel/x/callback`;

  if (!clientId || !clientSecret) {
    throw new Error('X_OAUTH_CLIENT_ID and X_OAUTH_CLIENT_SECRET must be set');
  }
  return { clientId, clientSecret, redirectUri, frontendUrl };
}

// ── PKCE helpers ─────────────────────────────────────────────────────────────

function generateCodeVerifier(): string {
  // 43–128 unreserved characters. 64 random bytes → base64url ≈ 86 chars.
  return randomBytes(64).toString('base64url').slice(0, 96);
}

function codeChallengeFromVerifier(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

// ── State storage (Redis) ────────────────────────────────────────────────────
// Holds { userId, codeVerifier }. Single-use with 10-minute TTL.

interface OAuthStateData {
  userId: string;
  codeVerifier: string;
  label: string;
}

async function storeOAuthState(state: string, data: OAuthStateData): Promise<void> {
  await redisClient.setEx(`x_oauth_state:${state}`, 600, JSON.stringify(data));
}

async function consumeOAuthState(state: string): Promise<OAuthStateData | null> {
  const key = `x_oauth_state:${state}`;
  const raw = await redisClient.get(key);
  if (raw) await redisClient.del(key);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<OAuthStateData>;
    return {
      userId: parsed.userId ?? '',
      codeVerifier: parsed.codeVerifier ?? '',
      label: parsed.label ?? 'Personal',  // backward-compat for old states
    };
  } catch { return null; }
}

// ── Controller ───────────────────────────────────────────────────────────────

export class XOAuthController {

  /**
   * GET /api/crossmodel/x/auth
   * Requires authentication via ?token=<jwt> query param.
   * Redirects the browser to X's consent screen.
   */
  async startAuth(req: Request, res: Response, next: NextFunction) {
    try {
      if (!req.user) {
        res.status(401).json({ error: 'Authentication required. Please log in to connect X.' });
        return;
      }
      const userId = req.user.id;
      const rawLabel = typeof req.query.label === 'string' ? req.query.label.trim() : '';
      const label = rawLabel.slice(0, 40) || 'Personal'; // cap length to keep DB clean
      if (!oauthConfigured()) {
        // Self-host setup hardening (2026-10-20): the same not_configured redirect
        // Slack/Asana use — the tab says "not set up on this instance" + the how-to.
        const frontendUrl = (process.env.FRONTEND_URL || 'https://digby.example.com').split(',')[0].trim();
        logger.warn('X OAuth: X_OAUTH_CLIENT_ID / X_OAUTH_CLIENT_SECRET not configured');
        res.redirect(`${frontendUrl}/account?tab=integrations&x=not_configured`);
        return;
      }
      const { clientId, redirectUri } = getConfig();

      const state = randomBytes(32).toString('hex');
      const codeVerifier = generateCodeVerifier();
      const codeChallenge = codeChallengeFromVerifier(codeVerifier);

      await storeOAuthState(state, { userId, codeVerifier, label });

      const params = new URLSearchParams({
        response_type:         'code',
        client_id:             clientId,
        redirect_uri:          redirectUri,
        scope:                 SCOPES,
        state,
        code_challenge:        codeChallenge,
        code_challenge_method: 'S256',
      });

      const consentUrl = `${X_AUTH_URL}?${params}`;
      logger.info(`X OAuth: starting flow for userId=${userId}`);
      res.redirect(consentUrl);
    } catch (error: any) {
      logger.error('X OAuth startAuth error:', error.message);
      next(error);
    }
  }

  /**
   * GET /api/crossmodel/x/callback
   * Public — X redirects here with ?code and ?state.
   */
  async handleCallback(req: Request, res: Response, _next: NextFunction) {
    const { code, state, error: oauthError } = req.query as Record<string, string>;
    const { clientId, clientSecret, redirectUri, frontendUrl } = getConfig();
    const errorRedirect = `${frontendUrl}/account?tab=integrations&x=error`;

    try {
      if (oauthError)  { logger.warn(`X OAuth callback error: ${oauthError}`); return res.redirect(errorRedirect); }
      if (!code || !state) { return res.redirect(errorRedirect); }

      const stateData = await consumeOAuthState(state);
      if (!stateData) {
        logger.warn('X OAuth callback: invalid/expired state');
        return res.redirect(errorRedirect);
      }
      const { userId, codeVerifier, label } = stateData;

      // ── Exchange authorization code for access + refresh tokens ─────────
      const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
      const body = new URLSearchParams({
        grant_type:    'authorization_code',
        code,
        redirect_uri:  redirectUri,
        client_id:     clientId,
        code_verifier: codeVerifier,
      });

      const tokenRes = await axios.post(X_TOKEN_URL, body.toString(), {
        headers: {
          Authorization: `Basic ${basic}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        timeout: 15000,
      });

      const {
        access_token, refresh_token, expires_in, scope, token_type,
      } = tokenRes.data as {
        access_token: string;
        refresh_token?: string;
        expires_in:   number;
        scope?:       string;
        token_type:   string;
      };

      if (!access_token) {
        logger.error(`X OAuth: no access_token in response for userId=${userId}`);
        return res.redirect(errorRedirect);
      }

      // Fetch the connected handle (best-effort, non-critical)
      let screenName: string | null = null;
      try {
        const me = await axios.get(X_ME_URL, {
          headers: { Authorization: `Bearer ${access_token}` },
          timeout: 5000,
        });
        screenName = me.data?.data?.username ?? null;
      } catch { /* ignore */ }

      const expiresAt = new Date(Date.now() + expires_in * 1000);
      const grantedScopes = scope ? scope.split(/\s+/).filter(Boolean) : [];

      await (prisma as any).xOAuthToken.upsert({
        where:  { userId_label: { userId, label } },
        create: {
          userId,
          label,
          accessToken:  encryptWith(access_token,  'X_TOKEN_ENCRYPTION_KEY'),
          refreshToken: refresh_token
            ? encryptWith(refresh_token, 'X_TOKEN_ENCRYPTION_KEY')
            : null,
          expiresAt,
          tokenType:    token_type || 'bearer',
          scopes:       grantedScopes,
          screenName,
        },
        update: {
          accessToken:  encryptWith(access_token,  'X_TOKEN_ENCRYPTION_KEY'),
          refreshToken: refresh_token
            ? encryptWith(refresh_token, 'X_TOKEN_ENCRYPTION_KEY')
            : undefined,
          expiresAt,
          tokenType:    token_type || 'bearer',
          scopes:       grantedScopes,
          screenName,
        },
      });

      await invalidateIntegrationStatusCache(userId); // surface the new connection immediately (don't wait for TTL)
      logger.info(`X OAuth: connected userId=${userId}, label=${label}, screenName=${screenName ?? 'unknown'}`);
      res.redirect(`${frontendUrl}/account?tab=integrations&x=connected`);
    } catch (error: any) {
      logger.error(`X OAuth callback error: ${error.response?.data
        ? JSON.stringify(error.response.data)
        : error.message}`);
      // A completed consent that cannot be stored (no X_TOKEN_ENCRYPTION_KEY on this
      // instance) is a configuration fact, not "try again" (2026-10-20).
      if (error instanceof EncryptionKeyError) {
        res.redirect(`${frontendUrl}/account?tab=integrations&x=not_configured&reason=encryption_key`);
        return;
      }
      res.redirect(errorRedirect);
    }
  }

  /**
   * GET /api/crossmodel/x/status
   * Backward-compat: returns the first (oldest) connected account's status.
   * fa956f09: also returns the PLATFORM read-path health so the UI can show a
   * degraded badge instead of implying everything is fine during a gateway
   * outage — "connected" only reflects the per-user OAuth row.
   */
  async getStatus(req: Request, res: Response, next: NextFunction) {
    try {
      const userId = req.user!.id;
      const [row, readHealth] = await Promise.all([
        (prisma as any).xOAuthToken.findFirst({
          where:   { userId },
          select:  { label: true, screenName: true, scopes: true, createdAt: true, expiresAt: true },
          orderBy: { createdAt: 'asc' },
        }),
        getReadHealth('x'),
      ]);
      // Shape: { status: 'ok'|'fail', lastError, lastErrorAt, failureCount } or null
      const readHealthPayload = readHealth
        ? {
            status: readHealth.status,
            lastError: readHealth.lastError,
            lastErrorAt: readHealth.lastErrorAt,
            failureCount: readHealth.failureCount,
          }
        : null;
      if (!row) {
        return res.json({ success: true, data: { connected: false, configured: oauthConfigured(), readHealth: readHealthPayload } });
      }
      res.json({
        success: true,
        data: {
          connected:      true,
          label:          row.label,
          screenName:     row.screenName ?? null,
          scopes:         row.scopes ?? [],
          connectedAt:    row.createdAt,
          tokenExpiresAt: row.expiresAt,
          readHealth:     readHealthPayload,
        },
      });
    } catch (error) {
      next(error);
    }
  }

  /** GET /api/crossmodel/x/accounts — list every connected X account for this user.
   * Shape unchanged (array of accounts): the frontend maps over this directly.
   * Platform read health rides on GET /x/status instead (fa956f09). */
  async listAccounts(req: Request, res: Response, next: NextFunction) {
    try {
      const userId = req.user!.id;
      const rows = await (prisma as any).xOAuthToken.findMany({
        where:   { userId },
        select:  { id: true, label: true, screenName: true, scopes: true, createdAt: true, expiresAt: true },
        orderBy: { createdAt: 'asc' },
      });
      res.json({
        success: true,
        data: rows.map((r: any) => ({
          id:             r.id,
          label:          r.label,
          screenName:     r.screenName ?? null,
          scopes:         r.scopes ?? [],
          connectedAt:    r.createdAt,
          tokenExpiresAt: r.expiresAt,
        })),
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * DELETE /api/crossmodel/x/disconnect[?label=Personal]
   * Revokes the access token with X (best-effort) and deletes the row(s).
   * Without a label → disconnects ALL X accounts for the user (backward compat).
   */
  async disconnect(req: Request, res: Response, next: NextFunction) {
    try {
      const userId = req.user!.id;
      const label  = typeof req.query.label === 'string' ? req.query.label : null;
      const { clientId, clientSecret } = getConfig();

      const tryRevoke = async (row: any) => {
        try {
          const accessToken = decryptWith(row.accessToken, 'X_TOKEN_ENCRYPTION_KEY');
          const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
          const revokeBody = new URLSearchParams({
            token: accessToken,
            token_type_hint: 'access_token',
            client_id: clientId,
          });
          await axios.post(X_REVOKE_URL, revokeBody.toString(), {
            headers: {
              Authorization: `Basic ${basic}`,
              'Content-Type': 'application/x-www-form-urlencoded',
            },
            timeout: 5000,
          });
        } catch (revokeErr: any) {
          logger.warn(`X token revoke failed (non-critical): ${revokeErr.message}`);
        }
      };

      if (label) {
        const row = await (prisma as any).xOAuthToken.findUnique({
          where: { userId_label: { userId, label } },
        });
        if (!row) {
          return res.json({ success: true, message: `No X account labelled "${label}"` });
        }
        await tryRevoke(row);
        await (prisma as any).xOAuthToken.delete({ where: { id: row.id } });
        await invalidateIntegrationStatusCache(userId);
        logger.info(`X OAuth: disconnected userId=${userId}, label=${label}`);
        return res.json({ success: true, message: `X account "${label}" disconnected` });
      }

      const rows = await (prisma as any).xOAuthToken.findMany({ where: { userId } });
      if (rows.length === 0) {
        return res.json({ success: true, message: 'Not connected to X' });
      }
      await Promise.allSettled(rows.map(tryRevoke));
      await (prisma as any).xOAuthToken.deleteMany({ where: { userId } });
      await invalidateIntegrationStatusCache(userId);
      logger.info(`X OAuth: disconnected all accounts for userId=${userId}`);
      res.json({ success: true, message: 'All X accounts disconnected' });
    } catch (error) {
      next(error);
    }
  }
}

export default new XOAuthController();
