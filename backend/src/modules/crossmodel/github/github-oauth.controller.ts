/**
 * GitHub OAuth Controller
 *
 * Handles the GitHub OAuth 2.0 authorization flow and token management.
 * Supports multiple GitHub accounts per user (Personal, Work, custom labels).
 *
 * Endpoints:
 *   GET    /api/crossmodel/github/auth         — Start OAuth flow (redirect to GitHub)
 *   GET    /api/crossmodel/github/callback     — Handle OAuth callback from GitHub
 *   GET    /api/crossmodel/github/status       — Check first connected account (compat)
 *   GET    /api/crossmodel/github/accounts     — List all connected accounts
 *   DELETE /api/crossmodel/github/disconnect   — Revoke and delete token(s)
 */

import { Request, Response, NextFunction } from 'express';
import { randomBytes } from 'crypto';
import axios from 'axios';
import prisma from '../../../config/database';
import redisClient from '../../../config/redis';
import { encryptWith, decryptWith, EncryptionKeyError } from '../google/crypto';
import { invalidateIntegrationStatusCache } from '../langgraph/integration-status-cache';
import logger from '../../../utils/logger';

// ── OAuth configuration ────────────────────────────────────────────────────────

const GITHUB_AUTH_URL  = 'https://github.com/login/oauth/authorize';
const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const GITHUB_USER_URL  = 'https://api.github.com/user';
const GITHUB_REVOKE_URL = (clientId: string) =>
  `https://api.github.com/applications/${clientId}/token`;

const SCOPES = ['repo', 'user', 'read:org'].join(' ');

/** True when the OAuth app is configured on this instance (the Integrations tab reads it as `configured`; a pasted PAT needs only the encryption key). */
function oauthConfigured(): boolean {
  return !!(process.env.GITHUB_OAUTH_CLIENT_ID && process.env.GITHUB_OAUTH_CLIENT_SECRET);
}

function getConfig() {
  const clientId     = process.env.GITHUB_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GITHUB_OAUTH_CLIENT_SECRET;
  const frontendUrl  = (process.env.FRONTEND_URL || 'https://digby.ai').split(',')[0].trim();
  // The callback derives from THIS instance's public URL (self-host setup
  // hardening 2026-10-20); on production FRONTEND_URL's first entry is
  // https://digby.ai, so the derived value is byte-identical.
  const redirectUri  = process.env.GITHUB_OAUTH_REDIRECT_URI ||
    `${frontendUrl}/api/crossmodel/github/callback`;

  if (!clientId || !clientSecret) {
    throw new Error('GITHUB_OAUTH_CLIENT_ID and GITHUB_OAUTH_CLIENT_SECRET must be set');
  }

  return { clientId, clientSecret, redirectUri, frontendUrl };
}

/**
 * Throws EncryptionKeyError (503) when the named token-encryption env var is
 * unset or not a 32-byte hex key — a cheap pre-check so callers fail with an
 * actionable message before doing outbound API work (ticket 387a5760).
 */
function assertEncryptionKey(keyEnvVar: string): void {
  const hex = process.env[keyEnvVar];
  if (!hex) {
    throw new EncryptionKeyError(
      `${keyEnvVar} is not set on the server — this instance cannot save GitHub credentials. ` +
      'The operator must set it to a 32-byte hex key (64 hex chars, `openssl rand -hex 32`) and restart the backend. ' +
      'Self-hosted instances: see docs/SELF_HOST.md.'
    );
  }
  if (Buffer.from(hex, 'hex').length !== 32) {
    throw new EncryptionKeyError(
      `${keyEnvVar} must be 32 bytes (64 hex chars) — the operator must regenerate it ` +
      '(`openssl rand -hex 32`) and restart the backend.'
    );
  }
}

// ── State storage (Redis) ─────────────────────────────────────────────────────
// Each OAuth state stores { userId, label } as JSON.
// Single-use with 5-minute TTL.

interface OAuthStateData {
  userId: string;
  label:  string;
}

async function storeOAuthState(state: string, userId: string, label: string): Promise<void> {
  const value = JSON.stringify({ userId, label });
  await redisClient.setEx(`github_oauth_state:${state}`, 300, value);
}

async function validateAndConsumeOAuthState(state: string): Promise<OAuthStateData | null> {
  const key = `github_oauth_state:${state}`;
  const raw = await redisClient.get(key);
  if (raw) await redisClient.del(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as OAuthStateData;
  } catch {
    return { userId: raw, label: 'Personal' };
  }
}

// ── Controller ────────────────────────────────────────────────────────────────

export class GitHubOAuthController {

  /**
   * GET /api/crossmodel/github/auth
   * [requires authentication via ?token= query param]
   *
   * Generate GitHub consent URL and redirect user to GitHub for authorization.
   * Accepts ?label=Personal|Work|<custom> to tag the connected account.
   * Stores CSRF state in Redis (5-min TTL).
   */
  async startAuth(req: Request, res: Response, next: NextFunction) {
    try {
      if (!req.user) {
        res.status(401).json({ error: 'Authentication required. Please log in to connect GitHub.' });
        return;
      }
      const userId = req.user.id;
      const label  = (req.query.label as string) || 'Personal';
      if (!oauthConfigured()) {
        // Self-host setup hardening (2026-10-20): no OAuth app on this instance —
        // the tab offers the pasted-token path + the admin how-to, not a raw 500.
        const frontendUrl = (process.env.FRONTEND_URL || 'https://digby.ai').split(',')[0].trim();
        logger.warn('GitHub OAuth: GITHUB_OAUTH_CLIENT_ID / GITHUB_OAUTH_CLIENT_SECRET not configured');
        res.redirect(`${frontendUrl}/account?tab=integrations&github=not_configured`);
        return;
      }
      const { clientId, redirectUri } = getConfig();

      const state = randomBytes(32).toString('hex');
      await storeOAuthState(state, userId, label);

      const params = new URLSearchParams({
        client_id:    clientId,
        redirect_uri: redirectUri,
        scope:        SCOPES,
        state,
      });

      const consentUrl = `${GITHUB_AUTH_URL}?${params}`;
      logger.info(`GitHub OAuth: starting flow for userId=${userId}, label=${label}`);
      res.redirect(consentUrl);
    } catch (error: any) {
      logger.error('GitHub OAuth startAuth error:', error.message);
      next(error);
    }
  }

  /**
   * GET /api/crossmodel/github/callback
   * [no authentication — callback from GitHub]
   *
   * Exchange authorization code for token, encrypt, and store in DB.
   * Redirects to the frontend account page.
   *
   * GitHub returns: { access_token, token_type, scope } — no refresh_token, no expires_in.
   */
  async handleCallback(req: Request, res: Response, next: NextFunction) {
    const { code, state, error: oauthError } = req.query as Record<string, string>;
    const { clientId, clientSecret, redirectUri, frontendUrl } = getConfig();
    const errorRedirect = `${frontendUrl}/account?tab=integrations&github=error`;

    try {
      if (oauthError) {
        logger.warn(`GitHub OAuth callback error: ${oauthError}`);
        return res.redirect(errorRedirect);
      }

      if (!code || !state) {
        logger.warn('GitHub OAuth callback: missing code or state');
        return res.redirect(errorRedirect);
      }

      const stateData = await validateAndConsumeOAuthState(state);
      if (!stateData) {
        logger.warn('GitHub OAuth callback: invalid or expired state');
        return res.redirect(errorRedirect);
      }

      const { userId, label } = stateData;

      // Exchange code for token — GitHub returns JSON (not form-encoded)
      const tokenRes = await axios.post(
        GITHUB_TOKEN_URL,
        {
          client_id:     clientId,
          client_secret: clientSecret,
          code,
          redirect_uri:  redirectUri,
        },
        {
          headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json',
          },
          timeout: 15000,
        }
      );

      const { access_token, scope } = tokenRes.data as {
        access_token: string;
        token_type:   string;
        scope:        string;
      };

      if (!access_token) {
        logger.error(`GitHub OAuth: no access_token in response for userId=${userId}`);
        return res.redirect(errorRedirect);
      }

      // Fetch GitHub username for display
      let username: string | undefined;
      try {
        const userRes = await axios.get(GITHUB_USER_URL, {
          headers: { Authorization: `Bearer ${access_token}` },
          timeout: 5000,
        });
        username = userRes.data?.login;
      } catch { /* non-critical — username display only */ }

      const grantedScopes = scope ? scope.split(',') : [];

      // Upsert encrypted token in DB — keyed on (userId, label)
      await (prisma as any).gitHubOAuthToken.upsert({
        where:  { userId_label: { userId, label } },
        create: {
          userId,
          label,
          accessToken: encryptWith(access_token, 'GITHUB_TOKEN_ENCRYPTION_KEY'),
          scopes:      grantedScopes,
          username:    username || null,
        },
        update: {
          accessToken: encryptWith(access_token, 'GITHUB_TOKEN_ENCRYPTION_KEY'),
          scopes:      grantedScopes,
          username:    username || null,
        },
      });

      await invalidateIntegrationStatusCache(userId); // surface the new connection immediately (don't wait for TTL)
      logger.info(`GitHub OAuth: connected userId=${userId}, label=${label}, username=${username || 'unknown'}`);
      res.redirect(`${frontendUrl}/account?tab=integrations&github=connected`);
    } catch (error: any) {
      logger.error('GitHub OAuth callback error:', error.message);
      // A completed consent that cannot be stored (no GITHUB_TOKEN_ENCRYPTION_KEY on
      // this instance) is a configuration fact, not "try again" (2026-10-20).
      if (error instanceof EncryptionKeyError) {
        const frontendUrl = (process.env.FRONTEND_URL || 'https://digby.ai').split(',')[0].trim();
        res.redirect(`${frontendUrl}/account?tab=integrations&github=not_configured&reason=encryption_key`);
        return;
      }
      res.redirect(errorRedirect);
    }
  }

  /**
   * POST /api/crossmodel/github/pat
   * [requires authentication]
   *
   * Alternative to the OAuth flow: connect GitHub with a user-supplied Personal
   * Access Token (classic `ghp_…` or fine-grained `github_pat_…`). This is the
   * reliable fallback for private *organization* repos, where the OAuth app needs
   * separate org approval — a PAT created by an org member already carries that
   * access. The PAT is validated against GET /user, then encrypted and stored in
   * the same table the OAuth flow uses, so the MCP/token-manager path consumes it
   * identically. (PATs, like our OAuth-app tokens, are read as Bearer credentials.)
   *
   * Body: { token: string, label?: string }
   */
  async connectPat(req: Request, res: Response, next: NextFunction) {
    try {
      if (!req.user) {
        res.status(401).json({ error: 'Authentication required.' });
        return;
      }
      const userId = req.user.id;
      const token  = String((req.body?.token ?? '')).trim();
      const label  = (String(req.body?.label ?? 'Token').trim()) || 'Token';

      if (token.length < 20) {
        return res.status(400).json({ error: 'A valid GitHub personal access token is required.' });
      }
      // Loose shape check: classic (ghp_/gho_), fine-grained (github_pat_), or legacy 40-hex.
      if (!/^(ghp_|gho_|github_pat_)/.test(token) && !/^[0-9a-f]{40}$/.test(token)) {
        return res.status(400).json({ error: 'That does not look like a GitHub personal access token (expected ghp_…, github_pat_…, or a 40-char token).' });
      }

      // Fail fast (503 naming the env var) when the instance has no token
      // encryption key, BEFORE the outbound GitHub validation call — an unset
      // GITHUB_TOKEN_ENCRYPTION_KEY used to surface here as a bare 500 with a
      // leaking stack trace (ticket 387a5760). assertEncryptionKey throws
      // EncryptionKeyError (503) which next(error) renders verbatim.
      assertEncryptionKey('GITHUB_TOKEN_ENCRYPTION_KEY');

      // Validate the token + capture username and (classic only) granted scopes.
      let username: string | undefined;
      let grantedScopes: string[] = [];
      try {
        const userRes = await axios.get(GITHUB_USER_URL, {
          headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'Digby', Accept: 'application/vnd.github+json' },
          timeout: 8000,
        });
        username = userRes.data?.login;
        const scopeHeader = userRes.headers?.['x-oauth-scopes'];
        if (typeof scopeHeader === 'string' && scopeHeader.trim()) {
          grantedScopes = scopeHeader.split(',').map((s: string) => s.trim()).filter(Boolean);
        }
      } catch (err: any) {
        const status = err?.response?.status;
        logger.warn(`GitHub PAT validation failed for userId=${userId}: ${status || err.message}`);
        return res.status(400).json({
          error: 'GitHub rejected that token. Make sure it has not expired and grants repository access — the "repo" scope (classic) or repository Contents: Read (fine-grained).',
        });
      }

      // Fine-grained PATs don't expose scopes via x-oauth-scopes; record a 'repo'
      // marker so the integration-status check (which looks for 'repo') reports
      // repository access. (The user pasted it specifically to read repos.)
      if (grantedScopes.length === 0) grantedScopes = ['repo'];

      await (prisma as any).gitHubOAuthToken.upsert({
        where:  { userId_label: { userId, label } },
        create: { userId, label, accessToken: encryptWith(token, 'GITHUB_TOKEN_ENCRYPTION_KEY'), scopes: grantedScopes, username: username || null },
        update: { accessToken: encryptWith(token, 'GITHUB_TOKEN_ENCRYPTION_KEY'), scopes: grantedScopes, username: username || null },
      });

      await invalidateIntegrationStatusCache(userId); // surface the new connection immediately (don't wait for TTL)
      logger.info(`GitHub PAT: connected userId=${userId}, label=${label}, username=${username || 'unknown'}, scopes=${grantedScopes.join('|')}`);
      return res.json({ success: true, data: { username: username || null, scopes: grantedScopes, label } });
    } catch (error: any) {
      logger.error('GitHub connectPat error:', error.message);
      next(error);
    }
  }

  /**
   * GET /api/crossmodel/github/status
   * [requires authentication]
   *
   * Backward-compat: returns the first connected account's status.
   */
  async getStatus(req: Request, res: Response, next: NextFunction) {
    try {
      const userId = req.user!.id;

      const row = await (prisma as any).gitHubOAuthToken.findFirst({
        where:  { userId },
        select: { username: true, scopes: true, createdAt: true, label: true },
        orderBy: { createdAt: 'asc' },
      });

      if (!row) {
        // configured = an OAuth app exists; patSupported = a pasted token can be stored (needs only the encryption key).
        return res.json({ success: true, data: { connected: false, configured: oauthConfigured(), patSupported: !!process.env.GITHUB_TOKEN_ENCRYPTION_KEY } });
      }

      res.json({
        success: true,
        data: {
          connected:    true,
          username:     row.username || null,
          scopes:       row.scopes   || [],
          label:        row.label,
          connectedAt:  row.createdAt,
        },
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/crossmodel/github/accounts
   * [requires authentication]
   *
   * Returns all connected GitHub accounts for the current user.
   */
  async listAccounts(req: Request, res: Response, next: NextFunction) {
    try {
      const userId = req.user!.id;

      const rows = await (prisma as any).gitHubOAuthToken.findMany({
        where:   { userId },
        select:  { id: true, label: true, username: true, scopes: true, createdAt: true },
        orderBy: { createdAt: 'asc' },
      });

      res.json({
        success: true,
        data: rows.map((r: any) => ({
          id:          r.id,
          label:       r.label,
          username:    r.username || null,
          scopes:      r.scopes  || [],
          connectedAt: r.createdAt,
        })),
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * DELETE /api/crossmodel/github/disconnect
   * [requires authentication]
   *
   * Revokes the access token with GitHub and deletes the token from DB.
   * If ?label=<label> is provided, disconnects only that account.
   * Otherwise disconnects ALL accounts.
   *
   * GitHub revoke: DELETE https://api.github.com/applications/{client_id}/token
   * with Basic auth (client_id:client_secret).
   */
  async disconnect(req: Request, res: Response, next: NextFunction) {
    try {
      const userId = req.user!.id;
      const label  = typeof req.query.label === 'string' ? req.query.label : null;
      const { clientId, clientSecret } = getConfig();

      if (label) {
        const row = await (prisma as any).gitHubOAuthToken.findUnique({
          where: { userId_label: { userId, label } },
        });

        if (!row) {
          return res.json({ success: true, message: `Not connected with label "${label}"` });
        }

        // Try to revoke with GitHub (non-critical)
        try {
          const accessToken = decryptWith(row.accessToken, 'GITHUB_TOKEN_ENCRYPTION_KEY');
          await axios.delete(GITHUB_REVOKE_URL(clientId), {
            headers: {
              Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
              'Content-Type': 'application/json',
            },
            data: { access_token: accessToken },
            timeout: 5000,
          });
        } catch { /* revocation failure is non-critical */ }

        await (prisma as any).gitHubOAuthToken.delete({ where: { id: row.id } });
        await invalidateIntegrationStatusCache(userId);
        logger.info(`GitHub OAuth: disconnected userId=${userId}, label=${label}`);
        return res.json({ success: true, message: `GitHub account "${label}" disconnected` });
      }

      // No label — disconnect ALL accounts
      const rows = await (prisma as any).gitHubOAuthToken.findMany({ where: { userId } });
      if (rows.length === 0) {
        return res.json({ success: true, message: 'Not connected to GitHub' });
      }

      // Try to revoke each token (non-critical)
      await Promise.allSettled(
        rows.map(async (row: any) => {
          try {
            const accessToken = decryptWith(row.accessToken, 'GITHUB_TOKEN_ENCRYPTION_KEY');
            await axios.delete(GITHUB_REVOKE_URL(clientId), {
              headers: {
                Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
                'Content-Type': 'application/json',
              },
              data: { access_token: accessToken },
              timeout: 5000,
            });
          } catch { /* revocation failure is non-critical */ }
        })
      );

      await (prisma as any).gitHubOAuthToken.deleteMany({ where: { userId } });
      await invalidateIntegrationStatusCache(userId);
      logger.info(`GitHub OAuth: disconnected all accounts for userId=${userId}`);
      res.json({ success: true, message: 'All GitHub accounts disconnected' });
    } catch (error) {
      next(error);
    }
  }
}

export default new GitHubOAuthController();
