/**
 * Xero OAuth Token Manager
 *
 * Loads tokens from DB, decrypts, auto-refreshes if expired (5-min buffer),
 * and returns a valid access token + tenant ID for the given user.
 *
 * Uses axios (already a backend dep) to call the Xero token refresh endpoint
 * directly — no need for xero-node SDK.
 */

import axios from 'axios';
import prisma from '../../../config/database';
import { encrypt, decrypt } from '../google/crypto';
import logger from '../../../utils/logger';

/** Refresh tokens that expire within this many ms */
const REFRESH_BUFFER_MS = 5 * 60 * 1000; // 5 minutes

export interface XeroTokenResult {
  accessToken: string;
  tenantId: string;
  orgName?: string;
}

/**
 * Returns a valid Xero access token + tenant ID for the user.
 * Refreshes the token if it's expired or close to expiry.
 * Returns null if no token is stored or if refresh fails.
 *
 * 2026-09-12 (ticket 64a25e8d): with multiple connected accounts, omitting
 * `label` resolves the DETERMINISTIC first-connected account (createdAt asc) —
 * same default rule as google/token-manager.ts. Callers that want a specific
 * account pass its label (see accountMatchesLabel for fuzzy matching).
 */
export async function getValidToken(userId: string, label?: string): Promise<XeroTokenResult | null> {
  try {
    const row = label
      ? await (prisma as any).xeroOAuthToken.findUnique({
          where: { userId_label: { userId, label } },
        })
      : await (prisma as any).xeroOAuthToken.findFirst({
          where: { userId },
          orderBy: { createdAt: 'asc' },
        });

    if (!row) return null;

    const accessToken = decrypt(row.accessToken);

    // Token still valid — return it
    if (row.expiresAt.getTime() - Date.now() > REFRESH_BUFFER_MS) {
      return { accessToken, tenantId: row.tenantId, orgName: row.orgName || undefined };
    }

    // Token expired (or close to expiry) — refresh it
    return await refreshToken(row);
  } catch (error: any) {
    logger.error(`Xero getValidToken failed for userId=${userId}: ${error.message}`);
    return null;
  }
}

async function refreshToken(row: any): Promise<XeroTokenResult | null> {
  const clientId     = process.env.XERO_CLIENT_ID;
  const clientSecret = process.env.XERO_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    logger.error('Xero OAuth credentials not configured — cannot refresh token');
    return null;
  }

  try {
    const refreshTokenDecrypted = decrypt(row.refreshToken);

    const params = new URLSearchParams({
      grant_type:    'refresh_token',
      refresh_token: refreshTokenDecrypted,
      client_id:     clientId,
      client_secret: clientSecret,
    });

    const response = await axios.post(
      'https://identity.xero.com/connect/token',
      params.toString(),
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 10000,
      }
    );

    const { access_token, refresh_token: new_refresh_token, expires_in } = response.data as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
    };

    const newExpiresAt = new Date(Date.now() + expires_in * 1000);

    // Xero always returns a new refresh token on each refresh (rotation)
    await (prisma as any).xeroOAuthToken.update({
      where: { id: row.id },
      data: {
        accessToken:  encrypt(access_token),
        refreshToken: encrypt(new_refresh_token),
        expiresAt:    newExpiresAt,
      },
    });

    logger.info(`Xero token refreshed for userId=${row.userId}, label=${row.label}`);
    return { accessToken: access_token, tenantId: row.tenantId, orgName: row.orgName || undefined };
  } catch (error: any) {
    const errMsg = error.response?.data?.error || error.message;
    logger.error(`Xero token refresh failed for userId=${row.userId}: ${errMsg}`);

    // If refresh token is revoked/invalid, delete this token row
    if (
      error.response?.data?.error === 'invalid_grant' ||
      error.response?.status === 400
    ) {
      try {
        await (prisma as any).xeroOAuthToken.delete({ where: { id: row.id } });
        logger.info(`Deleted invalid Xero token id=${row.id} for userId=${row.userId} (invalid_grant)`);
      } catch { /* already deleted or doesn't exist */ }
    }

    return null;
  }
}

/**
 * Check if a user has at least one connected Xero account.
 */
export async function hasXeroConnected(userId: string): Promise<boolean> {
  try {
    const row = await (prisma as any).xeroOAuthToken.findFirst({
      where: { userId },
      select: { id: true },
    });
    return row !== null;
  } catch {
    return false;
  }
}

// ── Multi-account helpers (ticket 64a25e8d — Google parity) ──────────────────

export interface XeroAccountRow {
  id: string;
  label: string;
  orgName: string | null;
  tenantId: string;
  scopes: string[];
  expiresAt: Date;
  createdAt: Date;
}

/** List all of a user's connected Xero accounts, first-connected first. */
export async function listXeroAccounts(userId: string): Promise<XeroAccountRow[]> {
  try {
    return await (prisma as any).xeroOAuthToken.findMany({
      where: { userId },
      select: { id: true, label: true, orgName: true, tenantId: true, scopes: true, expiresAt: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    });
  } catch {
    return [];
  }
}

/**
 * Fuzzy account match (mirrors google-mcp.ts accountMatchesLabel): a query
 * matches an account when it equals — case-insensitively — the bare label,
 * the org name, or the "Label (Org name)" composite shown in account lists.
 */
export function accountMatchesLabel(row: { label: string; orgName?: string | null }, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return false;
  const label = (row.label || '').toLowerCase();
  const org   = (row.orgName || '').toLowerCase();
  return q === label || (!!org && (q === org || q === `${label} (${org})`));
}

/** The "Label (Org name)" composite shown in account lists and error hints. */
export function xeroAccountDisplayName(row: { label: string; orgName?: string | null }): string {
  return row.orgName ? `${row.label} (${row.orgName})` : row.label;
}
