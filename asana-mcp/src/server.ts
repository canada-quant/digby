import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

import {
  asanaGetUser,
  asanaListWorkspaces,
  asanaListProjects,
  asanaListMyTasks,
  asanaGetTask,
  asanaSearchTasks,
  asanaCreateTask,
  asanaUpdateTask,
} from './tools/asana.js';

const PORT = parseInt(process.env.MCP_SERVER_PORT || '8000', 10);
const API_KEY = process.env.ASANA_MCP_API_KEY;
const app = express();
app.use(express.json({ limit: '10mb' }));

app.get('/health', (_, res) => res.send('ok'));

app.post('/mcp', async (req, res) => {
  const providedKey = (req.headers['x-api-key'] as string) || '';
  if (!API_KEY || providedKey !== API_KEY) {
    res.status(401).json({ error: 'Unauthorized', message: 'Valid X-API-Key required' });
    return;
  }

  const asanaToken = req.headers['x-asana-token'] as string | undefined;
  if (!asanaToken) {
    res.status(401).json({ error: 'X-Asana-Token header required' });
    return;
  }

  const server = new McpServer({ name: 'asana', version: '1.0.0' });

  server.tool(
    'asana_get_user',
    'Get the current authenticated Asana user',
    {},
    async () => {
      const text = await asanaGetUser(asanaToken);
      return { content: [{ type: 'text' as const, text }] };
    },
  );

  server.tool(
    'asana_list_workspaces',
    'List workspaces for the authenticated user',
    {},
    async () => {
      const text = await asanaListWorkspaces(asanaToken);
      return { content: [{ type: 'text' as const, text }] };
    },
  );

  server.tool(
    'asana_list_projects',
    'List projects in a workspace',
    {
      workspace: z.string().optional().describe('Workspace gid (defaults to the user\'s first workspace)'),
    },
    async ({ workspace }) => {
      const text = await asanaListProjects(asanaToken, workspace);
      return { content: [{ type: 'text' as const, text }] };
    },
  );

  server.tool(
    'asana_list_my_tasks',
    'List the authenticated user\'s incomplete assigned tasks',
    {
      workspace: z.string().optional().describe('Workspace gid (defaults to the user\'s first workspace)'),
    },
    async ({ workspace }) => {
      const text = await asanaListMyTasks(asanaToken, workspace);
      return { content: [{ type: 'text' as const, text }] };
    },
  );

  server.tool(
    'asana_create_task',
    'Create a task (in a project, or in the workspace when no project is given)',
    {
      name: z.string().describe('Task name'),
      notes: z.string().optional().describe('Task description'),
      project: z.string().optional().describe('Project gid to file the task in'),
      workspace: z.string().optional().describe('Workspace gid (defaults to the first workspace)'),
      dueOn: z.string().optional().describe('YYYY-MM-DD'),
      assignee: z.string().optional().describe('User gid or "me"'),
    },
    async (input) => {
      const text = await asanaCreateTask(asanaToken, input);
      return { content: [{ type: 'text' as const, text }] };
    },
  );

  server.tool(
    'asana_update_task',
    'Update a task: name, notes, completed, due date',
    {
      taskId: z.string().describe('Task gid'),
      name: z.string().optional(),
      notes: z.string().optional(),
      completed: z.boolean().optional(),
      dueOn: z.string().nullable().optional().describe('YYYY-MM-DD, or null to clear'),
    },
    async ({ taskId, ...rest }) => {
      const text = await asanaUpdateTask(asanaToken, taskId, rest);
      return { content: [{ type: 'text' as const, text }] };
    },
  );

  server.tool(
    'asana_get_task',
    'Get a single task by its ID',
    {
      taskId: z.string().describe('Task gid'),
    },
    async ({ taskId }) => {
      const text = await asanaGetTask(asanaToken, taskId);
      return { content: [{ type: 'text' as const, text }] };
    },
  );

  server.tool(
    'asana_search_tasks',
    'Search tasks in a workspace by text',
    {
      workspace: z.string().optional().describe('Workspace gid (defaults to the user\'s first workspace)'),
      text: z.string().describe('Search text'),
    },
    async ({ workspace, text }) => {
      const result = await asanaSearchTasks(asanaToken, text, workspace);
      return { content: [{ type: 'text' as const, text: result }] };
    },
  );

  try {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err: any) {
    console.error('[asana-mcp] Request error:', err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`[asana-mcp] listening on :${PORT}`);
});
