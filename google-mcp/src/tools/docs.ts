/**
 * Google Docs tools for the Google Workspace MCP server.
 */

import { google } from 'googleapis';

function getAuth(accessToken: string) {
  const auth = new google.auth.OAuth2();
  auth.setCredentials({ access_token: accessToken });
  return auth;
}

/**
 * Extract plain text from a Google Docs document object.
 * Traverses the body content array and concatenates all text runs.
 */
function extractDocText(document: any): string {
  const parts: string[] = [];

  const body = document.body?.content || [];
  for (const element of body) {
    if (element.paragraph) {
      for (const el of element.paragraph.elements || []) {
        const text = el.textRun?.content;
        if (text) parts.push(text);
      }
    } else if (element.table) {
      for (const row of element.table.tableRows || []) {
        for (const cell of row.tableCells || []) {
          for (const cellEl of cell.content || []) {
            if (cellEl.paragraph) {
              for (const el of cellEl.paragraph.elements || []) {
                const text = el.textRun?.content;
                if (text) parts.push(text);
              }
            }
          }
        }
        parts.push('\n');
      }
    }
  }

  return parts.join('').trim();
}

// ── Tool implementations ──────────────────────────────────────────────────────

/**
 * Read the full text content of a Google Document.
 * Truncates at 8000 chars to keep context manageable.
 */
export async function docsReadDocument(
  accessToken: string,
  documentId: string,
): Promise<string> {
  const auth = getAuth(accessToken);
  const docs = google.docs({ version: 'v1', auth });

  const res = await docs.documents.get({ documentId });
  const doc = res.data;

  const title   = doc.title || '(untitled)';
  const text    = extractDocText(doc);
  const truncated = text.length > 8000;

  return [
    `**${title}**`,
    `Document ID: ${documentId}`,
    `Characters: ${text.length}`,
    ``,
    truncated
      ? text.substring(0, 8000) + '\n\n... (document truncated at 8000 chars)'
      : text,
  ].join('\n');
}

// ── Write tools (2026-09-23, owner: "add all of that") ────────────────────────
const DOC_LINK = (id: string) => `https://docs.google.com/document/d/${id}/edit`;

/** The end index of a document body (where appended text goes). Pure — exported for tests. */
export function docEndIndex(document: any): number {
  const content = document?.body?.content || [];
  const last = content[content.length - 1];
  const end = Number(last?.endIndex ?? 1);
  // Google Docs bodies always end with a newline segment; insert before it.
  return Math.max(1, end - 1);
}

/** Create a Google Doc with a title and optional body text (plain text; blank lines kept). */
export async function docsCreateDocument(accessToken: string, title: string, bodyText = ''): Promise<string> {
  const auth = getAuth(accessToken);
  const docs = google.docs({ version: 'v1', auth });
  const created = await docs.documents.create({ requestBody: { title } });
  const documentId = created.data.documentId!;
  if (bodyText && bodyText.trim()) {
    await docs.documents.batchUpdate({
      documentId,
      requestBody: { requests: [{ insertText: { location: { index: 1 }, text: bodyText } }] },
    });
  }
  return `Created Google Doc "${title}" — documentId ${documentId} — ${DOC_LINK(documentId)}`;
}

/** Append plain text to the end of an existing Google Doc. */
export async function docsAppendText(accessToken: string, documentId: string, text: string): Promise<string> {
  const auth = getAuth(accessToken);
  const docs = google.docs({ version: 'v1', auth });
  const doc = await docs.documents.get({ documentId });
  const index = docEndIndex(doc.data);
  const payload = text.startsWith('\n') ? text : `\n${text}`;
  await docs.documents.batchUpdate({
    documentId,
    requestBody: { requests: [{ insertText: { location: { index }, text: payload } }] },
  });
  return `Appended ${payload.length} characters to Google Doc "${doc.data.title ?? documentId}" — documentId ${documentId} — ${DOC_LINK(documentId)}`;
}
