/**
 * Google Workspace Intent Detector
 *
 * Keyword / pattern matching to detect when the user wants Google Workspace data
 * included in the AI response. No LLM call — pure regex matching is fast and
 * cheap enough for every query.
 *
 * Returns flags for each service so the controller can selectively fetch context.
 */

export interface GoogleIntent {
  /** User is asking about emails / inbox / messages */
  gmail: boolean;
  /** User is asking about calendar / schedule / events */
  calendar: boolean;
  /** User is asking about files / Google Drive */
  drive: boolean;
  /** User is asking about a Google Doc */
  docs: boolean;
  /** User is asking about a Google Sheet */
  sheets: boolean;
  /** User wants to SEND an email — requires confirmation UI */
  sendEmail: boolean;
}

// ── Pattern sets ──────────────────────────────────────────────────────────────

const SEND_EMAIL_PATTERNS: RegExp[] = [
  /\b(send|write|compose|draft)\s+(an?\s+)?(email|message|mail)\b/i,
  /\bemail\s+.{1,60}\s+(about|regarding|re:|telling|to say)\b/i,
  /\bsend\s+.{1,80}\s+an\s+email\b/i,
  /\breply\s+(to|with)\b/i,
  /\bforward\s+(this\s+)?(email|message)\b/i,
];

const GMAIL_READ_PATTERNS: RegExp[] = [
  /\b(email|emails|gmail|inbox|message|messages|unread|sent|draft|drafts)\b/i,
  /\b(who\s+(sent|emailed|messaged|wrote)\s+me)\b/i,
  /\b(show|check|read|open|get|list)\s+(my\s+)?(email|emails|inbox|messages?)\b/i,
  /\bdo\s+i\s+have\s+(any\s+)?(new\s+)?(email|message)\b/i,
  /\bany\s+(new\s+)?(email|message|mail)\b/i,
  /\blast\s+(few\s+)?(email|message)\b/i,
  /\bcheck\s+my\s+mail\b/i,
];

const CALENDAR_PATTERNS: RegExp[] = [
  // Note: matches both "calendar" and "calendars" — the \b word boundary after "calendar"
  // was previously preventing "calendars" from matching (bug fix Mar 26, 2026)
  /\bcalendars?\b/i,
  /\b(schedule|meeting|meetings|event|events|appointment|appointments|agenda)\b/i,
  /\bwhat('s|\s+is)\s+on\s+my\s+(calendars?|schedule|agenda)\b/i,
  /\b(today|tomorrow|this week|next week|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b.*\b(meeting|schedule|calendars?|event|appointment)\b/i,
  /\b(meeting|schedule|calendars?|event|appointment)\b.*\b(today|tomorrow|this week|next week|monday|tuesday|wednesday|thursday|friday)\b/i,
  /\bdo\s+i\s+have\s+(a|any)?\s*(meeting|event|appointment|call)\b/i,
  /\bwhen\s+is\s+(my|the)\s+(next\s+)?(meeting|call|event)\b/i,
  /\b(add|create|schedule|book|set up)\s+(a|an\s+)?(meeting|event|appointment|call|reminder)\b/i,
  /\bfree\s+(time|slot|period)\b/i,
  /\bam\s+i\s+(busy|free|available)\b/i,
  // Workspace-specific calendar references: "check zezomedia calendar", "acme calendar", etc.
  // Matches "[verb] [word] calendar" or just "[word] calendar" patterns
  /\bcheck\s+\S+\s+calendars?\b/i,
  /\b(show|get|fetch|pull|see)\s+\S+\s+calendars?\b/i,
  // "google workspace" or "workspace" references in context of scheduling
  /\b(google\s+)?workspace\s+(calendar|account|schedule)\b/i,
  /\b(both|all|multiple|each|every)\s+(calendars?|accounts?|workspaces?)\b/i,
  /\b(second|other|another|additional)\s+(calendar|workspace|google\s+account)\b/i,
];

const DRIVE_PATTERNS: RegExp[] = [
  /\bgoogle\s+drive\b/i,
  /\b(find|search|look for|list)\s+(a\s+|my\s+|the\s+)?(file|files|folder|document|doc)\b/i,
  /\bwhat\s+(files?|documents?)\s+(do\s+i|have\s+i)\b/i,
  /\bmy\s+(recent\s+)?(files?|documents?)\b/i,
  /\bshared\s+(with\s+me\s+)?(file|document)\b/i,
];

const DOCS_PATTERNS: RegExp[] = [
  /\bgoogle\s+doc(s|ument)?\b/i,
  /\b(open|read|show|summarize|get)\s+(a\s+|my\s+|the\s+)?(doc|document|gdoc)\b/i,
  /\bread\s+(the\s+)?(document|doc)\b/i,
  /\b(document|doc)\s+(content|text|body)\b/i,
];

const SHEETS_PATTERNS: RegExp[] = [
  /\bgoogle\s+sheet(s)?\b/i,
  /\bspreadsheet\b/i,
  /\b(open|read|show|get|check)\s+(a\s+|my\s+|the\s+)?(sheet|spreadsheet|table)\b/i,
  /\b(row|column|cell|tab)\s+(data|value|content)\b/i,
  /\bexcel\s+file\b/i,
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function matchesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some(p => p.test(text));
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Detect Google Workspace data intent from a user message.
 *
 * @param message - Raw user message string
 * @returns Intent flags for each Google service
 */
export function detectGoogleIntent(message: string): GoogleIntent {
  const sendEmail = matchesAny(message, SEND_EMAIL_PATTERNS);
  const gmailRead = matchesAny(message, GMAIL_READ_PATTERNS);
  const gmail     = sendEmail || gmailRead;
  const calendar  = matchesAny(message, CALENDAR_PATTERNS);
  const drive     = matchesAny(message, DRIVE_PATTERNS);
  const docs      = matchesAny(message, DOCS_PATTERNS);
  const sheets    = matchesAny(message, SHEETS_PATTERNS);

  return { gmail, calendar, drive, docs, sheets, sendEmail };
}

/**
 * Returns true if any Google service intent is detected.
 */
export function hasAnyGoogleIntent(intent: GoogleIntent): boolean {
  return intent.gmail || intent.calendar || intent.drive || intent.docs || intent.sheets;
}

/** Month name (and common abbreviations) → 2-digit month, for after:/before: date parsing. */
const MONTHS: Record<string, string> = {
  january: '01', february: '02', march: '03', april: '04', may: '05', june: '06',
  july: '07', august: '08', september: '09', october: '10', november: '11', december: '12',
  jan: '01', feb: '02', mar: '03', apr: '04', jun: '06', jul: '07', aug: '08',
  sep: '09', sept: '09', oct: '10', nov: '11', dec: '12',
};

/** Domains never treated as a "participant" filter even when mentioned (the user's own / infra / noise). */
const IGNORED_PARTICIPANT_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'google.com', 'script.google.com',
  'digby.example.com', 'sunday.market',
]);

/**
 * Extract a Gmail search query from the user's natural language message.
 *
 * Gmail supports powerful search operators (from, to, subject, after:, before:, has:attachment,
 * is:unread, OR, parentheses…). This translates the message into Gmail syntax so the API returns
 * the RIGHT emails — not just the N most recent.
 *
 * Key behaviour for multi-contact requests ("emails related to cdw.ca, connie.xiong@cdw.ca,
 * sboone@nvidia.com …"): every email address AND bare company domain mentioned is collected into a
 * single `(from:X OR to:X OR …)` participant group. A mentioned domain (e.g. cdw.ca) subsumes the
 * individual addresses at that domain, so the whole domain is swept in one clause.
 */
export function extractGmailSearchQuery(message: string): string {
  const clauses: string[] = [];

  // ── Participants: every email address + bare company domain mentioned ───────
  const emails = Array.from(
    message.matchAll(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g)
  ).map(m => m[0].toLowerCase());

  // Bare domains like "cdw.ca" — not the domain half of an email (no preceding @ / word char / dot).
  const domains = Array.from(
    message.matchAll(/(?<![@\w.])([a-z0-9][a-z0-9\-]+\.(?:com|ca|net|org|io|ai|co|gov|edu)(?:\.[a-z]{2})?)\b/gi)
  ).map(m => m[1].toLowerCase()).filter(d => !IGNORED_PARTICIPANT_DOMAINS.has(d));

  const domainSet = new Set(domains);
  const participants = Array.from(new Set([
    ...domains,
    // Drop individual addresses whose domain is already covered by a mentioned domain.
    ...emails.filter(e => !domainSet.has(e.split('@')[1])),
  ]));

  if (participants.length > 0) {
    const ors = participants.flatMap(p => [`from:${p}`, `to:${p}`]);
    clauses.push(`(${ors.join(' OR ')})`);
  }

  // ── Date range — explicit dates take priority over relative phrases ─────────
  const isoDate = message.match(/\b(?:since|after|from|back\s+to)\s+(\d{4})[\/\-](\d{1,2})(?:[\/\-](\d{1,2}))?\b/i);
  const monthYear = message.match(/\b(?:since|after|back\s+to|starting\s+(?:in|from))\s+([A-Za-z]+)(?:\s+(\d{4}))?\b/i);
  if (isoDate) {
    const [, y, mo, d] = isoDate;
    clauses.push(`after:${y}/${mo.padStart(2, '0')}/${(d || '1').padStart(2, '0')}`);
  } else if (monthYear && MONTHS[monthYear[1].toLowerCase()]) {
    const mo = MONTHS[monthYear[1].toLowerCase()];
    const y  = monthYear[2] || String(new Date().getFullYear());
    clauses.push(`after:${y}/${mo}/01`);
  } else if (/\b(today|today'?s)\b/i.test(message)) {
    clauses.push('newer_than:1d');
  } else if (/\byesterday\b/i.test(message)) {
    clauses.push('newer_than:2d older_than:1d');
  } else if (/\bthis\s+week\b/i.test(message)) {
    clauses.push('newer_than:7d');
  } else if (/\blast\s+week\b/i.test(message)) {
    clauses.push('newer_than:14d older_than:7d');
  } else if (/\bthis\s+month\b/i.test(message)) {
    clauses.push('newer_than:30d');
  } else {
    const daysMatch  = message.match(/\blast\s+(\d+)\s+days?\b/i);
    const hoursMatch = message.match(/\blast\s+(\d+)\s+hours?\b/i);
    if (daysMatch) clauses.push(`newer_than:${daysMatch[1]}d`);
    else if (hoursMatch) clauses.push(`newer_than:${hoursMatch[1]}h`);
    else if (/\brecent(ly)?\b/i.test(message)) clauses.push('newer_than:3d');
  }

  // ── Subject filter (quoted only — keeps multi-contact sweeps from over-narrowing) ──
  const subjectMatch = message.match(/\b(?:subject|about|regarding|re)\s*[:=]?\s*"([^"]+)"/i);
  if (subjectMatch) clauses.push(`subject:${subjectMatch[1].trim()}`);

  // ── Status / attachment filters ─────────────────────────────────────────────
  if (/\bunread\b/i.test(message)) clauses.push('is:unread');
  if (/\bstarred\b/i.test(message)) clauses.push('is:starred');
  if (/\b(important|priority)\b/i.test(message)) clauses.push('is:important');
  if (/\bwith\s+attachments?\b/i.test(message) || /\bhas\s+attachment/i.test(message)) {
    clauses.push('has:attachment');
  }

  // ── Keyword catch-all (only when no participants, to preserve "emails about invoices") ──
  if (participants.length === 0 && !subjectMatch) {
    const aboutMatch = message.match(/\b(?:email|emails|messages?|mail)\s+(?:about|mentioning|containing|with|regarding)\s+["']?([^"'\n,]{3,40})["']?\b/i);
    if (aboutMatch) clauses.push(aboutMatch[1].trim());
  }

  return clauses.join(' ').trim();
}

/**
 * Suggest how many messages to fetch. Broad sweeps ("go through all my emails", "every",
 * "thoroughly", "diligently") request a deep scan; otherwise a modest default.
 */
export function extractGmailMaxResults(message: string): number {
  if (/\b(all|every|everything|entire|complete|thorough(ly)?|each|go\s+through|comb\s+through|dig\s+through|diligent(ly)?|deep)\b/i.test(message)) {
    return 100;
  }
  return 25;
}
