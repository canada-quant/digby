/**
 * HTTP client for the x-mcp container. Posts JSON-RPC tool/call requests with
 *   X-API-Key:  shared secret (X_MCP_API_KEY)
 *   X-X-Token:  per-user OAuth access token (refreshed by token-manager)
 *
 * All callers should pass an already-refreshed token. Read tools work even
 * with no token (they use Bright Data), but write tools will error gracefully.
 */

import axios from 'axios';
import logger from '../../../utils/logger';
import { resolveXToken, getValidToken } from './token-manager';
import { recordReadOutcome } from '../integration-health';

const X_MCP_URL = process.env.X_MCP_URL || 'http://x-mcp-prod:8000/mcp';
const X_MCP_API_KEY = process.env.X_MCP_API_KEY || '';

let nextRequestId = 1;

interface CallOptions {
  /** Set true for write tools so we fail early when the user is not connected. */
  requireUserToken?: boolean;
  /** Which connected X account to act as. Falls back to the primary (oldest) account. */
  label?: string;
  /**
   * Record this call's outcome into the platform IntegrationHealth row
   * (ticket fa956f09) — set on READ tools, whose failure is a PLATFORM-side
   * outage (shared gateway credentials), never a per-user auth problem.
   */
  readHealth?: boolean;
}

async function callMcp(
  userId: string | null,
  toolName: string,
  params: Record<string, unknown>,
  opts: CallOptions = {},
): Promise<string | null> {
  // Health of the read path is only observable on a real call — a missing
  // API key is a deployment misconfiguration, not a transient outage, but it
  // is still "reads failing platform-wide", so it latches the same way.
  const recordHealth = async (ok: boolean, reason?: string) => {
    if (opts.readHealth) await recordReadOutcome('x', ok, reason);
  };

  if (!X_MCP_API_KEY) {
    logger.warn(`X_MCP_API_KEY not configured — cannot call ${toolName}`);
    await recordHealth(false, 'X_MCP_API_KEY not configured');
    return null;
  }

  let xToken: string | null = null;
  if (userId) {
    // Write tools need the HONEST auth resolution (ticket fa956f09): a
    // connected user whose refresh token died must hear "reconnect X", not
    // the not-connected message that misdirected users to Settings while
    // their OAuth row was fine.
    if (opts.requireUserToken) {
      const resolved = await resolveXToken(userId, opts.label);
      if (!resolved.ok) return resolved.message;
      xToken = resolved.token;
    } else {
      xToken = await getValidToken(userId, opts.label);
    }
  }
  if (opts.requireUserToken && !xToken) {
    return opts.label
      ? `User has no X account labelled "${opts.label}".`
      : 'User has not connected their X account.';
  }

  try {
    const response = await axios.post(
      X_MCP_URL,
      {
        jsonrpc: '2.0',
        id: nextRequestId++,
        method: 'tools/call',
        params: { name: toolName, arguments: params },
      },
      {
        headers: {
          'X-API-Key': X_MCP_API_KEY,
          ...(xToken ? { 'X-X-Token': xToken } : {}),
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        timeout: 60000,
        responseType: 'text',
        transformResponse: (r) => r,
        validateStatus: (s) => s < 500,
      },
    );

    const body = response.data as string;
    const jsonPayload = body.startsWith('{')
      ? body
      : (body.split('\n')
            .map((l) => l.trim())
            .filter((l) => l.startsWith('data:'))
            .map((l) => l.slice(5).trim())
            .filter((l) => l && l !== '[DONE]')
            .at(-1)) || '';

    // The two nulls below were the SILENT failure paths (ticket fa956f09):
    // an empty/undecodable payload or a non-string content part returned
    // null with NO log line, so a platform-side gateway outage looked like
    // "no results". They now warn AND latch the read-health row.
    if (!jsonPayload) {
      logger.warn(`x-mcp tool ${toolName} returned an empty payload (gateway/SSE failure)`);
      await recordHealth(false, `x-mcp ${toolName}: empty payload from gateway`);
      return null;
    }
    const parsed = JSON.parse(jsonPayload);
    if (parsed.error) {
      const errDesc = `x-mcp ${toolName} error: ${JSON.stringify(parsed.error).slice(0, 400)}`;
      logger.warn(errDesc);
      await recordHealth(false, errDesc);
      return null;
    }
    const text = parsed.result?.content?.[0]?.text;
    if (typeof text !== 'string') {
      logger.warn(`x-mcp tool ${toolName} returned non-string content: ${JSON.stringify(parsed.result?.content).slice(0, 200)}`);
      await recordHealth(false, `x-mcp ${toolName}: non-string content part`);
      return null;
    }
    // Reviewer nuance (fa956f09): an empty content STRING is no-data to every
    // caller ('' is falsy at each consumption seam) — the health row must not
    // call it ok, or the UI badges "connected + healthy" while reads return
    // nothing (the exact 2026-09-22 illusion).
    if (!text.trim()) {
      logger.warn(`x-mcp tool ${toolName} returned an empty content string (no data)`);
      await recordHealth(false, `x-mcp ${toolName}: empty content string`);
      return null;
    }
    // A string result can still be x-mcp's honest DEGRADED sentinel (23c68866):
    // the gateway answered but x.com served walls AND every fallback leg failed —
    // the user is getting no data, so the read path is NOT healthy.
    if (text.includes('X READ DEGRADED')) {
      await recordHealth(false, `x-mcp ${toolName}: degraded read (wall/unusable upstream, fallbacks failed)`);
    } else {
      await recordHealth(true);
    }
    return text;
  } catch (err: any) {
    const msg = `x-mcp call ${toolName} failed: ${err.message}`;
    logger.warn(msg);
    await recordHealth(false, msg);
    return null;
  }
}

// ── Read tool wrappers ───────────────────────────────────────────────────────
// Reads attach the user's OAuth token when a userId is given AND an account is
// connected — x-mcp then prefers the authenticated X API v2 read path and only
// falls back to the (wall-detecting) Bright Data scrape when the API rejects
// the read (ticket f609ec35). Reads still work with userId null / no account.
// readHealth:true records each call's outcome in the platform IntegrationHealth
// row (ticket fa956f09) so a failing read path surfaces in the status API and
// the integrations UI instead of silently serving empty results.

export const getUserProfile  = (username: string, userId?: string | null) => callMcp(userId ?? null, 'x_get_user_profile', { username }, { readHealth: true });
export const getTweet        = (tweet: string, userId?: string | null)    => callMcp(userId ?? null, 'x_get_tweet', { tweet }, { readHealth: true });
export const search          = (query: string, userId?: string | null)    => callMcp(userId ?? null, 'x_search', { query }, { readHealth: true });
export const getTrends       = (woeid?: string, userId?: string | null)   => callMcp(userId ?? null, 'x_get_trends', woeid ? { woeid } : {}, { readHealth: true });

// ── Write tool wrappers ──────────────────────────────────────────────────────

export const postTweet = (
  userId: string,
  text: string,
  opts: { label?: string; replyToTweetId?: string; quoteTweetId?: string } = {},
) => callMcp(userId, 'x_post_tweet', {
  text,
  ...(opts.replyToTweetId ? { reply_to_tweet_id: opts.replyToTweetId } : {}),
  ...(opts.quoteTweetId   ? { quote_tweet_id: opts.quoteTweetId } : {}),
}, { requireUserToken: true, label: opts.label });

export const deleteTweet  = (userId: string, tweetId: string, label?: string) => callMcp(userId, 'x_delete_tweet',  { tweet_id: tweetId }, { requireUserToken: true, label });
export const likeTweet    = (userId: string, tweetId: string, label?: string) => callMcp(userId, 'x_like',          { tweet_id: tweetId }, { requireUserToken: true, label });
export const unlikeTweet  = (userId: string, tweetId: string, label?: string) => callMcp(userId, 'x_unlike',        { tweet_id: tweetId }, { requireUserToken: true, label });
export const retweet      = (userId: string, tweetId: string, label?: string) => callMcp(userId, 'x_retweet',       { tweet_id: tweetId }, { requireUserToken: true, label });
export const unretweet    = (userId: string, tweetId: string, label?: string) => callMcp(userId, 'x_unretweet',     { tweet_id: tweetId }, { requireUserToken: true, label });
export const follow       = (userId: string, target: string, label?: string)  => callMcp(userId, 'x_follow',        { username_or_id: target }, { requireUserToken: true, label });
export const unfollow     = (userId: string, target: string, label?: string)  => callMcp(userId, 'x_unfollow',      { username_or_id: target }, { requireUserToken: true, label });
export const getMe        = (userId: string, label?: string)                  => callMcp(userId, 'x_get_me',        {}, { requireUserToken: true, label });
