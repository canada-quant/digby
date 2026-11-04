/**
 * Google Workspace MCP Server
 *
 * Exposes Google APIs as MCP tools via Streamable HTTP transport.
 * Runs on port 8001 (internal). External requests go through auth-proxy on port 8000.
 *
 * Per-request architecture: a new McpServer instance is created for each POST to /mcp.
 * The user's Google access token is read from the X-Google-Token request header and
 * baked into each tool handler via closure — no session state needed.
 *
 * Tools exposed:
 *   gmail_list_messages, gmail_read_message, gmail_get_attachment, gmail_send_email, gmail_create_draft
 *   calendar_list_events, calendar_create_event
 *   drive_list_files, drive_get_file
 *   docs_read_document
 *   sheets_read_data
 */

import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

import { gmailListMessages, gmailReadMessage, gmailGetAttachment, gmailSendEmail, gmailCreateDraft } from './tools/gmail.js';
import { calendarListEvents, calendarCreateEvent } from './tools/calendar.js';
import { driveListFiles, driveGetFile, driveUploadFile, driveCreateFolder } from './tools/drive.js';
import { docsReadDocument, docsCreateDocument, docsAppendText } from './tools/docs.js';
import { sheetsReadData, sheetsCreateSpreadsheet, sheetsWriteValues, sheetsAppendRows } from './tools/sheets.js';
import { slidesCreatePresentation } from './tools/slides.js';

const PORT = parseInt(process.env.MCP_SERVER_PORT || '8001', 10);
const app  = express();
app.use(express.json({ limit: '10mb' }));

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/health', (_, res) => res.send('ok'));

// ── MCP handler — per-request server with token baked into tool closures ──────
app.post('/mcp', async (req, res) => {
  const googleToken = req.headers['x-google-token'] as string | undefined;

  if (!googleToken) {
    res.status(401).json({ error: 'X-Google-Token header required' });
    return;
  }

  const server = new McpServer({
    name:    'google-workspace',
    version: '1.0.0',
  });

  // ── Gmail tools ─────────────────────────────────────────────────────────────

  server.tool(
    'gmail_list_messages',
    'Search/list Gmail messages. Pages through results (up to maxResults, default 25, max 300) and reports ' +
    'the TOTAL match count even when only a page is shown. Lists each message\'s attachments (filename, size, ' +
    'attachmentId) when the result set is small (≤100). Use full Gmail search operators in `query` for precise, ' +
    'thorough sweeps — e.g. "from:(a@x.com OR b@y.com) OR to:(a@x.com OR b@y.com) after:2026/04/01 has:attachment". ' +
    'Returns subject, sender, recipient, date, id, preview, and attachments for each message.',
    {
      query:              z.string().optional().describe('Gmail search query with operators (from:, to:, subject:, after:YYYY/MM/DD, before:, has:attachment, is:unread, OR, parentheses…)'),
      maxResults:         z.number().optional().describe('Max messages to return — pages as needed (default 25, max 300). The total match count is always reported.'),
      includeAttachments: z.boolean().optional().describe("List each message's attachments (default true). Set false for a faster, lighter listing."),
    },
    async ({ query, maxResults, includeAttachments }) => {
      const text = await gmailListMessages(googleToken, query, maxResults, includeAttachments ?? true);
      return { content: [{ type: 'text' as const, text }] };
    }
  );

  server.tool(
    'gmail_read_message',
    'Read the full content of a single Gmail message by its ID — headers, body, and the list of attachments (with attachmentIds for gmail_get_attachment).',
    {
      messageId: z.string().describe('The Gmail message ID (from gmail_list_messages)'),
      maxChars:  z.number().optional().describe('Max characters of the body to return (default 15000, max 50000)'),
    },
    async ({ messageId, maxChars }) => {
      const text = await gmailReadMessage(googleToken, messageId, maxChars);
      return { content: [{ type: 'text' as const, text }] };
    }
  );

  server.tool(
    'gmail_get_attachment',
    'Download one attachment from a Gmail message. Text files (txt/csv/json/xml/md…) are returned as inline ' +
    'text; binary files (PDF, docx, images…) are returned as base64 JSON (under 25MB) for downstream ' +
    'processing/ingestion. Provide attachmentId (preferred) or filename, obtained from gmail_list_messages / gmail_read_message.',
    {
      messageId:    z.string().describe('The Gmail message ID that contains the attachment'),
      attachmentId: z.string().optional().describe('The attachment ID (from gmail_list_messages / gmail_read_message)'),
      filename:     z.string().optional().describe('The attachment filename (used if attachmentId is not provided)'),
    },
    async ({ messageId, attachmentId, filename }) => {
      const text = await gmailGetAttachment(googleToken, messageId, attachmentId, filename);
      return { content: [{ type: 'text' as const, text }] };
    }
  );

  server.tool(
    'gmail_send_email',
    'Send an email via Gmail. IMPORTANT: Only call this after explicit user confirmation.',
    {
      to:      z.string().describe('Recipient email address'),
      subject: z.string().describe('Email subject'),
      body:    z.string().describe('Email body (plain text)'),
      cc:      z.string().optional().describe('CC email addresses (comma-separated)'),
      bcc:     z.string().optional().describe('BCC email addresses (comma-separated)'),
    },
    async ({ to, subject, body, cc, bcc }) => {
      const messageId = await gmailSendEmail(googleToken, to, subject, body, cc, bcc);
      return { content: [{ type: 'text' as const, text: messageId }] };
    }
  );

  server.tool(
    'gmail_create_draft',
    'Create a Gmail draft email (does not send).',
    {
      to:      z.string().describe('Recipient email address'),
      subject: z.string().describe('Email subject'),
      body:    z.string().describe('Email body (plain text)'),
    },
    async ({ to, subject, body }) => {
      const draftId = await gmailCreateDraft(googleToken, to, subject, body);
      return { content: [{ type: 'text' as const, text: draftId }] };
    }
  );

  // ── Calendar tools ───────────────────────────────────────────────────────────

  server.tool(
    'calendar_list_events',
    'List Google Calendar events in a time range.',
    {
      timeMin:          z.string().optional().describe('Start of range (ISO 8601, defaults to now)'),
      timeMax:          z.string().optional().describe('End of range (ISO 8601, defaults to +7 days)'),
      maxResults:       z.number().optional().describe('Max events to return (default 10, max 50)'),
      displayTimezone:  z.string().optional().describe('IANA timezone to display times in (e.g. "America/New_York"). When set, all event times are shown in this timezone.'),
    },
    async ({ timeMin, timeMax, maxResults, displayTimezone }) => {
      const text = await calendarListEvents(googleToken, timeMin, timeMax, maxResults, displayTimezone);
      return { content: [{ type: 'text' as const, text }] };
    }
  );

  server.tool(
    'calendar_create_event',
    'Create a new event in Google Calendar.',
    {
      summary:     z.string().describe('Event title'),
      start:       z.string().describe('Start datetime (ISO 8601) or date (YYYY-MM-DD for all-day)'),
      end:         z.string().describe('End datetime (ISO 8601) or date (YYYY-MM-DD for all-day)'),
      description: z.string().optional().describe('Event description'),
      attendees:   z.array(z.string()).optional().describe('List of attendee email addresses'),
      location:    z.string().optional().describe('Event location'),
    },
    async ({ summary, start, end, description, attendees, location }) => {
      const text = await calendarCreateEvent(googleToken, summary, start, end, description, attendees, location);
      return { content: [{ type: 'text' as const, text }] };
    }
  );

  // ── Drive tools ──────────────────────────────────────────────────────────────

  server.tool(
    'drive_list_files',
    'List files in Google Drive. Supports search queries.',
    {
      query:      z.string().optional().describe('Search term to filter files by name or content'),
      maxResults: z.number().optional().describe('Max files to return (default 10, max 20)'),
    },
    async ({ query, maxResults }) => {
      const text = await driveListFiles(googleToken, query, maxResults);
      return { content: [{ type: 'text' as const, text }] };
    }
  );

  server.tool(
    'drive_get_file',
    'Get metadata and content of a specific Google Drive file.',
    {
      fileId: z.string().describe('The Google Drive file ID'),
    },
    async ({ fileId }) => {
      const text = await driveGetFile(googleToken, fileId);
      return { content: [{ type: 'text' as const, text }] };
    }
  );

  // ── Docs tools ───────────────────────────────────────────────────────────────

  server.tool(
    'docs_read_document',
    'Read the full text content of a Google Document.',
    {
      documentId: z.string().describe('The Google Docs document ID'),
    },
    async ({ documentId }) => {
      const text = await docsReadDocument(googleToken, documentId);
      return { content: [{ type: 'text' as const, text }] };
    }
  );

  // ── Sheets tools ─────────────────────────────────────────────────────────────

  server.tool(
    'sheets_read_data',
    'Read data from a Google Spreadsheet as a formatted table.',
    {
      spreadsheetId: z.string().describe('The Google Sheets spreadsheet ID'),
      range:         z.string().optional().describe('Sheet range (e.g. "Sheet1!A1:D10", defaults to entire first sheet)'),
    },
    async ({ spreadsheetId, range }) => {
      const text = await sheetsReadData(googleToken, spreadsheetId, range);
      return { content: [{ type: 'text' as const, text }] };
    }
  );

  // ── Handle the MCP request ───────────────────────────────────────────────────

  try {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless — no sessions needed
    });
    // ── Write tools (2026-09-23) — Docs / Sheets / Drive / Slides ──────────
    server.tool(
      'docs_create_document',
      'Create a new Google Doc with a title and optional plain-text body. Returns the documentId and edit link.',
      { title: z.string().describe('Document title'), bodyText: z.string().optional().describe('Initial body text (plain text; newlines kept)') },
      async ({ title, bodyText }) => ({ content: [{ type: 'text', text: await docsCreateDocument(googleToken, title, bodyText) }] }),
    );
    server.tool(
      'docs_append_text',
      'Append plain text to the END of an existing Google Doc (documentId from drive_list_files / docs_create_document).',
      { documentId: z.string().describe('The Google Doc ID'), text: z.string().describe('Text to append (plain text)') },
      async ({ documentId, text }) => ({ content: [{ type: 'text', text: await docsAppendText(googleToken, documentId, text) }] }),
    );
    server.tool(
      'sheets_create_spreadsheet',
      'Create a new Google Sheet; optional initial rows (first row = header) written from A1.',
      { title: z.string().describe('Spreadsheet title'), rows: z.array(z.array(z.union([z.string(), z.number(), z.boolean(), z.null()]))).optional().describe('Rows of cells'), sheetTitle: z.string().optional().describe('First sheet name (default Sheet1)') },
      async ({ title, rows, sheetTitle }) => ({ content: [{ type: 'text', text: await sheetsCreateSpreadsheet(googleToken, title, rows ?? [], sheetTitle ?? 'Sheet1') }] }),
    );
    server.tool(
      'sheets_write_values',
      'Overwrite a range (A1 notation, e.g. "Sheet1!A1:C10") with rows of cells.',
      { spreadsheetId: z.string(), range: z.string().describe('A1 range to overwrite'), rows: z.array(z.array(z.union([z.string(), z.number(), z.boolean(), z.null()]))).describe('Rows of cells') },
      async ({ spreadsheetId, range, rows }) => ({ content: [{ type: 'text', text: await sheetsWriteValues(googleToken, spreadsheetId, range, rows) }] }),
    );
    server.tool(
      'sheets_append_rows',
      'Append rows after the last data row of a sheet (range = sheet name, e.g. "Sheet1").',
      { spreadsheetId: z.string(), range: z.string().optional().describe('Sheet name or A1 range (default Sheet1)'), rows: z.array(z.array(z.union([z.string(), z.number(), z.boolean(), z.null()]))).describe('Rows of cells') },
      async ({ spreadsheetId, range, rows }) => ({ content: [{ type: 'text', text: await sheetsAppendRows(googleToken, spreadsheetId, range ?? 'Sheet1', rows) }] }),
    );
    server.tool(
      'drive_upload_file',
      'Upload text content as a Drive file (optionally into a folder, optionally converted to a native Google Doc/Sheet/Slides).',
      { name: z.string().describe('File name'), content: z.string().describe('File content (text)'), mimeType: z.string().optional().describe('Content mime type (default text/plain; text/markdown, text/csv, text/html…)'), folderId: z.string().optional(), convertTo: z.enum(['doc', 'sheet', 'slides']).optional().describe('Convert to a native Google file') },
      async ({ name, content, mimeType, folderId, convertTo }) => ({ content: [{ type: 'text', text: await driveUploadFile(googleToken, name, content, mimeType ?? 'text/plain', folderId, convertTo) }] }),
    );
    server.tool(
      'drive_create_folder',
      'Create a Google Drive folder (optionally inside a parent folder).',
      { name: z.string(), parentId: z.string().optional() },
      async ({ name, parentId }) => ({ content: [{ type: 'text', text: await driveCreateFolder(googleToken, name, parentId) }] }),
    );
    server.tool(
      'slides_create_presentation',
      'Create a Google Slides presentation from a title and a list of slides (each: title, body text and/or bullets).',
      { title: z.string(), slides: z.array(z.object({ title: z.string().optional(), body: z.string().optional(), bullets: z.array(z.string()).optional() })).optional() },
      async ({ title, slides }) => ({ content: [{ type: 'text', text: await slidesCreatePresentation(googleToken, title, slides ?? []) }] }),
    );

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err: any) {
    console.error('[google-mcp] Request error:', err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal server error', message: err.message });
    }
  }
});

// ── Start server ──────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[google-mcp] MCP server listening on :${PORT}`);
  console.log(`[google-mcp] Tools: Gmail (5), Calendar (2), Drive (2), Docs (1), Sheets (1)`);
});
