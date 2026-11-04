/**
 * Google Drive tools for the Google Workspace MCP server.
 */

import { google } from 'googleapis';

function getAuth(accessToken: string) {
  const auth = new google.auth.OAuth2();
  auth.setCredentials({ access_token: accessToken });
  return auth;
}

function mimeLabel(mimeType: string): string {
  const map: Record<string, string> = {
    'application/vnd.google-apps.document':     '📄 Doc',
    'application/vnd.google-apps.spreadsheet':  '📊 Sheet',
    'application/vnd.google-apps.presentation': '📊 Slides',
    'application/vnd.google-apps.folder':       '📁 Folder',
    'application/vnd.google-apps.form':         '📋 Form',
    'application/pdf':                           '📕 PDF',
    'image/jpeg':                                '🖼 Image',
    'image/png':                                 '🖼 Image',
    'text/plain':                                '📝 Text',
  };
  return map[mimeType] || '📄 File';
}

function formatDate(dateStr?: string | null): string {
  if (!dateStr) return '';
  try {
    return new Date(dateStr).toLocaleDateString('en-US', {
      year: 'numeric', month: 'short', day: 'numeric',
    });
  } catch { return dateStr; }
}

// ── Tool implementations ──────────────────────────────────────────────────────

/**
 * List files in Google Drive matching an optional query.
 */
export async function driveListFiles(
  accessToken: string,
  query = '',
  maxResults = 10,
): Promise<string> {
  const auth  = getAuth(accessToken);
  const drive = google.drive({ version: 'v3', auth });

  // Build search query
  let driveQuery = "trashed = false";
  if (query) {
    // Escape single quotes in user query
    const safeQ = query.replace(/'/g, "\\'");
    driveQuery += ` and (name contains '${safeQ}' or fullText contains '${safeQ}')`;
  }

  const res = await drive.files.list({
    q:        driveQuery,
    pageSize: Math.min(maxResults, 20),
    fields:   'files(id, name, mimeType, modifiedTime, size, owners, webViewLink)',
    orderBy:  'modifiedTime desc',
  });

  const files = res.data.files || [];

  if (files.length === 0) {
    return query
      ? `No files found matching "${query}".`
      : 'No files found in your Google Drive.';
  }

  const lines: string[] = [`Found ${files.length} file(s):\n`];

  for (const file of files) {
    const label    = mimeLabel(file.mimeType || '');
    const modified = formatDate(file.modifiedTime);
    const owner    = file.owners?.[0]?.displayName || '';

    lines.push(
      `${label} **${file.name}**\n` +
      `   ID: ${file.id}\n` +
      (modified ? `   Modified: ${modified}\n` : '') +
      (owner    ? `   Owner: ${owner}\n`         : '') +
      (file.webViewLink ? `   Link: ${file.webViewLink}` : '')
    );
  }

  return lines.join('\n\n');
}

/**
 * Get file metadata and content (for text-based files).
 * For Google Docs/Sheets/Slides, exports as plain text/CSV.
 */
export async function driveGetFile(
  accessToken: string,
  fileId: string,
): Promise<string> {
  const auth  = getAuth(accessToken);
  const drive = google.drive({ version: 'v3', auth });

  // Get file metadata
  const meta = await drive.files.get({
    fileId,
    fields: 'id, name, mimeType, modifiedTime, size, owners, webViewLink, description',
  });

  const file     = meta.data;
  const mimeType = file.mimeType || '';

  // For Google Workspace files, export as plain text
  const exportMimeMap: Record<string, string> = {
    'application/vnd.google-apps.document':     'text/plain',
    'application/vnd.google-apps.spreadsheet':  'text/csv',
    'application/vnd.google-apps.presentation': 'text/plain',
  };

  const exportMime = exportMimeMap[mimeType];
  let content = '';

  if (exportMime) {
    try {
      const exportRes = await drive.files.export(
        { fileId, mimeType: exportMime },
        { responseType: 'text' }
      );
      content = (exportRes.data as string).substring(0, 5000);
    } catch {
      content = '(content export failed)';
    }
  } else if (mimeType.startsWith('text/')) {
    try {
      const downloadRes = await drive.files.get(
        { fileId, alt: 'media' },
        { responseType: 'text' }
      );
      content = (downloadRes.data as string).substring(0, 5000);
    } catch {
      content = '(download failed)';
    }
  }

  return [
    `**${file.name}** (${mimeLabel(mimeType)})`,
    `ID: ${fileId}`,
    `Modified: ${formatDate(file.modifiedTime)}`,
    file.webViewLink ? `Link: ${file.webViewLink}` : '',
    file.description ? `Description: ${file.description}` : '',
    content ? `\n--- Content ---\n${content}` : '',
  ].filter(Boolean).join('\n');
}

// ── Write tools (2026-09-23, owner: "add all of that") ────────────────────────
import { Readable } from 'stream';

/** Google-native target mime for an optional conversion. Pure — exported for tests. */
export function driveConvertMime(convertTo?: string): string | undefined {
  switch ((convertTo || '').toLowerCase()) {
    case 'doc': case 'document': case 'google_doc': return 'application/vnd.google-apps.document';
    case 'sheet': case 'spreadsheet': case 'google_sheet': return 'application/vnd.google-apps.spreadsheet';
    case 'slides': case 'presentation': case 'google_slides': return 'application/vnd.google-apps.presentation';
    default: return undefined;
  }
}

/** Upload text content as a Drive file; optionally convert to a native Doc/Sheet/Slides. */
export async function driveUploadFile(
  accessToken: string,
  name: string,
  content: string,
  mimeType = 'text/plain',
  folderId?: string,
  convertTo?: string,
): Promise<string> {
  const auth  = getAuth(accessToken);
  const drive = google.drive({ version: 'v3', auth });
  const targetMime = driveConvertMime(convertTo);
  const res = await drive.files.create({
    requestBody: { name, ...(targetMime ? { mimeType: targetMime } : {}), ...(folderId ? { parents: [folderId] } : {}) },
    media: { mimeType, body: Readable.from([content]) },
    fields: 'id, name, mimeType, webViewLink, size',
  });
  const f = res.data;
  return `Uploaded "${f.name}" (${mimeLabel(f.mimeType || '')}${f.size ? `, ${formatSize(Number(f.size))}` : ''}) — fileId ${f.id} — ${f.webViewLink ?? ''}`.trim();
}

/** Create a Drive folder (optionally inside a parent folder). */
export async function driveCreateFolder(accessToken: string, name: string, parentId?: string): Promise<string> {
  const auth  = getAuth(accessToken);
  const drive = google.drive({ version: 'v3', auth });
  const res = await drive.files.create({
    requestBody: { name, mimeType: 'application/vnd.google-apps.folder', ...(parentId ? { parents: [parentId] } : {}) },
    fields: 'id, name, webViewLink',
  });
  return `Created folder "${res.data.name}" — folderId ${res.data.id} — ${res.data.webViewLink ?? ''}`.trim();
}

function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
