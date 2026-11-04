// Ops note (ticket e3cb31c3, 2026-09-22): this container's rebuild is gated by
// the deployed-sha marker compare in .github/workflows/deploy.yml ("Detect
// x-mcp changes in this push"). The gate used to compare the wave's own sha
// against itself (the marker was written mid-wave), so this container was
// never rebuilt and merged x-mcp fixes (f609ec35's read-path fix) sat
// undelivered. This comment doubles as the x-mcp/ path touch that makes the
// gate-fix wave's compare non-empty, forcing the one backlog-flushing rebuild.
import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

import {
  postTweet, deleteTweet, likeTweet, unlikeTweet,
  retweet, unretweet, follow, unfollow, getMe,
  lookupUserWithTweets, searchRecentTweets, getTweetById, extractTweetId,
} from './x-client.js';
import {
  getUserProfile, getTweet, search, getTrends,
} from './brightdata-client.js';
import { readWithOAuthFallback } from './read-fallback.js';

const PORT = parseInt(process.env.MCP_SERVER_PORT || '8000', 10);
const API_KEY = process.env.X_MCP_API_KEY;

const app = express();
app.use(express.json({ limit: '10mb' }));

app.get('/health', (_, res) => res.send('ok'));

app.post('/mcp', async (req, res) => {
  // ── Backend ↔ MCP container shared secret ───────────────────────────────
  const providedKey = (req.headers['x-api-key'] as string) || '';
  if (!API_KEY || providedKey !== API_KEY) {
    res.status(401).json({ error: 'Unauthorized', message: 'Valid X-API-Key required' });
    return;
  }

  // ── Per-user OAuth 2.0 access token (already refreshed upstream) ────────
  // Writes require this header. Reads PREFER it too (ticket f609ec35): with a
  // token attached, read tools try the authenticated X API v2 first and only
  // fall back to the wall-detecting Bright Data scrape when the API rejects
  // the read (e.g. developer-app tier without read access) — see
  // read-fallback.ts.
  const xToken = (req.headers['x-x-token'] as string | undefined) || '';

  const server = new McpServer({ name: 'x', version: '1.0.0' });

  // ── Read tools (OAuth-first via read-fallback; scrape fallback is wall-detected) ──

  server.tool(
    'x_get_user_profile',
    'Fetch an X user profile + recent posts (read-only; uses the connected X account when available, else public scrape)',
    { username: z.string().describe('Handle without the @, e.g. "jack"') },
    async ({ username }) => {
      const text = await readWithOAuthFallback(xToken, {
        apiRead: (t) => lookupUserWithTweets(t, username),
        scrapeRead: () => getUserProfile(username),
      });
      return { content: [{ type: 'text' as const, text }] };
    },
  );

  server.tool(
    'x_get_tweet',
    'Fetch a single tweet by URL or ID (read-only; uses the connected X account when available, else public scrape)',
    { tweet: z.string().describe('URL, "user/status/id", or numeric tweet ID') },
    async ({ tweet }) => {
      const id = extractTweetId(tweet);
      const text = id
        ? await readWithOAuthFallback(xToken, {
            apiRead: (t) => getTweetById(t, id),
            scrapeRead: () => getTweet(tweet),
          })
        : await getTweet(tweet);
      return { content: [{ type: 'text' as const, text }] };
    },
  );

  server.tool(
    'x_search',
    'Search recent X posts (read-only; uses the connected X account when available, else public scrape, with a Google site:x.com fallback when X anti-bot blocks the scrape)',
    { query: z.string().describe('Search query (supports X operators like from:, since:, lang:)') },
    async ({ query }) => {
      const text = await readWithOAuthFallback(xToken, {
        apiRead: (t) => searchRecentTweets(t, query),
        scrapeRead: () => search(query),
      });
      return { content: [{ type: 'text' as const, text }] };
    },
  );

  server.tool(
    'x_get_trends',
    'Fetch X trending topics as markdown (X API v2 trends is enterprise-gated; reads the login-free trends24.in mirror of X trends first and scrapes x.com/explore only when the mirror itself is down — x.com blocks unauthenticated scraping)',
    { woeid: z.string().optional().describe('Optional Yahoo Where-On-Earth ID for region-specific trends') },
    async ({ woeid }) => {
      const text = await getTrends(woeid);
      return { content: [{ type: 'text' as const, text }] };
    },
  );

  // ── Write tools (require user OAuth token) ──────────────────────────────

  const requireToken = (): string | null => xToken || null;

  server.tool(
    'x_get_me',
    'Get the authenticated user (their X handle, ID, bio)',
    {},
    async () => {
      const t = requireToken();
      if (!t) return { content: [{ type: 'text' as const, text: 'No X token — user has not connected their X account.' }] };
      return { content: [{ type: 'text' as const, text: await getMe(t) }] };
    },
  );

  server.tool(
    'x_post_tweet',
    'Post a new tweet (or reply / quote tweet) as the authenticated user',
    {
      text: z.string().describe('Tweet body, ≤280 chars unless on premium'),
      reply_to_tweet_id: z.string().optional().describe('If set, post as a reply to this tweet'),
      quote_tweet_id: z.string().optional().describe('If set, post as a quote of this tweet'),
    },
    async ({ text, reply_to_tweet_id, quote_tweet_id }) => {
      const t = requireToken();
      if (!t) return { content: [{ type: 'text' as const, text: 'Cannot post — user has not connected their X account.' }] };
      const r = await postTweet(t, text, reply_to_tweet_id, quote_tweet_id);
      return { content: [{ type: 'text' as const, text: r }] };
    },
  );

  server.tool(
    'x_delete_tweet',
    'Delete one of the authenticated user\'s own tweets',
    { tweet_id: z.string().describe('Tweet ID to delete') },
    async ({ tweet_id }) => {
      const t = requireToken();
      if (!t) return { content: [{ type: 'text' as const, text: 'Cannot delete — user has not connected their X account.' }] };
      return { content: [{ type: 'text' as const, text: await deleteTweet(t, tweet_id) }] };
    },
  );

  server.tool(
    'x_like',
    'Like a tweet',
    { tweet_id: z.string().describe('Tweet ID to like') },
    async ({ tweet_id }) => {
      const t = requireToken();
      if (!t) return { content: [{ type: 'text' as const, text: 'Cannot like — user has not connected their X account.' }] };
      return { content: [{ type: 'text' as const, text: await likeTweet(t, tweet_id) }] };
    },
  );

  server.tool(
    'x_unlike',
    'Remove a like from a tweet',
    { tweet_id: z.string().describe('Tweet ID to unlike') },
    async ({ tweet_id }) => {
      const t = requireToken();
      if (!t) return { content: [{ type: 'text' as const, text: 'Cannot unlike — user has not connected their X account.' }] };
      return { content: [{ type: 'text' as const, text: await unlikeTweet(t, tweet_id) }] };
    },
  );

  server.tool(
    'x_retweet',
    'Retweet a tweet',
    { tweet_id: z.string().describe('Tweet ID to retweet') },
    async ({ tweet_id }) => {
      const t = requireToken();
      if (!t) return { content: [{ type: 'text' as const, text: 'Cannot retweet — user has not connected their X account.' }] };
      return { content: [{ type: 'text' as const, text: await retweet(t, tweet_id) }] };
    },
  );

  server.tool(
    'x_unretweet',
    'Undo a retweet',
    { tweet_id: z.string().describe('Tweet ID to unretweet') },
    async ({ tweet_id }) => {
      const t = requireToken();
      if (!t) return { content: [{ type: 'text' as const, text: 'Cannot unretweet — user has not connected their X account.' }] };
      return { content: [{ type: 'text' as const, text: await unretweet(t, tweet_id) }] };
    },
  );

  server.tool(
    'x_follow',
    'Follow an X user',
    { username_or_id: z.string().describe('Handle (with or without @) or numeric user ID') },
    async ({ username_or_id }) => {
      const t = requireToken();
      if (!t) return { content: [{ type: 'text' as const, text: 'Cannot follow — user has not connected their X account.' }] };
      return { content: [{ type: 'text' as const, text: await follow(t, username_or_id) }] };
    },
  );

  server.tool(
    'x_unfollow',
    'Unfollow an X user',
    { username_or_id: z.string().describe('Handle (with or without @) or numeric user ID') },
    async ({ username_or_id }) => {
      const t = requireToken();
      if (!t) return { content: [{ type: 'text' as const, text: 'Cannot unfollow — user has not connected their X account.' }] };
      return { content: [{ type: 'text' as const, text: await unfollow(t, username_or_id) }] };
    },
  );

  try {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err: any) {
    console.error('[x-mcp] Request error:', err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`[x-mcp] listening on :${PORT}`);
});
