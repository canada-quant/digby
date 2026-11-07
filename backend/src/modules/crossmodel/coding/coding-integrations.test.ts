/**
 * Integrations-everywhere: every working READ wrapper is exposed as an agent
 * tool. The executor maps args onto the wrapper modules (all mocked here),
 * degrades gracefully (empty → "No result…", reject → "<name> failed: …",
 * never throws), and the chat orchestrator whitelist in the REAL agent module
 * stays in parity with INTEGRATION_TOOL_NAMES (tripwire).
 *
 * The REAL ./agent module is imported for the parity tripwire — its transitive
 * graph touches prisma + redis (and logger → config/env), so all three are
 * mocked with the repo-standard stand-ins.
 */

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../../config/database', () => ({ __esModule: true, default: {} }));

// config/env calls process.exit(1) without env vars and kills the whole jest
// worker at import time. The REAL ./agent graph now also reaches it via
// agent → tools → platform-tools → platform.service → error-handler (P6),
// and via platform.validation → agent-auth → utils/jwt — mock env at the root.
jest.mock('../../../config/env', () => ({
  __esModule: true,
  env: { NODE_ENV: 'test' },
}));
jest.mock('../../../config/redis', () => ({
  __esModule: true,
  default: { set: jest.fn(), get: jest.fn(), del: jest.fn(), publish: jest.fn() },
}));

jest.mock('../github/github-mcp', () => ({
  searchCode: jest.fn(),
  getFileContents: jest.fn(),
  listIssues: jest.fn(),
  getIssue: jest.fn(),
  listPullRequests: jest.fn(),
}));
jest.mock('../google/google-mcp', () => ({
  resolveGoogleAccount: jest.fn(),
  getGmailMessages: jest.fn(),
  getGmailMessage: jest.fn(),
  getGmailAttachment: jest.fn(),
  fetchGmailAttachmentRaw: jest.fn(),
  gmailAttachmentTextFromRaw: jest.fn(),
  getCalendarEvents: jest.fn(),
  listDriveFiles: jest.fn(),
  getDocContent: jest.fn(),
  getSheetData: jest.fn(),
}));
// 99145890 auto-ingest hook: the dynamic import() inside the gmail_get_attachment
// case resolves through this mock — pinning that the hook calls the GATED
// autoIngestGmailAttachmentIfEnabled (review F2), never ingestGmailAttachment.
jest.mock('../gmail-knowledge.service', () => ({
  ingestGmailAttachment: jest.fn(),
  autoIngestGmailAttachmentIfEnabled: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../slack/slack-mcp', () => ({
  searchMessages: jest.fn(),
  listChannels: jest.fn(),
  getChannelHistory: jest.fn(),
}));
jest.mock('../asana/asana-mcp', () => ({
  searchTasks: jest.fn(),
  listMyTasks: jest.fn(),
  listProjects: jest.fn(),
}));
jest.mock('../x/x-mcp', () => ({
  search: jest.fn(),
  getUserProfile: jest.fn(),
  getTrends: jest.fn(),
}));
jest.mock('../xero/xero-mcp', () => ({
  getOrganisation: jest.fn(),
  getContacts: jest.fn(),
  getInvoices: jest.fn(),
}));
jest.mock('../plaid/plaid-mcp', () => ({
  getAccounts: jest.fn(),
  getBalances: jest.fn(),
  getTransactions: jest.fn(),
}));
jest.mock('../imessage/imessage.service', () => ({
  selectAgent: jest.fn(),
  listAgents: jest.fn(async () => []),
  agentDisplayName: (a: any) => (a?.label || a?.deviceName || 'Mac'),
  isOnline: (lastSeenAt: any) => !!lastSeenAt && Date.now() - new Date(lastSeenAt).getTime() < 45_000,
}));
jest.mock('../imessage/agent-link', () => ({
  agentBroker: { dispatch: jest.fn() },
  IMESSAGE_READ_DISPATCH_TIMEOUT_MS: 30_000, // the 2026-10-22 Mac-wedge budget (IMSG-1)
}));

import {
  INTEGRATION_TOOL_SCHEMA, INTEGRATION_TOOL_NAMES, isIntegrationTool, executeIntegrationTool,
} from './coding-integrations';
import { CHAT_ORCH_TOOLS, WEB_TOOL_NAMES } from './agent';
import { CODING_TOOL_SCHEMA } from './tools';
import { ROLE_TOOLS } from './roles';
import { TOOL_DEFINITIONS } from '../tool-executor';
import * as google from '../google/google-mcp';
import * as slack from '../slack/slack-mcp';
import * as x from '../x/x-mcp';
import * as xero from '../xero/xero-mcp';
import * as plaid from '../plaid/plaid-mcp';
import { selectAgent, listAgents } from '../imessage/imessage.service';
import { agentBroker } from '../imessage/agent-link';

const U = 'u1';
const asMock = (f: unknown) => f as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  // Google reads run an account-resolution precheck first; default it to OK so
  // the wrapper-mapping tests below exercise the read path.
  asMock((google as any).resolveGoogleAccount).mockResolvedValue({ ok: true, token: 't' });
});

describe('schema surface', () => {
  it('exposes the 8 original + 20 read tools + 11 Google write tools (2026-09-23) + 5 connector write tools (#26, 2026-09-24) + 1 Mac-agent calendar read (1ea9a120) + 7 Discord tools (5 read + 2 human-turn write) + github_get_file_contents (fs-code-knowledge 2026-10-22), and only those', () => {
    expect(INTEGRATION_TOOL_NAMES).toHaveLength(53);
    expect(INTEGRATION_TOOL_NAMES).toContain('github_get_file_contents');
    expect(INTEGRATION_TOOL_NAMES).toContain('mac_calendar_list_events');
    for (const n of ['imessage_send', 'slack_post_message', 'asana_create_task', 'asana_update_task', 'x_post', 'discord_send_message', 'discord_send_dm']) expect(INTEGRATION_TOOL_NAMES).toContain(n);
    for (const n of ['gmail_send_email', 'gmail_create_draft', 'calendar_create_event', 'docs_create_document', 'docs_append_text', 'sheets_create_spreadsheet', 'sheets_write_values', 'sheets_append_rows', 'drive_upload_file', 'drive_create_folder', 'slides_create_presentation']) {
      expect(INTEGRATION_TOOL_NAMES).toContain(n);
    }
    expect(INTEGRATION_TOOL_SCHEMA.every(t => INTEGRATION_TOOL_NAMES.includes(t.function.name))).toBe(true);
    for (const n of INTEGRATION_TOOL_NAMES) expect(isIntegrationTool(n)).toBe(true);
    // 2026-09-23 (owner: "add all of that"): sending IS an agent tool now — human-attended turns only
    // (the machine-run refusal is pinned in coding-integrations.google-writes.test.ts).
    expect(isIntegrationTool('gmail_send_email')).toBe(true);
    expect(isIntegrationTool('x_post_tweet')).toBe(false);
    expect(isIntegrationTool('nope')).toBe(false);
  });
});

describe('pipe routing tripwire', () => {
  // web_pipe/youtube_pipe each have TWO executors: a legacy one (ToolCache →
  // run*Pipe(null, …) — digest only, no session RAG store) and a session-aware
  // one (executeCodingTool → run*Pipe(sessionId, …) — embeds to session memory).
  // Agent-run dispatch checks WEB_TOOL_NAMES FIRST, so a pipe tool in that set
  // silently takes the legacy path and the "N chunks embedded to session
  // memory" contract breaks (search_memory then finds nothing) — 2026-08
  // review catch when youtube_pipe was added to TOOL_DEFINITIONS.
  const PIPE_TOOLS = ['web_pipe', 'youtube_pipe'];

  it('pipe tools are NOT in WEB_TOOL_NAMES (agent runs route to the session-aware executor)', () => {
    for (const n of PIPE_TOOLS) expect(WEB_TOOL_NAMES.has(n)).toBe(false);
  });

  it('pipe tools ARE registered in both schema lists and in CHAT_ORCH_TOOLS', () => {
    const codingNames = CODING_TOOL_SCHEMA.map(t => t.function.name);
    const legacyNames = TOOL_DEFINITIONS.map(t => t.function.name);
    for (const n of PIPE_TOOLS) {
      expect(codingNames).toContain(n);
      expect(legacyNames).toContain(n);
      expect(CHAT_ORCH_TOOLS.has(n)).toBe(true);
    }
  });
});

describe('generate_image roster (owner 2026-09-24 — image generation)', () => {
  // The tool is dispatched through the ToolCache path (TOOL_DEFINITIONS →
  // WEB_TOOL_NAMES) and offered to the chat lead (CHAT_ORCH_TOOLS) — but never
  // to a worker role: the L2 checker / council colleagues must not draw (and
  // bill) a second copy of the lead's image.
  it('is in TOOL_DEFINITIONS, WEB_TOOL_NAMES and CHAT_ORCH_TOOLS, and in no ROLE_TOOLS role', () => {
    expect(TOOL_DEFINITIONS.map(t => t.function.name)).toContain('generate_image');
    expect(WEB_TOOL_NAMES.has('generate_image')).toBe(true);
    expect(CHAT_ORCH_TOOLS.has('generate_image')).toBe(true);
    for (const [role, names] of Object.entries(ROLE_TOOLS)) {
      expect({ role, granted: names.includes('generate_image') }).toEqual({ role, granted: false });
    }
  });
});

describe('ROLE_TOOLS ↔ schema sync (review NB1 — silent-drop guard)', () => {
  // toolsForRole drops unknown names SILENTLY, so a ROLE_TOOLS grant with no
  // registered schema just vanishes from the worker's advertised tool set (and
  // the roles.test.ts fixture list is hand-maintained — it can drift). Assert
  // every name granted to any role resolves to a real registered schema.
  it('every ROLE_TOOLS name resolves to a registered schema entry', () => {
    const registered = new Set([
      ...CODING_TOOL_SCHEMA.map(t => t.function.name),
      ...TOOL_DEFINITIONS.map(t => t.function.name),
      ...INTEGRATION_TOOL_NAMES,
    ]);
    const missing: string[] = [];
    for (const [role, names] of Object.entries(ROLE_TOOLS)) {
      for (const n of names) if (!registered.has(n)) missing.push(`${role}:${n}`);
    }
    expect(missing).toEqual([]);
  });
});

describe('executeIntegrationTool', () => {
  // fs-code-knowledge (2026-10-22): github_search_code pointed at github_get_file_contents,
  // which was never exposed — the read-only file read now dispatches to github-mcp.
  it('github_get_file_contents → github.getFileContents (owner/repo/path/ref; leading slash and .git trimmed; capped)', async () => {
    const gh = jest.requireMock('../github/github-mcp');
    gh.getFileContents.mockResolvedValue('[GitHub File: o/r/src/a.ts]\nbody');
    await expect(executeIntegrationTool(U, 'github_get_file_contents', { owner: 'o', repo: 'r.git', path: '/src/a.ts', ref: 'main' })).resolves.toContain('body');
    expect(gh.getFileContents).toHaveBeenCalledWith(U, 'o', 'r', 'src/a.ts', 'main');
    await executeIntegrationTool(U, 'github_get_file_contents', { owner: 'o', repo: 'r', path: 'x.ts' });
    expect(gh.getFileContents).toHaveBeenLastCalledWith(U, 'o', 'r', 'x.ts', undefined);
    await expect(executeIntegrationTool(U, 'github_get_file_contents', { repo: 'r', path: 'x' })).resolves.toMatch(/needs owner and repo/);
    gh.getFileContents.mockResolvedValue('');
    await expect(executeIntegrationTool(U, 'github_get_file_contents', { owner: 'o', repo: 'r', path: 'x' })).resolves.toMatch(/^No result from GitHub/);
    gh.getFileContents.mockResolvedValue('y'.repeat(130_000));
    const big = await executeIntegrationTool(U, 'github_get_file_contents', { owner: 'o', repo: 'r', path: 'big.ts' });
    expect(big.length).toBeLessThan(121_000);
    expect(big).toMatch(/truncated 10000 chars/);
  });
  // Review (2026-10-22): the tool is described as THE existence check, so a 404
  // must say it is not proof of absence — GitHub answers 404 for a repo / branch
  // the token cannot see as well as for a missing path.
  it('github_get_file_contents: a GitHub 404 carries the NOT-proof-of-absence line (parent dir named); a real file does not', async () => {
    const gh = jest.requireMock('../github/github-mcp');
    gh.getFileContents.mockResolvedValue('[GitHub File: o/r/frontend/app/ghost.tsx]\nError getting file frontend/app/ghost.tsx: Not Found - https://docs.github.com/rest/repos/contents#get-repository-content');
    const out = await executeIntegrationTool(U, 'github_get_file_contents', { owner: 'o', repo: 'r', path: 'frontend/app/ghost.tsx' });
    expect(out).toContain('Error getting file frontend/app/ghost.tsx: Not Found');
    expect(out).toContain('GitHub answers 404 both for a missing path and for a repo or branch the connected account(s) cannot see — NOT proof the code does not exist');
    expect(out).toContain('list the parent directory (path "frontend/app")');
    expect(out).toContain('or search by content');
    gh.getFileContents.mockResolvedValue('[GitHub File: o/r/README.md]\nError getting file README.md: Not Found');
    expect(await executeIntegrationTool(U, 'github_get_file_contents', { owner: 'o', repo: 'r', path: 'README.md' })).toContain('(path "" — the repo root)');
    gh.getFileContents.mockResolvedValue('[GitHub File: o/r/a.ts]\n# a.ts\n```\nconst NotFound = 1;\n```');
    expect(await executeIntegrationTool(U, 'github_get_file_contents', { owner: 'o', repo: 'r', path: 'a.ts' })).not.toMatch(/NOT proof/);
  });
  it('isGitHubFileNotFoundText: anchored on the whole answer — a real file QUOTING the 404 phrase is never a miss', () => {
    const { isGitHubFileNotFoundText } = require('./integration-tool-schema');
    expect(isGitHubFileNotFoundText('Error getting file a.ts: Not Found - https://docs.github.com/x')).toBe(true);
    expect(isGitHubFileNotFoundText('[GitHub File: o/r/a.ts]\nError getting file a.ts: Not Found')).toBe(true);
    expect(isGitHubFileNotFoundText('# docs/x.md\nRepository: o/r\n\n```\nError getting file a.ts: Not Found\n```')).toBe(false);
    expect(isGitHubFileNotFoundText('Error getting file a.ts: Bad credentials')).toBe(false);
    expect(isGitHubFileNotFoundText(null)).toBe(false);
  });
  it('unknown tool → the Unknown message (never throws)', async () => {
    await expect(executeIntegrationTool(U, 'nope', {})).resolves.toBe('Unknown integration tool: nope');
  });

  it('gmail_get_message maps messageId onto the wrapper', async () => {
    asMock(google.getGmailMessage).mockResolvedValue('[Gmail Message]\nhi');
    await expect(executeIntegrationTool(U, 'gmail_get_message', { messageId: 'm1' })).resolves.toContain('hi');
    expect(google.getGmailMessage).toHaveBeenCalledWith(U, 'm1', undefined);
    // label threads through when provided (multi-account read fix, 2026-08-11)
    await executeIntegrationTool(U, 'gmail_get_message', { messageId: 'm2', label: 'Work' });
    expect(google.getGmailMessage).toHaveBeenCalledWith(U, 'm2', 'Work');
  });

  it('gmail_get_attachment passes (messageId, attachmentId, filename) in wrapper order — filename is the stable handle (2026-10-02; 99145890: fetches RAW, renders via gmailAttachmentTextFromRaw)', async () => {
    asMock(google.fetchGmailAttachmentRaw).mockResolvedValue({ ok: true, result: 'data', envelope: false });
    asMock(google.gmailAttachmentTextFromRaw).mockResolvedValue('data');
    await executeIntegrationTool(U, 'gmail_get_attachment', { messageId: 'm1', attachmentId: 'a1' });
    expect(google.fetchGmailAttachmentRaw).toHaveBeenCalledWith(U, 'm1', 'a1', '', undefined);
    expect(await asMock(google.gmailAttachmentTextFromRaw).mock.results[0].value).toBe('data');
    // label threads through when provided (feedback cb6a90b1 — parity with the #192 reads)
    await executeIntegrationTool(U, 'gmail_get_attachment', { messageId: 'm2', attachmentId: 'a2', label: 'Work' });
    expect(google.fetchGmailAttachmentRaw).toHaveBeenCalledWith(U, 'm2', 'a2', '', 'Work');
    // filename threads through as the TTL-proof handle (attachmentIds expire within ~2 minutes)
    await executeIntegrationTool(U, 'gmail_get_attachment', { messageId: 'm3', filename: 'stmt.pdf' });
    expect(google.fetchGmailAttachmentRaw).toHaveBeenCalledWith(U, 'm3', '', 'stmt.pdf', undefined);
    expect(await executeIntegrationTool(U, 'gmail_get_attachment', { messageId: 'm4', filename: 'stmt.pdf' })).toBe('data');
  });

  it('99145890 auto-ingest hook (review F1/F2/F5): fires the GATED autoIngestGmailAttachmentIfEnabled — only for envelope answers, with a real project, a filename and the setting not killed; never the ungated ingestGmailAttachment', async () => {
    const gmailKnowledge = jest.requireMock('../gmail-knowledge.service');
    asMock(google.fetchGmailAttachmentRaw).mockResolvedValue({ ok: true, result: 'env-json', envelope: true });
    asMock(google.gmailAttachmentTextFromRaw).mockResolvedValue('rendered');

    // (a) WITH a project + filename → the GATED function fires (not ingestGmailAttachment)
    await executeIntegrationTool(U, 'gmail_get_attachment',
      { messageId: 'm1', filename: 'stmt.pdf' }, { projectId: 'p1', sessionId: 's1' });
    await new Promise((r) => setImmediate(r)); // the hook is fire-and-forget
    expect(gmailKnowledge.autoIngestGmailAttachmentIfEnabled).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'p1', userId: U, messageId: 'm1', filename: 'stmt.pdf', sessionId: 's1', label: undefined,
    }));
    expect(gmailKnowledge.ingestGmailAttachment).not.toHaveBeenCalled();

    // (b) no project context (ungrouped chat / no ctx) → never fires
    jest.clearAllMocks();
    asMock(google.fetchGmailAttachmentRaw).mockResolvedValue({ ok: true, result: 'env-json', envelope: true });
    asMock(google.gmailAttachmentTextFromRaw).mockResolvedValue('rendered');
    await executeIntegrationTool(U, 'gmail_get_attachment', { messageId: 'm2', filename: 'x.pdf' });
    await new Promise((r) => setImmediate(r));
    expect(gmailKnowledge.autoIngestGmailAttachmentIfEnabled).not.toHaveBeenCalled();

    // (c) 'chat' sentinel → never fires
    await executeIntegrationTool(U, 'gmail_get_attachment',
      { messageId: 'm3', filename: 'x.pdf' }, { projectId: 'chat' });
    await new Promise((r) => setImmediate(r));
    expect(gmailKnowledge.autoIngestGmailAttachmentIfEnabled).not.toHaveBeenCalled();

    // (d) no filename → never fires (nothing to dedup against)
    await executeIntegrationTool(U, 'gmail_get_attachment',
      { messageId: 'm4' }, { projectId: 'p1' });
    await new Promise((r) => setImmediate(r));
    expect(gmailKnowledge.autoIngestGmailAttachmentIfEnabled).not.toHaveBeenCalled();

    // (e) TEXT attachment (ok:true, envelope:false) → never fires (review F5)
    jest.clearAllMocks();
    asMock(google.fetchGmailAttachmentRaw).mockResolvedValue({ ok: true, result: 'inline text', envelope: false });
    asMock(google.gmailAttachmentTextFromRaw).mockResolvedValue('inline text');
    await executeIntegrationTool(U, 'gmail_get_attachment',
      { messageId: 'm5', filename: 'notes.txt' }, { projectId: 'p1' });
    await new Promise((r) => setImmediate(r));
    expect(gmailKnowledge.autoIngestGmailAttachmentIfEnabled).not.toHaveBeenCalled();

    // (f) KILL SWITCH: GMAIL_AUTO_INGEST_DISABLED=1 → never fires
    jest.clearAllMocks();
    asMock(google.fetchGmailAttachmentRaw).mockResolvedValue({ ok: true, result: 'env-json', envelope: true });
    asMock(google.gmailAttachmentTextFromRaw).mockResolvedValue('rendered');
    process.env.GMAIL_AUTO_INGEST_DISABLED = '1';
    try {
      await executeIntegrationTool(U, 'gmail_get_attachment',
        { messageId: 'm6', filename: 'y.pdf' }, { projectId: 'p1' });
      await new Promise((r) => setImmediate(r));
      expect(gmailKnowledge.autoIngestGmailAttachmentIfEnabled).not.toHaveBeenCalled();
    } finally {
      delete process.env.GMAIL_AUTO_INGEST_DISABLED;
    }
  });

  it('calendar_list_events defaults to the wrapper window, maps daysAhead → timeMax', async () => {
    asMock(google.getCalendarEvents).mockResolvedValue('[events]');
    await executeIntegrationTool(U, 'calendar_list_events', {});
    expect(google.getCalendarEvents).toHaveBeenCalledWith(U, undefined, undefined, undefined);

    const t0 = Date.now();
    await executeIntegrationTool(U, 'calendar_list_events', { daysAhead: 14, maxResults: 5 });
    const [, timeMin, timeMax, maxResults] = asMock(google.getCalendarEvents).mock.calls[1];
    expect(timeMin).toBeUndefined();
    expect(maxResults).toBe(5);
    const aheadMs = new Date(timeMax).getTime() - t0;
    expect(aheadMs).toBeGreaterThan(13 * 86400000);
    expect(aheadMs).toBeLessThan(15 * 86400000);
  });

  it('sheets_get_data passes an explicit range through and omits it otherwise', async () => {
    asMock(google.getSheetData).mockResolvedValue('[rows]');
    await executeIntegrationTool(U, 'sheets_get_data', { spreadsheetId: 'sid', range: 'A1:B5' });
    expect(google.getSheetData).toHaveBeenCalledWith(U, 'sid', 'A1:B5', undefined);
    await executeIntegrationTool(U, 'sheets_get_data', { spreadsheetId: 'sid' });
    expect(google.getSheetData).toHaveBeenCalledWith(U, 'sid', undefined, undefined);
    // label threads through when provided (multi-account read fix, 2026-08-11)
    await executeIntegrationTool(U, 'sheets_get_data', { spreadsheetId: 'sid', label: 'Personal' });
    expect(google.getSheetData).toHaveBeenCalledWith(U, 'sid', undefined, 'Personal');
  });

  it('slack_get_channel_history maps channel + optional limit', async () => {
    asMock(slack.getChannelHistory).mockResolvedValue('[history]');
    await executeIntegrationTool(U, 'slack_get_channel_history', { channel: '#eng', limit: 5 });
    expect(slack.getChannelHistory).toHaveBeenCalledWith(U, '#eng', 5);
    await executeIntegrationTool(U, 'slack_get_channel_history', { channel: '#eng' });
    expect(slack.getChannelHistory).toHaveBeenCalledWith(U, '#eng', undefined);
  });

  it('x reads forward the userId (OAuth attach) and x_get_trends omits an absent woeid (f609ec35)', async () => {
    asMock(x.search).mockResolvedValue('[tweets]');
    await expect(executeIntegrationTool(U, 'x_search', { query: 'openai' })).resolves.toBe('[tweets]');
    expect(x.search).toHaveBeenCalledWith('openai', U);

    asMock(x.getTrends).mockResolvedValue('[trends]');
    await executeIntegrationTool(U, 'x_get_trends', {});
    expect(x.getTrends).toHaveBeenCalledWith(undefined, U);
    await executeIntegrationTool(U, 'x_get_trends', { woeid: '23424977' });
    expect(x.getTrends).toHaveBeenCalledWith('23424977', U);
  });

  it('x read service failure is honest — never "integration may not be connected" (f609ec35)', async () => {
    // A null from the x-mcp wrapper means the SERVICE call failed (network/
    // gateway) — reads scrape public data and never depended on the user's
    // connection, so the legacy notFound('X') message was a misattribution.
    asMock(x.search).mockResolvedValue(null);
    const out = await executeIntegrationTool(U, 'x_search', { query: 'langgraph release' });
    expect(out).toContain('X read unavailable');
    expect(out).toContain('unrelated to whether the user');
    expect(out).not.toContain('may not be connected');

    asMock(x.getUserProfile).mockResolvedValue(null);
    const out2 = await executeIntegrationTool(U, 'x_get_user_profile', { username: 'LangChainAI' });
    expect(out2).toContain('X read unavailable');
    expect(out2).not.toContain('may not be connected');
  });

  it('xero_get_invoices maps the status filter (and the account label, ticket 64a25e8d)', async () => {
    asMock(xero.getInvoices).mockResolvedValue('[invoices]');
    await executeIntegrationTool(U, 'xero_get_invoices', { status: 'PAID' });
    expect(xero.getInvoices).toHaveBeenCalledWith(U, 'PAID', undefined, undefined);
    await executeIntegrationTool(U, 'xero_get_invoices', {});
    expect(xero.getInvoices).toHaveBeenCalledWith(U, undefined, undefined, undefined);
    await executeIntegrationTool(U, 'xero_get_invoices', { label: 'Work' });
    expect(xero.getInvoices).toHaveBeenCalledWith(U, undefined, undefined, 'Work');
  });

  it('plaid_get_transactions maps the days lookback', async () => {
    asMock(plaid.getTransactions).mockResolvedValue('[tx]');
    await executeIntegrationTool(U, 'plaid_get_transactions', { days: 7 });
    expect(plaid.getTransactions).toHaveBeenCalledWith(U, 7, undefined, undefined);
    await executeIntegrationTool(U, 'plaid_get_transactions', {});
    expect(plaid.getTransactions).toHaveBeenCalledWith(U, undefined, undefined, undefined);
  });

  // 7ac4b499: pagination passes through with != null so limit:0 (count-only)
  // survives — a truthiness check would silently drop the caller's page shape.
  it('plaid_get_transactions passes offset/limit through (limit:0 included)', async () => {
    asMock(plaid.getTransactions).mockResolvedValue('[tx]');
    await executeIntegrationTool(U, 'plaid_get_transactions', { days: 30, offset: 50, limit: 50 });
    expect(plaid.getTransactions).toHaveBeenCalledWith(U, 30, 50, 50);
    await executeIntegrationTool(U, 'plaid_get_transactions', { days: 30, limit: 0 });
    expect(plaid.getTransactions).toHaveBeenCalledWith(U, 30, 0, undefined);
  });

  it("wrapper resolving '' (with a healthy connection) degrades to a specific no-match message", async () => {
    asMock(google.getGmailMessage).mockResolvedValue('');
    await expect(executeIntegrationTool(U, 'gmail_get_message', { messageId: 'm1' }))
      .resolves.toMatch(/^No Gmail message with that ID/);
  });

  it('a wrapper\'s surfaced failure line (2026-10-04) reaches the model verbatim — never the "may not be connected … or nothing matched" conflation', async () => {
    const line = 'Slack search messages call was rejected by Slack (An API error occurred: invalid_auth) — the Slack connection needs re-authorizing: Account → Integrations → Slack → reconnect.';
    asMock(slack.searchMessages).mockResolvedValue(line);
    await expect(executeIntegrationTool(U, 'slack_search', { query: 'launch' })).resolves.toBe(line);
    asMock(plaid.getBalances).mockResolvedValue('');
    await expect(executeIntegrationTool(U, 'plaid_get_balances', {})).resolves.toMatch(/^No result from Plaid/); // '' keeps today's text
  });

  // The precheck differentiates the failure classes the old single notFound
  // string conflated: not-connected / refresh-failed / label-not-found each
  // surface their own resolution message (label-not-found lists valid labels).
  it('Google account-resolution failures surface the resolution message directly', async () => {
    const msg = 'No connected Google account matches "Wrk". Connected accounts: Work (paul@work.com).';
    asMock((google as any).resolveGoogleAccount).mockResolvedValue({ ok: false, reason: 'label_not_found', message: msg });
    await expect(executeIntegrationTool(U, 'gmail_get_message', { messageId: 'm1', label: 'Wrk' })).resolves.toBe(msg);
    expect(google.getGmailMessage).not.toHaveBeenCalled();

    const notConnected = 'Google is not connected — connect an account in Settings → Integrations.';
    asMock((google as any).resolveGoogleAccount).mockResolvedValue({ ok: false, reason: 'not_connected', message: notConnected });
    await expect(executeIntegrationTool(U, 'gmail_search', { query: 'invoice' })).resolves.toBe(notConnected);
    expect(google.getGmailMessages).not.toHaveBeenCalled();
  });

  it('the precheck receives the raw label arg (resolution owns the fuzzy matching)', async () => {
    asMock(google.getDocContent).mockResolvedValue('[doc]');
    await executeIntegrationTool(U, 'drive_get_doc', { documentId: 'd1', label: 'Work (paul@work.com)' });
    expect((google as any).resolveGoogleAccount).toHaveBeenCalledWith(U, 'Work (paul@work.com)');
    expect(google.getDocContent).toHaveBeenCalledWith(U, 'd1', 'Work (paul@work.com)');
  });

  it('wrapper rejecting → "<name> failed: <msg>" and the call does NOT throw', async () => {
    asMock(google.getGmailMessage).mockRejectedValue(new Error('boom'));
    await expect(executeIntegrationTool(U, 'gmail_get_message', { messageId: 'm1' }))
      .resolves.toBe('gmail_get_message failed: boom');
  });

  it('every tool still resolves a string when its wrapper rejects (sweep)', async () => {
    for (const f of [google.getGmailMessages, google.getGmailMessage, google.getGmailAttachment,
      google.getCalendarEvents, google.listDriveFiles, google.getDocContent, google.getSheetData,
      slack.searchMessages, slack.listChannels, slack.getChannelHistory,
      x.search, x.getUserProfile, x.getTrends,
      xero.getOrganisation, xero.getContacts, xero.getInvoices,
      plaid.getAccounts, plaid.getBalances, plaid.getTransactions]) {
      asMock(f).mockRejectedValue(new Error('down'));
    }
    asMock(selectAgent).mockResolvedValue({ agent: null, note: 'no paired Mac', error: 'none online' });
    for (const name of INTEGRATION_TOOL_NAMES) {
      await expect(executeIntegrationTool(U, name, {})).resolves.toEqual(expect.any(String));
    }
  });
});

describe('iMessage tools (Mac bridge dispatch)', () => {
  const agent = (over: any = {}) => ({
    id: 'agent-1', userId: U, label: 'MacBook Pro', deviceId: 'dev-1', deviceName: 'book.local',
    agentVersion: '0.5.0', isDefault: true, lastSeenAt: new Date(), pairedAt: new Date(), ...over,
  });
  const selection = (a: any, note = 'the paired Mac') => ({ agent: a, note, error: null });

  it('no paired agent → the not-available message, no dispatch', async () => {
    asMock(selectAgent).mockResolvedValue({ agent: null, note: 'no paired Mac', error: 'No Mac is connected. Pair your Mac first.' });
    await expect(executeIntegrationTool(U, 'imessage_list_chats', {})).resolves.toContain("iMessage isn't available");
    expect(agentBroker.dispatch).not.toHaveBeenCalled();
  });

  it('all paired Macs OFFLINE → the not-available message', async () => {
    asMock(selectAgent).mockResolvedValue({ agent: null, note: 'all paired Macs offline', error: 'Your Mac agent is offline.' });
    await expect(executeIntegrationTool(U, 'imessage_get_messages', { chat: '+15551234567' })).resolves.toContain("iMessage isn't available");
    expect(agentBroker.dispatch).not.toHaveBeenCalled();
  });

  it('online agent → dispatches list_chats, JSON-stringifies, and reports the device', async () => {
    asMock(selectAgent).mockResolvedValue(selection(agent()));
    asMock(agentBroker.dispatch).mockResolvedValue([{ name: 'Alice' }, { name: 'Bob' }]);
    const out = await executeIntegrationTool(U, 'imessage_list_chats', {});
    expect(out).toBe('[device: MacBook Pro] [{"name":"Alice"},{"name":"Bob"}]');
    expect(agentBroker.dispatch).toHaveBeenCalledWith('agent-1', 'list_chats', { limit: undefined }, 30_000);
  });

  it('online agent → dispatches get_messages with chat + limit', async () => {
    asMock(selectAgent).mockResolvedValue(selection(agent()));
    asMock(agentBroker.dispatch).mockResolvedValue('hello');
    await expect(executeIntegrationTool(U, 'imessage_get_messages', { chat: 'Alice', limit: 20 })).resolves.toBe('[device: MacBook Pro] hello');
    expect(agentBroker.dispatch).toHaveBeenCalledWith('agent-1', 'get_messages', { chat: 'Alice', limit: 20 }, 30_000);
  });

  it('device param → the targeted Mac is selected (multi-Mac)', async () => {
    asMock(selectAgent).mockResolvedValue(selection(agent({ id: 'agent-2', label: 'Mac mini', isDefault: false }), "device 'Mac mini' (targeted)"));
    asMock(agentBroker.dispatch).mockResolvedValue('ok');
    await executeIntegrationTool(U, 'imessage_list_chats', { device: 'Mac mini' });
    expect(selectAgent).toHaveBeenCalledWith(U, 'Mac mini');
  });

  it('unknown device label → clean error naming the paired Macs', async () => {
    asMock(selectAgent).mockResolvedValue({ agent: null, note: "unknown device 'iMac'", error: "No paired Mac matches 'iMac'. Paired Macs: 'MacBook Pro'." });
    const out = await executeIntegrationTool(U, 'imessage_list_chats', { device: 'iMac' });
    expect(out).toContain("No paired Mac matches 'iMac'");
    expect(out).toContain("'MacBook Pro'");
    expect(agentBroker.dispatch).not.toHaveBeenCalled();
  });

  it('dispatch rejecting → "iMessage request failed: …" (never throws)', async () => {
    asMock(selectAgent).mockResolvedValue(selection(agent()));
    asMock(agentBroker.dispatch).mockRejectedValue(new Error('agent timed out'));
    await expect(executeIntegrationTool(U, 'imessage_list_chats', {}))
      .resolves.toBe('iMessage request failed: agent timed out');
  });
});

describe('chat orchestrator whitelist parity (tripwire)', () => {
  it('every INTEGRATION_TOOL_NAMES entry is in the REAL agent CHAT_ORCH_TOOLS set', () => {
    for (const name of INTEGRATION_TOOL_NAMES) {
      expect(CHAT_ORCH_TOOLS.has(name)).toBe(true);
    }
  });

  it('the whitelist keeps its non-integration tools', () => {
    for (const name of ['search_engine', 'scrape_as_markdown', 'browser_task', 'web_pipe', 'search_memory', 'search_code_semantic']) {
      expect(CHAT_ORCH_TOOLS.has(name)).toBe(true);
    }
  });
});

// 1ea9a120 v0.7.3 (owner directive 2026-10-07): a Mac with zero calendars is
// NOT signed in to the Apple account — the dispatch case must surface
// actionable sign-in copy instead of the raw {events:null} shape the model
// could read as "no upcoming events".
describe('mac_calendar_list_events v0.7.3 sign-in guard', () => {
  it('surfaces sign-in copy for a no-calendar-account result (never a silent empty success)', async () => {
    // An ONLINE macos agent at 0.7.3 that advertises 'calendar' — passes the
    // serve-time gate so the dispatch (and the sign-in guard under test) runs.
    const signedOutMac = {
      id: 'agent-9', userId: U, label: 'mac-b', deviceId: 'dev-9', deviceName: 'mac-b.local',
      agentVersion: '0.7.3', capabilities: ['imessage', 'calendar'], platform: 'macos',
      isDefault: false, lastSeenAt: new Date(), pairedAt: new Date(),
    };
    asMock(listAgents).mockResolvedValue([signedOutMac]);
    asMock(agentBroker.dispatch).mockResolvedValue({
      events: null,
      unavailable: { reason: 'no-calendar-account', pane: 'calendar' },
    });
    const out = await executeIntegrationTool(U, 'mac_calendar_list_events', { device: 'mac-b' });
    expect(agentBroker.dispatch).toHaveBeenCalledWith('agent-9', 'calendar_list_events', expect.anything(), 30000);
    expect(out).toMatch(/not signed in to an Apple account/);
    expect(out).toMatch(/mac-b/);
    // Never the raw unavailable JSON masquerading as an empty success.
    expect(out).not.toMatch(/"events":null/);
  });
});

// daf8706a (agent 0.9.11): the incident Mac reported calendar-denied before
// AND after the owner granted the Digby app — the EventKit request runs in
// the agent binary (a DIFFERENT TCC client) that had never asked, so no
// Calendars row existed for it and the user's grant could not reach it. The
// backend must (a) surface tier 0 as its own never-requested copy that
// names the client binary and the new consent dialog, (b) name the agent
// binary in the plain denial copy, and (c) still pass the client through
// for older reasons it does not branch on.
describe('mac_calendar_list_events daf8706a tier-0 + client surfacing', () => {
  const tier0Mac = {
    id: 'agent-9', userId: U, label: 'mac-b', deviceId: 'dev-9', deviceName: 'mac-b.local',
    agentVersion: '0.9.11', capabilities: ['imessage', 'calendar'], platform: 'macos',
    isDefault: false, lastSeenAt: new Date(), pairedAt: new Date(),
  };
  it('surfaces never-requested copy (client named, dialog announced) for a tier-0 agent', async () => {
    asMock(listAgents).mockResolvedValue([tier0Mac]);
    asMock(agentBroker.dispatch).mockResolvedValue({
      events: null,
      unavailable: {
        reason: 'calendar-never-requested',
        pane: 'calendar',
        client: '/Library/Application Support/Digby/DigbyAgent',
      },
    });
    const out = await executeIntegrationTool(U, 'mac_calendar_list_events', { device: 'mac-b' });
    expect(out).toMatch(/never been granted Calendar access/);
    // 2026-11-06 repair: the copy must NEVER claim a dialog was triggered —
    // the request is asynchronous and its outcome was previously discarded,
    // so nothing verified that sentence (owner chased dialogs that never
    // appeared on three Macs).
    expect(out).not.toMatch(/dialog was just triggered/);
    expect(out).toMatch(/No consent attempt has been recorded on that Mac yet/);
    // The client binary must be visible in ONE line (ask 1).
    expect(out).toMatch(/\/Library\/Application Support\/Digby\/DigbyAgent/);
    expect(out).toMatch(/DIFFERENT client/);
    expect(out).not.toMatch(/"events":null/);
  });
  it('names the agent binary in the denial copy when the client is present', async () => {
    asMock(listAgents).mockResolvedValue([tier0Mac]);
    asMock(agentBroker.dispatch).mockResolvedValue({
      events: null,
      unavailable: { reason: 'calendar-denied', pane: 'calendar', client: '/usr/local/bin/digby-agent' },
    });
    const out = await executeIntegrationTool(U, 'mac_calendar_list_events', { device: 'mac-b' });
    expect(out).toMatch(/switched OFF for the Digby agent/);
    // The client binary is the TCC client the user must enable; a bare
    // "Digby" app row is a different client.
    expect(out).toMatch(/\/usr\/local\/bin\/digby-agent/);
    expect(out).not.toMatch(/"events":null/);
  });
  it('omits the client gracefully when an older agent (≤0.9.10) sends the legacy shape', async () => {
    asMock(listAgents).mockResolvedValue([tier0Mac]);
    asMock(agentBroker.dispatch).mockResolvedValue({
      events: null,
      unavailable: { reason: 'calendar-denied', pane: 'calendar' },
    });
    const out = await executeIntegrationTool(U, 'mac_calendar_list_events', { device: 'mac-b' });
    expect(out).toMatch(/switched OFF for the Digby agent/);
    expect(out).not.toMatch(/undefined/);
    expect(out).not.toMatch(/"events":null/);
  });
});
