/**
 * Xero OAuth Controller
 *
 * Handles the Xero OAuth 2.0 authorization flow and token management.
 *
 * Endpoints:
 *   GET    /api/crossmodel/xero/auth        — Start OAuth flow (redirect to Xero)
 *   GET    /api/crossmodel/xero/callback     — Handle OAuth callback from Xero
 *   GET    /api/crossmodel/xero/status       — Check connection status
 *   GET    /api/crossmodel/xero/debug-config — Show OAuth config (no secrets) for debugging
 *   DELETE /api/crossmodel/xero/disconnect   — Revoke and delete token
 */

import { Request, Response, NextFunction } from 'express';
import { randomBytes, createHash } from 'crypto';
import axios from 'axios';
import prisma from '../../../config/database';
import redisClient from '../../../config/redis';
import { encrypt, EncryptionKeyError } from '../google/crypto';
import { invalidateIntegrationStatusCache } from '../langgraph/integration-status-cache';
import logger from '../../../utils/logger';

// ── OAuth configuration ────────────────────────────────────────────────────────

const XERO_AUTH_URL  = 'https://login.xero.com/identity/connect/authorize';
const XERO_TOKEN_URL = 'https://identity.xero.com/connect/token';
const XERO_CONNECTIONS_URL = 'https://api.xero.com/connections';

// Xero scopes — `offline_access` is required to receive a refresh_token.
// Accounting scopes (accounting.transactions.read, etc.) require the Xero app
// to have the Accounting API enabled in the Xero Developer Portal.  If the app
// only has basic OpenID Connect access, requesting accounting scopes causes
// Xero to reject the auth request with "unauthorized_client Invalid scope".
//
// The env var XERO_SCOPES lets the operator add accounting scopes once the
// Xero app is configured for them, e.g.:
//   XERO_SCOPES=openid profile email offline_access accounting.transactions.read accounting.contacts.read accounting.settings.read accounting.reports.read
const DEFAULT_SCOPES = 'openid profile email offline_access';
const SCOPES = process.env.XERO_SCOPES || DEFAULT_SCOPES;

// PKCE — Xero's OIDC discovery advertises S256 code_challenge support.
// We ALWAYS send PKCE params (code_challenge in auth URL, code_verifier in token
// exchange) because Xero may require them depending on the app type configured in
// the Developer Portal.  Sending PKCE to a Web app is harmless — Xero simply
// ignores the code_challenge if the app doesn't require it.  NOT sending PKCE to
// a PKCE-type app causes "Sorry, something went wrong" after login.

function getConfig() {
  const clientId     = process.env.XERO_CLIENT_ID;
  const clientSecret = process.env.XERO_CLIENT_SECRET;
  const frontendUrl  = (process.env.FRONTEND_URL || 'https://digby.example.com')
    .split(',')[0].trim();
  // Derived from THIS instance's public URL (self-host setup hardening, 2026-10-20) —
  // the callback the Setup checklist tells the admin to register; the env overrides.
  const redirectUri  = process.env.XERO_OAUTH_REDIRECT_URI ||
    `${frontendUrl}/api/crossmodel/xero/callback`;

  if (!clientId || !clientSecret) {
    throw new Error('XERO_CLIENT_ID and XERO_CLIENT_SECRET must be set');
  }

  return { clientId, clientSecret, redirectUri, frontendUrl };
}

// ── PKCE helpers ──────────────────────────────────────────────────────────────

/** Generate a random code_verifier (43–128 chars, URL-safe) for PKCE. */
function generateCodeVerifier(): string {
  return randomBytes(32).toString('base64url');  // 43 chars
}

/** Derive the S256 code_challenge from a code_verifier. */
function generateCodeChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

// ── State storage (Redis) ─────────────────────────────────────────────────────

async function storeOAuthState(state: string, userId: string, codeVerifier: string, label?: string): Promise<void> {
  // Store userId, codeVerifier and the user-chosen label together so the
  // callback can retrieve all three (ticket 64a25e8d — multi-account labels).
  const payload = JSON.stringify({ userId, codeVerifier, label: label || null });
  await redisClient.setEx(`xero_oauth_state:${state}`, 300, payload);
}

async function validateAndConsumeOAuthState(state: string): Promise<{ userId: string; codeVerifier: string; label: string | null } | null> {
  const key = `xero_oauth_state:${state}`;
  const raw = await redisClient.get(key);
  if (!raw) return null;
  await redisClient.del(key);
  try {
    const parsed = JSON.parse(raw);
    return { userId: parsed.userId, codeVerifier: parsed.codeVerifier, label: parsed.label ?? null };
  } catch {
    // Legacy format (plain userId string) — no codeVerifier/label available
    return { userId: raw, codeVerifier: '', label: null };
  }
}

// ── Controller ────────────────────────────────────────────────────────────────

export class XeroOAuthController {

  /** GET /api/crossmodel/xero/auth — Start Xero OAuth flow. */
  async startAuth(req: Request, res: Response, next: NextFunction) {
    try {
      if (!req.user) {
        // 2026-09-12 (ticket 8cb3aa34 class): this endpoint is a BROWSER
        // NAVIGATION target (the integrations card does window.location.href
        // here) — a bare 401 JSON body renders as a white page with no way
        // back inside the Mac app's chromeless webview. Redirect to the real
        // UI, which toasts the reason and keeps navigation chrome.
        const frontendUrl = (process.env.FRONTEND_URL || 'https://digby.example.com').split(',')[0].trim();
        return res.redirect(`${frontendUrl}/account?tab=integrations&xero=auth_required`);
      }

      // Gracefully handle missing Xero credentials — redirect to frontend with
      // a clear error instead of throwing a 500 "Internal server error".
      const clientId     = process.env.XERO_CLIENT_ID;
      const clientSecret = process.env.XERO_CLIENT_SECRET;
      if (!clientId || !clientSecret) {
        const frontendUrl = (process.env.FRONTEND_URL || 'https://digby.example.com').split(',')[0].trim();
        logger.warn('Xero OAuth: XERO_CLIENT_ID / XERO_CLIENT_SECRET not configured');
        // not_configured (2026-10-20, self-host setup hardening): the Integrations tab
        // renders "not set up on this instance" + the admin how-to, not a transient error.
        return res.redirect(`${frontendUrl}/account?tab=integrations&xero=not_configured`);
      }

      const userId = req.user.id;
      const { redirectUri } = getConfig();
      const state = randomBytes(32).toString('hex');

      // 2026-09-12 (ticket 64a25e8d): multi-account labels — the label decides
      // "add another account" vs "reconnect": the callback upserts on
      // (userId, label), so a new label inserts a row, an existing label
      // overwrites tokens. Default 'Default' matches the schema default.
      const rawLabel = typeof req.query.label === 'string' ? req.query.label.trim() : '';
      const label = (rawLabel || 'Default').slice(0, 40);

      // Generate PKCE params.  Xero's OIDC discovery advertises S256 support.
      const codeVerifier  = generateCodeVerifier();
      const codeChallenge = generateCodeChallenge(codeVerifier);
      await storeOAuthState(state, userId, codeVerifier, label);

      // Build the authorization URL manually using encodeURIComponent so that
      // spaces in the scope string are encoded as %20 (not + which
      // URLSearchParams produces).  Some OAuth servers are strict about this.
      const authUrl = XERO_AUTH_URL
        + '?response_type=code'
        + '&client_id=' + encodeURIComponent(clientId)
        + '&redirect_uri=' + encodeURIComponent(redirectUri)
        + '&scope=' + encodeURIComponent(SCOPES)
        + '&state=' + encodeURIComponent(state)
        + '&code_challenge=' + encodeURIComponent(codeChallenge)
        + '&code_challenge_method=S256';

      logger.info(`Xero OAuth: starting flow userId=${userId}, redirect_uri=${redirectUri}, scopes=${SCOPES}`);
      logger.info(`Xero OAuth: auth URL = ${authUrl}`);
      res.redirect(authUrl);
    } catch (error: any) {
      logger.error('Xero OAuth startAuth error:', error.message);
      next(error);
    }
  }

  /** GET /api/crossmodel/xero/callback — Handle OAuth callback from Xero. */
  async handleCallback(req: Request, res: Response, _next: NextFunction) {
    // Log the FULL callback URL for debugging — captures all params Xero sends
    logger.info(`Xero OAuth callback hit: url=${req.originalUrl}, params=${JSON.stringify(req.query)}`);

    const { code, state, error: oauthError, error_description: oauthErrorDesc } = req.query as Record<string, string>;
    const frontendUrl = (process.env.FRONTEND_URL || 'https://digby.example.com').split(',')[0].trim();
    const errorRedirect = `${frontendUrl}/account?tab=integrations&xero=error`;

    // Guard: if credentials are missing the token exchange will fail anyway
    const clientId     = process.env.XERO_CLIENT_ID;
    const clientSecret = process.env.XERO_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      logger.warn('Xero OAuth callback: XERO_CLIENT_ID / XERO_CLIENT_SECRET not configured');
      return res.redirect(errorRedirect);
    }

    const redirectUri = process.env.XERO_OAUTH_REDIRECT_URI ||
      `${frontendUrl}/api/crossmodel/xero/callback`;

    try {
      if (oauthError || !code || !state) {
        const detail = oauthError
          ? `error=${oauthError}, description=${oauthErrorDesc || 'none'}`
          : `missing code/state (code=${!!code}, state=${!!state})`;
        logger.warn(`Xero OAuth callback: ${detail}`);
        return res.redirect(errorRedirect);
      }
      const stateData = await validateAndConsumeOAuthState(state);
      if (!stateData) {
        logger.warn('Xero OAuth callback: invalid or expired state');
        return res.redirect(errorRedirect);
      }
      const { userId, codeVerifier, label: stateLabel } = stateData;

      // Exchange code for tokens.
      // Send client_id, client_secret, AND code_verifier in the POST body.
      // This covers both app types:
      //   • Web app (confidential): uses client_secret, ignores code_verifier
      //   • PKCE app (public): uses code_verifier, ignores client_secret
      // Xero's token endpoint supports client_secret_post (credentials in body).
      const tokenParams: Record<string, string> = {
        grant_type: 'authorization_code', code,
        redirect_uri: redirectUri,
        client_id: clientId,
        client_secret: clientSecret,
      };
      // Always include code_verifier if we have one (from PKCE in startAuth)
      if (codeVerifier) {
        tokenParams.code_verifier = codeVerifier;
      }

      logger.info(`Xero OAuth: exchanging code for tokens, userId=${userId}, has_verifier=${!!codeVerifier}`);
      const tokenRes = await axios.post(XERO_TOKEN_URL,
        new URLSearchParams(tokenParams).toString(),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 15000 }
      );
      const { access_token, refresh_token, expires_in, scope } = tokenRes.data;
      if (!refresh_token) {
        // offline_access scope is required for refresh tokens.  If the Xero app
        // doesn't grant it we can still save the access token — it just won't
        // auto-refresh and the user will need to reconnect when it expires.
        logger.warn(`Xero OAuth: no refresh_token for userId=${userId} (offline_access may not be granted)`);
      }

      // Get connected tenants (organisations).
      // With basic scopes (openid profile email offline_access) Xero may return
      // an empty connections list because no accounting API access was granted.
      // This is NOT an error — the user successfully authenticated.  We save the
      // token with a placeholder tenantId so the connection is recorded.  When
      // accounting scopes are added later the tenant will be populated on re-auth.
      //
      // IMPORTANT: Do NOT treat empty connections as an error.  The token exchange
      // succeeded — the user is authenticated.  Redirecting to errorRedirect here
      // would discard valid tokens and show "Failed to connect Xero" to the user.
      let tenantId = '';
      let orgName: string | undefined;
      try {
        const connRes = await axios.get(XERO_CONNECTIONS_URL, {
          headers: { Authorization: `Bearer ${access_token}` }, timeout: 10000,
        });
        const tenants = connRes.data as Array<{ tenantId: string; tenantName: string }>;
        logger.info(`Xero OAuth: connections response (${tenants.length} tenants) for userId=${userId}: ${JSON.stringify(tenants)}`);
        if (tenants.length > 0) {
          tenantId = tenants[0].tenantId;
          orgName  = tenants[0].tenantName;
        }
      } catch (err: any) {
        logger.warn(`Xero OAuth: failed to fetch /connections: ${err.message} — continuing with placeholder tenant`);
      }
      if (!tenantId) {
        // No tenant — user authenticated but no org connected (basic scopes only).
        // Use a placeholder so we can still save the token and mark as connected.
        tenantId = 'pending';
        logger.info(`Xero OAuth: no tenant for userId=${userId} — saving with tenantId='pending' (basic scopes only)`);
      }

      const expiresAt = new Date(Date.now() + expires_in * 1000);
      const grantedScopes = (scope || '').split(' ');
      // 2026-09-12 (ticket 64a25e8d): a user-chosen label from the auth start
      // wins (that's how "add another account" works); legacy states without a
      // label keep the pre-existing orgName-derived labelling.
      const label = stateLabel || orgName || 'Default';

      await (prisma as any).xeroOAuthToken.upsert({
        where: { userId_label: { userId, label } },
        create: {
          userId, label, tenantId,
          accessToken: encrypt(access_token), refreshToken: refresh_token ? encrypt(refresh_token) : '',
          expiresAt, scopes: grantedScopes, orgName: orgName || null,
        },
        update: {
          tenantId,
          accessToken: encrypt(access_token), refreshToken: refresh_token ? encrypt(refresh_token) : '',
          expiresAt, scopes: grantedScopes, orgName: orgName || null,
        },
      });

      await invalidateIntegrationStatusCache(userId); // surface the new connection immediately (don't wait for TTL)
      logger.info(`Xero OAuth: connected userId=${userId}, org=${orgName}`);
      res.redirect(`${frontendUrl}/account?tab=integrations&xero=connected`);
    } catch (error: any) {
      // The consent succeeded but this instance cannot STORE the token (no
      // GOOGLE_TOKEN_ENCRYPTION_KEY) — tell the Integrations tab which key, not
      // a generic error (2026-10-20 self-host hardening; prod sets the key).
      if (error instanceof EncryptionKeyError) {
        logger.warn(`Xero OAuth callback: ${error.message}`);
        res.redirect(`${frontendUrl}/account?tab=integrations&xero=not_configured&reason=encryption_key`);
        return;
      }
      // Log full details for debugging — Xero errors often have useful info in response.data
      const detail = error.response?.data ? JSON.stringify(error.response.data) : error.message;
      logger.error(`Xero OAuth callback error: ${detail}`);
      res.redirect(errorRedirect);
    }
  }

  /** GET /api/crossmodel/xero/status — Check Xero connection status. */
  async getStatus(req: Request, res: Response, next: NextFunction) {
    try {
      const userId = req.user!.id;
      const configured = !!(process.env.XERO_CLIENT_ID && process.env.XERO_CLIENT_SECRET);
      const row = await (prisma as any).xeroOAuthToken.findFirst({
        where: { userId },
        select: { orgName: true, scopes: true, expiresAt: true, createdAt: true, label: true },
      });
      if (!row) {
        return res.json({ success: true, data: { connected: false, configured } });
      }
      res.json({
        success: true,
        data: {
          connected: true, configured, orgName: row.orgName || null, label: row.label,
          scopes: row.scopes || [], expiresAt: row.expiresAt, connectedAt: row.createdAt,
        },
      });
    } catch (error) { next(error); }
  }

  /** GET /api/crossmodel/xero/debug-config — Show OAuth config for debugging (no secrets exposed). */
  async debugConfig(_req: Request, res: Response) {
    const clientId = process.env.XERO_CLIENT_ID || '';
    const redirectUri = process.env.XERO_OAUTH_REDIRECT_URI || `${(process.env.FRONTEND_URL || 'https://digby.example.com').split(',')[0].trim()}/api/crossmodel/xero/callback`;
    const scopes = SCOPES;
    res.json({
      configured: !!(process.env.XERO_CLIENT_ID && process.env.XERO_CLIENT_SECRET),
      clientId: clientId ? clientId.substring(0, 8) + '...' : '(not set)',
      redirectUri,
      scopes,
      note: 'Ensure the redirect_uri above EXACTLY matches what is registered in the Xero Developer Portal (My Apps → Digby → Configuration → OAuth 2.0 redirect URIs). Even a trailing slash difference will cause "Sorry, something went wrong".',
    });
  }

  /**
   * GET /api/crossmodel/xero/accounts
   * [requires authentication]
   *
   * Returns all connected Xero accounts for the current user (ticket 64a25e8d —
   * Google-parity multi-account). Labels are unique per user
   * (@@unique([userId, label])).
   */
  async listAccounts(req: Request, res: Response, next: NextFunction) {
    try {
      const userId = req.user!.id;

      const rows = await (prisma as any).xeroOAuthToken.findMany({
        where:   { userId },
        select:  { id: true, label: true, orgName: true, scopes: true, expiresAt: true, createdAt: true },
        orderBy: { createdAt: 'asc' },
      });

      res.json({
        success: true,
        data: rows.map((r: any) => ({
          id:          r.id,
          label:       r.label,
          orgName:     r.orgName || null,
          scopes:      r.scopes  || [],
          expiresAt:   r.expiresAt,
          connectedAt: r.createdAt,
        })),
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * PATCH /api/crossmodel/xero/accounts/:id/label
   * [requires authentication]
   *
   * Renames the display label of one of the current user's connected Xero
   * accounts (ticket 64a25e8d — mirrors google-oauth.controller.ts
   * updateAccountLabel). Body: { label: string } — 1–40 chars after trim.
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
      const row = await (prisma as any).xeroOAuthToken.findFirst({ where: { id, userId } });
      if (!row) {
        return res.status(404).json({ success: false, error: 'Xero account not found' });
      }

      const payload = (r: any) => ({
        id:          r.id,
        label:       r.label,
        orgName:     r.orgName || null,
        scopes:      r.scopes  || [],
        expiresAt:   r.expiresAt,
        connectedAt: r.createdAt,
      });

      if (row.label === label) {
        return res.json({ success: true, data: payload(row) }); // no-op rename
      }

      const conflict = await (prisma as any).xeroOAuthToken.findFirst({
        where: { userId, label, NOT: { id } },
      });
      if (conflict) {
        return res.status(409).json({ success: false, error: `Another connected account already uses the label "${label}"` });
      }

      const updated = await (prisma as any).xeroOAuthToken.update({ where: { id }, data: { label } });
      logger.info(`Xero OAuth: relabeled account id=${id} for userId=${userId}: "${row.label}" → "${label}"`);
      res.json({ success: true, data: payload(updated) });
    } catch (error) {
      next(error);
    }
  }

  /** DELETE /api/crossmodel/xero/disconnect — Delete Xero token from DB. */
  async disconnect(req: Request, res: Response, next: NextFunction) {
    try {
      const userId = req.user!.id;
      // 2026-09-12 (ticket 64a25e8d): ?label=<label> disconnects only that
      // account (Google parity); absent disconnects ALL (backward compat).
      const label = typeof req.query.label === 'string' ? req.query.label.trim() : '';
      if (label) {
        const row = await (prisma as any).xeroOAuthToken.findUnique({
          where: { userId_label: { userId, label } },
        });
        if (!row) {
          return res.status(404).json({ success: false, error: `No connected Xero account with label "${label}"` });
        }
        await (prisma as any).xeroOAuthToken.delete({ where: { id: row.id } });
        await invalidateIntegrationStatusCache(userId);
        logger.info(`Xero OAuth: disconnected label="${label}" for userId=${userId}`);
        return res.json({ success: true, message: `Xero account "${label}" disconnected` });
      }
      const rows = await (prisma as any).xeroOAuthToken.findMany({ where: { userId } });
      if (rows.length === 0) {
        return res.json({ success: true, message: 'Not connected to Xero' });
      }
      await (prisma as any).xeroOAuthToken.deleteMany({ where: { userId } });
      await invalidateIntegrationStatusCache(userId);
      logger.info(`Xero OAuth: disconnected userId=${userId}`);
      res.json({ success: true, message: 'Xero disconnected' });
    } catch (error) { next(error); }
  }
}

export default new XeroOAuthController();

