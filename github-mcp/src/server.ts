import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

import {
  githubListRepos,
  githubGetRepo,
  githubSearchRepos,
} from './tools/repos.js';
import {
  githubListIssues,
  githubCreateIssue,
  githubGetIssue,
} from './tools/issues.js';
import {
  githubListPullRequests,
  githubGetPullRequest,
} from './tools/pulls.js';
import {
  githubSearchCode,
  githubGetFileContents,
  githubCreateOrUpdateFile,
  githubGetUser,
} from './tools/code.js';

const PORT = parseInt(process.env.MCP_SERVER_PORT || '8000', 10);
const API_KEY = process.env.GITHUB_MCP_API_KEY;
const app = express();
app.use(express.json({ limit: '10mb' }));

app.get('/health', (_, res) => res.send('ok'));

app.post('/mcp', async (req, res) => {
  const providedKey = (req.headers['x-api-key'] as string) || '';
  if (!API_KEY || providedKey !== API_KEY) {
    res.status(401).json({ error: 'Unauthorized', message: 'Valid X-API-Key required' });
    return;
  }

  const githubToken = req.headers['x-github-token'] as string | undefined;
  if (!githubToken) {
    res.status(401).json({ error: 'X-GitHub-Token header required' });
    return;
  }

  const server = new McpServer({ name: 'github', version: '1.0.0' });

  server.tool(
    'github_list_repos',
    'List repositories for the authenticated user',
    {
      sort: z.enum(['created', 'updated', 'pushed', 'full_name']).optional().describe('Sort order'),
      perPage: z.number().optional().describe('Results per page (default 10, max 30)'),
      type: z.enum(['all', 'owner', 'public', 'private', 'member']).optional().describe('Filter by repo type'),
    },
    async ({ sort, perPage, type }) => {
      const text = await githubListRepos(githubToken, sort, perPage ?? 10, type);
      return { content: [{ type: 'text' as const, text }] };
    },
  );

  server.tool(
    'github_get_repo',
    'Get details of a specific repository',
    {
      owner: z.string().describe('Repository owner (username or org)'),
      repo: z.string().describe('Repository name'),
    },
    async ({ owner, repo }) => {
      const text = await githubGetRepo(githubToken, owner, repo);
      return { content: [{ type: 'text' as const, text }] };
    },
  );

  server.tool(
    'github_search_repos',
    'Search GitHub repositories',
    {
      query: z.string().describe('Search query'),
      perPage: z.number().optional().describe('Results per page (default 10, max 30)'),
    },
    async ({ query, perPage }) => {
      const text = await githubSearchRepos(githubToken, query, perPage ?? 10);
      return { content: [{ type: 'text' as const, text }] };
    },
  );

  server.tool(
    'github_list_issues',
    'List issues in a repository',
    {
      owner: z.string().describe('Repository owner (username or org)'),
      repo: z.string().describe('Repository name'),
      state: z.enum(['open', 'closed', 'all']).optional().describe('Filter by state'),
      perPage: z.number().optional().describe('Results per page (default 10, max 30)'),
    },
    async ({ owner, repo, state, perPage }) => {
      const text = await githubListIssues(githubToken, owner, repo, state ?? 'open', perPage ?? 10);
      return { content: [{ type: 'text' as const, text }] };
    },
  );

  server.tool(
    'github_create_issue',
    'Create a new issue',
    {
      owner: z.string().describe('Repository owner (username or org)'),
      repo: z.string().describe('Repository name'),
      title: z.string().describe('Title'),
      body: z.string().optional().describe('Description body'),
      labels: z.array(z.string()).optional().describe('Label names'),
    },
    async ({ owner, repo, title, body, labels }) => {
      const text = await githubCreateIssue(githubToken, owner, repo, title, body, labels);
      return { content: [{ type: 'text' as const, text }] };
    },
  );

  server.tool(
    'github_get_issue',
    'Get a single issue by number',
    {
      owner: z.string().describe('Repository owner (username or org)'),
      repo: z.string().describe('Repository name'),
      issue_number: z.number().describe('Issue number'),
    },
    async ({ owner, repo, issue_number }) => {
      const text = await githubGetIssue(githubToken, owner, repo, issue_number);
      return { content: [{ type: 'text' as const, text }] };
    },
  );

  server.tool(
    'github_list_pull_requests',
    'List pull requests in a repository',
    {
      owner: z.string().describe('Repository owner (username or org)'),
      repo: z.string().describe('Repository name'),
      state: z.enum(['open', 'closed', 'all']).optional().describe('Filter by state'),
      perPage: z.number().optional().describe('Results per page (default 10, max 30)'),
    },
    async ({ owner, repo, state, perPage }) => {
      const text = await githubListPullRequests(githubToken, owner, repo, state ?? 'open', perPage ?? 10);
      return { content: [{ type: 'text' as const, text }] };
    },
  );

  server.tool(
    'github_get_pull_request',
    'Get a single pull request',
    {
      owner: z.string().describe('Repository owner (username or org)'),
      repo: z.string().describe('Repository name'),
      pull_number: z.number().describe('Pull request number'),
    },
    async ({ owner, repo, pull_number }) => {
      const text = await githubGetPullRequest(githubToken, owner, repo, pull_number);
      return { content: [{ type: 'text' as const, text }] };
    },
  );

  server.tool(
    'github_search_code',
    'Search code via GitHub\'s code-search API (indexes each repo\'s default branch only; forks excluded unless the query has fork:true; some private repos are not indexed). The Digby backend auto-scopes plain queries to the connected account\'s repos; queries with explicit user:/org:/repo:/owner: qualifiers pass through unchanged.',
    {
      query: z.string().describe('Search query'),
      perPage: z.number().optional().describe('Results per page (default 10, max 30)'),
    },
    async ({ query, perPage }) => {
      const text = await githubSearchCode(githubToken, query, perPage ?? 10);
      return { content: [{ type: 'text' as const, text }] };
    },
  );

  server.tool(
    'github_get_file_contents',
    'Read a file from a repository',
    {
      owner: z.string().describe('Repository owner (username or org)'),
      repo: z.string().describe('Repository name'),
      path: z.string().describe('File path in the repository'),
      ref: z.string().optional().describe('Git ref (branch, tag, commit SHA)'),
    },
    async ({ owner, repo, path, ref }) => {
      const text = await githubGetFileContents(githubToken, owner, repo, path, ref);
      return { content: [{ type: 'text' as const, text }] };
    },
  );

  server.tool(
    'github_create_or_update_file',
    'Create or update a file in a repository',
    {
      owner: z.string().describe('Repository owner (username or org)'),
      repo: z.string().describe('Repository name'),
      path: z.string().describe('File path in the repository'),
      message: z.string().describe('Commit message'),
      content: z.string().describe('File content'),
      branch: z.string().optional().describe('Branch name'),
      sha: z.string().optional().describe('File SHA (required for updates)'),
    },
    async ({ owner, repo, path, message, content, branch, sha }) => {
      const text = await githubCreateOrUpdateFile(githubToken, owner, repo, path, message, content, branch, sha);
      return { content: [{ type: 'text' as const, text }] };
    },
  );

  server.tool(
    'github_get_user',
    'Get authenticated user info',
    {},
    async () => {
      const text = await githubGetUser(githubToken);
      return { content: [{ type: 'text' as const, text }] };
    },
  );

  try {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err: any) {
    console.error('[github-mcp] Request error:', err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`[github-mcp] listening on :${PORT}`);
});