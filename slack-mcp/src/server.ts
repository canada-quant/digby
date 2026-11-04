import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

import {
  slackListChannels,
  slackChannelHistory,
  slackSearchMessages,
  slackListUsers,
  slackGetAuth,
  slackPostMessage,
} from './tools/slack.js';

const PORT = parseInt(process.env.MCP_SERVER_PORT || '8000', 10);
const API_KEY = process.env.SLACK_MCP_API_KEY;
const app = express();
app.use(express.json({ limit: '10mb' }));

app.get('/health', (_, res) => res.send('ok'));

app.post('/mcp', async (req, res) => {
  const providedKey = (req.headers['x-api-key'] as string) || '';
  if (!API_KEY || providedKey !== API_KEY) {
    res.status(401).json({ error: 'Unauthorized', message: 'Valid X-API-Key required' });
    return;
  }

  const slackToken = req.headers['x-slack-token'] as string | undefined;
  if (!slackToken) {
    res.status(401).json({ error: 'X-Slack-Token header required' });
    return;
  }

  const server = new McpServer({ name: 'slack', version: '1.0.0' });

  server.tool(
    'slack_list_channels',
    'List channels in the Slack workspace',
    {
      limit: z.number().optional().describe('Max channels to return (default 50, max 100)'),
      types: z.string().optional().describe('Comma-separated channel types (default public_channel,private_channel)'),
    },
    async ({ limit, types }) => {
      const text = await slackListChannels(slackToken, limit ?? 50, types);
      return { content: [{ type: 'text' as const, text }] };
    },
  );

  server.tool(
    'slack_post_message',
    'Post a message to a channel or DM as the authenticated user',
    {
      channel: z.string().describe('Channel ID or #name'),
      text: z.string().describe('Message text'),
      thread_ts: z.string().optional().describe('Reply in this thread'),
    },
    async ({ channel, text, thread_ts }) => {
      const out = await slackPostMessage(slackToken, channel, text, thread_ts);
      return { content: [{ type: 'text' as const, text: out }] };
    },
  );

  server.tool(
    'slack_channel_history',
    'Get recent messages in a channel',
    {
      channel: z.string().describe('Channel ID or #name'),
      limit: z.number().optional().describe('Max messages to return (default 20, max 100)'),
    },
    async ({ channel, limit }) => {
      const text = await slackChannelHistory(slackToken, channel, limit ?? 20);
      return { content: [{ type: 'text' as const, text }] };
    },
  );

  server.tool(
    'slack_search_messages',
    'Search messages across the workspace',
    {
      query: z.string().describe('Search query'),
      count: z.number().optional().describe('Max matches to return (default 20, max 100)'),
    },
    async ({ query, count }) => {
      const text = await slackSearchMessages(slackToken, query, count ?? 20);
      return { content: [{ type: 'text' as const, text }] };
    },
  );

  server.tool(
    'slack_list_users',
    'List workspace members',
    {
      limit: z.number().optional().describe('Max users to return (default 50, max 100)'),
    },
    async ({ limit }) => {
      const text = await slackListUsers(slackToken, limit ?? 50);
      return { content: [{ type: 'text' as const, text }] };
    },
  );

  server.tool(
    'slack_get_auth',
    'Get the authenticated user/team identity (auth.test)',
    {},
    async () => {
      const text = await slackGetAuth(slackToken);
      return { content: [{ type: 'text' as const, text }] };
    },
  );

  try {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err: any) {
    console.error('[slack-mcp] Request error:', err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`[slack-mcp] listening on :${PORT}`);
});
