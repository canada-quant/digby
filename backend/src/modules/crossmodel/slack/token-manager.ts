/**
 * Slack OAuth Token Manager
 *
 * Loads tokens from DB, decrypts using SLACK_TOKEN_ENCRYPTION_KEY, and returns
 * valid Slack *user* access tokens (xoxp) for the given user.
 *
 * Slack user tokens do NOT expire (no rotation unless explicitly enabled on the
 * Slack app), so — like GitHub — there is no refresh logic here.
 *
 * Supports multiple workspaces per user via the `label` column.
 */

import prisma from '../../../config/database';
import { decryptWith } from '../google/crypto';
import logger from '../../../utils/logger';

const KEY = 'SLACK_TOKEN_ENCRYPTION_KEY';

/**
 * Returns a valid Slack user token for the user.
 * If label is specified, returns the token for that workspace; otherwise the
 * first connected workspace. Returns null if no token is stored.
 */
export async function getValidToken(userId: string, label?: string): Promise<string | null> {
  try {
    const row = label
      ? await (prisma as any).slackOAuthToken.findUnique({ where: { userId_label: { userId, label } } })
      : await (prisma as any).slackOAuthToken.findFirst({ where: { userId } });

    if (!row) return null;
    return decryptWith(row.accessToken, KEY);
  } catch (error: any) {
    logger.error(`Slack getValidToken failed for userId=${userId}: ${error.message}`);
    return null;
  }
}

/**
 * Returns valid tokens for ALL connected Slack workspaces for the user.
 */
export async function getAllValidTokens(
  userId: string
): Promise<Array<{ token: string; label: string; teamName?: string }>> {
  try {
    const rows = await (prisma as any).slackOAuthToken.findMany({
      where: { userId },
      orderBy: { createdAt: 'asc' },
    });
    if (!rows || rows.length === 0) return [];

    const results: Array<{ token: string; label: string; teamName?: string }> = [];
    for (const row of rows) {
      try {
        results.push({
          token: decryptWith(row.accessToken, KEY),
          label: row.label || 'Workspace',
          teamName: row.teamName || undefined,
        });
      } catch (err: any) {
        logger.warn(`Slack getAllValidTokens: skipping "${row.label}" for userId=${userId}: ${err.message}`);
      }
    }
    return results;
  } catch (error: any) {
    logger.error(`Slack getAllValidTokens failed for userId=${userId}: ${error.message}`);
    return [];
  }
}

/** Check if a user has at least one connected Slack workspace. */
export async function hasSlackConnected(userId: string): Promise<boolean> {
  try {
    const row = await (prisma as any).slackOAuthToken.findFirst({ where: { userId }, select: { id: true } });
    return row !== null;
  } catch {
    return false;
  }
}
