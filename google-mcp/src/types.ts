/**
 * Shared types for the Google Workspace MCP server.
 */

/** Minimal Gmail message summary */
export interface GmailMessageSummary {
  id: string;
  subject: string;
  from: string;
  date: string;
  snippet: string;
}

/** Full Gmail message */
export interface GmailMessage extends GmailMessageSummary {
  body: string;
  to: string;
  cc?: string;
}

/** Google Calendar event */
export interface CalendarEvent {
  id: string;
  summary: string;
  description?: string;
  location?: string;
  start: string;
  end: string;
  attendees?: string[];
  organizer?: string;
  htmlLink?: string;
}

/** Google Drive file */
export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime?: string;
  size?: string;
  webViewLink?: string;
  owners?: string[];
}
