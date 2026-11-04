import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

import {
  discordGetBotInfo,
  discordListGuilds,
  discordListChannels,
  discordChannelHistory,
  discordSendMessage,
  discordListDms,
  discordSendDm,
  discordScrapeChannel,
} from './tools/discord.js';

const PORT = parseInt(process.env.MCP_SERVER_PORT || '8000', 10);
const API_KEY = process.env.DISCORD_MCP_API_KEY;
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const app = express();
app.use(express.json({ limit: '10mb' }));

app.get('/health', (_, res) => res.send('ok'));

app.post('/mcp', async (req, res) => {
  const providedKey = (req.headers['x-api-key'] as string) || '';
  if (!API_KEY || providedKey !== API_KEY) {
    res.status(401).json({ error: 'Unauthorized', message: 'Valid X-API-Key required' });
    return;
  }

  // Discord bots use a single bot token (ticket c0e2769b) — unlike Slack's
  // per-user OAuth tokens. The env token is the default; a caller may supply
  // its own bot token per request via X-Discord-Token.
  const token = (req.headers['x-discord-token'] as string | undefined) || BOT_TOKEN;
  if (!token) {
    res.status(401).json({ error: 'X-Discord-Token header required' });
    return;
  }

  const server = new McpServer({ name: 'discord', version: '1.0.0' });

  server.tool(
    'discord_get_bot_info',
    'Get the bot identity (username, display name, user id) — use this to verify the bot token works',
    {},
    async () => {
      const text = await discordGetBotInfo(token);
      return { content: [{ type: 'text' as const, text }] };
    },
  );

  server.tool(
    'discord_list_guilds',
    'List servers (guilds) the bot is a member of',
    {
      limit: z.number().optional().describe('Max guilds to return (default 50, max 200)'),
    },
    async ({ limit }) => {
      const text = await discordListGuilds(token, limit ?? 50);
      return { content: [{ type: 'text' as const, text }] };
    },
  );

  server.tool(
    'discord_list_channels',
    'List channels in a guild (server), sorted by position, with types and topics',
    {
      guildId: z.string().describe('Guild (server) ID — get it from discord_list_guilds'),
    },
    async ({ guildId }) => {
      const text = await discordListChannels(token, guildId);
      return { content: [{ type: 'text' as const, text }] };
    },
  );

  server.tool(
    'discord_channel_history',
    'Get recent messages in a channel (newest first)',
    {
      channelId: z.string().describe('Channel ID — get it from discord_list_channels'),
      limit: z.number().optional().describe('Max messages to return (default 20, max 100)'),
      before: z.string().optional().describe('Snowflake message ID: return messages older than it (pagination)'),
    },
    async ({ channelId, limit, before }) => {
      const text = await discordChannelHistory(token, channelId, limit ?? 20, before);
      return { content: [{ type: 'text' as const, text }] };
    },
  );

  server.tool(
    'discord_send_message',
    'Send a message to a channel as the bot',
    {
      channelId: z.string().describe('Channel ID to post in'),
      content: z.string().describe('Message text'),
      replyTo: z.string().optional().describe('Message ID to reply to'),
    },
    async ({ channelId, content, replyTo }) => {
      const out = await discordSendMessage(token, channelId, content, replyTo);
      return { content: [{ type: 'text' as const, text: out }] };
    },
  );

  server.tool(
    'discord_list_dms',
    'List DM channels open with the bot (a user must DM the bot first to open one)',
    {},
    async () => {
      const text = await discordListDms(token);
      return { content: [{ type: 'text' as const, text }] };
    },
  );

  server.tool(
    'discord_send_dm',
    'Send a direct message to a user as the bot (opens the DM channel if needed)',
    {
      userId: z.string().describe('Discord user ID to DM'),
      content: z.string().describe('Message text'),
    },
    async ({ userId, content }) => {
      const out = await discordSendDm(token, userId, content);
      return { content: [{ type: 'text' as const, text: out }] };
    },
  );

  server.tool(
    'discord_scrape_channel',
    'Scrape up to 2000 messages of full channel history (paginated, rate-limit aware)',
    {
      channelId: z.string().describe('Channel ID to scrape'),
      maxMessages: z.number().optional().describe('Max messages to collect (default 500, hard cap 2000)'),
      before: z.string().optional().describe('Snowflake message ID: only collect messages older than it'),
    },
    async ({ channelId, maxMessages, before }) => {
      const out = await discordScrapeChannel(token, channelId, maxMessages ?? 500, before);
      return { content: [{ type: 'text' as const, text: out }] };
    },
  );

  try {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err: any) {
    console.error('[discord-mcp] Request error:', err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`[discord-mcp] listening on :${PORT}`);
});
