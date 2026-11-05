/**
 * Slack OAuth Controller
 *
 * Handles the Slack OAuth v2 authorization flow and token management.
 * Digby requests USER-token scopes (authed_user.access_token / xoxp) so it reads
 * the workspace AS THE USER — search.messages in particular requires a user token.
 *
 * Endpoints:
 *   GET    /api/crossmodel/slack/auth        — Start OAuth flow (redirect to Slack)
 *   GET    /api/crossmodel/slack/callback     — Handle OAuth callback from Slack
 *   GET    /api/crossmodel/slack/status       — Check connection status
 *   DELETE /api/crossmodel/slack/disconnect   — Delete token(s)
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

const SLACK_AUTH_URL  = 'https://slack.com/oauth/v2/authorize';
const SLACK_TOKEN_URL = 'https://slack.com/api/oauth.v2.access';

// User-token scopes — read channels/messages/search/users AS THE USER.
const USER_SCOPES = [
  'channels:read',
  'groups:read',
  'channels:history',
  'groups:history',
  // im/mpim HISTORY (ticket 24541fb3, 2026-10-12): im:read/mpim:read only LIST
  // DM/group-DM conversations — reading their messages via conversations.history
  // needs the *:history scopes (api.slack.com/methods/conversations.history:
  // "User token: relevant *:history scope … any private conversation the user
  // is a member of"). They were never requested, so every reconnect re-granted
  // a DM-blind token and DM/group-DM reads failed missing_scope — reconnecting
  // could not fix it. Existing connections gain them on the NEXT reconnect.
  'im:history',
  'mpim:history',
  'im:read',
  'mpim:read',
  'search:read',
  'users:read',
  // WRITE (capability gap #26, 2026-09-24): slack_post_message posts AS THE USER.
  // Existing connections lack it until the user reconnects — the MCP error names that.
  'chat:write',
].join(',');

/**
 * The user-token scopes Digby's DM/group-DM read path cannot work without.
 * Used to warn (log + status payload) when a granted token lacks them — an
 * additive reconnect fixes it (Slack appends scopes; it never removes them).
 */
export const REQUIRED_DM_HISTORY_SCOPES = ['im:history', 'mpim:history'] as const;

/** Sanitize a Slack OAuth `error` query param for safe embedding in a redirect URL. */
function sanitizeOauthError(raw: unknown): string {
  const s = String(raw ?? '').slice(0, 64);
  return /^[a-z0-9_.:-]+$/i.test(s) ? s : 'error';
}

function getConfig() {
  const clientId     = process.env.SLACK_CLIENT_ID;
  const clientSecret = process.env.SLACK_CLIENT_SECRET;
  const frontendUrl  = (process.env.FRONTEND_URL || 'https://digby.ai').split(',')[0].trim();
  // Derived from THIS instance's public URL (self-host setup hardening, 2026-10-20); the env overrides.
  const redirectUri  = process.env.SLACK_OAUTH_REDIRECT_URI ||
    `${frontendUrl}/api/crossmodel/slack/callback`;

  if (!clientId || !clientSecret) {
    throw new Error('SLACK_CLIENT_ID and SLACK_CLIENT_SECRET must be set');
  }
  return { clientId, clientSecret, redirectUri, frontendUrl };
}

// ── State storage (Redis) — single-use, 5-minute TTL ───────────────────────────

async function storeOAuthState(state: string, userId: string): Promise<void> {
  await redisClient.setEx(`slack_oauth_state:${state}`, 300, userId);
}

async function validateAndConsumeOAuthState(state: string): Promise<string | null> {
  const key = `slack_oauth_state:${state}`;
  const raw = await redisClient.get(key);
  if (raw) await redisClient.del(key);
  return raw || null;
}

/** Escape a string for safe embedding in an HTML attribute / text node. */
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Interstitial for the Mac desktop shell (ticket 8cb3aa34). The Mac app is a
 * chromeless WKWebView whose external-browser handoff (main.swift) fires ONLY
 * for REAL link clicks (.linkActivated) on non-whitelisted hosts — a 302 here
 * is a JS/redirect navigation, so slack.com would load INSIDE the webview:
 * no Slack session, Google sign-in blocked in embedded webviews, and any link
 * the user clicks rips the page out to the browser leaving the webview blank
 * (the reported "white screen with no way to get back"). This page's REAL
 * <a> click hands the consent URL to the system browser (where the user has
 * their Slack session), and the back link stays on the whitelisted app host
 * so the user is never stranded.
 */
export function renderDesktopHandoffPage(consentUrl: string, backUrl: string): string {
  const href = escapeHtml(consentUrl);
  const back = escapeHtml(backUrl);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connect Slack — Digby</title>
</head>
<body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0f0a1e;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#ece8f7;">
  <div style="max-width:26rem;padding:2rem;text-align:center;">
    <div style="font-size:2.5rem;margin-bottom:1rem;">&#x1F4AC;</div>
    <h1 style="font-size:1.25rem;margin:0 0 0.75rem;">Connect Slack to Digby</h1>
    <p style="font-size:0.9rem;line-height:1.5;color:#b6aed0;margin:0 0 1.5rem;">
      Slack sign-in needs your real browser. Tap below and Slack opens in your default browser &mdash; approve there and Digby is connected (then come straight back).
    </p>
    <a href="${href}" style="display:inline-block;padding:0.7rem 1.4rem;border-radius:0.6rem;background:#7c3aed;color:#fff;text-decoration:none;font-weight:600;">Continue in your browser</a>
    <p style="margin:1.5rem 0 0;"><a href="${back}" style="color:#a78bfa;font-size:0.85rem;">&larr; Back to Digby</a></p>
  </div>
</body>
</html>`;
}

// ── Controller ────────────────────────────────────────────────────────────────

export class SlackOAuthController {

  /** GET /api/crossmodel/slack/auth — Start Slack OAuth flow. */
  async startAuth(req: Request, res: Response, next: NextFunction) {
    try {
      const frontendUrl = (process.env.FRONTEND_URL || 'https://digby.ai').split(',')[0].trim();
      if (!req.user) {
        // 2026-09-12 (ticket 8cb3aa34): this endpoint is a BROWSER NAVIGATION
        // target (the integrations card does window.location.href here) — a
        // bare 401 JSON body renders as a white page with no way back inside
        // the Mac app's chromeless webview. Redirect to the real UI, which
        // toasts the reason and keeps navigation chrome.
        return res.redirect(`${frontendUrl}/account?tab=integrations&slack=auth_required`);
      }

      const clientId     = process.env.SLACK_CLIENT_ID;
      const clientSecret = process.env.SLACK_CLIENT_SECRET;
      if (!clientId || !clientSecret) {
        logger.warn('Slack OAuth: SLACK_CLIENT_ID / SLACK_CLIENT_SECRET not configured');
        return res.redirect(`${frontendUrl}/account?tab=integrations&slack=not_configured`);
      }

      const userId = req.user.id;
      const { redirectUri } = getConfig();
      const state = randomBytes(32).toString('hex');
      await storeOAuthState(state, userId);

      const params = new URLSearchParams({
        client_id:    clientId,
        user_scope:   USER_SCOPES,
        redirect_uri: redirectUri,
        state,
      });

      const consentUrl = `${SLACK_AUTH_URL}?${params}`;
      logger.info(`Slack OAuth: starting flow for userId=${userId}`);

      // 2026-09-12 (ticket 8cb3aa34): the frontend appends desktop=1 when
      // window.__digbyDesktop is set (the Mac shell). Render the handoff
      // interstitial instead of the 302 — see renderDesktopHandoffPage for why
      // the redirect dead-ends inside the chromeless webview. no-store: the
      // page embeds a single-use state.
      if (req.query.desktop === '1') {
        res.set('Cache-Control', 'no-store');
        return res.status(200).type('html').send(
          renderDesktopHandoffPage(consentUrl, `${frontendUrl}/account?tab=integrations`),
        );
      }

      res.redirect(consentUrl);
    } catch (error: any) {
      logger.error('Slack OAuth startAuth error:', error.message);
      next(error);
    }
  }

  /** GET /api/crossmodel/slack/callback — Handle OAuth callback from Slack. */
  async handleCallback(req: Request, res: Response, _next: NextFunction) {
    const { code, state, error: oauthError } = req.query as Record<string, string>;
    const { clientId, clientSecret, redirectUri, frontendUrl } = getConfig();
    // Ticket 24541fb3: pass Slack's own error code (invalid_scope, access_denied …)
    // through to the UI instead of flattening every failure to a generic "error" —
    // the owner reconnected three times against an error he was never shown.
    const errorRedirect = `${frontendUrl}/account?tab=integrations&slack=error${
      oauthError ? `&reason=${sanitizeOauthError(oauthError)}` : ''
    }`;

    try {
      if (oauthError) {
        logger.warn(`Slack OAuth callback error: ${oauthError}`);
        return res.redirect(errorRedirect);
      }
      if (!code || !state) {
        logger.warn('Slack OAuth callback: missing code or state');
        return res.redirect(errorRedirect);
      }

      const userId = await validateAndConsumeOAuthState(state);
      if (!userId) {
        logger.warn('Slack OAuth callback: invalid or expired state');
        return res.redirect(errorRedirect);
      }

      // Exchange code → tokens. Slack returns JSON with ok:false on error (HTTP 200).
      const tokenRes = await axios.post(
        SLACK_TOKEN_URL,
        new URLSearchParams({
          client_id:     clientId,
          client_secret: clientSecret,
          code,
          redirect_uri:  redirectUri,
        }).toString(),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 15000 }
      );

      const data = tokenRes.data as {
        ok: boolean;
        error?: string;
        team?: { id: string; name: string };
        authed_user?: { id: string; scope: string; access_token: string; token_type: string };
      };

      if (!data.ok) {
        logger.error(`Slack OAuth: token exchange failed: ${data.error}`);
        // Pass Slack's exchange error code through too (invalid_scope,
        // code_already_used …) — symmetric with the authorize-redirect branch.
        return res.redirect(`${frontendUrl}/account?tab=integrations&slack=error${
          data.error ? `&reason=${sanitizeOauthError(data.error)}` : ''
        }`);
      }

      const userToken = data.authed_user?.access_token;
      if (!userToken) {
        logger.error('Slack OAuth: no authed_user.access_token in response (request user_scope, not bot scope)');
        return res.redirect(errorRedirect);
      }

      const teamId       = data.team?.id || null;
      const teamName     = data.team?.name || null;
      const slackUserId  = data.authed_user?.id || null;
      const grantedScopes = (data.authed_user?.scope || '').split(',').filter(Boolean);
      const label        = teamName || 'Workspace';

      // Ticket 24541fb3: never accept a silently-degraded grant again. Slack
      // scopes are ADDITIVE across reconnects (appending scopes), so a grant
      // missing these means the token cannot read DM/group-DM history — the
      // exact four-day blind spot. Warn loudly; the connection still saves.
      const missingHistoryScopes = REQUIRED_DM_HISTORY_SCOPES.filter(s => !grantedScopes.includes(s));
      if (missingHistoryScopes.length > 0) {
        logger.warn(
          `Slack OAuth: connected userId=${userId} team=${teamName || 'unknown'} WITHOUT DM history scopes ` +
          `[${missingHistoryScopes.join(',')}] — slack_get_channel_history on DMs/group-DMs will fail ` +
          `missing_scope until the user reconnects (Slack appends scopes on re-auth)`
        );
      }

      await (prisma as any).slackOAuthToken.upsert({
        where:  { userId_label: { userId, label } },
        create: {
          userId, label,
          accessToken: encryptWith(userToken, 'SLACK_TOKEN_ENCRYPTION_KEY'),
          scopes: grantedScopes, teamId, teamName, slackUserId,
        },
        update: {
          accessToken: encryptWith(userToken, 'SLACK_TOKEN_ENCRYPTION_KEY'),
          scopes: grantedScopes, teamId, teamName, slackUserId,
        },
      });

      await invalidateIntegrationStatusCache(userId); // surface the new connection immediately (don't wait for TTL)
      logger.info(`Slack OAuth: connected userId=${userId}, team=${teamName || 'unknown'}`);
      res.redirect(`${frontendUrl}/account?tab=integrations&slack=connected`);
    } catch (error: any) {
      const detail = error.response?.data ? JSON.stringify(error.response.data) : error.message;
      logger.error(`Slack OAuth callback error: ${detail}`);
      // A completed consent that cannot be stored (no SLACK_TOKEN_ENCRYPTION_KEY on
      // this instance) is a configuration fact, not "try again" (2026-10-20).
      if (error instanceof EncryptionKeyError) {
        res.redirect(`${frontendUrl}/account?tab=integrations&slack=not_configured&reason=encryption_key`);
        return;
      }
      res.redirect(errorRedirect);
    }
  }

  /** GET /api/crossmodel/slack/status — Check Slack connection status. */
  async getStatus(req: Request, res: Response, next: NextFunction) {
    try {
      const userId = req.user!.id;
      const configured = !!(process.env.SLACK_CLIENT_ID && process.env.SLACK_CLIENT_SECRET);
      const row = await (prisma as any).slackOAuthToken.findFirst({
        where:  { userId },
        select: { teamName: true, scopes: true, createdAt: true, label: true },
      });
      if (!row) {
        return res.json({ success: true, data: { connected: false, configured } });
      }
      // Ticket 24541fb3: expose which DM-history scopes the stored token LACKS, so
      // the UI (and lanes) can tell "reconnect needed to gain im/mpim history" from
      // a healthy connection. Empty array = the token can read DM + group-DM history.
      const missingScopes = REQUIRED_DM_HISTORY_SCOPES.filter(s => !(row.scopes || []).includes(s));
      res.json({
        success: true,
        data: {
          connected: true, configured,
          teamName: row.teamName || null, label: row.label,
          scopes: row.scopes || [], connectedAt: row.createdAt,
          missingScopes,
        },
      });
    } catch (error) { next(error); }
  }

  /** DELETE /api/crossmodel/slack/disconnect — Delete Slack token(s) from DB. */
  async disconnect(req: Request, res: Response, next: NextFunction) {
    try {
      const userId = req.user!.id;
      const rows = await (prisma as any).slackOAuthToken.findMany({ where: { userId } });
      if (rows.length === 0) {
        return res.json({ success: true, message: 'Not connected to Slack' });
      }
      await (prisma as any).slackOAuthToken.deleteMany({ where: { userId } });
      await invalidateIntegrationStatusCache(userId);
      logger.info(`Slack OAuth: disconnected userId=${userId}`);
      res.json({ success: true, message: 'Slack disconnected' });
    } catch (error) { next(error); }
  }
}

export default new SlackOAuthController();
