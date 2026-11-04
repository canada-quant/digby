/**
 * Google OAuth Controller
 *
 * Handles the Google OAuth 2.0 authorization flow and token management.
 * Supports multiple Google accounts per user (Personal, Work, custom labels).
 *
 * Endpoints:
 *   GET    /api/crossmodel/google/auth          — Start OAuth flow (redirect to Google)
 *   GET    /api/crossmodel/google/callback      — Handle OAuth callback from Google
 *   GET    /api/crossmodel/google/status        — Check first connected account (compat)
 *   GET    /api/crossmodel/google/accounts      — List all connected accounts
 *   PATCH  /api/crossmodel/google/accounts/:id/label — Rename an account's label
 *   DELETE /api/crossmodel/google/disconnect    — Revoke and delete token(s)
 *   POST   /api/crossmodel/google/send-email    — Send email (called after UI confirmation)
 */

import { Request, Response, NextFunction } from 'express';
import { randomBytes } from 'crypto';
import axios from 'axios';
import prisma from '../../../config/database';
import redisClient from '../../../config/redis';
import { encrypt, decrypt, EncryptionKeyError } from './crypto';
import { sendGmailEmail } from './google-mcp';
import { GOOGLE_ALL_SCOPES, missingGoogleWriteScopes } from './google-scopes';
import { invalidateIntegrationStatusCache } from '../langgraph/integration-status-cache';
import logger from '../../../utils/logger';

// ── OAuth configuration ────────────────────────────────────────────────────────

const GOOGLE_AUTH_URL   = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL  = 'https://oauth2.googleapis.com/token';
const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';

// Scopes requested — read + (2026-09-23) editing scopes for Docs/Sheets/Slides/
// Drive uploads/Gmail drafts. ONE list in google-scopes.ts (shared with the
// status badge + the agent write precheck). Existing accounts re-consent via
// the same /auth flow (prompt=consent, same label → row updated in place).
const SCOPES = GOOGLE_ALL_SCOPES.join(' ');

/** True when the OAuth app is configured on this instance (the Integrations tab reads it as `configured`). */
function oauthConfigured(): boolean {
  return !!(process.env.GOOGLE_OAUTH_CLIENT_ID && process.env.GOOGLE_OAUTH_CLIENT_SECRET);
}

function getConfig() {
  const clientId     = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const frontendUrl  = (process.env.FRONTEND_URL || 'https://digby.example.com').split(',')[0].trim();
  // The callback derives from THIS instance's public URL (self-host setup
  // hardening 2026-10-20): a self-host without the explicit override used to
  // send its OAuth dance to production. On production FRONTEND_URL's first
  // entry is https://digby.example.com, so the derived value is byte-identical.
  const redirectUri  = process.env.GOOGLE_OAUTH_REDIRECT_URI ||
    `${frontendUrl}/api/crossmodel/google/callback`;

  if (!clientId || !clientSecret) {
    throw new Error('GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET must be set');
  }

  return { clientId, clientSecret, redirectUri, frontendUrl };
}

// ── State storage (Redis) ─────────────────────────────────────────────────────
// Each OAuth state stores { userId, label } as JSON.
// Single-use with 5-minute TTL.

interface OAuthStateData {
  userId: string;
  label:  string;
}

// Use the shared Redis singleton — avoids creating a new connection per OAuth state operation.
// Previously each call created its own client + connection, leading to connection leaks
// when the client.quit() path was not reached (e.g. on exceptions).

async function storeOAuthState(state: string, userId: string, label: string): Promise<void> {
  const value = JSON.stringify({ userId, label });
  await redisClient.setEx(`google_oauth_state:${state}`, 300, value); // 5 min TTL
}

async function validateAndConsumeOAuthState(state: string): Promise<OAuthStateData | null> {
  const key = `google_oauth_state:${state}`;
  // Atomic GET+DEL: fetch the value, then delete it (single-use CSRF token)
  const raw = await redisClient.get(key);
  if (raw) await redisClient.del(key); // consume — single-use
  if (!raw) return null;
  try {
    return JSON.parse(raw) as OAuthStateData;
  } catch {
    // Legacy: older states stored just userId string — treat as Personal
    return { userId: raw, label: 'Personal' };
  }
}

// ── Controller ────────────────────────────────────────────────────────────────

export class GoogleOAuthController {

  /**
   * GET /api/crossmodel/google/auth
   * [requires authentication via ?token= query param]
   *
   * Generate Google consent URL and redirect user to Google for authorization.
   * Accepts ?label=Personal|Work|<custom> to tag the connected account.
   * Stores CSRF state in Redis (5-min TTL).
   */
  async startAuth(req: Request, res: Response, next: NextFunction) {
    try {
      // optionalAuthenticate reads ?token= query param (needed for browser redirect flows)
      if (!req.user) {
        res.status(401).json({ error: 'Authentication required. Please log in to connect Google.' });
        return;
      }
      const userId = req.user.id;
      const label  = (req.query.label as string) || 'Personal';
      if (!oauthConfigured()) {
        // Self-host setup hardening (2026-10-20): the same not_configured redirect
        // Slack/Asana use — the tab says "not set up on this instance" + the how-to
        // instead of landing the browser on a raw 500 page.
        const frontendUrl = (process.env.FRONTEND_URL || 'https://digby.example.com').split(',')[0].trim();
        logger.warn('Google OAuth: GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET not configured');
        res.redirect(`${frontendUrl}/account?tab=integrations&google=not_configured`);
        return;
      }
      const { clientId, redirectUri } = getConfig();

      const state = randomBytes(32).toString('hex');
      await storeOAuthState(state, userId, label);

      const params = new URLSearchParams({
        client_id:     clientId,
        redirect_uri:  redirectUri,
        response_type: 'code',
        scope:         SCOPES,
        access_type:   'offline',
        prompt:        'consent',  // always show consent to ensure refresh_token is returned
        state,
      });

      const consentUrl = `${GOOGLE_AUTH_URL}?${params}`;
      logger.info(`Google OAuth: starting flow for userId=${userId}, label=${label}`);
      res.redirect(consentUrl);
    } catch (error: any) {
      logger.error('Google OAuth startAuth error:', error.message);
      next(error);
    }
  }

  /**
   * GET /api/crossmodel/google/callback
   * [no authentication — callback from Google]
   *
   * Exchange authorization code for tokens, encrypt, and store in DB.
   * Redirects to the frontend account page.
   */
  async handleCallback(req: Request, res: Response, next: NextFunction) {
    const { code, state, error: oauthError } = req.query as Record<string, string>;
    const { clientId, clientSecret, redirectUri, frontendUrl } = getConfig();
    const errorRedirect = `${frontendUrl}/account?tab=integrations&google=error`;

    try {
      if (oauthError) {
        logger.warn(`Google OAuth callback error: ${oauthError}`);
        return res.redirect(errorRedirect);
      }

      if (!code || !state) {
        logger.warn('Google OAuth callback: missing code or state');
        return res.redirect(errorRedirect);
      }

      // Validate CSRF state and extract userId + label
      const stateData = await validateAndConsumeOAuthState(state);
      if (!stateData) {
        logger.warn('Google OAuth callback: invalid or expired state');
        return res.redirect(errorRedirect);
      }

      const { userId, label } = stateData;

      // Exchange code for tokens
      const params = new URLSearchParams({
        code,
        client_id:     clientId,
        client_secret: clientSecret,
        redirect_uri:  redirectUri,
        grant_type:    'authorization_code',
      });

      const tokenRes = await axios.post(
        GOOGLE_TOKEN_URL,
        params.toString(),
        {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          timeout: 15000,
        }
      );

      const { access_token, refresh_token, expires_in, scope } = tokenRes.data as {
        access_token:  string;
        refresh_token: string;
        expires_in:    number;
        scope:         string;
        token_type:    string;
      };

      if (!refresh_token) {
        // Google only returns refresh_token on first authorization (or with prompt=consent).
        // This shouldn't happen since we set prompt=consent, but handle it gracefully.
        logger.error(`Google OAuth: no refresh_token in response for userId=${userId}`);
        return res.redirect(errorRedirect);
      }

      // Get the user's Google email for display purposes
      let googleEmail: string | undefined;
      try {
        const infoRes = await axios.get('https://www.googleapis.com/oauth2/v2/userinfo', {
          headers: { Authorization: `Bearer ${access_token}` },
          timeout: 5000,
        });
        googleEmail = infoRes.data.email;
      } catch { /* non-critical — email display only */ }

      const expiresAt    = new Date(Date.now() + expires_in * 1000);
      const grantedScopes = scope.split(' ');

      // Upsert encrypted token in DB — keyed on (userId, label)
      await (prisma as any).googleOAuthToken.upsert({
        where:  { userId_label: { userId, label } },
        create: {
          userId,
          label,
          accessToken:  encrypt(access_token),
          refreshToken: encrypt(refresh_token),
          expiresAt,
          scopes:       grantedScopes,
          email:        googleEmail || null,
        },
        update: {
          accessToken:  encrypt(access_token),
          refreshToken: encrypt(refresh_token),
          expiresAt,
          scopes:       grantedScopes,
          email:        googleEmail || null,
        },
      });

      await invalidateIntegrationStatusCache(userId); // surface the new connection immediately (don't wait for TTL)
      logger.info(`Google OAuth: connected userId=${userId}, label=${label}, email=${googleEmail || 'unknown'}`);
      res.redirect(`${frontendUrl}/account?tab=integrations&google=connected`);
    } catch (error: any) {
      logger.error('Google OAuth callback error:', error.message);
      // A completed consent that cannot be stored (no GOOGLE_TOKEN_ENCRYPTION_KEY on
      // this instance) is a configuration fact, not "try again" (2026-10-20).
      if (error instanceof EncryptionKeyError) {
        const frontendUrl = (process.env.FRONTEND_URL || 'https://digby.example.com').split(',')[0].trim();
        res.redirect(`${frontendUrl}/account?tab=integrations&google=not_configured&reason=encryption_key`);
        return;
      }
      res.redirect(errorRedirect);
    }
  }

  /**
   * GET /api/crossmodel/google/status
   * [requires authentication]
   *
   * Backward-compat: returns the first connected account's status.
   * New code should use /accounts instead.
   */
  async getStatus(req: Request, res: Response, next: NextFunction) {
    try {
      const userId = req.user!.id;

      const row = await (prisma as any).googleOAuthToken.findFirst({
        where:  { userId },
        select: { email: true, scopes: true, expiresAt: true, createdAt: true, label: true },
        orderBy: { createdAt: 'asc' },
      });

      if (!row) {
        return res.json({ success: true, data: { connected: false, configured: oauthConfigured() } });
      }

      res.json({
        success: true,
        data: {
          connected: true,
          email:      row.email    || null,
          scopes:     row.scopes   || [],
          label:      row.label,
          expiresAt:  row.expiresAt,
          connectedAt: row.createdAt,
        },
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/crossmodel/google/accounts
   * [requires authentication]
   *
   * Returns all connected Google accounts for the current user.
   */
  async listAccounts(req: Request, res: Response, next: NextFunction) {
    try {
      const userId = req.user!.id;

      const rows = await (prisma as any).googleOAuthToken.findMany({
        where:   { userId },
        select:  { id: true, label: true, email: true, scopes: true, expiresAt: true, createdAt: true },
        orderBy: { createdAt: 'asc' },
      });

      res.json({
        success: true,
        data: rows.map((r: any) => ({
          id:          r.id,
          label:       r.label,
          email:       r.email   || null,
          scopes:      r.scopes  || [],
          missingWriteScopes: missingGoogleWriteScopes(r.scopes || []), // 2026-09-23: drives the "Update permissions" CTA
          expiresAt:   r.expiresAt,
          connectedAt: r.createdAt,
        })),
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * PATCH /api/crossmodel/google/accounts/:id/label
   * [requires authentication]
   *
   * Renames the display label of one of the current user's connected Google
   * accounts (feedback abeb36a2 — e.g. relabel "Work" → "Sunday Market Media").
   * Body: { label: string } — 1–40 chars after trim.
   * 400 invalid label · 404 account id is not one of the user's · 409 another of
   * the user's accounts already uses the label (labels are unique per user).
   */
  async updateAccountLabel(req: Request, res: Response, next: NextFunction) {
    try {
      const userId = req.user!.id;
      const id     = req.params.id;
      const raw    = (req.body as any)?.label;
      const label  = typeof raw === 'string' ? raw.trim() : '';

      if (!label || label.length > 40) {
        return res.status(400).json({ success: false, error: 'Label must be 1–40 characters' });
      }

      // Ownership scoping: the id must resolve to a row owned by THIS user.
      const row = await (prisma as any).googleOAuthToken.findFirst({ where: { id, userId } });
      if (!row) {
        return res.status(404).json({ success: false, error: 'Google account not found' });
      }

      const payload = (r: any) => ({
        id:          r.id,
        label:       r.label,
        email:       r.email   || null,
        scopes:      r.scopes  || [],
        expiresAt:   r.expiresAt,
        connectedAt: r.createdAt,
      });

      if (row.label === label) {
        return res.json({ success: true, data: payload(row) }); // no-op rename
      }

      const conflict = await (prisma as any).googleOAuthToken.findFirst({
        where: { userId, label, NOT: { id } },
      });
      if (conflict) {
        return res.status(409).json({ success: false, error: `Another connected account already uses the label "${label}"` });
      }

      const updated = await (prisma as any).googleOAuthToken.update({ where: { id }, data: { label } });
      logger.info(`Google OAuth: relabeled account id=${id} for userId=${userId}: "${row.label}" → "${label}"`);
      res.json({ success: true, data: payload(updated) });
    } catch (error) {
      next(error);
    }
  }

  /**
   * DELETE /api/crossmodel/google/disconnect
   * [requires authentication]
   *
   * Revokes the access token with Google and deletes the token from DB.
   * If ?label=<label> is provided, disconnects only that account.
   * Otherwise disconnects ALL accounts (backward compat).
   */
  async disconnect(req: Request, res: Response, next: NextFunction) {
    try {
      const userId = req.user!.id;
      const label  = typeof req.query.label === 'string' ? req.query.label : null;

      if (label) {
        // Disconnect specific account by label
        const row = await (prisma as any).googleOAuthToken.findUnique({
          where: { userId_label: { userId, label } },
        });

        if (!row) {
          return res.json({ success: true, message: `Not connected with label "${label}"` });
        }

        // Try to revoke with Google (non-critical)
        try {
          const accessToken = decrypt(row.accessToken);
          await axios.post(`${GOOGLE_REVOKE_URL}?token=${accessToken}`, {}, { timeout: 5000 });
        } catch { /* revocation failure is non-critical */ }

        await (prisma as any).googleOAuthToken.delete({ where: { id: row.id } });
        await invalidateIntegrationStatusCache(userId);
        logger.info(`Google OAuth: disconnected userId=${userId}, label=${label}`);
        return res.json({ success: true, message: `Google account "${label}" disconnected` });
      }

      // No label — disconnect ALL accounts
      const rows = await (prisma as any).googleOAuthToken.findMany({ where: { userId } });
      if (rows.length === 0) {
        return res.json({ success: true, message: 'Not connected to Google' });
      }

      // Try to revoke each token (non-critical)
      await Promise.allSettled(
        rows.map(async (row: any) => {
          try {
            const accessToken = decrypt(row.accessToken);
            await axios.post(`${GOOGLE_REVOKE_URL}?token=${accessToken}`, {}, { timeout: 5000 });
          } catch { /* revocation failure is non-critical */ }
        })
      );

      await (prisma as any).googleOAuthToken.deleteMany({ where: { userId } });
      await invalidateIntegrationStatusCache(userId);
      logger.info(`Google OAuth: disconnected all accounts for userId=${userId}`);
      res.json({ success: true, message: 'All Google accounts disconnected' });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /api/crossmodel/google/send-email
   * [requires authentication]
   *
   * Send an email on behalf of the user after explicit UI confirmation.
   * Body: { to, subject, body, cc?, bcc?, label? }
   * label: which Google account to use (defaults to first connected)
   */
  async sendEmail(req: Request, res: Response, next: NextFunction) {
    try {
      const userId = req.user!.id;
      const { to, subject, body, cc, bcc, label } = req.body as {
        to:      string;
        subject: string;
        body:    string;
        cc?:     string;
        bcc?:    string;
        label?:  string;
      };

      if (!to?.trim())      return res.status(400).json({ error: '"to" is required' });
      if (!subject?.trim()) return res.status(400).json({ error: '"subject" is required' });
      if (!body?.trim())    return res.status(400).json({ error: '"body" is required' });

      const result = await sendGmailEmail(userId, to.trim(), subject.trim(), body.trim(), cc, bcc, label?.trim() || undefined);

      if (!result.success) {
        logger.warn(`send-email failed for userId=${userId}: ${result.error}`);
        return res.status(502).json({ success: false, error: result.error });
      }

      logger.info(`send-email success for userId=${userId} to=${to}${label ? ` from=${label}` : ''}`);
      res.json({ success: true, messageId: result.messageId, label: label || null });
    } catch (error) {
      next(error);
    }
  }
}

export default new GoogleOAuthController();
