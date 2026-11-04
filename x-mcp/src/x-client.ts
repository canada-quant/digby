/**
 * Thin wrapper around X (Twitter) API v2 for write/engagement operations.
 *
 * Callers pass a per-user OAuth 2.0 access token. We do NOT refresh here —
 * the backend's token-manager refreshes BEFORE calling the MCP server so the
 * token we receive in the X-X-Token header is always fresh.
 */

import axios, { AxiosError } from 'axios';

const X_API = 'https://api.x.com/2';

interface XError {
  status?: number;
  body?: unknown;
  message: string;
}

function summarizeError(err: unknown): XError {
  if (err instanceof AxiosError) {
    return {
      status: err.response?.status,
      body: err.response?.data,
      message: err.message,
    };
  }
  return { message: err instanceof Error ? err.message : String(err) };
}

async function authedFetch<T>(
  token: string,
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await axios.request<T>({
    method,
    url: `${X_API}${path}`,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    data: body,
    timeout: 20000,
    validateStatus: (s) => s < 500,
  });
  if (res.status >= 400) {
    const detail = typeof res.data === 'object' ? JSON.stringify(res.data) : String(res.data);
    throw new AxiosError(`X API ${res.status}: ${detail}`, undefined, undefined, undefined, res);
  }
  return res.data;
}

async function getAuthenticatedUserId(token: string): Promise<string> {
  const me = await authedFetch<{ data: { id: string; username: string; name: string } }>(
    token, 'GET', '/users/me',
  );
  return me.data.id;
}

/** Cache the user-id lookup for the lifetime of one MCP request. */
const userIdMemo = new Map<string, string>();
async function resolveUserId(token: string): Promise<string> {
  const cached = userIdMemo.get(token);
  if (cached) return cached;
  const id = await getAuthenticatedUserId(token);
  userIdMemo.set(token, id);
  return id;
}

// ── Write operations ─────────────────────────────────────────────────────────

export async function postTweet(
  token: string,
  text: string,
  replyToTweetId?: string,
  quoteTweetId?: string,
): Promise<string> {
  try {
    const body: Record<string, unknown> = { text };
    if (replyToTweetId) body.reply = { in_reply_to_tweet_id: replyToTweetId };
    if (quoteTweetId) body.quote_tweet_id = quoteTweetId;

    const result = await authedFetch<{ data: { id: string; text: string } }>(
      token, 'POST', '/tweets', body,
    );

    const tweetUrl = `https://x.com/i/web/status/${result.data.id}`;
    const kind = replyToTweetId ? 'Reply' : quoteTweetId ? 'Quote tweet' : 'Tweet';
    return `${kind} posted ✅\nID: ${result.data.id}\nURL: ${tweetUrl}\nText: ${result.data.text}`;
  } catch (err) {
    const e = summarizeError(err);
    return `Error posting tweet (status ${e.status ?? '?'}): ${e.message}`;
  }
}

export async function deleteTweet(token: string, tweetId: string): Promise<string> {
  try {
    await authedFetch(token, 'DELETE', `/tweets/${tweetId}`);
    return `Tweet ${tweetId} deleted ✅`;
  } catch (err) {
    const e = summarizeError(err);
    return `Error deleting tweet ${tweetId}: ${e.message}`;
  }
}

export async function likeTweet(token: string, tweetId: string): Promise<string> {
  try {
    const userId = await resolveUserId(token);
    await authedFetch(token, 'POST', `/users/${userId}/likes`, { tweet_id: tweetId });
    return `Tweet ${tweetId} liked ❤️`;
  } catch (err) {
    const e = summarizeError(err);
    return `Error liking tweet ${tweetId}: ${e.message}`;
  }
}

export async function unlikeTweet(token: string, tweetId: string): Promise<string> {
  try {
    const userId = await resolveUserId(token);
    await authedFetch(token, 'DELETE', `/users/${userId}/likes/${tweetId}`);
    return `Tweet ${tweetId} unliked`;
  } catch (err) {
    const e = summarizeError(err);
    return `Error unliking tweet ${tweetId}: ${e.message}`;
  }
}

export async function retweet(token: string, tweetId: string): Promise<string> {
  try {
    const userId = await resolveUserId(token);
    await authedFetch(token, 'POST', `/users/${userId}/retweets`, { tweet_id: tweetId });
    return `Retweeted ${tweetId} 🔁`;
  } catch (err) {
    const e = summarizeError(err);
    return `Error retweeting ${tweetId}: ${e.message}`;
  }
}

export async function unretweet(token: string, tweetId: string): Promise<string> {
  try {
    const userId = await resolveUserId(token);
    await authedFetch(token, 'DELETE', `/users/${userId}/retweets/${tweetId}`);
    return `Unretweeted ${tweetId}`;
  } catch (err) {
    const e = summarizeError(err);
    return `Error unretweeting ${tweetId}: ${e.message}`;
  }
}

async function resolveTargetUserId(token: string, usernameOrId: string): Promise<string> {
  if (/^\d+$/.test(usernameOrId)) return usernameOrId;
  const cleaned = usernameOrId.replace(/^@/, '');
  const res = await authedFetch<{ data: { id: string; username: string } }>(
    token, 'GET', `/users/by/username/${cleaned}`,
  );
  return res.data.id;
}

export async function follow(token: string, target: string): Promise<string> {
  try {
    const sourceId = await resolveUserId(token);
    const targetId = await resolveTargetUserId(token, target);
    await authedFetch(token, 'POST', `/users/${sourceId}/following`, { target_user_id: targetId });
    return `Followed @${target.replace(/^@/, '')} (id=${targetId})`;
  } catch (err) {
    const e = summarizeError(err);
    return `Error following ${target}: ${e.message}`;
  }
}

export async function unfollow(token: string, target: string): Promise<string> {
  try {
    const sourceId = await resolveUserId(token);
    const targetId = await resolveTargetUserId(token, target);
    await authedFetch(token, 'DELETE', `/users/${sourceId}/following/${targetId}`);
    return `Unfollowed @${target.replace(/^@/, '')}`;
  } catch (err) {
    const e = summarizeError(err);
    return `Error unfollowing ${target}: ${e.message}`;
  }
}

// ── Authenticated identity ───────────────────────────────────────────────────

export async function getMe(token: string): Promise<string> {
  try {
    const me = await authedFetch<{
      data: { id: string; username: string; name: string; description?: string }
    }>(token, 'GET', '/users/me?user.fields=description');
    const u = me.data;
    return [
      `Authenticated as: @${u.username} (${u.name})`,
      `ID: ${u.id}`,
      u.description ? `Bio: ${u.description}` : '',
    ].filter(Boolean).join('\n');
  } catch (err) {
    const e = summarizeError(err);
    return `Error reading authenticated user: ${e.message}`;
  }
}

// ── Read operations (per-user OAuth; ticket f609ec35, 2026-09-22) ───────────
//
// X API v2 read endpoints. The Digby OAuth flow already requests tweet.read +
// users.read scopes (x-oauth.controller.ts SCOPES), so a connected user's token
// can read WHEN the developer app is on a tier with read access (Basic+).
// These functions THROW on API errors — callers (server.ts read tools) catch
// and fall back to the wall-detecting Bright Data scrape path.
//
// X API v2 has NO trends endpoint, so x_get_trends stays scrape-only.

function fmtCount(n: number | undefined): string {
  return typeof n === 'number' ? n.toLocaleString('en-US') : '?';
}

function fmtWhen(iso: unknown): string {
  return typeof iso === 'string' && iso ? `${iso.slice(0, 16).replace('T', ' ')}Z` : '(no timestamp)';
}

export async function lookupUserWithTweets(token: string, usernameRaw: string): Promise<string> {
  const username = usernameRaw.replace(/^@/, '').trim();
  if (!username) return 'Empty username.';
  const user = await authedFetch<{ data: any }>(
    token, 'GET',
    `/users/by/username/${encodeURIComponent(username)}` +
      '?user.fields=created_at,description,location,public_metrics,url,verified',
  );
  const u = user.data;
  const tweets = await authedFetch<{ data?: any[] }>(
    token, 'GET',
    `/users/${u.id}/tweets?max_results=5&tweet.fields=created_at,public_metrics`,
  );
  const m = u.public_metrics ?? {};
  const lines: string[] = [
    `# @${u.username} — ${u.name}${u.verified ? ' ✓' : ''}`,
    '',
    u.description || '(no bio)',
    '',
    `Followers: ${fmtCount(m.followers_count)} · Following: ${fmtCount(m.following_count)} · Posts: ${fmtCount(m.tweet_count)}` +
      (u.created_at ? ` · Joined ${String(u.created_at).slice(0, 10)}` : ''),
  ];
  if (u.location) lines.push(`Location: ${u.location}`);
  if (u.url) lines.push(`URL: ${u.url}`);
  const recent = tweets.data ?? [];
  if (recent.length) {
    lines.push('', '## Recent posts');
    for (const t of recent) {
      const tm = t.public_metrics ?? {};
      lines.push(
        '',
        `— ${fmtWhen(t.created_at)} (❤ ${fmtCount(tm.like_count)} · 🔁 ${fmtCount(tm.retweet_count)} · 💬 ${fmtCount(tm.reply_count)})`,
        t.text ?? '',
        `https://x.com/${u.username}/status/${t.id}`,
      );
    }
  }
  return lines.join('\n');
}

export async function searchRecentTweets(token: string, query: string): Promise<string> {
  if (!query.trim()) return 'Empty search query.';
  const res = await authedFetch<{ data?: any[]; includes?: { users?: any[] } }>(
    token, 'GET',
    `/tweets/search/recent?query=${encodeURIComponent(query)}` +
      '&max_results=10&tweet.fields=created_at,public_metrics,author_id&expansions=author_id&user.fields=username,name',
  );
  const users = new Map((res.includes?.users ?? []).map((x: any) => [x.id, x]));
  const rows = res.data ?? [];
  if (!rows.length) {
    return `# X search — "${query}"\n\nNo matching posts in the last 7 days (the X API search/recent window).`;
  }
  const lines = [`# X search — "${query}" (${rows.length} recent posts)`, ''];
  for (const t of rows) {
    const au = users.get(t.author_id);
    const tm = t.public_metrics ?? {};
    lines.push(
      `— @${au?.username ?? t.author_id}${au?.name ? ` (${au.name})` : ''} · ${fmtWhen(t.created_at)} · ❤ ${fmtCount(tm.like_count)} 🔁 ${fmtCount(tm.retweet_count)}`,
      t.text ?? '',
      `https://x.com/${au?.username ?? 'i'}/status/${t.id}`,
      '',
    );
  }
  return lines.join('\n');
}

export async function getTweetById(token: string, tweetId: string): Promise<string> {
  const res = await authedFetch<{ data: any; includes?: { users?: any[] } }>(
    token, 'GET',
    `/tweets/${tweetId}?tweet.fields=created_at,public_metrics,author_id,conversation_id` +
      '&expansions=author_id&user.fields=username,name',
  );
  const t = res.data;
  const au = (res.includes?.users ?? [])[0];
  const tm = t.public_metrics ?? {};
  return [
    `# Tweet ${tweetId}`,
    '',
    `@${au?.username ?? t.author_id}${au?.name ? ` (${au.name})` : ''} · ${fmtWhen(t.created_at)}`,
    `❤ ${fmtCount(tm.like_count)} · 🔁 ${fmtCount(tm.retweet_count)} · 💬 ${fmtCount(tm.reply_count)} · 👁 ${fmtCount(tm.impression_count)}`,
    '',
    t.text ?? '',
    '',
    `https://x.com/${au?.username ?? 'i'}/status/${t.id}`,
  ].join('\n');
}

/** Extract a numeric tweet ID from a URL, "user/status/id", or a bare ID. */
export function extractTweetId(input: string): string | null {
  const m = input.match(/status(?:es)?\/(\d+)/);
  if (m) return m[1];
  const trimmed = input.trim();
  if (/^\d+$/.test(trimmed)) return trimmed;
  return null;
}
