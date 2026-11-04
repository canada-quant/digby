/**
 * Google Sheets tools for the Google Workspace MCP server.
 */

import { google } from 'googleapis';

function getAuth(accessToken: string) {
  const auth = new google.auth.OAuth2();
  auth.setCredentials({ access_token: accessToken });
  return auth;
}

/**
 * Format a 2D array of cell values as a Markdown table.
 */
function formatAsMarkdownTable(rows: any[][]): string {
  if (rows.length === 0) return '(empty spreadsheet)';

  // Use first row as header
  const header = rows[0].map(c => String(c ?? ''));
  const dataRows = rows.slice(1);

  const colWidths = header.map((h, i) => {
    const maxData = dataRows.reduce((max, row) => {
      const cell = String(row[i] ?? '');
      return Math.max(max, cell.length);
    }, 0);
    return Math.max(h.length, maxData, 3);
  });

  const pad = (str: string, len: number) => str.substring(0, len).padEnd(len);

  const headerRow  = '| ' + header.map((h, i) => pad(h, colWidths[i])).join(' | ') + ' |';
  const separator  = '| ' + colWidths.map(w => '-'.repeat(w)).join(' | ')            + ' |';
  const dataRowsStr = dataRows.slice(0, 50).map(row =>
    '| ' + header.map((_, i) => pad(String(row[i] ?? ''), colWidths[i])).join(' | ') + ' |'
  );

  const lines = [headerRow, separator, ...dataRowsStr];
  if (dataRows.length > 50) {
    lines.push(`\n... (${dataRows.length - 50} more rows not shown)`);
  }

  return lines.join('\n');
}

// ── Tool implementations ──────────────────────────────────────────────────────

/**
 * Read data from a Google Spreadsheet.
 * Range defaults to the first sheet (Sheet1) if not specified.
 */
export async function sheetsReadData(
  accessToken: string,
  spreadsheetId: string,
  range = '',
): Promise<string> {
  const auth   = getAuth(accessToken);
  const sheets = google.sheets({ version: 'v4', auth });

  // Get spreadsheet metadata first to find sheet names
  const metaRes = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: 'properties.title,sheets.properties',
  });

  const title      = metaRes.data.properties?.title || '(untitled)';
  const sheetsList = metaRes.data.sheets || [];
  const firstSheet = sheetsList[0]?.properties?.title || 'Sheet1';

  // Use provided range or default to first sheet
  const targetRange = range || firstSheet;

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: targetRange,
  });

  const values = res.data.values || [];

  const sheetNames = sheetsList
    .map((s: any) => s.properties?.title)
    .filter(Boolean)
    .join(', ');

  return [
    `**${title}** — ${targetRange}`,
    `Spreadsheet ID: ${spreadsheetId}`,
    sheetNames ? `Sheets: ${sheetNames}` : '',
    `Rows: ${values.length}`,
    ``,
    formatAsMarkdownTable(values),
  ].filter(Boolean).join('\n');
}

// ── Write tools (2026-09-23, owner: "add all of that") ────────────────────────
const SHEET_LINK = (id: string) => `https://docs.google.com/spreadsheets/d/${id}/edit`;

/** Normalize a rows payload (arrays of cells; numbers/booleans kept, null → ''). Pure — exported for tests. */
export function normalizeRows(rows: unknown): Array<Array<string | number | boolean>> {
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((r): r is unknown[] => Array.isArray(r))
    .map((r) => r.map((c) => (c === null || c === undefined ? '' : (typeof c === 'number' || typeof c === 'boolean' ? c : String(c)))));
}

/** Create a spreadsheet with an optional first sheet name and initial rows (row 0 = header). */
export async function sheetsCreateSpreadsheet(accessToken: string, title: string, rows: unknown = [], sheetTitle = 'Sheet1'): Promise<string> {
  const auth = getAuth(accessToken);
  const sheets = google.sheets({ version: 'v4', auth });
  const created = await sheets.spreadsheets.create({
    requestBody: { properties: { title }, sheets: [{ properties: { title: sheetTitle } }] },
  });
  const spreadsheetId = created.data.spreadsheetId!;
  const values = normalizeRows(rows);
  if (values.length) {
    await sheets.spreadsheets.values.update({
      spreadsheetId, range: `${sheetTitle}!A1`, valueInputOption: 'USER_ENTERED', requestBody: { values },
    });
  }
  return `Created Google Sheet "${title}" — spreadsheetId ${spreadsheetId} (${values.length} row(s) written to ${sheetTitle}) — ${SHEET_LINK(spreadsheetId)}`;
}

/** Overwrite a rectangular range (A1 notation) with rows. */
export async function sheetsWriteValues(accessToken: string, spreadsheetId: string, range: string, rows: unknown): Promise<string> {
  const auth = getAuth(accessToken);
  const sheets = google.sheets({ version: 'v4', auth });
  const values = normalizeRows(rows);
  if (!values.length) return 'Nothing to write — rows is empty.';
  const res = await sheets.spreadsheets.values.update({ spreadsheetId, range, valueInputOption: 'USER_ENTERED', requestBody: { values } });
  return `Wrote ${res.data.updatedRows ?? values.length} row(s) × ${res.data.updatedColumns ?? values[0].length} column(s) to ${res.data.updatedRange ?? range} — spreadsheetId ${spreadsheetId} — ${SHEET_LINK(spreadsheetId)}`;
}

/** Append rows after the last data row of a sheet (range = sheet name or A1 range). */
export async function sheetsAppendRows(accessToken: string, spreadsheetId: string, range: string, rows: unknown): Promise<string> {
  const auth = getAuth(accessToken);
  const sheets = google.sheets({ version: 'v4', auth });
  const values = normalizeRows(rows);
  if (!values.length) return 'Nothing to append — rows is empty.';
  const res = await sheets.spreadsheets.values.append({
    spreadsheetId, range: range || 'Sheet1', valueInputOption: 'USER_ENTERED', insertDataOption: 'INSERT_ROWS', requestBody: { values },
  });
  const upd = res.data.updates;
  return `Appended ${upd?.updatedRows ?? values.length} row(s) at ${upd?.updatedRange ?? range} — spreadsheetId ${spreadsheetId} — ${SHEET_LINK(spreadsheetId)}`;
}
