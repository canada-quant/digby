/**
 * Asana OAuth Token Manager
 *
 * Loads tokens from DB, decrypts with ASANA_TOKEN_ENCRYPTION_KEY, and returns a
 * valid Asana access token — refreshing on demand when the access token is near
 * expiry. Asana access tokens live ~1h; the refresh token is long-lived and is
 * NOT rotated on refresh, so we keep the stored refresh token and only update the
 * access token + expiry. (Mirrors the Xero refresh pattern.)
 */

import prisma from '../../../config/database';
import axios from 'axios';
import { encryptWith, decryptWith } from '../google/crypto';
import logger from '../../../utils/logger';

const KEY = 'ASANA_TOKEN_ENCRYPTION_KEY';
const ASANA_TOKEN_URL = 'https://app.asana.com/-/oauth_token';

/**
 * Returns a valid Asana access token for the user, refreshing if needed.
 * Returns null if no token is stored or refresh fails.
 */
export async function getValidToken(userId: string, label?: string): Promise<string | null> {
  try {
    const row = label
      ? await (prisma as any).asanaOAuthToken.findUnique({ where: { userId_label: { userId, label } } })
      : await (prisma as any).asanaOAuthToken.findFirst({ where: { userId } });

    if (!row) return null;

    const expiresMs = new Date(row.expiresAt).getTime();
    // Token still valid for >60s — use it as-is.
    if (expiresMs - Date.now() > 60_000) {
      return decryptWith(row.accessToken, KEY);
    }

    const clientId     = process.env.ASANA_CLIENT_ID;
    const clientSecret = process.env.ASANA_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      logger.warn('Asana token refresh: ASANA_CLIENT_ID / ASANA_CLIENT_SECRET not set');
      return decryptWith(row.accessToken, KEY); // best-effort with the stale token
    }

    const refreshToken = decryptWith(row.refreshToken, KEY);
    const res = await axios.post(
      ASANA_TOKEN_URL,
      new URLSearchParams({
        grant_type:    'refresh_token',
        client_id:     clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
      }).toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 15000 }
    );

    const { access_token, expires_in } = res.data as { access_token?: string; expires_in?: number };
    if (!access_token) {
      logger.warn(`Asana token refresh: no access_token returned for userId=${userId}`);
      return null;
    }

    const newExpiresAt = new Date(Date.now() + (expires_in || 3600) * 1000);
    await (prisma as any).asanaOAuthToken.update({
      where: { id: row.id },
      data:  { accessToken: encryptWith(access_token, KEY), expiresAt: newExpiresAt },
    });
    logger.info(`Asana: refreshed token for userId=${userId}`);
    return access_token;
  } catch (error: any) {
    const detail = error.response?.data ? JSON.stringify(error.response.data) : error.message;
    logger.error(`Asana getValidToken failed for userId=${userId}: ${detail}`);
    return null;
  }
}

/** Check if a user has a connected Asana account. */
export async function hasAsanaConnected(userId: string): Promise<boolean> {
  try {
    const row = await (prisma as any).asanaOAuthToken.findFirst({ where: { userId }, select: { id: true } });
    return row !== null;
  } catch {
    return false;
  }
}
