/**
 * Google OAuth scopes — ONE list for the consent request, the account status
 * (missing-permission badge) and the agent write precheck (2026-09-23, owner:
 * "add all of that" — Docs/Sheets/Slides/Drive create+edit, Gmail drafts, and
 * the Calendar create / Gmail send tools the MCP server already implemented).
 *
 * Accounts connected before this change hold only the READ scopes; every
 * write tool checks the account's granted scopes first and answers with the
 * re-consent instruction instead of a Google 403. Pure leaf (no imports).
 */
const G = 'https://www.googleapis.com/auth/';

export const GOOGLE_READ_SCOPES = [
  `${G}gmail.readonly`,
  `${G}gmail.send`,
  `${G}calendar.readonly`,
  `${G}calendar.events`,
  `${G}drive.readonly`,
  `${G}documents.readonly`,
  `${G}spreadsheets.readonly`,
] as const;

/** Added 2026-09-23 — editing scopes. */
export const GOOGLE_WRITE_SCOPES = [
  `${G}documents`,
  `${G}spreadsheets`,
  `${G}presentations`,
  `${G}drive.file`,
  `${G}gmail.compose`,
] as const;

export const GOOGLE_ALL_SCOPES: readonly string[] = [...GOOGLE_READ_SCOPES, ...GOOGLE_WRITE_SCOPES];

/** Scopes each agent-facing WRITE tool needs on the resolved account. */
export const GOOGLE_TOOL_SCOPES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  gmail_send_email:          [`${G}gmail.send`],
  gmail_create_draft:        [`${G}gmail.compose`],
  calendar_create_event:     [`${G}calendar.events`],
  docs_create_document:      [`${G}documents`],
  docs_append_text:          [`${G}documents`],
  sheets_create_spreadsheet: [`${G}spreadsheets`],
  sheets_write_values:       [`${G}spreadsheets`],
  sheets_append_rows:        [`${G}spreadsheets`],
  drive_upload_file:         [`${G}drive.file`],
  drive_create_folder:       [`${G}drive.file`],
  slides_create_presentation:[`${G}presentations`],
});

export const GOOGLE_WRITE_TOOL_NAMES: readonly string[] = Object.keys(GOOGLE_TOOL_SCOPES);

/** Which of the WRITE scopes an account still lacks (for the UI badge / re-consent CTA). */
export function missingGoogleWriteScopes(granted: readonly string[] | null | undefined): string[] {
  const have = new Set((granted ?? []).map((s) => s.trim()));
  // The broad `drive` scope implies drive.file.
  if (have.has(`${G}drive`)) have.add(`${G}drive.file`);
  return GOOGLE_WRITE_SCOPES.filter((s) => !have.has(s));
}

/** Which scopes a specific tool still lacks on an account ([] = ready). */
export function missingScopesForTool(tool: string, granted: readonly string[] | null | undefined): string[] {
  const need = GOOGLE_TOOL_SCOPES[tool] ?? [];
  const have = new Set((granted ?? []).map((s) => s.trim()));
  if (have.has(`${G}drive`)) have.add(`${G}drive.file`);
  return need.filter((s) => !have.has(s));
}

/** Short human label for a scope URL (UI + refusal text). */
export function scopeShortName(scope: string): string {
  return scope.replace(G, '');
}
