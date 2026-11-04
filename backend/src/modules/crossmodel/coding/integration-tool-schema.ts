/**
 * Integration tool schemas + names — DEPENDENCY-FREE module.
 *
 * Split out of coding-integrations.ts so policy modules (roles.ts) and tests can
 * import the tool names without dragging in the env-dependent MCP wrapper chain
 * (github-mcp → token-manager → config/env throws without DATABASE_URL/REDIS_URL
 * in jest). The executor stays in coding-integrations.ts.
 */

/**
 * github_get_file_contents (fs-code-knowledge, 2026-10-22): github_search_code's
 * description has always said "use github_get_file_contents for a known path",
 * but no such tool was exposed — the pointer dangled, and a supervisor with no
 * worktree had no way to read a file on main before telling the owner a feature
 * did not exist. The read-only executor (github-mcp getFileContents → the
 * MCP server's octokit repos.getContent) already existed.
 * GITHUB_FILE_READ_TOOL_DISABLED=1 removes the tool AND the pointer to it.
 */
export function githubFileReadToolDisabled(): boolean { return process.env.GITHUB_FILE_READ_TOOL_DISABLED === '1'; }

/**
 * GitHub answers 404 both for a path that is missing AND for a repo / branch the
 * token cannot see (review 2026-10-22). github-mcp renders it as the text
 * "Error getting file <p>: Not Found - https://docs.github.com/…". Anchored on
 * the WHOLE answer (an optional "[GitHub File: …]" header line first) — a real
 * file's body never starts with it, so reading a file that merely quotes the
 * phrase is never mistaken for a miss.
 */
const GITHUB_FILE_NOT_FOUND_RE = /^\s*(?:\[GitHub File: [^\n]*\]\n)?\s*Error getting file\b[^\n]*\bNot Found\b/i;
export function isGitHubFileNotFoundText(text: string | null | undefined): boolean {
  return typeof text === 'string' && GITHUB_FILE_NOT_FOUND_RE.test(text);
}

/**
 * The line a github_get_file_contents 404 carries: the tool is THE existence
 * check, so a 404 must say it is not proof of absence and name the cheap
 * follow-up (list the parent directory — a readable listing proves the repo is
 * visible, so the miss is then about the path). null when the answer is no 404.
 */
export function githubFileNotFoundNote(answer: string, filePath: string): string | null {
  if (!isGitHubFileNotFoundText(answer)) return null;
  const p = String(filePath ?? '').replace(/\/+$/, '');
  const parent = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
  return `[NOT PROOF OF ABSENCE] GitHub answers 404 both for a missing path and for a repo or branch the connected account(s) cannot see — NOT proof the code does not exist; list the parent directory (path "${parent}"${parent ? '' : ' — the repo root'}) to confirm the repo is readable, or search by content.`;
}

const GITHUB_FILE_READ_TOOL_SCHEMA = {
  type: 'function' as const,
  function: {
    name: 'github_get_file_contents', description: 'Read ONE file (or list a directory) from a GitHub repo the user\'s connected accounts can see — read-only. owner + repo + path; ref = branch / tag / sha (omit for the repo\'s default branch). The direct existence check: read the file on main before saying any code or feature does not exist — a code-search miss is never proof of absence, and neither is a 404 alone (GitHub answers 404 for a repo the account cannot see too; list the parent directory to tell them apart).',
    parameters: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, path: { type: 'string', description: 'Repo-relative path ("" or "/" lists the root).' }, ref: { type: 'string', description: 'Branch, tag or commit sha. Omit for the default branch.' } }, required: ['owner', 'repo', 'path'] },
  },
};

export const INTEGRATION_TOOL_SCHEMA = [
  {
    type: 'function' as const,
    function: {
      name: 'github_search_code', description: 'Search code across the user\'s connected GitHub accounts. Plain queries are auto-scoped to the connected accounts\' repos (user + orgs, incl. forks); add explicit repo:/org:/user: qualifiers to target specific repos. GitHub\'s code-search index covers each repo\'s default branch only and does not include every private repo — a 0-result response can mean "not indexed"' + (githubFileReadToolDisabled() ? '.' : '; use github_get_file_contents for a known path.'),
      parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    },
  },
  ...(githubFileReadToolDisabled() ? [] : [GITHUB_FILE_READ_TOOL_SCHEMA]),
  {
    type: 'function' as const,
    function: {
      name: 'github_list_issues', description: 'List issues in a GitHub repo (owner/repo).',
      parameters: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, state: { type: 'string', enum: ['open', 'closed', 'all'] } }, required: ['owner', 'repo'] },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'github_get_issue', description: 'Read one GitHub issue (owner/repo + number).',
      parameters: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, number: { type: 'number' } }, required: ['owner', 'repo', 'number'] },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'github_list_prs', description: 'List pull requests in a GitHub repo (owner/repo).',
      parameters: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, state: { type: 'string', enum: ['open', 'closed', 'all'] } }, required: ['owner', 'repo'] },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'gmail_search', description: 'Search the user\'s Gmail (e.g. a thread describing the task).',
      parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'drive_search', description: 'Search the user\'s Google Drive for docs/specs. Searches every connected account (results labeled "--- Label (email) ---") unless a label narrows it to one.',
      parameters: { type: 'object', properties: { query: { type: 'string' }, label: { type: 'string', description: 'Connected Google account to search — the bare label, the email, or the "Label (email)" shown in section headers (case-insensitive). Omit to search all accounts.' } }, required: ['query'] },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'slack_search', description: 'Search the user\'s Slack messages for context (a thread/spec).',
      parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'asana_search', description: 'Search the user\'s Asana tasks (the ticket for this work).',
      parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'gmail_get_message', description: 'Read one Gmail message by ID (IDs come from gmail_search).',
      parameters: { type: 'object', properties: { messageId: { type: 'string' }, label: { type: 'string', description: 'Connected Google account to read from — the bare label, the email, or the "Label (email)" shown in gmail_search section headers (case-insensitive). Omit to try every connected account (message IDs are account-specific).' } }, required: ['messageId'] },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'gmail_get_attachment', description: 'Download a Gmail attachment. Prefer filename (the stable handle — attachmentIds rotate on every fetch and expire within ~2 minutes, so an attachmentId listed earlier usually fails). Text files return inline text; PDF/DOCX return extracted text; image attachments (HEIC/JPG/PNG…) return a vision-model description of what they show; other binaries return base64 JSON.',
      parameters: { type: 'object', properties: { messageId: { type: 'string' }, filename: { type: 'string', description: 'Attachment filename exactly as listed by gmail_search / gmail_get_message — the preferred, stable handle.' }, attachmentId: { type: 'string', description: 'Only works immediately (within ~2 minutes) after the fetch that listed it.' }, label: { type: 'string', description: 'Connected Google account to read from — the bare label, the email, or the "Label (email)" from section headers (case-insensitive). Omit to try every connected account.' } }, required: ['messageId'] },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'calendar_list_events', description: 'List upcoming Google Calendar events (default: next 7 days).',
      parameters: { type: 'object', properties: { daysAhead: { type: 'number' }, maxResults: { type: 'number' } } },
    },
  },
  {
    type: 'function' as const,
    function: {
      // Mac-agent calendar read (ticket 1ea9a120) — DISTINCT from the Google
      // connector above on purpose: the agent dispatch command it carries is
      // 'calendar_list_events' (the macos-app 0.7.0 command name), but the
      // LLM-facing name must not collide with the Google tool.
      name: 'mac_calendar_list_events', description: 'List upcoming macOS Calendar.app events (default: next 7 days) from the user\'s paired Mac — Apple Calendar / EventKit, NOT Google Calendar. Optional device picks which paired Mac when several are paired.',
      parameters: { type: 'object', properties: { daysAhead: { type: 'number', description: 'Days lookback from today (default 7).' }, device: { type: 'string', description: 'Which paired Mac to read from (its label, e.g. "MacBook Pro"), when several Macs are paired. Omit to use the default Mac.' } } },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'drive_get_doc', description: 'Read the text content of a Google Doc (IDs come from drive_search).',
      parameters: { type: 'object', properties: { documentId: { type: 'string' }, label: { type: 'string', description: 'Connected Google account to read from — the bare label, the email, or the "Label (email)" from section headers (case-insensitive). Omit to try every connected account.' } }, required: ['documentId'] },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'sheets_get_data', description: 'Read data from a Google Sheet (optional A1 range).',
      parameters: { type: 'object', properties: { spreadsheetId: { type: 'string' }, range: { type: 'string' }, label: { type: 'string', description: 'Connected Google account to read from — the bare label, the email, or the "Label (email)" from section headers (case-insensitive). Omit to try every connected account.' } }, required: ['spreadsheetId'] },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'slack_list_channels', description: 'List the user\'s Slack channels AND DMs/group-DMs (IDs come from here).',
      parameters: { type: 'object', properties: { types: { type: 'string', description: 'Comma-separated Slack conversation types to list. Default: public_channel,private_channel,im,mpim (everything). Use e.g. "im,mpim" for DMs only.' } } },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'slack_get_channel_history', description: 'Read recent messages from a Slack channel (name or ID).',
      parameters: { type: 'object', properties: { channel: { type: 'string' }, limit: { type: 'number' } }, required: ['channel'] },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'discord_list_guilds', description: 'List Discord servers (guilds) the bot is a member of — start here, then discord_list_channels.',
      parameters: { type: 'object', properties: { limit: { type: 'number', description: 'Max guilds to return (default 50, max 200).' } } },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'discord_list_channels', description: 'List channels in a Discord server with types and topics (guildId from discord_list_guilds).',
      parameters: { type: 'object', properties: { guildId: { type: 'string', description: 'Guild (server) ID.' } }, required: ['guildId'] },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'discord_channel_history', description: 'Read recent messages in a Discord channel (newest first); `before` (a snowflake message ID) paginates older.',
      parameters: { type: 'object', properties: { channelId: { type: 'string', description: 'Channel ID from discord_list_channels.' }, limit: { type: 'number', description: 'Max messages (default 20, max 100).' }, before: { type: 'string', description: 'Snowflake message ID: return messages older than it.' } }, required: ['channelId'] },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'discord_list_dms', description: 'List DM channels open with the Discord bot (a user must DM the bot first to open one).',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'discord_scrape_channel', description: 'Scrape up to 2000 messages of full Discord channel history (paginated, rate-limit aware) — for bulk context gathering.',
      parameters: { type: 'object', properties: { channelId: { type: 'string' }, maxMessages: { type: 'number', description: 'Max messages to collect (default 500, hard cap 2000).' }, before: { type: 'string', description: 'Snowflake message ID: only collect messages older than it.' } }, required: ['channelId'] },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'asana_list_tasks', description: 'List the user\'s assigned Asana tasks.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'asana_list_projects', description: 'List the user\'s Asana projects.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'x_search', description: 'Search X (Twitter) posts.',
      parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'x_get_user_profile', description: 'Read an X (Twitter) user profile.',
      parameters: { type: 'object', properties: { username: { type: 'string' } }, required: ['username'] },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'x_get_trends', description: 'Get trending topics on X (Twitter).',
      parameters: { type: 'object', properties: { woeid: { type: 'string' } } },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'xero_get_organisation', description: 'Get the user\'s Xero organisation info.',
      parameters: { type: 'object', properties: { label: { type: 'string', description: 'Connected Xero account to use — the bare label, the org name, or the "Label (Org name)" shown in account lists. Omit to use the first-connected (default) account.' } } },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'xero_get_contacts', description: 'List Xero contacts (customers/suppliers).',
      parameters: { type: 'object', properties: { search: { type: 'string' }, label: { type: 'string', description: 'Connected Xero account to read from — the bare label, the org name, or the "Label (Org name)" shown in account lists. Omit to use the first-connected (default) account.' } } },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'xero_get_invoices', description: 'List Xero sales invoices (optional status filter, e.g. DRAFT / AUTHORISED / PAID).',
      parameters: { type: 'object', properties: { status: { type: 'string' }, label: { type: 'string', description: 'Connected Xero account to read from — the bare label, the org name, or the "Label (Org name)" shown in account lists. Omit to use the first-connected (default) account.' } } },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'plaid_get_accounts', description: 'List the user\'s linked bank accounts.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'plaid_get_balances', description: 'Get balances for the user\'s linked bank accounts.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'plaid_get_transactions', description: 'Get bank transactions for the user\'s linked accounts. Optional `days` lookback (default 30). Paginate with `offset` (items to skip, default 0) and `limit` (page size, default 50, max 500) — each institution\'s header reports its own window `total` plus the `offset`/`limit` used, so request successive pages until you have collected each institution\'s `total`. A count-only summary is available with `limit: 0`.',
      parameters: { type: 'object', properties: { days: { type: 'number', description: 'Days lookback, default 30.' }, offset: { type: 'number', description: 'Items to skip before the returned page (default 0). Use with limit to page through history beyond the newest items.' }, limit: { type: 'number', description: 'Page size: default 50, max 500. Use 0 for a count-only summary (total in window) with no transaction rows.' } } },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'imessage_list_chats', description: 'List recent iMessage/SMS chats (needs the paired Mac bridge online). Optional `device` names which paired Mac to use (label like "MacBook Pro") when several are paired.',
      parameters: { type: 'object', properties: { limit: { type: 'number' }, device: { type: 'string', description: 'Which paired Mac to read from (its label), when several Macs are paired. Omit to use the default Mac.' } } },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'imessage_get_messages', description: 'Read messages from an iMessage/SMS chat (needs the paired Mac bridge online). Optional `device` names which paired Mac to use when several are paired.',
      parameters: { type: 'object', properties: { chat: { type: 'string' }, limit: { type: 'number' }, device: { type: 'string', description: 'Which paired Mac to read from (its label), when several Macs are paired. Omit to use the default Mac.' } }, required: ['chat'] },
    },
  },
];

// ── Google WRITE tools (2026-09-23, owner: "add all of that") ─────────────────
// Every write takes an optional `label` (which connected Google account); with
// several accounts and no label the executor refuses and lists them. Results
// come back as a JSON envelope {ok, tool, ids, message} so the action verifier
// and receipts can vouch for "I created the sheet" claims. Machine-triggered
// runs may NOT send email (human-turn anchor, see coding-integrations.ts).
// GOOGLE_WRITE_TOOLS_DISABLED=1 removes them from every schema.
const LABEL = { label: { type: 'string', description: 'Which connected Google account (bare label or email). Required when more than one is connected.' } };
const ROWS = { type: 'array', items: { type: 'array', items: { type: ['string', 'number', 'boolean', 'null'] } }, description: 'Rows of cells (first row may be a header).' };
export function googleWriteToolsDisabled(): boolean { return process.env.GOOGLE_WRITE_TOOLS_DISABLED === '1'; }
export const GOOGLE_WRITE_TOOL_SCHEMA = [
  { type: 'function' as const, function: { name: 'gmail_send_email', description: 'Send an email from the user\'s connected Gmail account. Only on a human-attended turn — the user asked for this send in THIS conversation. Confirm recipient + intent in your reply.', parameters: { type: 'object', properties: { to: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string', description: 'Plain-text body' }, cc: { type: 'string' }, bcc: { type: 'string' }, ...LABEL }, required: ['to', 'subject', 'body'] } } },
  { type: 'function' as const, function: { name: 'gmail_create_draft', description: 'Create a Gmail DRAFT (not sent) the user can review in Gmail.', parameters: { type: 'object', properties: { to: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' }, ...LABEL }, required: ['to', 'subject', 'body'] } } },
  { type: 'function' as const, function: { name: 'calendar_create_event', description: 'Create a Google Calendar event (ISO 8601 datetimes, or YYYY-MM-DD for all-day).', parameters: { type: 'object', properties: { summary: { type: 'string' }, start: { type: 'string' }, end: { type: 'string' }, description: { type: 'string' }, location: { type: 'string' }, attendees: { type: 'array', items: { type: 'string' } }, ...LABEL }, required: ['summary', 'start', 'end'] } } },
  { type: 'function' as const, function: { name: 'docs_create_document', description: 'Create a new Google Doc with a title and optional plain-text body; returns documentId + link.', parameters: { type: 'object', properties: { title: { type: 'string' }, bodyText: { type: 'string' }, ...LABEL }, required: ['title'] } } },
  { type: 'function' as const, function: { name: 'docs_append_text', description: 'Append plain text to the end of an existing Google Doc (documentId from drive_search / docs_create_document).', parameters: { type: 'object', properties: { documentId: { type: 'string' }, text: { type: 'string' }, ...LABEL }, required: ['documentId', 'text'] } } },
  { type: 'function' as const, function: { name: 'sheets_create_spreadsheet', description: 'Create a new Google Sheet with optional initial rows written from A1; returns spreadsheetId + link.', parameters: { type: 'object', properties: { title: { type: 'string' }, rows: ROWS, sheetTitle: { type: 'string' }, ...LABEL }, required: ['title'] } } },
  { type: 'function' as const, function: { name: 'sheets_write_values', description: 'Overwrite an A1 range of an existing Google Sheet with rows (e.g. range "Sheet1!A1:C10").', parameters: { type: 'object', properties: { spreadsheetId: { type: 'string' }, range: { type: 'string' }, rows: ROWS, ...LABEL }, required: ['spreadsheetId', 'range', 'rows'] } } },
  { type: 'function' as const, function: { name: 'sheets_append_rows', description: 'Append rows after the last data row of a sheet (range = sheet name, e.g. "Sheet1").', parameters: { type: 'object', properties: { spreadsheetId: { type: 'string' }, range: { type: 'string' }, rows: ROWS, ...LABEL }, required: ['spreadsheetId', 'rows'] } } },
  { type: 'function' as const, function: { name: 'drive_upload_file', description: 'Upload text content to Google Drive as a file (optionally into a folder; convertTo doc|sheet|slides makes a native Google file).', parameters: { type: 'object', properties: { name: { type: 'string' }, content: { type: 'string' }, mimeType: { type: 'string', description: 'text/plain (default), text/markdown, text/csv, text/html…' }, folderId: { type: 'string' }, convertTo: { type: 'string', enum: ['doc', 'sheet', 'slides'] }, ...LABEL }, required: ['name', 'content'] } } },
  { type: 'function' as const, function: { name: 'drive_create_folder', description: 'Create a Google Drive folder (optionally inside a parent folder).', parameters: { type: 'object', properties: { name: { type: 'string' }, parentId: { type: 'string' }, ...LABEL }, required: ['name'] } } },
  { type: 'function' as const, function: { name: 'slides_create_presentation', description: 'Create a Google Slides deck from a title and slides (each: title, body and/or bullets).', parameters: { type: 'object', properties: { title: { type: 'string' }, slides: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, body: { type: 'string' }, bullets: { type: 'array', items: { type: 'string' } } } } }, ...LABEL }, required: ['title'] } } },
];
export const GOOGLE_WRITE_TOOL_NAMES = GOOGLE_WRITE_TOOL_SCHEMA.map(t => t.function.name);
if (!googleWriteToolsDisabled()) INTEGRATION_TOOL_SCHEMA.push(...(GOOGLE_WRITE_TOOL_SCHEMA as any));

// ── Connector WRITE tools (capability gap audit #26, 2026-09-24) ─────────────
// Outbound writes on the non-Google connectors. imessage_send / slack_post_message /
// x_post keep the gmail_send_email rule (human-attended turn required; NOT
// grantable to machine runs) — the audit's CONSEQUENTIAL / NEVER-AUTONOMOUS
// classes map onto the connector layer's ONE anchor, ctx.userTurnAt.
// asana_create_task / asana_update_task are reversible edits in the user's own
// workspace and run unattended. CONNECTOR_WRITE_TOOLS_DISABLED=1 removes them.
export function connectorWriteToolsDisabled(): boolean { return process.env.CONNECTOR_WRITE_TOOLS_DISABLED === '1'; }
export const CONNECTOR_WRITE_TOOL_SCHEMA = [
  { type: 'function' as const, function: { name: 'imessage_send', description: "Send an iMessage/SMS from the user's paired Mac to a phone number or email handle (`to`) — the same send the UI's confirm card performs. Only on a human-attended turn where the user asked for THIS send in THIS conversation; never from a scheduled/automatic run. Capped per user per day. Resolve a contact name to a handle first with imessage_list_chats. Optional `device` picks the Mac when several are paired.", parameters: { type: 'object', properties: { to: { type: 'string', description: 'Phone number or email handle (not a display name).' }, text: { type: 'string' }, device: { type: 'string' } }, required: ['to', 'text'] } } },
  { type: 'function' as const, function: { name: 'slack_post_message', description: "Post a message to a Slack channel or DM AS THE USER (channel id or #name; optional thread_ts to reply in a thread). Only on a human-attended turn where the user asked for the post; never from a scheduled/automatic run. A missing chat:write permission means the user reconnects Slack in Account → Integrations — say so, never retry.", parameters: { type: 'object', properties: { channel: { type: 'string' }, text: { type: 'string' }, thread_ts: { type: 'string' } }, required: ['channel', 'text'] } } },
  { type: 'function' as const, function: { name: 'asana_create_task', description: "Create an Asana task in the user's workspace (optionally in a project gid from asana_list_projects; dueOn YYYY-MM-DD; assignee gid or 'me'). Reversible edit in the user's own workspace — allowed unattended. Returns taskId + link.", parameters: { type: 'object', properties: { name: { type: 'string' }, notes: { type: 'string' }, project: { type: 'string' }, workspace: { type: 'string' }, dueOn: { type: 'string' }, assignee: { type: 'string' } }, required: ['name'] } } },
  { type: 'function' as const, function: { name: 'asana_update_task', description: "Update an Asana task (taskId gid from asana_search / asana_list_tasks): name, notes, completed, dueOn (YYYY-MM-DD or null to clear). Reversible; allowed unattended.", parameters: { type: 'object', properties: { taskId: { type: 'string' }, name: { type: 'string' }, notes: { type: 'string' }, completed: { type: 'boolean' }, dueOn: { type: ['string', 'null'] } }, required: ['taskId'] } } },
  { type: 'function' as const, function: { name: 'x_post', description: "Post on X (Twitter) as the user — a new post, a reply (replyToTweetId) or a quote (quoteTweetId). PUBLIC posture: only on a human-attended turn where the user asked for THIS post with THIS text; never from a scheduled/automatic run; confirm the exact text in your reply. ≤ 280 chars unless the account is premium. Needs the user's connected X account (label picks one when several are connected).", parameters: { type: 'object', properties: { text: { type: 'string' }, replyToTweetId: { type: 'string' }, quoteTweetId: { type: 'string' }, label: { type: 'string' } }, required: ['text'] } } },
  { type: 'function' as const, function: { name: 'discord_send_message', description: "Send a message to a Discord channel as the Discord bot (NOT the user — one shared bot token). Only on a human-attended turn where the user asked for this send in this conversation; never from a scheduled/automatic run. The bot must have permission to post in the target channel; find channelId via discord_list_channels.", parameters: { type: 'object', properties: { channelId: { type: 'string', description: 'Channel ID from discord_list_channels.' }, text: { type: 'string' } }, required: ['channelId', 'text'] } } },
  { type: 'function' as const, function: { name: 'discord_send_dm', description: "Send a Discord DM to a user from the bot. A DM channel must already exist (the user must have DM'd the bot first) — resolve userId via discord_list_dms. Only on a human-attended turn where the user asked for this send; never from a scheduled/automatic run.", parameters: { type: 'object', properties: { userId: { type: 'string', description: 'User ID from discord_list_dms.' }, text: { type: 'string' } }, required: ['userId', 'text'] } } },
];
export const CONNECTOR_WRITE_TOOL_NAMES = CONNECTOR_WRITE_TOOL_SCHEMA.map(t => t.function.name);
/** The connector writes that need a human-attended turn (the gmail_send_email rule). */
export const HUMAN_TURN_CONNECTOR_WRITES: ReadonlySet<string> = new Set(['imessage_send', 'slack_post_message', 'x_post', 'discord_send_message', 'discord_send_dm']);
if (!connectorWriteToolsDisabled()) INTEGRATION_TOOL_SCHEMA.push(...(CONNECTOR_WRITE_TOOL_SCHEMA as any));
/** Every connector WRITE (Google + the #26 set) — worker roles never receive these (roles.ts). */
export const INTEGRATION_WRITE_TOOL_NAMES: ReadonlySet<string> = new Set([...GOOGLE_WRITE_TOOL_NAMES, ...CONNECTOR_WRITE_TOOL_NAMES]);

export const INTEGRATION_TOOL_NAMES = INTEGRATION_TOOL_SCHEMA.map(t => t.function.name);
const NAME_SET = new Set(INTEGRATION_TOOL_NAMES);
export function isIntegrationTool(name: string): boolean { return NAME_SET.has(name); }
