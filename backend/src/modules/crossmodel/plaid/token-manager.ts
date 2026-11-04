/**
 * Plaid Token Manager
 *
 * Loads Plaid access tokens from DB, decrypts, and returns them for API calls.
 * Plaid access tokens don't expire (they're permanent until the user revokes),
 * so there's no refresh logic needed — unlike Xero/Google OAuth.
 *
 * Uses the same AES-256-GCM encryption as Google/Xero tokens.
 */

import prisma from '../../../config/database';
import { encrypt, decrypt } from '../google/crypto';
import logger from '../../../utils/logger';

export interface PlaidTokenResult {
  accessToken: string;
  itemId: string;
  institutionName?: string;
}

/**
 * Returns all Plaid access tokens for a user.
 * Returns empty array if no tokens are stored.
 */
export async function getPlaidTokens(userId: string): Promise<PlaidTokenResult[]> {
  try {
    const rows = await (prisma as any).plaidAccessToken.findMany({
      where: { userId },
      select: {
        accessToken: true,
        itemId: true,
        institutionName: true,
      },
    });

    return rows.map((row: any) => ({
      accessToken: decrypt(row.accessToken),
      itemId: row.itemId,
      institutionName: row.institutionName || undefined,
    }));
  } catch (error: any) {
    logger.error(`Plaid getPlaidTokens failed for userId=${userId}: ${error.message}`);
    return [];
  }
}

/**
 * Returns the first Plaid access token for a user (convenience for single-account users).
 * Returns null if no token is stored.
 */
export async function getFirstPlaidToken(userId: string): Promise<PlaidTokenResult | null> {
  const tokens = await getPlaidTokens(userId);
  return tokens.length > 0 ? tokens[0] : null;
}

/**
 * Check if a user has at least one connected Plaid account.
 */
export async function hasPlaidConnected(userId: string): Promise<boolean> {
  try {
    const row = await (prisma as any).plaidAccessToken.findFirst({
      where: { userId },
      select: { id: true },
    });
    return row !== null;
  } catch {
    return false;
  }
}

/**
 * Store a new Plaid access token (after public_token exchange).
 */
export async function storePlaidToken(
  userId: string,
  accessToken: string,
  itemId: string,
  institutionId?: string,
  institutionName?: string,
): Promise<void> {
  const label = institutionName || 'Default';

  await (prisma as any).plaidAccessToken.upsert({
    where: { userId_itemId: { userId, itemId } },
    create: {
      userId,
      label,
      accessToken: encrypt(accessToken),
      itemId,
      institutionId: institutionId || null,
      institutionName: institutionName || null,
    },
    update: {
      accessToken: encrypt(accessToken),
      institutionId: institutionId || null,
      institutionName: institutionName || null,
      label,
    },
  });

  logger.info(`Plaid token stored for userId=${userId}, institution=${institutionName || 'unknown'}`);
}

/**
 * Delete all Plaid tokens for a user (disconnect).
 */
export async function deletePlaidTokens(userId: string): Promise<number> {
  const result = await (prisma as any).plaidAccessToken.deleteMany({
    where: { userId },
  });
  return result.count;
}
