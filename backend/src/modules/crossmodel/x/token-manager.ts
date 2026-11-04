/**
 * X (Twitter) OAuth Token Manager
 *
 * Unlike GitHub, X access tokens DO expire (typically ~2h) and must be refreshed
 * via the refresh token. We store both encrypted access + refresh tokens plus
 * expiresAt; getValidToken() automatically refreshes when the token is within
 * 60s of expiry.
 *
 * Refresh tokens are single-use under X's PKCE implementation — every refresh
 * returns a new refresh token, so we persist whatever the IdP returns.
 */

import axios from 'axios';
import prisma from '../../../config/database';
import { encryptWith, decryptWith } from './crypto';
import logger from '../../../utils/logger';

const X_TOKEN_URL = 'https://api.x.com/2/oauth2/token';
const REFRESH_BUFFER_MS = 60 * 1000; // refresh if within 60s of expiry

interface RefreshedTokens {
  access_token: string;
  refresh_token?: string;  // X may rotate; persist whatever comes back
  expires_in: number;       // seconds
  scope?: string;
  token_type: string;
}

async function refreshTokens(refreshToken: string): Promise<RefreshedTokens> {
  const clientId = process.env.X_OAUTH_CLIENT_ID;
  const clientSecret = process.env.X_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('X_OAUTH_CLIENT_ID / X_OAUTH_CLIENT_SECRET not configured');
  }

  // X requires HTTP Basic auth with the client_id:client_secret pair on
  // confidential clients, AND the same client_id in the form body.
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
  });

  const res = await axios.post(X_TOKEN_URL, body.toString(), {
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    timeout: 15000,
  });
  return res.data as RefreshedTokens;
}

async function persistRefreshed(
  rowId: string,
  refreshed: RefreshedTokens,
): Promise<void> {
  const expiresAt = new Date(Date.now() + refreshed.expires_in * 1000);
  const update: Record<string, unknown> = {
    accessToken: encryptWith(refreshed.access_token, 'X_TOKEN_ENCRYPTION_KEY'),
    expiresAt,
  };
  if (refreshed.refresh_token) {
    update.refreshToken = encryptWith(refreshed.refresh_token, 'X_TOKEN_ENCRYPTION_KEY');
  }
  if (refreshed.scope) {
    update.scopes = refreshed.scope.split(/\s+/).filter(Boolean);
  }
  await (prisma as any).xOAuthToken.update({ where: { id: rowId }, data: update });
}

/**
 * Resolves the user's X access token, refreshing in place if needed, with an
 * HONEST discriminated result (ticket fa956f09): "not connected",
 * "label not found", and "refresh failed (stale auth)" are different failure
 * classes and must not collapse into one null — a connected user whose token
 * can no longer refresh needs to be told to RECONNECT, not that they never
 * connected.
 *
 *   - When `label` is given, resolves that specific connected account.
 *   - Without a label, resolves the oldest connected account ("primary") to
 *     keep behaviour deterministic for callers that don't care which account.
 */
export type XTokenResolution =
  | { ok: true; token: string }
  | {
      ok: false;
      reason: 'not_connected' | 'label_not_found' | 'no_refresh_token' | 'refresh_failed' | 'error';
      message: string;
    };

export async function resolveXToken(userId: string, label?: string): Promise<XTokenResolution> {
  try {
    const row = label
      ? await (prisma as any).xOAuthToken.findUnique({
          where: { userId_label: { userId, label } },
        })
      : await (prisma as any).xOAuthToken.findFirst({
          where: { userId },
          orderBy: { createdAt: 'asc' },
        });
    if (!row) {
      return label
        ? { ok: false, reason: 'label_not_found', message: `User has no X account labelled "${label}".` }
        : { ok: false, reason: 'not_connected', message: 'User has not connected their X account.' };
    }

    const stillFresh =
      row.expiresAt && new Date(row.expiresAt).getTime() - Date.now() > REFRESH_BUFFER_MS;
    if (stillFresh) {
      return { ok: true, token: decryptWith(row.accessToken, 'X_TOKEN_ENCRYPTION_KEY') };
    }

    // Need to refresh.
    if (!row.refreshToken) {
      logger.warn(`X token expired for userId=${userId} but no refresh token stored`);
      return {
        ok: false,
        reason: 'no_refresh_token',
        message: 'The user\'s X session expired and no refresh token is stored — ask them to reconnect X in Account → Integrations.',
      };
    }
    let refreshToken: string;
    try {
      refreshToken = decryptWith(row.refreshToken, 'X_TOKEN_ENCRYPTION_KEY');
    } catch (err: any) {
      logger.error(`X refresh-token decrypt failed for userId=${userId}: ${err.message}`);
      return {
        ok: false,
        reason: 'refresh_failed',
        message: 'The user\'s stored X refresh token could not be read — ask them to reconnect X in Account → Integrations.',
      };
    }

    let refreshed: RefreshedTokens;
    try {
      refreshed = await refreshTokens(refreshToken);
    } catch (err: any) {
      logger.error(
        `X token refresh failed for userId=${userId}: ${err.response?.data
          ? JSON.stringify(err.response.data)
          : err.message}`,
      );
      return {
        ok: false,
        reason: 'refresh_failed',
        message: 'The user\'s X token refresh failed (auth expired or revoked) — ask them to reconnect X in Account → Integrations.',
      };
    }

    await persistRefreshed(row.id, refreshed);
    return { ok: true, token: refreshed.access_token };
  } catch (error: any) {
    logger.error(`X getValidToken failed for userId=${userId}: ${error.message}`);
    return { ok: false, reason: 'error', message: `X token lookup failed: ${error.message}` };
  }
}

/**
 * Back-compat thin wrapper over resolveXToken: the token, or null when the
 * user has no usable X session (any failure class).
 */
export async function getValidToken(userId: string, label?: string): Promise<string | null> {
  const resolved = await resolveXToken(userId, label);
  return resolved.ok ? resolved.token : null;
}

export async function hasXConnected(userId: string): Promise<boolean> {
  try {
    const row = await (prisma as any).xOAuthToken.findFirst({
      where: { userId },
      select: { id: true },
    });
    return row !== null;
  } catch {
    return false;
  }
}

export async function getConnectedScreenName(userId: string, label?: string): Promise<string | null> {
  try {
    const row = label
      ? await (prisma as any).xOAuthToken.findUnique({
          where: { userId_label: { userId, label } },
          select: { screenName: true },
        })
      : await (prisma as any).xOAuthToken.findFirst({
          where: { userId },
          select: { screenName: true },
          orderBy: { createdAt: 'asc' },
        });
    return row?.screenName ?? null;
  } catch {
    return null;
  }
}

/** All connected X accounts for the user (display-safe — no tokens). */
export async function listAccounts(userId: string): Promise<Array<{
  id: string;
  label: string;
  screenName: string | null;
  scopes: string[];
  connectedAt: Date;
  tokenExpiresAt: Date;
}>> {
  try {
    const rows = await (prisma as any).xOAuthToken.findMany({
      where:   { userId },
      select:  {
        id: true, label: true, screenName: true, scopes: true,
        createdAt: true, expiresAt: true,
      },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((r: any) => ({
      id:             r.id,
      label:          r.label,
      screenName:     r.screenName ?? null,
      scopes:         r.scopes ?? [],
      connectedAt:    r.createdAt,
      tokenExpiresAt: r.expiresAt,
    }));
  } catch (err: any) {
    logger.warn(`X listAccounts failed for userId=${userId}: ${err.message}`);
    return [];
  }
}
