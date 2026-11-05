/**
 * Asana OAuth Controller
 *
 * Handles the Asana OAuth 2.0 authorization-code flow and token management.
 * Asana access tokens expire (~1h); the refresh token is long-lived, so we store
 * both encrypted and refresh on demand in the token-manager.
 *
 * Endpoints:
 *   GET    /api/crossmodel/asana/auth        — Start OAuth flow (redirect to Asana)
 *   GET    /api/crossmodel/asana/callback     — Handle OAuth callback from Asana
 *   GET    /api/crossmodel/asana/status       — Check connection status
 *   DELETE /api/crossmodel/asana/disconnect   — Delete token
 */

import { Request, Response, NextFunction } from 'express';
import { randomBytes } from 'crypto';
import axios from 'axios';
import prisma from '../../../config/database';
import redisClient from '../../../config/redis';
import { encryptWith, EncryptionKeyError } from '../google/crypto';
import { invalidateIntegrationStatusCache } from '../langgraph/integration-status-cache';
import logger from '../../../utils/logger';

// ── OAuth configuration ────────────────────────────────────────────────────────

const ASANA_AUTH_URL  = 'https://app.asana.com/-/oauth_authorize';
const ASANA_TOKEN_URL = 'https://app.asana.com/-/oauth_token';

function getConfig() {
  const clientId     = process.env.ASANA_CLIENT_ID;
  const clientSecret = process.env.ASANA_CLIENT_SECRET;
  const frontendUrl  = (process.env.FRONTEND_URL || 'https://digby.ai').split(',')[0].trim();
  // Derived from THIS instance's public URL (self-host setup hardening, 2026-10-20); the env overrides.
  const redirectUri  = process.env.ASANA_OAUTH_REDIRECT_URI ||
    `${frontendUrl}/api/crossmodel/asana/callback`;

  if (!clientId || !clientSecret) {
    throw new Error('ASANA_CLIENT_ID and ASANA_CLIENT_SECRET must be set');
  }
  return { clientId, clientSecret, redirectUri, frontendUrl };
}

// ── State storage (Redis) — single-use, 5-minute TTL ───────────────────────────

async function storeOAuthState(state: string, userId: string): Promise<void> {
  await redisClient.setEx(`asana_oauth_state:${state}`, 300, userId);
}

async function validateAndConsumeOAuthState(state: string): Promise<string | null> {
  const key = `asana_oauth_state:${state}`;
  const raw = await redisClient.get(key);
  if (raw) await redisClient.del(key);
  return raw || null;
}

// ── Controller ────────────────────────────────────────────────────────────────

export class AsanaOAuthController {

  /** GET /api/crossmodel/asana/auth — Start Asana OAuth flow. */
  async startAuth(req: Request, res: Response, next: NextFunction) {
    try {
      if (!req.user) {
        res.status(401).json({ error: 'Authentication required. Please log in to connect Asana.' });
        return;
      }

      const clientId     = process.env.ASANA_CLIENT_ID;
      const clientSecret = process.env.ASANA_CLIENT_SECRET;
      if (!clientId || !clientSecret) {
        const frontendUrl = (process.env.FRONTEND_URL || 'https://digby.ai').split(',')[0].trim();
        logger.warn('Asana OAuth: ASANA_CLIENT_ID / ASANA_CLIENT_SECRET not configured');
        return res.redirect(`${frontendUrl}/account?tab=integrations&asana=not_configured`);
      }

      const userId = req.user.id;
      const { redirectUri } = getConfig();
      const state = randomBytes(32).toString('hex');
      await storeOAuthState(state, userId);

      const params = new URLSearchParams({
        client_id:     clientId,
        redirect_uri:  redirectUri,
        response_type: 'code',
        state,
      });

      const consentUrl = `${ASANA_AUTH_URL}?${params}`;
      logger.info(`Asana OAuth: starting flow for userId=${userId}`);
      res.redirect(consentUrl);
    } catch (error: any) {
      logger.error('Asana OAuth startAuth error:', error.message);
      next(error);
    }
  }

  /** GET /api/crossmodel/asana/callback — Handle OAuth callback from Asana. */
  async handleCallback(req: Request, res: Response, _next: NextFunction) {
    const { code, state, error: oauthError } = req.query as Record<string, string>;
    const { clientId, clientSecret, redirectUri, frontendUrl } = getConfig();
    const errorRedirect = `${frontendUrl}/account?tab=integrations&asana=error`;

    try {
      if (oauthError) {
        logger.warn(`Asana OAuth callback error: ${oauthError}`);
        return res.redirect(errorRedirect);
      }
      if (!code || !state) {
        logger.warn('Asana OAuth callback: missing code or state');
        return res.redirect(errorRedirect);
      }

      const userId = await validateAndConsumeOAuthState(state);
      if (!userId) {
        logger.warn('Asana OAuth callback: invalid or expired state');
        return res.redirect(errorRedirect);
      }

      const tokenRes = await axios.post(
        ASANA_TOKEN_URL,
        new URLSearchParams({
          grant_type:    'authorization_code',
          client_id:     clientId,
          client_secret: clientSecret,
          redirect_uri:  redirectUri,
          code,
        }).toString(),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 15000 }
      );

      const { access_token, refresh_token, expires_in, data } = tokenRes.data as {
        access_token?: string;
        refresh_token?: string;
        expires_in?: number;
        data?: { id?: number | string; gid?: string; name?: string; email?: string };
      };

      if (!access_token || !refresh_token) {
        logger.error(`Asana OAuth: missing access/refresh token for userId=${userId}`);
        return res.redirect(errorRedirect);
      }

      const expiresAt    = new Date(Date.now() + (expires_in || 3600) * 1000);
      const asanaUserId  = data?.gid || (data?.id != null ? String(data.id) : null);
      const asanaName    = data?.name || null;
      const label        = 'Default';

      await (prisma as any).asanaOAuthToken.upsert({
        where:  { userId_label: { userId, label } },
        create: {
          userId, label,
          accessToken:  encryptWith(access_token, 'ASANA_TOKEN_ENCRYPTION_KEY'),
          refreshToken: encryptWith(refresh_token, 'ASANA_TOKEN_ENCRYPTION_KEY'),
          expiresAt, scopes: [], asanaUserId, asanaName,
        },
        update: {
          accessToken:  encryptWith(access_token, 'ASANA_TOKEN_ENCRYPTION_KEY'),
          refreshToken: encryptWith(refresh_token, 'ASANA_TOKEN_ENCRYPTION_KEY'),
          expiresAt, asanaUserId, asanaName,
        },
      });

      await invalidateIntegrationStatusCache(userId); // surface the new connection immediately (don't wait for TTL)
      logger.info(`Asana OAuth: connected userId=${userId}, user=${asanaName || 'unknown'}`);
      res.redirect(`${frontendUrl}/account?tab=integrations&asana=connected`);
    } catch (error: any) {
      const detail = error.response?.data ? JSON.stringify(error.response.data) : error.message;
      logger.error(`Asana OAuth callback error: ${detail}`);
      // A completed consent that cannot be stored (no ASANA_TOKEN_ENCRYPTION_KEY on
      // this instance) is a configuration fact, not "try again" (2026-10-20).
      if (error instanceof EncryptionKeyError) {
        res.redirect(`${frontendUrl}/account?tab=integrations&asana=not_configured&reason=encryption_key`);
        return;
      }
      res.redirect(errorRedirect);
    }
  }

  /** GET /api/crossmodel/asana/status — Check Asana connection status. */
  async getStatus(req: Request, res: Response, next: NextFunction) {
    try {
      const userId = req.user!.id;
      const configured = !!(process.env.ASANA_CLIENT_ID && process.env.ASANA_CLIENT_SECRET);
      const row = await (prisma as any).asanaOAuthToken.findFirst({
        where:  { userId },
        select: { asanaName: true, createdAt: true, label: true },
      });
      if (!row) {
        return res.json({ success: true, data: { connected: false, configured } });
      }
      res.json({
        success: true,
        data: {
          connected: true, configured,
          asanaName: row.asanaName || null, label: row.label,
          connectedAt: row.createdAt,
        },
      });
    } catch (error) { next(error); }
  }

  /** DELETE /api/crossmodel/asana/disconnect — Delete Asana token from DB. */
  async disconnect(req: Request, res: Response, next: NextFunction) {
    try {
      const userId = req.user!.id;
      const rows = await (prisma as any).asanaOAuthToken.findMany({ where: { userId } });
      if (rows.length === 0) {
        return res.json({ success: true, message: 'Not connected to Asana' });
      }
      await (prisma as any).asanaOAuthToken.deleteMany({ where: { userId } });
      await invalidateIntegrationStatusCache(userId);
      logger.info(`Asana OAuth: disconnected userId=${userId}`);
      res.json({ success: true, message: 'Asana disconnected' });
    } catch (error) { next(error); }
  }
}

export default new AsanaOAuthController();
